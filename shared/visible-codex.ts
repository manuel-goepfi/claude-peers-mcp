import { readFileSync, readlinkSync } from "node:fs";
import {
  codexProcessArgv,
  isClientProcess,
  isCodexAppServerProcess,
  isInteractiveCodexArgv,
  type ProcessInfo,
} from "./client.ts";

export interface VisibleCodexProcess {
  pid: number;
  cwd: string;
  tty: string;
  env: Record<string, string | undefined>;
}

export interface VisibleCodexReaders {
  getTty?: (pid: number) => string | null;
  cwdOf?: (pid: number) => string | null;
  environOf?: (pid: number) => Record<string, string | undefined>;
  processStartTicks?: (pid: number) => number | null;
  paneTtyHint?: string | null;
}

function commandName(value: string): string {
  return value.trim().split(/\s+/)[0]?.toLowerCase().replace(/^.*\//, "") ?? "";
}

function defaultGetTty(pid: number): string | null {
  try {
    const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(pid)]);
    const tty = new TextDecoder().decode(proc.stdout).trim();
    return tty && tty !== "?" && tty !== "??" ? tty : null;
  } catch {
    return null;
  }
}

function snapshotTty(row: ProcessInfo, ttyReader: (pid: number) => string | null): string | null {
  return row.tty === undefined ? ttyReader(row.pid) : row.tty;
}

function normalizedTty(value: string): string {
  return value.replace(/^\/dev\//, "");
}

function defaultCwdOf(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function defaultEnvironOf(pid: number): Record<string, string | undefined> {
  try {
    const text = readFileSync(`/proc/${pid}/environ`, "utf8");
    const env: Record<string, string | undefined> = {};
    for (const entry of text.split("\0")) {
      const idx = entry.indexOf("=");
      if (idx <= 0) continue;
      env[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
    return env;
  } catch {
    return {};
  }
}

export function processStartTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const startTicks = Number(fields[19]);
    return Number.isFinite(startTicks) ? startTicks : null;
  } catch {
    return null;
  }
}

export function hasVisibleCodexIdentityEnv(env: Record<string, string | undefined>): boolean {
  return Boolean(env.CLAUDE_PEER_NAME || env.TMUX_PANE);
}

export function isVisibleCodexProcess(row: ProcessInfo): boolean {
  return isClientProcess(row, "codex") && !isCodexAppServerProcess(row);
}

export function isVisibleCodexArgs(args: string, pid?: number): boolean {
  const first = commandName(args);
  const tokens = args.trim().split(/\s+/).filter(Boolean).map((token) => token.replace(/^['"]|['"]$/g, ""));
  if (first !== "codex" && !first.startsWith("codex-") && first !== "node" && first !== "bun") return false;
  const exact = pid ? codexProcessArgv(pid) : null;
  // Tests and stale ps snapshots can carry a PID that has already been reused.
  // Trust /proc only while its executable still matches the snapshotted argv.
  const argv = exact && commandName(exact[0] ?? "") === first ? exact : tokens;
  return isInteractiveCodexArgv(argv);
}

interface VisibleCodexCandidate {
  row: ProcessInfo;
  visible: VisibleCodexProcess;
}

export { isInteractiveCodexArgv };

export function isInteractiveNativeCodex(row: ProcessInfo, exactArgv = codexProcessArgv(row.pid)): boolean {
  if (exactArgv) return isInteractiveCodexArgv(exactArgv);
  const flattened = row.args.trim().split(/\s+/).filter(Boolean).map((token) =>
    token.replace(/^['"]|['"]$/g, "")
  );
  return isInteractiveCodexArgv(flattened.length > 0 ? flattened : [row.comm]);
}

/** Select one logical TUI, accepting a sole Node/Bun shim or its native child. */
export function singleInteractiveCodexProcess(rows: ProcessInfo[]): ProcessInfo | null {
  const candidates = rows.filter((row) =>
    isClientProcess(row, "codex") && !isCodexAppServerProcess(row) && isInteractiveNativeCodex(row)
  );
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length !== 2) return null;
  const [first, second] = candidates;
  const launcher = second!.ppid === first!.pid ? first : first!.ppid === second!.pid ? second : null;
  const native = launcher === first ? second : launcher === second ? first : null;
  if (!launcher || !native) return null;
  const launcherCommand = commandName(launcher.comm);
  const launcherArg = commandName(launcher.args);
  const nativeCommand = commandName(native.comm);
  if (![launcherCommand, launcherArg].some((value) => value === "node" || value === "bun")) return null;
  if (nativeCommand !== "codex" && !nativeCommand.startsWith("codex-")) return null;
  return native;
}

/**
 * Codex installed through npm has two client processes for one TUI: the Node
 * launcher and its native Codex child. They carry the same pane/TTY identity,
 * so counting both as separate sessions creates a false ambiguity. Collapse
 * only that exact direct pair; a nested Codex command is a separate candidate
 * and must keep the lookup ambiguous.
 */
function singleLogicalVisibleCodex(
  candidates: VisibleCodexCandidate[],
): VisibleCodexProcess | null {
  if (candidates.length === 1) return candidates[0]!.visible;
  if (candidates.length !== 2) return null;

  const [first, second] = candidates;
  const launcher = second!.row.ppid === first!.row.pid ? first
    : first!.row.ppid === second!.row.pid ? second
      : null;
  const native = launcher === first ? second : launcher === second ? first : null;
  if (!launcher || !native) return null;

  const launcherCommand = commandName(launcher.row.comm);
  const launcherArg = commandName(launcher.row.args);
  if (![launcherCommand, launcherArg].some((value) => value === "node" || value === "bun")) return null;
  const nativeCommand = commandName(native.row.comm);
  if (nativeCommand !== "codex" && !nativeCommand.startsWith("codex-")) return null;
  if (!isInteractiveNativeCodex(native.row)) return null;
  if (launcher.visible.cwd !== native.visible.cwd || launcher.visible.tty !== native.visible.tty) return null;

  const identityKeys = ["TMUX_PANE", "CLAUDE_PEER_TMUX_PANE_ID", "CLAUDE_PEER_NAME"] as const;
  if (identityKeys.some((key) => launcher.visible.env[key] !== native.visible.env[key])) return null;
  return native.visible;
}

export function findSingleVisibleCodexProcess(
  processes: Map<number, ProcessInfo> | Iterable<ProcessInfo>,
  cwdHint: string,
  readers: VisibleCodexReaders = {},
  requireIdentityEnv = true,
): VisibleCodexProcess | null {
  const ttyReader = readers.getTty ?? defaultGetTty;
  const cwdReader = readers.cwdOf ?? defaultCwdOf;
  const envReader = readers.environOf ?? defaultEnvironOf;
  const rows = processes instanceof Map ? processes.values() : processes;
  const candidates: VisibleCodexCandidate[] = [];

  for (const row of rows) {
    if (!isVisibleCodexProcess(row)) continue;
    const tty = snapshotTty(row, ttyReader);
    if (!tty) continue;
    const cwd = cwdReader(row.pid);
    if (!cwd || cwd !== cwdHint) continue;
    const env = envReader(row.pid);
    if (requireIdentityEnv && !hasVisibleCodexIdentityEnv(env)) continue;
    candidates.push({ row, visible: { pid: row.pid, cwd, tty, env } });
  }

  return singleLogicalVisibleCodex(candidates);
}

export function findVisibleCodexProcessByPaneId(
  processes: Map<number, ProcessInfo> | Iterable<ProcessInfo>,
  cwdHint: string | null,
  paneId: string,
  readers: VisibleCodexReaders = {},
): VisibleCodexProcess | null {
  const ttyReader = readers.getTty ?? defaultGetTty;
  const cwdReader = readers.cwdOf ?? defaultCwdOf;
  const envReader = readers.environOf ?? defaultEnvironOf;
  const paneTty = readers.paneTtyHint ? normalizedTty(readers.paneTtyHint) : null;
  const rows = processes instanceof Map ? processes.values() : processes;
  const candidates: VisibleCodexCandidate[] = [];

  for (const row of rows) {
    if (!isVisibleCodexProcess(row)) continue;
    const tty = snapshotTty(row, ttyReader);
    if (!tty) continue;
    if (paneTty && normalizedTty(tty) !== paneTty) continue;
    const cwd = cwdReader(row.pid);
    if (!cwd || (cwdHint !== null && cwd !== cwdHint)) continue;
    const env = envReader(row.pid);
    if (env.TMUX_PANE !== paneId && env.CLAUDE_PEER_TMUX_PANE_ID !== paneId) continue;
    candidates.push({ row, visible: { pid: row.pid, cwd, tty, env } });
  }

  return singleLogicalVisibleCodex(candidates);
}

export function findNearestVisibleCodexProcessByStart(
  processes: Map<number, ProcessInfo> | Iterable<ProcessInfo>,
  cwdHint: string,
  anchorPid: number,
  readers: VisibleCodexReaders = {},
  maxStartTickDelta = 2_000,
  requireIdentityEnv = true,
): VisibleCodexProcess | null {
  const startTicksReader = readers.processStartTicks ?? processStartTicks;
  const anchorStart = startTicksReader(anchorPid);
  if (anchorStart === null) return null;

  const rows = processes instanceof Map ? processes.values() : processes;
  const candidates = Array.from(rows)
    .filter((row) => row.pid !== anchorPid)
    .map((row) => {
      const startTicks = startTicksReader(row.pid);
      if (startTicks === null) return null;
      const visible = findSingleVisibleCodexProcess([row], cwdHint, readers, requireIdentityEnv);
      if (!visible) return null;
      const delta = anchorStart - startTicks;
      if (delta < 0 || delta > maxStartTickDelta) return null;
      return { visible, delta };
    })
    .filter((entry): entry is { visible: VisibleCodexProcess; delta: number } => entry !== null)
    .sort((a, b) => a.delta - b.delta);

  if (candidates.length === 0) return null;
  if (candidates.length > 1 && candidates[0]!.delta === candidates[1]!.delta) return null;
  return candidates[0]!.visible;
}
