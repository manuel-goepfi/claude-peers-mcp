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
 *   2. connect to that app-server socket (refuse if unreachable or not a Codex
 *      app-server) and read the thread's own status (thread/read,
 *      thread/loaded/list), checking the server answers for the SAME thread id;
 *   3. gate peer mail in the broker with the intermediate `stopping` gate
 *      BEFORE touching the turn, so an interrupt-triggered Stop hook cannot
 *      claim mail;
 *   4. turn/interrupt every in-progress turn (ids from thread/turns/list);
 *   5. thread/archive its loaded subagents (threads whose parentThreadId
 *      chain leads to it, found by thread/read of every loaded thread),
 *      deepest first, then the thread itself (the server unloads it);
 *   6. verify with the server's own status that neither the thread nor any
 *      of its subagents is still loaded, and only then raise the gate to the
 *      permanent `stopped`.
 *
 * If any step after 3 fails, the gate stays `stopping`: mail stays gated, the
 * thread is NOT labelled stopped, and the operator either reruns the stop
 * (retry) or runs `--unstop` (recovery). A thread that the server does not
 * have loaded is labelled `stopped` only when it is proven absent from
 * thread/loaded/list on EVERY known app-server socket; one unreachable server,
 * or a --socket that is not a known app-server socket, refuses.
 *
 * `--unstop --thread UUID` lifts a `stopping` or `stopped` gate (audited in
 * the broker) only when the thread is loaded again on its app-server, or with
 * the explicit `--operator-override` flag.
 *
 * App-server method names are the v2 protocol of the installed Codex CLI
 * (0.160.1): `codex app-server generate-ts` emits ClientRequest.ts with
 * "initialize", "thread/read", "thread/loaded/list", "thread/turns/list",
 * "turn/interrupt" and "thread/archive" (the legacy
 * interruptConversation/archiveConversation methods are not in that
 * protocol). The relay already speaks this protocol over the same ws+unix
 * transport ("thread/start", "thread/resume", "thread/name/set").
 *
 * Exit codes: 0 stopped / unstopped / dry run, 3 already gone (or nothing to
 * unstop), 2 refused (nothing changed), 1 failed after acting (gate left at
 * `stopping`), 64 usage.
 */
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const EXIT = { stopped: 0, failed: 1, refused: 2, gone: 3, usage: 64 } as const;

export interface StopOptions {
  paneId?: string;
  threadId?: string;
  socket?: string;
  dryRun: boolean;
  brokerPort: number;
  unstop?: boolean;
  operatorOverride?: boolean;
}

const THREAD_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = [
  "usage: codex-thread-stop (--pane %N | --thread UUID) [--socket PATH] [--dry-run]",
  "       codex-thread-stop --unstop --thread UUID [--socket PATH] [--operator-override] [--dry-run]",
].join("\n");

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
      else if (arg === "--unstop") options.unstop = true;
      else if (arg === "--operator-override") options.operatorOverride = true;
      else if (arg === "--pane") options.paneId = value();
      else if (arg === "--thread") options.threadId = value().toLowerCase();
      else if (arg === "--socket") options.socket = value();
      else if (arg === "-h" || arg === "--help") return { ok: false, error: USAGE };
      else return { ok: false, error: `unknown argument: ${arg}\n${USAGE}` };
    } catch (error) {
      return { ok: false, error: `${(error as Error).message}\n${USAGE}` };
    }
  }
  if (options.unstop && (!options.threadId || options.paneId)) return { ok: false, error: `--unstop takes --thread UUID (not --pane)\n${USAGE}` };
  if (options.operatorOverride && !options.unstop) return { ok: false, error: `--operator-override is only valid with --unstop\n${USAGE}` };
  if (!options.paneId && !options.threadId) return { ok: false, error: USAGE };
  if (options.paneId && !/^%\d+$/.test(options.paneId)) return { ok: false, error: "invalid --pane (expected %N)" };
  if (options.threadId && !THREAD_RE.test(options.threadId)) return { ok: false, error: "invalid --thread (expected a thread UUID)" };
  if (options.socket && !options.socket.startsWith("/")) return { ok: false, error: "--socket must be an absolute path" };
  if (!Number.isInteger(options.brokerPort) || options.brokerPort < 1 || options.brokerPort > 65535) {
    return { ok: false, error: "invalid CLAUDE_PEERS_PORT" };
  }
  return { ok: true, options };
}

// --- sockets ----------------------------------------------------------------

/** Relays record the account's `app-server-control.sock` symlink; compare resolved targets. */
export function canonicalSocket(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

const ACCOUNT_HOMES = [".codex", ".codex-b", ".codex-b-remote", ".codex-c", ".codex-c-remote"];

/**
 * App-server sockets this host knows about, for the absence proof:
 * CLAUDE_PEERS_CODEX_APP_SERVER_SOCKETS (colon-separated) when set, else the
 * standard account homes' control sockets that exist. The broker adds every
 * socket a relay has recorded.
 */
export function defaultKnownSockets(env: Record<string, string | undefined> = process.env, home = homedir()): string[] {
  const configured = env.CLAUDE_PEERS_CODEX_APP_SERVER_SOCKETS;
  if (configured !== undefined) return configured.split(":").filter((path) => path.startsWith("/"));
  return ACCOUNT_HOMES.map((dir) => join(home, dir, "app-server-control", "app-server-control.sock")).filter((path) => {
    try { lstatSync(path); return true; } catch { return false; }
  });
}

// --- broker binding -------------------------------------------------------

export type GateName = "pane-closed" | "stopping" | "stopped";

export interface ControlRow {
  thread_id: string;
  tmux_pane_id: string | null;
  app_server_socket: string | null;
  bound_at: string | null;
  superseded_at: string | null;
  gate: GateName | null;
}

export interface BindingLookup {
  controls: ControlRow[];
  peers: Array<{ id: string; pid: number; tmux_pane_id: string | null; thread_id: string; non_targetable: number; alive?: boolean }>;
  known_sockets?: string[];
}

export type StopTarget =
  | { kind: "target"; threadId: string; socket: string; socketSource: "recorded" | "explicit"; paneId: string | null; priorGate: GateName | null }
  | { kind: "gone"; message: string }
  | { kind: "refuse"; message: string };

/**
 * Decide which single thread on which single app-server to stop. Anything
 * short of exactly one thread with exactly one socket is a refusal. A thread
 * left at `stopping` by a failed stop is still a target (retry).
 */
export function selectStopTarget(
  lookup: BindingLookup,
  options: Pick<StopOptions, "paneId" | "threadId" | "socket">,
  canonical: (path: string) => string = canonicalSocket,
): StopTarget {
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
  if (options.socket && recorded.length === 1 && canonical(recorded[0]!) !== canonical(options.socket)) {
    return { kind: "refuse", message: `--socket ${options.socket} contradicts the recorded app-server ${recorded[0]} for thread ${threadId}` };
  }
  const socket = recorded[0] ?? options.socket;
  if (!socket) {
    return { kind: "refuse", message: `no app-server socket recorded for thread ${threadId} (bound before the relay recorded sockets?); pass --socket PATH explicitly` };
  }
  const control = controls[0];
  return {
    kind: "target", threadId, socket, socketSource: recorded.length === 1 ? "recorded" : "explicit",
    paneId: options.paneId ?? control?.tmux_pane_id ?? null, priorGate: control?.gate ?? null,
  };
}

export type UnstopProof = "loaded-on-app-server" | "operator-override";

export interface BrokerApi {
  lookup(selector: { tmux_pane_id?: string; thread_id?: string }): Promise<BindingLookup>;
  gate(threadId: string, gate: "stopping" | "stopped", paneId: string | null, socket: string | null): Promise<{ gated_peer_ids: string[]; queued: number; gate: string }>;
  unstop(threadId: string, proof: UnstopProof): Promise<{ restored_peer_ids: string[]; queued: number; from_gate: string }>;
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
    async gate(threadId, gate, paneId, socket) {
      const value = await post("/codex-thread-gate", {
        thread_id: threadId, gate, ...(paneId ? { tmux_pane_id: paneId } : {}), ...(socket ? { app_server_socket: socket } : {}),
      });
      return { gated_peer_ids: (value.gated_peer_ids as string[]) ?? [], queued: Number(value.queued ?? 0), gate: String(value.gate) };
    },
    async unstop(threadId, proof) {
      const value = await post("/codex-thread-unstop", { thread_id: threadId, proof });
      return { restored_peer_ids: (value.restored_peer_ids as string[]) ?? [], queued: Number(value.queued ?? 0), from_gate: String(value.from_gate) };
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
  outcome: "stopped" | "gone" | "failed" | "refused" | "dry-run";
  messages: string[];
  interrupted: string[];
}

function errorText(reply: RpcReply): string {
  return reply.error?.message ?? JSON.stringify(reply.error);
}

/** Connect, then prove the endpoint is a Codex app-server (initialize handshake). */
export async function openAppServer(connect: (socket: string) => Promise<RpcConnection>, socket: string): Promise<RpcConnection> {
  const rpc = await connect(socket);
  const init = await rpc.request("initialize", {
    clientInfo: { name: "claude-peers-codex-thread-stop", title: null, version: "1" },
    capabilities: { experimentalApi: false, requestAttestation: false },
  });
  const agent = (init.result as { userAgent?: unknown } | undefined)?.userAgent;
  if (init.error || typeof agent !== "string") {
    rpc.close();
    throw new Error(init.error ? `initialize failed: ${errorText(init)}` : "endpoint did not identify as a Codex app-server");
  }
  rpc.notify("initialized");
  return rpc;
}

export async function loadedThreadIds(rpc: RpcConnection): Promise<Set<string> | null> {
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

/**
 * What the v2 Thread `source` says the thread is: a client-started top-level
 * thread ("cli", "vscode", "exec", "mcp", "appServer", or {custom}), a
 * subagent ({subAgent}), or anything else ("unknown", {internal}, missing).
 */
export type SourceKind = "top-level" | "subagent" | "unknown";

export type ThreadStatus =
  | { known: false; error: string; transport: boolean }
  | { known: true; status: string; id: string | null; parentThreadId: string | null; updatedAt: number | null; sourceKind: SourceKind };

const TOP_LEVEL_SOURCES = new Set(["cli", "vscode", "exec", "mcp", "appserver"]);

function sourceKindOf(source: unknown): SourceKind {
  if (typeof source === "string") return TOP_LEVEL_SOURCES.has(source.toLowerCase()) ? "top-level" : "unknown";
  if (source && typeof source === "object") {
    const keys = Object.keys(source).map((key) => key.toLowerCase());
    if (keys.includes("subagent")) return "subagent";
    if (keys.length === 1 && keys[0] === "custom") return "top-level";
  }
  return "unknown";
}

/**
 * A subagent names its parent in `parentThreadId` (v2 Thread); older servers
 * only carry it in source.subAgent.thread_spawn.parent_thread_id.
 */
function parentOf(thread: { parentThreadId?: unknown; source?: unknown }): string | null {
  if (typeof thread.parentThreadId === "string") return thread.parentThreadId.toLowerCase();
  const spawn = (thread.source as { subAgent?: { thread_spawn?: { parent_thread_id?: unknown } } } | undefined)?.subAgent?.thread_spawn;
  return typeof spawn?.parent_thread_id === "string" ? spawn.parent_thread_id.toLowerCase() : null;
}

/** Thread.updatedAt is Unix seconds; tolerate milliseconds. Returns epoch ms. */
function updatedAtMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value > 1e12 ? value : value * 1000;
}

export async function threadStatus(rpc: RpcConnection, threadId: string): Promise<ThreadStatus> {
  const reply = await rpc.request("thread/read", { threadId, includeTurns: false });
  if (reply.error) return { known: false, error: errorText(reply), transport: TRANSPORT_ERROR_CODES.has(reply.error.code ?? 0) };
  const thread = (reply.result as { thread?: { id?: unknown; status?: { type?: unknown }; parentThreadId?: unknown; source?: unknown; updatedAt?: unknown } })?.thread;
  const status = thread?.status?.type;
  return {
    known: true, status: typeof status === "string" ? status : "unknown", id: typeof thread?.id === "string" ? thread.id.toLowerCase() : null,
    parentThreadId: thread ? parentOf(thread) : null, updatedAt: updatedAtMs(thread?.updatedAt), sourceKind: sourceKindOf(thread?.source),
  };
}

/**
 * Loaded subagents of `threadId` (children, grandchildren, ...), deepest
 * first so none outlives its parent. `ancestors` adds ids that count as part
 * of the tree even though they are no longer loaded (a grandchild whose
 * parent was already archived). Reads every loaded thread; a transport
 * failure is an error, because an unread thread may be a descendant.
 */
export async function loadedDescendants(rpc: RpcConnection, threadId: string, loaded: Set<string>, ancestors: Iterable<string> = []):
  Promise<{ ids: string[] } | { error: string }> {
  const parents = new Map<string, string>();
  for (const id of loaded) {
    if (id === threadId) continue;
    const info = await threadStatus(rpc, id);
    if (!info.known) {
      if (info.transport) return { error: `thread/read ${id} failed: ${info.error}` };
      continue; // unloaded between list and read
    }
    if (info.parentThreadId) parents.set(id, info.parentThreadId);
  }
  const tree = new Set([threadId, ...ancestors]);
  const depth = new Map<string, number>();
  for (const id of parents.keys()) {
    let hops = 0;
    for (let cursor: string | undefined = id; cursor !== undefined && hops <= parents.size; cursor = parents.get(cursor)) {
      if (cursor !== id && tree.has(cursor)) { depth.set(id, hops); break; }
      hops++;
    }
  }
  return { ids: [...depth.keys()].sort((a, b) => depth.get(b)! - depth.get(a)!) };
}

async function inProgressTurnIds(rpc: RpcConnection, threadId: string): Promise<{ ids: string[]; error?: string }> {
  const reply = await rpc.request("thread/turns/list", { threadId, limit: 10, sortDirection: "desc" });
  if (reply.error) return { ids: [], error: errorText(reply) };
  const data = (reply.result as { data?: Array<{ id?: unknown; status?: unknown }> })?.data ?? [];
  return { ids: data.filter((turn) => turn.status === "inProgress" && typeof turn.id === "string").map((turn) => turn.id as string) };
}

/**
 * Proof that a thread the target server does not have loaded is not running
 * anywhere: the target socket must itself be a known app-server socket, and
 * every other known socket must be reachable and must not list the thread in
 * thread/loaded/list. Returns null when proven, else the refusal reason.
 */
export async function proveAbsentEverywhere(threadId: string, target: string, known: string[],
  connect: (socket: string) => Promise<RpcConnection>, canonical: (path: string) => string = canonicalSocket,
): Promise<string | null> {
  const targetKey = canonical(target);
  const others = new Map<string, string>();
  for (const socket of known) if (canonical(socket) !== targetKey) others.set(canonical(socket), socket);
  if (!known.some((socket) => canonical(socket) === targetKey)) {
    return `${target} is not a known app-server socket (none recorded by a relay or found in the account homes); cannot prove the thread is not running elsewhere`;
  }
  for (const socket of others.values()) {
    let rpc: RpcConnection;
    try {
      rpc = await openAppServer(connect, socket);
    } catch (error) {
      return `app-server ${socket} is unreachable (${error instanceof Error ? error.message : String(error)}); cannot prove the thread is not running there`;
    }
    try {
      const loaded = await loadedThreadIds(rpc);
      if (loaded === null) return `thread/loaded/list failed on ${socket}; cannot prove absence`;
      if (loaded.has(threadId)) return `thread ${threadId} is loaded on ${socket}, not on ${target}; rerun with --socket ${socket}`;
    } finally {
      rpc.close();
    }
  }
  return null;
}

/**
 * Archive the given subagents of `threadId`, then re-list. Returns null when
 * none of its subagents is loaded any more, else the ids still loaded ("" when
 * that cannot be verified).
 */
async function archiveSubagents(rpc: RpcConnection, threadId: string, ids: string[], messages: string[]): Promise<string | null> {
  for (const id of ids) {
    const reply = await rpc.request("thread/archive", { threadId: id });
    messages.push(reply.error ? `subagent ${id}: thread/archive failed: ${errorText(reply)}` : `archived subagent ${id}`);
  }
  const loaded = await loadedThreadIds(rpc);
  if (loaded === null) return "";
  const left = await loadedDescendants(rpc, threadId, loaded, ids);
  if ("error" in left) return "";
  return left.ids.length > 0 ? left.ids.join(", ") : null;
}

const RECOVERY = (threadId: string) =>
  `mail stays gated as 'stopping' and the thread is NOT marked stopped; rerun codex-thread-stop to retry, or codex-thread-stop --unstop --thread ${threadId} to restore delivery`;

export async function stopThreadOnServer(rpc: RpcConnection, threadId: string, options: {
  dryRun: boolean;
  /** Raise the broker gate; returns a human summary. Throws on failure. */
  gate: (gate: "stopping" | "stopped", confirmedSocket: boolean) => Promise<string>;
  /** Absence proof for a thread this server does not have loaded (null = proven). */
  proveAbsent: () => Promise<string | null>;
  settleMs?: number;
  pollMs?: number;
}): Promise<ServerStopResult> {
  const messages: string[] = [];
  const interrupted: string[] = [];
  const result = (outcome: ServerStopResult["outcome"]) => ({ outcome, messages, interrupted });

  const before = await threadStatus(rpc, threadId);
  if (!before.known && before.transport) { messages.push(`thread/read failed: ${before.error}`); return result("refused"); }
  if (before.known && before.id !== null && before.id !== threadId) {
    messages.push(`server answered for thread ${before.id}, not ${threadId}; refusing a foreign thread`);
    return result("refused");
  }
  const loadedBefore = await loadedThreadIds(rpc);
  if (loadedBefore === null) { messages.push("thread/loaded/list failed; cannot prove what is running"); return result("refused"); }
  const isLoaded = loadedBefore.has(threadId);
  // Subagents the thread spawned stay loaded after it finishes (each holds
  // proxy listeners and session fds), so a stop ends the whole tree. Read
  // only once this server is proven to be the thread's own.
  let descendants: string[] = [];
  let subagentPlan = "";
  const findSubagents = async (): Promise<string | null> => {
    const tree = await loadedDescendants(rpc, threadId, loadedBefore);
    if ("error" in tree) return `cannot list the thread's subagents (${tree.error})`;
    descendants = tree.ids;
    subagentPlan = descendants.length > 0
      ? `would thread/archive ${descendants.length} loaded subagent(s) first: ${descendants.join(", ")}`
      : "no loaded subagents";
    return null;
  };

  if (!isLoaded && (!before.known || before.status === "notLoaded")) {
    // Not loaded HERE is not proof of death: the thread may live on another
    // app-server (a wrong --socket, or a binding with no recorded socket).
    const refusal = await options.proveAbsent() ?? await findSubagents();
    if (refusal) { messages.push(`refused: ${refusal}; no gate applied`); return result("refused"); }
    const where = before.known ? "is not loaded" : `is unknown (${before.error})`;
    if (options.dryRun) { messages.push(`would mark stopped: thread ${where} here and absent from every known app-server`, subagentPlan); return result("dry-run"); }
    if (descendants.length > 0) {
      const remaining = await archiveSubagents(rpc, threadId, descendants, messages);
      if (remaining !== null) {
        messages.push(`verification FAILED: subagent(s) still loaded: ${remaining || "unverifiable"}; no gate applied`);
        return result("failed");
      }
    }
    try { messages.push(await options.gate("stopped", before.known)); }
    catch (error) { messages.push(`mail gate FAILED: ${error instanceof Error ? error.message : String(error)}`); return result("failed"); }
    if (before.known) {
      const archive = await rpc.request("thread/archive", { threadId });
      messages.push(archive.error ? `archive skipped: ${errorText(archive)}` : "archived (was not loaded)");
    }
    messages.push(`already gone: thread ${threadId} ${where} on this app-server and is absent from every known app-server`);
    return result("gone");
  }

  const subagentError = await findSubagents();
  if (subagentError) { messages.push(`refused: ${subagentError}; no gate applied`); return result("refused"); }
  const status = before.known ? before.status : "unknown";
  const turns = status === "active" ? await inProgressTurnIds(rpc, threadId) : { ids: [] as string[] };
  if (options.dryRun) {
    messages.push(
      `thread ${threadId} is loaded (status ${status})`,
      "would gate peer mail in the broker (stopping)",
      turns.ids.length > 0 ? `would turn/interrupt ${turns.ids.join(", ")}` : "no in-progress turn to interrupt",
      subagentPlan,
      "would thread/archive, verify it and its subagents unload, then mark it stopped",
    );
    return result("dry-run");
  }

  try { messages.push(await options.gate("stopping", true)); }
  catch (error) {
    messages.push(`mail gate FAILED (${error instanceof Error ? error.message : String(error)}); nothing was interrupted or archived`);
    return result("failed");
  }
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

  // Deepest first; a failure here shows up in the verification below.
  for (const id of descendants) {
    const reply = await rpc.request("thread/archive", { threadId: id });
    messages.push(reply.error ? `subagent ${id}: thread/archive failed: ${errorText(reply)}` : `archived subagent ${id}`);
  }
  const archive = await rpc.request("thread/archive", { threadId });
  if (archive.error) {
    messages.push(`thread/archive failed: ${errorText(archive)}`, RECOVERY(threadId));
    return result("failed");
  }
  messages.push("archived");

  const after = await threadStatus(rpc, threadId);
  const loadedAfter = await loadedThreadIds(rpc);
  if (loadedAfter === null || loadedAfter.has(threadId) || (after.known && after.status !== "notLoaded") || (!after.known && after.transport)) {
    const state = loadedAfter === null ? "unverifiable" : loadedAfter.has(threadId) ? "loaded" : after.known ? after.status : "unverifiable";
    messages.push(`verification FAILED: thread still ${state} after archive`, RECOVERY(threadId));
    return result("failed");
  }
  // Includes subagents spawned after the first listing, and grandchildren of
  // subagents archived above.
  const left = await loadedDescendants(rpc, threadId, loadedAfter, descendants);
  if ("error" in left || left.ids.length > 0) {
    messages.push(`verification FAILED: subagent(s) still loaded: ${"error" in left ? `unverifiable (${left.error})` : left.ids.join(", ")}`, RECOVERY(threadId));
    return result("failed");
  }
  messages.push(`verified: thread ${threadId} is ${after.known ? after.status : "unknown to the server"} and not loaded${descendants.length > 0 ? `, nor are its ${descendants.length} subagent(s)` : ""}`);
  try { messages.push(await options.gate("stopped", true)); }
  catch (error) {
    messages.push(`server confirmed the stop but the broker could not record it (${error instanceof Error ? error.message : String(error)}); mail stays gated as 'stopping'; rerun to finalize`);
    return result("failed");
  }
  return result("stopped");
}

export interface RunDeps {
  broker: BrokerApi;
  connect: (socketPath: string) => Promise<RpcConnection>;
  /** Sockets of every app-server on this host (absence proof). */
  knownSockets: () => string[];
  canonical?: (path: string) => string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  settleMs?: number;
  pollMs?: number;
}

export async function runCodexThreadStop(options: StopOptions, deps: RunDeps): Promise<number> {
  if (options.unstop) return runCodexThreadUnstop(options, deps);
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const canonical = deps.canonical ?? canonicalSocket;
  let lookup: BindingLookup;
  try {
    lookup = await deps.broker.lookup(options.threadId && !options.paneId
      ? { thread_id: options.threadId }
      : { tmux_pane_id: options.paneId! });
    if (options.paneId && options.threadId) {
      const byThread = await deps.broker.lookup({ thread_id: options.threadId });
      lookup = { controls: [...lookup.controls, ...byThread.controls], peers: [...lookup.peers, ...byThread.peers], known_sockets: lookup.known_sockets };
    }
  } catch (error) {
    err(`codex-thread-stop: refused: binding lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.refused;
  }
  const target = selectStopTarget(lookup, options, canonical);
  if (target.kind === "refuse") { err(`codex-thread-stop: refused: ${target.message}`); return EXIT.refused; }
  if (target.kind === "gone") { out(`codex-thread-stop: ${target.message}`); return EXIT.gone; }

  out(`codex-thread-stop: thread ${target.threadId} pane ${target.paneId ?? "-"} app-server ${target.socket} (${target.socketSource})${target.priorGate ? ` gate ${target.priorGate}` : ""}${options.dryRun ? " (dry run)" : ""}`);
  let rpc: RpcConnection;
  try {
    rpc = await openAppServer(deps.connect, target.socket);
  } catch (error) {
    err(`codex-thread-stop: refused: app-server not usable at ${target.socket}: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.refused;
  }
  try {
    const known = [...deps.knownSockets(), ...(lookup.known_sockets ?? [])];
    const result = await stopThreadOnServer(rpc, target.threadId, {
      dryRun: options.dryRun,
      settleMs: deps.settleMs,
      pollMs: deps.pollMs,
      proveAbsent: () => proveAbsentEverywhere(target.threadId, target.socket, known, deps.connect, canonical),
      gate: async (gate, confirmedSocket) => {
        const gated = await deps.broker.gate(target.threadId, gate, target.paneId, confirmedSocket ? target.socket : null);
        return `peer mail gated '${gated.gate}' (${gated.gated_peer_ids.length} seat(s), ${gated.queued} queued message(s) stay queued)`;
      },
    });
    for (const line of result.messages) out(`  ${line}`);
    switch (result.outcome) {
      case "stopped": out("codex-thread-stop: stopped"); return EXIT.stopped;
      case "dry-run": out("codex-thread-stop: dry run: read-only status calls only; no gate, interrupt, or archive sent"); return EXIT.stopped;
      case "gone": out("codex-thread-stop: already gone"); return EXIT.gone;
      case "refused": err("codex-thread-stop: refused (nothing changed)"); return EXIT.refused;
      default: err("codex-thread-stop: FAILED (see above)"); return EXIT.failed;
    }
  } finally {
    rpc.close();
  }
}

/**
 * Recovery from a mistaken or failed stop. Lifts a `stopping` or `stopped`
 * gate only when the thread is loaded again on its app-server (same thread id
 * answered), or with the explicit --operator-override flag. The broker writes
 * an audit row with the proof and the restored peer ids.
 */
export async function runCodexThreadUnstop(options: StopOptions, deps: RunDeps): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const canonical = deps.canonical ?? canonicalSocket;
  const threadId = options.threadId!;
  let lookup: BindingLookup;
  try { lookup = await deps.broker.lookup({ thread_id: threadId }); }
  catch (error) {
    err(`codex-thread-stop --unstop: refused: binding lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.refused;
  }
  const control = lookup.controls.find((row) => row.thread_id === threadId);
  if (control?.gate !== "stopped" && control?.gate !== "stopping") {
    out(`codex-thread-stop --unstop: thread ${threadId} is not stopped (gate ${control?.gate ?? "none"}); nothing to undo`);
    return EXIT.gone;
  }
  let proof: UnstopProof;
  if (options.operatorOverride) {
    proof = "operator-override";
  } else {
    const recorded = control.app_server_socket;
    if (options.socket && recorded && canonical(options.socket) !== canonical(recorded)) {
      err(`codex-thread-stop --unstop: refused: --socket ${options.socket} contradicts the recorded app-server ${recorded}`);
      return EXIT.refused;
    }
    const socket = recorded ?? options.socket;
    if (!socket) {
      err("codex-thread-stop --unstop: refused: no app-server socket recorded; pass --socket PATH (thread must be loaded there) or --operator-override");
      return EXIT.refused;
    }
    let rpc: RpcConnection;
    try { rpc = await openAppServer(deps.connect, socket); }
    catch (error) {
      err(`codex-thread-stop --unstop: refused: app-server not usable at ${socket}: ${error instanceof Error ? error.message : String(error)}`);
      return EXIT.refused;
    }
    try {
      const status = await threadStatus(rpc, threadId);
      const loaded = await loadedThreadIds(rpc);
      const sameThread = status.known && (status.id === null || status.id === threadId);
      if (!loaded?.has(threadId) || !sameThread) {
        err(`codex-thread-stop --unstop: refused: thread ${threadId} is not loaded on ${socket}; resume it there first, or pass --operator-override to lift the gate anyway`);
        return EXIT.refused;
      }
    } finally {
      rpc.close();
    }
    proof = "loaded-on-app-server";
  }
  if (options.dryRun) {
    out(`codex-thread-stop --unstop: dry run: would lift '${control.gate}' for thread ${threadId} (proof ${proof})`);
    return EXIT.stopped;
  }
  try {
    const lifted = await deps.broker.unstop(threadId, proof);
    out(`codex-thread-stop --unstop: lifted '${lifted.from_gate}' for thread ${threadId} (proof ${proof}); ${lifted.restored_peer_ids.length} seat(s) targetable again, ${lifted.queued} queued message(s) deliverable; audit row written`);
    return EXIT.stopped;
  } catch (error) {
    err(`codex-thread-stop --unstop: FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.failed;
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
    knownSockets: () => defaultKnownSockets(),
  });
  process.exit(code);
}
