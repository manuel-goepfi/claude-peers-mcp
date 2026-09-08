import { AsyncLocalStorage } from "node:async_hooks";

const snapshots = new AsyncLocalStorage<Map<string, Map<string, string> | null>>();

/** Share only within one request, never across later ownership decisions. */
export function withRuntimePaneSnapshot<T>(work: () => T): T {
  return snapshots.run(new Map(), work);
}

export function runtimePaneRow(socket: string, pane: string, read = readPanes): string | null {
  const cache = snapshots.getStore();
  if (cache?.has(socket)) return cache.get(socket)?.get(pane) ?? null;
  const output = read(socket);
  const rows = output === null ? null : new Map(output.split("\n").filter(Boolean).map(line => {
    const fields = line.split("\t");
    return [fields[2]!, line] as const;
  }));
  cache?.set(socket, rows);
  return rows?.get(pane) ?? null;
}

function readPanes(socket: string): string | null {
  const result = Bun.spawnSync(["tmux", "-S", socket, "list-panes", "-a", "-F",
    "#{pid}\t#{pane_pid}\t#{pane_id}\t#{session_id}\t#{session_name}"],
  { stdout: "pipe", stderr: "ignore", timeout: 1500 });
  return result.exitCode === 0 ? result.stdout.toString().trimEnd() : null;
}
