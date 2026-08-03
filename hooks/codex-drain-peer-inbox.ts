#!/usr/bin/env bun
import { readFileSync, readlinkSync } from "node:fs";
import { isClientProcess as sharedIsClientProcess, isCodexAppServerProcess as sharedIsCodexAppServerProcess, type ProcessInfo } from "../shared/client.ts";
import { renderInboundLine } from "../shared/render.ts";
import type { ClientType, Message, ReceiverMode } from "../shared/types.ts";
import { findSingleVisibleCodexProcess } from "../shared/visible-codex.ts";

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const MAX_MESSAGES = 25;
const MAX_BYTES = 64 * 1024;
const CLIENT_TYPE: Extract<ClientType, "codex" | "gemini"> =
  process.env.CLAUDE_PEERS_CLIENT_TYPE === "gemini" ? "gemini" : "codex";
const RECEIVER_MODE: Extract<ReceiverMode, "codex-hook" | "gemini-hook"> =
  CLIENT_TYPE === "gemini" ? "gemini-hook" : "codex-hook";
const HOOK_EVENT_NAME = process.env.CLAUDE_PEERS_HOOK_EVENT_NAME ??
  (CLIENT_TYPE === "gemini" ? "BeforeAgent" : "UserPromptSubmit");

/**
 * Codex thread identity — the exact join, and the fix for "no codex ancestor found".
 *
 * Codex hands every hook the SAME ThreadId it stamps into `_meta.threadId` on
 * external MCP tool calls: SessionStart, UserPromptSubmit and StopCommandInput
 * all carry `session_id` (codex-rs/hooks/src/schema.rs). The registration hook
 * persists it on the peer row as `thread_id`, so when we have it we can address
 * our own row exactly — no process table, no ancestry, no correlation.
 *
 * That matters because ancestry does not work under a long-lived
 * `codex app-server`: the app-server owns the MCP guard/server children rather
 * than the pane TUI, so walking up from this hook finds no codex parent at all.
 * Measured 2026-08-03 in ~/.codex/logs/drain-peer-inbox.log: 553 `drain-failed
 * rc=1` entries, 541 of them immediately preceded by "no codex ancestor found".
 *
 * Kept as module state rather than threaded through every call site so the
 * claim/ack/heartbeat trio can pick their route family in one place. Null means
 * "no thread identity available" (Gemini, legacy Codex, unreadable payload) and
 * the pre-existing PID path is used unchanged.
 */
let activeThreadId: string | null = null;

/** Read Codex's `session_id` out of the hook payload. Non-empty strings only. */
export function readThreadId(hookInput: Record<string, unknown> | null): string | null {
  const raw = hookInput?.session_id;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}
const REGISTER_SCRIPT = new URL("./register-peer-session.ts", import.meta.url).pathname;
const REGISTER_TIMEOUT_MS = 2_000;

type ProcRow = ProcessInfo;

interface AckByPidResponse {
  ok: boolean;
  peer_id?: string;
  acked?: number;
  error?: string;
}

type ClaimResponse = { peer_id?: string; drain_id?: string; messages?: Message[] };
type ClaimFn = (pid: number, drainId: string) => Promise<ClaimResponse>;
interface RegistrationProcess {
  exited: Promise<number>;
  kill(signal?: string | number): void;
  stderr?: ReadableStream<Uint8Array> | number | null;
}

export class BrokerHttpError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number,
    public readonly brokerError: string,
  ) {
    super(`${path} ${status}: ${brokerError}`);
  }
}

function log(msg: string): void {
  console.error(`[claude-peers ${CLIENT_TYPE}-hook] ${msg}`);
}

function processTable(): Map<number, ProcRow> {
  const table = new Map<number, ProcRow>();
  const proc = Bun.spawnSync(["ps", "-ewwo", "pid=,ppid=,comm=,args="]);
  if (proc.exitCode !== 0) return table;
  const text = new TextDecoder().decode(proc.stdout);
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    table.set(Number(m[1]), {
      pid: Number(m[1]),
      ppid: Number(m[2]),
      comm: m[3] ?? "",
      args: m[4] ?? "",
    });
  }
  return table;
}

function isClientProcess(row: ProcRow, clientType = CLIENT_TYPE): boolean {
  return sharedIsClientProcess(row, clientType);
}

function isCodexAppServerProcess(row: ProcRow): boolean {
  return sharedIsCodexAppServerProcess(row);
}

function isPeersServer(row: ProcRow): boolean {
  return /claude-peers-mcp\/server\.ts/.test(row.args) || (/\/server\.ts/.test(row.args) && /claude-peers/.test(row.args));
}

// A stdio-guard wrapper and the `bun` server it spawns BOTH satisfy isPeersServer:
// the wrapper's argv contains the server path too. The broker registers the RUNTIME
// process, so an ambiguous match must resolve to the deepest one. Previously this
// only worked by accident -- a narrow pane (COLUMNS < ~145) truncated the wrapper's
// argv so it failed isPeersServer; at full width both matched, `selected.length === 1`
// failed, and the hook silently drained nothing.
function preferLeafCandidates(rows: ProcRow[], table: Map<number, ProcRow>): ProcRow[] {
  if (rows.length <= 1) return rows;
  const isAncestorOfAnother = (row: ProcRow): boolean => {
    for (const other of rows) {
      if (other.pid === row.pid) continue;
      let cur: ProcRow | undefined = table.get(other.pid);
      for (let guard = 0; cur && guard < 20; guard++) {
        if (cur.ppid === row.pid) return true;
        cur = table.get(cur.ppid);
      }
    }
    return false;
  };
  const leaves = rows.filter((r) => !isAncestorOfAnother(r));
  return leaves.length > 0 ? leaves : rows;
}

function descendants(rootPid: number, table: Map<number, ProcRow>): ProcRow[] {
  const children = new Map<number, ProcRow[]>();
  for (const row of table.values()) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const out: ProcRow[] = [];
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    out.push(next);
    stack.push(...(children.get(next.pid) ?? []));
  }
  return out;
}

function cwdOf(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function getTty(pid: number): string | null {
  try {
    const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(pid)]);
    const tty = new TextDecoder().decode(proc.stdout).trim();
    return tty && tty !== "?" && tty !== "??" ? tty : null;
  } catch {
    return null;
  }
}

function hasPeerIdentityEnv(pid: number): boolean {
  try {
    const text = readFileSync(`/proc/${pid}/environ`, "utf8");
    return text.includes("CLAUDE_PEER_NAME=") || text.includes("TMUX_PANE=");
  } catch {
    return false;
  }
}

function findClientAncestor(table: Map<number, ProcRow>, startPid = process.ppid, clientType = CLIENT_TYPE): number | null {
  let current = startPid;
  for (let i = 0; i < 30; i++) {
    const row = table.get(current);
    if (!row) return null;
    if (isClientProcess(row, clientType)) {
      if (clientType === "codex" && isCodexAppServerProcess(row)) return null;
      return row.pid;
    }
    if (row.ppid <= 1 || row.ppid === row.pid) return null;
    current = row.ppid;
  }
  return null;
}

/**
 * True when this hook is running under a codex app-server host and has no seat
 * of its own — no controlling tty anywhere up the chain to the app-server.
 *
 * Distinguishes "seatless by construction" (expected, silent) from "should have
 * had a seat and lost it" (a real fault worth logging).
 */
export function isHostedWithoutSeat(
  table: Map<number, ProcRow>,
  startPid = process.ppid,
  ttyReader: (pid: number) => string | null = getTty,
): boolean {
  const appServer = findCodexAppServerAncestor(table, startPid);
  if (!appServer) return false;
  let current: number | undefined = startPid;
  for (let i = 0; i < 30 && current !== undefined; i++) {
    if (ttyReader(current)) return false; // a tty means a real seat exists
    if (current === appServer.pid) break;
    current = table.get(current)?.ppid;
    if (current !== undefined && current <= 1) break;
  }
  return true;
}

function findCodexAppServerAncestor(table: Map<number, ProcRow>, startPid = process.ppid): ProcRow | null {
  let current = startPid;
  for (let i = 0; i < 30; i++) {
    const row = table.get(current);
    if (!row) return null;
    if (isCodexAppServerProcess(row)) return row;
    if (row.ppid <= 1 || row.ppid === row.pid) return null;
    current = row.ppid;
  }
  return null;
}

export function findMcpPidFromTable(
  table: Map<number, ProcRow>,
  startPid: number,
  hookCwd: string,
  cwdResolver: (pid: number) => string | null = cwdOf,
  clientType = CLIENT_TYPE,
): number | null {
  const clientPid = findClientAncestor(table, startPid, clientType);
  if (!clientPid) return null;

  const candidates = descendants(clientPid, table)
    .filter(isPeersServer)
    .filter((row) => row.pid !== process.pid);
  const cwdMatches = candidates.filter((row) => cwdResolver(row.pid) === hookCwd);
  const selected = preferLeafCandidates(cwdMatches.length > 0 ? cwdMatches : candidates, table);
  if (selected.length === 1) return selected[0]!.pid;
  return null;
}

export function findClientPidFromTable(
  table: Map<number, ProcRow>,
  startPid = process.ppid,
  clientType = CLIENT_TYPE,
): number | null {
  return findClientAncestor(table, startPid, clientType);
}

export function findHookPeerPidsFromTable(
  table: Map<number, ProcRow>,
  startPid = process.ppid,
  hookCwd = process.cwd(),
  cwdReader: (pid: number) => string | null = cwdOf,
  clientType = CLIENT_TYPE,
  envPid: number | null = null,
  identityEnvReader: (pid: number) => boolean = hasPeerIdentityEnv,
  ttyReader: (pid: number) => string | null = getTty,
): { primary: number; fallbacks: number[] } | null {
  const validEnvPid = envPid !== null && Number.isInteger(envPid) && envPid > 1 ? envPid : null;
  const hasEnvPid = validEnvPid !== null;
  let clientPid = findClientAncestor(table, startPid, clientType);
  if (!clientPid && clientType === "codex") {
    const appServer = findCodexAppServerAncestor(table, startPid);
    const visibleCwd = appServer ? (cwdReader(appServer.pid) ?? hookCwd) : hookCwd;
    const visible = findSingleVisibleCodexProcess(table, visibleCwd, {
      cwdOf: cwdReader,
      getTty: ttyReader,
      environOf: (pid) => identityEnvReader(pid) ? { CLAUDE_PEER_NAME: "1" } : {},
    });
    clientPid = visible?.pid ?? null;
  }
  if (!clientPid) {
    // An app-server-hosted thread has no seat: no tty, no tmux pane, no
    // CLAUDE_PEER_NAME. There is nothing to disambiguate it with and no mailbox
    // it owns, so having no seat is its NORMAL state, not a fault — the visible
    // lanes it hosts drain on their own hooks. Logging it as a failure on every
    // prompt buried the real failures under ~13 lines per 10 minutes and made a
    // healthy fleet look broken. Stay quiet for that case; keep the log for a
    // hook that genuinely should have resolved a seat and did not.
    if (!hasEnvPid && !isHostedWithoutSeat(table, startPid, ttyReader)) {
      log(`no ${CLIENT_TYPE} ancestor found`);
    }
    return hasEnvPid ? { primary: validEnvPid, fallbacks: [] } : null;
  }

  const candidates = descendants(clientPid, table)
    .filter(isPeersServer)
    .filter((row) => row.pid !== process.pid);
  const cwdMatches = candidates.filter((row) => cwdReader(row.pid) === hookCwd);
  const selected = preferLeafCandidates(cwdMatches.length > 0 ? cwdMatches : candidates, table);
  if (selected.length === 1) {
    const mcpPid = selected[0]!.pid;
    const fallbacks = [mcpPid, validEnvPid]
      .filter((pid): pid is number => pid !== null && Number.isInteger(pid) && pid > 1 && pid !== clientPid)
      .filter((pid, index, all) => all.indexOf(pid) === index);
    return { primary: clientPid, fallbacks };
  }
  if (selected.length > 1 && !hasEnvPid) {
    log(`multiple claude-peers MCP candidates: ${selected.map((p) => p.pid).join(",")}`);
  }
  if (hasEnvPid && validEnvPid !== clientPid) return { primary: clientPid, fallbacks: [validEnvPid] };
  return { primary: clientPid, fallbacks: [] };
}

/**
 * Resolve this hook's seat, distinguishing "no seat by construction" from
 * "should have had a seat and did not".
 *
 * The caller needs the difference for its EXIT CODE, not just its log level: an
 * app-server-hosted thread has no seat and no mailbox, so exiting non-zero makes
 * the wrapper record `drain-failed rc=1` on every prompt for something that is
 * working as intended. Silencing only the message left that half in place.
 */
function findHookPeerPids(): { primary: number; fallbacks: number[] } | { seatless: true } | null {
  const envPid = Number(process.env.CLAUDE_PEERS_MCP_PID ?? "");
  const table = processTable();
  const resolved = findHookPeerPidsFromTable(
    table,
    process.ppid,
    process.cwd(),
    cwdOf,
    CLIENT_TYPE,
    Number.isInteger(envPid) && envPid > 1 ? envPid : null,
  );
  if (resolved) return resolved;
  return isHostedWithoutSeat(table, process.ppid) ? { seatless: true } : null;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = typeof json === "object" && json && "error" in json ? String((json as { error: unknown }).error) : res.statusText;
    throw new BrokerHttpError(path, res.status, err);
  }
  return json as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorBody(error: unknown): string {
  return error instanceof BrokerHttpError ? error.brokerError : errorMessage(error);
}

export function isMissingPeerClaimError(error: unknown): boolean {
  const msg = errorBody(error);
  return /unknown target pid|no peer|peer not found/i.test(msg);
}

export function isMissingClaimEndpointError(error: unknown): boolean {
  if (error instanceof BrokerHttpError) {
    return error.path === "/claim-by-pid" && error.status === 404 && !isMissingPeerClaimError(error);
  }
  const msg = errorMessage(error);
  return /\/claim-by-pid\s+404:\s*(not found)?$/i.test(msg) || /cannot\s+post\s+\/claim-by-pid/i.test(msg);
}

export function shouldSelfRegisterAfterClaimError(error: unknown): boolean {
  return isMissingPeerClaimError(error) && !isMissingClaimEndpointError(error);
}

export async function waitForRegistrationProcess(
  proc: RegistrationProcess,
  timeoutMs = REGISTER_TIMEOUT_MS,
): Promise<{ code: number; stderr: string }> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const stderrPromise = proc.stderr && typeof proc.stderr !== "number"
    ? new Response(proc.stderr).text()
    : Promise.resolve("");
  const completed = Promise.all([proc.exited, stderrPromise]).then(([code, stderr]) => ({ code, stderr }));
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // Process may have already exited.
      }
      reject(new Error(`registration timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([completed, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function registerCurrentSessionForDrain(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["bun", REGISTER_SCRIPT], {
      env: { ...process.env, CLAUDE_PEERS_CLIENT_TYPE: CLIENT_TYPE },
      stdout: "ignore",
      stderr: "pipe",
    });
    const { code, stderr } = await waitForRegistrationProcess(proc);
    if (code !== 0) {
      log(`self-registration failed with exit ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
      return false;
    }
    if (/registration failed|unexpected failure|no .* ancestor found/i.test(stderr)) {
      log(`self-registration did not complete cleanly: ${stderr.trim()}`);
      return false;
    }
    return true;
  } catch (e) {
    log(`self-registration failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * Pick the route family and the identity key for this drain.
 *
 * The `-by-thread` routes are atomic siblings of the `-by-pid` ones: each
 * resolves exactly one LIVE thread row server-side (404 none/dead, 409 duplicate
 * live rows, 400 invalid, same-UID caller required). Resolving identity and then
 * claiming as two calls would leave a TOCTOU gap — the mapping can change
 * between them — which is why the broker exposes claim/ack/heartbeat directly
 * keyed by thread rather than an identity lookup we join client-side.
 */
export function resolveDrainRoute(
  base: string,
  pid: number,
  threadId: string | null,
): { path: string; identity: Record<string, unknown> } {
  return threadId
    ? { path: `/${base}-by-thread`, identity: { thread_id: threadId } }
    : { path: `/${base}-by-pid`, identity: { pid } };
}

/** Thin binding of resolveDrainRoute to this drain's resolved thread identity. */
function drainRoute(base: string, pid: number): { path: string; identity: Record<string, unknown> } {
  return resolveDrainRoute(base, pid, activeThreadId);
}

async function heartbeat(pid: number, status: "ok" | "error", drained = 0, error?: string): Promise<void> {
  const route = drainRoute("hook-heartbeat", pid);
  try {
    await post(route.path, {
      ...route.identity,
      caller_pid: process.pid,
      client_type: CLIENT_TYPE,
      receiver_mode: RECEIVER_MODE,
      status,
      drained,
      error,
    });
  } catch (e) {
    log(`heartbeat failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function claim(pid: number, drainId: string): Promise<ClaimResponse> {
  const route = drainRoute("claim", pid);
  return post(route.path, {
    ...route.identity,
    caller_pid: process.pid,
    client_type: CLIENT_TYPE,
    receiver_mode: RECEIVER_MODE,
    drain_id: drainId,
    limit: MAX_MESSAGES,
    max_bytes: MAX_BYTES,
  });
}

export async function retryClaimAfterSelfRegistration(options: {
  claimPids: number[];
  drainId: string;
  initialPid: number;
  lastClaimError: string;
  register: () => Promise<boolean>;
  claim: ClaimFn;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{
  claimed: ClaimResponse | null;
  pid: number;
  lastClaimError: string;
  attemptedRegistration: boolean;
  fatalError?: string;
}> {
  let pid = options.initialPid;
  let lastClaimError = options.lastClaimError;
  if (!await options.register()) {
    return { claimed: null, pid, lastClaimError, attemptedRegistration: true };
  }

  await (options.sleep ?? Bun.sleep)(250);
  for (const candidatePid of options.claimPids) {
    pid = candidatePid;
    try {
      return {
        claimed: await options.claim(pid, options.drainId),
        pid,
        lastClaimError,
        attemptedRegistration: true,
      };
    } catch (e) {
      lastClaimError = errorMessage(e);
      if (!shouldSelfRegisterAfterClaimError(e)) {
        return { claimed: null, pid, lastClaimError, attemptedRegistration: true, fatalError: lastClaimError };
      }
    }
  }
  return { claimed: null, pid, lastClaimError, attemptedRegistration: true };
}

// Codex pipes the hook event JSON on stdin. Reading it is best-effort: a
// manual TTY run or an empty pipe must not hang the hook (1.5s race guard).
export async function readHookInput(): Promise<Record<string, unknown> | null> {
  if (process.stdin.isTTY) return null;
  try {
    const text = await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 1500)),
    ]);
    if (!text.trim()) return null;
    return JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    log(`hook input unreadable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function main(): Promise<void> {
  const hookInput = await readHookInput();
  if (HOOK_EVENT_NAME === "Stop") {
    // Stop-event loop guard (official Codex hooks contract): stop_hook_active
    // means this Stop already blocked once without progress — let Codex stop.
    if (hookInput?.stop_hook_active === true) {
      return;
    }
    // Fail CLOSED when the payload could not be read on a piped stdin: a
    // dropped stop_hook_active=true would otherwise re-block a turn we were
    // contractually told to release. Skipping leaves mail for the next
    // UserPromptSubmit / SessionStart drain — nothing is lost.
    if (hookInput === null && !process.stdin.isTTY) {
      log("Stop hook input unreadable — failing closed (no drain, no block)");
      return;
    }
  }

  // Thread identity first: it is an exact join to our own row, so it makes the
  // process table irrelevant. Only fall back to ancestry when Codex gave us no
  // session_id (Gemini, legacy Codex, unreadable payload). The PID carried
  // alongside is used for log lines only — the -by-thread routes ignore it.
  activeThreadId = readThreadId(hookInput);
  let pids: { primary: number; fallbacks: number[] };
  if (activeThreadId) {
    pids = { primary: process.pid, fallbacks: [] };
  } else {
    const resolvedPids = findHookPeerPids();
    if (!resolvedPids) {
      process.exitCode = 1;
      return;
    }
    // Seatless by construction: nothing to drain and nothing wrong. Exit 0 so the
    // wrapper does not log a failure for the expected case.
    if ("seatless" in resolvedPids) return;
    pids = resolvedPids;
  }

  const drainId = `${RECEIVER_MODE}:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let claimed: { peer_id?: string; drain_id?: string; messages?: Message[] } | null = null;
  let pid = pids.primary;
  const claimPids = [pids.primary, ...pids.fallbacks].filter((candidate, index, all) => all.indexOf(candidate) === index);
  let lastClaimError = "";
  let sawMissingPeer = false;
  // At SessionStart the peer-register hook and MCP servers launch concurrently
  // with this drain (Codex runs same-event hooks in parallel) — retry
  // peer-not-found briefly instead of giving up on the race.
  const notFoundAttempts = HOOK_EVENT_NAME === "SessionStart" ? 5 : 1;
  for (let attempt = 0; attempt < notFoundAttempts && !claimed; attempt++) {
    if (attempt > 0) await Bun.sleep(600);
    for (const candidatePid of claimPids) {
      pid = candidatePid;
      try {
        claimed = await claim(pid, drainId);
        break;
      } catch (e) {
        const msg = errorMessage(e);
        lastClaimError = msg;
        if (shouldSelfRegisterAfterClaimError(e)) {
          sawMissingPeer = true;
          continue;
        }
        if (isMissingClaimEndpointError(e)) {
          const hint = `${msg}; broker is alive but missing prompt-hook claim support, restart claude-peers-broker`;
          log(`claim failed: ${hint}`);
          await heartbeat(pid, "error", 0, hint);
          return;
        }
        {
          log(`claim failed: ${msg}`);
          await heartbeat(pid, "error", 0, msg);
          return;
        }
      }
    }
  }
  if (!claimed && sawMissingPeer) {
    log("peer row missing during drain; attempting bounded self-registration before one retry");
    const retry = await retryClaimAfterSelfRegistration({
      claimPids,
      drainId,
      initialPid: pid,
      lastClaimError,
      register: registerCurrentSessionForDrain,
      claim,
    });
    pid = retry.pid;
    lastClaimError = retry.lastClaimError;
    claimed = retry.claimed;
    if (retry.fatalError) {
      log(`claim retry failed: ${retry.fatalError}`);
      await heartbeat(pid, "error", 0, retry.fatalError);
      return;
    }
  }
  if (!claimed) {
    log(`claim failed: ${lastClaimError}`);
    await heartbeat(pid, "error", 0, lastClaimError);
    return;
  }

  const messages = claimed.messages ?? [];
  if (messages.length === 0 || !claimed.drain_id) {
    await heartbeat(pid, "ok", 0);
    return;
  }

  const lines = messages.map(renderInboundLine);
  const context = `---\n${messages.length} pending peer message(s):\n\n${lines.join("\n\n")}`;
  // Output shape is event-dependent (official Codex hooks contract): Stop
  // ignores additionalContext / plain stdout, but supports decision:"block"
  // with a reason that is fed back to the model — turn-end delivery. All
  // other events take hookSpecificOutput.additionalContext.
  const output = HOOK_EVENT_NAME === "Stop"
    ? {
      decision: "block",
      reason: `${messages.length} peer message(s) arrived during this turn. Read and handle them before stopping:\n\n${lines.join("\n\n")}`,
    }
    : {
      hookSpecificOutput: {
        hookEventName: HOOK_EVENT_NAME,
        additionalContext: context,
      },
    };

  try {
    await Bun.write(Bun.stdout, `${JSON.stringify(output)}\n`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`stdout emit failed before ack: ${msg}`);
    await heartbeat(pid, "error", 0, msg);
    process.exitCode = 1;
    return;
  }

  try {
    const ackRoute = drainRoute("ack", pid);
    const ack = await post<AckByPidResponse>(ackRoute.path, {
      ...ackRoute.identity,
      caller_pid: process.pid,
      client_type: CLIENT_TYPE,
      receiver_mode: RECEIVER_MODE,
      drain_id: claimed.drain_id,
      ids: messages.map((m) => m.id),
      via: RECEIVER_MODE,
    });
    if (ack.acked !== messages.length) {
      throw new Error(`ack mismatch: expected ${messages.length}, got ${ack.acked ?? 0}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`ack failed after stdout emit: ${msg}`);
    await heartbeat(pid, "error", 0, msg);
    return;
  }
  await heartbeat(pid, "ok", messages.length);
}

if (import.meta.main) {
  main().catch((e) => {
    log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
