#!/usr/bin/env bun
import { boundedCommand } from "../shared/bounded-command.ts";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  chooseOperatorLabel,
  cleanTmuxOptionValue,
  isOperatorChosenWindowName,
  preservedTmuxOperatorLabel,
  stripResolvedNameSuffix,
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

/**
 * `label` is what the border shows. `name` is set only when the seat's routing
 * name differs from it: a hand-set `broker.29` in session `infra` is shown as
 * is, but a seat with no explicit name keeps answering to `infra.29`, so a
 * border repaired by hand never renames a seat. Use `name ?? label` for names.
 */
export type PaneLabelResult =
  | { status: "preserved" | "labeled"; label: string; name?: string }
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
  seatName: string | null;
  autoLabel: string | null;
}

/**
 * The allocator records every label it writes here. A pane whose
 * @operator_label differs from this value was labelled by a person (or by
 * rename-lane), and that label is never rewritten: the top border must show the
 * name the operator chose, not one the allocator derived.
 */
export const AUTO_LABEL_OPTION = "@operator_label_auto";

const SNAPSHOT_FORMAT = [
  "#{pane_id}",
  "#{session_name}",
  "#{pane_index}",
  "#{window_name}",
  "#{window_panes}",
  "#{@operator_label}",
  "#{@peer_label}",
  `#{${SEAT_NAME_OPTION}}`,
  `#{${AUTO_LABEL_OPTION}}`,
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
    seatName: cleanSeatName(fields[7]),
    autoLabel: cleanTmuxOptionValue(fields[8]),
  };
}

/**
 * Was the pane's current label written by a person rather than the allocator?
 * With a recorded auto label the answer is exact. Panes labelled before the
 * record existed fall back to shape. The allocator replaced every non-ordinal
 * label, so a real name still present was set by hand. An ordinal with another
 * prefix is usually the pane's label from before a session rename and follows
 * the session, unless it is the pane's window name: copying the window name
 * onto the border is how operators repaired labels by hand.
 */
function hasHumanLabel(pane: PaneSnapshot): boolean {
  const label = pane.operatorLabel;
  if (!label) return false;
  if (pane.autoLabel) return label !== pane.autoLabel;
  const ordinal = preservedTmuxOperatorLabel(label, null, pane.session);
  // Machine fallbacks (`infra.%24`, a bare command name) are not names anyone
  // chose; the allocator still repairs them.
  if (ordinal === null) return isOperatorChosenWindowName(label, pane.session);
  return label === pane.windowName && ordinal !== stripResolvedNameSuffix(label);
}

/**
 * The label this pane should show. A hand-set label stays. Otherwise the
 * seat's explicit name, and only without one, the session ordinal.
 *
 * The window name is deliberately not a tier: this label is also the peer name
 * of a seat with no explicit name, so deriving it from window names would
 * re-register lanes under their launcher's window name instead of the
 * `<session>.<n>` address the fleet routes by.
 */
function decidePaneLabel(pane: PaneSnapshot, siblings: string): { label: string; keep: boolean; name?: string; record?: string } {
  if (hasHumanLabel(pane)) {
    const label = pane.operatorLabel!;
    // A hand-set border is display only; the seat keeps a routing ordinal. An
    // ordinal-shaped label maps onto the session as before. Any other label
    // routes by the pane's own ordinal, kept in the record (which already
    // differs from the border, so the border stays hand-set).
    const name = preservedTmuxOperatorLabel(label, null, pane.session);
    if (name) return name !== label ? { label, keep: true, name } : { label, keep: true };
    const recorded = pane.autoLabel && preservedTmuxOperatorLabel(pane.autoLabel, null, pane.session) === pane.autoLabel
      ? pane.autoLabel : null;
    if (recorded) return { label, keep: true, name: recorded };
    const ordinal = chooseOperatorLabel(pane.session, pane.paneIndex, usedOperatorLabels(siblings, pane.paneId),
      pane.windowName, pane.windowPanes);
    return { label, keep: false, name: ordinal, record: ordinal };
  }
  if (pane.seatName) return { label: pane.seatName, keep: pane.operatorLabel === pane.seatName };
  const preserved = preservedTmuxOperatorLabel(pane.operatorLabel, pane.peerLabel, pane.session);
  const owned = preserved !== null && ownsPreservedLabel(pane, preserved, siblings);
  if (owned) return { label: preserved, keep: pane.operatorLabel === preserved };
  return {
    label: chooseOperatorLabel(pane.session, pane.paneIndex, usedOperatorLabels(siblings, pane.paneId),
      pane.windowName, pane.windowPanes),
    keep: false,
  };
}

function usedOperatorLabels(raw: string, currentPaneId: string): string[] {
  const labels: string[] = [];
  for (const line of raw.split("\n")) {
    const [paneId, operatorLabel, peerLabel, seatName, autoLabel] = line.split("\t");
    if (!paneId || paneId === currentPaneId) continue;
    const label = cleanTmuxOptionValue(operatorLabel) ?? cleanTmuxOptionValue(peerLabel);
    if (label) labels.push(label);
    // Under a typed non-ordinal border the record is the pane's routing
    // ordinal (an ordinal border routes by its own number instead).
    const record = cleanTmuxOptionValue(autoLabel);
    const border = cleanTmuxOptionValue(operatorLabel);
    if (record && border && border !== record && preservedTmuxOperatorLabel(border, null, "") === null) labels.push(record);
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
  return run(["list-panes","-s","-t",pane.session,"-F",`#{pane_id}\t#{@operator_label}\t#{@peer_label}\t#{${SEAT_NAME_OPTION}}\t#{${AUTO_LABEL_OPTION}}`]);
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

  const siblings=siblingLabels(pane,run);
  if (!siblings.ok) {
    return panePresence(pane.paneId,run)==="absent"
      ? {status:"skipped",reason:"pane-gone"}
      : {status:"failed",reason:"session-list-failed"};
  }
  const {label,keep,name,record}=decidePaneLabel(pane,siblings.out);
  if (keep) return name ? {status:"preserved",label,name} : {status:"preserved",label};
  if (record) {
    // Allocate a routing ordinal under a hand-set border without touching it.
    return run(["set-option", "-p", "-t", pane.paneId, AUTO_LABEL_OPTION, record]).ok
      ? { status: "preserved", label, name: record }
      : { status: "failed", reason: "routing-ordinal-write-failed" };
  }

  // Birth-time allocation owns only the human label. Broker identity fields are
  // registration-owned and must never be fabricated for a zero-turn pane.
  // The label goes first: if the record write then fails, the new label reads
  // as hand-set and stays, which is safe; the reverse order would make the old
  // label read as hand-set and pin it.
  const stamped = run(["set-option", "-p", "-t", pane.paneId, "@operator_label", label]);
  if (stamped.ok) {
    run(["set-option", "-p", "-t", pane.paneId, AUTO_LABEL_OPTION, label]);
    return { status: "labeled", label };
  }
  return panePresence(pane.paneId, run) === "absent"
    ? { status: "skipped", reason: "pane-gone" }
    : { status: "failed", reason: "label-write-failed" };
}

export function ensurePaneOperatorLabel(paneId: string, run: TmuxLabelRunner = runTmux, lockSocket?: string): PaneLabelResult {
  if (run !== runTmux && !lockSocket) return ensurePaneOperatorLabelUnlocked(paneId,run);
  const snapshot = run(["display-message","-p","-t",paneId,SNAPSHOT_FORMAT]);
  const pane = snapshot.ok ? parseSnapshot(snapshot.out) : null;
  // Read-only fast path: a pane already showing the label it should show needs
  // no lock. Any write re-decides from a fresh snapshot under the lock.
  if (pane?.paneId === paneId && pane.operatorLabel) {
    const siblings=siblingLabels(pane,run);
    if (siblings.ok) {
      const {label,keep,name}=decidePaneLabel(pane,siblings.out);
      if (keep) return name ? {status:"preserved",label,name} : {status:"preserved",label};
    }
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
  | { status: "claimed"; name: string; label?: PaneLabelResult }
  | { status: "released"; label?: PaneLabelResult }
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
  const result = ensurePaneOperatorLabel(paneId, run, lockSocket);
  return (result.status === "preserved" || result.status === "labeled") && result.name
    ? { status: result.status, label: result.name } : result;
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
  const previous = name === "" ? readPaneSeatName(paneId, run) : null;
  const result = claimPaneSeatNameLocked(paneId, name, run, lockSocket);
  // The top border follows the claim: a new seat name replaces an allocator
  // label, a release returns the pane to an ordinal. A hand-set label is kept
  // (the allocator decides that, under its own lock).
  if (result.status === "claimed") return { ...result, label: ensurePaneOperatorLabel(paneId, run, lockSocket) };
  if (result.status === "released") {
    if (previous) dropReleasedSeatLabel(paneId, previous, run);
    return { ...result, label: ensurePaneOperatorLabel(paneId, run, lockSocket) };
  }
  return result;
}

/**
 * A released seat name that the allocator put on the border would otherwise
 * survive as an ordinal (`C5 Orch.294` has the ordinal shape) and keep the
 * pane answering to the name it just gave up. Clear it so the allocator
 * chooses again. A hand-set label is left alone.
 */
function dropReleasedSeatLabel(paneId: string, released: string, run: TmuxLabelRunner): void {
  const snapshot = run(["display-message", "-p", "-t", paneId, SNAPSHOT_FORMAT]);
  const pane = snapshot.ok ? parseSnapshot(snapshot.out) : null;
  if (!pane || pane.paneId !== paneId || pane.operatorLabel !== released || hasHumanLabel(pane)) return;
  run(["set-option", "-p", "-t", paneId, "-u", "@operator_label"]);
  run(["set-option", "-p", "-t", paneId, "-u", AUTO_LABEL_OPTION]);
  // The registration mirror would promote the old name straight back; the
  // seat's next identity publish restamps it from the new label.
  if (pane.peerLabel && stripResolvedNameSuffix(pane.peerLabel) === released) {
    run(["set-option", "-p", "-t", paneId, "-u", "@peer_label"]);
  }
}

function claimPaneSeatNameLocked(paneId: string, name: string, run: TmuxLabelRunner, lockSocket?: string): SeatNameClaimResult {
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
    // A hand-set label, or one already showing the seat name, is final.
    if (pane?.operatorLabel && (hasHumanLabel(pane) || pane.operatorLabel === pane.seatName)) continue;
    const label = pane && preservedTmuxOperatorLabel(pane.operatorLabel, pane.peerLabel, pane.session);
    // A canonical ordinal is final only for a seat with no explicit name: a
    // named seat's border must move to its name even when its counter is unique.
    if (pane && !pane.seatName && label === pane.operatorLabel && label && claims.get(claimKey(pane, label)) === 1) continue;
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
