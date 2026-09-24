import { AsyncLocalStorage } from "node:async_hooks";
const snapshots = new AsyncLocalStorage<{
  panes: Map<string, Map<string, string> | null>;
  asyncPanes?: boolean;
}>();

// A short TTL makes pane moves and session renames visible without a tmux
// subprocess for every heartbeat or claim.
const PANE_TTL_MS = 1_000;
const paneCache = new Map<string, { rows: Map<string, string> | null; expires: number }>();
const paneReads = new Map<string, Promise<Map<string, string> | null>>();

function paneRows(output: string | null): Map<string, string> | null {
  return output === null ? null : new Map(output.split("\n").filter(Boolean).map(line => {
    const fields = line.split("\t");
    return [fields[2]!, line] as const;
  }));
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

function readPanes(socket: string): string | null {
  const result = Bun.spawnSync(["tmux", "-S", socket, "list-panes", "-a", "-F",
    "#{pid}\t#{pane_pid}\t#{pane_id}\t#{session_id}\t#{session_name}"],
  { stdout: "pipe", stderr: "ignore", timeout: 1500 });
  return result.exitCode === 0 ? result.stdout.toString().trimEnd() : null;
}

async function readPanesAsync(socket: string): Promise<string | null> {
  try {
    const child = Bun.spawn(["tmux", "-S", socket, "list-panes", "-a", "-F",
      "#{pid}\t#{pane_pid}\t#{pane_id}\t#{session_id}\t#{session_name}"],
    { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 2_000);
    try {
      const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      return code === 0 && output.length <= 1024 * 1024 ? output.trimEnd() : null;
    } finally { clearTimeout(timer); }
  } catch { return null; }
}
