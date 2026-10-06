/**
 * codex-subagent-reaper: archive finished, orphaned Codex subagent threads on
 * the host's shared Codex app-servers.
 *
 * A subagent thread stays loaded after its work is done, and it stays loaded
 * when its parent unloads. Each one holds managed-network-proxy listeners,
 * session fds and writer locks until it is unloaded, so orphans accumulate
 * until the app-server runs out of descriptors (2026-10-06: 89 loaded threads
 * on one server, 32 of them orphans of 16 unloaded parents). Archiving a
 * subagent unloads it and releases them.
 *
 * Dry run by default; `--apply` archives. A thread is archived ONLY when all
 * of these hold:
 *   - it is a subagent (thread/read names a parentThreadId);
 *   - its status is `idle` (never active, systemError, or unknown);
 *   - its parent is absent from thread/loaded/list on EVERY known app-server
 *     socket (one unreachable server refuses the whole run);
 *   - its updatedAt is older than the grace period (default 30 minutes).
 * Each candidate is re-read and the parent re-checked on every server
 * immediately before its archive, and the archive is verified with
 * thread/loaded/list. Top-level (lane) threads are never archived; a lane
 * thread in `systemError` is only reported, for its owning lane to handle.
 *
 * Known sockets are the same set codex-thread-stop uses:
 * CLAUDE_PEERS_CODEX_APP_SERVER_SOCKETS (colon-separated) when set, else the
 * account homes' control sockets that exist.
 *
 * Exit codes: 0 dry run or every candidate archived, 1 an archive failed or
 * did not verify, 2 refused (nothing changed), 64 usage.
 */
import { pathToFileURL } from "node:url";
import {
  canonicalSocket,
  connectAppServer,
  defaultKnownSockets,
  loadedThreadIds,
  openAppServer,
  threadStatus,
  type RpcConnection,
} from "./codex-thread-stop.ts";

export const REAPER_EXIT = { ok: 0, failed: 1, refused: 2, usage: 64 } as const;

export interface ReaperOptions {
  apply: boolean;
  graceMs: number;
}

const DEFAULT_GRACE_MINUTES = 30;
const USAGE = `usage: codex-subagent-reaper [--dry-run | --apply] [--grace-min N]   (default: dry run, grace ${DEFAULT_GRACE_MINUTES})`;

export function parseReaperArgs(argv: string[]): { ok: true; options: ReaperOptions } | { ok: false; error: string } {
  let apply = false;
  let dryRun = false;
  let graceMinutes = DEFAULT_GRACE_MINUTES;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--grace-min") {
      const value = argv[++index];
      if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) return { ok: false, error: `--grace-min needs a whole number of minutes >= 1\n${USAGE}` };
      graceMinutes = Number(value);
    } else if (arg === "-h" || arg === "--help") return { ok: false, error: USAGE };
    else return { ok: false, error: `unknown argument: ${arg}\n${USAGE}` };
  }
  if (apply && dryRun) return { ok: false, error: `--apply and --dry-run are exclusive\n${USAGE}` };
  return { ok: true, options: { apply, graceMs: graceMinutes * 60_000 } };
}

export interface LoadedThread {
  socket: string;
  threadId: string;
  status: string;
  parentThreadId: string | null;
  updatedAt: number | null;
}

export type Verdict =
  | { action: "archive"; reason: string }
  | { action: "keep"; reason: string }
  | { action: "report"; reason: string };

/** The whole archive rule. `loadedEverywhere` is the union of every known server's loaded list. */
export function classifyThread(thread: LoadedThread, loadedEverywhere: Set<string>, nowMs: number, graceMs: number): Verdict {
  if (!thread.parentThreadId) {
    return thread.status === "systemError"
      ? { action: "report", reason: "lane thread in systemError: route to its owning lane (never archived here)" }
      : { action: "keep", reason: "lane thread" };
  }
  if (loadedEverywhere.has(thread.parentThreadId)) return { action: "keep", reason: `parent ${thread.parentThreadId} is loaded` };
  if (thread.status !== "idle") {
    return thread.status === "systemError"
      ? { action: "report", reason: `orphan subagent in systemError (parent ${thread.parentThreadId} not loaded); not archived` }
      : { action: "keep", reason: `status ${thread.status}` };
  }
  if (thread.updatedAt === null) return { action: "keep", reason: "no updatedAt; cannot apply the grace period" };
  const idleMs = nowMs - thread.updatedAt;
  if (idleMs < graceMs) return { action: "keep", reason: `updated ${minutes(idleMs)}m ago, inside the ${minutes(graceMs)}m grace period` };
  return { action: "archive", reason: `idle orphan: parent ${thread.parentThreadId} is loaded on no known app-server; idle ${minutes(idleMs)}m` };
}

function minutes(ms: number): number {
  return Math.max(0, Math.round(ms / 60_000));
}

export interface ReaperDeps {
  connect: (socketPath: string) => Promise<RpcConnection>;
  knownSockets: () => string[];
  canonical?: (path: string) => string;
  now?: () => number;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** Every server's loaded list, and their union (for the parent check). */
async function listLoaded(servers: Map<string, RpcConnection>):
  Promise<{ bySocket: Map<string, Set<string>>; ids: Set<string> } | { error: string }> {
  const bySocket = new Map<string, Set<string>>();
  const ids = new Set<string>();
  for (const [socket, rpc] of servers) {
    const loaded = await loadedThreadIds(rpc);
    if (loaded === null) return { error: `thread/loaded/list failed on ${socket}` };
    bySocket.set(socket, loaded);
    for (const id of loaded) ids.add(id);
  }
  return { bySocket, ids };
}

async function readLoaded(socket: string, rpc: RpcConnection, threadId: string): Promise<LoadedThread | { error: string } | null> {
  const info = await threadStatus(rpc, threadId);
  if (!info.known) return info.transport ? { error: `thread/read ${threadId} on ${socket} failed: ${info.error}` } : null;
  return { socket, threadId, status: info.status, parentThreadId: info.parentThreadId, updatedAt: info.updatedAt };
}

export async function runCodexSubagentReaper(options: ReaperOptions, deps: ReaperDeps): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const canonical = deps.canonical ?? canonicalSocket;
  const now = deps.now ?? Date.now;
  const sockets = new Map<string, string>();
  for (const socket of deps.knownSockets()) if (!sockets.has(canonical(socket))) sockets.set(canonical(socket), socket);
  if (sockets.size === 0) { err("codex-subagent-reaper: refused: no known app-server socket"); return REAPER_EXIT.refused; }

  const servers = new Map<string, RpcConnection>();
  try {
    for (const socket of sockets.values()) {
      try {
        servers.set(socket, await openAppServer(deps.connect, socket));
      } catch (error) {
        err(`codex-subagent-reaper: refused: app-server ${socket} is unreachable (${error instanceof Error ? error.message : String(error)}); cannot prove any parent is gone`);
        return REAPER_EXIT.refused;
      }
    }
    const union = await listLoaded(servers);
    if ("error" in union) { err(`codex-subagent-reaper: refused: ${union.error}; cannot prove any parent is gone`); return REAPER_EXIT.refused; }

    const candidates: LoadedThread[] = [];
    const counts = { archive: 0, keep: 0, report: 0 };
    out(`codex-subagent-reaper: ${servers.size} app-server(s), ${union.ids.size} loaded thread(s), grace ${minutes(options.graceMs)}m${options.apply ? "" : " (dry run)"}`);
    for (const [socket, rpc] of servers) {
      for (const threadId of union.bySocket.get(socket)!) {
        const thread = await readLoaded(socket, rpc, threadId);
        if (thread === null) continue; // unloaded since the listing
        if ("error" in thread) { counts.keep++; out(`  keep    ${threadId} (${socket}): unreadable: ${thread.error}`); continue; }
        const verdict = classifyThread(thread, union.ids, now(), options.graceMs);
        counts[verdict.action]++;
        if (verdict.action === "archive") candidates.push(thread);
        // Plain lane threads are the bulk of every server; only count them.
        if (verdict.action !== "keep" || thread.parentThreadId) out(`  ${verdict.action.padEnd(7)} ${threadId} (${socket}): ${verdict.reason}`);
      }
    }
    out(`codex-subagent-reaper: ${counts.archive} to archive, ${counts.report} reported, ${counts.keep} kept`);
    if (!options.apply) {
      out("codex-subagent-reaper: dry run: read-only calls only; rerun with --apply to archive");
      return REAPER_EXIT.ok;
    }

    let failed = 0;
    let archived = 0;
    for (const candidate of candidates) {
      const rpc = servers.get(candidate.socket)!;
      // Re-check right before acting: the parent may have been resumed, or the
      // subagent re-driven, since the survey.
      const fresh = await listLoaded(servers);
      if ("error" in fresh) { failed++; out(`  skipped ${candidate.threadId}: ${fresh.error}; cannot re-prove the parent is gone`); continue; }
      const again = await readLoaded(candidate.socket, rpc, candidate.threadId);
      if (again === null) { out(`  skipped ${candidate.threadId}: no longer loaded`); continue; }
      if ("error" in again) { failed++; out(`  skipped ${candidate.threadId}: ${again.error}`); continue; }
      const verdict = classifyThread(again, fresh.ids, now(), options.graceMs);
      if (verdict.action !== "archive") { out(`  skipped ${candidate.threadId}: ${verdict.reason}`); continue; }
      const reply = await rpc.request("thread/archive", { threadId: candidate.threadId });
      const loaded = await loadedThreadIds(rpc);
      if (reply.error || loaded === null || loaded.has(candidate.threadId)) {
        failed++;
        out(`  FAILED  ${candidate.threadId}: ${reply.error ? `thread/archive: ${reply.error.message ?? JSON.stringify(reply.error)}` : loaded === null ? "unverifiable after archive" : "still loaded after archive"}`);
        continue;
      }
      archived++;
      out(`  archived ${candidate.threadId} (${candidate.socket})`);
    }
    out(`codex-subagent-reaper: archived ${archived} of ${candidates.length}${failed ? `, ${failed} failed` : ""}`);
    return failed > 0 ? REAPER_EXIT.failed : REAPER_EXIT.ok;
  } finally {
    for (const rpc of servers.values()) rpc.close();
  }
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  const parsed = parseReaperArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(REAPER_EXIT.usage);
  }
  const code = await runCodexSubagentReaper(parsed.options, {
    connect: (socket) => connectAppServer(socket),
    knownSockets: () => defaultKnownSockets(),
  });
  process.exit(code);
}
