#!/usr/bin/env bun
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

function panePresence(paneId: string, run: TmuxLabelRunner): "present" | "absent" | "unknown" {
  const livePanes = run(["list-panes", "-a", "-F", "#{pane_id}"]);
  if (!livePanes.ok) return "unknown";
  return livePanes.out.split("\n").some((value) => value.trim() === paneId)
    ? "present"
    : "absent";
}

export function ensurePaneOperatorLabel(
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
  if (pane.operatorLabel && preserved) return { status: "preserved", label: preserved };

  let label = preserved;
  if (!label) {
    const siblings = run([
      "list-panes", "-s", "-t", pane.session,
      "-F", "#{pane_id}\t#{@operator_label}\t#{@peer_label}",
    ]);
    if (!siblings.ok) {
      return panePresence(pane.paneId, run) === "absent"
        ? { status: "skipped", reason: "pane-gone" }
        : { status: "failed", reason: "session-list-failed" };
    }
    label = chooseOperatorLabel(
      pane.session,
      pane.paneIndex,
      usedOperatorLabels(siblings.out, pane.paneId),
      pane.windowName,
      pane.windowPanes,
    );
  }

  // Birth-time allocation owns only the human label. Broker identity fields are
  // registration-owned and must never be fabricated for a zero-turn pane.
  const stamped = run(["set-option", "-p", "-t", pane.paneId, "@operator_label", label]);
  if (stamped.ok) return { status: "labeled", label };
  return panePresence(pane.paneId, run) === "absent"
    ? { status: "skipped", reason: "pane-gone" }
    : { status: "failed", reason: "label-write-failed" };
}

export function labelAllUnlabeledPanes(
  run: TmuxLabelRunner = runTmux,
): { visited: number; labeled: number; failed: number } {
  const panes = run(["list-panes", "-a", "-F", "#{pane_id}"]);
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
