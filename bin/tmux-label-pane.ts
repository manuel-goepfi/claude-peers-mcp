#!/usr/bin/env bun
import { boundedCommand } from "../shared/bounded-command.ts";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  chooseOperatorLabel,
  cleanTmuxOptionValue,
  preservedTmuxOperatorLabel,
} from "../shared/operator-label.ts";
import {
  PANE_SEAT_FORMAT,
  SEAT_NAME_OPTION,
  cleanSeatName,
  describeSeatHolder,
  parsePaneSeatRows,
  seatNameHolder,
} from "../shared/seat-name.ts";

export interface TmuxLabelCommandResult {
  ok: boolean;
  out: string;
}

export type TmuxLabelRunner = (args: string[]) => TmuxLabelCommandResult;

export type PaneLabelResult =
  | { status: "preserved" | "labeled"; label: string }
  | { status: "skipped"; reason: "pane-gone" }
  | { status: "failed"; reason: string };

interface PaneSnapshot {
  paneId: string;
  session: string;
  paneIndex: string | undefined;
  windowName: string | undefined;
  windowPanes: number | undefined;
  operatorLabel: string | null;
  peerLabel: string | null;
}

const SNAPSHOT_FORMAT = [
  "#{pane_id}",
  "#{session_name}",
  "#{pane_index}",
  "#{window_name}",
  "#{window_panes}",
  "#{@operator_label}",
  "#{@peer_label}",
].join("\t");

function withoutOneTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/, "");
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[0-9]+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseSnapshot(raw: string): PaneSnapshot | null {
  const fields = withoutOneTrailingNewline(raw).split("\t");
  if (fields.length < 7 || !fields[0] || !fields[1]) return null;
  return {
    paneId: fields[0],
    session: fields[1],
    paneIndex: cleanTmuxOptionValue(fields[2]) ?? undefined,
    windowName: cleanTmuxOptionValue(fields[3]) ?? undefined,
    windowPanes: positiveInteger(fields[4]),
    operatorLabel: cleanTmuxOptionValue(fields[5]),
    peerLabel: cleanTmuxOptionValue(fields[6]),
  };
}

function usedOperatorLabels(raw: string, currentPaneId: string): string[] {
  const labels: string[] = [];
  for (const line of raw.split("\n")) {
    const [paneId, operatorLabel, peerLabel, seatName] = line.split("\t");
    if (!paneId || paneId === currentPaneId) continue;
    const label = cleanTmuxOptionValue(operatorLabel) ?? cleanTmuxOptionValue(peerLabel);
    if (label) labels.push(label);
    // An explicit seat name in the ordinal shape (a role label) is taken too:
    // the next auto label must be allocated above it, never onto it.
    const seat = cleanTmuxOptionValue(seatName);
    if (seat) labels.push(seat);
  }
  return labels;
}

function ownsPreservedLabel(pane: PaneSnapshot, label: string, siblings: string): boolean {
  const contenders=[{id:pane.paneId,current:pane.operatorLabel===label}];
  for (const line of siblings.split("\n")) {
    const [id,operator,peer]=line.split("\t");
    if (!id || id===pane.paneId || !/^%[0-9]+$/.test(id)) continue;
    if (preservedTmuxOperatorLabel(operator ?? null,peer ?? null,pane.session)!==label) continue;
    contenders.push({id,current:cleanTmuxOptionValue(operator)===label});
  }
  // Keep the already-canonical owner. If legacy duplicates are equally ranked,
  // stable pane IDs select the survivor independently of enumeration order.
  contenders.sort((a,b)=>Number(b.current)-Number(a.current) || Number(a.id.slice(1))-Number(b.id.slice(1)));
  return contenders[0]!.id===pane.paneId;
}

function siblingLabels(pane: PaneSnapshot, run: TmuxLabelRunner): TmuxLabelCommandResult {
  return run(["list-panes","-s","-t",pane.session,"-F",`#{pane_id}\t#{@operator_label}\t#{@peer_label}\t#{${SEAT_NAME_OPTION}}`]);
}

function panePresence(paneId: string, run: TmuxLabelRunner): "present" | "absent" | "unknown" {
  const livePanes = run(["list-panes", "-a", "-F", "#{pane_id}"]);
  if (!livePanes.ok) return "unknown";
  return livePanes.out.split("\n").some((value) => value.trim() === paneId)
    ? "present"
    : "absent";
}

function ensurePaneOperatorLabelUnlocked(
  paneId: string,
  run: TmuxLabelRunner = runTmux,
): PaneLabelResult {
  const snapshotResult = run(["display-message", "-p", "-t", paneId, SNAPSHOT_FORMAT]);
  if (!snapshotResult.ok) {
    const presence = panePresence(paneId, run);
    if (presence === "unknown") return { status: "failed", reason: "pane-list-failed" };
    return presence === "present"
      ? { status: "failed", reason: "pane-snapshot-failed" }
      : { status: "skipped", reason: "pane-gone" };
  }
  const pane = parseSnapshot(snapshotResult.out);
  if (!pane || pane.paneId !== paneId) return { status: "failed", reason: "invalid-pane-snapshot" };

  const preserved = preservedTmuxOperatorLabel(pane.operatorLabel, pane.peerLabel, pane.session);
  const siblings=siblingLabels(pane,run);
  if (!siblings.ok) {
    return panePresence(pane.paneId,run)==="absent"
      ? {status:"skipped",reason:"pane-gone"}
      : {status:"failed",reason:"session-list-failed"};
  }
  const keep=preserved && ownsPreservedLabel(pane,preserved,siblings.out);
  if (keep && pane.operatorLabel===preserved) return {status:"preserved",label:preserved};
  const label=keep ? preserved : chooseOperatorLabel(pane.session,pane.paneIndex,
    usedOperatorLabels(siblings.out,pane.paneId),pane.windowName,pane.windowPanes);

  // Birth-time allocation owns only the human label. Broker identity fields are
  // registration-owned and must never be fabricated for a zero-turn pane.
  const stamped = run(["set-option", "-p", "-t", pane.paneId, "@operator_label", label]);
  if (stamped.ok) return { status: "labeled", label };
  return panePresence(pane.paneId, run) === "absent"
    ? { status: "skipped", reason: "pane-gone" }
    : { status: "failed", reason: "label-write-failed" };
}

export function ensurePaneOperatorLabel(paneId: string, run: TmuxLabelRunner = runTmux, lockSocket?: string): PaneLabelResult {
  if (run !== runTmux && !lockSocket) return ensurePaneOperatorLabelUnlocked(paneId,run);
  const snapshot = run(["display-message","-p","-t",paneId,SNAPSHOT_FORMAT]);
  const pane = snapshot.ok ? parseSnapshot(snapshot.out) : null;
  const canonical = pane && preservedTmuxOperatorLabel(pane.operatorLabel,pane.peerLabel,pane.session);
  if (pane?.paneId === paneId && canonical && pane.operatorLabel === canonical) {
    const siblings=siblingLabels(pane,run);
    if (siblings.ok && ownsPreservedLabel(pane,canonical,siblings.out)) return {status:"preserved",label:canonical};
  }
  const identity = run(["display-message","-p","-t",paneId,"#{socket_path}\t#{pid}\t#{session_id}"]);
  if (!identity.ok || identity.out.trim().split("\t").length !== 3) {
    return panePresence(paneId, run) === "absent"
      ? {status:"skipped",reason:"pane-gone"}
      : {status:"failed",reason:"lock-identity-unavailable"};
  }
  const directory=join(tmpdir(),`claude-peers-pane-labels-${process.getuid?.() ?? "user"}`);
  mkdirSync(directory,{recursive:true,mode:0o700});
  const lock=join(directory,createHash("sha256").update(identity.out.trim()).digest("hex")+".lock");
  // Every writer shares a socket/server/session lock. A timeout fails closed;
  // an unlocked fallback would allow two simultaneously opened panes to claim N.
  const result=boundedCommand(["flock","-F","-w","5",lock,process.execPath,new URL(import.meta.url).pathname,"--locked-json",paneId],
    {operation:"pane-label-lock",timeoutMs:8000,
      env:lockSocket ? {...process.env,CLAUDE_PEERS_TMUX_SOCKET:lockSocket} : process.env});
  if (!result.ok) return {status:"failed",reason:"label-lock-or-write-failed"};
  try {return JSON.parse(result.out) as PaneLabelResult;}
  catch {return {status:"failed",reason:"invalid-label-result"};}
}

export type SeatNameClaimResult =
  | { status: "claimed"; name: string }
  | { status: "released" }
  | { status: "refused"; holder: string }
  | { status: "failed"; reason: string };

/** The explicit seat name stamped on a pane, or null when it has none. */
export function readPaneSeatName(paneId: string, run: TmuxLabelRunner = runTmux): string | null {
  const result = run(["show-options", "-p", "-t", paneId, "-v", SEAT_NAME_OPTION]);
  return result.ok ? cleanSeatName(result.out) : null;
}

/** Which other pane already answers to `name`? Read-only; null when free. */
export function paneSeatNameHolder(paneId: string, name: string, run: TmuxLabelRunner = runTmux): string | null | { failed: string } {
  const panes = run(["list-panes", "-a", "-F", PANE_SEAT_FORMAT]);
  if (!panes.ok) return { failed: "pane-list-failed" };
  const holder = seatNameHolder(parsePaneSeatRows(panes.out), paneId, name);
  return holder ? describeSeatHolder(holder) : null;
}

/** The name this pane's seat answers to: explicit seat name, else the auto label. */
export function resolvePaneSeatName(paneId: string, run: TmuxLabelRunner = runTmux, lockSocket?: string): PaneLabelResult {
  const explicit = readPaneSeatName(paneId, run);
  if (explicit) return { status: "preserved", label: explicit };
  return ensurePaneOperatorLabel(paneId, run, lockSocket);
}

function claimPaneSeatNameUnlocked(paneId: string, name: string, run: TmuxLabelRunner): SeatNameClaimResult {
  if (name === "") {
    // Releasing returns the pane to its auto label. Unsetting an unset option
    // still exits 0, so a failure here is a real one.
    return run(["set-option", "-p", "-t", paneId, "-u", SEAT_NAME_OPTION]).ok
      ? { status: "released" }
      : { status: "failed", reason: "seat-name-unset-failed" };
  }
  const cleaned = cleanSeatName(name);
  if (!cleaned || cleaned !== name.trim()) return { status: "failed", reason: "invalid-seat-name" };
  const panes = run(["list-panes", "-a", "-F", PANE_SEAT_FORMAT]);
  if (!panes.ok) return { status: "failed", reason: "pane-list-failed" };
  const rows = parsePaneSeatRows(panes.out);
  if (!rows.some((row) => row.paneId === paneId)) return { status: "failed", reason: "pane-gone" };
  const holder = seatNameHolder(rows, paneId, cleaned);
  if (holder) return { status: "refused", holder: describeSeatHolder(holder) };
  return run(["set-option", "-p", "-t", paneId, SEAT_NAME_OPTION, cleaned]).ok
    ? { status: "claimed", name: cleaned }
    : { status: "failed", reason: "seat-name-write-failed" };
}

/**
 * Stamp an explicit seat name on a pane, refusing a name another pane answers
 * to. An empty name releases the pane back to its auto label.
 *
 * Names are unique across the whole tmux server, not per session, so the lock
 * is server-wide: two launchers claiming one role label at the same moment must
 * not both win.
 */
export function claimPaneSeatName(paneId: string, name: string, run: TmuxLabelRunner = runTmux, lockSocket?: string): SeatNameClaimResult {
  if (run !== runTmux && !lockSocket) return claimPaneSeatNameUnlocked(paneId, name, run);
  const identity = run(["display-message", "-p", "-t", paneId, "#{socket_path}\t#{pid}"]);
  if (!identity.ok || identity.out.trim().split("\t").length !== 2) {
    return { status: "failed", reason: panePresence(paneId, run) === "absent" ? "pane-gone" : "lock-identity-unavailable" };
  }
  const directory = join(tmpdir(), `claude-peers-pane-labels-${process.getuid?.() ?? "user"}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, createHash("sha256").update(`seat-names\0${identity.out.trim()}`).digest("hex") + ".lock");
  const result = boundedCommand(["flock", "-F", "-w", "5", lock, process.execPath, new URL(import.meta.url).pathname, "--claim-seat-name-locked-json", paneId, name],
    { operation: "seat-name-lock", timeoutMs: 8000,
      env: lockSocket ? { ...process.env, CLAUDE_PEERS_TMUX_SOCKET: lockSocket } : process.env });
  try { return JSON.parse(result.out) as SeatNameClaimResult; }
  catch { return { status: "failed", reason: result.ok ? "invalid-claim-result" : "seat-name-lock-or-write-failed" }; }
}

export function labelAllUnlabeledPanes(
  run: TmuxLabelRunner = runTmux,
  sessionId?: string,
): { visited: number; labeled: number; failed: number } {
  // One server snapshot replaces two tmux commands per already-correct pane.
  // It is only a read-only filter: candidates still use the authoritative
  // allocator, which re-reads state under its normal session lock before writes.
  const panes = run(["list-panes", ...(sessionId ? ["-s","-t",sessionId] : ["-a"]), "-F", SNAPSHOT_FORMAT]);
  if (!panes.ok) return { visited: 0, labeled: 0, failed: 1 };
  const rows = panes.out.split("\n").filter(Boolean);
  const snapshots = rows.map(parseSnapshot);
  const claims = new Map<string, number>();
  const claimKey = (pane: PaneSnapshot, label: string) => JSON.stringify([pane.session, label]);
  for (const pane of snapshots) {
    if (!pane) continue;
    const label = preservedTmuxOperatorLabel(pane.operatorLabel, pane.peerLabel, pane.session);
    if (label) {
      const key = claimKey(pane, label);
      claims.set(key, (claims.get(key) ?? 0) + 1);
    }
  }
  let labeled = 0;
  let failed = 0;
  for (const [index, row] of rows.entries()) {
    const pane = snapshots[index];
    const label = pane && preservedTmuxOperatorLabel(pane.operatorLabel, pane.peerLabel, pane.session);
    if (pane && label === pane.operatorLabel && label && claims.get(claimKey(pane, label)) === 1) continue;
    const paneId = row.split("\t")[0]!;
    if (!/^%[0-9]+$/.test(paneId)) { failed++; continue; }
    const result = ensurePaneOperatorLabel(paneId, run);
    if (result.status === "labeled") labeled++;
    if (result.status === "failed") failed++;
  }
  return { visited: rows.length, labeled, failed };
}

function runTmux(args: string[]): TmuxLabelCommandResult {
  const tmuxBin = process.env.CLAUDE_PEERS_TMUX_BIN ?? "tmux";
  const socket = process.env.CLAUDE_PEERS_TMUX_SOCKET;
  const command = socket ? [tmuxBin, "-S", socket, ...args] : [tmuxBin, ...args];
  return boundedCommand(command, { operation: "pane-label-tmux", timeoutMs: 3000 });
}

export function main(args = process.argv.slice(2)): number {
  if (args.length===2 && args[0]==="--locked-json" && /^%[0-9]+$/.test(args[1]!)) {
    const result=ensurePaneOperatorLabelUnlocked(args[1]!);
    console.log(JSON.stringify(result));
    return result.status==="failed" ? 1 : 0;
  }
  if (args.length===2 && args[0]==="--print" && /^%[0-9]+$/.test(args[1]!)) {
    const result=ensurePaneOperatorLabel(args[1]!);
    if (result.status==="labeled" || result.status==="preserved") {console.log(result.label);return 0;}
    return 1;
  }
  if (args.length===3 && args[0]==="--claim-seat-name-locked-json" && /^%[0-9]+$/.test(args[1]!)) {
    // Always exit 0: boundedCommand discards stdout on a non-zero exit, and a
    // refusal must reach the caller with its holder intact.
    console.log(JSON.stringify(claimPaneSeatNameUnlocked(args[1]!,args[2]!,runTmux)));
    return 0;
  }
  // Launchers: `--claim-seat-name <pane> <name>` stamps an explicit name (empty
  // releases it). Exit 3 means another pane answers to the name; the holder is
  // printed so the operator can see which seat to rename first.
  if (args.length===3 && args[0]==="--claim-seat-name" && /^%[0-9]+$/.test(args[1]!)) {
    const result=claimPaneSeatName(args[1]!,args[2]!);
    if (result.status==="claimed") {console.log(result.name);return 0;}
    if (result.status==="released") return 0;
    if (result.status==="refused") {console.error(`seat name "${args[2]}" is already held by ${result.holder}`);return 3;}
    console.error(`seat name claim failed pane=${args[1]} reason=${result.reason}`);
    return 1;
  }
  // `--print-seat <pane>`: the name the pane's seat answers to (explicit seat
  // name first, else the auto label). `--print` stays the auto label only.
  if (args.length===2 && args[0]==="--print-seat" && /^%[0-9]+$/.test(args[1]!)) {
    const result=resolvePaneSeatName(args[1]!);
    if (result.status==="labeled" || result.status==="preserved") {console.log(result.label);return 0;}
    return 1;
  }
  if (args.length===2 && args[0]==="--session" && /^\$[0-9]+$/.test(args[1]!)) {
    return labelAllUnlabeledPanes(runTmux,args[1]).failed > 0 ? 1 : 0;
  }
  if (args.length === 1 && args[0] === "--all") {
    const result = labelAllUnlabeledPanes();
    if (result.failed > 0) {
      console.error(`${new Date().toISOString()} tmux pane-label backfill failed for ${result.failed}/${result.visited} pane(s)`);
      return 1;
    }
    return 0;
  }
  const paneId = args.length === 1 ? args[0] : undefined;
  if (!paneId || !/^%[0-9]+$/.test(paneId)) {
    console.error("usage: tmux-label-pane.ts <pane-id>|--all");
    return 2;
  }
  const result = ensurePaneOperatorLabel(paneId);
  if (result.status === "failed") {
    console.error(`${new Date().toISOString()} tmux pane-label failed pane=${paneId} reason=${result.reason}`);
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exitCode = main();
