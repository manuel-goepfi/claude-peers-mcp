#!/usr/bin/env bun
import { cpSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspectClientSurfaces } from "../shared/doctor.ts";
import { startTestBroker } from "../tests/helpers/test-broker.ts";

const sourceRoot = resolve(import.meta.dir, "..");

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(command: string[], options: { cwd: string; home: string }): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...process.env, HOME: options.home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`command failed (${code}): ${stderr.trim()}`);
  return { stdout, stderr };
}

function backupFrom(output: string): string {
  const path = output.split("\n").find((line) => line.startsWith("backup: "))?.slice("backup: ".length);
  invariant(path, "installer did not report a material-change backup");
  invariant((statSync(path).mode & 0o777) === 0o600, "installer backup mode is not 0600");
  return path;
}

async function protocolSmoke(root: string): Promise<void> {
  const broker = await startTestBroker({ root: join(root, "broker"), cleanupOnStop: false, prefix: "clean-install" });
  const children = [Bun.spawn(["sleep", "30"]), Bun.spawn(["sleep", "30"])];
  const tokens = new Map<string, string>();
  const post = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
    const id = String(body.id ?? body.from_id ?? "");
    const response = await fetch(`${broker.url}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(tokens.has(id) ? { "X-Peer-Token": tokens.get(id)! } : {}),
      },
      body: JSON.stringify(body),
    });
    const value = await response.json() as Record<string, unknown>;
    if (!response.ok || value.error) throw new Error(`protocol smoke failed at ${path}`);
    if (path === "/register" && typeof value.id === "string" && typeof value.token === "string") tokens.set(value.id, value.token);
    return value as T;
  };

  try {
    const registered = [] as Array<{ id: string }>;
    for (const [index, child] of children.entries()) {
      registered.push(await post<{ id: string }>("/register", {
        pid: child.pid,
        cwd: `/smoke/session-${index + 1}`,
        git_root: null,
        tty: null,
        name: `smoke-${index + 1}`,
        tmux_session: null,
        tmux_window_index: null,
        tmux_window_name: null,
        client_type: "claude",
        receiver_mode: "claude-channel",
        summary: "",
      }));
    }
    const peers = await post<Array<{ id: string }>>("/list-peers", { id: registered[0]!.id, scope: "machine", cwd: "/", git_root: null });
    invariant(peers.some((peer) => peer.id === registered[1]!.id), "second clean-install peer was not discoverable");
    const sent = await post<{ id: number }>("/send-message", { from_id: registered[0]!.id, to_id: registered[1]!.id, text: "clean-install-protocol-proof" });
    invariant(Number.isInteger(sent.id), "send did not return a message id");
    const polled = await post<{ messages: Array<{ id: number }> }>("/poll-messages", { id: registered[1]!.id });
    invariant(polled.messages.some((message) => message.id === sent.id), "queued message was not visible to its receiver");
    const acked = await post<{ acked: number }>("/ack-messages", { id: registered[1]!.id, ids: [sent.id] });
    invariant(acked.acked === 1, "receiver did not acknowledge the queued message");
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));
    await broker.stop();
  }
}

export async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "claude-peers-clean-install-"));
  const home = join(root, "home");
  const clone = join(home, "claude-peers-mcp");
  const project = join(home, "project");
  try {
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(project, { mode: 0o700 });
    mkdirSync(clone, { mode: 0o700 });
    for (const entry of ["bin", "hooks", "shared", "server.ts", "broker.ts", "package.json"]) {
      cpSync(join(sourceRoot, entry), join(clone, entry), { recursive: true });
    }
    chmodSync(clone, 0o700);

    const originals = {
      claude: "{\n  \"theme\": \"smoke\"\n}\n",
      codex: "{\n  \"operatorSetting\": \"smoke\"\n}\n",
      gemini: "{\n  \"ui\": {\n    \"theme\": \"smoke\"\n  }\n}\n",
    };
    for (const client of ["claude", "codex", "gemini"] as const) {
      const directory = join(home, `.${client}`);
      mkdirSync(directory, { mode: 0o700 });
      const file = client === "codex" ? "hooks.json" : "settings.json";
      writeFileSync(join(directory, file), originals[client], { mode: 0o600 });
    }

    const installers = {
      claude: join(clone, "bin/install-claude-hook.ts"),
      codex: join(clone, "bin/install-codex-hook.ts"),
      gemini: join(clone, "bin/install-gemini-hook.ts"),
    };
    const firstBackups = new Map<string, string>();
    for (const client of ["claude", "codex", "gemini"] as const) {
      const result = await run([process.execPath, installers[client]], { cwd: project, home });
      invariant(result.stderr === "", `${client} installer wrote unexpected stderr`);
      firstBackups.set(client, backupFrom(result.stdout));
    }

    writeFileSync(join(home, ".claude.json"), `${JSON.stringify({ mcpServers: { "claude-peers": { command: process.execPath, args: [join(clone, "server.ts")] } } }, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(home, ".codex", "config.toml"), `[mcp_servers.claude-peers]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(join(clone, "server.ts"))}]\n`, { mode: 0o600 });

    const beforeNoop = new Map<string, { bytes: Buffer; mtime: number; backups: number }>();
    for (const client of ["claude", "codex", "gemini"] as const) {
      const directory = join(home, `.${client}`);
      const file = client === "codex" ? "hooks.json" : "settings.json";
      const path = join(directory, file);
      beforeNoop.set(client, {
        bytes: readFileSync(path),
        mtime: statSync(path).mtimeMs,
        backups: readdirSync(directory).filter((name) => name.includes(".bak-")).length,
      });
      await run([process.execPath, installers[client], "--check"], { cwd: project, home });
      await run([process.execPath, installers[client]], { cwd: project, home });
      const before = beforeNoop.get(client)!;
      invariant(readFileSync(path).equals(before.bytes), `${client} second install changed bytes`);
      invariant(statSync(path).mtimeMs === before.mtime, `${client} second install changed mtime`);
      invariant(readdirSync(directory).filter((name) => name.includes(".bak-")).length === before.backups, `${client} second install created a backup`);
    }

    const surfaces = inspectClientSurfaces(home, project, clone);
    for (const client of ["claude", "codex", "gemini"] as const) {
      invariant(surfaces[client].hooks.user.state === "current", `${client} user hook surface is not current`);
      invariant(surfaces[client].mcp.user.state === "current", `${client} user MCP surface is not current`);
      invariant(!surfaces[client].duplicate_scope, `${client} is installed in duplicate scopes`);
    }

    await protocolSmoke(root);

    for (const client of ["claude", "codex", "gemini"] as const) {
      await run([process.execPath, installers[client], "--uninstall"], { cwd: project, home });
      const reinstalled = await run([process.execPath, installers[client]], { cwd: project, home });
      const restoreBackup = backupFrom(reinstalled.stdout);
      await run([process.execPath, installers[client], "--restore", restoreBackup], { cwd: project, home });
      const file = client === "codex" ? "hooks.json" : "settings.json";
      invariant(readFileSync(join(home, `.${client}`, file), "utf8") === originals[client], `${client} restore did not recover the original configuration`);
      invariant(firstBackups.has(client), `${client} first backup evidence was not retained`);
    }

    console.log(JSON.stringify({ status: "passed", clients: ["claude", "codex", "gemini"], protocol: "register-discover-send-ack", credentials: "not-required" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`clean-install smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
