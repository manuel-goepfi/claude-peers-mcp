import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startTestBroker, type TestBroker } from "./helpers/test-broker.ts";

let broker: TestBroker;
const children: ReturnType<typeof Bun.spawn>[] = [];
const tokens = new Map<string, string>();
beforeAll(async () => { broker = await startTestBroker({ prefix: "seat-routing-stability" }); });
afterAll(async () => {
  for (const child of children) { child.kill(); await child.exited; }
  await broker?.stop();
});
async function call(path: string, body: Record<string, unknown>) {
  const id = (body.id ?? body.from_id) as string;
  const res = await fetch(`${broker.url}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Peer-Token": tokens.get(id) ?? "" },
    body: JSON.stringify(body),
  });
  const result = await res.json() as any;
  if (result.id && result.token) tokens.set(result.id, result.token);
  return result;
}
async function register(pane: string, thread?: string) {
  const child = Bun.spawn(["sleep", "120"], { stdout: "ignore", stderr: "ignore" });
  children.push(child);
  return call("/register", {
    pid: child.pid, cwd: "/routing-test", git_root: "/routing-test", name: `routing${pane}.1`,
    tmux_session: "routing-test", tmux_pane_id: pane, client_type: "claude", receiver_mode: "claude-channel",
    ...(thread ? { thread_id: thread } : {}),
  });
}

test("a live candidate stays sendable when its sibling heartbeats", async () => {
  const bound = await register("%991", "10000000-0000-4000-8000-000000000001");
  const adapter = await register("%991");
  expect(adapter.id).not.toBe(bound.id);
  const sender = await register("%992");
  // Bound session is the live candidate; the unbound adapter then heartbeats
  // between the failed send and retry, exactly as in the observed incident.
  await Bun.sleep(5);
  await call("/heartbeat", { id: bound.id });
  const stale = await call("/send-message", { from_id: sender.id, to_id: adapter.id, text: "first attempt" });
  expect(stale.code).toBe("STALE_PEER_ID");
  expect(stale.candidates.map((p: { id: string }) => p.id)).toEqual([bound.id]);
  for (let i = 0; i < 3; i++) {
    await Bun.sleep(5);
    await call("/heartbeat", { id: adapter.id });
    const retry = await call("/send-message", { from_id: sender.id, to_id: bound.id, text: `retry ${i}` });
    expect(retry.ok).toBe(true);
    await call("/heartbeat", { id: bound.id });
  }
});


test("distinct conversations retain a stable newest registration across heartbeats", async () => {
  const old = await register("%993", "10000000-0000-4000-8000-000000000002");
  await Bun.sleep(5);
  const current = await register("%993", "10000000-0000-4000-8000-000000000003");
  const sender = await register("%994");
  for (const id of [old.id, current.id, old.id]) {
    await Bun.sleep(5);
    await call("/heartbeat", { id });
    const stale = await call("/send-message", { from_id: sender.id, to_id: old.id, text: "old conversation" });
    expect(stale.code).toBe("STALE_PEER_ID");
    expect(stale.candidates.map((p: { id: string }) => p.id)).toEqual([current.id]);
    expect((await call("/send-message", { from_id: sender.id, to_id: current.id, text: "current" })).ok).toBe(true);
  }
});

test("legacy duplicate registrations with tied timestamps resolve consistently", async () => {
  const first = await register("%995", "10000000-0000-4000-8000-000000000004");
  const second = await register("%995", "10000000-0000-4000-8000-000000000005");
  // Seed only the isolated fixture's legacy state; never modify a live DB.
  const db = new Database(broker.dbPath);
  try { db.run("UPDATE peers SET registered_at = '2026-01-01T00:00:00.000Z' WHERE id IN (?, ?)", [first.id, second.id]); }
  finally { db.close(); }
  const sender = await register("%996");
  const [loser, winner] = [first.id, second.id].sort();
  for (const id of [loser, winner, loser]) {
    await Bun.sleep(5);
    await call("/heartbeat", { id });
    const sent = await call("/send-message", { from_id: sender.id, to_id: winner, text: "stable tie" });
    expect(sent.ok).toBe(true);
  }
});
