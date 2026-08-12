/**
 * Regression tests for two seat-plumbing bugs (SPEC-01 planted-error style):
 *
 *   Bug 1 — dead-PID seat reclaim regardless of age. A live process re-claiming
 *   a tmux pane whose only occupant is a CONFIRMED-DEAD row must inherit that
 *   row (and its stranded undelivered mail) even when the dead row is older than
 *   REHYDRATE_WINDOW_MS. The old code applied the 1h age gate BEFORE the liveness
 *   check, so a long-dead tombstone was skipped -> the live proc got a fresh id
 *   -> the seat was permanently deaf+mute. Fix: liveness before age; a dead
 *   candidate is inheritable at any age.
 *
 *   Nudge candidate invariant — only currently undelivered mail addressed to
 *   the exact peer may put a lane in the poller's nudge set. Hook state, a pane,
 *   or delivered history cannot synthesize work.
 *
 * Uses in-memory DB fixtures. Poller selection/dedup assertions call exported
 * production helpers; broker rehydration assertions mirror its transaction.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { lanesWithUnread, paneAlreadyNudgedThisTick } from "../bin/codex-autodrain-poller.ts";
import { retentionPurgeSql, storageIndexes, unknownReceiverPurgeSql } from "../shared/storage.ts";

const REHYDRATE_WINDOW_MS = 3600_000; // 1h — mirror of broker.ts

// Mirror of broker.ts rehydrate candidate-selection + inherit decision.
// Returns the inherited id, or null. `isAlive(pid)` is the test liveness oracle
// (mirrors process.kill(pid,0): true=alive/EPERM=skip, false=ESRCH=dead).
function chooseInheritedId(
  candidates: { id: string; pid: number; last_seen: string }[],
  isAlive: (pid: number) => boolean,
  nowMs: number,
): string | null {
  for (const c of candidates) {
    const lastSeenMs = new Date(c.last_seen).getTime();
    if (!Number.isFinite(lastSeenMs)) continue;
    // Liveness gate, NO age gate (mirror of broker.ts). A live (or EPERM) pid is
    // never inherited; a confirmed-dead seat is inheritable regardless of age.
    if (isAlive(c.pid)) continue;
    void nowMs; // age intentionally not gated for confirmed-dead candidates
    return c.id;
  }
  return null;
}

describe("Bug 1 — dead-PID seat reclaim regardless of age", () => {
  const isAlive = (pid: number) => pid === 1; // only pid 1 is "alive" here

  test("inherits a CONFIRMED-DEAD seat older than the 1h window (the deaf-seat bug)", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    const inherited = chooseInheritedId(
      [{ id: "deadseat", pid: 999, last_seen: twoHoursAgo }], // pid 999 dead, 2h old
      isAlive,
      Date.now(),
    );
    // Old behavior: age gate skipped it -> null -> fresh id -> deaf seat.
    // Fixed behavior: dead-at-any-age is inheritable.
    expect(inherited).toBe("deadseat");
  });

  test("does NOT inherit a still-ALIVE seat (no hijack of a live peer's id)", () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const inherited = chooseInheritedId(
      [{ id: "liveseat", pid: 1, last_seen: recent }], // pid 1 alive
      isAlive,
      Date.now(),
    );
    expect(inherited).toBeNull();
  });

  test("recent dead seat still inherits (unchanged happy path)", () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const inherited = chooseInheritedId(
      [{ id: "deadseat", pid: 999, last_seen: recent }],
      isAlive,
      Date.now(),
    );
    expect(inherited).toBe("deadseat");
  });

  test("PLANTED-WRONG guard: an alive seat must NOT be reported inheritable", () => {
    // If a future edit reorders liveness/age and lets a live pid through, this
    // catches it. A test suite that cannot fail proves nothing (SPEC-01).
    const recent = new Date(Date.now() - 60_000).toISOString();
    const inherited = chooseInheritedId(
      [{ id: "liveseat", pid: 1, last_seen: recent }],
      isAlive,
      Date.now(),
    );
    expect(inherited).not.toBe("liveseat");
  });
});

describe("Bug 1 (full fix) — reaper decouples mail-reap from row-reap", () => {
  // Mirror of broker.ts liveAndFreshPeers reap decision for a DEAD seat past the
  // 1h window. The full fix: a dead seat with PENDING mail is preserved (its mail
  // is a recoverable inbox the any-age inherit path will surface); a dead seat
  // with ZERO mail is reaped normally (bounds tombstone growth). Without this,
  // the reaper deleted the mail at 1h and the any-age inherit recovered nothing.
  type ReapAction = "reap" | "preserve-inbox" | "keep-active";
  const DEAD_MAIL_TTL_MS = 24 * 3600_000; // mirror of broker.ts default (24h)
  // lastSeenValid mirrors prod's guard: a malformed/corrupt last_seen
  // (Number.isFinite === false) means untrustworthy state — such a seat reaps
  // normally even WITH mail, so corrupt tombstones never leak forever.
  // The dead-with-mail PRESERVE path now has a TTL ceiling: mail is kept only
  // within DEAD_MAIL_TTL_MS (floored at REHYDRATE_WINDOW_MS); past it the row +
  // stranded mail are reaped instead of preserved forever.
  function reapDecision(deadPidAlive: boolean, ageMs: number, pendingMail: number, lastSeenValid = true): ReapAction {
    if (deadPidAlive && ageMs <= REHYDRATE_WINDOW_MS) return "keep-active"; // not reapable yet
    const reapable = !deadPidAlive || ageMs > REHYDRATE_WINDOW_MS;
    if (!reapable) return "keep-active";
    const mailExpired = ageMs > Math.max(REHYDRATE_WINDOW_MS, DEAD_MAIL_TTL_MS);
    if (pendingMail > 0 && lastSeenValid && !mailExpired) return "preserve-inbox"; // dead + mail + valid ts + within TTL → keep
    return "reap"; // dead + (empty OR malformed ts OR mail past TTL) → delete row+mail
  }

  test("DEAD seat >1h WITH pending mail is PRESERVED (mail survives for inheritance)", () => {
    expect(reapDecision(false, 2 * 3600_000, 3)).toBe("preserve-inbox");
  });

  test("DEAD seat >1h with ZERO mail is REAPED (no unbounded tombstone growth)", () => {
    expect(reapDecision(false, 2 * 3600_000, 0)).toBe("reap");
  });

  test("DEAD seat with MALFORMED last_seen is REAPED even WITH mail (no corrupt-tombstone leak)", () => {
    // Prod: a NaN timestamp → reapable-by-age → reaps regardless of mail. The
    // narrow exception to preserve-on-pending-mail (broker.ts lastSeenValid guard).
    expect(reapDecision(false, 2 * 3600_000, 3, /*lastSeenValid*/ false)).toBe("reap");
  });

  test("PLANTED-WRONG guard: a dead seat with mail (valid ts) WITHIN the TTL must NOT be reaped", () => {
    // 5h < 24h TTL → still a recoverable inbox. If a future edit re-deletes mail at
    // the 1h mark (drops the preserve path), this flips to "reap" and fails.
    expect(reapDecision(false, 5 * 3600_000, 1)).not.toBe("reap");
  });

  test("DEAD seat with mail PAST the 24h TTL is REAPED (the forever-leak is closed)", () => {
    // The real leak: a session dead 6 days with unread mail was preserved forever.
    expect(reapDecision(false, 6 * 24 * 3600_000, 1)).toBe("reap");
  });

  test("PLANTED-WRONG guard: dropping the TTL ceiling re-opens the forever-leak", () => {
    // If a future edit removes the mailExpired check, a 6-day dead-with-mail seat
    // goes back to "preserve-inbox" and this flips red.
    expect(reapDecision(false, 6 * 24 * 3600_000, 1)).not.toBe("preserve-inbox");
  });
});

describe("autodrain requires exact currently undelivered mail", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run(
      `CREATE TABLE peers (
        id TEXT PRIMARY KEY, pid INTEGER, name TEXT, client_type TEXT,
        tmux_pane_id TEXT, thread_id TEXT, seat_key TEXT, receiver_mode TEXT,
        last_hook_seen_at TEXT, unread_episode INTEGER NOT NULL DEFAULT 0
      )`,
    );
    db.run(
      "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, to_id TEXT, delivered INTEGER)",
    );
  });

  test("does not surface a fresh NULL-hook seat with zero mail", () => {
    db.run(
      "INSERT INTO peers (id, pid, name, client_type, last_hook_seen_at) VALUES ('fresh', 100, 'infra.4', 'claude', NULL)",
    );
    expect(lanesWithUnread(db, ["claude"])).toEqual([]);
  });

  test("does not surface delivered history as pending mail", () => {
    db.run(
      "INSERT INTO peers (id, pid, name, client_type, last_hook_seen_at) VALUES ('history', 101, 'coding.1', 'claude', NULL)",
    );
    db.run("INSERT INTO messages (to_id, delivered) VALUES ('history', 1)");
    expect(lanesWithUnread(db, ["claude"])).toEqual([]);
  });

  test("surfaces and counts only undelivered mail for the exact peer", () => {
    db.run(
      "INSERT INTO peers (id, pid, name, client_type, last_hook_seen_at) VALUES ('hasmail', 101, 'coding.1', 'claude', '2026-06-17T05:00:00Z')",
    );
    db.run(
      "INSERT INTO peers (id, pid, name, client_type, last_hook_seen_at) VALUES ('other', 102, 'coding.2', 'claude', NULL)",
    );
    db.run("INSERT INTO messages (to_id, delivered) VALUES ('hasmail', 0)");
    db.run("INSERT INTO messages (to_id, delivered) VALUES ('hasmail', 1)");
    const lanes = lanesWithUnread(db, ["claude"]);
    const hasmail = lanes.find((l) => l.id === "hasmail");
    expect(hasmail).toBeDefined();
    expect(hasmail!.unread).toBe(1);
    expect(lanes.find((l) => l.id === "other")).toBeUndefined();
  });
});

describe("per-pane nudge dedup", () => {
  // Multiple lanes can still resolve to one pane. The real exported guard keeps
  // one physical pane to at most one nudge per tick.
  // Field captured live (2026-06-18): pane %433 carried 3 clause5.6 rows, 2 of them
  // NULL-hook+zero-mail, nudged interleaved every ~60s (attempts 1→3).

  // Replicate ONLY tick()'s loop scaffolding (claim-after-nudge); the DECISION
  // (paneAlreadyNudgedThisTick) is the real prod export under test.
  function nudgesThisTick(lanesByPane: { id: string; pane: string }[]): string[] {
    const claimed = new Set<string>();
    const nudged: string[] = [];
    for (const lane of lanesByPane) {
      if (paneAlreadyNudgedThisTick(lane.pane, claimed)) continue; // A2 — real export
      nudged.push(lane.id);
      claimed.add(lane.pane);                                      // claim-after-nudge (tick() scaffolding)
    }
    return nudged;
  }

  test("three lanes on ONE pane produce exactly ONE nudge that tick (A2 dedup)", () => {
    // The live %433 shape: 3 clause5.6 rows on the same pane.
    const nudged = nudgesThisTick([
      { id: "yg1wvppe", pane: "%433" },
      { id: "pzvp8mf3", pane: "%433" },
      { id: "jiyh6aqs", pane: "%433" },
    ]);
    expect(nudged).toEqual(["yg1wvppe"]); // first claimant only
    expect(nudged.length).toBe(1);        // not 3 — the storm is gone
  });

  test("lanes on DISTINCT panes each nudge (dedup does not over-suppress)", () => {
    const nudged = nudgesThisTick([
      { id: "a", pane: "%1" },
      { id: "b", pane: "%2" },
      { id: "c", pane: "%3" },
    ]);
    expect(nudged).toEqual(["a", "b", "c"]);
  });

  test("PLANTED-WRONG guard: the real export blocks a second lane on a claimed pane", () => {
    // paneAlreadyNudgedThisTick is the actual tick() guard. A claimed pane must
    // block the next lane; without it the pane is nudged once per lane (the storm).
    const claimed = new Set<string>(["%9"]);
    expect(paneAlreadyNudgedThisTick("%9", claimed)).toBe(true);   // claimed → blocked
    expect(paneAlreadyNudgedThisTick("%8", claimed)).toBe(false);  // unclaimed → allowed
    // End-to-end via the loop: two lanes on one pane → exactly one nudge.
    const nudged = nudgesThisTick([{ id: "x", pane: "%9" }, { id: "y", pane: "%9" }]);
    expect(nudged.length).toBe(1);
  });
});

describe("Bug 5 — seat-supersede: a live older same-seat duplicate is told to step down", () => {
  // Root cause of the "seat churn" (xkcf84xp <-> ltv3gknh ping-pong, 2026-06-27):
  // a `claude --resume` / bg-spare / MCP re-init spawns a NEW server.ts for a pane
  // while the OLD server for that same pane keeps running. Both have valid tokens,
  // so neither 401s — the broker ping-pongs `last_seen` between two live
  // registrations on one seat → unreliable 1:1 delivery. The old seat-dedup left a
  // LIVE duplicate untouched ("a live row is not stale — never touch it"); that's
  // the gap. Fix: the newest registrant is authoritative, so every LIVE older
  // same-seat self-dup is flagged superseded → told to step down on its next
  // heartbeat → exits → one live registration remains.
  //
  // Mirror of broker.ts liveDuplicatesToSupersede (broker.ts is not import-safe —
  // top-level Bun.serve + Database; the repo mirrors broker decisions in tests).
  function liveDuplicatesToSupersede(
    dups: { id: string; pid: number }[],
    isAlive: (pid: number) => boolean,
  ): string[] {
    return dups.filter((d) => isAlive(d.pid)).map((d) => d.id);
  }

  // selectSamePaneSelfDuplicates returns rows for the SAME seat with a DIFFERENT
  // pid than the registrant (newest-first), so the registrant is never in `dups`.
  test("a LIVE older duplicate on the same seat is superseded (the churn fix)", () => {
    const alive = (pid: number) => pid === 383761; // the old live leftover
    const dups = [{ id: "xkcf84xp", pid: 383761 }]; // older live row on pane %5
    expect(liveDuplicatesToSupersede(dups, alive)).toEqual(["xkcf84xp"]);
  });

  test("a DEAD older duplicate is NOT superseded (dead-row paths own it)", () => {
    const alive = (_pid: number) => false; // the old row's pid is dead
    const dups = [{ id: "deadseat", pid: 999 }];
    expect(liveDuplicatesToSupersede(dups, alive)).toEqual([]); // dedup/rehydrate handle dead rows
  });

  test("ALL live older dups are superseded (newest registrant wins over every leftover)", () => {
    const alive = (_pid: number) => true; // every leftover still running
    const dups = [
      { id: "a", pid: 100 },
      { id: "b", pid: 200 },
      { id: "c", pid: 300 },
    ];
    expect(liveDuplicatesToSupersede(dups, alive).sort()).toEqual(["a", "b", "c"]);
  });

  test("mixed live/dead: only the LIVE leftovers are superseded", () => {
    const alive = (pid: number) => pid === 100 || pid === 300; // 200 is dead
    const dups = [
      { id: "live1", pid: 100 },
      { id: "dead", pid: 200 },
      { id: "live2", pid: 300 },
    ];
    expect(liveDuplicatesToSupersede(dups, alive).sort()).toEqual(["live1", "live2"]);
  });

  test("no duplicates → nobody superseded (the common, healthy case)", () => {
    expect(liveDuplicatesToSupersede([], () => true)).toEqual([]);
  });

  test("PLANTED-WRONG guard: superseding DEAD rows would corrupt the rehydration path", () => {
    // If a future edit drops the liveness filter (supersedes every dup incl. dead
    // ones), this flips — and dead rows would be wrongly told to step down,
    // stealing the rehydration/inherit path's recoverable-mail tombstone.
    const alive = (_pid: number) => false;
    const dups = [{ id: "deadseat", pid: 999 }];
    expect(liveDuplicatesToSupersede(dups, alive)).not.toContain("deadseat");
  });
});

describe("Bug 6 — delivered-message TTL purge (bounds unbounded DB growth)", () => {
  // delivered=1 rows are only ever MARKED, never deleted, so they accumulate
  // forever (observed 2026-06-27: 5,180 delivered msgs, oldest 2026-04-07, ~9.2MB
  // of a 12MB db). The reaper now purges delivered mail older than
  // DELIVERED_MSG_TTL_MS on its 30s tick. Mirror of the prod DELETE (broker.ts is
  // not import-safe). Undelivered mail and recent delivered mail are untouched.
  let db: Database;
  const DELIVERED_MSG_TTL_MS = 7 * 24 * 3600_000; // 7d (mirror of broker default)

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, to_id TEXT, delivered INTEGER, delivered_at TEXT, retention_at TEXT)");
    db.run(`CREATE INDEX ${storageIndexes.deliveredRetention} ON messages(delivered, retention_at)`);
  });

  // Mirror of the cleanStalePeers delivered-purge DELETE.
  function purgeDelivered(nowMs: number): number {
    const cutoffIso = new Date(nowMs - DELIVERED_MSG_TTL_MS).toISOString();
    return db.run(retentionPurgeSql(), [cutoffIso]).changes;
  }

  test("an OLD delivered message (past TTL) is purged", () => {
    const old = new Date(Date.now() - 30 * 24 * 3600_000).toISOString(); // 30 days
    db.run("INSERT INTO messages (to_id, delivered, delivered_at, retention_at) VALUES ('a', 1, ?, ?)", [old, old]);
    expect(purgeDelivered(Date.now())).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
  });

  test("a RECENT delivered message (within TTL) is kept", () => {
    const recent = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    db.run("INSERT INTO messages (to_id, delivered, delivered_at, retention_at) VALUES ('a', 1, ?, ?)", [recent, recent]);
    expect(purgeDelivered(Date.now())).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });
  });

  test("UNDELIVERED mail is NEVER purged by this sweep (delivered=0), regardless of age", () => {
    // even an ancient undelivered row stays — it's a different sweep's concern.
    db.run("INSERT INTO messages (to_id, delivered, delivered_at) VALUES ('a', 0, NULL)");
    expect(purgeDelivered(Date.now())).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });
  });

  test("PLANTED-WRONG guard: a delivered=0 row must survive (never purge undelivered)", () => {
    db.run("INSERT INTO messages (to_id, delivered, delivered_at) VALUES ('a', 0, NULL)");
    purgeDelivered(Date.now());
    expect((db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(1);
  });
});

describe("Bug 7 — undelivered-mail TTL for live-but-non-draining peers (receiver_mode='unknown')", () => {
  // A peer that heartbeats (row never goes stale) but never drains
  // (receiver_mode='unknown' — a send-only / misregistered client like a one-way
  // bridge) traps undelivered mail forever: the orphan sweep skips it (to_id is a
  // live row), the dead-seat TTL skips it (seat is alive), and the delivered TTL
  // skips it (delivered=0). The reaper now caps such mail by absolute age, GATED on
  // receiver_mode='unknown' so a real but idle Claude/Codex/Gemini peer is never
  // affected. Live proof 2026-06-28: pieces-bridge.linux trapped 7 broadcasts for
  // up to 7 days. Mirror of the prod DELETE (broker.ts is not import-safe).
  let db: Database;
  const UNDELIVERED_MSG_TTL_MS = 7 * 24 * 3600_000; // 7d (mirror of broker default)

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("CREATE TABLE peers (id TEXT PRIMARY KEY, receiver_mode TEXT NOT NULL DEFAULT 'unknown')");
    db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, to_id TEXT, delivered INTEGER, sent_at TEXT)");
    db.run(`CREATE INDEX ${storageIndexes.unknownReceiverRetention} ON messages(delivered, sent_at, to_id)`);
  });

  // Mirror of the cleanStalePeers undelivered-mail-TTL DELETE.
  function purgeStaleUndelivered(nowMs: number): number {
    const cutoffIso = new Date(nowMs - UNDELIVERED_MSG_TTL_MS).toISOString();
    return db.run(unknownReceiverPurgeSql(), [cutoffIso]).changes;
  }

  const OLD = new Date(Date.now() - 30 * 24 * 3600_000).toISOString(); // 30d
  const RECENT = new Date(Date.now() - 60_000).toISOString(); // 1 min

  test("HAPPY: old undelivered mail to an UNKNOWN-receiver peer is dropped", () => {
    db.run("INSERT INTO peers (id, receiver_mode) VALUES ('bridge', 'unknown')");
    db.run("INSERT INTO messages (to_id, delivered, sent_at) VALUES ('bridge', 0, ?)", [OLD]);
    expect(purgeStaleUndelivered(Date.now())).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
  });

  test("EDGE recent: a within-TTL undelivered row to an unknown peer is KEPT", () => {
    db.run("INSERT INTO peers (id, receiver_mode) VALUES ('bridge', 'unknown')");
    db.run("INSERT INTO messages (to_id, delivered, sent_at) VALUES ('bridge', 0, ?)", [RECENT]);
    expect(purgeStaleUndelivered(Date.now())).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });
  });

  test("NON-LOSSY GATE: old undelivered mail to a REAL receiver (claude-channel) is KEPT", () => {
    // This is the load-bearing guard: a real but idle peer past the TTL must NOT
    // lose mail. Only no-receive-path (unknown) recipients are capped.
    db.run("INSERT INTO peers (id, receiver_mode) VALUES ('claude-x', 'claude-channel')");
    db.run("INSERT INTO messages (to_id, delivered, sent_at) VALUES ('claude-x', 0, ?)", [OLD]);
    expect(purgeStaleUndelivered(Date.now())).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });
  });

  test("EDGE delivered: a delivered=1 row past the TTL is NOT this sweep's concern", () => {
    // The delivered-mail TTL (Bug 6) owns delivered=1; this sweep only touches delivered=0.
    db.run("INSERT INTO peers (id, receiver_mode) VALUES ('bridge', 'unknown')");
    db.run("INSERT INTO messages (to_id, delivered, sent_at) VALUES ('bridge', 1, ?)", [OLD]);
    expect(purgeStaleUndelivered(Date.now())).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });
  });

  test("VoV (planted error): dropping the receiver_mode='unknown' gate would purge the real receiver's mail", () => {
    // Prove the gate is load-bearing: run the UNGATED variant and confirm it WOULD
    // delete the real-receiver row that the gated version keeps. If this expectation
    // ever flips, the non-lossy guarantee is broken.
    db.run("INSERT INTO peers (id, receiver_mode) VALUES ('claude-x', 'claude-channel')");
    db.run("INSERT INTO messages (to_id, delivered, sent_at) VALUES ('claude-x', 0, ?)", [OLD]);
    const cutoffIso = new Date(Date.now() - UNDELIVERED_MSG_TTL_MS).toISOString();
    const ungatedDeleted = db.run("DELETE FROM messages WHERE delivered = 0 AND sent_at < ?", [cutoffIso]).changes;
    expect(ungatedDeleted).toBe(1); // ungated WOULD drop the real receiver's mail — that's why the gate exists
  });
});
