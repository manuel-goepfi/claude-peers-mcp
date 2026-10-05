/**
 * Ended runtime mailbox groups must leave the peer table.
 *
 * liveAndFreshPeers used to return early for every `live:` seat, so a group
 * whose native process had ended was never reaped. On the live host
 * (2026-10-05) 1,464 of 1,541 rows were such leftovers and every whole-table
 * scan proved each one dead again. A group row is now retired through the
 * ordinary dead-seat path, but only once its pinned process has provably ended:
 * a transient proof failure (no tmux, no procfs evidence) keeps the row.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { startTestBroker, type TestBroker } from "./helpers/test-broker.ts";
import { currentSeatProcessKey } from "../shared/live-runtime-proof.ts";

const HOUR_MS = 3_600_000;
// Above the kernel's pid_max ceiling (2^22), so kill(pid, 0) is always ESRCH.
const NEVER_A_PID = 4_194_400;

describe("ended runtime mailbox groups are reaped", () => {
  let broker: TestBroker;
  let db: Database;
  let caller: { id: string; token: string };
  const children = new Set<ReturnType<typeof Bun.spawn>>();

  beforeAll(async () => {
    broker = await startTestBroker({ prefix: "live-group-reap" });
    db = new Database(broker.dbPath);
    db.run("PRAGMA busy_timeout = 5000");
    const res = await fetch(`${broker.url}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pid: spawnHolder(), cwd: "/lgr", git_root: "/lgr", name: "lgr-caller",
        client_type: "claude", receiver_mode: "claude-channel",
        tmux_session: "lgr", tmux_window_index: "0", tmux_window_name: "w", tmux_pane_id: "%990",
      }),
    });
    caller = (await res.json()) as { id: string; token: string };
  }, 35_000);

  afterAll(async () => {
    for (const child of children) child.kill();
    db.close();
    await broker.stop();
  });

  function spawnHolder(): number {
    const child = Bun.spawn(["sleep", "120"], { stdout: "ignore", stderr: "ignore" });
    children.add(child);
    return child.pid;
  }

  const hex = (bytes: number) => randomBytes(bytes).toString("hex");

  function insertGroupRow(pid: number, processKey: string, lastSeenAgoMs: number): string {
    const id = `lg${hex(3)}`;
    const lastSeen = new Date(Date.now() - lastSeenAgoMs).toISOString();
    db.run(
      `INSERT INTO peers (id, pid, cwd, registered_at, last_seen, token, tmux_session, tmux_pane_id,
         client_type, receiver_mode, thread_id, seat_key, non_targetable)
       VALUES (?, ?, '/lgr', ?, ?, ?, 'lgr', ?, 'claude', 'claude-channel', ?, ?, 0)`,
      [id, pid, lastSeen, lastSeen, `tok-${id}`, `%${30000 + Math.floor(Math.random() * 10000)}`,
        crypto.randomUUID(), `live:${hex(32)}:native:${processKey}`],
    );
    return id;
  }

  const exists = (id: string) => Boolean(db.query("SELECT 1 FROM peers WHERE id = ?").get(id));

  async function sweepViaListPeers(): Promise<void> {
    const res = await fetch(`${broker.url}/list-peers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Peer-Token": caller.token },
      body: JSON.stringify({ id: caller.id, scope: "machine", cwd: "/lgr", git_root: null }),
    });
    expect(res.status).toBe(200);
  }

  test("an ended group past the rehydrate window is deleted", async () => {
    const id = insertGroupRow(NEVER_A_PID, hex(32), 2 * HOUR_MS);
    await sweepViaListPeers();
    expect(exists(id)).toBe(false);
  });

  test("a reused pid is a different incarnation and counts as ended", async () => {
    const id = insertGroupRow(spawnHolder(), hex(32), 2 * HOUR_MS);
    await sweepViaListPeers();
    expect(exists(id)).toBe(false);
  });

  test("an ended group inside the rehydrate window is kept", async () => {
    const id = insertGroupRow(NEVER_A_PID, hex(32), 10 * 60_000);
    await sweepViaListPeers();
    expect(exists(id)).toBe(true);
  });

  test("an ended group holding undelivered mail is kept as a recoverable inbox", async () => {
    const id = insertGroupRow(NEVER_A_PID, hex(32), 2 * HOUR_MS);
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, 'held', ?)", [caller.id, id, new Date().toISOString()]);
    await sweepViaListPeers();
    expect(exists(id)).toBe(true);
  });

  test("a live incarnation without a runtime proof is never reaped", async () => {
    const pid = spawnHolder();
    const key = currentSeatProcessKey(pid);
    expect(key).not.toBeNull();
    // No tmux pane or account proof exists for this holder, so the group is
    // not current; the pinned process is still the same incarnation.
    const id = insertGroupRow(pid, key!, 2 * HOUR_MS);
    await sweepViaListPeers();
    expect(exists(id)).toBe(true);
  });
});
