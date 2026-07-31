/**
 * /ack-messages must record that a drain happened.
 *
 * Measured 2026-07-31, and the reason this file exists: a cursor lane had acked
 * four messages with last_drain_at still NULL, and a Claude lane acked 23 while
 * the column read 34 minutes stale. Both were draining correctly. The by-pid hook
 * routes stamp drain health; this token-authed route did not — and it is the ONLY
 * route a client without a drain hook (cursor, kimi) ever uses.
 *
 * The cost of the gap is not cosmetic: recipientDeliveryHealth reads last_drain_at
 * to decide whether to warn a sender that its mail is going nowhere. A permanently
 * NULL column means every sender to a healthy nudge-driven lane is told the lane is
 * not reading — which is exactly the false alarm that made cursor look broken.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { startTestBroker, type TestBroker } from "./helpers/test-broker.ts";

describe("/ack-messages drain telemetry", () => {
  let broker: TestBroker;
  const tokens = new Map<string, string>();
  const children = new Set<ReturnType<typeof Bun.spawn>>();

  beforeAll(async () => {
    broker = await startTestBroker({ prefix: "drain-stamp" });
  }, 35_000);

  afterAll(async () => {
    for (const child of children) child.kill();
    await broker.stop();
  });

  function spawnHolder(): number {
    const child = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
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

  async function register(name: string, clientType: string, receiverMode: string, pane: string | null) {
    const json = await call<{ id: string }>("/register", {
      pid: spawnHolder(), cwd: `/ds/${name}`, git_root: `/ds/${name}`, name,
      client_type: clientType, receiver_mode: receiverMode,
      tmux_session: pane ? "ds" : null, tmux_window_index: pane ? "0" : null,
      tmux_window_name: pane ? "w" : null, tmux_pane_id: pane,
    });
    return json.id;
  }

  function drainAt(id: string): string | null {
    const db = new Database(broker.dbPath, { readonly: true });
    const row = db.query("SELECT last_drain_at FROM peers WHERE id = ?").get(id) as { last_drain_at: string | null };
    db.close();
    return row.last_drain_at;
  }

  test("stamps last_drain_at for a client that has NO hook route at all", async () => {
    // cursor is the case the gap was found on: manual-drain, nudged by the poller,
    // and it never touches /poll-by-pid — so this route is its only chance to
    // report that it read its mail.
    const cursor = await register("ds-cursor", "cursor", "manual-drain", "%3001");
    const sender = await register("ds-sender", "claude", "claude-channel", "%3002");
    expect(drainAt(cursor)).toBeNull();

    const sent = await call<{ id: number }>("/send-message", {
      from_id: sender, to_id: cursor, text: "read me",
    });
    const acked = await call<{ acked: number }>("/ack-messages", {
      id: cursor, ids: [sent.id], via: "check_messages",
    });
    expect(acked.acked).toBe(1);

    const stamped = drainAt(cursor);
    expect(stamped).not.toBeNull();
    expect(Date.now() - new Date(stamped!).getTime()).toBeLessThan(60_000);
  });

  test("does not stamp when the ack acknowledged nothing", async () => {
    // A no-op ack (already-delivered ids, or ids belonging to another peer) is not
    // evidence of a drain. Stamping it would let a lane look healthy forever by
    // acking mail it never received.
    const lane = await register("ds-noop", "cursor", "manual-drain", "%3003");
    const other = await register("ds-other", "cursor", "manual-drain", "%3004");
    const sender = await register("ds-sender2", "claude", "claude-channel", "%3005");

    const sent = await call<{ id: number }>("/send-message", {
      from_id: sender, to_id: other, text: "not for ds-noop",
    });
    const acked = await call<{ acked: number }>("/ack-messages", {
      id: lane, ids: [sent.id], via: "check_messages",
    });
    expect(acked.acked).toBe(0);
    expect(drainAt(lane)).toBeNull();
  });

  test("the stamp advances on a later drain rather than sticking at the first", async () => {
    // The staleness this fixes was a column frozen at an old value while drains
    // kept happening — so "not null" is not enough, it has to move.
    const lane = await register("ds-advance", "kimi", "manual-drain", "%3006");
    const sender = await register("ds-sender3", "claude", "claude-channel", "%3007");

    const first = await call<{ id: number }>("/send-message", { from_id: sender, to_id: lane, text: "one" });
    await call("/ack-messages", { id: lane, ids: [first.id], via: "check_messages" });
    const firstStamp = drainAt(lane)!;

    await Bun.sleep(1100);   // ISO timestamps are second-resolution in places; clear the boundary
    const second = await call<{ id: number }>("/send-message", { from_id: sender, to_id: lane, text: "two" });
    await call("/ack-messages", { id: lane, ids: [second.id], via: "check_messages" });
    const secondStamp = drainAt(lane)!;

    expect(new Date(secondStamp).getTime()).toBeGreaterThan(new Date(firstStamp).getTime());
  });

  test("a drained nudge-driven lane no longer warns its senders", async () => {
    // The end the fix is for: sending to a cursor lane that HAS drained must not
    // tell the sender its mail is stranded.
    const lane = await register("ds-health", "cursor", "manual-drain", "%3008");
    const sender = await register("ds-sender4", "claude", "claude-channel", "%3009");

    const first = await call<{ id: number }>("/send-message", { from_id: sender, to_id: lane, text: "first" });
    await call("/ack-messages", { id: lane, ids: [first.id], via: "check_messages" });

    const next = await call<{
      warning?: string;
      recipient?: { state?: string; last_drain_at?: string | null; warning?: string | null };
    }>("/send-message", { from_id: sender, to_id: lane, text: "second" });
    expect(next.recipient?.state).toBe("healthy");
    expect(next.recipient?.last_drain_at).not.toBeNull();
    expect(next.recipient?.warning).toBeNull();
    expect(next.warning).toBeUndefined();
  });
});
