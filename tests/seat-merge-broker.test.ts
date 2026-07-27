/**
 * End-to-end seat merge and delivery honesty, against a real broker process.
 *
 * The scenario is the one that actually happened: a Claude session registers
 * twice for one pane — server.ts with the MCP server pid, the SessionStart hook
 * with the TUI pid — and the two pid-keyed registrations used to produce two
 * rows. Mail landed on whichever the sender resolved, the seat drained the
 * other, and the poller nudged the pane forever over mail it could not see.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { startTestBroker, type TestBroker } from "./helpers/test-broker.ts";

describe("seat-anchored registration", () => {
  let broker: TestBroker;
  const tokens = new Map<string, string>();
  const children = new Set<ReturnType<typeof Bun.spawn>>();

  beforeAll(async () => {
    broker = await startTestBroker({ prefix: "seat-merge" });
  }, 35_000);

  afterAll(async () => {
    for (const child of children) child.kill();
    await broker.stop();
  });

  /** A real, killable process to stand in for a registrant. */
  function spawnHolder(): number {
    const child = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    children.add(child);
    return child.pid;
  }

  async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const claimedId = (body.id as string | undefined) ?? (body.from_id as string | undefined);
    if (claimedId && tokens.has(claimedId)) headers["X-Peer-Token"] = tokens.get(claimedId)!;
    const res = await fetch(`${broker.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const json = (await res.json()) as Record<string, unknown>;
    if (json.id && json.token) tokens.set(json.id as string, json.token as string);
    return json as T;
  }

  function register(pid: number, over: Record<string, unknown> = {}) {
    return call<{ id: string; token: string }>("/register", {
      pid,
      cwd: "/seat/project",
      git_root: "/seat/project",
      tty: "pts/70",
      name: "seat.1",
      tmux_session: "seatsess",
      tmux_window_index: "1",
      tmux_window_name: "lane",
      tmux_pane_id: "%700",
      client_type: "claude",
      receiver_mode: "claude-channel",
      ...over,
    });
  }

  function rows() {
    const db = new Database(broker.dbPath, { readonly: true });
    try {
      return db.query(
        "SELECT id, pid, seat_key, seat_pids FROM peers WHERE tmux_pane_id = '%700' ORDER BY registered_at",
      ).all() as Array<{ id: string; pid: number; seat_key: string | null; seat_pids: string }>;
    } finally {
      db.close();
    }
  }

  test("two registrars for one pane produce ONE row with ONE id", async () => {
    const serverPid = spawnHolder();
    const tuiPid = spawnHolder();

    const first = await register(serverPid);
    const second = await register(tuiPid);

    expect(first.id).toBeTruthy();
    // The whole point: the second registrar adopts the seat instead of minting
    // a second identity for the same pane.
    expect(second.id).toBe(first.id);

    const seatRows = rows();
    expect(seatRows).toHaveLength(1);
    expect(seatRows[0]!.seat_key).toBe("pane:seatsess:%700");
    // Both processes are recorded as serving the seat.
    expect(JSON.parse(seatRows[0]!.seat_pids)).toEqual(expect.arrayContaining([serverPid, tuiPid]));
  });

  test("the adopting registrar keeps the seat token, so the co-registrant is not 401'd", async () => {
    const a = spawnHolder();
    const b = spawnHolder();
    const first = await register(a, { tmux_pane_id: "%701" });
    const second = await register(b, { tmux_pane_id: "%701" });
    expect(second.id).toBe(first.id);
    expect(second.token).toBe(first.token);
  });

  test("mail queued on either registration reaches the one seat", async () => {
    const serverPid = spawnHolder();
    const tuiPid = spawnHolder();
    const senderPid = spawnHolder();

    // Seat registers via its MCP server, and mail arrives addressed to that id.
    const seat = await register(serverPid, { tmux_pane_id: "%702" });
    const sender = await call<{ id: string }>("/register", {
      pid: senderPid, cwd: "/seat/other", git_root: "/seat/other", name: "sender.1", client_type: "claude",
    });
    await call("/send-message", { id: sender.id, from_id: sender.id, to_id: seat.id, text: "handoff packet" });

    // Then the SessionStart hook registers the TUI pid for the same pane.
    const merged = await register(tuiPid, { tmux_pane_id: "%702" });
    expect(merged.id).toBe(seat.id);

    // The mail is still addressed to a row that exists and is drainable.
    const db = new Database(broker.dbPath, { readonly: true });
    const pending = db.query(
      "SELECT m.text FROM messages m JOIN peers p ON p.id = m.to_id WHERE m.delivered = 0 AND p.tmux_pane_id = '%702'",
    ).all() as Array<{ text: string }>;
    db.close();
    expect(pending.map((r) => r.text)).toContain("handoff packet");
  });

  test("a pre-existing duplicate row is folded in and its mail migrates, not dropped", async () => {
    // Simulate the rows already in the wild: a seat that accumulated a second
    // row before this fix shipped, holding mail nobody could drain.
    const strandedPid = spawnHolder();
    const livePid = spawnHolder();
    const senderPid = spawnHolder();

    const stranded = await register(strandedPid, { tmux_pane_id: "%703" });
    const sender = await call<{ id: string }>("/register", {
      pid: senderPid, cwd: "/seat/other2", git_root: "/seat/other2", name: "sender.2", client_type: "claude",
    });
    await call("/send-message", { id: sender.id, from_id: sender.id, to_id: stranded.id, text: "stranded mail" });

    const db0 = new Database(broker.dbPath, { readonly: true });
    const before = db0.query("SELECT COUNT(*) n FROM messages WHERE to_id = ? AND delivered = 0").get(stranded.id) as { n: number };
    db0.close();
    expect(before.n).toBe(1);

    const survivor = await register(livePid, { tmux_pane_id: "%703" });

    const db = new Database(broker.dbPath, { readonly: true });
    const seatRows = db.query("SELECT id FROM peers WHERE tmux_pane_id = '%703'").all() as Array<{ id: string }>;
    const migrated = db.query(
      "SELECT COUNT(*) n FROM messages WHERE to_id = ? AND delivered = 0 AND text = 'stranded mail'",
    ).get(survivor.id) as { n: number };
    db.close();

    expect(seatRows).toHaveLength(1);
    // Merge, never supersede: the message followed the seat.
    expect(migrated.n).toBe(1);
  });

  test("a LIVE row's id survives ahead of a newer dead one", async () => {
    // The shape left behind by every seat that duplicated before this fix, and
    // the shape sitting in the production database right now: one row whose
    // process is gone but whose last_seen is newest, beside one still occupied.
    // Senders can still reach the live id; adopting the dead one would strand
    // exactly them. Seeded directly because registration can no longer produce
    // two rows on a seat, and a dead pid cannot register at all (S3).
    const livePid = spawnHolder();
    const deadHolder = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    const deadPid = deadHolder.pid;
    deadHolder.kill();
    await Bun.sleep(120);

    const db = new Database(broker.dbPath);
    const insert = (id: string, pid: number, lastSeen: string) => db.run(
      `INSERT INTO peers (id, pid, cwd, git_root, tty, name, resolved_name, tmux_session,
        tmux_window_index, tmux_window_name, tmux_pane_id, client_type, receiver_mode,
        summary, registered_at, last_seen, token, non_targetable, seat_key, seat_pids)
       VALUES (?,?,'/seat/legacy','/seat/legacy','pts/71',?,?, 'seatsess','1','lane','%708',
        'claude','claude-channel','', ?, ?, 'tok-' || ?, 0, 'pane:seatsess:%708', '[]')`,
      [id, pid, "legacy.1", id, lastSeen, lastSeen, id],
    );
    insert("legacyalive", livePid, "2026-07-27T07:00:00.000Z");
    insert("legacydead", deadPid, "2026-07-27T07:05:00.000Z"); // newer, but gone
    db.close();

    const newcomer = spawnHolder();
    const adopted = await register(newcomer, {
      tmux_pane_id: "%708", cwd: "/seat/legacy", git_root: "/seat/legacy", tty: "pts/71", name: "legacy.1",
    });
    expect(adopted.id).toBe("legacyalive");

    const after = new Database(broker.dbPath, { readonly: true });
    const remaining = after.query("SELECT id FROM peers WHERE tmux_pane_id = '%708'").all() as Array<{ id: string }>;
    after.close();
    expect(remaining).toHaveLength(1);
  });

  test("headless lanes never merge — two anonymous lanes stay two seats", async () => {
    const one = spawnHolder();
    const two = spawnHolder();
    const shared = {
      cwd: "/seat/headless", git_root: "/seat/headless", name: "bg", client_type: "codex",
      tmux_session: null, tmux_pane_id: null, tty: null,
    };
    const a = await call<{ id: string }>("/register", { pid: one, ...shared });
    const b = await call<{ id: string }>("/register", { pid: two, ...shared });
    // No durable seat anchor → no merge. Collapsing these would cross-deliver
    // two unrelated background lanes' mail.
    expect(b.id).not.toBe(a.id);
  });

  test("a different project in the same pane does not inherit the previous occupant's identity", async () => {
    const first = spawnHolder();
    const second = spawnHolder();
    const a = await register(first, { tmux_pane_id: "%704" });
    const b = await register(second, { tmux_pane_id: "%704", cwd: "/seat/other-project", git_root: "/seat/other-project" });
    expect(b.id).not.toBe(a.id);
  });

  test("a seat stays alive while ANY of its processes lives", async () => {
    // Kills the pid the ROW carries and keeps a different seat pid alive, so
    // this can only pass through seat_pids. Killing the other one would leave
    // row.pid alive and the test would pass without seat identity at all.
    const serverPid = spawnHolder();
    const tuiPid = spawnHolder();
    const seat = await register(serverPid, { tmux_pane_id: "%705" });
    await register(tuiPid, { tmux_pane_id: "%705" });

    const db = new Database(broker.dbPath, { readonly: true });
    const row = db.query("SELECT pid, seat_pids FROM peers WHERE id = ?").get(seat.id) as { pid: number; seat_pids: string };
    db.close();
    expect(row.pid).toBe(tuiPid); // last registrant owns the row's pid column
    expect(JSON.parse(row.seat_pids)).toContain(serverPid);

    // Kill the process the row is keyed on; the co-registrant keeps serving.
    for (const child of children) if (child.pid === row.pid) child.kill();
    await Bun.sleep(150);

    const probePid = spawnHolder();
    const probe = await call<{ id: string }>("/register", {
      pid: probePid, cwd: "/seat/probe", git_root: "/seat/probe", name: "probe.1", client_type: "claude",
    });
    const sent = await call<{ ok: boolean; code?: string }>("/send-message", {
      id: probe.id, from_id: probe.id, to_id: seat.id, text: "still reachable?",
    });
    expect(sent.ok).toBe(true);
  });
});

describe("delivery honesty over the wire", () => {
  let broker: TestBroker;
  const tokens = new Map<string, string>();
  const children = new Set<ReturnType<typeof Bun.spawn>>();

  beforeAll(async () => {
    broker = await startTestBroker({ prefix: "delivery-honesty" });
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
    const claimedId = (body.id as string | undefined) ?? (body.from_id as string | undefined);
    if (claimedId && tokens.has(claimedId)) headers["X-Peer-Token"] = tokens.get(claimedId)!;
    const res = await fetch(`${broker.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const json = (await res.json()) as Record<string, unknown>;
    if (json.id && json.token) tokens.set(json.id as string, json.token as string);
    return json as T;
  }

  type SendResult = {
    ok: boolean;
    id?: number;
    warning?: string;
    recipient?: { state: string; pending: number; nudgeable: boolean; oldest_pending_ms: number | null };
  };

  test("a send to a healthy seat carries no warning", async () => {
    const senderPid = spawnHolder();
    const targetPid = spawnHolder();
    const sender = await call<{ id: string }>("/register", {
      pid: senderPid, cwd: "/h/a", git_root: "/h/a", name: "h-sender", client_type: "claude",
    });
    const target = await call<{ id: string }>("/register", {
      pid: targetPid, cwd: "/h/b", git_root: "/h/b", name: "h-target", client_type: "claude",
      receiver_mode: "claude-channel", tmux_session: "hs", tmux_window_index: "0", tmux_window_name: "w", tmux_pane_id: "%800",
    });
    const sent = await call<SendResult>("/send-message", {
      id: sender.id, from_id: sender.id, to_id: target.id, text: "hello",
    });
    expect(sent.ok).toBe(true);
    expect(sent.recipient?.state).toBe("healthy");
    expect(sent.recipient?.pending).toBe(1);
    expect(sent.warning).toBeUndefined();
  });

  test("sending to a seat with no drain path warns instead of reporting plain success", async () => {
    // The overnight case: a no-tmux manual-drain codex lane. Every sender saw
    // "queued" and nobody learned the work was never collected.
    const senderPid = spawnHolder();
    const targetPid = spawnHolder();
    const sender = await call<{ id: string }>("/register", {
      pid: senderPid, cwd: "/h/c", git_root: "/h/c", name: "h-sender2", client_type: "claude",
    });
    const target = await call<{ id: string }>("/register", {
      pid: targetPid, cwd: "/h/d", git_root: "/h/d", name: "h-orphan", client_type: "codex",
      receiver_mode: "manual-drain",
    });
    const sent = await call<SendResult>("/send-message", {
      id: sender.id, from_id: sender.id, to_id: target.id, text: "final handoff",
    });
    expect(sent.ok).toBe(true);
    expect(sent.recipient?.state).toBe("no_drain_path");
    expect(sent.recipient?.nudgeable).toBe(false);
    expect(sent.warning).toContain("no automatic drain path");
  });

  test("pending count reflects the real backlog, and counts the message just sent", async () => {
    const senderPid = spawnHolder();
    const targetPid = spawnHolder();
    const sender = await call<{ id: string }>("/register", {
      pid: senderPid, cwd: "/h/e", git_root: "/h/e", name: "h-sender3", client_type: "claude",
    });
    const target = await call<{ id: string }>("/register", {
      pid: targetPid, cwd: "/h/f", git_root: "/h/f", name: "h-backlog", client_type: "codex",
      receiver_mode: "manual-drain",
    });
    let last: SendResult | undefined;
    for (let i = 0; i < 3; i++) {
      last = await call<SendResult>("/send-message", {
        id: sender.id, from_id: sender.id, to_id: target.id, text: `packet ${i}`,
      });
    }
    expect(last?.recipient?.pending).toBe(3);
    expect(last?.warning).toContain("3 message(s)");
  });

  test("send_to_peer reports the same health as send_message", async () => {
    const senderPid = spawnHolder();
    const targetPid = spawnHolder();
    const sender = await call<{ id: string }>("/register", {
      pid: senderPid, cwd: "/h/g", git_root: "/h/g", name: "h-sender4", client_type: "claude",
    });
    await call<{ id: string }>("/register", {
      pid: targetPid, cwd: "/h/h", git_root: "/h/h", name: "h-selector-target", client_type: "codex",
      receiver_mode: "manual-drain",
    });
    const sent = await call<SendResult>("/send-to-peer", {
      id: sender.id, from_id: sender.id, selector: { name: "h-selector-target" }, text: "via selector",
    });
    expect(sent.ok).toBe(true);
    expect(sent.recipient?.state).toBe("no_drain_path");
    expect(sent.warning).toBeTruthy();
  });
});
