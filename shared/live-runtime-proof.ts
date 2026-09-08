import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { processStartIdentity } from "./broker-lifecycle.ts";

export interface SeatRuntimeProof {
  runtime_key: string;
  process_key: string;
  account_key: string;
  socket_path: string;
  pane_id: string;
  session_name: string;
  session_id: string;
  server_pid: number;
  peer_pid: number;
}

export interface RuntimeProofReaders {
  read(path: string): string;
  start(pid: number): string | null;
  socketOwner(path: string): number | null;
  pane(socket: string, pane: string): string | null;
  uid: number;
}

const readers: RuntimeProofReaders = {
  read: (path) => readFileSync(path, "utf8"),
  start: processStartIdentity,
  socketOwner: (path) => { const s = statSync(path); return s.isSocket() ? s.uid : null; },
  pane: (socket, pane) => {
    const result = Bun.spawnSync(["tmux", "-S", socket, "display-message", "-p", "-t", pane,
      "#{pid}\t#{pane_pid}\t#{pane_id}\t#{session_id}\t#{session_name}"],
    { stdout: "pipe", stderr: "ignore", timeout: 1500 });
    return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trimEnd() : null;
  },
  uid: process.getuid?.() ?? -1,
};

function digest(parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Cheap generation check for already-proven registrations. This checks process
 * incarnation only; enrollment still needs the full runtime/account proof. */
export function currentSeatProcessKey(pid: number): string | null {
  try {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const start = processStartIdentity(pid);
    return start ? digest([boot, String(pid), start]) : null;
  } catch { return null; }
}

/** Missing metadata is not proof of death. Only ESRCH or a different complete
 * process incarnation establishes that the saved process has ended. */
export function seatProcessState(pid:number, savedKey:string|null):"ended"|"live"|"unknown" {
  if (!Number.isSafeInteger(pid) || pid<=1 || !savedKey || !/^[a-f0-9]{64}$/.test(savedKey)) return "unknown";
  const current=currentSeatProcessKey(pid);
  if (current) return current === savedKey ? "live" : "ended";
  try { process.kill(pid,0); return "unknown"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "ended" : "unknown"; }
}

/** Same-user runtime evidence, not inferred from operator labels or cwd.
 * The caller authenticates the broker identity separately. Do not serialize
 * the proof's private socket path into public health/discovery responses.
 */
export function proveSeatRuntime(
  peer: { pid: number; tmux_pane_id: string | null; client_type?: string },
  deps: RuntimeProofReaders = readers,
): SeatRuntimeProof | null {
  if (!peer.tmux_pane_id || !/^%\d+$/.test(peer.tmux_pane_id)
    || !Number.isInteger(peer.pid) || peer.pid <= 1 || deps.uid < 0) return null;
  try {
    const boot = deps.read("/proc/sys/kernel/random/boot_id").trim();
    if (!/^[a-f0-9-]{36}$/.test(boot)) return null;
    const peerStart = deps.start(peer.pid);
    if (!peerStart) return null;
    const env = Object.fromEntries(deps.read(`/proc/${peer.pid}/environ`).split("\0")
      .filter((entry) => entry.includes("=")).map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
    const tmux = env.TMUX?.match(/^(.*),(\d+),(\d+)$/);
    if (!tmux || !isAbsolute(tmux[1]!) || deps.socketOwner(tmux[1]!) !== deps.uid) return null;
    const serverPid = Number(tmux[2]), serverStart = deps.start(serverPid);
    if (!serverStart) return null;
    const pane = deps.pane(tmux[1]!, peer.tmux_pane_id)?.split("\t");
    if (!pane || pane.length !== 5 || Number(pane[0]) !== serverPid || pane[2] !== peer.tmux_pane_id
      || !/^\$\d+$/.test(pane[3]!) || !pane[4] || /[\x00-\x1f\x7f]/.test(pane[4])) return null;
    const shellPid = Number(pane[1]);
    let pid = peer.pid, belongs = false;
    for (let i = 0; i < 32 && pid > 1; i++) {
      if (pid === shellPid) { belongs = true; break; }
      const stat = deps.read(`/proc/${pid}/stat`);
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
      const parent = Number(fields[1]);
      if (!Number.isInteger(parent) || parent === pid) return null;
      pid = parent;
    }
    if (!belongs || deps.start(peer.pid) !== peerStart || deps.start(serverPid) !== serverStart) return null;
    // Bind the account to the visible client's actual environment. Missing
    // profile/home evidence remains unresolved, rather than using broker HOME.
    const config = peer.client_type === "codex" ? env.CODEX_HOME || (env.HOME && join(env.HOME, ".codex"))
      : peer.client_type === "claude" ? env.CLAUDE_CONFIG_DIR || (env.HOME && join(env.HOME, ".claude")) : null;
    if (!config || !isAbsolute(config)) return null;
    return {
      runtime_key: `tmux:${digest([boot, tmux[1]!, String(serverPid), serverStart])}:${pane[2]}`,
      process_key: digest([boot, String(peer.pid), peerStart]),
      account_key: digest([String(deps.uid), peer.client_type!, config]),
      socket_path: tmux[1]!, pane_id: pane[2]!, session_id: pane[3]!, session_name: pane[4]!,
      server_pid: serverPid, peer_pid: peer.pid,
    };
  } catch { return null; }
}
