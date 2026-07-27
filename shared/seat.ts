// Durable seat identity.
//
// A "seat" is the operator-visible place an agent lives: a tmux pane, or a
// terminal. Processes come and go there — a Claude session registers TWICE
// (the MCP server registers its own pid, the SessionStart hook registers the
// TUI pid), an MCP server is killed at compact/resume and never respawns, a
// Cursor host cycles its servers on its own schedule. Keying peer identity on
// a pid therefore mints a fresh row per process, and one pane accumulates
// several rows that all answer to the same name. Mail parks on whichever row
// the resolver picked; the seat drains a different one; the poller counts the
// undrained row forever and nudges a pane that has nothing to show. Every
// ghost-mail and duplicate-roster incident traces back to that.
//
// So identity is anchored on the seat and processes are an attribute of it:
// one seat = one row = one id, holding the set of pids known to serve it. The
// seat is alive while ANY of those pids is alive.

/** Fields any registration or stored row exposes for seat derivation. */
export interface SeatLocation {
  tmux_session?: string | null;
  tmux_pane_id?: string | null;
  tty?: string | null;
}

function present(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * The durable seat key for a location, or null when the location has no
 * durable anchor (a headless/background lane with neither pane nor tty).
 *
 * Null is deliberate and load-bearing: it means "do not merge". Background
 * lanes are anonymous — two of them in the same cwd are genuinely different
 * seats, and collapsing them would cross-deliver their mail. They keep the
 * per-process identity they have always had.
 *
 * Format matches activePeerKey()'s pane:/tty: prefixes, which are already a
 * public selector contract (`send_to_peer {seat_key}`) — do not change them
 * without changing that contract.
 */
export function durableSeatKey(location: SeatLocation): string | null {
  if (present(location.tmux_session) && present(location.tmux_pane_id)) {
    return `pane:${location.tmux_session}:${location.tmux_pane_id}`;
  }
  if (present(location.tty)) return `tty:${location.tty}`;
  return null;
}

/** Upper bound on retained pids per seat. Generous; seats see a handful. */
export const MAX_SEAT_PIDS = 8;

/**
 * Parse the stored seat_pids JSON. Tolerates every legacy/corrupt shape —
 * NULL (pre-migration rows), malformed JSON, non-arrays, non-integer members —
 * by returning what is usable. A seat's pid list is diagnostic state, never a
 * reason to fail a registration or drop a row.
 */
export function parseSeatPids(raw: string | null | undefined): number[] {
  if (!present(raw)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: number[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry <= 0) continue;
    if (!out.includes(entry)) out.push(entry);
  }
  return out.slice(0, MAX_SEAT_PIDS);
}

export function serializeSeatPids(pids: number[]): string {
  return JSON.stringify(pids.slice(0, MAX_SEAT_PIDS));
}

/**
 * Fold a newly-registering pid into a seat's pid set.
 *
 * The registrant goes first (it is the freshest evidence of who serves this
 * seat), followed by previously-known pids that are still alive. Dead pids are
 * dropped: retaining them would keep a seat "alive" forever on the ghost of a
 * process that exited, which is the failure mode this whole module exists to
 * end.
 */
export function mergeSeatPids(
  existing: number[],
  registrantPid: number,
  isPidAlive: (pid: number) => boolean,
): number[] {
  const merged = [registrantPid];
  for (const pid of existing) {
    if (merged.length >= MAX_SEAT_PIDS) break;
    if (pid === registrantPid || merged.includes(pid)) continue;
    if (!isPidAlive(pid)) continue;
    merged.push(pid);
  }
  return merged;
}

/**
 * Is this seat alive? True when any pid serving it is alive.
 *
 * Falls back to the row's own `pid` when the seat has no recorded pid set, so
 * rows written before the seat migration behave exactly as they did before.
 */
export function seatPidsAlive(
  seatPids: number[],
  fallbackPid: number,
  isPidAlive: (pid: number) => boolean,
): boolean {
  if (seatPids.length === 0) return isPidAlive(fallbackPid);
  return seatPids.some(isPidAlive);
}

/**
 * SQL that backfills seat_key for rows written before this column existed.
 * Mirrors durableSeatKey() exactly; keep the two in step.
 */
export function seatKeyBackfillSql(): string {
  return `
    UPDATE peers SET seat_key = CASE
      WHEN tmux_session IS NOT NULL AND tmux_session <> ''
        AND tmux_pane_id IS NOT NULL AND tmux_pane_id <> ''
        THEN 'pane:' || tmux_session || ':' || tmux_pane_id
      WHEN tty IS NOT NULL AND tty <> '' THEN 'tty:' || tty
      ELSE NULL
    END
    WHERE seat_key IS NULL
  `;
}
