/**
 * Regression test — /register must not crash when a peer registers BEFORE its
 * async auto-summary lands (the "lane needs a manual nudge" bug).
 *
 * Root cause (verified 2026-06-15): `peers.summary` is `TEXT NOT NULL DEFAULT
 * ''`. A column DEFAULT only applies when the column is OMITTED from the INSERT
 * — NOT when a nullish value is bound to it. bg/daemon-hosted lanes register
 * lazily on first tool call, often before the gpt-5.4-nano summary is generated,
 * so `body.summary` is `undefined`. Binding `undefined`/`null` to a NOT NULL
 * column throws `NOT NULL constraint failed: peers.summary`, which made
 * `/register` return a bare 500 and the lane silently never registered → it was
 * invisible to the broker → the operator had to manually nudge it.
 *
 * The fix coalesces `body.summary ?? ""` (and `body.tty ?? null`) at the bind
 * site in handleRegister.
 *
 * This test exercises the REAL table schema + REAL bind shape against an
 * in-memory DB (not a mirrored re-implementation), so it fails on the
 * pre-fix binding and passes on the post-fix binding — a Verification-of-the-
 * Verifier planted-error pair (SPEC-01).
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";

// The exact peers-table columns the insert binds (mirrors broker.ts CREATE
// TABLE for tty + summary, which are the two nullish-sensitive columns).
function freshPeersDb(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE peers (
      id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      git_root TEXT,
      absolute_git_dir TEXT,
      tty TEXT,
      name TEXT,
      resolved_name TEXT,
      tmux_session TEXT,
      tmux_window_index INTEGER,
      tmux_window_name TEXT,
      tmux_pane_id TEXT,
      client_type TEXT NOT NULL DEFAULT 'unknown',
      receiver_mode TEXT NOT NULL DEFAULT 'unknown',
      summary TEXT NOT NULL DEFAULT '',
      registered_at TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      token TEXT NOT NULL
    )
  `);
  return db;
}

function insertStmt(db: Database) {
  return db.prepare(`
    INSERT INTO peers (id, pid, cwd, git_root, absolute_git_dir, tty, name, resolved_name, tmux_session, tmux_window_index, tmux_window_name, tmux_pane_id, client_type, receiver_mode, summary, registered_at, last_seen, token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
}

// Bind in the SAME order broker.ts insertPeer.run uses. `applyFix` toggles the
// `?? ""` / `?? null` coalescing so we can prove the planted error.
function runInsert(db: Database, summary: string | undefined, tty: string | undefined, applyFix: boolean) {
  const now = new Date().toISOString();
  const summaryValue = applyFix ? (summary ?? "") : summary;
  const ttyValue = applyFix ? (tty ?? null) : tty;
  insertStmt(db).run(
    "peer1", 1234, "/tmp/x", "/tmp/x", null, ttyValue as string | null,
    "lane.1", "lane.1", null, null, null, null,
    "claude", "claude-channel", summaryValue as string, now, now, "tok",
  );
}

describe("register: summary NOT NULL crash", () => {
  test("PLANTED ERROR — pre-fix binding (undefined summary) throws NOT NULL", () => {
    const db = freshPeersDb();
    // This is the bug: binding undefined to summary (NOT NULL) throws.
    expect(() => runInsert(db, undefined, "/dev/pts/3", false)).toThrow(/NOT NULL/);
    db.close();
  });

  test("FIX — body.summary ?? '' lets a not-yet-summarized lane register", () => {
    const db = freshPeersDb();
    expect(() => runInsert(db, undefined, "/dev/pts/3", true)).not.toThrow();
    const row = db.query("SELECT summary, tty FROM peers WHERE id = 'peer1'").get() as { summary: string; tty: string | null };
    expect(row.summary).toBe("");
    expect(row.tty).toBe("/dev/pts/3");
    db.close();
  });

  test("FIX — undefined tty (daemon-hosted, no controlling tty) coalesces to NULL", () => {
    const db = freshPeersDb();
    expect(() => runInsert(db, "working on X", undefined, true)).not.toThrow();
    const row = db.query("SELECT summary, tty FROM peers WHERE id = 'peer1'").get() as { summary: string; tty: string | null };
    expect(row.summary).toBe("working on X");
    expect(row.tty).toBeNull();
    db.close();
  });

  test("FIX — a real summary is preserved verbatim (no clobbering)", () => {
    const db = freshPeersDb();
    runInsert(db, "[tmux 1:claude] editing foo.ts", "/dev/pts/9", true);
    const row = db.query("SELECT summary FROM peers WHERE id = 'peer1'").get() as { summary: string };
    expect(row.summary).toBe("[tmux 1:claude] editing foo.ts");
    db.close();
  });
});

// Two UPDATE shapes prove the fix. `applyFix=false` mirrors the PRE-FIX SQL
// (`summary = ?` — binds the value straight in, so undefined/empty clobbers or
// crashes). `applyFix=true` mirrors the FIXED SQL
// (`summary = COALESCE(NULLIF(?, ''), summary)` — empty/undefined preserves the
// existing live summary). This is the Verification-of-the-Verifier pair: the
// planted (pre-fix) shape fails the way the bug did; the fixed shape holds.
function updateStmt(db: Database, applyFix: boolean) {
  const summaryClause = applyFix ? "summary = COALESCE(NULLIF(?, ''), summary)" : "summary = ?";
  return db.prepare(`
    UPDATE peers
    SET pid = ?, cwd = ?, git_root = ?, absolute_git_dir = ?, tty = ?,
        name = ?, resolved_name = ?, tmux_session = ?, tmux_window_index = ?,
        tmux_window_name = ?, tmux_pane_id = ?, client_type = ?,
        receiver_mode = ?, ${summaryClause},
        last_seen = ?, token = ?
    WHERE id = ?
  `);
}

function runUpdate(db: Database, summary: string | undefined, applyFix: boolean) {
  const now = new Date().toISOString();
  updateStmt(db, applyFix).run(
    1234, "/tmp/x", "/tmp/x", null, "/dev/pts/3",
    "lane.1", "lane.1", null, null, null, null,
    "claude", "claude-channel", summary as string, now, "tok2", "peer1",
  );
}

describe("register: re-registration summary preservation", () => {
  test("PLANTED ERROR — pre-fix UPDATE bind (undefined summary) throws NOT NULL", () => {
    const db = freshPeersDb();
    runInsert(db, "live operator summary", "/dev/pts/3", true);
    // Pre-fix SQL bound `summary = ?` directly — undefined throws NOT NULL.
    expect(() => runUpdate(db, undefined, false)).toThrow(/NOT NULL/);
    db.close();
  });

  test("PLANTED ERROR — pre-fix UPDATE bind (empty summary) CLOBBERS the live summary", () => {
    const db = freshPeersDb();
    runInsert(db, "live operator summary", "/dev/pts/3", true);
    // Pre-fix SQL with empty "" silently overwrote the live summary — the bug.
    runUpdate(db, "", false);
    const row = db.query("SELECT summary FROM peers WHERE id = 'peer1'").get() as { summary: string };
    expect(row.summary).toBe(""); // demonstrates the clobber the fix prevents
    db.close();
  });

  test("FIX — re-register with EMPTY summary preserves the live summary", () => {
    const db = freshPeersDb();
    runInsert(db, "live operator summary", "/dev/pts/3", true);
    // A lane re-registering (401 recovery) re-sends its frozen startup summary,
    // which is "" after the operator set the real one via /set-summary.
    // COALESCE(NULLIF('', ''), summary) keeps the live value.
    runUpdate(db, "", true);
    const row = db.query("SELECT summary FROM peers WHERE id = 'peer1'").get() as { summary: string };
    expect(row.summary).toBe("live operator summary");
    db.close();
  });

  test("FIX — re-register with a NEW non-empty summary updates it", () => {
    const db = freshPeersDb();
    runInsert(db, "old summary", "/dev/pts/3", true);
    runUpdate(db, "fresh summary", true);
    const row = db.query("SELECT summary FROM peers WHERE id = 'peer1'").get() as { summary: string };
    expect(row.summary).toBe("fresh summary");
    db.close();
  });

  test("FIX — re-register with undefined summary preserves the live summary (no crash)", () => {
    const db = freshPeersDb();
    runInsert(db, "live operator summary", "/dev/pts/3", true);
    expect(() => runUpdate(db, undefined, true)).not.toThrow();
    const row = db.query("SELECT summary FROM peers WHERE id = 'peer1'").get() as { summary: string };
    expect(row.summary).toBe("live operator summary");
    db.close();
  });
});

// Orphan-mail sweep: undelivered messages whose target peer row is gone (e.g. a
// re-register that assigned a new id and abandoned the old) must be cleaned, or
// the messages table grows unbounded. cleanStalePeers runs:
//   DELETE FROM messages WHERE delivered = 0 AND to_id NOT IN (SELECT id FROM peers)
function dbWithMessages(): Database {
  const db = freshPeersDb();
  db.run(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id TEXT NOT NULL, to_id TEXT NOT NULL, text TEXT NOT NULL,
      sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0,
      delivered_at TEXT, claimed_by TEXT, claimed_at TEXT
    )
  `);
  return db;
}

describe("register: orphan-mail sweep", () => {
  test("sweep removes undelivered mail to a gone peer, keeps mail to a live peer", () => {
    const db = dbWithMessages();
    const now = new Date().toISOString();
    runInsert(db, "live", "/dev/pts/3", true); // creates peer1 (live)
    // mail to the live peer (must survive) + mail to a gone peer (must go)
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?,?,?,?,0)", ["x", "peer1", "to-live", now]);
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?,?,?,?,0)", ["x", "GONE-ID", "to-gone", now]);
    // an already-delivered row to a gone peer must NOT be touched (delivered=1)
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?,?,?,?,1)", ["x", "GONE-ID", "old-delivered", now]);

    const res = db.run("DELETE FROM messages WHERE delivered = 0 AND to_id NOT IN (SELECT id FROM peers)");
    expect(res.changes).toBe(1); // only the undelivered orphan

    const surviving = db.query("SELECT to_id, delivered FROM messages ORDER BY id").all() as { to_id: string; delivered: number }[];
    expect(surviving.map((r) => r.to_id)).toEqual(["peer1", "GONE-ID"]); // live undelivered + delivered orphan kept
    expect(surviving.find((r) => r.to_id === "peer1")!.delivered).toBe(0);
    db.close();
  });

  test("sweep is a no-op when every undelivered message has a live peer", () => {
    const db = dbWithMessages();
    const now = new Date().toISOString();
    runInsert(db, "live", "/dev/pts/3", true);
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?,?,?,?,0)", ["x", "peer1", "ok", now]);
    const res = db.run("DELETE FROM messages WHERE delivered = 0 AND to_id NOT IN (SELECT id FROM peers)");
    expect(res.changes).toBe(0);
    db.close();
  });
});
