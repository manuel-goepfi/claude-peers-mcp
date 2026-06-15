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
import {
  parseTmuxPanes,
  bgSessionIdFromPtyHostArgs,
  resolveBgAttachPane,
  type ProcLike,
} from "../shared/tmux.ts";

// Env parse with validation: a bad value must NOT silently break the daemon.
// Number("") === 0 (a 0ms interval is a spin loop) and Number("abc") === NaN
// (setInterval(NaN) never fires) — both are caught here, falling back to the
// default with a warning rather than a silently-dead or runaway daemon.
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`[codex-autodrain] invalid ${name}="${raw}" — using default ${fallback}ms`);
    return fallback;
  }
  return n;
}

const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${homedir()}/.claude-peers.db`;
const POLL_INTERVAL_MS = envMs("POLL_INTERVAL_MS", 15_000);
const NUDGE_COOLDOWN_MS = envMs("NUDGE_COOLDOWN_MS", 60_000);
const DRY_RUN = process.env.DRY_RUN === "1";
const NUDGE_TEXT = "check your peer inbox and handle any pending messages";
// Give up nudging a lane after this many consecutive attempts with mail still
// unread — a lane whose drain hook is broken must NOT be keystroke-bombed
// forever. The counter resets to 0 the moment the lane has no unread mail.
const MAX_NUDGE_ATTEMPTS = Number(process.env.MAX_NUDGE_ATTEMPTS ?? 5);

// Per-client idle profile. A lane is only nudged when its profile says the pane
// is at an empty/placeholder input prompt and shows no busy marker. The two TUIs
// render differently, so the prompt glyph and the busy vocabulary differ:
//   - Codex / Gemini: prompt glyph U+203A (›); busy = "esc to interrupt", etc.
//   - Claude: prompt glyph U+276F (❯); busy = its own spinner verbs + the
//     "· N tokens" status row Claude prints while a turn is in flight.
// ASCII '>' is never a glyph here — it also matches output lines (markdown
// blockquotes, diff context, heredoc continuations) and would mis-select a
// non-input line as the prompt.
export interface IdleProfile {
  prompt: RegExp;        // matches the line-leading input prompt glyph
  promptLine: RegExp;    // matches a single captured line that IS the prompt line
  strip: RegExp;         // strips up to & incl the glyph (+1 optional space); keeps SGR
  busy: RegExp[];        // any match => mid-turn => never nudge
}
const CODEX_BUSY = [/esc to interrupt/i, /\bWorking\b/, /\bRunning\b/, /Reviewing approval/i, /tokens used/i];
// Claude busy markers: the animated spinner verbs Claude cycles through mid-turn
// ("Cogitated", "Warping", "Evaporating", … — the set is open, so match the
// shared shape: a spinner verb immediately followed by the "(Ns ·" timer), the
// universal "esc to interrupt" hint, and the "· N tokens" in-flight status row.
const CLAUDE_BUSY = [/esc to interrupt/i, /\(\d+s\s*·/, /·\s*[\d.]+k?\s*tokens/i, /\b(Esc to interrupt|Running…|Working…)/i];
const PROFILES: Record<string, IdleProfile> = {
  codex:  { prompt: /(^|\n)\s*›\s/, promptLine: /^\s*›/, strip: /^.*?›\s?/, busy: CODEX_BUSY },
  gemini: { prompt: /(^|\n)\s*›\s/, promptLine: /^\s*›/, strip: /^.*?›\s?/, busy: CODEX_BUSY },
  claude: { prompt: /(^|\n)\s*❯\s/, promptLine: /^\s*❯/, strip: /^.*?❯\s?/, busy: CLAUDE_BUSY },
};
export function profileFor(clientType: string): IdleProfile {
  return PROFILES[clientType] ?? PROFILES.codex!;
}

const lastNudge = new Map<string, number>();  // peer id -> epoch ms of last nudge
const nudgeAttempts = new Map<string, number>(); // peer id -> consecutive nudge count

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

interface Lane {
  id: string;
  name: string | null;
  pid: number;
  client_type: string;
  tmux_pane_id: string | null;  // empty/null for a bg-claude lane → resolved lazily
  unread: number;
}

// Read-only: every nudgeable peer (codex, gemini, AND claude) with unread mail.
// No drain — detect only. A claude bg-spare lane registers with an EMPTY
// tmux_pane_id (its pane only exists once `claude attach <id>` runs, AFTER the
// MCP server's one-shot detectTmuxPane()), so we must NOT gate on a non-empty
// pane here — the pane is resolved lazily at nudge time instead (resolveLanePane),
// when the attach client is guaranteed to exist. Codex/gemini lanes register WITH
// a pane, so for them the lazy step is a no-op passthrough.
const NUDGEABLE_CLIENTS = ["codex", "gemini", "claude"];
function lanesWithUnread(db: Database): Lane[] {
  const placeholders = NUDGEABLE_CLIENTS.map(() => "?").join(", ");
  return db.query(`
    SELECT p.id, p.name, p.pid, p.client_type, p.tmux_pane_id, COUNT(m.id) AS unread
    FROM peers p
    JOIN messages m ON m.to_id = p.id AND m.delivered = 0
    WHERE p.client_type IN (${placeholders})
    GROUP BY p.id
    HAVING unread > 0
  `).all(...NUDGEABLE_CLIENTS) as Lane[];
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
export function paneTextIsIdle(captureWithAnsi: string, profile: IdleProfile = PROFILES.codex!): boolean {
  const plain = stripAnsi(captureWithAnsi);
  if (profile.busy.some((re) => re.test(plain))) return false; // mid-turn
  if (!profile.prompt.test(plain)) return false;               // no idle prompt visible

  // Last line whose stripped form starts with this client's prompt glyph.
  const promptLine = [...captureWithAnsi.split("\n")].reverse()
    .find((l) => profile.promptLine.test(stripAnsi(l))) ?? "";
  if (!promptLine) return false;
  // Strip everything up to and including the client's glyph (and one optional
  // space), keeping SGR codes after it so the dim/bright check below is exact.
  const afterGlyph = promptLine.replace(profile.strip, "");  // keep SGR codes
  const afterPlain = stripAnsi(afterGlyph).trim();
  if (afterPlain === "") return true;                          // empty input — nudge
  // Non-empty: it is a placeholder (safe to nudge) ONLY if the ENTIRE visible
  // text is rendered dim. Merely CONTAINING a dim span is not enough — real
  // bright operator input with a dim ghost-autocomplete suffix or a dim inline
  // @mention (e.g. "deploy to prod\x1b[2muction\x1b[0m") would otherwise be
  // misread as empty and the nudge would SUBMIT the operator's text. We verify
  // dimness by reconstructing only the text that is under an active dim (ESC[2m)
  // SGR state and checking it covers the whole non-space input.
  return everyVisibleCharIsDim(afterGlyph);
}

/**
 * True iff every non-space visible character in an SGR-bearing string is
 * rendered under an active dim (ESC[2m) state. Returns false if any visible
 * char is bright (no dim active) — i.e. there is real, non-placeholder input.
 * Dim is turned on by ESC[2m and cleared by ESC[0m or ESC[22m (and a fresh
 * ESC[<other>m without 2 does not clear dim, per SGR semantics).
 */
export function everyVisibleCharIsDim(s: string): boolean {
  let dim = false;
  let sawVisible = false;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b" && s[i + 1] === "[") {
      const m = /^\x1b\[([0-9;]*)m/.exec(s.slice(i));
      if (m) {
        const codes = m[1]!.split(";").filter((c) => c !== "");
        for (const c of codes.length ? codes : ["0"]) {
          if (c === "2") dim = true;
          else if (c === "0" || c === "22") dim = false;
        }
        i += m[0].length;
        continue;
      }
    }
    const ch = s[i]!;
    if (ch.trim() !== "") {           // a visible, non-space char
      sawVisible = true;
      if (!dim) return false;          // a bright visible char => real input
    }
    i++;
  }
  return sawVisible;                    // all visible chars were dim (placeholder)
}

function paneIsIdle(paneId: string, profile: IdleProfile): boolean {
  // Capture WITH escape sequences (-e) so paneTextIsIdle can read SGR colors.
  const { ok, out } = sh(["tmux", "capture-pane", "-p", "-e", "-t", paneId, "-S", "-15"]);
  if (!ok) return false;
  return paneTextIsIdle(out, profile);
}

// One process snapshot per tick, shared across every lane's resolution + ownership
// check. A `ps -ww` is ~0.5s on a loaded host; doing it per-lane made a 12-lane
// fan-out tick ~12s (83% of the poll window). Snapshotting once drops the whole
// tick's resolution cost to a single ps regardless of lane count. Built fresh each
// tick (cheap relative to the interval) so it never goes stale within a tick.
interface TickSnapshot {
  procs: ProcLike[];
  paneByPid: Map<number, string>;          // pane_pid → pane_id
  paneMap: ReturnType<typeof parseTmuxPanes>;
}
function takeSnapshot(): TickSnapshot | null {
  const psOut = sh(["ps", "-eo", "pid=,ppid=,args="]);
  const paneOut = sh(["tmux", "list-panes", "-a", "-F", "#{pane_pid}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_id}"]);
  if (!psOut.ok || !paneOut.ok) return null;
  const procs: ProcLike[] = [];
  for (const line of psOut.out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3]! });
  }
  const paneMap = parseTmuxPanes(paneOut.out);
  const paneByPid = new Map<number, string>();
  for (const [panePid, info] of paneMap) if (info.pane_id) paneByPid.set(panePid, info.pane_id);
  return { procs, paneByPid, paneMap };
}

// Memoized lane-id → pane-id. A bg-claude lane's session→pane mapping is stable
// for the life of the attach (changes only on re-attach), so we resolve it once
// and reuse. The cache self-invalidates: paneOwnedByPid() runs before every nudge
// and a stale entry fails that check, dropping the lane back to re-resolution.
const paneCache = new Map<string, string>();   // peer id → pane id

// Resolve a lane's pane. Codex/gemini register WITH a pane → return it directly.
// A claude bg lane registers with an empty pane → resolve lazily: find its bg
// session id from the MCP-server process ancestry, then locate the tmux pane
// whose subtree runs `claude attach <id>` (resolveBgAttachPane). Returns "" when
// a bg lane has no live attach client (truly detached → unreachable by design).
function resolveLanePane(lane: Lane, snap: TickSnapshot): string {
  if (lane.tmux_pane_id) return lane.tmux_pane_id;       // already has a pane (codex/gemini/attached)
  const cached = paneCache.get(lane.id);
  if (cached) return cached;
  // The lane's pid is its MCP server (bun server.ts). Walk its ancestry in the
  // shared snapshot for the bg-pty-host id, then resolve the attach-client pane.
  const ppidMap = new Map<number, number>();
  for (const p of snap.procs) ppidMap.set(p.pid, p.ppid);
  let bgId: string | null = null;
  let walk: number | undefined = lane.pid;
  for (let i = 0; i < 20 && walk !== undefined; i++) {
    const info = snap.procs.find((p) => p.pid === walk);
    if (info) { bgId = bgSessionIdFromPtyHostArgs(info.args); if (bgId) break; }
    const parent = ppidMap.get(walk);
    if (parent === undefined || parent <= 1 || parent === walk) break;
    walk = parent;
  }
  if (!bgId) return "";
  const pane = resolveBgAttachPane(bgId, snap.paneMap, snap.procs);
  if (pane?.pane_id) { paneCache.set(lane.id, pane.pane_id); return pane.pane_id; }
  return "";   // bg session not attached anywhere → no pane to nudge
}

function nudge(lane: Lane, paneId: string): void {
  const tag = `${lane.name ?? "?"}/${lane.id} pane=${paneId}`;
  if (DRY_RUN) { log(`DRY_RUN would nudge ${tag} (${lane.unread} unread)`); return; }
  // Type the literal prompt text then submit, with a short settle BETWEEN the
  // two so the Codex TUI commits the typed input before the Enter arrives — a
  // C-m that races ahead of the not-yet-committed text is dropped (verified
  // live). `-l` sends NUDGE_TEXT literally (no key-name interpretation); the
  // settle is the reliability fix; C-m is the submit (the Codex TUI ignores the
  // "Enter" key-name but submits on C-m). We do NOT re-capture to "verify"
  // submission: after submit the TUI echoes the prompt into its transcript, so a
  // capture can't distinguish "still in input" from "submitted + shown in
  // scrollback" — and a stuck row is already bounded by MAX_NUDGE_ATTEMPTS.
  const sent = sh(["tmux", "send-keys", "-l", "-t", paneId, NUDGE_TEXT]);
  if (!sent.ok) { log(`nudge send-keys failed for ${tag} — pane gone? skipping`); return; }
  Bun.spawnSync(["sleep", "0.3"]); // let the TUI commit the typed text before Enter
  sh(["tmux", "send-keys", "-t", paneId, "C-m"]);
  lastNudge.set(lane.id, Date.now());
  nudgeAttempts.set(lane.id, (nudgeAttempts.get(lane.id) ?? 0) + 1);
  log(`nudged ${tag} (${lane.unread} unread, attempt ${nudgeAttempts.get(lane.id)})`);
}

// A tick whose wall-time crosses this fraction of the poll interval is logged as
// a canary: with the per-tick ps snapshot cached, fan-out is bounded mostly by
// the serial 0.3s nudge floor, which stays well under the window until ~30+
// simultaneous idle lanes. If this warns, lane width has grown past the design
// envelope and the nudge loop should be made concurrent (see decision-log).
const TICK_WARN_MS = Math.min(10_000, POLL_INTERVAL_MS * 0.66);

function tick(db: Database): void {
  const tickStart = Date.now();
  let lanes: Lane[];
  try { lanes = lanesWithUnread(db); } catch (e) {
    log(`DB read failed: ${e instanceof Error ? e.message : String(e)}`); return;
  }
  // Prune per-lane state for lanes that no longer have unread mail: reset their
  // attempt counter (so a future stuck episode starts fresh) AND bound all maps
  // to current lanes so they cannot grow unbounded over a multi-day run.
  const active = new Set(lanes.map((l) => l.id));
  for (const id of nudgeAttempts.keys()) if (!active.has(id)) nudgeAttempts.delete(id);
  for (const id of lastNudge.keys()) if (!active.has(id)) lastNudge.delete(id);
  for (const id of paneCache.keys()) if (!active.has(id)) paneCache.delete(id);

  if (lanes.length === 0) return;

  // ONE process+pane snapshot for the whole tick — shared across every lane's
  // pane resolution and ownership check (see takeSnapshot). Without this the
  // per-lane `ps -ww` made a 12-lane tick ~12s; with it the tick's resolution
  // cost is a single ps regardless of lane count.
  const snap = takeSnapshot();
  if (!snap) { log("tick: snapshot (ps/tmux) failed — skipping this tick"); return; }

  for (const lane of lanes) {
    // Per-lane crash isolation: a throw from any check (e.g. pstree missing,
    // tmux gone) must NOT escape the setInterval callback and kill the daemon.
    // Log it and move to the next lane.
    try {
      if (!isPidAlive(lane.pid)) continue;                       // dead lane — reaper handles it
      if ((nudgeAttempts.get(lane.id) ?? 0) >= MAX_NUDGE_ATTEMPTS) {
        // Drain hook likely broken — stop hammering. One warning, then silent
        // until the lane's unread clears (which resets the counter via the prune
        // above) or it drops out of the lane set.
        if ((nudgeAttempts.get(lane.id) ?? 0) === MAX_NUDGE_ATTEMPTS) {
          log(`giving up on ${lane.name ?? lane.id}: ${MAX_NUDGE_ATTEMPTS} nudges, still ${lane.unread} unread (drain hook stuck?)`);
          nudgeAttempts.set(lane.id, MAX_NUDGE_ATTEMPTS + 1); // mark "warned", stop re-logging
        }
        continue;
      }
      const since = Date.now() - (lastNudge.get(lane.id) ?? 0);
      if (since < NUDGE_COOLDOWN_MS) continue;                   // recently nudged — give it time to drain
      const paneId = resolveLanePane(lane, snap);
      if (!paneId) continue;                                     // bg lane not attached anywhere → unreachable, skip
      if (!paneOwnedByPid(paneId, lane.pid)) { paneCache.delete(lane.id); continue; } // pane gone/reused → drop cache
      if (!paneIsIdle(paneId, profileFor(lane.client_type))) continue; // busy or has queued input — never disturb
      nudge(lane, paneId);
    } catch (e) {
      log(`tick: error handling lane ${lane.name ?? lane.id} — ${e instanceof Error ? e.message : String(e)} (continuing)`);
    }
  }

  const elapsed = Date.now() - tickStart;
  if (elapsed > TICK_WARN_MS) {
    log(`SLOW TICK: ${elapsed}ms over ${lanes.length} lane(s) (warn>${TICK_WARN_MS}ms, interval=${POLL_INTERVAL_MS}ms) — lane width may exceed design envelope`);
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
