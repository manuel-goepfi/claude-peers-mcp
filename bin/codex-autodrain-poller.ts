#!/usr/bin/env bun
/**
 * Codex auto-drain poller.
 *
 * Problem: Codex/Gemini peers are `manual-drain` — the broker has no push
 * channel to them, so mail sent to an IDLE Codex lane sits unread in the broker
 * until the lane takes a turn (its UserPromptSubmit/SessionStart/Stop drain hook
 * only fires on a turn boundary). The operator had to manually nudge idle Codex
 * lanes. This watchdog automates that nudge.
 *
 * How it works (verified live 2026-06-15): every POLL_INTERVAL_MS, for each
 * Codex/Gemini peer that (a) has unread mail in the broker DB, (b) has a tmux
 * pane, and (c) is IDLE (its pane shows the prompt, not active work), it
 * `tmux send-keys` a benign nudge into the pane. That fires the lane's
 * UserPromptSubmit drain hook, which pulls the mail from the broker and injects
 * it into the Codex context. The poller NEVER drains the broker itself (that
 * would consume the mail without showing it to Codex) — it only DETECTS (a
 * read-only DB count) and NUDGES. The drain stays owned by the hook.
 *
 * Safety:
 *   - Reads unread count from the SQLite DB read-only (no /poll-by-pid, no drain).
 *   - Only nudges a pane that is IDLE: capture-pane must show the Codex prompt
 *     glyph and NOT a busy marker ("esc to interrupt" / "Working" / "Running").
 *   - Only nudges when the input line is empty (no queued operator text to
 *     accidentally submit).
 *   - Per-pane cooldown so a lane that's slow to drain isn't nudged repeatedly.
 *   - Verifies the pid is alive and the pane still maps to that Codex pid before
 *     sending keys (never types into a pane a different process now owns).
 *
 * Run: bun bin/codex-autodrain-poller.ts   (or as a systemd-user unit)
 * Env: CLAUDE_PEERS_DB (default ~/.claude-peers.db), POLL_INTERVAL_MS (15000),
 *      NUDGE_COOLDOWN_MS (60000), DRY_RUN=1 (log what it WOULD do, send nothing).
 */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";

const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${homedir()}/.claude-peers.db`;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 15_000);
const NUDGE_COOLDOWN_MS = Number(process.env.NUDGE_COOLDOWN_MS ?? 60_000);
const DRY_RUN = process.env.DRY_RUN === "1";
const NUDGE_TEXT = "check your peer inbox and handle any pending messages";

// Busy markers that mean the Codex lane is mid-turn — never nudge then.
const BUSY_MARKERS = [/esc to interrupt/i, /\bWorking\b/, /\bRunning\b/, /Reviewing approval/i, /tokens used/i];
// The Codex idle prompt glyph (start of the input line when waiting).
const PROMPT_GLYPH = /(^|\n)\s*[›>]\s/;

const lastNudge = new Map<string, number>(); // peer id -> epoch ms

function log(msg: string): void {
  console.error(`[codex-autodrain] ${new Date().toISOString()} ${msg}`);
}

function sh(cmd: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync(cmd);
  return { ok: p.exitCode === 0, out: new TextDecoder().decode(p.stdout) };
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) {
    return (e as { code?: string }).code === "EPERM"; // alive under another uid
  }
}

interface CodexLane {
  id: string;
  name: string | null;
  pid: number;
  tmux_pane_id: string;
  unread: number;
}

// Read-only: Codex/Gemini peers with a pane AND unread mail. No drain.
function lanesWithUnread(db: Database): CodexLane[] {
  return db.query(`
    SELECT p.id, p.name, p.pid, p.tmux_pane_id, COUNT(m.id) AS unread
    FROM peers p
    JOIN messages m ON m.to_id = p.id AND m.delivered = 0
    WHERE p.client_type IN ('codex', 'gemini')
      AND p.tmux_pane_id IS NOT NULL AND p.tmux_pane_id != ''
    GROUP BY p.id
    HAVING unread > 0
  `).all() as CodexLane[];
}

// Confirm the pane still belongs to the lane's pid (not a recycled/reused pane).
function paneOwnedByPid(paneId: string, pid: number): boolean {
  const { ok, out } = sh(["tmux", "list-panes", "-a", "-F", "#{pane_id} #{pane_pid}"]);
  if (!ok) return false;
  const line = out.split("\n").find((l) => l.startsWith(`${paneId} `));
  if (!line) return false; // pane gone
  const panePid = Number(line.split(" ")[1]);
  if (!Number.isInteger(panePid)) return false;
  if (panePid === pid) return true;
  // pane_pid is the shell; the codex pid should be a descendant. Walk the pane's
  // process subtree (pstree -p prints all pids) and require the codex pid in it,
  // so we never type into a pane whose original lane exited and was replaced.
  const tree = sh(["pstree", "-p", String(panePid)]);
  return tree.ok && tree.out.includes(`(${pid})`);
}

// Strip SGR escape sequences to a plain-text view.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Pure idle/empty-input decision over a `tmux capture-pane -e` output (ANSI
 * intact). Exported for unit testing without a live tmux. Returns true only when
 * the lane is idle (no busy marker, prompt glyph present) AND the input line is
 * empty OR holds only a DIM (ESC[2m) placeholder — never bright queued text.
 */
export function paneTextIsIdle(captureWithAnsi: string): boolean {
  const plain = stripAnsi(captureWithAnsi);
  if (BUSY_MARKERS.some((re) => re.test(plain))) return false; // mid-turn
  if (!PROMPT_GLYPH.test(plain)) return false;                 // no idle prompt visible

  // Last line whose stripped form starts with the prompt glyph.
  const promptLine = [...captureWithAnsi.split("\n")].reverse()
    .find((l) => /^\s*[›>]/.test(stripAnsi(l))) ?? "";
  if (!promptLine) return false;
  const afterGlyph = promptLine.replace(/^.*?[›>]\s?/, "");   // keep SGR codes
  const afterPlain = stripAnsi(afterGlyph).trim();
  if (afterPlain === "") return true;                          // empty input — nudge
  // Non-empty: a placeholder ONLY if rendered dim (ESC[2m). Bright text = real
  // queued operator input → never nudge (would submit their text).
  return /\x1b\[2m/.test(afterGlyph);
}

function paneIsIdle(paneId: string): boolean {
  // Capture WITH escape sequences (-e) so paneTextIsIdle can read SGR colors.
  const { ok, out } = sh(["tmux", "capture-pane", "-p", "-e", "-t", paneId, "-S", "-15"]);
  if (!ok) return false;
  return paneTextIsIdle(out);
}

function nudge(lane: CodexLane): void {
  const tag = `${lane.name ?? "?"}/${lane.id} pane=${lane.tmux_pane_id}`;
  if (DRY_RUN) { log(`DRY_RUN would nudge ${tag} (${lane.unread} unread)`); return; }
  // Send the prompt text, then submit with C-m (carriage return). The Codex TUI
  // does NOT submit on the `Enter` keyname (it leaves the text queued in the
  // input line); C-m is the reliable submit. Verified live on marketing.1:
  // `Enter` left the nudge unsubmitted, `C-m` submitted + drained all 5 unread.
  sh(["tmux", "send-keys", "-t", lane.tmux_pane_id, NUDGE_TEXT]);
  sh(["tmux", "send-keys", "-t", lane.tmux_pane_id, "C-m"]);
  lastNudge.set(lane.id, Date.now());
  log(`nudged ${tag} (${lane.unread} unread)`);
}

function tick(db: Database): void {
  let lanes: CodexLane[];
  try { lanes = lanesWithUnread(db); } catch (e) {
    log(`DB read failed: ${e instanceof Error ? e.message : String(e)}`); return;
  }
  for (const lane of lanes) {
    if (!isPidAlive(lane.pid)) continue;                       // dead lane — reaper handles it
    const since = Date.now() - (lastNudge.get(lane.id) ?? 0);
    if (since < NUDGE_COOLDOWN_MS) continue;                   // recently nudged — give it time to drain
    if (!paneOwnedByPid(lane.tmux_pane_id, lane.pid)) continue; // pane gone/reused
    if (!paneIsIdle(lane.tmux_pane_id)) continue;              // busy or has queued input — never disturb
    nudge(lane);
  }
}

function main(): void {
  log(`starting: db=${DB_PATH} interval=${POLL_INTERVAL_MS}ms cooldown=${NUDGE_COOLDOWN_MS}ms${DRY_RUN ? " DRY_RUN" : ""}`);
  const db = new Database(DB_PATH, { readonly: true });
  tick(db);
  setInterval(() => tick(db), POLL_INTERVAL_MS);
}

// Run the daemon only when executed directly — importing this module (e.g. from
// a unit test of paneTextIsIdle) must NOT start the poll loop.
if (import.meta.main) main();
