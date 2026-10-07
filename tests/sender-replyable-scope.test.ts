/**
 * Sender replyability is computed for every message a /poll-messages returns.
 * It used to resolve the sender against a liveness proof of every stored peer
 * row, so a queue of N messages cost N whole-table proofs. On the live host
 * 2026-10-05 that was 78% of broker CPU and stalled the event loop for seconds.
 *
 * These tests pin the routing semantics (a row competes only with rows on its
 * own seat) and the cost shape: unrelated dead rows add no liveness proofs to a
 * poll. The cost is counted, not timed. A wall-clock bound measured host load:
 * it failed at 1.5 to 4 s in a one-CPU lease with the code unchanged.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { startTestBroker, type TestBroker } from "./helpers/test-broker.ts";
import type { Message } from "../shared/types.ts";

describe("sender replyability is proved per seat", () => {
  let broker: TestBroker;
  let db: Database;
  const tokens = new Map<string, string>();
  const children = new Set<ReturnType<typeof Bun.spawn>>();

  beforeAll(async () => {
    broker = await startTestBroker({ prefix: "sender-replyable" });
    db = new Database(broker.dbPath);
    db.run("PRAGMA busy_timeout = 5000");
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

  async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const claimed = (body.id as string | undefined) ?? (body.from_id as string | undefined);
    if (claimed && tokens.has(claimed)) headers["X-Peer-Token"] = tokens.get(claimed)!;
    const res = await fetch(`${broker.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const json = (await res.json()) as Record<string, unknown>;
    if (json.id && json.token) tokens.set(json.id as string, json.token as string);
    return json as T;
  }

  function hex(bytes: number): string {
    return randomBytes(bytes).toString("hex");
  }

  // Direct row insertion: registration would merge two rows on one pane, and
  // these tests need both rows to exist side by side.
  function insertPeer(row: { id: string; pid: number; pane: string; registeredAt: string; seatKey?: string; nonTargetable?: number }) {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO peers (id, pid, cwd, registered_at, last_seen, token, tmux_session, tmux_pane_id,
         client_type, receiver_mode, seat_key, non_targetable)
       VALUES (?, ?, '/sr', ?, ?, ?, 'sr', ?, 'claude', 'claude-channel', ?, ?)`,
      [row.id, row.pid, row.registeredAt, now, `tok-${row.id}`, row.pane, row.seatKey ?? null, row.nonTargetable ?? 0],
    );
    tokens.set(row.id, `tok-${row.id}`);
  }

  function queue(from: string, to: string, text: string) {
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?)", [from, to, text, new Date().toISOString()]);
  }

  async function registerTarget(name: string, pane: string) {
    return call<{ id: string }>("/register", {
      pid: spawnHolder(), cwd: `/sr/${name}`, git_root: `/sr/${name}`, name,
      client_type: "claude", receiver_mode: "claude-channel",
      tmux_session: "sr", tmux_window_index: "0", tmux_window_name: "w", tmux_pane_id: pane,
    });
  }

  async function replyableBySender(targetId: string): Promise<Map<string, boolean | number | undefined>> {
    const inbox = await call<{ messages: Message[] }>("/poll-messages", { id: targetId });
    return new Map(inbox.messages.map((m) => [m.from_id, m.from_replyable]));
  }

  test("only the active row of a shared seat is replyable", async () => {
    const target = await registerTarget("sr-target-a", "%950");
    const older = `old${hex(3)}`;
    const newer = `new${hex(3)}`;
    insertPeer({ id: older, pid: spawnHolder(), pane: "%951", registeredAt: "2026-10-01T00:00:00.000Z" });
    insertPeer({ id: newer, pid: spawnHolder(), pane: "%951", registeredAt: "2026-10-02T00:00:00.000Z" });
    queue(older, target.id, "from the superseded row");
    queue(newer, target.id, "from the active row");
    queue(newer, target.id, "second message from the active row");

    const replyable = await replyableBySender(target.id);
    expect(replyable.get(newer)).toBe(1);
    expect(replyable.get(older)).toBe(0);
  });

  test("unknown, non-targetable and dead senders stay non-replyable", async () => {
    const target = await registerTarget("sr-target-b", "%960");
    const hidden = `hid${hex(3)}`;
    const dead = `ded${hex(3)}`;
    insertPeer({ id: hidden, pid: spawnHolder(), pane: "%961", registeredAt: new Date().toISOString(), nonTargetable: 1 });
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    insertPeer({ id: dead, pid: gone.pid, pane: "%962", registeredAt: new Date().toISOString() });
    queue("nosuchpeer", target.id, "from nobody");
    queue(hidden, target.id, "from a send-only identity");
    queue(dead, target.id, "from a dead seat");

    const replyable = await replyableBySender(target.id);
    expect(replyable.get("nosuchpeer")).toBe(0);
    expect(replyable.get(hidden)).toBe(0);
    expect(replyable.get(dead)).toBe(0);
  });

  // The broker counts every seat liveness probe (a pid probe or a runtime-group
  // proof) in the authenticated /metrics aggregate. Equal counts at two table
  // sizes prove that a poll's proofs do not depend on unrelated rows, whatever
  // the host load. Reverting to a whole-table proof adds one probe per stored
  // row per sender and fails the equality. Only the proofs are seat-scoped:
  // each sender's resolution still reads every targetable row, so wall time
  // stays linear in the table and is deliberately not asserted here.
  async function probesSoFar(id: string): Promise<number> {
    const metrics = await call<{ seat_liveness_probes?: number }>("/metrics", { id });
    expect(typeof metrics.seat_liveness_probes).toBe("number");
    return metrics.seat_liveness_probes!;
  }

  async function pollProbes(targetId: string): Promise<{ probes: number; replyable: Map<string, boolean | number | undefined> }> {
    const before = await probesSoFar(targetId);
    const replyable = await replyableBySender(targetId);
    return { probes: (await probesSoFar(targetId)) - before, replyable };
  }

  test("unrelated dead rows add no liveness proofs to a poll", async () => {
    const target = await registerTarget("sr-target-c", "%970");
    const senders: string[] = [];
    for (let i = 0; i < 25; i++) {
      const id = `snd${hex(3)}`;
      insertPeer({ id, pid: spawnHolder(), pane: `%97${i + 10}`, registeredAt: new Date().toISOString() });
      senders.push(id);
    }
    for (const sender of senders) queue(sender, target.id, `from ${sender}`);

    const small = await pollProbes(target.id);
    expect(small.replyable.size).toBe(senders.length);
    for (const sender of senders) expect(small.replyable.get(sender)).toBe(1);
    // Non-vacuous: every distinct sender is proved once. A counter that never
    // moves would make the equality below pass for any implementation.
    expect(small.probes).toBeGreaterThanOrEqual(senders.length);

    // Ended runtime-group rows look like the 1,400+ rows found on the live host:
    // each one needs a database read and a procfs read to prove it is gone. The
    // assertion is exact, so the table only has to dwarf the sender count.
    const insert = db.prepare(
      `INSERT INTO peers (id, pid, cwd, registered_at, last_seen, token, tmux_session, tmux_pane_id,
         client_type, receiver_mode, seat_key, non_targetable)
       VALUES (?, ?, '/sr', ?, ?, ?, 'sr', ?, 'claude', 'claude-channel', ?, 0)`,
    );
    const iso = new Date().toISOString();
    db.transaction(() => {
      for (let i = 0; i < 1000; i++) {
        insert.run(`dd${hex(4)}`, 4_000_000 + i, iso, iso, null, `%${20000 + i}`, `live:${hex(32)}:native:${hex(32)}`);
      }
    })();

    // /poll-messages is read-only, so the same 25 messages come back.
    const large = await pollProbes(target.id);
    expect(large.replyable.size).toBe(senders.length);
    for (const sender of senders) expect(large.replyable.get(sender)).toBe(1);
    expect(large.probes).toBe(small.probes);
  }, 60_000);
});
