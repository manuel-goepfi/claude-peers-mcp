import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXIT,
  httpBrokerApi,
  jsonRpcConnection,
  parseStopArgs,
  runCodexThreadStop,
  selectStopTarget,
  type BindingLookup,
  type BrokerApi,
  type RpcConnection,
} from "../bin/codex-thread-stop.ts";
import { FakeCodexAppServer, type FakeThread } from "./fixtures/fake-codex-app-server.ts";
import { startTestBroker, type TestBroker } from "./helpers/test-broker.ts";
import { lanesWithUnread } from "../bin/codex-autodrain-poller.ts";
import { shouldSelfRegisterAfterClaimError } from "../hooks/codex-drain-peer-inbox.ts";
import { initializeStorage } from "../shared/storage.ts";
import { applyCodexThreadGate, ensureCodexThreadControlTable } from "../shared/codex-thread-control.ts";

const T_LANE = "01a1108e-702f-7101-93c2-0824eac7bd3f";
const T_OTHER = "01a1108e-702f-7101-93c2-0824eac7bd40";
const T_THIRD = "01a1108e-702f-7101-93c2-0824eac7bd41";
const SOCKET = "/run/user/1000/codex-test/app-server-control.sock";
const CLI = new URL("../bin/codex-thread-stop.ts", import.meta.url).pathname;
const FAKE = new URL("./fixtures/fake-codex-app-server.ts", import.meta.url).pathname;

function fakeConnect(fake: FakeCodexAppServer, connects: string[] = []): (socket: string) => Promise<RpcConnection> {
  return async (socket) => {
    connects.push(socket);
    let listener: ((text: string) => void) | null = null;
    return jsonRpcConnection({
      send(text) {
        const frames = fake.handle(text);
        // A real server also pushes notifications; the client must ignore them.
        frames.unshift(JSON.stringify({ method: "thread/status/changed", params: { threadId: T_OTHER, status: { type: "idle" } } }));
        queueMicrotask(() => { for (const frame of frames) listener?.(frame); });
      },
      onMessage(next) { listener = next; },
      onClose() {},
      close() {},
    }, 2_000);
  };
}

function recordingBroker(lookup: BindingLookup) {
  const gates: Array<{ threadId: string; paneId: string | null }> = [];
  const api: BrokerApi = {
    async lookup() { return lookup; },
    async gate(threadId, paneId) { gates.push({ threadId, paneId }); return { gated_peer_ids: ["peer-lane"], queued: 1 }; },
  };
  return { api, gates };
}

function laneLookup(): BindingLookup {
  return {
    controls: [
      { thread_id: T_LANE, tmux_pane_id: "%28803", app_server_socket: SOCKET, bound_at: "2026-10-06T09:00:00.000Z", superseded_at: null, gate: null },
      { thread_id: T_THIRD, tmux_pane_id: "%28803", app_server_socket: SOCKET, bound_at: "2026-10-06T08:00:00.000Z", superseded_at: "2026-10-06T09:00:00.000Z", gate: null },
    ],
    peers: [{ id: "peer-lane", pid: 4242, tmux_pane_id: "%28803", thread_id: T_LANE, non_targetable: 0 }],
  };
}

function sharedServer(overrides: Record<string, FakeThread> = {}): FakeCodexAppServer {
  return new FakeCodexAppServer({
    [T_LANE]: { status: "active", turns: [{ id: "turn-old", status: "completed" }, { id: "turn-live", status: "inProgress" }], settleReads: 1 },
    [T_OTHER]: { status: "active", turns: [{ id: "turn-other", status: "inProgress" }] },
    [T_THIRD]: { status: "idle", turns: [{ id: "turn-third", status: "completed" }] },
    ...overrides,
  });
}

const quiet = { out: () => {}, err: () => {}, settleMs: 500, pollMs: 1 };

describe("codex-thread-stop against a shared app-server", () => {
  test("--pane interrupts and archives exactly that thread, after gating its mail", async () => {
    const fake = sharedServer();
    const broker = recordingBroker(laneLookup());
    const lines: string[] = [];
    const code = await runCodexThreadStop(
      { paneId: "%28803", dryRun: false, brokerPort: 7899 },
      { ...quiet, out: (line) => lines.push(line), broker: broker.api, connect: fakeConnect(fake) },
    );
    expect(code).toBe(EXIT.stopped);
    expect(broker.gates).toEqual([{ threadId: T_LANE, paneId: "%28803" }]);
    const interrupt = fake.calls.findIndex((call) => call.method === "turn/interrupt");
    const archive = fake.calls.findIndex((call) => call.method === "thread/archive");
    expect(interrupt).toBeGreaterThan(-1);
    expect(fake.calls[interrupt]!.params).toEqual({ threadId: T_LANE, turnId: "turn-live" });
    expect(archive).toBeGreaterThan(interrupt);
    expect(fake.mutatingCalls().map((call) => [call.method, call.threadId])).toEqual([
      ["turn/interrupt", T_LANE],
      ["thread/archive", T_LANE],
    ]);
    // Neighbouring lanes on the same server: untouched and still running.
    expect(fake.callsFor(T_OTHER)).toEqual([]);
    expect(fake.callsFor(T_THIRD)).toEqual([]);
    expect(fake.loadedIds().sort()).toEqual([T_OTHER, T_THIRD].sort());
    expect(fake.threads.get(T_OTHER)!.turns![0]!.status).toBe("inProgress");
    // The stopped thread can no longer run a turn on the server.
    expect(fake.handle(JSON.stringify({ id: 99, method: "turn/start", params: { threadId: T_LANE, input: [] } }))[0])
      .toContain(`thread not found: ${T_LANE}`);
    expect(lines.join("\n")).toContain("verified");
  });

  test("--dry-run sends no gate, interrupt, or archive", async () => {
    const fake = sharedServer();
    const broker = recordingBroker(laneLookup());
    const code = await runCodexThreadStop(
      { paneId: "%28803", dryRun: true, brokerPort: 7899 },
      { ...quiet, broker: broker.api, connect: fakeConnect(fake) },
    );
    expect(code).toBe(EXIT.stopped);
    expect(broker.gates).toEqual([]);
    expect(fake.mutatingCalls()).toEqual([]);
    expect(fake.loadedIds()).toContain(T_LANE);
    expect(fake.threads.get(T_LANE)!.turns![1]!.status).toBe("inProgress");
  });

  test("an ambiguous pane binding is refused before any server contact", async () => {
    const fake = sharedServer();
    const lookup = laneLookup();
    lookup.peers.push({ id: "peer-other", pid: 4343, tmux_pane_id: "%28803", thread_id: T_OTHER, non_targetable: 0 });
    const broker = recordingBroker(lookup);
    const connects: string[] = [];
    const errors: string[] = [];
    const code = await runCodexThreadStop(
      { paneId: "%28803", dryRun: false, brokerPort: 7899 },
      { ...quiet, err: (line) => errors.push(line), broker: broker.api, connect: fakeConnect(fake, connects) },
    );
    expect(code).toBe(EXIT.refused);
    expect(errors.join("\n")).toContain("ambiguous binding");
    expect(connects).toEqual([]);
    expect(broker.gates).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  test("conflicting or missing app-server records are refused", () => {
    const lookup = laneLookup();
    expect(selectStopTarget(lookup, { paneId: "%28803", socket: "/other.sock" }).kind).toBe("refuse");
    lookup.controls[0]!.app_server_socket = null;
    const missing = selectStopTarget(lookup, { paneId: "%28803" });
    expect(missing.kind).toBe("refuse");
    expect(selectStopTarget(lookup, { paneId: "%28803", socket: SOCKET })).toMatchObject({ kind: "target", threadId: T_LANE, socket: SOCKET });
    expect(selectStopTarget(lookup, { paneId: "%28803", threadId: T_OTHER }).kind).toBe("refuse");
    expect(selectStopTarget({ controls: [], peers: [] }, { paneId: "%1" }).kind).toBe("refuse");
  });

  test("an already-gone thread exits 3 without interrupting or archiving anything live", async () => {
    const fake = sharedServer();
    fake.threads.delete(T_LANE);
    const broker = recordingBroker(laneLookup());
    expect(await runCodexThreadStop(
      { paneId: "%28803", dryRun: false, brokerPort: 7899 },
      { ...quiet, broker: broker.api, connect: fakeConnect(fake) },
    )).toBe(EXIT.gone);
    // Mail is still gated: a ghost registration must not get the queue.
    expect(broker.gates).toHaveLength(1);
    expect(fake.mutatingCalls()).toEqual([]);

    const unloaded = sharedServer({ [T_LANE]: { status: "notLoaded", archived: true } });
    expect(await runCodexThreadStop(
      { threadId: T_LANE, dryRun: false, brokerPort: 7899 },
      { ...quiet, broker: recordingBroker(laneLookup()).api, connect: fakeConnect(unloaded) },
    )).toBe(EXIT.gone);
    expect(unloaded.mutatingCalls().every((call) => call.threadId === T_LANE && call.method === "thread/archive")).toBe(true);

    const stopped = laneLookup();
    stopped.controls[0]!.gate = "stopped";
    stopped.peers = [];
    expect(await runCodexThreadStop(
      { paneId: "%28803", dryRun: false, brokerPort: 7899 },
      { ...quiet, broker: recordingBroker(stopped).api, connect: fakeConnect(sharedServer()) },
    )).toBe(EXIT.gone);
  });

  test("an unreachable app-server is refused without gating", async () => {
    const broker = recordingBroker(laneLookup());
    const code = await runCodexThreadStop(
      { paneId: "%28803", dryRun: false, brokerPort: 7899 },
      { ...quiet, broker: broker.api, connect: async () => { throw new Error("connect ENOENT"); } },
    );
    expect(code).toBe(EXIT.refused);
    expect(broker.gates).toEqual([]);
  });

  test("a thread that stays loaded after archive is a failure, not a stop", async () => {
    const fake = sharedServer();
    const original = fake.handle.bind(fake);
    fake.handle = (text: string) => {
      const frames = original(text);
      if (JSON.parse(text).method === "thread/archive") { fake.threads.get(T_LANE)!.archived = false; fake.threads.get(T_LANE)!.status = "idle"; }
      return frames;
    };
    expect(await runCodexThreadStop(
      { paneId: "%28803", dryRun: false, brokerPort: 7899 },
      { ...quiet, broker: recordingBroker(laneLookup()).api, connect: fakeConnect(fake) },
    )).toBe(EXIT.failed);
  });

  test("a silent app-server is a failure, never 'already gone'", async () => {
    const broker = recordingBroker(laneLookup());
    const silent: RpcConnection = {
      async request(method) {
        return method === "initialize" ? { result: {} } : { error: { code: -32001, message: `${method} timed out after 1ms` } };
      },
      notify() {},
      close() {},
    };
    expect(await runCodexThreadStop(
      { paneId: "%28803", dryRun: false, brokerPort: 7899 },
      { ...quiet, broker: broker.api, connect: async () => silent },
    )).toBe(EXIT.failed);
    expect(broker.gates).toEqual([]);
  });

  test("the drain hook treats a gated-thread 410 as terminal, not as a missing peer", () => {
    expect(shouldSelfRegisterAfterClaimError(new Error('/claim-by-thread 410: {"error":"codex thread stopped: peer mail delivery is gated"}'))).toBe(false);
    expect(shouldSelfRegisterAfterClaimError(new Error('/claim-by-thread 410: {"error":"codex thread pane closed: peer mail delivery is gated until a live pane re-binds it"}'))).toBe(false);
    expect(shouldSelfRegisterAfterClaimError(new Error('/claim-by-thread 404: {"error":"peer not found"}'))).toBe(true);
  });

  test("argument parsing", () => {
    expect(parseStopArgs(["--pane", "%28803", "--dry-run"], {})).toMatchObject({ ok: true, options: { paneId: "%28803", dryRun: true, brokerPort: 7899 } });
    expect(parseStopArgs(["--thread", T_LANE.toUpperCase()], {})).toMatchObject({ ok: true, options: { threadId: T_LANE } });
    expect(parseStopArgs([], {}).ok).toBe(false);
    expect(parseStopArgs(["--pane", "28803"], {}).ok).toBe(false);
    expect(parseStopArgs(["--thread", "nope"], {}).ok).toBe(false);
    expect(parseStopArgs(["--pane", "%1", "--socket", "relative.sock"], {}).ok).toBe(false);
  });
});

// --- broker gating -----------------------------------------------------------

const brokers: TestBroker[] = [];
const holders: Array<ReturnType<typeof Bun.spawn>> = [];
afterEach(async () => {
  for (const holder of holders.splice(0)) holder.kill();
  for (const broker of brokers.splice(0)) await broker.stop();
});

async function post(broker: TestBroker, path: string, body: Record<string, unknown>, token?: string) {
  const response = await fetch(`${broker.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { "X-Peer-Token": token } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function registerCodexThread(broker: TestBroker, threadId: string, paneId: string | null) {
  const holder = Bun.spawn(["sleep", "120"], { stdout: "ignore", stderr: "ignore" });
  holders.push(holder);
  const registered = await post(broker, "/register", {
    pid: holder.pid, cwd: broker.root, git_root: null, absolute_git_dir: null, tty: null,
    name: `lane-${threadId.slice(-4)}`, tmux_session: null, tmux_window_index: null, tmux_window_name: null,
    tmux_pane_id: null, thread_id: threadId, client_type: "codex", receiver_mode: "codex-hook", summary: "",
  });
  expect(registered.status).toBe(200);
  const id = String(registered.body.id);
  if (paneId) {
    const db = new Database(broker.dbPath);
    db.run("UPDATE peers SET tmux_pane_id = ? WHERE id = ?", [paneId, id]);
    db.close();
  }
  return { id, token: String(registered.body.token), pid: holder.pid! };
}

function queue(broker: TestBroker, toId: string, text: string): void {
  const db = new Database(broker.dbPath);
  db.run("INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?)", ["coordinator", toId, text, new Date().toISOString()]);
  db.close();
}

function delivered(broker: TestBroker, text: string): number {
  const db = new Database(broker.dbPath, { readonly: true });
  const row = db.query("SELECT delivered FROM messages WHERE text = ?").get(text) as { delivered: number };
  db.close();
  return row.delivered;
}

describe("peer-mail gating for a stopped Codex thread", () => {
  test("after a stop, queued mail stays queued and no delivery path hands it to the thread", async () => {
    const broker = await startTestBroker({ prefix: "codex-thread-stop" });
    brokers.push(broker);
    const lane = await registerCodexThread(broker, T_LANE, "%28803");
    const other = await registerCodexThread(broker, T_OTHER, "%28804");
    queue(broker, lane.id, "wake the closed lane");
    queue(broker, other.id, "for the live lane");

    const fake = sharedServer();
    const lines: string[] = [];
    const code = await runCodexThreadStop(
      { paneId: "%28803", socket: SOCKET, dryRun: false, brokerPort: broker.port },
      { ...quiet, out: (line) => lines.push(line), broker: httpBrokerApi(broker.port), connect: fakeConnect(fake) },
    );
    expect(code).toBe(EXIT.stopped);
    expect(lines.join("\n")).toContain("1 queued message(s) stay queued");

    // Hook drain by thread (the 2026-10-06 wake path): terminal 410, no mail.
    const claim = await post(broker, "/claim-by-thread", { thread_id: T_LANE, caller_pid: process.pid });
    expect(claim.status).toBe(410);
    expect(claim.body.messages).toBeUndefined();
    // MCP check_messages with the thread's still-valid token: nothing.
    const polled = await post(broker, "/poll-messages", { id: lane.id }, lane.token);
    expect(polled.status).toBe(200);
    expect(polled.body.messages).toEqual([]);
    // PID-routed drains: nothing.
    const byPid = await post(broker, "/poll-by-pid", { pid: lane.pid, caller_pid: process.pid });
    expect(byPid.body.messages ?? []).toEqual([]);
    const claimByPid = await post(broker, "/claim-by-pid", { pid: lane.pid, caller_pid: process.pid });
    expect(claimByPid.body.messages ?? []).toEqual([]);
    // Self-registration of the headless thread is refused.
    const ghost = await post(broker, "/register", {
      pid: lane.pid, cwd: broker.root, git_root: null, absolute_git_dir: null, tty: null, name: "ghost",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, tmux_pane_id: null,
      thread_id: T_LANE, client_type: "codex", receiver_mode: "codex-hook", summary: "",
    });
    expect(ghost.status).toBe(410);
    // New mail cannot be addressed to the stopped seat.
    const sent = await post(broker, "/send-message", { from_id: other.id, to_id: lane.id, text: "late" }, other.token);
    expect(sent.body.ok).toBe(false);
    // The queued message is still queued (not delivered, not deleted).
    expect(delivered(broker, "wake the closed lane")).toBe(0);
    // A stopped thread is never re-bound, even by a relay.
    const rebind = await post(broker, "/bind-codex-pane-thread", { caller_pid: process.pid, tmux_pane_id: "%28803", thread_id: T_LANE });
    expect(rebind.status).toBe(410);

    // The neighbouring lane still receives its mail.
    const otherClaim = await post(broker, "/claim-by-thread", { thread_id: T_OTHER, caller_pid: process.pid });
    expect(otherClaim.status).toBe(200);
    expect((otherClaim.body.messages as Array<{ text: string }>).map((m) => m.text)).toEqual(["for the live lane"]);

    // Lookup reflects the terminal gate; a second stop is "already gone".
    const again = await runCodexThreadStop(
      { paneId: "%28803", dryRun: false, brokerPort: broker.port },
      { ...quiet, broker: httpBrokerApi(broker.port), connect: fakeConnect(fake) },
    );
    expect(again).toBe(EXIT.gone);
  }, 20_000);

  test("a relay pane-closed gate applies only to the pane that owns the thread", async () => {
    const broker = await startTestBroker({ prefix: "codex-pane-closed" });
    brokers.push(broker);
    const lane = await registerCodexThread(broker, T_LANE, "%30001");
    queue(broker, lane.id, "after pane close");
    const db = new Database(broker.dbPath);
    db.run("INSERT INTO codex_thread_controls (thread_id, tmux_pane_id, app_server_socket, bound_at) VALUES (?, ?, ?, ?)",
      [T_LANE, "%30001", SOCKET, new Date().toISOString()]);
    db.close();

    const wrongPane = await post(broker, "/codex-thread-gate", { caller_pid: process.pid, thread_id: T_LANE, gate: "pane-closed", tmux_pane_id: "%30002" });
    expect(wrongPane.body.applied).toBe(false);
    expect((await post(broker, "/identity-by-thread", { thread_id: T_LANE, caller_pid: process.pid })).status).toBe(200);

    const closed = await post(broker, "/codex-thread-gate", { caller_pid: process.pid, thread_id: T_LANE, gate: "pane-closed", tmux_pane_id: "%30001" });
    expect(closed.body).toMatchObject({ applied: true, gate: "pane-closed", queued: 1, gated_peer_ids: [lane.id] });
    expect((await post(broker, "/claim-by-thread", { thread_id: T_LANE, caller_pid: process.pid })).status).toBe(410);
    expect(delivered(broker, "after pane close")).toBe(0);

    // A later explicit stop upgrades the gate; a pane-closed notice never downgrades it.
    const stopped = await post(broker, "/codex-thread-gate", { caller_pid: process.pid, thread_id: T_LANE, gate: "stopped", tmux_pane_id: "%30001" });
    expect(stopped.body.gate).toBe("stopped");
    const downgrade = await post(broker, "/codex-thread-gate", { caller_pid: process.pid, thread_id: T_LANE, gate: "pane-closed", tmux_pane_id: "%30001" });
    expect(downgrade.body.gate).toBe("stopped");
    const lookup = await post(broker, "/codex-thread-binding", { caller_pid: process.pid, tmux_pane_id: "%30001" });
    expect((lookup.body.controls as Array<{ gate: string; app_server_socket: string }>)[0]).toMatchObject({ gate: "stopped", app_server_socket: SOCKET });
    expect((await post(broker, "/codex-thread-gate", { caller_pid: process.pid, thread_id: T_LANE, gate: "everything" })).status).toBe(400);
    expect((await post(broker, "/codex-thread-binding", { caller_pid: process.pid })).status).toBe(400);
  }, 20_000);
});

// --- real transport ------------------------------------------------------------

describe("codex-thread-stop CLI over a real ws+unix socket", () => {
  test("stops one thread end to end and exits 0, then 3", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-thread-stop-"));
    const socket = join(root, "app-server-control.sock");
    const callsPath = join(root, "calls.json");
    const gates: unknown[] = [];
    const broker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const body = await request.json() as Record<string, unknown>;
        if (path === "/codex-thread-binding") {
          return Response.json({
            controls: [{ thread_id: T_LANE, tmux_pane_id: "%28803", app_server_socket: socket, bound_at: "x", superseded_at: null, gate: gates.length ? "stopped" : null }],
            peers: gates.length ? [] : [{ id: "peer-lane", pid: 1, tmux_pane_id: "%28803", thread_id: T_LANE, non_targetable: 0 }],
          });
        }
        if (path === "/codex-thread-gate") { gates.push(body); return Response.json({ ok: true, applied: true, gate: "stopped", gated_peer_ids: ["peer-lane"], queued: 0 }); }
        return Response.json({ error: "missing x-peer-token" }, { status: 401 });
      },
    });
    const state = {
      [T_LANE]: { status: "active", turns: [{ id: "turn-live", status: "inProgress" }] },
      [T_OTHER]: { status: "active", turns: [{ id: "turn-other", status: "inProgress" }] },
    };
    const server = Bun.spawn(["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", FAKE, socket, JSON.stringify(state), callsPath], {
      stdout: "pipe", stderr: "pipe",
    });
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !existsSync(socket)) await Bun.sleep(25);
      expect(existsSync(socket)).toBe(true);
      // Async spawn: the fake broker is served from this test's event loop.
      const run = async (args: string[]) => {
        const child = Bun.spawn(["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", CLI, ...args], {
          env: { ...process.env, CLAUDE_PEERS_PORT: String(broker.port) }, stdout: "pipe", stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        return { stdout, stderr, exitCode };
      };
      const first = await run(["--pane", "%28803"]);
      const stdout = first.stdout;
      expect({ code: first.exitCode, stderr: first.stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("interrupted turn turn-live");
      const recorded = JSON.parse(readFileSync(callsPath, "utf8")) as { calls: Array<{ method: string; threadId: string | null }>; loaded: string[] };
      expect(recorded.calls.filter((call) => call.method === "turn/interrupt" || call.method === "thread/archive")
        .map((call) => [call.method, call.threadId])).toEqual([["turn/interrupt", T_LANE], ["thread/archive", T_LANE]]);
      expect(recorded.loaded).toEqual([T_OTHER]);
      expect(gates).toHaveLength(1);
      expect((await run(["--pane", "%28803"])).exitCode).toBe(EXIT.gone);
      expect((await run(["--thread", T_LANE, "--socket", join(root, "missing.sock")])).exitCode).toBe(EXIT.refused);
    } finally {
      server.kill("SIGTERM");
      await server.exited;
      broker.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

// --- relay bind records the app-server; pane-closed lifts, stopped refuses ------

const BIND_CLIENT = new URL("./fixtures/codex-pane-bind-client.ts", import.meta.url).pathname;
const canUseTmux = Bun.which("tmux") !== null;

(canUseTmux ? describe : describe.skip)("relay bind records the per-thread app-server", () => {
  test("bind persists pane+socket, a pane-closed gate is lifted by a proven re-bind, a stopped thread is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-stop-bind-"));
    const socket = join(root, "tmux.sock");
    const shimDir = join(root, "tmux-bin");
    mkdirSync(shimDir);
    writeFileSync(join(shimDir, "tmux"), '#!/bin/sh\nexec "$TEST_REAL_TMUX" -S "$TEST_TMUX_SOCKET" "$@"\n');
    chmodSync(join(shimDir, "tmux"), 0o755);
    const privateEnv = {
      PATH: `${shimDir}:${process.env.PATH ?? ""}`,
      TEST_REAL_TMUX: Bun.which("tmux")!,
      TEST_TMUX_SOCKET: socket,
      CLAUDE_PEERS_TMUX_BIN: "tmux",
      CLAUDE_PEERS_TMUX_SOCKET: socket,
    };
    const broker = await startTestBroker({ prefix: "codex-stop-bind", env: privateEnv });
    brokers.push(broker);
    const session = `cp-stop-bind-${process.pid}-${Date.now()}`;
    try {
      const codexBinary = join(root, "codex");
      copyFileSync("/usr/bin/sleep", codexBinary);
      chmodSync(codexBinary, 0o755);
      const r1 = join(root, "r1.json"), r2 = join(root, "r2.json"), r3 = join(root, "r3.json");
      const go2 = join(root, "go2"), go3 = join(root, "go3");
      const command = [
        `tmux set-option -p -t "$TMUX_PANE" @operator_label stop.bind`,
        `(cd /; exec "${codexBinary}" 60) & tui=$!`,
        `bun "${BIND_CLIENT}" "${broker.port}" "${r1}" "${T_LANE}"`,
        `while [ ! -f "${go2}" ]; do sleep 0.05; done`,
        `bun "${BIND_CLIENT}" "${broker.port}" "${r2}" "${T_LANE}" "${T_OTHER}"`,
        `while [ ! -f "${go3}" ]; do sleep 0.05; done`,
        `bun "${BIND_CLIENT}" "${broker.port}" "${r3}" "${T_OTHER}"`,
        `wait "$tui"`,
      ].join("; ");
      const created = Bun.spawnSync([
        "tmux", "-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, "-n", "bind", "-c", root,
        "env", `APP_SERVER_SOCKET=${SOCKET}`, "bash", "-c", command,
      ], { env: { ...process.env, ...privateEnv }, stdout: "pipe", stderr: "pipe" });
      expect(created.exitCode).toBe(0);
      const paneId = new TextDecoder().decode(Bun.spawnSync(["tmux", "-S", socket, "list-panes", "-t", session, "-F", "#{pane_id}"]).stdout).trim();
      const waitFor = async (path: string) => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && !existsSync(path)) await Bun.sleep(50);
        return JSON.parse(readFileSync(path, "utf8")) as Array<{ status: number; body: Record<string, unknown> }>;
      };

      const first = await waitFor(r1);
      expect(first.map((result) => result.status)).toEqual([200]);
      const lookup = await post(broker, "/codex-thread-binding", { caller_pid: process.pid, tmux_pane_id: paneId });
      expect((lookup.body.controls as Array<Record<string, unknown>>).map((row) => [row.thread_id, row.app_server_socket, row.gate]))
        .toEqual([[T_LANE, SOCKET, null]]);
      const selected = selectStopTarget(lookup.body as unknown as BindingLookup, { paneId });
      expect(selected).toMatchObject({ kind: "target", threadId: T_LANE, socket: SOCKET });

      // The relay's shutdown notice gates the pane's thread...
      const closed = await post(broker, "/codex-thread-gate", { caller_pid: process.pid, thread_id: T_LANE, gate: "pane-closed", tmux_pane_id: paneId });
      expect(closed.body.applied).toBe(true);
      expect((await post(broker, "/identity-by-thread", { thread_id: T_LANE, caller_pid: process.pid })).status).toBe(410);
      // ...and an explicit resume proven by a live pane lifts it; a new task in
      // the same pane supersedes the old one for --pane.
      writeFileSync(go2, "");
      expect((await waitFor(r2)).map((result) => result.status)).toEqual([200, 200]);
      const afterResume = await post(broker, "/codex-thread-binding", { caller_pid: process.pid, thread_id: T_LANE });
      expect((afterResume.body.controls as Array<Record<string, unknown>>)[0]).toMatchObject({ gate: null, tmux_pane_id: paneId });
      const byPane = await post(broker, "/codex-thread-binding", { caller_pid: process.pid, tmux_pane_id: paneId });
      expect(selectStopTarget(byPane.body as unknown as BindingLookup, { paneId })).toMatchObject({ kind: "target", threadId: T_OTHER });

      // A stopped thread is never re-bound.
      expect((await post(broker, "/codex-thread-gate", { caller_pid: process.pid, thread_id: T_OTHER, gate: "stopped", tmux_pane_id: paneId })).body.gate).toBe("stopped");
      writeFileSync(go3, "");
      expect((await waitFor(r3)).map((result) => result.status)).toEqual([410]);
    } finally {
      Bun.spawnSync(["tmux", "-S", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
});

describe("autodrain poller never wakes a gated thread", () => {
  test("a stopped thread's queued mail produces no pane wake; other lanes still do", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-stop-poller-"));
    const db = new Database(join(root, "peers.db"));
    try {
      initializeStorage(db, { databasePath: join(root, "peers.db") });
      ensureCodexThreadControlTable(db);
      const now = new Date().toISOString();
      for (const [id, thread, pane] of [["lane", T_LANE, "%28803"], ["other", T_OTHER, "%28804"]] as const) {
        db.run(`INSERT INTO peers (id, pid, cwd, name, tmux_pane_id, thread_id, client_type, receiver_mode, registered_at, last_seen, token)
          VALUES (?, 1, '/repo', ?, ?, ?, 'codex', 'codex-hook', ?, ?, ?)`, [id, id, pane, thread, now, now, `token-${id}`]);
        db.run("INSERT INTO messages (from_id, to_id, text, sent_at) VALUES ('coordinator', ?, 'wake', ?)", [id, now]);
      }
      expect(lanesWithUnread(db, ["codex"]).map((lane) => lane.id).sort()).toEqual(["lane", "other"]);
      applyCodexThreadGate(db, { threadId: T_LANE, gate: "stopped", paneId: "%28803", nowIso: now });
      expect(lanesWithUnread(db, ["codex"]).map((lane) => lane.id)).toEqual(["other"]);
      expect(db.query("SELECT delivered FROM messages WHERE to_id = 'lane'").get()).toEqual({ delivered: 0 });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
