/**
 * codex-thread-stop: stop ONE Codex lane thread on a SHARED Codex app-server.
 *
 * Shared seats (bin/codex-shared-seat) run every lane as a thread inside one
 * long-lived app-server. Closing the pane ends the TUI, not the thread: a
 * loaded thread can keep running headless and be re-driven by queued peer mail.
 * This tool ends exactly one thread and never the server:
 *
 *   1. resolve the pane/thread binding the relay published to the broker
 *      (/codex-thread-binding), refusing an ambiguous or socket-less binding;
 *   2. connect to that app-server socket (refuse if unreachable) and read the
 *      thread's own status (thread/read, thread/loaded/list);
 *   3. gate peer mail for the thread in the broker (/codex-thread-gate stopped)
 *      BEFORE touching the turn, so an interrupt-triggered Stop hook cannot
 *      claim mail;
 *   4. turn/interrupt every in-progress turn (ids from thread/turns/list);
 *   5. thread/archive the thread (the server unloads it);
 *   6. verify with the server's own status that it is no longer loaded.
 *
 * App-server method names are the v2 protocol of the installed Codex CLI
 * (0.160.1): `codex app-server generate-ts` emits ClientRequest.ts with
 * "thread/read", "thread/loaded/list", "thread/turns/list", "turn/interrupt"
 * and "thread/archive" (the legacy interruptConversation/archiveConversation
 * methods are not in that protocol). The relay already speaks this protocol
 * over the same ws+unix transport ("thread/start", "thread/resume",
 * "thread/name/set").
 *
 * Exit codes: 0 stopped, 3 already gone, 2 refused (ambiguous binding, no
 * binding, unreachable server or broker), 1 failed after acting, 64 usage.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const EXIT = { stopped: 0, failed: 1, refused: 2, gone: 3, usage: 64 } as const;

export interface StopOptions {
  paneId?: string;
  threadId?: string;
  socket?: string;
  dryRun: boolean;
  brokerPort: number;
}

const THREAD_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = "usage: codex-thread-stop (--pane %N | --thread UUID) [--socket PATH] [--dry-run]";

export function parseStopArgs(argv: string[], env: Record<string, string | undefined> = process.env):
  | { ok: true; options: StopOptions }
  | { ok: false; error: string } {
  const options: StopOptions = { dryRun: false, brokerPort: Number(env.CLAUDE_PEERS_PORT ?? "7899") };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    try {
      if (arg === "--dry-run") options.dryRun = true;
      else if (arg === "--pane") options.paneId = value();
      else if (arg === "--thread") options.threadId = value().toLowerCase();
      else if (arg === "--socket") options.socket = value();
      else if (arg === "-h" || arg === "--help") return { ok: false, error: USAGE };
      else return { ok: false, error: `unknown argument: ${arg}\n${USAGE}` };
    } catch (error) {
      return { ok: false, error: `${(error as Error).message}\n${USAGE}` };
    }
  }
  if (!options.paneId && !options.threadId) return { ok: false, error: USAGE };
  if (options.paneId && !/^%\d+$/.test(options.paneId)) return { ok: false, error: "invalid --pane (expected %N)" };
  if (options.threadId && !THREAD_RE.test(options.threadId)) return { ok: false, error: "invalid --thread (expected a thread UUID)" };
  if (options.socket && !options.socket.startsWith("/")) return { ok: false, error: "--socket must be an absolute path" };
  if (!Number.isInteger(options.brokerPort) || options.brokerPort < 1 || options.brokerPort > 65535) {
    return { ok: false, error: "invalid CLAUDE_PEERS_PORT" };
  }
  return { ok: true, options };
}

// --- broker binding -------------------------------------------------------

export interface ControlRow {
  thread_id: string;
  tmux_pane_id: string | null;
  app_server_socket: string | null;
  bound_at: string | null;
  superseded_at: string | null;
  gate: "pane-closed" | "stopped" | null;
}

export interface BindingLookup {
  controls: ControlRow[];
  peers: Array<{ id: string; pid: number; tmux_pane_id: string | null; thread_id: string; non_targetable: number; alive?: boolean }>;
}

export type StopTarget =
  | { kind: "target"; threadId: string; socket: string; paneId: string | null; priorGate: ControlRow["gate"] }
  | { kind: "gone"; message: string }
  | { kind: "refuse"; message: string };

/**
 * Decide which single thread on which single app-server to stop. Anything
 * short of exactly one thread with exactly one known socket is a refusal.
 */
export function selectStopTarget(lookup: BindingLookup, options: Pick<StopOptions, "paneId" | "threadId" | "socket">): StopTarget {
  let threadId = options.threadId ?? null;
  if (options.paneId) {
    const current = lookup.controls.filter((row) => row.tmux_pane_id === options.paneId && !row.superseded_at && row.gate !== "stopped");
    const bound = lookup.peers.filter((row) => row.tmux_pane_id === options.paneId && row.non_targetable === 0);
    const threads = [...new Set([...current.map((row) => row.thread_id), ...bound.map((row) => row.thread_id)])];
    if (threadId) {
      if (threads.length > 0 && !threads.includes(threadId)) {
        return { kind: "refuse", message: `pane ${options.paneId} drives ${threads.join(", ")}, not ${threadId}; refusing a mismatched --pane/--thread pair` };
      }
    } else if (threads.length > 1) {
      return { kind: "refuse", message: `ambiguous binding: pane ${options.paneId} maps to ${threads.length} threads (${threads.join(", ")}); rerun with --thread` };
    } else if (threads.length === 1) {
      threadId = threads[0]!;
    } else {
      const stopped = lookup.controls.find((row) => row.tmux_pane_id === options.paneId && row.gate === "stopped" && !row.superseded_at);
      if (stopped) return { kind: "gone", message: `pane ${options.paneId}: thread ${stopped.thread_id} was already stopped` };
      return { kind: "refuse", message: `no Codex thread binding recorded for pane ${options.paneId}` };
    }
  }
  if (!threadId) return { kind: "refuse", message: "no thread selected" };
  const controls = lookup.controls.filter((row) => row.thread_id === threadId);
  const recorded = [...new Set(controls.map((row) => row.app_server_socket).filter((socket): socket is string => Boolean(socket)))];
  if (recorded.length > 1) {
    return { kind: "refuse", message: `ambiguous binding: thread ${threadId} has ${recorded.length} recorded app-servers (${recorded.join(", ")})` };
  }
  if (options.socket && recorded.length === 1 && recorded[0] !== options.socket) {
    return { kind: "refuse", message: `--socket ${options.socket} contradicts the recorded app-server ${recorded[0]} for thread ${threadId}` };
  }
  const socket = options.socket ?? recorded[0];
  if (!socket) {
    return { kind: "refuse", message: `no app-server socket recorded for thread ${threadId} (bound before the relay recorded sockets?); pass --socket PATH explicitly` };
  }
  const control = controls[0];
  return { kind: "target", threadId, socket, paneId: options.paneId ?? control?.tmux_pane_id ?? null, priorGate: control?.gate ?? null };
}

export interface BrokerApi {
  lookup(selector: { tmux_pane_id?: string; thread_id?: string }): Promise<BindingLookup>;
  gate(threadId: string, paneId: string | null): Promise<{ gated_peer_ids: string[]; queued: number }>;
}

export function httpBrokerApi(port: number, request: typeof fetch = fetch): BrokerApi {
  const post = async (path: string, body: Record<string, unknown>) => {
    const response = await request(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caller_pid: process.pid, ...body }),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    // An older broker routes unknown POST paths through peer-token auth.
    if (response.status === 401 && text.includes("x-peer-token")) {
      throw new Error(`broker on port ${port} has no ${path} route (deploy this branch and restart the broker)`);
    }
    if (!response.ok) throw new Error(`broker ${path} ${response.status}: ${text.slice(0, 240)}`);
    return JSON.parse(text) as Record<string, unknown>;
  };
  return {
    async lookup(selector) {
      return await post("/codex-thread-binding", selector) as unknown as BindingLookup;
    },
    async gate(threadId, paneId) {
      const value = await post("/codex-thread-gate", { thread_id: threadId, gate: "stopped", ...(paneId ? { tmux_pane_id: paneId } : {}) });
      return { gated_peer_ids: (value.gated_peer_ids as string[]) ?? [], queued: Number(value.queued ?? 0) };
    },
  };
}

// --- app-server JSON-RPC --------------------------------------------------

export interface RpcReply {
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface RpcConnection {
  request(method: string, params: unknown): Promise<RpcReply>;
  notify(method: string, params?: unknown): void;
  close(): void;
}

export interface RpcTransport {
  send(text: string): void;
  onMessage(listener: (text: string) => void): void;
  onClose(listener: (reason: string) => void): void;
  close(): void;
}

/** Codex app-server framing: {id, method, params} requests, no "jsonrpc" field. */
export function jsonRpcConnection(transport: RpcTransport, timeoutMs = 10_000): RpcConnection {
  let nextId = 0;
  const pending = new Map<string, { resolve: (reply: RpcReply) => void; timer: ReturnType<typeof setTimeout> }>();
  const failAll = (reason: string) => {
    for (const [key, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ error: { code: -32000, message: reason } });
      pending.delete(key);
    }
  };
  transport.onMessage((text) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(text) as Record<string, unknown>; } catch { return; }
    // Server notifications and server-initiated requests carry `method`; only
    // responses to our own ids settle a pending call.
    if (typeof message.method === "string") return;
    const key = `${typeof message.id}:${String(message.id)}`;
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    clearTimeout(entry.timer);
    entry.resolve({ result: message.result, error: message.error as RpcReply["error"] });
  });
  transport.onClose((reason) => failAll(`app-server connection closed: ${reason}`));
  return {
    request(method, params) {
      const id = `codex-thread-stop-${++nextId}`;
      return new Promise<RpcReply>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(`string:${id}`);
          resolve({ error: { code: -32001, message: `${method} timed out after ${timeoutMs}ms` } });
        }, timeoutMs);
        pending.set(`string:${id}`, { resolve, timer });
        transport.send(JSON.stringify({ id, method, params }));
      });
    },
    notify(method, params) {
      transport.send(JSON.stringify(params === undefined ? { method } : { method, params }));
    },
    close() {
      failAll("closed by client");
      transport.close();
    },
  };
}

/** Real transport: the installed `ws` package over ws+unix, exactly like the relay. */
export async function connectAppServer(socketPath: string, timeoutMs = 3_000): Promise<RpcConnection> {
  const WebSocket = createRequire(import.meta.url)("../node_modules/ws/index.js") as {
    new (url: string, options: Record<string, unknown>): {
      readyState: number;
      on(event: string, listener: (...args: unknown[]) => void): void;
      once(event: string, listener: (...args: unknown[]) => void): void;
      send(text: string): void;
      close(): void;
      terminate(): void;
    };
  };
  const socket = new WebSocket(`ws+unix://${socketPath}:/`, { perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error(`connect timed out after ${timeoutMs}ms`)); }, timeoutMs);
    socket.once("open", () => { clearTimeout(timer); resolve(); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); });
  });
  return jsonRpcConnection({
    send: (text) => socket.send(text),
    onMessage: (listener) => socket.on("message", (data, binary) => {
      if (binary === true) return;
      listener(String(data));
    }),
    onClose: (listener) => socket.on("close", (code) => listener(`code ${String(code)}`)),
    close: () => socket.close(),
  });
}

// --- stop sequence ----------------------------------------------------------

export interface ServerStopResult {
  outcome: "stopped" | "gone" | "failed" | "dry-run";
  messages: string[];
  interrupted: string[];
  gateError?: string;
}

function errorText(reply: RpcReply): string {
  return reply.error?.message ?? JSON.stringify(reply.error);
}

async function loadedThreadIds(rpc: RpcConnection): Promise<Set<string> | null> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const reply = await rpc.request("thread/loaded/list", cursor ? { cursor } : {});
    if (reply.error) return null;
    const result = reply.result as { data?: unknown; nextCursor?: unknown };
    for (const id of Array.isArray(result?.data) ? result.data : []) if (typeof id === "string") ids.add(id.toLowerCase());
    cursor = typeof result?.nextCursor === "string" ? result.nextCursor : null;
    if (!cursor) return ids;
  }
  return null;
}

// Client-side transport failures (timeout, closed socket) are not the server
// saying it does not know a thread, so they must never read as "already gone".
const TRANSPORT_ERROR_CODES = new Set([-32000, -32001]);

async function threadStatus(rpc: RpcConnection, threadId: string): Promise<{ known: false; error: string; transport: boolean } | { known: true; status: string }> {
  const reply = await rpc.request("thread/read", { threadId, includeTurns: false });
  if (reply.error) return { known: false, error: errorText(reply), transport: TRANSPORT_ERROR_CODES.has(reply.error.code ?? 0) };
  const status = (reply.result as { thread?: { status?: { type?: unknown } } })?.thread?.status?.type;
  return { known: true, status: typeof status === "string" ? status : "unknown" };
}

async function inProgressTurnIds(rpc: RpcConnection, threadId: string): Promise<{ ids: string[]; error?: string }> {
  const reply = await rpc.request("thread/turns/list", { threadId, limit: 10, sortDirection: "desc" });
  if (reply.error) return { ids: [], error: errorText(reply) };
  const data = (reply.result as { data?: Array<{ id?: unknown; status?: unknown }> })?.data ?? [];
  return { ids: data.filter((turn) => turn.status === "inProgress" && typeof turn.id === "string").map((turn) => turn.id as string) };
}

export async function stopThreadOnServer(rpc: RpcConnection, threadId: string, options: {
  dryRun: boolean;
  gate: () => Promise<string>;
  settleMs?: number;
  pollMs?: number;
}): Promise<ServerStopResult> {
  const messages: string[] = [];
  const interrupted: string[] = [];
  const init = await rpc.request("initialize", {
    clientInfo: { name: "claude-peers-codex-thread-stop", title: null, version: "1" },
    capabilities: { experimentalApi: false, requestAttestation: false },
  });
  if (init.error) return { outcome: "failed", messages: [`initialize failed: ${errorText(init)}`], interrupted };
  rpc.notify("initialized");

  let gateError: string | undefined;
  const applyGate = async () => {
    try { messages.push(await options.gate()); }
    catch (error) { gateError = error instanceof Error ? error.message : String(error); messages.push(`mail gate FAILED: ${gateError}`); }
  };

  const before = await threadStatus(rpc, threadId);
  if (!before.known && before.transport) return { outcome: "failed", messages: [`thread/read failed: ${before.error}`], interrupted };
  const loadedBefore = await loadedThreadIds(rpc);
  if (loadedBefore === null) return { outcome: "failed", messages: ["thread/loaded/list failed; cannot prove what is running"], interrupted };
  const isLoaded = loadedBefore.has(threadId);

  if (!before.known && !isLoaded) {
    if (options.dryRun) return { outcome: "dry-run", messages: [`would gate mail; server does not know thread ${threadId} (${before.error})`], interrupted };
    await applyGate();
    messages.push(`already gone: server does not know thread ${threadId} (${before.error})`);
    return { outcome: gateError ? "failed" : "gone", messages, interrupted, gateError };
  }
  if (!isLoaded && before.known && before.status === "notLoaded") {
    if (options.dryRun) return { outcome: "dry-run", messages: [`would gate mail and archive; thread ${threadId} is not loaded (no turn can run)`], interrupted };
    await applyGate();
    const archive = await rpc.request("thread/archive", { threadId });
    messages.push(archive.error ? `archive skipped: ${errorText(archive)}` : "archived (was not loaded)");
    messages.push(`already gone: thread ${threadId} is not loaded on this app-server; no turn can run`);
    return { outcome: gateError ? "failed" : "gone", messages, interrupted, gateError };
  }

  const status = before.known ? before.status : "unknown";
  const turns = status === "active" ? await inProgressTurnIds(rpc, threadId) : { ids: [] as string[] };
  if (options.dryRun) {
    return {
      outcome: "dry-run",
      messages: [
        `thread ${threadId} is loaded (status ${status})`,
        "would gate peer mail in the broker",
        turns.ids.length > 0 ? `would turn/interrupt ${turns.ids.join(", ")}` : "no in-progress turn to interrupt",
        "would thread/archive and verify it unloads",
      ],
      interrupted,
    };
  }

  await applyGate();
  if (status === "active" && turns.ids.length === 0) {
    messages.push(`thread is active but no in-progress turn was listed${turns.error ? ` (${turns.error})` : ""}; archive will shut it down`);
  }
  for (const turnId of turns.ids) {
    const reply = await rpc.request("turn/interrupt", { threadId, turnId });
    if (reply.error && !/no active turn/i.test(errorText(reply))) {
      messages.push(`turn/interrupt ${turnId} failed: ${errorText(reply)}`);
    } else {
      interrupted.push(turnId);
      messages.push(`interrupted turn ${turnId}`);
    }
  }
  if (status === "active") {
    const deadline = Date.now() + (options.settleMs ?? 10_000);
    for (;;) {
      const now = await threadStatus(rpc, threadId);
      if (!now.known || now.status !== "active" || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 250));
    }
  }

  const archive = await rpc.request("thread/archive", { threadId });
  if (archive.error) {
    messages.push(`thread/archive failed: ${errorText(archive)}`);
    return { outcome: "failed", messages, interrupted, gateError };
  }
  messages.push("archived");

  const after = await threadStatus(rpc, threadId);
  const loadedAfter = await loadedThreadIds(rpc);
  if (loadedAfter === null || loadedAfter.has(threadId) || (after.known && after.status !== "notLoaded")) {
    messages.push(`verification FAILED: thread still ${loadedAfter?.has(threadId) ? "loaded" : after.known ? after.status : "unverifiable"} after archive`);
    return { outcome: "failed", messages, interrupted, gateError };
  }
  messages.push(`verified: thread ${threadId} is ${after.known ? after.status : "unknown to the server"} and not loaded`);
  return { outcome: gateError ? "failed" : "stopped", messages, interrupted, gateError };
}

export async function runCodexThreadStop(options: StopOptions, deps: {
  broker: BrokerApi;
  connect: (socketPath: string) => Promise<RpcConnection>;
  out?: (line: string) => void;
  err?: (line: string) => void;
  settleMs?: number;
  pollMs?: number;
}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  let lookup: BindingLookup;
  try {
    lookup = await deps.broker.lookup(options.threadId && !options.paneId
      ? { thread_id: options.threadId }
      : { tmux_pane_id: options.paneId! });
    if (options.paneId && options.threadId) {
      const byThread = await deps.broker.lookup({ thread_id: options.threadId });
      lookup = { controls: [...lookup.controls, ...byThread.controls], peers: [...lookup.peers, ...byThread.peers] };
    }
  } catch (error) {
    err(`codex-thread-stop: refused: binding lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.refused;
  }
  const target = selectStopTarget(lookup, options);
  if (target.kind === "refuse") { err(`codex-thread-stop: refused: ${target.message}`); return EXIT.refused; }
  if (target.kind === "gone") { out(`codex-thread-stop: ${target.message}`); return EXIT.gone; }

  out(`codex-thread-stop: thread ${target.threadId} pane ${target.paneId ?? "-"} app-server ${target.socket}${options.dryRun ? " (dry run)" : ""}`);
  let rpc: RpcConnection;
  try {
    rpc = await deps.connect(target.socket);
  } catch (error) {
    err(`codex-thread-stop: refused: app-server not reachable at ${target.socket}: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.refused;
  }
  try {
    const result = await stopThreadOnServer(rpc, target.threadId, {
      dryRun: options.dryRun,
      settleMs: deps.settleMs,
      pollMs: deps.pollMs,
      gate: async () => {
        const gated = await deps.broker.gate(target.threadId, target.paneId);
        return `peer mail gated (${gated.gated_peer_ids.length} seat(s), ${gated.queued} queued message(s) stay queued)`;
      },
    });
    for (const line of result.messages) out(`  ${line}`);
    switch (result.outcome) {
      case "stopped": out("codex-thread-stop: stopped"); return EXIT.stopped;
      case "dry-run": out("codex-thread-stop: dry run: read-only status calls only; no gate, interrupt, or archive sent"); return EXIT.stopped;
      case "gone": out("codex-thread-stop: already gone"); return EXIT.gone;
      default: err("codex-thread-stop: FAILED (see above)"); return EXIT.failed;
    }
  } finally {
    rpc.close();
  }
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  const parsed = parseStopArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(EXIT.usage);
  }
  const code = await runCodexThreadStop(parsed.options, {
    broker: httpBrokerApi(parsed.options.brokerPort),
    connect: (socket) => connectAppServer(socket),
  });
  process.exit(code);
}
