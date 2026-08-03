import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestBroker } from "./helpers/test-broker.ts";
import { peerName } from "../hooks/register-peer-session.ts";

const SERVER_SCRIPT = new URL("../server.ts", import.meta.url).pathname;
const REGISTER_SCRIPT = new URL("../hooks/register-peer-session.ts", import.meta.url).pathname;
const APP_SERVER_FIXTURE = new URL("./fixtures/codex-app-server-parent.ts", import.meta.url).pathname;
const APP_SERVER_HOOK_FIXTURE = new URL("./fixtures/codex-app-server-hook-parent.ts", import.meta.url).pathname;

const canUseTmux = Bun.spawnSync(["tmux", "list-sessions"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

(canUseTmux ? test : test.skip)("a pane-local app-server registers the exact Codex lane when the cwd is shared", async () => {
  const broker = await startTestBroker({ prefix: "appserver-register-pane" });
  const cwd = mkdtempSync(join(tmpdir(), "claude-peers-appserver-register-"));
  const otherSession = `cp-appreg-other-${process.pid}-${Date.now()}`;
  const currentSession = `cp-appreg-current-${process.pid}-${Date.now()}`;
  let appServer: ReturnType<typeof Bun.spawn> | null = null;
  try {
    for (const [session, name] of [[otherSession, "other-lane"], [currentSession, "stale-launch-name"]] as const) {
      const created = Bun.spawnSync([
        "tmux", "new-session", "-d", "-s", session, "-c", cwd,
        "env", `CLAUDE_PEER_NAME=${name}`, "bash", "-c", "exec -a codex sleep 60",
      ], { stdout: "pipe", stderr: "pipe" });
      expect(created.exitCode).toBe(0);
    }

    const currentPane = new TextDecoder().decode(Bun.spawnSync([
      "tmux", "list-panes", "-t", currentSession, "-F", "#{pane_id}",
    ]).stdout).trim();
    expect(currentPane).toMatch(/^%\d+$/);
    const currentPid = Number(new TextDecoder().decode(Bun.spawnSync([
      "tmux", "list-panes", "-t", currentSession, "-F", "#{pane_pid}",
    ]).stdout).trim());
    const currentTty = new TextDecoder().decode(Bun.spawnSync([
      "tmux", "list-panes", "-t", currentSession, "-F", "#{pane_tty}",
    ]).stdout).trim().replace(/^\/dev\//, "");
    expect(Bun.spawnSync([
      "tmux", "set-option", "-p", "-t", currentPane, "@peer_resolved_name", "orch.5",
    ]).exitCode).toBe(0);
    expect(Bun.spawnSync([
      "tmux", "set-option", "-p", "-t", currentPane, "@operator_label", "stale-human",
    ]).exitCode).toBe(0);

    const threadId = `019fc273-register-pane-${process.pid}`;
    const command = `exec -a codex bun ${JSON.stringify(APP_SERVER_HOOK_FIXTURE)} ${JSON.stringify(REGISTER_SCRIPT)} app-server`;
    appServer = Bun.spawn(["bash", "-c", command], {
      cwd,
      env: {
        ...process.env,
        TMUX: undefined,
        TMUX_PANE: currentPane,
        CLAUDE_PEER_NAME: "stale-launch-name",
        CLAUDE_PEERS_PORT: String(broker.port),
        CLAUDE_PEERS_DB: broker.dbPath,
        CLAUDE_PEERS_BRIDGE_TOKEN_FILE: broker.tokenPath,
        CLAUDE_PEERS_TMUX_IDENTITY_MIRROR: "0",
        HOOK_PROBE_SESSION_ID: threadId,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!(appServer.stdout instanceof ReadableStream) || !(appServer.stderr instanceof ReadableStream)) {
      throw new Error("app-server hook fixture output pipes unavailable");
    }
    const stdout = new Response(appServer.stdout).text();
    const stderr = new Response(appServer.stderr).text();
    expect(await appServer.exited).toBe(0);
    expect((await stdout).trim()).toBe("");
    expect(await stderr).toContain(`identity resolved via inherited pane ${currentPane}`);

    const db = new Database(broker.dbPath, { readonly: true });
    const rows = db.query(
      "SELECT name, pid, tty, thread_id, tmux_session, tmux_pane_id, seat_key FROM peers ORDER BY id",
    ).all() as Array<Record<string, unknown>>;
    db.close();
    expect(rows).toEqual([{
      name: "orch.5",
      pid: currentPid,
      tty: currentTty,
      thread_id: threadId,
      tmux_session: currentSession,
      tmux_pane_id: currentPane,
      seat_key: `pane:${currentSession}:${currentPane}`,
    }]);

    expect(Bun.spawnSync([
      "tmux", "set-option", "-p", "-t", currentPane, "@peer_resolved_name", "",
    ]).exitCode).toBe(0);
    expect(Bun.spawnSync([
      "tmux", "set-option", "-p", "-t", currentPane, "@operator_label", "operator-fallback",
    ]).exitCode).toBe(0);
    expect(peerName("codex", currentPid, { session: currentSession, pane_id: currentPane }, {
      CLAUDE_PEER_NAME: "stale-launch-name",
    })).toBe("operator-fallback");

    Bun.spawnSync(["tmux", "kill-session", "-t", otherSession], { stdout: "ignore", stderr: "ignore" });
    const mismatchThreadId = `${threadId}-mismatch`;
    appServer = Bun.spawn(["bash", "-c", command], {
      cwd,
      env: {
        ...process.env,
        TMUX: undefined,
        TMUX_PANE: "%999999",
        CLAUDE_PEER_NAME: "wrong-pane",
        CLAUDE_PEERS_PORT: String(broker.port),
        CLAUDE_PEERS_DB: broker.dbPath,
        CLAUDE_PEERS_BRIDGE_TOKEN_FILE: broker.tokenPath,
        CLAUDE_PEERS_TMUX_IDENTITY_MIRROR: "0",
        HOOK_PROBE_SESSION_ID: mismatchThreadId,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!(appServer.stderr instanceof ReadableStream)) throw new Error("mismatch hook stderr unavailable");
    const mismatchStderr = new Response(appServer.stderr).text();
    expect(await appServer.exited).toBe(1);
    expect(await mismatchStderr).toContain("no codex ancestor found");
    const afterMismatch = new Database(broker.dbPath, { readonly: true });
    const mismatchCount = afterMismatch.query("SELECT COUNT(*) AS count FROM peers WHERE thread_id = ?")
      .get(mismatchThreadId) as { count: number };
    afterMismatch.close();
    expect(mismatchCount.count).toBe(0);
  } finally {
    appServer?.kill();
    Bun.spawnSync(["tmux", "kill-session", "-t", otherSession], { stdout: "ignore", stderr: "ignore" });
    Bun.spawnSync(["tmux", "kill-session", "-t", currentSession], { stdout: "ignore", stderr: "ignore" });
    await broker.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);

(canUseTmux ? test : test.skip)("delayed app-server respawn binds by thread to the hook-owned pane and retains it on close", async () => {
  const broker = await startTestBroker({ prefix: "appserver-seat" });
  const cwd = mkdtempSync(join(tmpdir(), "claude-peers-appserver-seat-"));
  const session = `cp-appseat-${process.pid}-${Date.now()}`;
  let appServer: ReturnType<typeof Bun.spawn> | null = null;
  let appServerStderr: Promise<string> | null = null;
  try {
    const threadId = `019fc273-appserver-${process.pid}`;
    const created = Bun.spawnSync([
      "tmux", "new-session", "-d", "-s", session, "-c", cwd,
      "env", "CLAUDE_PEER_NAME=appserver-proof", "bash", "-c", "exec -a codex sleep 60",
    ], { stdout: "pipe", stderr: "pipe" });
    expect(created.exitCode).toBe(0);

    const paneResult = Bun.spawnSync([
      "tmux", "list-panes", "-t", session,
      "-F", "#{pane_pid}\t#{pane_id}\t#{pane_tty}\t#{session_name}\t#{window_index}\t#{window_name}",
    ]);
    expect(paneResult.exitCode).toBe(0);
    const [pidText, paneId, tty, tmuxSession, windowIndex, windowName] = new TextDecoder().decode(paneResult.stdout).trim().split("\t");
    const tuiPid = Number(pidText);
    expect(Number.isInteger(tuiPid)).toBe(true);

    const registered = await fetch(`${broker.url}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pid: tuiPid,
        cwd,
        git_root: null,
        absolute_git_dir: null,
        tty,
        name: "appserver-proof",
        tmux_session: tmuxSession,
        tmux_window_index: windowIndex,
        tmux_window_name: windowName,
        tmux_pane_id: paneId,
        thread_id: threadId,
        client_type: "codex",
        receiver_mode: "codex-hook",
        preserve_token: true,
        summary: "",
      }),
    });
    expect(registered.status).toBe(200);
    const hookRow = await registered.json() as { id: string; token: string };

    // Regression guard for the rejected launch-window design: a healthy MCP
    // connection can respawn long after its TUI. This exceeds the old 300-tick
    // (~3 second) window but must still resolve through the exact ThreadId.
    await Bun.sleep(3_500);

    const appServerCommand = `exec -a codex bun ${JSON.stringify(APP_SERVER_FIXTURE)} ${JSON.stringify(SERVER_SCRIPT)} app-server`;
    appServer = Bun.spawn(["bash", "-c", appServerCommand], {
      cwd,
      env: {
        ...process.env,
        TMUX: undefined,
        TMUX_PANE: undefined,
        CLAUDE_PEER_NAME: undefined,
        CLAUDE_PEERS_PORT: String(broker.port),
        CLAUDE_PEERS_DB: broker.dbPath,
        CLAUDE_PEERS_BRIDGE_TOKEN_FILE: broker.tokenPath,
        CLAUDE_PEERS_TMUX_IDENTITY_MIRROR: "0",
        MCP_PROBE_THREAD_ID: threadId,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!(appServer.stdout instanceof ReadableStream) || !(appServer.stderr instanceof ReadableStream)) {
      throw new Error("app-server fixture output pipes unavailable");
    }
    const appServerStdout = new Response(appServer.stdout).text();
    appServerStderr = new Response(appServer.stderr).text();
    await appServer.exited;

    const output = await appServerStdout;
    expect(output).toContain('"id":2');
    expect(output).toContain(hookRow.id);
    expect(output).toContain("appserver-proof");

    const afterDb = new Database(broker.dbPath, { readonly: true });
    const afterClose = afterDb.query("SELECT id, pid, name, thread_id, seat_key, token FROM peers").all() as Array<Record<string, unknown>>;
    afterDb.close();
    expect(afterClose).toEqual([{
      id: hookRow.id,
      pid: tuiPid,
      name: "appserver-proof",
      thread_id: threadId,
      seat_key: `pane:${tmuxSession}:${paneId}`,
      token: hookRow.token,
    }]);
    const stderr = await appServerStderr;
    expect(stderr).toContain(`app-server identity verified via thread=${threadId} hook-owned pid=${tuiPid}`);
    expect(stderr).toContain(`Retained hook-owned seat ${hookRow.id} during MCP shutdown`);
  } finally {
    appServer?.kill();
    Bun.spawnSync(["tmux", "kill-session", "-t", session], { stdout: "ignore", stderr: "ignore" });
    await broker.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);

(canUseTmux ? test : test.skip)("unbound app-server MCP tools fail loudly without creating an observer row", async () => {
  const broker = await startTestBroker({ prefix: "appserver-unbound" });
  const cwd = mkdtempSync(join(tmpdir(), "claude-peers-appserver-unbound-"));
  const session = `cp-appunbound-${process.pid}-${Date.now()}`;
  let appServer: ReturnType<typeof Bun.spawn> | null = null;
  try {
    const created = Bun.spawnSync([
      "tmux", "new-session", "-d", "-s", session, "-c", cwd,
      "env", "CLAUDE_PEER_NAME=appserver-unbound", "bash", "-c", "exec -a codex sleep 60",
    ], { stdout: "pipe", stderr: "pipe" });
    expect(created.exitCode).toBe(0);

    const appServerCommand = `exec -a codex bun ${JSON.stringify(APP_SERVER_FIXTURE)} ${JSON.stringify(SERVER_SCRIPT)} app-server`;
    appServer = Bun.spawn(["bash", "-c", appServerCommand], {
      cwd,
      env: {
        ...process.env,
        TMUX: undefined,
        TMUX_PANE: undefined,
        CLAUDE_PEER_NAME: undefined,
        CLAUDE_PEERS_PORT: String(broker.port),
        CLAUDE_PEERS_DB: broker.dbPath,
        CLAUDE_PEERS_BRIDGE_TOKEN_FILE: broker.tokenPath,
        CLAUDE_PEERS_TMUX_IDENTITY_MIRROR: "0",
        MCP_PROBE_THREAD_ID: "019fc273-unbound-thread",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!(appServer.stdout instanceof ReadableStream) || !(appServer.stderr instanceof ReadableStream)) {
      throw new Error("app-server fixture output pipes unavailable");
    }
    const stdout = new Response(appServer.stdout).text();
    const stderr = new Response(appServer.stderr).text();
    await appServer.exited;

    const output = await stdout;
    expect(output).toContain('"id":2');
    expect(output).toContain('"isError":true');
    expect(output).toContain("did not run whoami");
    expect(await stderr).toContain("Codex app-server identity requires thread-bound hook seat proof");

    const db = new Database(broker.dbPath, { readonly: true });
    const rows = db.query("SELECT id, name, seat_key FROM peers").all();
    db.close();
    expect(rows).toEqual([]);
  } finally {
    appServer?.kill();
    Bun.spawnSync(["tmux", "kill-session", "-t", session], { stdout: "ignore", stderr: "ignore" });
    await broker.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);
