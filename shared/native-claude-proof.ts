import { readFileSync, statSync } from "node:fs";
import { isClientProcess } from "./client.ts";

// Resolve once during module startup. No heartbeat or claim can spawn a
// blocking subprocess when Linux process start times are checked.
const clockTicks = await (async (): Promise<number | null> => {
  try {
    const child = Bun.spawn(["getconf", "CLK_TCK"], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 1_000);
    try {
      const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      const ticks = Number(output.trim());
      return code === 0 && ticks > 0 ? ticks : null;
    } finally { clearTimeout(timer); }
  } catch { return null; }
})();

/** CLK_TCK resolved once at startup; null when it could not be read. */
export function clockTicksPerSecond(): number | null {
  return clockTicks;
}

// Read only process metadata, never the environment or terminal contents.
export function nearestNativeClaude(callerPid: number): { pid: number; bornAt: number; callerBornAt: number } | null {
  if (!Number.isInteger(callerPid) || callerPid <= 1) return null;
  try {
    const uid = process.getuid?.();
    const ticks = clockTicks;
    const boot = Number(readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)?.[1]);
    if (ticks === null || !(boot > 0)) return null;
    let pid = callerPid;
    let callerBornAt = NaN;
    for (let depth = 0; depth < 30 && pid > 1; depth++) {
      if (statSync(`/proc/${pid}`).uid !== uid) return null;
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      const ppid = Number(fields[1]);
      if (depth === 0) callerBornAt = (boot + Number(fields[19]) / ticks) * 1000;
      const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
      if (isClientProcess({ pid, ppid, comm, args }, "claude")) {
        const bornAt = (boot + Number(fields[19]) / ticks) * 1000;
        return Number.isFinite(bornAt) && Number.isFinite(callerBornAt) ? { pid, bornAt, callerBornAt } : null;
      }
      if (!Number.isInteger(ppid) || ppid === pid) return null;
      pid = ppid;
    }
  } catch { /* An exited or unreadable process is not ownership proof. */ }
  return null;
}
