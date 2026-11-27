import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { blockedScreenReason, tick, __resetNudgeBudgetStateForTest, type TickSnapshot } from "../bin/codex-autodrain-poller.ts";

const T0 = Date.parse("2026-11-23T12:30:00.000Z");
const MIN = 60_000;

// The screen an agy lane showed on 2026-11-23 after its quota ran out.
const AGY_QUOTA_SCREEN = [
  "> [peer-mail] Process the attached peer messages. If none are attached, fetch pending mail with check_messages.",
  "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 28m45s.",
  "Error ID: ad87fd3b-84a4-4947-a5f1-e47b3f180907-560",
  " How’s the CLI experience so far? Help us improve:",
  " [1] Good  [2] Fine  [3] Bad  [0] Skip",
  "? for shortcuts                                    accept-edits · Gemini 4 Carbon · medium",
].join("\n");

function fixture(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE peers (
    id TEXT PRIMARY KEY, name TEXT, pid INTEGER NOT NULL, client_type TEXT NOT NULL,
    tmux_pane_id TEXT, thread_id TEXT, seat_key TEXT, receiver_mode TEXT,
    last_hook_seen_at TEXT, last_drain_at TEXT, unread_episode INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE TABLE messages (id INTEGER PRIMARY KEY, to_id TEXT NOT NULL, text TEXT NOT NULL,
    sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, delivered_at TEXT)`);
  db.run("INSERT INTO peers VALUES (\x27seat-1\x27, \x27review-agy-1123b\x27, ?, \x27claude\x27, \x27%42\x27, NULL, \x27pane:C5:%42\x27, \x27claude-channel\x27, NULL, NULL, 1)", [process.pid]);
  db.run("INSERT INTO messages VALUES (1, \x27seat-1\x27, \x27review this\x27, ?, 0, NULL)", [new Date(T0 - 20 * MIN).toISOString()]);
  return db;
}

const snap: TickSnapshot = {
  procs: [{ pid: process.pid, ppid: 1, args: "claude" }],
  paneByPid: new Map([["%42", process.pid]]),
  paneMap: new Map([[process.pid, { session: "C5", window_index: "1", window_name: "w", pane_index: "1", pane_id: "%42" }]]),
};

function runTick(db: Database, nowMs: number, idle: boolean, logs: string[]): number {
  let wakes = 0;
  tick(db, snap, {
    nudgeableClients: ["claude"],
    isPidAlive: () => true,
    paneIsIdle: () => idle,
    paneIsInCopyMode: () => false,
    capturePane: () => AGY_QUOTA_SCREEN,
    log: (m) => logs.push(m),
    stuckWakeWarnMs: 10 * MIN,
    wakeBatchMs: 0,
    now: () => nowMs,
    nudgeLane: () => { wakes++; return "submitted"; },
  });
  return wakes;
}

describe("blockedScreenReason", () => {
  test("names the agy quota error and its feedback survey", () => {
    expect(blockedScreenReason(AGY_QUOTA_SCREEN)).toBe("quota reached, feedback survey");
  });

  test("names an authentication error", () => {
    expect(blockedScreenReason("● Bash(x)\n⚠ UNAUTHENTICATED (code 401): Request had invalid authentication credentials.\n")).toBe("authentication error");
  });

  test("quotes the last visible line when nothing known matches, ignoring ANSI", () => {
    expect(blockedScreenReason("\x1b[1mworking on it\x1b[0m\n• Working (23m 54s • esc to interrupt)\n\n")).toBe("last line: \"• Working (23m 54s • esc to interrupt)\"");
    expect(blockedScreenReason("\n\n")).toBe("empty screen");
  });
});

describe("poller logs a lane whose pane stays busy with unread mail", () => {
  test("silent before the bound, one line after it, none on later ticks, and re-armed after the pane goes idle", () => {
    __resetNudgeBudgetStateForTest();
    const db = fixture();
    const logs: string[] = [];
    const waiting = () => logs.filter((l) => l.startsWith("wake waiting on"));
    try {
      expect(runTick(db, T0, false, logs)).toBe(0);
      expect(runTick(db, T0 + 9 * MIN, false, logs)).toBe(0);
      expect(waiting()).toEqual([]);

      expect(runTick(db, T0 + 10 * MIN, false, logs)).toBe(0);
      expect(waiting()).toEqual([
        "wake waiting on review-agy-1123b/seat-1 pane=%42: 1 unread, pane not idle for 10m (quota reached, feedback survey)",
      ]);
      runTick(db, T0 + 30 * MIN, false, logs);
      expect(waiting().length).toBe(1);

      // The pane comes back: the lane is woken and the warning re-arms.
      expect(runTick(db, T0 + 31 * MIN, true, logs)).toBe(1);
      runTick(db, T0 + 40 * MIN, false, logs);
      runTick(db, T0 + 51 * MIN, false, logs);
      expect(waiting().length).toBe(2);
    } finally {
      db.close();
    }
  });
});
