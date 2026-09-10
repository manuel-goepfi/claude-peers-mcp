import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { boundedCommand } from "./bounded-command.ts";
import type { ProcLike } from "./tmux.ts";

function processStat(text: string, pid: number): { ppid: number; start: string; comm: string } | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 1 || close <= open || Number(text.slice(0, open).trim()) !== pid) return null;
  const fields = text.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  const start = fields[19];
  if (!Number.isSafeInteger(ppid) || ppid < 0 || !start || !/^\d+$/.test(start)) return null;
  return { ppid, start, comm: text.slice(open + 1, close) };
}

/** Run in a disposable child: even a stalled procfs read must not block a tick. */
export function readLinuxProcessSnapshot(
  procRoot = "/proc",
  readText: (path: string) => string = path => readFileSync(path, "utf8"),
): ProcLike[] {
  const rows: ProcLike[] = [];
  for (const entry of readdirSync(procRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (!Number.isSafeInteger(pid)) continue;
    try {
      const statPath = join(procRoot, entry.name, "stat");
      const before = processStat(readText(statPath), pid);
      if (!before) continue;
      const args = readText(join(procRoot, entry.name, "cmdline")).replaceAll("\0", " ").trim();
      const after = processStat(readText(statPath), pid);
      // Never combine one process's argv with a reused PID or changed ancestry.
      if (!after || before.start !== after.start || before.ppid !== after.ppid) continue;
      rows.push({ pid, ppid: after.ppid, args: args || `[${after.comm}]` });
    } catch { /* A process can exit or become unreadable during the scan. */ }
  }
  return rows;
}

export function readProcessSnapshot(
  run = boundedCommand,
  platform: NodeJS.Platform = process.platform,
): ProcLike[] | null {
  const linux = platform === "linux";
  const command = linux
    ? [process.execPath, new URL(import.meta.url).pathname, "--linux-proc-snapshot"]
    : ["ps", "-eo", "pid=,ppid=,args="];
  const result = run(command, { operation: "poller-process-snapshot", timeoutMs: 3000 });
  if (!result.ok) return null;
  if (!linux) {
    return result.out.split("\n").flatMap(line => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), args: match[3]! }] : [];
    });
  }
  try {
    const rows = JSON.parse(result.out) as unknown;
    if (!Array.isArray(rows) || !rows.every(row => row && Number.isSafeInteger(row.pid)
      && row.pid > 0 && Number.isSafeInteger(row.ppid) && row.ppid >= 0 && typeof row.args === "string")) return null;
    return rows;
  } catch { return null; }
}

if (import.meta.main) {
  if (process.argv[2] !== "--linux-proc-snapshot") process.exit(2);
  try {
    // This pipe is consumed only by the parent snapshot reader, never its log.
    process.stdout.write(JSON.stringify(readLinuxProcessSnapshot(process.argv[3])));
  } catch { process.exitCode = 1; }
}
