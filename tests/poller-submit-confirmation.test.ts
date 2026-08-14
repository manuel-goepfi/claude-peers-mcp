/**
 * The poller must never ACK mail based on a tmux keystroke.
 *
 * Live P1, 2026-08-03: the autodrain poller delivered a 3-message batch into
 * infra.7's pane and immediately acked it. `submitPaneText()` returned the exit
 * code of `tmux send-keys ... C-m`, which only proves tmux handed the keystroke
 * to the pane — not that the TUI consumed it as a submit. The text sat unsent in
 * the composer until the operator pressed Enter roughly a minute later, by which
 * point messages 14677/14688/14691 were already stamped
 * delivered_at 10:01:39.143 and gone from the queue.
 *
 * That is silent LOSS rather than delay: an acked message is never retried, so
 * had the operator cleared the composer instead of submitting it, three messages
 * would have vanished with no trace anywhere except a "delivered" row.
 *
 * The durable repair is wake-only: the poller may submit a notification, while
 * the lane's own hook claims and acknowledges mail by exact thread identity.
 * These tests pin submission observation and prove the poller contains no broker
 * claim/ack route that could convert a missed Enter into message loss.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __nudgeAttemptCountForTest,
  __resetNudgeBudgetStateForTest,
  composerStillHolds,
  loadNudgeBudgetState,
  nudgeBudgetHealthStatus,
  submissionProbe,
  submitWakeOnlyNudge,
  tick,
  writeHeartbeat,
  type Lane,
  type TickSnapshot,
} from "../bin/codex-autodrain-poller.ts";

const PROMPT = "› ";

describe("submissionProbe picks a recognisable fragment", () => {
  test("collapses whitespace so a re-wrapped composer still matches", () => {
    expect(submissionProbe("peer   message\n\n  from infra.2")).toBe("peer message from infra.2");
  });

  test("is bounded — a whole batch is not used as the probe", () => {
    expect(submissionProbe("x".repeat(500)).length).toBeLessThanOrEqual(48);
  });

  test("empty text yields an empty probe", () => {
    expect(submissionProbe("   \n  ")).toBe("");
  });
});

describe("composerStillHolds distinguishes UNSENT from SENT", () => {
  const probe = submissionProbe("[peer-mail] 3 pending peer message(s) from infra.2");

  test("text sitting in the composer reads as UNSENT", () => {
    // The live failure: typed, not submitted.
    const capture = ["some earlier output", "", `${PROMPT}[peer-mail] 3 pending peer message(s) from infra.2`].join("\n");
    expect(composerStillHolds(capture, probe)).toBe(true);
  });

  test("the SAME text in the transcript above an empty composer reads as SENT", () => {
    // The discriminator that matters. After submission the text is still on
    // screen — it moved up into the transcript. A naive "does the capture
    // contain it" check would call every successful submit a failure and the
    // poller would never ack anything.
    const capture = [
      "[peer-mail] 3 pending peer message(s) from infra.2",
      "• Working (2s)",
      `${PROMPT}Find and fix a bug in @filename`,
    ].join("\n");
    expect(composerStillHolds(capture, probe)).toBe(false);
  });

  test("wrapped composer text still counts as held", () => {
    const capture = [`${PROMPT}[peer-mail] 3 pending peer`, "message(s) from infra.2"].join("\n");
    expect(composerStillHolds(capture, probe)).toBe(true);
  });

  test.each([
    ["Cursor", `→ ${probe}`, "→ Add a follow-up"],
    ["Claude", `❯ ${probe}`, "❯ "],
    ["Grok 4.6 boxed", `│ ❯ ${probe} │`, "│ ❯                                      │"],
    ["Kimi boxed", `│ > ${probe}`, "│ > "],
    ["legacy Grok", `$ ${probe}`, "$ "],
  ])("%s composer reports held before Enter and released after submit", (_client, held, empty) => {
    expect(composerStillHolds(`earlier output\n${held}`, probe)).toBe(true);
    expect(composerStillHolds(`${probe}\nWorking\n${empty}`, probe)).toBe(false);
  });

  test("a capture with no visible composer never claims the text is held", () => {
    // Fail toward "submitted" here: with no prompt marker we have no evidence of
    // holding, and inventing one would block delivery on every unusual pane.
    expect(composerStillHolds("no prompt marker anywhere\njust output", probe)).toBe(false);
  });

  test("an empty probe never reports held", () => {
    expect(composerStillHolds(`${PROMPT}anything at all`, "")).toBe(false);
  });

  test("a different message in the composer does not match ours", () => {
    const capture = `${PROMPT}some unrelated thing the operator typed`;
    expect(composerStillHolds(capture, probe)).toBe(false);
  });

  test("the LAST prompt marker delimits the composer, not the first", () => {
    // Earlier turns leave their own prompt markers in the scrollback; using the
    // first would treat the whole transcript as composer and report everything
    // as unsent.
    const capture = [
      `${PROMPT}[peer-mail] 3 pending peer message(s) from infra.2`,
      "• Working (2s)",
      `${PROMPT}`,
    ].join("\n");
    expect(composerStillHolds(capture, probe)).toBe(false);
  });
});

describe("the shipped poller is wake-only", () => {
  // These were six `expect(source).not.toContain(...)` greps over this file's own
  // text. They are gone deliberately, not lost.
  //
  // A negative source grep passes on an empty file, on a rename, on a refactor,
  // and on any spelling nobody thought to enumerate — which is exactly how the
  // by-thread routes slipped past the first version of that guard, when it named
  // only the -by-pid pair. The assertion sat in a different layer from the defect,
  // so the suite stayed green while the property was unproven.
  //
  // The tick tests below supersede all of them and are strictly stronger: fetch is
  // stubbed to THROW, so `brokerRequests` catches ANY route — including one that
  // does not exist yet — and the row is asserted to remain undelivered. That
  // observes the layer the defect actually lives in.
  const laneFor = (overrides: Partial<Lane> = {}): Lane => ({
    id: "seat-1", name: "infra.9", pid: process.pid, client_type: "codex",
    tmux_pane_id: "%42", thread_id: "thread-1", seat_key: "pane:infra:%42",
    receiver_mode: "codex-hook", unread: 2,
    unread_episode: 1,
    last_hook_seen_at: null, ...overrides,
  } as Lane);

  test("an unobserved submit reports failure instead of claiming delivery", () => {
    // The P1 in behavioural form. submitPaneText used to return the `send-keys`
    // exit code, so tmux accepting a keystroke counted as the model having read
    // the mail. The contract now is that an unconfirmed submit says so, and it is
    // this return value that keeps delivery unclaimed. The transport attempt is
    // still cooldown-limited and bounded so a stuck composer cannot be hammered.
    expect(submitWakeOnlyNudge(laneFor(), "%42", { submit: () => false })).toBe("submit-failed");
  });

  test("a submit that throws is also a failure, never a silent success", () => {
    // The catch path had no coverage at all. A tmux call that throws must not be
    // indistinguishable from a delivered wake.
    expect(submitWakeOnlyNudge(laneFor(), "%42", {
      submit: () => { throw new Error("tmux vanished"); },
    })).toBe("submit-failed");
  });

  test("a confirmed submit is the only thing that reports success", () => {
    // Asserted from both directions: without this, an implementation that always
    // returned "submit-failed" would pass the two tests above.
    expect(submitWakeOnlyNudge(laneFor(), "%42", { submit: () => true })).toBe("submitted");
  });

  test("the real tick wakes an exact seat without claiming or acknowledging its mail", () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE peers (
      id TEXT PRIMARY KEY, name TEXT, pid INTEGER NOT NULL, client_type TEXT NOT NULL,
      tmux_pane_id TEXT, thread_id TEXT, seat_key TEXT, receiver_mode TEXT,
      last_hook_seen_at TEXT, last_drain_at TEXT, unread_episode INTEGER NOT NULL DEFAULT 0
    )`);
    db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY, to_id TEXT NOT NULL, sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, delivered_at TEXT)");
    db.run("INSERT INTO peers VALUES ('seat-1', 'infra.9', ?, 'codex', '%42', 'thread-1', 'pane:infra:%42', 'codex-hook', NULL, NULL, 1)", [process.pid]);
    db.run("INSERT INTO messages (id, to_id, sent_at, delivered) VALUES (1, 'seat-1', '2026-08-12T00:00:00.000Z', 0)");
    const snap: TickSnapshot = {
      procs: [{ pid: process.pid, ppid: 1, args: "codex resume" }],
      paneByPid: new Map([["%42", process.pid]]),
      paneMap: new Map([[process.pid, {
        session: "infra", window_index: "1", window_name: "peers", pane_index: "9", pane_id: "%42",
      }]]),
    };
    const submissions: Array<{ id: string; paneId: string }> = [];
    const brokerRequests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        brokerRequests.push(String(input));
        throw new Error("poller tick must not call the broker");
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      tick(db, snap, {
        nudgeableClients: ["codex"],
        isPidAlive: () => true,
        paneIsIdle: () => true,
        nudgeLane: (lane, paneId) => {
          submissions.push({ id: lane.id, paneId });
          return "submitted";
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(submissions).toEqual([{ id: "seat-1", paneId: "%42" }]);
    expect(brokerRequests).toEqual([]);
    expect(db.query("SELECT delivered FROM messages WHERE id = 1").get()).toEqual({ delivered: 0 });
    db.close();
  });

  test("the real tick never wakes zero-mail or delivered-only lanes", () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE peers (
      id TEXT PRIMARY KEY, name TEXT, pid INTEGER NOT NULL, client_type TEXT NOT NULL,
      tmux_pane_id TEXT, thread_id TEXT, seat_key TEXT, receiver_mode TEXT,
      last_hook_seen_at TEXT, last_drain_at TEXT, unread_episode INTEGER NOT NULL DEFAULT 0
    )`);
    db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY, to_id TEXT NOT NULL, sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, delivered_at TEXT)");
    db.run("INSERT INTO peers VALUES ('empty-seat', 'infra.empty', ?, 'codex', '%43', 'thread-empty', 'pane:infra:%43', 'codex-hook', NULL, NULL, 0)", [process.pid]);
    db.run("INSERT INTO peers VALUES ('history-seat', 'infra.history', ?, 'codex', '%44', 'thread-history', 'pane:infra:%44', 'codex-hook', NULL, NULL, 1)", [process.pid]);
    db.run("INSERT INTO messages (id, to_id, sent_at, delivered, delivered_at) VALUES (2, 'history-seat', '2026-08-12T00:00:00.000Z', 1, '2026-08-12T00:00:01.000Z')");

    const submissions: string[] = [];
    tick(db, { procs: [], paneByPid: new Map(), paneMap: new Map() }, {
      nudgeableClients: ["codex"],
      isPidAlive: () => true,
      paneIsIdle: () => true,
      nudgeLane: (lane) => {
        submissions.push(lane.id);
        return "submitted";
      },
    });

    expect(submissions).toEqual([]);
    db.close();
  });

  test("the real tick refuses a mismatched seat before the transport boundary", () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE peers (
      id TEXT PRIMARY KEY, name TEXT, pid INTEGER NOT NULL, client_type TEXT NOT NULL,
      tmux_pane_id TEXT, thread_id TEXT, seat_key TEXT, receiver_mode TEXT,
      last_hook_seen_at TEXT, last_drain_at TEXT, unread_episode INTEGER NOT NULL DEFAULT 0
    )`);
    db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY, to_id TEXT NOT NULL, sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, delivered_at TEXT)");
    db.run("INSERT INTO peers VALUES ('seat-2', 'infra.8', ?, 'codex', '%42', 'thread-2', 'pane:infra:%99', 'codex-hook', NULL, NULL, 1)", [process.pid]);
    db.run("INSERT INTO messages (id, to_id, sent_at, delivered) VALUES (2, 'seat-2', '2026-08-12T00:00:00.000Z', 0)");
    const submissions: string[] = [];
    tick(db, {
      procs: [{ pid: process.pid, ppid: 1, args: "codex resume" }],
      paneByPid: new Map([["%42", process.pid]]),
      paneMap: new Map([[process.pid, {
        session: "infra", window_index: "1", window_name: "peers", pane_index: "8", pane_id: "%42",
      }]]),
    }, {
      nudgeableClients: ["codex"],
      isPidAlive: () => true,
      paneIsIdle: () => true,
      nudgeLane: (_lane, paneId) => {
        submissions.push(paneId);
        return "submitted";
      },
    });

    expect(submissions).toEqual([]);
    expect(db.query("SELECT delivered FROM messages WHERE id = 2").get()).toEqual({ delivered: 0 });
    db.close();
  });

  test("the real tick keeps one bounded budget across a continuous unread episode", () => {
    __resetNudgeBudgetStateForTest();
    const db = new Database(":memory:");
    db.run(`CREATE TABLE peers (
      id TEXT PRIMARY KEY, name TEXT, pid INTEGER NOT NULL, client_type TEXT NOT NULL,
      tmux_pane_id TEXT, thread_id TEXT, seat_key TEXT, receiver_mode TEXT,
      last_hook_seen_at TEXT, last_drain_at TEXT, unread_episode INTEGER NOT NULL DEFAULT 0
    )`);
    db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY, to_id TEXT NOT NULL, sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, delivered_at TEXT)");
    db.run("INSERT INTO peers VALUES ('budget-seat', 'infra.budget', ?, 'codex', '%52', 'thread-budget', 'pane:infra:%52', 'codex-hook', '2026-08-12T00:00:00Z', '2026-08-12T00:00:00.000Z', 1)", [process.pid]);
    db.run("INSERT INTO messages (id, to_id, sent_at, delivered) VALUES (1, 'budget-seat', '2026-08-12T00:00:02.000Z', 0)");
    const snap: TickSnapshot = {
      procs: [{ pid: process.pid, ppid: 1, args: "codex resume" }],
      paneByPid: new Map([["%52", process.pid]]),
      paneMap: new Map([[process.pid, {
        session: "infra", window_index: "1", window_name: "peers", pane_index: "10", pane_id: "%52",
      }]]),
    };
    let now = 100_000;
    let submissions = 0;
    const runTick = () => {
      now += 61_000;
      tick(db, snap, {
        nudgeableClients: ["codex"],
        isPidAlive: () => true,
        paneIsIdle: () => true,
        now: () => now,
        nudgeLane: () => {
          submissions++;
          return "submitted";
        },
      });
    };

    for (let attempt = 0; attempt < 5; attempt++) runTick();
    expect(submissions).toBe(5);
    expect(__nudgeAttemptCountForTest("budget-seat")).toBe(5);

    // Reconciliation may merge a dead duplicate's newer health timestamp into
    // this row. That is not an inbox transition: importing t1 between the
    // target's baseline t0 and still-unread mail t2 must not buy five attempts.
    db.run("UPDATE peers SET last_drain_at = '2026-08-12T00:00:01.000Z' WHERE id = 'budget-seat'");
    runTick();
    expect(submissions).toBe(5);
    expect(__nudgeAttemptCountForTest("budget-seat")).toBe(6);

    db.run("INSERT INTO messages (id, to_id, sent_at, delivered) VALUES (2, 'budget-seat', '2026-08-12T00:00:01.000Z', 0)");
    runTick();
    expect(submissions).toBe(5);
    expect(__nudgeAttemptCountForTest("budget-seat")).toBe(6);

    db.run("UPDATE messages SET delivered = 1, delivered_at = '2026-08-12T00:00:02.000Z' WHERE id = 1");
    runTick();
    expect(submissions).toBe(5);
    expect(__nudgeAttemptCountForTest("budget-seat")).toBe(6);

    db.run("UPDATE messages SET delivered = 1, delivered_at = '2026-08-12T00:00:03.000Z'");
    runTick();
    expect(__nudgeAttemptCountForTest("budget-seat")).toBeUndefined();

    db.run("INSERT INTO messages (id, to_id, sent_at, delivered) VALUES (3, 'budget-seat', '2026-08-12T00:00:04.000Z', 0)");
    db.run("UPDATE peers SET unread_episode = 2 WHERE id = 'budget-seat'");
    runTick();
    expect(submissions).toBe(6);
    expect(__nudgeAttemptCountForTest("budget-seat")).toBe(1);
    db.close();
  });

  test("the hard cap survives a poller process restart", () => {
    __resetNudgeBudgetStateForTest();
    const root = mkdtempSync(join(tmpdir(), "claude-peers-nudge-budget-"));
    const budgetPath = join(root, "budget.json");
    const db = new Database(":memory:");
    db.run(`CREATE TABLE peers (
      id TEXT PRIMARY KEY, name TEXT, pid INTEGER NOT NULL, client_type TEXT NOT NULL,
      tmux_pane_id TEXT, thread_id TEXT, seat_key TEXT, receiver_mode TEXT,
      last_hook_seen_at TEXT, last_drain_at TEXT, unread_episode INTEGER NOT NULL DEFAULT 0
    )`);
    db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY, to_id TEXT NOT NULL, sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, delivered_at TEXT)");
    db.run("INSERT INTO peers VALUES ('restart-seat', 'infra.restart', ?, 'codex', '%62', 'thread-restart', 'pane:infra:%62', 'codex-hook', NULL, NULL, 7)", [process.pid]);
    db.run("INSERT INTO messages VALUES (1, 'restart-seat', '2026-08-12T00:00:00.000Z', 0, NULL)");
    const snap: TickSnapshot = {
      procs: [{ pid: process.pid, ppid: 1, args: "codex resume" }],
      paneByPid: new Map([["%62", process.pid]]),
      paneMap: new Map([[process.pid, {
        session: "infra", window_index: "1", window_name: "peers", pane_index: "14", pane_id: "%62",
      }]]),
    };
    let now = 100_000;
    let submissions = 0;
    const runTick = () => {
      now += 61_000;
      tick(db, snap, {
        nudgeableClients: ["codex"], isPidAlive: () => true, paneIsIdle: () => true,
        now: () => now, nudgeLane: () => {
          const onDisk = JSON.parse(readFileSync(budgetPath, "utf8"));
          expect(onDisk.peers["restart-seat"].attempts).toBe(submissions + 1);
          submissions++;
          return "submitted";
        },
      });
    };

    try {
      expect(loadNudgeBudgetState(budgetPath)).toBe(true);
      for (let count = 0; count < 5; count++) runTick();
      expect(submissions).toBe(5);
      expect(statSync(budgetPath).mode & 0o777).toBe(0o600);

      // Temporarily removing Codex from NUDGE_CLIENTS is not a mailbox drain.
      // The durable ledger must survive that absence as well as a process exit.
      tick(db, snap, {
        nudgeableClients: ["claude"], isPidAlive: () => true, paneIsIdle: () => true,
        now: () => now, nudgeLane: () => { submissions++; return "submitted"; },
      });
      expect(submissions).toBe(5);

      // Simulate a new poller process: all in-memory maps disappear, then the
      // daemon reloads the atomic ledger before its first tick.
      __resetNudgeBudgetStateForTest();
      expect(loadNudgeBudgetState(budgetPath)).toBe(true);
      expect(__nudgeAttemptCountForTest("restart-seat")).toBe(5);
      runTick();
      expect(submissions).toBe(5);
      expect(__nudgeAttemptCountForTest("restart-seat")).toBe(6);

      db.run("UPDATE messages SET delivered = 1, delivered_at = '2026-08-12T00:01:00.000Z' WHERE id = 1");
      db.run("DELETE FROM peers WHERE id = 'restart-seat'");
      runTick();
      expect(__nudgeAttemptCountForTest("restart-seat")).toBeUndefined();
      __resetNudgeBudgetStateForTest();
      expect(loadNudgeBudgetState(budgetPath)).toBe(true);
      expect(__nudgeAttemptCountForTest("restart-seat")).toBeUndefined();
    } finally {
      __resetNudgeBudgetStateForTest();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unreadable or unwritable durable ledger fails closed", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-nudge-ledger-fail-"));
    const corruptPath = join(root, "corrupt.json");
    writeFileSync(corruptPath, "", { mode: 0o600 });
    expect(loadNudgeBudgetState(corruptPath)).toBe(false);
    expect(nudgeBudgetHealthStatus()).toBe("degraded");
    writeHeartbeat();
    const heartbeatPath = process.env.CLAUDE_PEERS_AUTODRAIN_HEARTBEAT
      ?? `${process.env.HOME}/.claude-peers-autodrain.heartbeat`;
    expect(readFileSync(heartbeatPath, "utf8")).toContain("nudge_budget=degraded");

    const db = new Database(":memory:");
    db.run(`CREATE TABLE peers (
      id TEXT PRIMARY KEY, name TEXT, pid INTEGER NOT NULL, client_type TEXT NOT NULL,
      tmux_pane_id TEXT, thread_id TEXT, seat_key TEXT, receiver_mode TEXT,
      last_hook_seen_at TEXT, last_drain_at TEXT, unread_episode INTEGER NOT NULL DEFAULT 0
    )`);
    db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY, to_id TEXT NOT NULL, sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, delivered_at TEXT)");
    db.run("INSERT INTO peers VALUES ('closed-seat', 'infra.closed', ?, 'codex', '%63', 'thread-closed', 'pane:infra:%63', 'codex-hook', NULL, NULL, 1)", [process.pid]);
    db.run("INSERT INTO messages VALUES (1, 'closed-seat', '2026-08-12T00:00:00.000Z', 0, NULL)");
    const snap: TickSnapshot = {
      procs: [{ pid: process.pid, ppid: 1, args: "codex resume" }],
      paneByPid: new Map([["%63", process.pid]]),
      paneMap: new Map([[process.pid, {
        session: "infra", window_index: "1", window_name: "peers", pane_index: "15", pane_id: "%63",
      }]]),
    };
    let submissions = 0;
    const deps = {
      nudgeableClients: ["codex"], isPidAlive: () => true, paneIsIdle: () => true,
      now: () => 200_000, nudgeLane: () => { submissions++; return "submitted" as const; },
    };
    try {
      tick(db, snap, deps);
      expect(submissions).toBe(0);

      __resetNudgeBudgetStateForTest();
      const freshPath = join(root, "fresh.json");
      expect(loadNudgeBudgetState(freshPath)).toBe(true);
      expect(existsSync(freshPath)).toBe(true);
      expect(statSync(freshPath).mode & 0o777).toBe(0o600);
      tick(db, snap, deps);
      expect(submissions).toBe(1);

      __resetNudgeBudgetStateForTest();
      expect(loadNudgeBudgetState(join(root, "missing", "budget.json"))).toBe(false);
      tick(db, snap, deps);
      expect(submissions).toBe(1);
    } finally {
      __resetNudgeBudgetStateForTest();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("failed wake transports receive cooldown and stop at the same hard cap", () => {
    __resetNudgeBudgetStateForTest();
    const db = new Database(":memory:");
    db.run(`CREATE TABLE peers (
      id TEXT PRIMARY KEY, name TEXT, pid INTEGER NOT NULL, client_type TEXT NOT NULL,
      tmux_pane_id TEXT, thread_id TEXT, seat_key TEXT, receiver_mode TEXT,
      last_hook_seen_at TEXT, last_drain_at TEXT, unread_episode INTEGER NOT NULL DEFAULT 0
    )`);
    db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY, to_id TEXT NOT NULL, sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, delivered_at TEXT)");
    db.run("INSERT INTO peers VALUES ('failed-seat', 'infra.failed', ?, 'codex', '%53', 'thread-failed', 'pane:infra:%53', 'codex-hook', '2026-08-12T00:00:00Z', NULL, 1)", [process.pid]);
    db.run("INSERT INTO messages VALUES (1, 'failed-seat', '2026-08-12T00:00:00.000Z', 0, NULL)");
    const snap: TickSnapshot = {
      procs: [{ pid: process.pid, ppid: 1, args: "codex resume" }],
      paneByPid: new Map([["%53", process.pid]]),
      paneMap: new Map([[process.pid, {
        session: "infra", window_index: "1", window_name: "peers", pane_index: "11", pane_id: "%53",
      }]]),
    };
    let now = 100_000;
    let attempts = 0;
    const runTick = () => {
      now += 61_000;
      tick(db, snap, {
        nudgeableClients: ["codex"],
        isPidAlive: () => true,
        paneIsIdle: () => true,
        now: () => now,
        nudgeLane: () => { attempts++; return "submit-failed"; },
      });
    };

    for (let count = 0; count < 8; count++) runTick();
    expect(attempts).toBe(5);
    expect(__nudgeAttemptCountForTest("failed-seat")).toBe(6);
    expect(db.query("SELECT delivered FROM messages WHERE id = 1").get()).toEqual({ delivered: 0 });
    db.close();
  });

  test("copy-mode safety skips are free, while failed and confirmed transports share one budget", () => {
    __resetNudgeBudgetStateForTest();
    const db = new Database(":memory:");
    db.run(`CREATE TABLE peers (
      id TEXT PRIMARY KEY, name TEXT, pid INTEGER NOT NULL, client_type TEXT NOT NULL,
      tmux_pane_id TEXT, thread_id TEXT, seat_key TEXT, receiver_mode TEXT,
      last_hook_seen_at TEXT, last_drain_at TEXT, unread_episode INTEGER NOT NULL DEFAULT 0
    )`);
    db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY, to_id TEXT NOT NULL, sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, delivered_at TEXT)");
    db.run("INSERT INTO peers VALUES ('mixed-seat', 'infra.mixed', ?, 'codex', '%54', 'thread-mixed', 'pane:infra:%54', 'codex-hook', '2026-08-12T00:00:00Z', NULL, 1)", [process.pid]);
    db.run("INSERT INTO messages VALUES (1, 'mixed-seat', '2026-08-12T00:00:00.000Z', 0, NULL)");
    const snap: TickSnapshot = {
      procs: [{ pid: process.pid, ppid: 1, args: "codex resume" }],
      paneByPid: new Map([["%54", process.pid]]),
      paneMap: new Map([[process.pid, {
        session: "infra", window_index: "1", window_name: "peers", pane_index: "12", pane_id: "%54",
      }]]),
    };
    let now = 100_000;
    const outcomes = ["submit-failed", "submitted"] as const;
    let calls = 0;
    const runTick = (copyMode = false) => {
      now += 61_000;
      tick(db, snap, {
        nudgeableClients: ["codex"],
        isPidAlive: () => true,
        paneIsIdle: () => true,
        paneIsInCopyMode: () => copyMode,
        now: () => now,
        nudgeLane: () => outcomes[calls++]!,
      });
    };

    runTick();
    expect(__nudgeAttemptCountForTest("mixed-seat")).toBe(1);
    runTick(true);
    expect(__nudgeAttemptCountForTest("mixed-seat")).toBe(1);
    runTick();
    expect(__nudgeAttemptCountForTest("mixed-seat")).toBe(2);
    tick(db, snap, {
      nudgeableClients: ["codex"], isPidAlive: () => true, paneIsIdle: () => true,
      now: () => now, nudgeLane: () => { calls++; return "submitted"; },
    });
    expect(calls).toBe(2);
    expect(db.query("SELECT delivered FROM messages WHERE id = 1").get()).toEqual({ delivered: 0 });
    db.close();
  });

  test("a complete drain and refill between polls starts a fresh episode", () => {
    __resetNudgeBudgetStateForTest();
    const db = new Database(":memory:");
    db.run(`CREATE TABLE peers (
      id TEXT PRIMARY KEY, name TEXT, pid INTEGER NOT NULL, client_type TEXT NOT NULL,
      tmux_pane_id TEXT, thread_id TEXT, seat_key TEXT, receiver_mode TEXT,
      last_hook_seen_at TEXT, last_drain_at TEXT, unread_episode INTEGER NOT NULL DEFAULT 0
    )`);
    db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY, to_id TEXT NOT NULL, sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, delivered_at TEXT)");
    db.run("INSERT INTO peers VALUES ('refill-seat', 'infra.refill', ?, 'codex', '%55', 'thread-refill', 'pane:infra:%55', 'codex-hook', '2026-08-12T00:00:00Z', NULL, 1)", [process.pid]);
    db.run("INSERT INTO messages VALUES (1, 'refill-seat', '2026-08-12T00:00:00.000Z', 0, NULL)");
    const snap: TickSnapshot = {
      procs: [{ pid: process.pid, ppid: 1, args: "codex resume" }],
      paneByPid: new Map([["%55", process.pid]]),
      paneMap: new Map([[process.pid, {
        session: "infra", window_index: "1", window_name: "peers", pane_index: "13", pane_id: "%55",
      }]]),
    };
    let now = 100_000;
    let submissions = 0;
    const runTick = () => {
      now += 61_000;
      tick(db, snap, {
        nudgeableClients: ["codex"], isPidAlive: () => true, paneIsIdle: () => true,
        now: () => now, nudgeLane: () => { submissions++; return "submitted"; },
      });
    };

    for (let count = 0; count < 5; count++) runTick();
    db.run("UPDATE messages SET delivered = 1, delivered_at = '2026-08-12T00:00:01.000Z' WHERE id = 1");
    db.run("INSERT INTO messages VALUES (2, 'refill-seat', '2026-08-12T00:00:02.000Z', 0, NULL)");
    db.run("UPDATE peers SET unread_episode = 2 WHERE id = 'refill-seat'");
    runTick();
    expect(submissions).toBe(6);
    expect(__nudgeAttemptCountForTest("refill-seat")).toBe(1);
    db.close();
  });
});
