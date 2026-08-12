import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  const childEnv = { ...process.env, ...env };
  // The fallback tests intentionally provide XDG_RUNTIME_DIR but no explicit
  // standby override. Do not let the operator's ambient override defeat that
  // branch; a precedence test supplies the variable explicitly below.
  if (!Object.prototype.hasOwnProperty.call(env, "CLAUDE_PEERS_STANDBY_RUNTIME_DIR")) {
    delete childEnv.CLAUDE_PEERS_STANDBY_RUNTIME_DIR;
  }
  const child = Bun.spawn(["bash", watcher], {
    env: childEnv,
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
  test("fails open without HOME and records why it did not arm", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-standby-minimal-env-"));
    roots.push(root);
    const child = Bun.spawn(["env", "-i",
      `PATH=${process.env.PATH ?? "/usr/bin:/bin"}`,
      `TMPDIR=${root}`,
      "CLAUDE_PEERS_STANDBY_CLAUDE_PID=999999999",
      "bash", watcher,
    ], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    child.stdin.write(`${JSON.stringify({ session_id: "minimal-env-session" })}\n`);
    child.stdin.end();
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ]);

    expect(code).toBe(0);
    expect(stderr).not.toContain("HOME: unbound variable");
    expect(existsSync(join(root, ".claude", "logs", "standby-watcher.log"))).toBe(true);
  });

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
    expect(stderr).toContain('<peer-message from="codex-peer" sent_at="2026-07-12T13:00:00Z" relayed="false" replyable="true">');
    expect(stderr).toContain("reply proof");
    expect(stderr).toContain("Autonomous mode is enabled");
    expect(stderr).toContain("[REDACTED-PEER-MSG-TAG]");
    expect(stderr).not.toContain("</PEER-MESSAGE>");
    expect(stderr).not.toContain("\u001b");
    // Thread identity is probed FIRST, then the watcher falls back to the pid
    // route because this fixture's peer row carries no thread_id — the state
    // most of the live fleet is in. Pinning the full sequence (rather than just
    // the last two calls) is what proves the fallback actually happened instead
    // of the thread route silently succeeding against a stub.
    expect(requests.map((request) => request.path)).toEqual([
      "/claim-by-thread",
      "/claim-by-pid",
      "/ack-by-pid",
    ]);
    // index 2, not 1: [0] is the thread probe, [1] the pid claim, [2] the ack.
    expect(requests[2]?.body).toMatchObject({ pid: anchor.pid, caller_pid: anchor.pid, drain_id: "drain-7", ids: [7] });
    // The ack must use the SAME route family the claim succeeded on, or it acks
    // against a different resolution of identity than the one that served the mail.
    expect(requests[2]?.path).toBe("/ack-by-pid");
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

  test("drains by thread identity when the MCP pid is NOT discoverable by ancestry", async () => {
    // The live failure, 2026-08-03. Claude's hooks contract guarantees session_id
    // on Stop stdin; it does NOT guarantee that this hook is an ancestor of the
    // session's MCP server. In the real detached topology find_mcp_pid() finds
    // nothing, and the watcher used to `exit 0` silently — Stop reported success,
    // the transcript showed no hookErrors, and no watcher existed.
    //
    // This is the case every other test in this file misses, because they all
    // INJECT CLAUDE_PEERS_STANDBY_MCP_PID and so never exercise discovery
    // failure. Note the absence of that variable below — that is the point.
    const root = mkdtempSync(join(tmpdir(), "claude-peers-standby-detached-"));
    roots.push(root);
    const runtime = join(root, "runtime");
    mkdirSync(runtime, { mode: 0o700 });
    const customDb = join(root, "custom-peers.db");
    const db = new Database(customDb);
    db.run("CREATE TABLE peers (pid INTEGER PRIMARY KEY, thread_id TEXT, summary TEXT NOT NULL)");
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const broker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const body = await request.json() as Record<string, unknown>;
        requests.push({ path, body });
        if (path === "/claim-by-thread") {
          return Response.json({
            peer_id: "peer-detached",
            drain_id: "drain-99",
            messages: [{ id: 99, from_id: "codex-peer", to_id: "peer-detached", text: "detached delivery", sent_at: "2026-08-03T11:00:00Z", delivered: false, delivered_at: null }],
          });
        }
        return Response.json({ ok: true, acked: 1 });
      },
    });
    servers.push(broker);
    const anchor = Bun.spawn(["sleep", "20"]);
    children.push(anchor);
    // A detached thread must read the summary from the same thread-owned row,
    // not from whichever row happens to carry the visible Claude PID.
    db.run("INSERT INTO peers (pid, thread_id, summary) VALUES (?, ?, ?)", [anchor.pid, null, "standby ask"]);
    db.run("INSERT INTO peers (pid, thread_id, summary) VALUES (?, ?, ?)", [anchor.pid + 1, "detached-session-id", "standby auto"]);
    db.close();

    // Force discovery to FAIL, deterministically.
    //
    // Simply omitting CLAUDE_PEERS_STANDBY_MCP_PID is not enough and quietly
    // made this test meaningless on the first attempt: the test runner is a
    // descendant of a real `claude` process, so find_mcp_pid() walked up, found
    // it, and resolved the OPERATOR'S OWN live MCP server. The test passed while
    // exercising the opposite of the detached case — and worse, pointed a test
    // at a live session's adapter.
    //
    // A `ps` shim that reports nothing reproduces the real detached topology
    // honestly: no claude ancestor, no server child, discovery returns nothing.
    const shimBin = join(root, "bin");
    mkdirSync(shimBin, { mode: 0o700 });
    writeFileSync(join(shimBin, "ps"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

    const child = startWatcher({
      HOME: root,
      XDG_RUNTIME_DIR: runtime,
      PATH: `${shimBin}:${process.env.PATH ?? ""}`,
      CLAUDE_PEERS_DB: customDb,
      CLAUDE_PEERS_PORT: String(broker.port),
      CLAUDE_PEERS_STANDBY_CLAUDE_PID: String(anchor.pid),
      // deliberately NO CLAUDE_PEERS_STANDBY_MCP_PID — discovery must fail
      CLAUDE_PEERS_STANDBY_POLL_INTERVAL_SECONDS: "1",
    }, "detached-session-id");
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ]);

    // exit 2 is asyncRewake: mail was found and surfaced. Before the fix this
    // was exit 0 with an empty stderr and no broker call at all.
    expect(code).toBe(2);
    expect(stderr).toContain("detached delivery");
    expect(stderr).toContain("Autonomous mode is enabled");
    // It must never have needed the pid route.
    expect(requests.map((r) => r.path)).toEqual(["/claim-by-thread", "/ack-by-thread"]);
    expect(requests[0]?.body).toMatchObject({ thread_id: "detached-session-id" });
    // And it must NOT smuggle a pid in as identity — that would let the broker
    // resolve a different row than the thread names.
    expect(requests[0]?.body).not.toHaveProperty("pid");
  }, 15_000);

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
        // Match the real broker: an unknown thread is 404, not an empty claim.
        // This fixture's peer row carries no thread_id, so the watcher must fall
        // back to the pid route — which is the behaviour this test exercises.
        // Returning a well-formed empty claim here instead would let the watcher
        // latch onto the thread route and poll it forever, and the PID-refresh
        // path under test would never run.
        if (path.endsWith("-by-thread")) return Response.json({ error: "peer not found" }, { status: 404 });
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

  test("an explicit standby runtime directory wins over XDG_RUNTIME_DIR", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-standby-runtime-precedence-"));
    roots.push(root);
    const xdg = join(root, "xdg");
    const explicit = join(root, "explicit");
    mkdirSync(xdg, { mode: 0o700 });
    mkdirSync(explicit, { mode: 0o700 });
    const broker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/claim-by-pid") {
          return Response.json({ peer_id: "peer-test", drain_id: "empty", messages: [] });
        }
        return Response.json({ ok: true, acked: 0 });
      },
    });
    servers.push(broker);
    const anchor = Bun.spawn(["sleep", "20"]);
    children.push(anchor);
    const child = startWatcher({
      HOME: root,
      XDG_RUNTIME_DIR: xdg,
      CLAUDE_PEERS_STANDBY_RUNTIME_DIR: explicit,
      CLAUDE_PEERS_PORT: String(broker.port),
      CLAUDE_PEERS_STANDBY_CLAUDE_PID: String(anchor.pid),
      CLAUDE_PEERS_STANDBY_MCP_PID: String(anchor.pid),
      CLAUDE_PEERS_STANDBY_ACTIVE_SECONDS: "10",
      CLAUDE_PEERS_STANDBY_POLL_INTERVAL_SECONDS: "1",
    }, "runtime-precedence-test");
    children.push(child);

    const explicitState = join(explicit, "claude-peers", "standby");
    const deadline = Date.now() + 2_000;
    while (!existsSync(explicitState) && Date.now() < deadline) await Bun.sleep(50);
    expect(existsSync(explicitState)).toBe(true);
    expect(existsSync(join(xdg, "claude-peers", "standby"))).toBe(false);
    expect(statSync(explicitState).mode & 0o777).toBe(0o700);
  }, 4_000);
});
