import type { Database } from "bun:sqlite";

/**
 * Per-thread control record for Codex lanes that run as threads inside a SHARED
 * Codex app-server (bin/codex-shared-seat + bin/codex-appserver-relay.ts).
 *
 * Closing a lane's tmux pane ends the TUI and its relay, but not the thread on
 * the shared app-server. A loaded thread can keep running headless, and its
 * Stop/PostToolUse hooks can still claim queued peer mail by thread id and turn
 * it into more work (2026-10-06: a closed lane committed and pushed while its
 * replacement ran in the same tree). This table records, per thread:
 *
 *   - which pane drove it and which app-server socket hosts it (written by the
 *     relay's /bind-codex-pane-thread publication), so `codex-thread-stop` can
 *     address exactly that thread on exactly that server; and
 *   - a delivery gate. `pane-closed` is set by the relay when it shuts down and
 *     is cleared only by a later proven relay bind of the same thread (an
 *     explicit resume in a live pane). `stopped` is set by codex-thread-stop and
 *     is never cleared by the broker: a stopped thread cannot re-register,
 *     re-bind, claim, or poll mail.
 *
 * Queued mail is never moved or acknowledged by a gate. It stays queued under
 * the gated peer ids (non_targetable, so no new mail can be addressed to them)
 * until the ordinary dead-seat retention reaps it.
 */
export type CodexThreadGate = "pane-closed" | "stopped";

export interface CodexThreadControlRow {
  thread_id: string;
  tmux_pane_id: string | null;
  app_server_socket: string | null;
  bound_at: string | null;
  superseded_at: string | null;
  gate: CodexThreadGate | null;
  gated_at: string | null;
  gated_peer_ids: string;
}

export const CODEX_THREAD_CONTROL_RETENTION_MS = 30 * 86_400_000;

export function ensureCodexThreadControlTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS codex_thread_controls (
      thread_id TEXT PRIMARY KEY,
      tmux_pane_id TEXT,
      app_server_socket TEXT,
      bound_at TEXT,
      superseded_at TEXT,
      gate TEXT CHECK (gate IS NULL OR gate IN ('pane-closed', 'stopped')),
      gated_at TEXT,
      gated_peer_ids TEXT NOT NULL DEFAULT '[]'
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_codex_thread_controls_pane ON codex_thread_controls(tmux_pane_id)");
}

export function validAppServerSocket(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length <= 512
    && !/[\x00-\x1f\x7f]/.test(value);
}

function parsedIds(raw: string | null | undefined): string[] {
  try {
    const value = JSON.parse(raw ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function codexThreadControl(db: Database, threadId: string): CodexThreadControlRow | null {
  return db.query("SELECT * FROM codex_thread_controls WHERE thread_id = ?")
    .get(threadId.toLowerCase()) as CodexThreadControlRow | null;
}

export function codexThreadGate(db: Database, threadId: string): CodexThreadGate | null {
  return codexThreadControl(db, threadId)?.gate ?? null;
}

/**
 * Is this peer id a gated mailbox? True when the id was flagged by a gate, or
 * when its row is still bound to a gated thread (covers a row that a racing
 * registration attached to the thread after the gate was applied).
 */
export function codexPeerDeliveryGated(db: Database, peerId: string): boolean {
  const row = db.query(`
    SELECT 1 FROM codex_thread_controls c
    WHERE c.gate IS NOT NULL AND (
      c.thread_id = (SELECT lower(thread_id) FROM peers WHERE id = ?)
      OR EXISTS (SELECT 1 FROM json_each(c.gated_peer_ids) j WHERE j.value = ?)
    )
    LIMIT 1
  `).get(peerId, peerId);
  return row !== null;
}

/** Record a successful relay bind: pane, app-server socket, and pane supersession. */
export function recordCodexThreadBinding(db: Database, input: {
  threadId: string;
  paneId: string;
  appServerSocket: string | null;
  nowIso: string;
}): void {
  const threadId = input.threadId.toLowerCase();
  db.transaction(() => {
    db.run(`
      INSERT INTO codex_thread_controls (thread_id, tmux_pane_id, app_server_socket, bound_at, superseded_at)
      VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(thread_id) DO UPDATE SET
        tmux_pane_id = excluded.tmux_pane_id,
        app_server_socket = COALESCE(excluded.app_server_socket, codex_thread_controls.app_server_socket),
        bound_at = excluded.bound_at,
        superseded_at = NULL
    `, [threadId, input.paneId, input.appServerSocket, input.nowIso]);
    // The pane now drives a different task; earlier threads it drove are no
    // longer what `--pane` means. They stay addressable by `--thread`.
    db.run(`
      UPDATE codex_thread_controls SET superseded_at = ?
      WHERE tmux_pane_id = ? AND thread_id <> ? AND superseded_at IS NULL
    `, [input.nowIso, input.paneId, threadId]);
  })();
}

/**
 * Apply a delivery gate: every live Codex row bound to the thread becomes
 * non_targetable (no new mail can be addressed to it, no claim/poll path
 * resolves it) and its id is remembered so mail queued for it stays gated even
 * if the row's thread binding is later cleared. Never touches messages.
 */
export function applyCodexThreadGate(db: Database, input: {
  threadId: string;
  gate: CodexThreadGate;
  paneId: string | null;
  nowIso: string;
}): { gated_peer_ids: string[]; queued: number; gate: CodexThreadGate } {
  const threadId = input.threadId.toLowerCase();
  return db.transaction(() => {
    const existing = codexThreadControl(db, threadId);
    const flagged = (db.query(`
      UPDATE peers SET non_targetable = 1
      WHERE lower(thread_id) = ? AND client_type = 'codex' AND non_targetable = 0
        AND COALESCE(seat_key, '') NOT LIKE 'live:%'
      RETURNING id
    `).all(threadId) as Array<{ id: string }>).map((row) => row.id);
    const ids = [...new Set([...parsedIds(existing?.gated_peer_ids), ...flagged])];
    // `stopped` is terminal: a later pane-closed notice never downgrades it.
    const gate: CodexThreadGate = existing?.gate === "stopped" ? "stopped" : input.gate;
    db.run(`
      INSERT INTO codex_thread_controls (thread_id, tmux_pane_id, gate, gated_at, gated_peer_ids)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        tmux_pane_id = COALESCE(codex_thread_controls.tmux_pane_id, excluded.tmux_pane_id),
        gate = excluded.gate,
        gated_at = COALESCE(codex_thread_controls.gated_at, excluded.gated_at),
        gated_peer_ids = excluded.gated_peer_ids
    `, [threadId, input.paneId, gate, input.nowIso, JSON.stringify(ids)]);
    const placeholders = ids.map(() => "?").join(",");
    const queued = ids.length === 0 ? 0 : (db.query(
      `SELECT COUNT(*) AS n FROM messages WHERE delivered = 0 AND to_id IN (${placeholders})`,
    ).get(...ids) as { n: number }).n;
    return { gated_peer_ids: ids, queued, gate };
  })();
}

/**
 * Lift a `pane-closed` gate after a proven relay bind of the same thread. The
 * rows it flagged become targetable again so the bind's thread fold can carry
 * their queued mail to the live pane row. A `stopped` gate is never lifted.
 */
export function liftPaneClosedGate(db: Database, threadId: string): number {
  const normalized = threadId.toLowerCase();
  return db.transaction(() => {
    const control = codexThreadControl(db, normalized);
    if (control?.gate !== "pane-closed") return 0;
    let restored = 0;
    for (const id of parsedIds(control.gated_peer_ids)) {
      restored += db.run(
        "UPDATE peers SET non_targetable = 0 WHERE id = ? AND lower(thread_id) = ? AND client_type = 'codex'",
        [id, normalized],
      ).changes;
    }
    db.run(
      "UPDATE codex_thread_controls SET gate = NULL, gated_at = NULL, gated_peer_ids = '[]' WHERE thread_id = ?",
      [normalized],
    );
    return restored;
  })();
}

/** Lookup for codex-thread-stop. Includes superseded, gated, and dead rows. */
export function codexThreadBindingLookup(db: Database, selector: { paneId?: string; threadId?: string }): {
  controls: CodexThreadControlRow[];
  peers: Array<{ id: string; pid: number; tmux_pane_id: string | null; thread_id: string; non_targetable: number }>;
} {
  if (selector.threadId) {
    const threadId = selector.threadId.toLowerCase();
    return {
      controls: db.query("SELECT * FROM codex_thread_controls WHERE thread_id = ?").all(threadId) as CodexThreadControlRow[],
      peers: db.query(`
        SELECT id, pid, tmux_pane_id, lower(thread_id) AS thread_id, non_targetable FROM peers
        WHERE client_type = 'codex' AND lower(thread_id) = ?
        ORDER BY last_seen DESC LIMIT 50
      `).all(threadId) as never,
    };
  }
  const paneId = selector.paneId ?? "";
  return {
    controls: db.query(
      "SELECT * FROM codex_thread_controls WHERE tmux_pane_id = ? ORDER BY COALESCE(bound_at, gated_at) DESC LIMIT 50",
    ).all(paneId) as CodexThreadControlRow[],
    peers: db.query(`
      SELECT id, pid, tmux_pane_id, lower(thread_id) AS thread_id, non_targetable FROM peers
      WHERE client_type = 'codex' AND tmux_pane_id = ? AND thread_id IS NOT NULL AND length(thread_id) > 0
      ORDER BY last_seen DESC LIMIT 50
    `).all(paneId) as never,
  };
}

/** Retention: drop records with no remaining peer row once they are old. */
export function purgeCodexThreadControls(db: Database, cutoffIso: string): number {
  return db.run(`
    DELETE FROM codex_thread_controls
    WHERE COALESCE(gated_at, bound_at, '') < ?
      AND NOT EXISTS (SELECT 1 FROM peers WHERE lower(peers.thread_id) = codex_thread_controls.thread_id)
  `, [cutoffIso]).changes;
}
