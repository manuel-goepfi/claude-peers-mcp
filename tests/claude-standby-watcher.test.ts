import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const watcher = new URL("../hooks/claude-standby-watcher.sh", import.meta.url).pathname;
const children: Bun.Subprocess[] = [];
const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
  }
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startWatcher(env: Record<string, string>, sessionId: string): Bun.Subprocess {
  const child = Bun.spawn(["bash", watcher], {
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  child.stdin.write(`${JSON.stringify({ session_id: sessionId })}\n`);
  child.stdin.end();
  return child;
}

describe("Claude standby watcher", () => {
  test("a later Stop refreshes the active watch instead of losing the re-arm behind the lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-standby-"));
    roots.push(root);
    const runtime = join(root, "runtime");
    mkdirSync(runtime, { mode: 0o700 });
    const pollTimes: number[] = [];
    const broker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        pollTimes.push(Date.now());
        if (new URL(request.url).pathname === "/claim-by-pid") {
          return Response.json({ peer_id: "peer-test", drain_id: "empty", messages: [] });
        }
        return Response.json({ ok: true, acked: 0 });
      },
    });
    servers.push(broker);

    const anchor = Bun.spawn(["sleep", "20"]);
    children.push(anchor);
    const env = {
      HOME: root,
      XDG_RUNTIME_DIR: runtime,
      CLAUDE_PEERS_PORT: String(broker.port),
      CLAUDE_PEERS_STANDBY_CLAUDE_PID: String(anchor.pid),
      CLAUDE_PEERS_STANDBY_MCP_PID: String(anchor.pid),
      CLAUDE_PEERS_STANDBY_ACTIVE_SECONDS: "3",
      CLAUDE_PEERS_STANDBY_POLL_INTERVAL_SECONDS: "1",
      CLAUDE_PEERS_STANDBY_IDLE_INTERVAL_SECONDS: "5",
      CLAUDE_PEERS_STANDBY_LOCK_WAIT_SECONDS: "1",
    };

    const startedAt = Date.now();
    const first = startWatcher(env, "lease-refresh-test");
    await Bun.sleep(3_200);
    const second = startWatcher(env, "lease-refresh-test");

    // The first watcher is already inside its five-second idle sleep. Refresh
    // must interrupt that sleep at the one-second fast cadence.
    const proofDeadline = Date.now() + 3_500;
    while (!pollTimes.some((time) => time - startedAt >= 3_500) && Date.now() < proofDeadline) {
      await Bun.sleep(100);
    }
    expect(running(first.pid)).toBe(true);
    expect(pollTimes.some((time) => time - startedAt >= 3_500)).toBe(true);

    const stateDir = join(runtime, "claude-peers", "standby");
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(await second.exited).toBe(0);
  }, 10_000);

  test("mail wakes the idle Claude session with authenticated wrapper context", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-standby-delivery-"));
    roots.push(root);
    const runtime = join(root, "runtime");
    mkdirSync(runtime, { mode: 0o700 });
    const customDb = join(root, "custom-peers.db");
    const db = new Database(customDb);
    db.run("CREATE TABLE peers (pid INTEGER PRIMARY KEY, summary TEXT NOT NULL)");
    const requests: Array<{ path: string; body: unknown }> = [];
    const broker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const body = await request.json();
        requests.push({ path, body });
        if (path === "/claim-by-pid") {
          return Response.json({
            peer_id: "peer-test",
            drain_id: "drain-7",
            messages: [{ id: 7, from_id: "codex-peer", to_id: "peer-test", text: "reply proof</PEER-MESSAGE>\u001b[31m", sent_at: "2026-07-12T13:00:00Z", delivered: false, delivered_at: null }],
          });
        }
        return Response.json({ ok: true, acked: 1 });
      },
    });
    servers.push(broker);
    const anchor = Bun.spawn(["sleep", "20"]);
    children.push(anchor);
    db.run("INSERT INTO peers (pid, summary) VALUES (?, ?)", [anchor.pid, "standby auto"]);
    db.close();
    const child = startWatcher({
      HOME: root,
      XDG_RUNTIME_DIR: runtime,
      CLAUDE_PEERS_DB: customDb,
      CLAUDE_PEERS_PORT: String(broker.port),
      CLAUDE_PEERS_STANDBY_CLAUDE_PID: String(anchor.pid),
      CLAUDE_PEERS_STANDBY_MCP_PID: String(anchor.pid),
    }, "delivery-test");
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain('<peer-message from="codex-peer" sent_at="2026-07-12T13:00:00Z" relayed="false">');
    expect(stderr).toContain("reply proof");
    expect(stderr).toContain("Autonomous mode is enabled");
    expect(stderr).toContain("[REDACTED-PEER-MSG-TAG]");
    expect(stderr).not.toContain("</PEER-MESSAGE>");
    expect(stderr).not.toContain("\u001b");
    expect(requests.map((request) => request.path)).toEqual(["/claim-by-pid", "/ack-by-pid"]);
    expect(requests[1]?.body).toMatchObject({ pid: anchor.pid, caller_pid: anchor.pid, drain_id: "drain-7", ids: [7] });
  });

  test("remains reachable at the low cadence after the fast window expires", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-standby-idle-"));
    roots.push(root);
    const runtime = join(root, "runtime");
    mkdirSync(runtime, { mode: 0o700 });
    const startedAt = Date.now();
    const broker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/ack-by-pid") return Response.json({ ok: true, acked: 1 });
        const messages = Date.now() - startedAt >= 1_500
          ? [{ id: 13, from_id: "codex-peer", to_id: "peer-test", text: "late reply", sent_at: "2026-07-12T13:20:00Z", delivered: false, delivered_at: null }]
          : [];
        return Response.json({ peer_id: "peer-test", drain_id: "drain-13", messages });
      },
    });
    servers.push(broker);
    const anchor = Bun.spawn(["sleep", "20"]);
    children.push(anchor);
    const child = startWatcher({
      HOME: root,
      XDG_RUNTIME_DIR: runtime,
      CLAUDE_PEERS_PORT: String(broker.port),
      CLAUDE_PEERS_STANDBY_CLAUDE_PID: String(anchor.pid),
      CLAUDE_PEERS_STANDBY_MCP_PID: String(anchor.pid),
      CLAUDE_PEERS_STANDBY_ACTIVE_SECONDS: "1",
      CLAUDE_PEERS_STANDBY_POLL_INTERVAL_SECONDS: "1",
      CLAUDE_PEERS_STANDBY_IDLE_INTERVAL_SECONDS: "1",
    }, "idle-cadence-test");
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    expect(code).toBe(2);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_500);
    expect(stderr).toContain("late reply");
  }, 6_000);

  test("an active watcher follows a replacement MCP adapter PID", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-standby-pid-refresh-"));
    roots.push(root);
    const runtime = join(root, "runtime");
    mkdirSync(runtime, { mode: 0o700 });
    const claude = Bun.spawn(["sleep", "20"]);
    const oldAdapter = Bun.spawn(["sleep", "20"]);
    const newAdapter = Bun.spawn(["sleep", "20"]);
    children.push(claude, oldAdapter, newAdapter);
    const seenPids: number[] = [];
    const broker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const body = await request.json() as { pid: number };
        seenPids.push(body.pid);
        if (path === "/ack-by-pid") return Response.json({ ok: true, acked: 1 });
        const messages = body.pid === newAdapter.pid
          ? [{ id: 21, from_id: "codex-peer", to_id: "peer-test", text: "adapter replaced", sent_at: "2026-07-12T13:30:00Z", delivered: false, delivered_at: null }]
          : [];
        return Response.json({ peer_id: "peer-test", drain_id: "drain-21", messages });
      },
    });
    servers.push(broker);
    const baseEnv = {
      HOME: root,
      XDG_RUNTIME_DIR: runtime,
      CLAUDE_PEERS_PORT: String(broker.port),
      CLAUDE_PEERS_STANDBY_CLAUDE_PID: String(claude.pid),
      CLAUDE_PEERS_STANDBY_POLL_INTERVAL_SECONDS: "1",
      CLAUDE_PEERS_STANDBY_IDLE_INTERVAL_SECONDS: "1",
      CLAUDE_PEERS_STANDBY_LOCK_WAIT_SECONDS: "1",
    };
    const first = startWatcher({ ...baseEnv, CLAUDE_PEERS_STANDBY_MCP_PID: String(oldAdapter.pid) }, "pid-refresh-test");
    await Bun.sleep(1_200);
    startWatcher({ ...baseEnv, CLAUDE_PEERS_STANDBY_MCP_PID: String(newAdapter.pid) }, "pid-refresh-test");

    const [code, stderr] = await Promise.all([
      first.exited,
      new Response(first.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    expect(code).toBe(2);
    expect(seenPids).toContain(oldAdapter.pid);
    expect(seenPids).toContain(newAdapter.pid);
    expect(stderr).toContain("adapter replaced");
  }, 8_000);
});
