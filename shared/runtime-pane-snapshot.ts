import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, readdirSync } from "node:fs";

type ProcessStat = { pid: number; stat: string };
const snapshots = new AsyncLocalStorage<{
  panes: Map<string, Map<string, string> | null>;
  processes?: ProcessStat[];
}>();

/** Share only within one request, never across later ownership decisions. */
export function withRuntimePaneSnapshot<T>(work: () => T): T {
  return snapshots.run({ panes: new Map() }, work);
}

export function runtimePaneRow(socket: string, pane: string, read = readPanes): string | null {
  const cache = snapshots.getStore()?.panes;
  if (cache?.has(socket)) return cache.get(socket)?.get(pane) ?? null;
  const output = read(socket);
  const rows = output === null ? null : new Map(output.split("\n").filter(Boolean).map(line => {
    const fields = line.split("\t");
    return [fields[2]!, line] as const;
  }));
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
    "#{pid}\t#{pane_pid}\t#{pane_id}\t#{session_id}\t#{session_name}"],
  { stdout: "pipe", stderr: "ignore", timeout: 1500 });
  return result.exitCode === 0 ? result.stdout.toString().trimEnd() : null;
}
