import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const LAUNCHER = new URL("../bin/codex-shared-seat", import.meta.url).pathname;
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startUnixSocket(root: string, socket: string, label: string) {
  const script = join(root, `${label}.ts`);
  const ready = join(root, `${label}.ready`);
  mkdirSync(dirname(socket), { recursive: true });
  writeFileSync(script, `
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
const server = createServer();
server.listen(process.env.FAKE_UPSTREAM_SOCKET!, () => {
  writeFileSync(process.env.FAKE_UPSTREAM_READY!, "yes");
});
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
await new Promise(() => {});
`);
  const process = Bun.spawn(["bun", script], {
    cwd: root,
    env: {
      ...globalThis.process.env,
      FAKE_UPSTREAM_SOCKET: socket,
      FAKE_UPSTREAM_READY: ready,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++) Bun.sleepSync(10);
  if (!existsSync(ready)) {
    process.kill();
    await process.exited;
    throw new Error(`fake Unix server did not become ready: ${socket}`);
  }
  return process;
}

describe("codexd shared app-server launcher", () => {
  test("does not fall back from an absent Codex B socket to a live Codex A socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-shared-seat-no-upstream-"));
    roots.push(root);
    const state = join(root, "state");
    const runtime = join(root, "run");
    mkdirSync(state);
    mkdirSync(runtime);
    const fakeCodex = join(root, "codex");
    const fakeRelay = join(root, "relay.ts");
    writeFileSync(fakeCodex, `#!/usr/bin/env bash
touch "$FAKE_SHARED_STATE/tui.started"
`);
    chmodSync(fakeCodex, 0o755);
    writeFileSync(fakeRelay, `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_SHARED_STATE + "/relay.started", "yes");
`);

    const accountASocket = join(root, ".codex", "app-server-control", "app-server-control.sock");
    const missingSocket = join(root, ".codex-b", "app-server-control", "app-server-control.sock");
    const accountA = await startUnixSocket(root, accountASocket, "account-a-upstream");
    try {
      const result = Bun.spawnSync([LAUNCHER], {
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          CODEX_HOME: join(root, ".codex-b"),
          XDG_RUNTIME_DIR: runtime,
          TMUX_PANE: "%4243",
          CLAUDE_PEERS_REAL_CODEX: fakeCodex,
          CLAUDE_PEERS_CODEX_RELAY: fakeRelay,
          CLAUDE_PEERS_CODEX_APP_SERVER_SOCKET: undefined,
          FAKE_SHARED_STATE: state,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const stderr = new TextDecoder().decode(result.stderr);
      expect(result.exitCode).toBe(1);
      expect(stderr).toContain(`account app-server socket is unavailable: ${missingSocket}`);
      expect(stderr).not.toContain(accountASocket);
      expect(existsSync(join(state, "relay.started"))).toBe(false);
      expect(existsSync(join(state, "tui.started"))).toBe(false);
    } finally {
      accountA.kill();
      await accountA.exited;
    }
  });

  test("rejects an ordinary file where the account app-server socket must be", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-shared-seat-file-upstream-"));
    roots.push(root);
    const state = join(root, "state");
    mkdirSync(state);
    const fakeCodex = join(root, "codex");
    const fakeRelay = join(root, "relay.ts");
    const ordinaryFile = join(root, ".codex-b", "app-server-control", "app-server-control.sock");
    mkdirSync(dirname(ordinaryFile), { recursive: true });
    writeFileSync(ordinaryFile, "not a socket\n");
    writeFileSync(fakeCodex, `#!/usr/bin/env bash
touch "$FAKE_SHARED_STATE/tui.started"
`);
    chmodSync(fakeCodex, 0o755);
    writeFileSync(fakeRelay, `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_SHARED_STATE + "/relay.started", "yes");
`);

    const result = Bun.spawnSync([LAUNCHER], {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        CODEX_HOME: join(root, ".codex-b"),
        TMUX_PANE: "%4244",
        CLAUDE_PEERS_REAL_CODEX: fakeCodex,
        CLAUDE_PEERS_CODEX_RELAY: fakeRelay,
        CLAUDE_PEERS_CODEX_APP_SERVER_SOCKET: undefined,
        FAKE_SHARED_STATE: state,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      `account app-server socket is unavailable: ${ordinaryFile}`,
    );
    expect(existsSync(join(state, "relay.started"))).toBe(false);
    expect(existsSync(join(state, "tui.started"))).toBe(false);
  });

  test("fails before the headless fallback when the account socket is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-shared-seat-headless-no-upstream-"));
    roots.push(root);
    const state = join(root, "state");
    mkdirSync(state);
    const fakeCodex = join(root, "codex");
    writeFileSync(fakeCodex, `#!/usr/bin/env bash
touch "$FAKE_SHARED_STATE/tui.started"
`);
    chmodSync(fakeCodex, 0o755);
    const missingSocket = join(root, ".codex-b", "app-server-control", "app-server-control.sock");

    const result = Bun.spawnSync([LAUNCHER], {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        CODEX_HOME: join(root, ".codex-b"),
        TMUX_PANE: undefined,
        CLAUDE_PEERS_REAL_CODEX: fakeCodex,
        CLAUDE_PEERS_CODEX_APP_SERVER_SOCKET: undefined,
        FAKE_SHARED_STATE: state,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      `account app-server socket is unavailable: ${missingSocket}`,
    );
    expect(existsSync(join(state, "tui.started"))).toBe(false);
  });

  test("routes the TUI through a private Unix relay and reaps the relay on exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-shared-seat-"));
    roots.push(root);
    const state = join(root, "state");
    const runtime = join(root, "run");
    mkdirSync(state);
    mkdirSync(runtime);
    const fakeCodex = join(root, "codex");
    const fakeRelay = join(root, "relay.ts");
    const upstreamSocket = join(root, ".codex-b", "app-server-control", "app-server-control.sock");
    writeFileSync(fakeCodex, `#!/usr/bin/env bash
printf '%s\n' "$@" >"$FAKE_SHARED_STATE/tui.args"
exit 0
`);
    chmodSync(fakeCodex, 0o755);
    writeFileSync(fakeRelay, `
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index]!, process.argv[index + 1]!);
const socket = args.get("--socket")!;
const ready = args.get("--ready")!;
const server = createServer();
server.listen(socket, () => {
  writeFileSync(process.env.FAKE_SHARED_STATE + "/relay.pid", String(process.pid));
  writeFileSync(process.env.FAKE_SHARED_STATE + "/relay.upstream", args.get("--upstream")!);
  writeFileSync(ready, String(process.pid));
});
const stop = () => { server.close(() => process.exit(0)); };
process.on("SIGTERM", stop);
await new Promise(() => {});
`);

    const upstream = await startUnixSocket(root, upstreamSocket, "account-b-upstream");
    try {
      const result = Bun.spawnSync([LAUNCHER, "resume", "exact-thread"], {
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          CODEX_HOME: join(root, ".codex-b"),
          XDG_RUNTIME_DIR: runtime,
          TMUX_PANE: "%4242",
          CLAUDE_PEERS_REAL_CODEX: fakeCodex,
          CLAUDE_PEERS_CODEX_RELAY: fakeRelay,
          CLAUDE_PEERS_CODEX_APP_SERVER_SOCKET: undefined,
          FAKE_SHARED_STATE: state,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      const args = readFileSync(join(state, "tui.args"), "utf8").trim().split("\n");
      expect(args[0]).toBe("--remote");
      expect(args[1]).toMatch(/^unix:\/\/.+\/app-server\.sock$/);
      expect(args.slice(2)).toEqual(["--cd", root, "resume", "exact-thread"]);
      expect(readFileSync(join(state, "relay.upstream"), "utf8")).toBe(upstreamSocket);
      const relayPid = Number(readFileSync(join(state, "relay.pid"), "utf8"));
      expect(alive(relayPid)).toBe(false);
      expect(existsSync(args[1]!.slice("unix://".length))).toBe(false);
    } finally {
      upstream.kill();
      await upstream.exited;
    }
  });

  test("falls back explicitly when there is no tmux pane and the account socket is live", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-shared-seat-headless-"));
    roots.push(root);
    const state = join(root, "state");
    mkdirSync(state);
    const fakeCodex = join(root, "codex");
    const upstreamSocket = join(root, ".codex-b", "app-server-control", "app-server-control.sock");
    writeFileSync(fakeCodex, `#!/usr/bin/env bash
printf '%s\n' "$@" >"$FAKE_SHARED_STATE/tui.args"
`);
    chmodSync(fakeCodex, 0o755);
    const upstream = await startUnixSocket(root, upstreamSocket, "headless-account-b-upstream");
    try {
      const result = Bun.spawnSync([LAUNCHER, "resume", "exact-thread"], {
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          CODEX_HOME: join(root, ".codex-b"),
          TMUX_PANE: undefined,
          CLAUDE_PEERS_REAL_CODEX: fakeCodex,
          CLAUDE_PEERS_CODEX_APP_SERVER_SOCKET: undefined,
          FAKE_SHARED_STATE: state,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(result.stderr)).toContain("no verified tmux pane");
      expect(readFileSync(join(state, "tui.args"), "utf8")).toBe(
        `--remote\nunix://\n--cd\n${root}\nresume\nexact-thread\n`,
      );
    } finally {
      upstream.kill();
      await upstream.exited;
    }
  });
});
