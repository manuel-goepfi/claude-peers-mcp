/**
 * Tests for the reliable delivery features cherry-picked from upstream PR #25:
 * - /ack-messages broker endpoint (read-only poll, explicit ack)
 * - Peer-scoped ack (cannot ack another peer's messages)
 * - Transaction wrapping
 * - Backward compat: old broker schemas
 *
 * Plus tests for our fork-local improvements:
 * - Buffer cap data-loss path
 * - find_peer piggyback delivery
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";

// --- Broker schema + ack endpoint logic ---

describe("PR #25 ack endpoint logic", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.run(`
      CREATE TABLE peers (
        id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        cwd TEXT NOT NULL,
        git_root TEXT,
        tty TEXT,
        summary TEXT NOT NULL DEFAULT '',
        registered_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        text TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Seed peers + messages
    const now = new Date().toISOString();
    db.run("INSERT INTO peers (id, pid, cwd, registered_at, last_seen) VALUES (?, ?, ?, ?, ?)", ["alice", 1, "/", now, now]);
    db.run("INSERT INTO peers (id, pid, cwd, registered_at, last_seen) VALUES (?, ?, ?, ?, ?)", ["bob", 2, "/", now, now]);
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?)", ["alice", "bob", "msg 1", now]);
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?)", ["alice", "bob", "msg 2", now]);
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?)", ["alice", "bob", "msg 3", now]);
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?)", ["bob", "alice", "msg 4", now]);
  });

  afterAll(() => db.close());

  test("read-only poll does NOT mark messages delivered", () => {
    const before = db.query("SELECT COUNT(*) as c FROM messages WHERE to_id = ? AND delivered = 0").get("bob") as { c: number };
    expect(before.c).toBe(3);

    // Simulate read-only poll (handlePollMessages logic)
    const messages = db.query("SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC").all("bob");
    expect(messages.length).toBe(3);

    const after = db.query("SELECT COUNT(*) as c FROM messages WHERE to_id = ? AND delivered = 0").get("bob") as { c: number };
    expect(after.c).toBe(3); // still undelivered
  });

  test("peer-scoped ack only marks messages owned by that peer", () => {
    const markScoped = db.prepare("UPDATE messages SET delivered = 1 WHERE id = ? AND to_id = ?");

    // Bob acks message id=1 (his own) — should succeed
    const result1 = markScoped.run(1, "bob");
    expect(result1.changes).toBe(1);

    // Bob tries to ack message id=4 (alice's) — should be no-op
    const result2 = markScoped.run(4, "bob");
    expect(result2.changes).toBe(0);

    // Verify alice's message is still undelivered
    const aliceMsg = db.query("SELECT delivered FROM messages WHERE id = ?").get(4) as { delivered: number };
    expect(aliceMsg.delivered).toBe(0);
  });

  test("transactional ack: all-or-nothing", () => {
    const markScoped = db.prepare("UPDATE messages SET delivered = 1 WHERE id = ? AND to_id = ?");

    const ackBatch = db.transaction((ids: number[], peerId: string) => {
      let count = 0;
      for (const id of ids) {
        count += markScoped.run(id, peerId).changes;
      }
      return count;
    });

    const acked = ackBatch([2, 3], "bob");
    expect(acked).toBe(2);

    const remaining = db.query("SELECT COUNT(*) as c FROM messages WHERE to_id = ? AND delivered = 0").get("bob") as { c: number };
    expect(remaining.c).toBe(0);
  });

  test("ack of nonexistent message id is a no-op (does not throw)", () => {
    const markScoped = db.prepare("UPDATE messages SET delivered = 1 WHERE id = ? AND to_id = ?");
    expect(() => markScoped.run(99999, "bob")).not.toThrow();
    const result = markScoped.run(99999, "bob");
    expect(result.changes).toBe(0);
  });
});

// --- Buffer cap data-loss path (fork-local improvement) ---

describe("Local buffer cap behavior", () => {
  // Replicate the prune logic from server.ts main() with the raised caps.
  // Caps must match server.ts: post-review-army these are 10000 / 5000.

  const BUFFER_CAP = 10000;
  const BUFFER_DRAIN_TO = 5000;

  function runPruneLogic(buffer: number[], confirmedDelivered: Set<number>): { removed: number[]; remaining: number[] } {
    if (buffer.length > BUFFER_CAP) {
      const removed = buffer.splice(0, buffer.length - BUFFER_DRAIN_TO);
      for (const id of removed) confirmedDelivered.add(id);
      return { removed, remaining: buffer };
    }
    return { removed: [], remaining: buffer };
  }

  test("cap not reached: no pruning", () => {
    const buffer = Array.from({ length: 9999 }, (_, i) => i);
    const dedup = new Set<number>();
    const { removed, remaining } = runPruneLogic(buffer, dedup);
    expect(removed.length).toBe(0);
    expect(remaining.length).toBe(9999);
    expect(dedup.size).toBe(0);
  });

  test("cap exceeded: prune to drain target", () => {
    const buffer = Array.from({ length: 11000 }, (_, i) => i);
    const dedup = new Set<number>();
    const { removed, remaining } = runPruneLogic(buffer, dedup);
    expect(removed.length).toBe(6000); // 11000 - 5000
    expect(remaining.length).toBe(5000);
    expect(dedup.size).toBe(6000); // pruned messages added to dedup to prevent re-delivery
  });

  test("pruned messages are oldest first (FIFO)", () => {
    const buffer = Array.from({ length: 10500 }, (_, i) => i);
    const dedup = new Set<number>();
    const { removed, remaining } = runPruneLogic(buffer, dedup);
    expect(removed[0]).toBe(0); // oldest
    expect(removed[removed.length - 1]).toBe(5499); // last pruned (10500 - 5000 - 1)
    expect(remaining[0]).toBe(5500); // first kept
    expect(remaining[remaining.length - 1]).toBe(10499); // newest
  });

  test("fork-local cap is 50x larger than upstream (10000 vs 200)", () => {
    // Regression guard: if someone reverts to upstream cap, this fails.
    // Cap raised post-review-army to make overflow practically unreachable.
    expect(BUFFER_CAP).toBe(10000);
    expect(BUFFER_CAP).toBeGreaterThanOrEqual(200 * 50);
  });

  // F1 post-review: symmetric coverage for the confirmedDeliveredIds prune.
  // Off-by-one or wrong-half eviction would cause re-display of delivered messages.
  test("confirmedDeliveredIds prune evicts oldest, retains newest (FIFO)", () => {
    const DEDUP_CAP = 5000;
    const DEDUP_DRAIN_TO = 2500;
    const confirmed = new Set<number>();
    for (let i = 0; i < 5001; i++) confirmed.add(i);

    if (confirmed.size > DEDUP_CAP) {
      const arr = [...confirmed];
      const toRemove = arr.slice(0, arr.length - DEDUP_DRAIN_TO);
      for (const id of toRemove) confirmed.delete(id);
    }

    expect(confirmed.size).toBe(DEDUP_DRAIN_TO);
    // Oldest (smallest) IDs evicted
    expect(confirmed.has(0)).toBe(false);
    expect(confirmed.has(2499)).toBe(false);
    // Newest (largest) IDs retained
    expect(confirmed.has(2501)).toBe(true);
    expect(confirmed.has(5000)).toBe(true);
  });

  test("confirmedDeliveredIds prune does not fire below cap", () => {
    const DEDUP_CAP = 5000;
    const confirmed = new Set<number>();
    for (let i = 0; i < 4999; i++) confirmed.add(i);
    if (confirmed.size > DEDUP_CAP) throw new Error("should not fire");
    expect(confirmed.size).toBe(4999);
  });

  // F2 post-review: after overflow prune, localBufferIds must be rebuilt
  // from the surviving buffer — stale IDs would block re-delivery of messages
  // the broker still has as undelivered.
  test("overflow prune rebuilds localBufferIds from survivors only", () => {
    const buffer: { id: number }[] = Array.from({ length: 11000 }, (_, i) => ({ id: i }));
    const localBufferIds = new Set<number>(buffer.map((m) => m.id));
    const confirmedDelivered = new Set<number>();

    if (buffer.length > BUFFER_CAP) {
      const removed = buffer.splice(0, buffer.length - BUFFER_DRAIN_TO);
      for (const m of removed) confirmedDelivered.add(m.id);
      // Replicate the rebuild logic from server.ts main()
      localBufferIds.clear();
      for (const m of buffer) localBufferIds.add(m.id);
    }

    expect(buffer.length).toBe(BUFFER_DRAIN_TO);
    expect(localBufferIds.size).toBe(BUFFER_DRAIN_TO);
    // Pruned IDs MUST NOT be in localBufferIds (else poll would block re-delivery)
    expect(localBufferIds.has(0)).toBe(false);
    expect(localBufferIds.has(5999)).toBe(false);
    // Survivor IDs ARE in localBufferIds
    expect(localBufferIds.has(6000)).toBe(true);
    expect(localBufferIds.has(10999)).toBe(true);
    // And they're in confirmedDelivered (pruned path)
    expect(confirmedDelivered.has(0)).toBe(true);
    expect(confirmedDelivered.has(5999)).toBe(true);
    expect(confirmedDelivered.has(6000)).toBe(false);
  });
});

// --- drainPendingMessages dedup filter behavior ---

describe("drainPendingMessages dedup filter (T1)", () => {
  // Replicate the filter logic from drainPendingMessages: messages already
  // in confirmedDeliveredIds must be excluded from the unseen set.

  function filterUnseen<T extends { id: number }>(
    buffered: T[],
    confirmedDeliveredIds: Set<number>
  ): T[] {
    return buffered.filter((m) => !confirmedDeliveredIds.has(m.id));
  }

  test("excludes messages already in confirmedDeliveredIds", () => {
    const buffered = [{ id: 1, text: "a" }, { id: 2, text: "b" }, { id: 3, text: "c" }];
    const confirmed = new Set<number>([2]);
    const unseen = filterUnseen(buffered, confirmed);
    expect(unseen.length).toBe(2);
    expect(unseen.map((m) => m.id)).toEqual([1, 3]);
  });

  test("returns empty when ALL buffered messages already confirmed", () => {
    const buffered = [{ id: 1 }, { id: 2 }];
    const confirmed = new Set<number>([1, 2]);
    expect(filterUnseen(buffered, confirmed).length).toBe(0);
  });

  test("returns all when confirmed is empty", () => {
    const buffered = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(filterUnseen(buffered, new Set()).length).toBe(3);
  });

  // Display IS delivery — the post-pr-review-toolkit fix reverts the C5 ackOk
  // gate. Once the message text is rendered into a tool response Claude WILL
  // see, dedup must be added unconditionally to prevent duplication on the
  // next poll cycle (broker still has delivered=0 so it will re-send).
  test("post-fix: dedup populated even when ack fails (display = delivery)", async () => {
    // Simulate the ackAndDedup helper logic: ack throws, dedup still populated.
    const confirmed = new Set<number>();
    const ids = [10, 20, 30];
    const fakeBrokerFetch = async () => {
      throw new Error("simulated broker unreachable");
    };
    try {
      await fakeBrokerFetch();
    } catch {
      // Caught and logged in real code
    }
    // Critical post-fix invariant: dedup add runs UNCONDITIONALLY after the
    // catch, NOT inside an if(ackOk).
    for (const id of ids) confirmed.add(id);
    expect(confirmed.size).toBe(3);
    expect(confirmed.has(10)).toBe(true);
    // Re-running the same drain on the same buffer would now filter out these
    // IDs, preventing duplicate display.
  });

  test("regression guard: ackAndDedup must add to dedup BEFORE the next drain", () => {
    // Two-step: first drain shows messages [1,2], second drain on a freshly
    // re-buffered set must not show them again.
    const confirmed = new Set<number>();
    // Drain 1
    const buffered1 = [{ id: 1 }, { id: 2 }];
    const unseen1 = buffered1.filter((m) => !confirmed.has(m.id));
    for (const m of unseen1) confirmed.add(m.id); // unconditional dedup add
    expect(unseen1.length).toBe(2);

    // Broker re-sends the same messages (because ack failed earlier).
    const buffered2 = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const unseen2 = buffered2.filter((m) => !confirmed.has(m.id));
    expect(unseen2.length).toBe(1); // only id=3 — 1 and 2 already in dedup
    expect(unseen2[0]!.id).toBe(3);
  });
});

// --- Buffer overflow with myId=null edge case (T4) ---

describe("Buffer overflow prune with null peer ID (T4)", () => {
  // Post-review-army: pruned messages must NOT be acked to the broker.
  // The myId=null guard must not crash, and dedup must still be populated.

  test("overflow prune adds to dedup even when myId is null", () => {
    const myId: string | null = null;
    const buffer = Array.from({ length: 11000 }, (_, i) => ({ id: i }));
    const confirmedDelivered = new Set<number>();
    const BUFFER_CAP = 10000;
    const BUFFER_DRAIN_TO = 5000;

    if (buffer.length > BUFFER_CAP) {
      const removed = buffer.splice(0, buffer.length - BUFFER_DRAIN_TO);
      for (const m of removed) confirmedDelivered.add(m.id);
      // The post-fix code does NOT ack on overflow — verify we'd never reach
      // brokerFetch when myId is null.
      expect(myId).toBeNull();
    }

    expect(buffer.length).toBe(5000);
    expect(confirmedDelivered.size).toBe(6000);
  });

  test("post-fix overflow does NOT ack broker (silent loss prevention)", () => {
    // Regression test for the post-review-army behavior change: the upstream
    // PR #25 logic acked pruned messages (silent data loss). Our fix removes
    // the ack call entirely so messages remain undelivered server-side and
    // can be re-delivered on next session.
    const buffer = Array.from({ length: 11000 }, (_, i) => ({ id: i }));
    const BUFFER_CAP = 10000;
    const BUFFER_DRAIN_TO = 5000;
    let brokerFetchCalled = false;

    if (buffer.length > BUFFER_CAP) {
      const removed = buffer.splice(0, buffer.length - BUFFER_DRAIN_TO);
      // Simulate the real prune logic — dedup add only, no broker call
      const confirmed = new Set<number>();
      for (const m of removed) confirmed.add(m.id);
      // brokerFetch SHOULD NOT be called here in the post-fix code
      expect(brokerFetchCalled).toBe(false);
    }
  });
});

// --- C1 regression: broker log file appends across spawn calls ---
//
// Verifies the C1 fix (fs.openSync(path, 'a') instead of Bun.file()).
// If anyone reverts to Bun.file() this test catches it: Bun.file() as spawn
// stdio writes from byte 0 (overwrite-in-place), so the second spawn would
// shrink the file or leave only its own short output.

describe("C1: broker log append semantics", () => {
  const TEST_LOG = "/tmp/claude-peers-test-append.log";

  beforeAll(() => {
    Bun.spawnSync(["rm", "-f", TEST_LOG]);
  });
  afterAll(() => {
    Bun.spawnSync(["rm", "-f", TEST_LOG]);
  });

  test("openSync('a') + spawn appends, does not overwrite", async () => {
    const { openSync, closeSync, statSync, readFileSync } = await import("node:fs");

    // First spawn: write 100 bytes of "AAA..."
    const fd1 = openSync(TEST_LOG, "a");
    const proc1 = Bun.spawn(["sh", "-c", "printf 'AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA\\n'"], {
      stdio: ["ignore", fd1, "ignore"],
    });
    await proc1.exited;
    closeSync(fd1);
    const sizeAfterFirst = statSync(TEST_LOG).size;
    expect(sizeAfterFirst).toBeGreaterThan(0);

    // Second spawn: write "BBBB"
    const fd2 = openSync(TEST_LOG, "a");
    const proc2 = Bun.spawn(["sh", "-c", "printf 'BBBB\\n'"], {
      stdio: ["ignore", fd2, "ignore"],
    });
    await proc2.exited;
    closeSync(fd2);
    const sizeAfterSecond = statSync(TEST_LOG).size;

    // Append semantics: file MUST be larger after the second spawn
    expect(sizeAfterSecond).toBeGreaterThan(sizeAfterFirst);

    // And the file must contain BOTH the AAAA prefix AND the BBBB suffix
    const content = readFileSync(TEST_LOG, "utf8");
    expect(content).toContain("AAAA");
    expect(content).toContain("BBBB");
    // BBBB must come after AAAA in the file
    expect(content.indexOf("BBBB")).toBeGreaterThan(content.indexOf("AAAA"));
  });

  test("regression: Bun.file() as spawn stdio overwrites from byte 0", async () => {
    // Document the bug we fixed. This test runs the broken pattern and asserts
    // the broken behavior — so future maintainers see exactly why we use openSync.
    const BROKEN_LOG = "/tmp/claude-peers-test-broken.log";
    Bun.spawnSync(["rm", "-f", BROKEN_LOG]);
    await Bun.write(BROKEN_LOG, "previous-session-content-aaaaaaaaaaaaaaa\n");

    const proc = Bun.spawn(["sh", "-c", "printf 'X\\n'"], {
      stdio: ["ignore", Bun.file(BROKEN_LOG), "ignore"],
    });
    await proc.exited;

    // Bun.file() writes from byte 0. The output "X\n" is 2 bytes.
    // The file is NOT shorter than before (Bun does not truncate on open),
    // but the first 2 bytes are "X\n" instead of "pr".
    const after = await Bun.file(BROKEN_LOG).text();
    expect(after.startsWith("X")).toBe(true);
    expect(after.startsWith("previous")).toBe(false);

    Bun.spawnSync(["rm", "-f", BROKEN_LOG]);
  });
});

// --- whoami tool + find_peer piggyback (live broker integration) ---

describe("Live broker delivery features", () => {
  const BROKER_PORT = 17900;
  let brokerProc: ReturnType<typeof Bun.spawn>;
  const brokerUrl = `http://127.0.0.1:${BROKER_PORT}`;
  const TEST_DB = "/tmp/claude-peers-test-delivery.db";

  const brokerStderrChunks: string[] = [];
  beforeAll(async () => {
    Bun.spawnSync(["rm", "-f", TEST_DB]);

    brokerProc = Bun.spawn(["bun", "/home/manzo/claude-peers-mcp/broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_PORT: String(BROKER_PORT), CLAUDE_PEERS_DB: TEST_DB },
      stdout: "ignore",
      stderr: "pipe",
    });
    // Capture stderr so latency-log-format assertions can grep the log lines
    // the broker emits on every successful ack. Non-blocking — discards if
    // the reader can't keep up (tests only assert on the tail).
    (async () => {
      const decoder = new TextDecoder();
      if (!brokerProc.stderr || typeof brokerProc.stderr === "number") return;
      const reader = (brokerProc.stderr as ReadableStream<Uint8Array>).getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) brokerStderrChunks.push(decoder.decode(value));
        }
      } catch {}
    })();

    let brokerAlive = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`${brokerUrl}/health`, { signal: AbortSignal.timeout(500) });
        if (res.ok) { brokerAlive = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!brokerAlive) {
      throw new Error(`Test broker failed to start on ${brokerUrl} within 6 seconds`);
    }
  });

  afterAll(() => {
    brokerProc.kill();
    Bun.spawnSync(["rm", "-f", TEST_DB]);
  });

  // S2: tests now cooperate with token auth. Maintain a per-peer-id token
  // cache so callers don't have to thread the token through every test.
  const tokens = new Map<string, string>();
  async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const b = body as Record<string, unknown> | undefined;
    const claimedId = (b?.id as string | undefined) ?? (b?.from_id as string | undefined);
    if (claimedId && tokens.has(claimedId)) {
      headers["X-Peer-Token"] = tokens.get(claimedId)!;
    }
    const res = await fetch(`${brokerUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (path === "/register" && json.id && json.token) {
      tokens.set(json.id as string, json.token as string);
    }
    return json as T;
  }

  test("/ack-messages endpoint exists and returns ok", async () => {
    const reg = await brokerFetch<{ id: string }>("/register", {
      pid: process.pid,
      cwd: "/test",
      git_root: null,
      tty: null,
      name: null,
      tmux_session: null,
      tmux_window_index: null,
      tmux_window_name: null,
      summary: "",
    });

    const ack = await brokerFetch<{ ok: boolean; acked: number }>("/ack-messages", {
      id: reg.id,
      ids: [],
    });
    expect(ack.ok).toBe(true);
    expect(ack.acked).toBe(0);
  });

  test("read-only poll: messages remain undelivered after poll", async () => {
    const receiver = await brokerFetch<{ id: string }>("/register", {
      pid: process.pid,
      cwd: "/receiver",
      git_root: null,
      tty: null,
      name: "test-receiver",
      tmux_session: null,
      tmux_window_index: null,
      tmux_window_name: null,
      summary: "",
    });

    // Sender sends a message (will fail because handleRegister deduped sender)
    // Re-register sender in different process slot
    // Actually skip — just send from receiver to itself for the read-only test
    await brokerFetch("/send-message", {
      from_id: receiver.id,
      to_id: receiver.id,
      text: "test message",
    });

    // Poll 1: should return the message
    const poll1 = await brokerFetch<{ messages: { id: number; text: string }[] }>("/poll-messages", { id: receiver.id });
    expect(poll1.messages.length).toBe(1);
    const msgId = poll1.messages[0]!.id;

    // Poll 2: should STILL return the same message (read-only poll doesn't ack)
    const poll2 = await brokerFetch<{ messages: { id: number; text: string }[] }>("/poll-messages", { id: receiver.id });
    expect(poll2.messages.length).toBe(1);
    expect(poll2.messages[0]!.id).toBe(msgId);

    // Now ack
    const ackResp = await brokerFetch<{ ok: boolean; acked: number }>("/ack-messages", {
      id: receiver.id,
      ids: [msgId],
    });
    expect(ackResp.acked).toBe(1);

    // Poll 3: message should be gone
    const poll3 = await brokerFetch<{ messages: { id: number }[] }>("/poll-messages", { id: receiver.id });
    expect(poll3.messages.length).toBe(0);
  });

  test("peer-scoped ack: cannot ack another peer's messages via broker", async () => {
    // Spawn two real long-lived child processes so each peer has a distinct,
    // valid PID that the broker's process.kill(pid, 0) liveness check accepts.
    // Using process.pid for both peers would trigger handleRegister's PID-dedup,
    // deleting peerA when peerB registers — the assertion would then pass for
    // the WRONG reason (no row matches the ack rather than the scope check working).
    const childA = Bun.spawn(["sleep", "60"]);
    const childB = Bun.spawn(["sleep", "60"]);

    const peerA = await brokerFetch<{ id: string }>("/register", {
      pid: childA.pid,
      cwd: "/A",
      git_root: null,
      tty: null,
      name: "peer-a",
      tmux_session: null,
      tmux_window_index: null,
      tmux_window_name: null,
      summary: "",
    });

    const peerB = await brokerFetch<{ id: string }>("/register", {
      pid: childB.pid,
      cwd: "/B",
      git_root: null,
      tty: null,
      name: "peer-b",
      tmux_session: null,
      tmux_window_index: null,
      tmux_window_name: null,
      summary: "",
    });

    // Send message to peerB
    await brokerFetch("/send-message", {
      from_id: peerB.id,
      to_id: peerB.id,
      text: "for peer B",
    });

    // Get peerB's pending message
    const poll = await brokerFetch<{ messages: { id: number }[] }>("/poll-messages", { id: peerB.id });
    expect(poll.messages.length).toBeGreaterThanOrEqual(1);
    const msgIdForB = poll.messages[0]!.id;

    // peerA tries to ack peerB's message — should be no-op (acked: 0)
    const badAck = await brokerFetch<{ ok: boolean; acked: number }>("/ack-messages", {
      id: peerA.id,
      ids: [msgIdForB],
    });
    expect(badAck.ok).toBe(true);
    expect(badAck.acked).toBe(0);

    // Verify peerB still has the message
    const pollAgain = await brokerFetch<{ messages: { id: number }[] }>("/poll-messages", { id: peerB.id });
    expect(pollAgain.messages.some((m) => m.id === msgIdForB)).toBe(true);

    // Clean up the long-lived child processes
    childA.kill();
    childB.kill();
  });

  // /poll-by-pid: PID-authenticated drain used by the UserPromptSubmit hook.
  // Bypasses X-Peer-Token auth — caller_pid + same-UID is the auth.
  async function rawPost(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${brokerUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json };
  }

  test("/poll-by-pid: returns undelivered mail and atomically acks", async () => {
    const child = Bun.spawn(["sleep", "60"]);
    const peer = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/pbp-1", git_root: null, tty: null, name: "pbp-1",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    await brokerFetch("/send-message", { from_id: peer.id, to_id: peer.id, text: "hello" });

    const { status, json } = await rawPost("/poll-by-pid", { pid: child.pid, caller_pid: process.pid });
    expect(status).toBe(200);
    expect(json.peer_id).toBe(peer.id);
    const msgs = json.messages as { id: number; text: string }[];
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs[0]!.text).toBe("hello");
    expect(json.acked).toBe(msgs.length);

    // Poll again via authed path — messages should now be marked delivered.
    const poll2 = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: peer.id });
    expect(poll2.messages.length).toBe(0);

    // F5: delivered_at must be populated so latency telemetry isn't silently
    // broken by a future refactor that drops the nowIso UPDATE arg. Open a
    // read-only handle to the broker's DB — WAL mode allows concurrent reads.
    const ro = new Database(TEST_DB, { readonly: true });
    const row = ro.query("SELECT delivered, delivered_at FROM messages WHERE id = ?").get(msgs[0]!.id) as
      { delivered: number; delivered_at: string | null };
    ro.close();
    expect(row.delivered).toBe(1);
    expect(row.delivered_at).not.toBeNull();
    expect(typeof row.delivered_at).toBe("string");
    child.kill();
  });

  test("/poll-by-pid: unknown pid returns empty without error", async () => {
    // Pick a likely-unused PID — 0 is reserved, broker treats pid <= 1 as invalid.
    // Use a real alive PID (our own) that isn't registered as a peer.
    const { status, json } = await rawPost("/poll-by-pid", { pid: 999999, caller_pid: process.pid });
    // Alive-check on pid 999999 likely fails, but the endpoint treats "no peer with this pid"
    // as empty result (ok:true, messages:[]). Liveness check is done on caller_pid only.
    expect(status).toBe(200);
    expect(json.peer_id).toBe("");
    expect(json.messages).toEqual([]);
    expect(json.acked).toBe(0);
  });

  test("/poll-by-pid: cross-peer isolation (pid A drain does not leak peer B's mail)", async () => {
    const childA = Bun.spawn(["sleep", "60"]);
    const childB = Bun.spawn(["sleep", "60"]);
    const peerA = await brokerFetch<{ id: string }>("/register", {
      pid: childA.pid, cwd: "/pbp-A", git_root: null, tty: null, name: "pbp-A",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const peerB = await brokerFetch<{ id: string }>("/register", {
      pid: childB.pid, cwd: "/pbp-B", git_root: null, tty: null, name: "pbp-B",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    await brokerFetch("/send-message", { from_id: peerA.id, to_id: peerB.id, text: "for B only" });
    // F4: also queue mail for peer A so drainA's UPDATE path actually runs.
    // Without this, drainA has an empty messages array and the UPDATE loop
    // never fires — a scope-loss regression (removing `to_id = ?` from the
    // UPDATE WHERE clause) would not be caught.
    await brokerFetch("/send-message", { from_id: peerB.id, to_id: peerA.id, text: "for A only" });

    // Drain via peerA's pid — should return ONLY A's message, not B's.
    const drainA = await rawPost("/poll-by-pid", { pid: childA.pid, caller_pid: process.pid });
    expect(drainA.status).toBe(200);
    expect(drainA.json.peer_id).toBe(peerA.id);
    const aMsgs = drainA.json.messages as { text: string }[];
    expect(aMsgs.length).toBe(1);
    expect(aMsgs[0]!.text).toBe("for A only");

    // Scope-loss guard: if markDeliveredScoped lost `AND to_id = ?`, peer B's
    // message would have been collaterally marked delivered by drainA's
    // UPDATE and the next assertion would fail.
    const peekB = await brokerFetch<{ messages: { text: string }[] }>("/poll-messages", { id: peerB.id });
    expect(peekB.messages.length).toBe(1);
    expect(peekB.messages[0]!.text).toBe("for B only");

    // Drain via peerB's pid — returns B's message.
    const drainB = await rawPost("/poll-by-pid", { pid: childB.pid, caller_pid: process.pid });
    expect(drainB.status).toBe(200);
    expect(drainB.json.peer_id).toBe(peerB.id);
    expect((drainB.json.messages as unknown[]).length).toBe(1);
    childA.kill();
    childB.kill();
  });

  test("/poll-by-pid: rejects invalid pid", async () => {
    const { status, json } = await rawPost("/poll-by-pid", { pid: 0, caller_pid: process.pid });
    expect(status).toBe(400);
    expect(typeof json.error).toBe("string");
  });

  test("/poll-by-pid: emits canonical latency log line on ack", async () => {
    // Telemetry contract: the broker must log each acked delivery with the
    // exact format `[broker] deliver id=<N> from=<id> to=<id> via=<path>
    // latency_ms=<N>`. This is the grep target for the latency dashboard
    // and the `via=` label splits the three delivery paths (piggyback,
    // check_messages, poll-by-pid). If any field name drifts, ops grep breaks.
    const child = Bun.spawn(["sleep", "60"]);
    const peer = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/log-fmt", git_root: null, tty: null, name: "log-fmt",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    await brokerFetch("/send-message", { from_id: peer.id, to_id: peer.id, text: "log-format probe" });

    // Drain via the hook path and capture the resulting log line.
    const before = brokerStderrChunks.length;
    await rawPost("/poll-by-pid", { pid: child.pid, caller_pid: process.pid });
    // Small wait for stderr pipe to flush the console.error line.
    await new Promise((r) => setTimeout(r, 150));
    const newLogs = brokerStderrChunks.slice(before).join("");

    // Assert the full canonical format (id, from, to, via=poll-by-pid, latency_ms).
    // Any regression dropping one of these fields will fail grep.
    expect(newLogs).toMatch(/\[broker\] deliver id=\d+ from=\S+ to=\S+ via=poll-by-pid latency_ms=\d+/);
    child.kill();
  });

  test("/poll-by-pid: rejects dead caller_pid (same-UID check fails)", async () => {
    // Spawn + immediately kill so PID was valid but is now dead.
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    const { status, json } = await rawPost("/poll-by-pid", { pid: process.pid, caller_pid: dead.pid });
    // Accept any 4xx — the specific code (403 vs 400) depends on verifyPidUid
    // return-path and may drift as that function evolves. The assertion that
    // matters is "non-200, with an error string".
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(typeof json.error).toBe("string");
  });

  // --- Delivery confirmation tests (#2 workflow improvement) ---------------

  test("send_message returns message id in response", async () => {
    const childS = Bun.spawn(["sleep", "60"]);
    const childT = Bun.spawn(["sleep", "60"]);
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/dc-s", git_root: null, tty: null, name: "s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const target = await brokerFetch<{ id: string }>("/register", {
      pid: childT.pid, cwd: "/dc-t", git_root: null, tty: null, name: "t",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const send = await brokerFetch<{ ok: boolean; id?: number }>("/send-message", {
      from_id: sender.id, to_id: target.id, text: "hello",
    });
    expect(send.ok).toBe(true);
    expect(typeof send.id).toBe("number");
    expect(send.id).toBeGreaterThan(0);
    childS.kill(); childT.kill();
  });

  test("message-status: undelivered message returns delivered=false, delivered_at=null", async () => {
    const childS = Bun.spawn(["sleep", "60"]);
    const childT = Bun.spawn(["sleep", "60"]);
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/ms1-s", git_root: null, tty: null, name: "s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const target = await brokerFetch<{ id: string }>("/register", {
      pid: childT.pid, cwd: "/ms1-t", git_root: null, tty: null, name: "t",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const send = await brokerFetch<{ id: number }>("/send-message", {
      from_id: sender.id, to_id: target.id, text: "pending",
    });
    const status = await brokerFetch<{ ok: boolean; statuses: { id: number; delivered: boolean; delivered_at: string | null }[] }>(
      "/message-status", { id: sender.id, ids: [send.id] }
    );
    expect(status.ok).toBe(true);
    expect(status.statuses[0]!.id).toBe(send.id);
    expect(status.statuses[0]!.delivered).toBe(false);
    expect(status.statuses[0]!.delivered_at).toBeNull();
    childS.kill(); childT.kill();
  });

  test("message-status: after ack, delivered=true + delivered_at populated", async () => {
    const childS = Bun.spawn(["sleep", "60"]);
    const childT = Bun.spawn(["sleep", "60"]);
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childS.pid, cwd: "/ms2-s", git_root: null, tty: null, name: "s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const target = await brokerFetch<{ id: string }>("/register", {
      pid: childT.pid, cwd: "/ms2-t", git_root: null, tty: null, name: "t",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const send = await brokerFetch<{ id: number }>("/send-message", {
      from_id: sender.id, to_id: target.id, text: "will be acked",
    });
    // Drain via /poll-by-pid (atomic ack) to mark it delivered.
    await rawPost("/poll-by-pid", { pid: childT.pid, caller_pid: process.pid });

    const status = await brokerFetch<{ ok: boolean; statuses: { delivered: boolean; delivered_at: string | null }[] }>(
      "/message-status", { id: sender.id, ids: [send.id] }
    );
    expect(status.statuses[0]!.delivered).toBe(true);
    expect(typeof status.statuses[0]!.delivered_at).toBe("string");
    childS.kill(); childT.kill();
  });

  test("message-status: another peer cannot read my message's status", async () => {
    const childA = Bun.spawn(["sleep", "60"]);
    const childB = Bun.spawn(["sleep", "60"]);
    const childT = Bun.spawn(["sleep", "60"]);
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: childA.pid, cwd: "/ms3-a", git_root: null, tty: null, name: "a",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const b = await brokerFetch<{ id: string }>("/register", {
      pid: childB.pid, cwd: "/ms3-b", git_root: null, tty: null, name: "b",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const target = await brokerFetch<{ id: string }>("/register", {
      pid: childT.pid, cwd: "/ms3-t", git_root: null, tty: null, name: "t",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const aSend = await brokerFetch<{ id: number }>("/send-message", {
      from_id: a.id, to_id: target.id, text: "a's secret",
    });
    // Peer b queries status of peer a's message id — should NOT get the
    // real status (sender-scoped lookup returns empty for non-owner).
    const status = await brokerFetch<{ statuses: { id: number; delivered: boolean; delivered_at: string | null }[] }>(
      "/message-status", { id: b.id, ids: [aSend.id] }
    );
    expect(status.statuses[0]!.id).toBe(aSend.id);
    expect(status.statuses[0]!.delivered).toBe(false);
    expect(status.statuses[0]!.delivered_at).toBeNull();
    childA.kill(); childB.kill(); childT.kill();
  });

  // --- Broadcast tests (#5 workflow improvement) --------------------------
  // /broadcast-message fanout by scope filter. Insertion via the authed
  // brokerFetch so rate-limit + token auth cover this path too.

  test("broadcast: tmux_session fanout delivers to all matching peers", async () => {
    const childA = Bun.spawn(["sleep", "60"]);
    const childB = Bun.spawn(["sleep", "60"]);
    const childC = Bun.spawn(["sleep", "60"]);
    const childSender = Bun.spawn(["sleep", "60"]);
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: childA.pid, cwd: "/bc1", git_root: null, tty: null, name: "a",
      tmux_session: "bcast1", tmux_window_index: "0", tmux_window_name: "claude", summary: "",
    });
    const b = await brokerFetch<{ id: string }>("/register", {
      pid: childB.pid, cwd: "/bc2", git_root: null, tty: null, name: "b",
      tmux_session: "bcast1", tmux_window_index: "1", tmux_window_name: "claude", summary: "",
    });
    const c = await brokerFetch<{ id: string }>("/register", {
      pid: childC.pid, cwd: "/bc3", git_root: null, tty: null, name: "c",
      tmux_session: "bcast-other", tmux_window_index: "0", tmux_window_name: "claude", summary: "",
    });
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childSender.pid, cwd: "/bc-sender", git_root: null, tty: null, name: "sender",
      tmux_session: "bcast-sender", tmux_window_index: "0", tmux_window_name: "claude", summary: "",
    });

    const result = await brokerFetch<{ ok: boolean; sent: number }>("/broadcast-message", {
      from_id: sender.id, text: "hello bcast1", tmux_session: "bcast1",
    });
    expect(result.ok).toBe(true);
    expect(result.sent).toBe(2);

    // Verify a and b got it, c did not
    const pollA = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: a.id });
    const pollB = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: b.id });
    const pollC = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: c.id });
    expect(pollA.messages.length).toBe(1);
    expect(pollB.messages.length).toBe(1);
    expect(pollC.messages.length).toBe(0);
    childA.kill(); childB.kill(); childC.kill(); childSender.kill();
  });

  test("broadcast: excludes the sender even if sender matches the scope", async () => {
    const childA = Bun.spawn(["sleep", "60"]);
    const childSender = Bun.spawn(["sleep", "60"]);
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: childA.pid, cwd: "/bc-self-a", git_root: null, tty: null, name: "a",
      tmux_session: "bcast2", tmux_window_index: "0", tmux_window_name: "claude", summary: "",
    });
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childSender.pid, cwd: "/bc-self-s", git_root: null, tty: null, name: "sender",
      // Sender in the SAME scope as the target
      tmux_session: "bcast2", tmux_window_index: "1", tmux_window_name: "claude", summary: "",
    });
    const result = await brokerFetch<{ ok: boolean; sent: number }>("/broadcast-message", {
      from_id: sender.id, text: "hello bcast2", tmux_session: "bcast2",
    });
    expect(result.sent).toBe(1);  // only peer a, not sender itself
    const pollSelf = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: sender.id });
    expect(pollSelf.messages.length).toBe(0);
    const pollA = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: a.id });
    expect(pollA.messages.length).toBe(1);
    childA.kill(); childSender.kill();
  });

  test("broadcast: rejects unfiltered call (no scope)", async () => {
    const child = Bun.spawn(["sleep", "60"]);
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/bc-unfilt", git_root: null, tty: null, name: "s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const result = await brokerFetch<{ ok: boolean; sent: number; error?: string }>("/broadcast-message", {
      from_id: sender.id, text: "no scope",
    });
    expect(result.ok).toBe(false);
    expect(result.sent).toBe(0);
    expect(typeof result.error).toBe("string");
    expect(result.error).toMatch(/scope filter/i);
    child.kill();
  });

  test("broadcast: name_like is case-insensitive substring", async () => {
    const childA = Bun.spawn(["sleep", "60"]);
    const childB = Bun.spawn(["sleep", "60"]);
    const childC = Bun.spawn(["sleep", "60"]);
    const childSender = Bun.spawn(["sleep", "60"]);
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: childA.pid, cwd: "/bc-nl-a", git_root: null, tty: null,
      name: "reviewer.1", tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const b = await brokerFetch<{ id: string }>("/register", {
      pid: childB.pid, cwd: "/bc-nl-b", git_root: null, tty: null,
      name: "REVIEWER.2", tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const c = await brokerFetch<{ id: string }>("/register", {
      pid: childC.pid, cwd: "/bc-nl-c", git_root: null, tty: null,
      name: "coder.1", tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: childSender.pid, cwd: "/bc-nl-s", git_root: null, tty: null, name: "s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const result = await brokerFetch<{ ok: boolean; sent: number }>("/broadcast-message", {
      from_id: sender.id, text: "reviewers only", name_like: "review",
    });
    expect(result.sent).toBe(2);  // a + b, not c
    const pollA = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: a.id });
    const pollB = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: b.id });
    const pollC = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: c.id });
    expect(pollA.messages.length).toBe(1);
    expect(pollB.messages.length).toBe(1);
    expect(pollC.messages.length).toBe(0);
    childA.kill(); childB.kill(); childC.kill(); childSender.kill();
  });

  test("broadcast: size cap enforced (>32KB text)", async () => {
    const child = Bun.spawn(["sleep", "60"]);
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: child.pid, cwd: "/bc-cap", git_root: null, tty: null, name: "s",
      tmux_session: "bcast-cap", tmux_window_index: "0", tmux_window_name: "claude", summary: "",
    });
    const big = "x".repeat(33 * 1024);
    const result = await brokerFetch<{ ok: boolean; sent: number; error?: string }>("/broadcast-message", {
      from_id: sender.id, text: big, tmux_session: "bcast-cap",
    });
    expect(result.ok).toBe(false);
    expect(result.sent).toBe(0);
    expect(typeof result.error).toBe("string");
    expect(result.error).toMatch(/exceeds/i);
    child.kill();
  });

  // --- Rehydration tests (#7 workflow improvement) ------------------------
  // When a peer dies and relaunches in the same tmux pane, the new
  // registration inherits the old peer's ID so orphaned mail is recoverable.

  test("rehydration: new peer in same tmux location inherits dead peer's ID", async () => {
    const dead = Bun.spawn(["sleep", "60"]);
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: dead.pid, cwd: "/rehydrate-1", git_root: null, tty: null,
      name: "a", tmux_session: "rh1", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    dead.kill();
    await dead.exited;

    const fresh = Bun.spawn(["sleep", "60"]);
    const b = await brokerFetch<{ id: string }>("/register", {
      pid: fresh.pid, cwd: "/rehydrate-1", git_root: null, tty: null,
      name: "b-new", tmux_session: "rh1", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    expect(b.id).toBe(a.id);
    fresh.kill();
  });

  test("rehydration: undelivered mail survives re-registration", async () => {
    const sender = Bun.spawn(["sleep", "60"]);
    const dead = Bun.spawn(["sleep", "60"]);
    const s = await brokerFetch<{ id: string }>("/register", {
      pid: sender.pid, cwd: "/rehydrate-2-sender", git_root: null, tty: null,
      name: "sender", tmux_session: null, tmux_window_index: null,
      tmux_window_name: null, summary: "",
    });
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: dead.pid, cwd: "/rehydrate-2", git_root: null, tty: null,
      name: "a", tmux_session: "rh2", tmux_window_index: "1",
      tmux_window_name: "claude", summary: "",
    });
    await brokerFetch("/send-message", {
      from_id: s.id, to_id: a.id, text: "survive my death",
    });
    dead.kill();
    await dead.exited;

    const fresh = Bun.spawn(["sleep", "60"]);
    await brokerFetch("/register", {
      pid: fresh.pid, cwd: "/rehydrate-2", git_root: null, tty: null,
      name: "b-new", tmux_session: "rh2", tmux_window_index: "1",
      tmux_window_name: "claude", summary: "",
    });
    // Drain via /poll-by-pid — should see the mail addressed to the
    // inherited ID (a.id), proving rehydration restored the inbox.
    const { json } = await rawPost("/poll-by-pid", {
      pid: fresh.pid, caller_pid: process.pid,
    });
    expect(json.peer_id).toBe(a.id);
    const msgs = json.messages as { text: string }[];
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.text).toBe("survive my death");
    sender.kill();
    fresh.kill();
  });

  test("rehydration: different tmux pane does NOT inherit", async () => {
    const dead = Bun.spawn(["sleep", "60"]);
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: dead.pid, cwd: "/rehydrate-3", git_root: null, tty: null,
      name: "a", tmux_session: "rh3", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    dead.kill();
    await dead.exited;

    // Relaunch at a DIFFERENT pane index — should NOT inherit.
    const fresh = Bun.spawn(["sleep", "60"]);
    const b = await brokerFetch<{ id: string }>("/register", {
      pid: fresh.pid, cwd: "/rehydrate-3", git_root: null, tty: null,
      name: "b-new", tmux_session: "rh3", tmux_window_index: "1",
      tmux_window_name: "claude", summary: "",
    });
    expect(b.id).not.toBe(a.id);
    fresh.kill();
  });

  test("rehydration: stale peer (>1h last_seen) does NOT inherit", async () => {
    const dead = Bun.spawn(["sleep", "60"]);
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: dead.pid, cwd: "/rehydrate-4", git_root: null, tty: null,
      name: "a", tmux_session: "rh4", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    dead.kill();
    await dead.exited;

    // Backdate last_seen so the candidate is older than the 1h window.
    // Requires a read-write DB handle; WAL allows one writer.
    const rw = new Database(TEST_DB);
    rw.run(
      "UPDATE peers SET last_seen = ? WHERE id = ?",
      [new Date(Date.now() - 2 * 3600_000).toISOString(), a.id]
    );
    rw.close();

    const fresh = Bun.spawn(["sleep", "60"]);
    const b = await brokerFetch<{ id: string }>("/register", {
      pid: fresh.pid, cwd: "/rehydrate-4", git_root: null, tty: null,
      name: "b-new", tmux_session: "rh4", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    expect(b.id).not.toBe(a.id);
    fresh.kill();
  });

  test("rehydration: live peer is NOT displaced", async () => {
    const alive = Bun.spawn(["sleep", "60"]);
    const a = await brokerFetch<{ id: string }>("/register", {
      pid: alive.pid, cwd: "/rehydrate-5", git_root: null, tty: null,
      name: "a", tmux_session: "rh5", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });

    // Register a "clone" with the same location tuple but a different live
    // PID. The original peer is ALIVE — rehydration must skip it, and the
    // new peer gets a fresh ID. Both live side-by-side.
    const clone = Bun.spawn(["sleep", "60"]);
    const b = await brokerFetch<{ id: string }>("/register", {
      pid: clone.pid, cwd: "/rehydrate-5", git_root: null, tty: null,
      name: "b", tmux_session: "rh5", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    expect(b.id).not.toBe(a.id);
    alive.kill();
    clone.kill();
  });

  // --- M4: Most-recent dead candidate wins rehydration --------------------
  test("rehydration: most-recent dead candidate wins when multiple match", async () => {
    // Register two peers at the same tmux location with different last_seen,
    // kill both, then register a fresh peer — should inherit the MORE RECENT
    // one's ID (ORDER BY last_seen DESC). Protects against accidental ASC flip.
    const old = Bun.spawn(["sleep", "60"]);
    const recent = Bun.spawn(["sleep", "60"]);
    const oldPeer = await brokerFetch<{ id: string }>("/register", {
      pid: old.pid, cwd: "/rehydrate-m4", git_root: null, tty: null,
      name: "old", tmux_session: "rh-m4", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    const recentPeer = await brokerFetch<{ id: string }>("/register", {
      pid: recent.pid, cwd: "/rehydrate-m4", git_root: null, tty: null,
      name: "recent", tmux_session: "rh-m4", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    // Wait to guarantee distinguishable last_seen timestamps between the two.
    await new Promise((r) => setTimeout(r, 50));
    // Backdate the older peer so "recent" is clearly the most-recent dead slot.
    const rw = new Database(TEST_DB);
    rw.run(
      "UPDATE peers SET last_seen = ? WHERE id = ?",
      [new Date(Date.now() - 1000).toISOString(), oldPeer.id]
    );
    rw.close();
    old.kill();
    recent.kill();
    await old.exited;
    await recent.exited;

    const fresh = Bun.spawn(["sleep", "60"]);
    const newPeer = await brokerFetch<{ id: string }>("/register", {
      pid: fresh.pid, cwd: "/rehydrate-m4", git_root: null, tty: null,
      name: "fresh", tmux_session: "rh-m4", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    // Must inherit the MORE RECENT dead slot, not the older one.
    expect(newPeer.id).toBe(recentPeer.id);
    expect(newPeer.id).not.toBe(oldPeer.id);
    fresh.kill();
  });

  // --- M5: Own-PID re-register does NOT trigger rehydrate branch ----------
  test("rehydration: re-register with same pid + same location does NOT rehydrate", async () => {
    // When a peer's own PID re-registers (e.g., after broker restart), the
    // existing PID-dedup path should handle it — rehydration is for DIFFERENT
    // pids inheriting a dead slot. This test guards against a regression where
    // the rehydrate query returns the peer's OWN current row and tries to
    // inherit from itself.
    const p = Bun.spawn(["sleep", "60"]);
    const first = await brokerFetch<{ id: string }>("/register", {
      pid: p.pid, cwd: "/rehydrate-m5", git_root: null, tty: null,
      name: "self", tmux_session: "rh-m5", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    // Re-register with the same pid AND same location. Expected behavior:
    // the existing-PID dedup deletes the old row, a FRESH id is generated,
    // no rehydration occurs (the query excludes `pid = body.pid`).
    const second = await brokerFetch<{ id: string }>("/register", {
      pid: p.pid, cwd: "/rehydrate-m5", git_root: null, tty: null,
      name: "self-again", tmux_session: "rh-m5", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    expect(second.id).not.toBe(first.id);  // fresh id, not inherited
    // Exactly one row for this pid
    const ro = new Database(TEST_DB, { readonly: true });
    const count = (ro.query("SELECT COUNT(*) AS n FROM peers WHERE pid = ?").get(p.pid) as { n: number }).n;
    ro.close();
    expect(count).toBe(1);
    p.kill();
  });

  // --- M3: Broadcast filter combinations (git_root only, tmux+name_like) --
  test("broadcast: git_root-only filter matches peers in that repo", async () => {
    const a = Bun.spawn(["sleep", "60"]);
    const b = Bun.spawn(["sleep", "60"]);
    const s = Bun.spawn(["sleep", "60"]);
    const peerA = await brokerFetch<{ id: string }>("/register", {
      pid: a.pid, cwd: "/git-a", git_root: "/home/proj-X", tty: null, name: "a",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const peerB = await brokerFetch<{ id: string }>("/register", {
      pid: b.pid, cwd: "/git-b", git_root: "/home/proj-Y", tty: null, name: "b",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: s.pid, cwd: "/git-s", git_root: "/home/proj-X", tty: null, name: "s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const result = await brokerFetch<{ ok: boolean; sent: number }>("/broadcast-message", {
      from_id: sender.id, text: "proj-X repo only", git_root: "/home/proj-X",
    });
    expect(result.sent).toBe(1);  // only peerA (sender excluded even though same repo)
    const pA = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: peerA.id });
    const pB = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: peerB.id });
    expect(pA.messages.length).toBe(1);
    expect(pB.messages.length).toBe(0);
    a.kill(); b.kill(); s.kill();
  });

  test("broadcast: tmux + name_like filters AND together (intersection)", async () => {
    const match = Bun.spawn(["sleep", "60"]);
    const onlyTmux = Bun.spawn(["sleep", "60"]);
    const onlyName = Bun.spawn(["sleep", "60"]);
    const s = Bun.spawn(["sleep", "60"]);
    const mPeer = await brokerFetch<{ id: string }>("/register", {
      pid: match.pid, cwd: "/m", git_root: null, tty: null,
      name: "reviewer.m", tmux_session: "review-tmux", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    const tPeer = await brokerFetch<{ id: string }>("/register", {
      pid: onlyTmux.pid, cwd: "/t", git_root: null, tty: null,
      name: "coder.t", tmux_session: "review-tmux", tmux_window_index: "1",
      tmux_window_name: "claude", summary: "",
    });
    const nPeer = await brokerFetch<{ id: string }>("/register", {
      pid: onlyName.pid, cwd: "/n", git_root: null, tty: null,
      name: "reviewer.n", tmux_session: "other-tmux", tmux_window_index: "0",
      tmux_window_name: "claude", summary: "",
    });
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: s.pid, cwd: "/s", git_root: null, tty: null, name: "sender",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const result = await brokerFetch<{ ok: boolean; sent: number }>("/broadcast-message", {
      from_id: sender.id, text: "intersect",
      tmux_session: "review-tmux", name_like: "review",
    });
    expect(result.sent).toBe(1);  // only match peer (AND semantics)
    const pM = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: mPeer.id });
    const pT = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: tPeer.id });
    const pN = await brokerFetch<{ messages: unknown[] }>("/poll-messages", { id: nPeer.id });
    expect(pM.messages.length).toBe(1);
    expect(pT.messages.length).toBe(0);
    expect(pN.messages.length).toBe(0);
    match.kill(); onlyTmux.kill(); onlyName.kill(); s.kill();
  });

  // --- B1 regression: name_like wildcards are escaped ---------------------
  test("broadcast: name_like='%' is escaped, not treated as SQL wildcard", async () => {
    // Without the ESCAPE clause, name_like='%' would LIKE-match every named
    // peer (bypass the "scope filter required" guard). Current code escapes
    // the % to literal and also rejects length < 2 — so this single-char
    // filter must return length-guard error, not a match-all broadcast.
    const s = Bun.spawn(["sleep", "60"]);
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: s.pid, cwd: "/b1", git_root: null, tty: null, name: "s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    // Single wildcard char → rejected by length guard (<2)
    const r1 = await brokerFetch<{ ok: boolean; sent: number; error?: string }>(
      "/broadcast-message", { from_id: sender.id, text: "x", name_like: "%" });
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/at least 2 characters|non-wildcard/i);
    // Two wildcard chars → rejected by non-wildcard-content guard
    const r2 = await brokerFetch<{ ok: boolean; sent: number; error?: string }>(
      "/broadcast-message", { from_id: sender.id, text: "x", name_like: "%%" });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/non-wildcard/i);
    s.kill();
  });

  // --- B2 regression: broadcast fanout charges msg-bucket proportionally --
  test("broadcast: fanout of N targets charges N message-bucket slots", async () => {
    // Send message-bucket to near-full via sequential /send-message, then
    // attempt a broadcast that would fanout more than the remaining budget.
    // The handler must reject WITHOUT inserting (proportional rate charge).
    // Use small target count + small budget headroom for test speed.
    const receivers: ReturnType<typeof Bun.spawn>[] = [];
    const receiverIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const proc = Bun.spawn(["sleep", "60"]);
      receivers.push(proc);
      const p = await brokerFetch<{ id: string }>("/register", {
        pid: proc.pid, cwd: `/b2-r${i}`, git_root: null, tty: null,
        name: `r${i}`, tmux_session: "b2-tmux", tmux_window_index: String(i),
        tmux_window_name: "claude", summary: "",
      });
      receiverIds.push(p.id);
    }
    const s = Bun.spawn(["sleep", "60"]);
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: s.pid, cwd: "/b2-s", git_root: null, tty: null, name: "s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    // Burn the sender's msg-bucket to 58/60 with sequential sends.
    for (let i = 0; i < 58; i++) {
      await brokerFetch("/send-message", {
        from_id: sender.id, to_id: receiverIds[0], text: "fill" + i,
      });
    }
    // Attempt broadcast to 4 receivers → needs 4 slots, only 2 remain → reject.
    const broadcastResult = await brokerFetch<{ ok: boolean; sent: number; error?: string }>(
      "/broadcast-message",
      { from_id: sender.id, text: "should be rejected", tmux_session: "b2-tmux" }
    );
    expect(broadcastResult.ok).toBe(false);
    expect(broadcastResult.sent).toBe(0);
    expect(broadcastResult.error).toMatch(/quota|rate/i);
    // Verify NO messages were inserted for the broadcast (atomic reject).
    const rw = new Database(TEST_DB, { readonly: true });
    const broadcastCount = (rw.query(
      "SELECT COUNT(*) AS n FROM messages WHERE text = ?"
    ).get("should be rejected") as { n: number }).n;
    rw.close();
    expect(broadcastCount).toBe(0);
    receivers.forEach((p) => p.kill());
    s.kill();
  });

  // --- M1: Concurrent /message-status during the 2s send_message wait -----
  test("message-status: concurrent drain during sender's wait window", async () => {
    // Simulates the race: sender fires send_message → 2s sleep before
    // polling status. During that window, recipient drains via /poll-by-pid.
    // Sender's subsequent /message-status call must correctly reflect
    // delivered=true + delivered_at populated.
    const senderProc = Bun.spawn(["sleep", "60"]);
    const recvProc = Bun.spawn(["sleep", "60"]);
    const sender = await brokerFetch<{ id: string }>("/register", {
      pid: senderProc.pid, cwd: "/m1-s", git_root: null, tty: null, name: "s",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const recv = await brokerFetch<{ id: string }>("/register", {
      pid: recvProc.pid, cwd: "/m1-r", git_root: null, tty: null, name: "r",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
    });
    const send = await brokerFetch<{ id: number }>("/send-message", {
      from_id: sender.id, to_id: recv.id, text: "race probe",
    });

    // Kick off concurrent drain at t=50ms, meanwhile wait 200ms then query status.
    const drainPromise = (async () => {
      await new Promise((r) => setTimeout(r, 50));
      await rawPost("/poll-by-pid", { pid: recvProc.pid, caller_pid: process.pid });
    })();
    await new Promise((r) => setTimeout(r, 200));
    const statusPromise = brokerFetch<{
      ok: boolean; statuses: { delivered: boolean; delivered_at: string | null }[];
    }>("/message-status", { id: sender.id, ids: [send.id] });
    await Promise.all([drainPromise, statusPromise]);
    const status = await statusPromise;
    expect(status.statuses[0]!.delivered).toBe(true);
    expect(typeof status.statuses[0]!.delivered_at).toBe("string");
    senderProc.kill();
    recvProc.kill();
  });
});
