/**
 * Pure parsing helpers for F2 tmux process-ancestry detection.
 *
 * These live in shared/ rather than server.ts so tests can import them
 * without triggering server.ts's top-level main() side effects (which
 * would spawn a broker, register a peer, and start the poll loop).
 */

export interface TmuxPaneInfo {
  session: string;
  window_index: string;
  window_name: string;
}

/**
 * Parse output of `tmux list-panes -a -F "#{pane_pid}\t#{session_name}\t#{window_index}\t#{window_name}"`.
 * Returns a Map keyed by pane_pid for O(1) ancestry lookups.
 *
 * Tab-delimited (NOT space-delimited) so session names and window names with
 * spaces are preserved. Skips malformed lines and lines with non-numeric pids.
 */
export function parseTmuxPanes(output: string): Map<number, TmuxPaneInfo> {
  const paneMap = new Map<number, TmuxPaneInfo>();
  for (const line of output.trim().split("\n")) {
    const parts = line.split("\t");
    if (parts.length >= 4) {
      const pid = parseInt(parts[0]!, 10);
      if (!isNaN(pid)) {
        paneMap.set(pid, {
          session: parts[1]!,
          window_index: parts[2]!,
          window_name: parts[3]!,
        });
      }
    }
  }
  return paneMap;
}

/**
 * Parse output of `ps -eo pid,ppid` into a pid → ppid map.
 * Skips the header line; tolerates extra whitespace.
 */
export function parsePsTree(output: string): Map<number, number> {
  const tree = new Map<number, number>();
  const lines = output.trim().split("\n").slice(1); // drop header
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      const pid = parseInt(parts[0]!, 10);
      const ppid = parseInt(parts[1]!, 10);
      if (!isNaN(pid) && !isNaN(ppid)) {
        tree.set(pid, ppid);
      }
    }
  }
  return tree;
}
