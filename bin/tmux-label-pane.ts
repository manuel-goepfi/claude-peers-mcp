#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  chooseOperatorLabel,
  cleanTmuxOptionValue,
  preservedTmuxOperatorLabel,
} from "../shared/operator-label.ts";

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
    const [paneId, operatorLabel, peerLabel] = line.split("\t");
    if (!paneId || paneId === currentPaneId) continue;
    const label = cleanTmuxOptionValue(operatorLabel) ?? cleanTmuxOptionValue(peerLabel);
    if (label) labels.push(label);
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
  return run(["list-panes","-s","-t",pane.session,"-F","#{pane_id}\t#{@operator_label}\t#{@peer_label}"]);
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
  if (!identity.ok || identity.out.trim().split("\t").length !== 3) return {status:"failed",reason:"lock-identity-unavailable"};
  const directory=join(tmpdir(),`claude-peers-pane-labels-${process.getuid?.() ?? "user"}`);
  mkdirSync(directory,{recursive:true,mode:0o700});
  const lock=join(directory,createHash("sha256").update(identity.out.trim()).digest("hex")+".lock");
  // Every writer shares a socket/server/session lock. A timeout fails closed;
  // an unlocked fallback would allow two simultaneously opened panes to claim N.
  const result=Bun.spawnSync(["flock","-w","5",lock,process.execPath,new URL(import.meta.url).pathname,"--locked-json",paneId],
    {stdout:"pipe",stderr:"ignore",timeout:8000,
      env:lockSocket ? {...process.env,CLAUDE_PEERS_TMUX_SOCKET:lockSocket} : process.env});
  if (result.exitCode!==0) return {status:"failed",reason:"label-lock-or-write-failed"};
  try {return JSON.parse(new TextDecoder().decode(result.stdout)) as PaneLabelResult;}
  catch {return {status:"failed",reason:"invalid-label-result"};}
}

export function labelAllUnlabeledPanes(
  run: TmuxLabelRunner = runTmux,
  sessionId?: string,
): { visited: number; labeled: number; failed: number } {
  const panes = run(["list-panes", ...(sessionId ? ["-s","-t",sessionId] : ["-a"]), "-F", "#{pane_id}"]);
  if (!panes.ok) return { visited: 0, labeled: 0, failed: 1 };
  const paneIds = panes.out.split("\n").map((value) => value.trim()).filter(Boolean);
  let labeled = 0;
  let failed = 0;
  for (const paneId of paneIds) {
    const result = ensurePaneOperatorLabel(paneId, run);
    if (result.status === "labeled") labeled++;
    if (result.status === "failed") failed++;
  }
  return { visited: paneIds.length, labeled, failed };
}

function runTmux(args: string[]): TmuxLabelCommandResult {
  const tmuxBin = process.env.CLAUDE_PEERS_TMUX_BIN ?? "tmux";
  const socket = process.env.CLAUDE_PEERS_TMUX_SOCKET;
  const command = socket ? [tmuxBin, "-S", socket, ...args] : [tmuxBin, ...args];
  try {
    const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "ignore" });
    return { ok: result.exitCode === 0, out: new TextDecoder().decode(result.stdout) };
  } catch {
    return { ok: false, out: "" };
  }
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
  if (args.length===2 && args[0]==="--session" && /^\$[0-9]+$/.test(args[1]!)) {
    return labelAllUnlabeledPanes(runTmux,args[1]).failed > 0 ? 1 : 0;
  }
  if (args.length === 1 && args[0] === "--all") {
    const result = labelAllUnlabeledPanes();
    if (result.failed > 0) {
      console.error(`tmux pane-label backfill failed for ${result.failed}/${result.visited} pane(s)`);
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
    console.error(`tmux pane-label failed pane=${paneId} reason=${result.reason}`);
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exitCode = main();
