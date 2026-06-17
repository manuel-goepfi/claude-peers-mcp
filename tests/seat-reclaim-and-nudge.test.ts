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
 *   Bug 3 — the autodrain poller's lane query skipped zero-mail seats
 *   (HAVING unread > 0), so a freshly-registered seat whose drain hook never
 *   attached (last_hook_seen_at IS NULL) and has no mail yet was never nudged ->
 *   its hook never attached (chicken-and-egg). Fix: also surface
 *   last_hook_seen_at IS NULL seats; MAX_NUDGE_ATTEMPTS bounds the bootstrap.
 *
 * Mirrors the inline-logic test pattern (in-memory DB + a copy of the prod
 * logic). If broker.ts / codex-autodrain-poller.ts diverge, update these copies.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";

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
  // lastSeenValid mirrors prod's guard: a malformed/corrupt last_seen
  // (Number.isFinite === false) means untrustworthy state — such a seat reaps
  // normally even WITH mail, so corrupt tombstones never leak forever.
  function reapDecision(deadPidAlive: boolean, ageMs: number, pendingMail: number, lastSeenValid = true): ReapAction {
    if (deadPidAlive && ageMs <= REHYDRATE_WINDOW_MS) return "keep-active"; // not reapable yet
    const reapable = !deadPidAlive || ageMs > REHYDRATE_WINDOW_MS;
    if (!reapable) return "keep-active";
    if (pendingMail > 0 && lastSeenValid) return "preserve-inbox"; // dead + mail + valid ts → keep row+mail
    return "reap"; // dead + (empty OR malformed ts) → delete row+mail
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

  test("PLANTED-WRONG guard: a dead seat with mail (valid ts) must NOT be reaped (regression of the full fix)", () => {
    // If a future edit re-deletes mail at the 1h mark, this flips to "reap" and fails.
    expect(reapDecision(false, 5 * 3600_000, 1)).not.toBe("reap");
  });
});

describe("Bug 3 — autodrain surfaces NULL-hook zero-mail seats", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run(
      "CREATE TABLE peers (id TEXT PRIMARY KEY, pid INTEGER, name TEXT, client_type TEXT, tmux_pane_id TEXT, last_hook_seen_at TEXT)",
    );
    db.run(
      "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, to_id TEXT, delivered INTEGER)",
    );
  });

  // Mirror of codex-autodrain-poller.ts lanesWithUnread() — the fixed query.
  function lanesWithUnread(): { id: string; unread: number; last_hook_seen_at: string | null }[] {
    return db
      .query(
        `SELECT p.id, p.last_hook_seen_at, COUNT(m.id) AS unread
         FROM peers p
         LEFT JOIN messages m ON m.to_id = p.id AND m.delivered = 0
         WHERE p.client_type IN ('codex','gemini','claude')
         GROUP BY p.id
         HAVING unread > 0 OR p.last_hook_seen_at IS NULL`,
      )
      .all() as { id: string; unread: number; last_hook_seen_at: string | null }[];
  }

  test("surfaces a fresh NULL-hook seat with ZERO mail (the bootstrap-nudge case)", () => {
    db.run(
      "INSERT INTO peers (id, pid, name, client_type, last_hook_seen_at) VALUES ('fresh', 100, 'infra.4', 'claude', NULL)",
    );
    const lanes = lanesWithUnread();
    const fresh = lanes.find((l) => l.id === "fresh");
    expect(fresh).toBeDefined();
    expect(fresh!.unread).toBe(0); // COUNT(m.id) over no rows = 0 (not 1 — would be wrong with COUNT(*))
  });

  test("surfaces a seat WITH unread mail (unchanged behavior)", () => {
    db.run(
      "INSERT INTO peers (id, pid, name, client_type, last_hook_seen_at) VALUES ('hasmail', 101, 'coding.1', 'claude', '2026-06-17T05:00:00Z')",
    );
    db.run("INSERT INTO messages (to_id, delivered) VALUES ('hasmail', 0)");
    const lanes = lanesWithUnread();
    const hasmail = lanes.find((l) => l.id === "hasmail");
    expect(hasmail).toBeDefined();
    expect(hasmail!.unread).toBe(1);
  });

  test("does NOT surface a hook-attached seat with zero mail (no needless nudge)", () => {
    db.run(
      "INSERT INTO peers (id, pid, name, client_type, last_hook_seen_at) VALUES ('healthy', 102, 'rag.1', 'claude', '2026-06-17T05:00:00Z')",
    );
    const lanes = lanesWithUnread();
    expect(lanes.find((l) => l.id === "healthy")).toBeUndefined();
  });
});
