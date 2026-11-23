import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, readdirSync } from "node:fs";
import { compareHomeSession, parseSessionCandidate, type SessionCandidate } from "./tmux-home-session.ts";

type ProcessStat = { pid: number; stat: string };
const snapshots = new AsyncLocalStorage<{
  panes: Map<string, Map<string, string> | null>;
  processes?: ProcessStat[];
  asyncPanes?: boolean;
}>();

// A short TTL makes pane moves and session renames visible without a tmux
// subprocess for every heartbeat or claim.
const PANE_TTL_MS = 1_000;
const paneCache = new Map<string, { rows: Map<string, string> | null; expires: number }>();
const paneReads = new Map<string, Promise<Map<string, string> | null>>();

// The first five fields are the proof row; the session fields after them only
// rank the sessions a grouped window is listed under (once per session).
const RUNTIME_PANE_FORMAT =
  `#{pid}\t#{pane_pid}\t#{pane_id}\t#{session_id}\t#{session_name}\t#{session_grouped}\t#{session_group}\t#{session_created}\t#{destroy-unattached}\t#{window_linked_sessions}`;

function paneRows(output: string | null): Map<string, string> | null {
  if (output === null) return null;
  const rows = new Map<string, { line: string; rank: SessionCandidate | null }>();
  for (const line of output.split("\n").filter(Boolean)) {
    const fields = line.split("\t");
    const proof = fields.slice(0, 5).join("\t");
    const rank = parseSessionCandidate(fields[4] ?? "", [fields[3] ?? "", ...fields.slice(5)]);
    const held = rows.get(fields[2]!);
    if (held?.rank && rank && compareHomeSession(rank, held.rank) >= 0) continue;
    rows.set(fields[2]!, { line: proof, rank });
  }
  return new Map([...rows].map(([pane, row]) => [pane, row.line] as const));
}

/** Share only within one request, never across later ownership decisions. */
export function withRuntimePaneSnapshot<T>(work: () => T, asyncPanes = false): T {
  return snapshots.run({ panes: new Map(), asyncPanes }, work);
}

/** Broker requests await a coalesced, bounded tmux read without blocking Bun's
 * event loop. A failed read is cached for one second to avoid a retry storm. */
export async function primeRuntimePaneRows(socket: string, force = false): Promise<void> {
  if (paneCache.size > 128) {
    for (const [key, value] of paneCache) if (value.expires <= Date.now()) paneCache.delete(key);
  }
  let cached = paneCache.get(socket);
  if (force || !cached || cached.expires <= Date.now()) {
    let pending = paneReads.get(socket);
    if (!pending) {
      pending = readPanesAsync(socket).then(paneRows);
      paneReads.set(socket, pending);
      void pending.finally(() => paneReads.delete(socket));
    }
    const rows = await pending;
    cached = { rows, expires: Date.now() + (rows ? PANE_TTL_MS : 1_000) };
    paneCache.set(socket, cached);
  }
  snapshots.getStore()?.panes.set(socket, cached.rows);
}

export function runtimePaneRow(socket: string, pane: string, read = readPanes): string | null {
  const cache = snapshots.getStore()?.panes;
  if (cache?.has(socket)) return cache.get(socket)?.get(pane) ?? null;
  if (snapshots.getStore()?.asyncPanes) return null;
  const output = read(socket);
  const rows = paneRows(output);
  cache?.set(socket, rows);
  return rows?.get(pane) ?? null;
}

/** Native proofs for different TTYs share a scan, never a prior request's owner. */
export function runtimeProcessStats(read = readProcessStats): ProcessStat[] {
  const snapshot = snapshots.getStore();
  if (!snapshot) return read();
  return snapshot.processes ??= read();
}

function readProcessStats(): ProcessStat[] {
  const rows: ProcessStat[] = [];
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    try { rows.push({ pid, stat: readFileSync(`/proc/${pid}/stat`, "utf8") }); }
    catch { /* Processes can exit during the snapshot. */ }
  }
  return rows;
}

function readPanes(socket: string): string | null {
  const result = Bun.spawnSync(["tmux", "-S", socket, "list-panes", "-a", "-F",
    RUNTIME_PANE_FORMAT],
  { stdout: "pipe", stderr: "ignore", timeout: 1500 });
  return result.exitCode === 0 ? result.stdout.toString().trimEnd() : null;
}

async function readPanesAsync(socket: string): Promise<string | null> {
  try {
    const child = Bun.spawn(["tmux", "-S", socket, "list-panes", "-a", "-F",
      RUNTIME_PANE_FORMAT],
    { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 2_000);
    try {
      const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      return code === 0 && output.length <= 1024 * 1024 ? output.trimEnd() : null;
    } finally { clearTimeout(timer); }
  } catch { return null; }
}
