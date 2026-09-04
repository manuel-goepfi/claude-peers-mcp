import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { startTestBroker, type TestBroker } from "./helpers/test-broker.ts";

const THREAD = "019ff65b-9ea6-7751-898a-9c645d30b1e6";

describe("pane/thread reconciliation", () => {
  let broker: TestBroker;
  const tokens = new Map<string, string>();
  const children = new Set<ReturnType<typeof Bun.spawn>>();

  beforeAll(async () => {
    broker = await startTestBroker({ prefix: "pane-thread-reconcile" });
  }, 35_000);

  afterAll(async () => {
    await Promise.all([...children].map(async (child) => {
      child.kill();
      await child.exited;
    }));
    await broker.stop();
  });

  function spawnHolder(): number {
    const child = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    children.add(child);
    return child.pid;
  }

  async function stopHolder(pid: number): Promise<void> {
    const child = [...children].find((candidate) => candidate.pid === pid);
    if (!child) throw new Error(`holder ${pid} not found`);
    child.kill();
    await child.exited;
    children.delete(child);
  }

  async function call(
    path: string,
    body: Record<string, unknown>,
    headerOverrides: Record<string, string> = {},
  ) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const claimedId = (body.id as string | undefined) ?? (body.from_id as string | undefined);
    if (claimedId && tokens.has(claimedId)) headers["X-Peer-Token"] = tokens.get(claimedId)!;
    Object.assign(headers, headerOverrides);
    const response = await fetch(`${broker.url}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const json = await response.json() as Record<string, unknown>;
    if (json.id && json.token) tokens.set(String(json.id), String(json.token));
    return { status: response.status, json };
  }

  async function register(pid: number, overrides: Record<string, unknown> = {}) {
    return call("/register", {
      pid,
      cwd: "/pane-thread/project",
      git_root: "/pane-thread/project",
      tty: null,
      name: `peer-${pid}`,
      tmux_session: null,
      tmux_window_index: null,
      tmux_window_name: null,
      tmux_pane_id: null,
      client_type: "codex",
      receiver_mode: "manual-drain",
      summary: "",
      ...overrides,
    });
  }

  test("folds a thread-only row into its exact pane row without dropping mail", async () => {
    const hostPid = spawnHolder();
    const panePid = spawnHolder();
    const senderPid = spawnHolder();

    const threadRow = await register(hostPid, {
      name: "codex-thread-only",
      thread_id: THREAD.toUpperCase(),
      receiver_mode: "codex-hook",
    });
    const paneRow = await register(panePid, {
      name: "infra.4",
      tty: "pts/904",
      tmux_session: "infra",
      tmux_window_index: "1",
      tmux_window_name: "infra",
      tmux_pane_id: "%904",
    });
    const sender = await register(senderPid, { name: "sender.1", client_type: "claude" });
    expect(threadRow.status).toBe(200);
    expect(paneRow.status).toBe(200);
    expect(sender.status).toBe(200);
    const threadRowId = String(threadRow.json.id);
    const paneRowId = String(paneRow.json.id);

    const summary = await call("/set-summary", {
      id: threadRowId,
      summary: "thread receiver is ready",
    });
    expect(summary.status).toBe(200);
    const heartbeat = await call("/hook-heartbeat-by-thread", {
      thread_id: THREAD.toUpperCase(),
      caller_pid: process.pid,
      client_type: "codex",
      receiver_mode: "codex-hook",
      status: "error",
      drained: 0,
      error: "thread drain failed",
    });
    expect(heartbeat.status).toBe(200);

    const sent = await call("/send-message", {
      id: sender.json.id,
      from_id: sender.json.id,
      to_id: threadRowId,
      text: "stranded before reconcile",
    });
    expect(sent.status).toBe(200);

    const reconciled = await call("/reconcile-pane-thread", {
      id: paneRowId,
      pid: panePid,
      caller_pid: process.pid,
      tmux_pane_id: "%904",
      thread_id: THREAD,
    });
    expect(reconciled.status).toBe(200);
    expect(reconciled.json).toMatchObject({
      ok: true,
      id: paneRowId,
      thread_id: THREAD,
      folded: 1,
      migrated: 1,
    });

    const db = new Database(broker.dbPath, { readonly: true });
    const rows = db.query(
      "SELECT id, pid, tmux_pane_id, thread_id, unread_episode FROM peers WHERE thread_id = ? ORDER BY id",
    ).all(THREAD) as Array<{ id: string; pid: number; tmux_pane_id: string | null; thread_id: string; unread_episode: number }>;
    const mail = db.query(
      "SELECT to_id, text, delivered FROM messages WHERE text = 'stranded before reconcile'",
    ).get() as { to_id: string; text: string; delivered: number };
    db.close();
    expect(rows).toEqual([{ id: paneRowId, pid: panePid, tmux_pane_id: "%904", thread_id: THREAD, unread_episode: 1 }]);
    expect(mail).toEqual({ to_id: paneRowId, text: "stranded before reconcile", delivered: 0 });

    const listed = await call("/list-peers", { id: paneRowId, scope: "machine" });
    expect(listed.status).toBe(200);
    const visible = (listed.json as unknown as Array<Record<string, unknown>>)
      .find((peer) => peer.id === paneRowId);
    expect(visible).toMatchObject({
      id: paneRowId,
      receiver_mode: "codex-hook",
      summary: "thread receiver is ready",
      last_drain_error: "thread drain failed",
    });
    expect(visible?.last_hook_seen_at).toBeString();

    const claimed = await call("/claim-by-thread", {
      thread_id: THREAD,
      caller_pid: process.pid,
      client_type: "codex",
      receiver_mode: "codex-hook",
      drain_id: "pane-thread-test",
      limit: 25,
      max_bytes: 64 * 1024,
    });
    expect(claimed.status).toBe(200);
    expect((claimed.json.messages as Array<{ text: string }>).map((message) => message.text)).toContain("stranded before reconcile");

    const again = await call("/reconcile-pane-thread", {
      id: paneRowId,
      pid: panePid,
      caller_pid: process.pid,
      tmux_pane_id: "%904",
      thread_id: THREAD,
    });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ folded: 0, migrated: 0 });
  });

  test("merges conflicting receiver state with deterministic field precedence", async () => {
    const thread = "12121212-3434-4567-89ab-cdefabcdefab";
    const hostPid = spawnHolder();
    const panePid = spawnHolder();
    const duplicate = await register(hostPid, {
      name: "state-duplicate",
      thread_id: thread,
      receiver_mode: "codex-hook",
      summary: "duplicate summary",
    });
    const pane = await register(panePid, {
      name: "state-target",
      tty: "pts/917",
      tmux_session: "infra",
      tmux_pane_id: "%917",
      summary: "target summary",
    });
    const writable = new Database(broker.dbPath);
    writable.run(`
      UPDATE peers
      SET receiver_mode = 'codex-hook',
          last_hook_seen_at = '2026-08-12T12:00:01.000Z',
          last_drain_at = '2026-08-12T12:00:04.000Z',
          last_drain_error = 'older hook error'
      WHERE id = ?
    `, [String(duplicate.json.id)]);
    writable.run(`
      UPDATE peers
      SET last_hook_seen_at = '2026-08-12T12:00:03.000Z',
          last_drain_at = '2026-08-12T12:00:02.000Z',
          last_drain_error = 'newest hook error'
      WHERE id = ?
    `, [String(pane.json.id)]);
    writable.close();

    const reconciled = await call("/reconcile-pane-thread", {
      id: pane.json.id,
      pid: panePid,
      caller_pid: process.pid,
      tmux_pane_id: "%917",
      thread_id: thread,
    });
    expect(reconciled.status).toBe(200);
    const db = new Database(broker.dbPath, { readonly: true });
    const receiverStateAfterFold = db.query(`
      SELECT receiver_mode, summary, last_hook_seen_at, last_drain_at, last_drain_error
      FROM peers WHERE id = ?
    `).get(String(pane.json.id));
    expect(receiverStateAfterFold).toEqual({
      receiver_mode: "codex-hook",
      summary: "target summary",
      last_hook_seen_at: "2026-08-12T12:00:03.000Z",
      last_drain_at: "2026-08-12T12:00:04.000Z",
      last_drain_error: "newest hook error",
    });
    db.close();

    const repeated = await call("/reconcile-pane-thread", {
      id: pane.json.id,
      pid: panePid,
      caller_pid: process.pid,
      tmux_pane_id: "%917",
      thread_id: thread,
    });
    expect(repeated.status).toBe(200);
    expect(repeated.json).toMatchObject({ folded: 0, migrated: 0 });
    const afterRepeatDb = new Database(broker.dbPath, { readonly: true });
    expect(afterRepeatDb.query(`
      SELECT receiver_mode, summary, last_hook_seen_at, last_drain_at, last_drain_error
      FROM peers WHERE id = ?
    `).get(String(pane.json.id))).toEqual(receiverStateAfterFold);
    afterRepeatDb.close();
  });

  test("duplicate health and mail cannot fabricate a new target unread episode", async () => {
    const thread = "23232323-4545-4678-9abc-defabcdefabc";
    const hostPid = spawnHolder();
    const panePid = spawnHolder();
    const senderPid = spawnHolder();
    const duplicate = await register(hostPid, {
      name: "episode-duplicate",
      thread_id: thread,
      receiver_mode: "codex-hook",
    });
    const pane = await register(panePid, {
      name: "episode-target",
      tty: "pts/918",
      tmux_session: "infra",
      tmux_pane_id: "%918",
    });
    const sender = await register(senderPid, { name: "episode-sender", client_type: "claude" });
    await call("/send-message", {
      id: sender.json.id,
      from_id: sender.json.id,
      to_id: pane.json.id,
      text: "target episode mail",
    });
    await call("/send-message", {
      id: sender.json.id,
      from_id: sender.json.id,
      to_id: duplicate.json.id,
      text: "duplicate episode mail",
    });
    const writable = new Database(broker.dbPath);
    writable.run("UPDATE peers SET last_drain_at = '2026-08-12T12:00:01.000Z' WHERE id = ?", [String(duplicate.json.id)]);
    expect(writable.query("SELECT unread_episode FROM peers WHERE id = ?").get(String(pane.json.id)))
      .toEqual({ unread_episode: 1 });
    writable.close();

    const reconciled = await call("/reconcile-pane-thread", {
      id: pane.json.id,
      pid: panePid,
      caller_pid: process.pid,
      tmux_pane_id: "%918",
      thread_id: thread,
    });
    expect(reconciled.status).toBe(200);
    expect(reconciled.json).toMatchObject({ folded: 1, migrated: 1 });

    const db = new Database(broker.dbPath, { readonly: true });
    expect(db.query("SELECT unread_episode, last_drain_at FROM peers WHERE id = ?").get(String(pane.json.id)))
      .toEqual({ unread_episode: 1, last_drain_at: "2026-08-12T12:00:01.000Z" });
    expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE to_id = ? AND delivered = 0").get(String(pane.json.id)))
      .toEqual({ count: 2 });
    db.close();
  });

  test("rebinds the verified current pane when it moves to a new thread", async () => {
    const newThread = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    const oldThread = "11111111-2222-4333-8444-555555555555";
    const panePid = spawnHolder();
    const pane = await register(panePid, {
      name: "conflict.1",
      tty: "pts/905",
      tmux_session: "infra",
      tmux_pane_id: "%905",
      thread_id: oldThread,
    });

    const response = await call("/reconcile-pane-thread", {
      id: pane.json.id,
      pid: panePid,
      caller_pid: process.pid,
      tmux_pane_id: "%905",
      thread_id: newThread,
    });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      id: pane.json.id,
      thread_id: newThread,
      folded: 0,
      migrated: 0,
    });

    const db = new Database(broker.dbPath, { readonly: true });
    expect(db.query("SELECT thread_id FROM peers WHERE id = ?").get(String(pane.json.id)))
      .toEqual({ thread_id: newThread });
    db.close();

    const newProofResponse = await fetch(`${broker.url}/identity-by-thread`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: newThread, caller_pid: process.pid }),
    });
    expect(newProofResponse.status).toBe(200);
    expect(await newProofResponse.json()).toMatchObject({ id: pane.json.id, thread_id: newThread });
    const oldProofResponse = await fetch(`${broker.url}/identity-by-thread`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: oldThread, caller_pid: process.pid }),
    });
    expect(oldProofResponse.status).toBe(404);

    const repeated = await call("/reconcile-pane-thread", {
      id: pane.json.id,
      pid: panePid,
      caller_pid: process.pid,
      tmux_pane_id: "%905",
      thread_id: newThread,
    });
    expect(repeated.status).toBe(200);
    expect(repeated.json).toMatchObject({ folded: 0, migrated: 0 });
  });

  test("preserves queued, claimed, and acknowledged message semantics while folding", async () => {
    const thread = "44444444-5555-4666-8777-888888888888";
    const hostPid = spawnHolder();
    const panePid = spawnHolder();
    const senderPid = spawnHolder();
    const threadRow = await register(hostPid, {
      name: "state-thread",
      thread_id: thread,
      receiver_mode: "codex-hook",
    });
    const paneRow = await register(panePid, {
      name: "state-pane",
      tty: "pts/910",
      tmux_session: "infra",
      tmux_pane_id: "%910",
    });
    const sender = await register(senderPid, { name: "state-sender", client_type: "claude" });
    const threadId = String(threadRow.json.id);
    const paneId = String(paneRow.json.id);

    const ackCandidate = await call("/send-message", {
      id: sender.json.id,
      from_id: sender.json.id,
      to_id: threadId,
      text: "acknowledged before fold",
    });
    const firstClaim = await call("/claim-by-thread", {
      thread_id: thread,
      caller_pid: process.pid,
      client_type: "codex",
      receiver_mode: "codex-hook",
      drain_id: "ack-before-fold",
    });
    expect(firstClaim.status).toBe(200);
    const firstAck = await call("/ack-by-thread", {
      thread_id: thread,
      caller_pid: process.pid,
      client_type: "codex",
      receiver_mode: "codex-hook",
      drain_id: "ack-before-fold",
      ids: [Number(ackCandidate.json.id)],
      via: "test",
    });
    expect(firstAck.json.acked).toBe(1);

    const claimedCandidate = await call("/send-message", {
      id: sender.json.id,
      from_id: sender.json.id,
      to_id: threadId,
      text: "claimed across fold",
    });
    const secondClaim = await call("/claim-by-thread", {
      thread_id: thread,
      caller_pid: process.pid,
      client_type: "codex",
      receiver_mode: "codex-hook",
      drain_id: "claim-across-fold",
    });
    expect((secondClaim.json.messages as Array<{ id: number }>).map((message) => message.id))
      .toEqual([Number(claimedCandidate.json.id)]);
    const queuedCandidate = await call("/send-message", {
      id: sender.json.id,
      from_id: sender.json.id,
      to_id: threadId,
      text: "queued across fold",
    });

    const reconciled = await call("/reconcile-pane-thread", {
      id: paneId,
      pid: panePid,
      caller_pid: process.pid,
      tmux_pane_id: "%910",
      thread_id: thread,
    });
    expect(reconciled.json).toMatchObject({ folded: 1, migrated: 2 });

    const db = new Database(broker.dbPath, { readonly: true });
    const states = db.query(`
      SELECT id, to_id, delivered, claimed_by
      FROM messages
      WHERE id IN (?, ?, ?)
      ORDER BY id
    `).all(
      Number(ackCandidate.json.id),
      Number(claimedCandidate.json.id),
      Number(queuedCandidate.json.id),
    ) as Array<{ id: number; to_id: string; delivered: number; claimed_by: string | null }>;
    db.close();
    expect(states).toEqual([
      { id: Number(ackCandidate.json.id), to_id: threadId, delivered: 1, claimed_by: null },
      { id: Number(claimedCandidate.json.id), to_id: paneId, delivered: 0, claimed_by: "claim-across-fold" },
      { id: Number(queuedCandidate.json.id), to_id: paneId, delivered: 0, claimed_by: null },
    ]);

    const continuedAck = await call("/ack-by-thread", {
      thread_id: thread,
      caller_pid: process.pid,
      client_type: "codex",
      receiver_mode: "codex-hook",
      drain_id: "claim-across-fold",
      ids: [Number(claimedCandidate.json.id)],
      via: "test",
    });
    expect(continuedAck.json.acked).toBe(1);
    const queuedClaim = await call("/claim-by-thread", {
      thread_id: thread,
      caller_pid: process.pid,
      client_type: "codex",
      receiver_mode: "codex-hook",
      drain_id: "claim-after-fold",
    });
    expect((queuedClaim.json.messages as Array<{ id: number }>).map((message) => message.id))
      .toEqual([Number(queuedCandidate.json.id)]);
  });

  test("transfers a live prior pane for the same thread onto the destination pane", async () => {
    const thread = "22222222-3333-4444-8555-666666666666";
    const firstPid = spawnHolder();
    const secondPid = spawnHolder();
    const senderPid = spawnHolder();
    const first = await register(firstPid, {
      name: "concrete.1",
      tty: "pts/906",
      tmux_session: "infra",
      tmux_pane_id: "%906",
      thread_id: thread,
    });
    const second = await register(secondPid, {
      name: "concrete.2",
      tty: "pts/907",
      tmux_session: "infra",
      tmux_pane_id: "%907",
    });
    const sender = await register(senderPid, { name: "live-transfer-sender", client_type: "claude" });
    const sent = await call("/send-message", {
      id: sender.json.id,
      from_id: sender.json.id,
      to_id: first.json.id,
      text: "mail follows live resume",
    });
    expect(sent.status).toBe(200);

    const response = await call("/reconcile-pane-thread", {
      id: second.json.id,
      pid: secondPid,
      caller_pid: process.pid,
      tmux_pane_id: "%907",
      thread_id: thread,
    });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      ok: true,
      id: second.json.id,
      thread_id: thread,
      folded: 1,
      migrated: 1,
    });

    const db = new Database(broker.dbPath, { readonly: true });
    const row = db.query(
      "SELECT id, pid, name, tmux_pane_id, thread_id FROM peers WHERE thread_id = ?",
    ).get(thread) as { id: string; pid: number; name: string; tmux_pane_id: string; thread_id: string };
    const mail = db.query(
      "SELECT to_id, text FROM messages WHERE text = 'mail follows live resume'",
    ).get() as { to_id: string; text: string };
    const gone = db.query("SELECT id FROM peers WHERE id = ?").get(String(first.json.id));
    db.close();
    expect(row).toEqual({
      id: String(second.json.id),
      pid: secondPid,
      name: "concrete.2",
      tmux_pane_id: "%907",
      thread_id: thread,
    });
    expect(mail).toEqual({ to_id: String(second.json.id), text: "mail follows live resume" });
    expect(gone).toBeNull();

    // Stale token from the prior live pane must step down as superseded.
    const stale = await fetch(`${broker.url}/set-summary`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Peer-Token": String(first.json.token),
      },
      body: JSON.stringify({ id: first.json.id, summary: "should not stick" }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "superseded" });
  });

  test("refuses a valid Codex pane adopting a thread owned by another client", async () => {
    const thread = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const claudePid = spawnHolder();
    const panePid = spawnHolder();
    const senderPid = spawnHolder();
    const claude = await register(claudePid, {
      name: "claude-thread-owner",
      client_type: "claude",
      receiver_mode: "claude-channel",
      thread_id: thread,
    });
    const pane = await register(panePid, {
      name: "codex-adopter",
      tty: "pts/916",
      tmux_session: "infra",
      tmux_pane_id: "%916",
    });
    const sender = await register(senderPid, { name: "cross-client-sender", client_type: "claude" });
    await call("/send-message", {
      id: sender.json.id,
      from_id: sender.json.id,
      to_id: claude.json.id,
      text: "must stay with Claude",
    });

    const beforeDb = new Database(broker.dbPath, { readonly: true });
    const peersBefore = beforeDb.query("SELECT id, thread_id FROM peers WHERE id IN (?, ?) ORDER BY id")
      .all(String(claude.json.id), String(pane.json.id));
    beforeDb.close();
    const response = await call("/reconcile-pane-thread", {
      id: pane.json.id,
      pid: panePid,
      caller_pid: process.pid,
      tmux_pane_id: "%916",
      thread_id: thread,
    });
    expect(response.status).toBe(409);
    expect(response.json.error).toBe("thread is already bound to another client");

    const afterDb = new Database(broker.dbPath, { readonly: true });
    expect(afterDb.query("SELECT id, thread_id FROM peers WHERE id IN (?, ?) ORDER BY id")
      .all(String(claude.json.id), String(pane.json.id))).toEqual(peersBefore);
    expect(afterDb.query("SELECT to_id, delivered FROM messages WHERE text = 'must stay with Claude'").get())
      .toEqual({ to_id: claude.json.id, delivered: 0 });
    afterDb.close();
  });

  test("adopts a dead prior pane for the same thread and preserves its mail", async () => {
    const thread = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    const oldPid = spawnHolder();
    const newPid = spawnHolder();
    const senderPid = spawnHolder();
    const oldPane = await register(oldPid, {
      name: "resume-old",
      tty: "pts/913",
      tmux_session: "infra",
      tmux_pane_id: "%913",
      thread_id: thread,
      receiver_mode: "codex-hook",
    });
    const newPane = await register(newPid, {
      name: "resume-new",
      tty: "pts/914",
      tmux_session: "infra",
      tmux_pane_id: "%914",
    });
    const sender = await register(senderPid, { name: "resume-sender", client_type: "claude" });
    const sent = await call("/send-message", {
      id: sender.json.id,
      from_id: sender.json.id,
      to_id: oldPane.json.id,
      text: "mail survives dead-pane resume",
    });
    expect(sent.status).toBe(200);
    await stopHolder(oldPid);

    const response = await call("/reconcile-pane-thread", {
      id: newPane.json.id,
      pid: newPid,
      caller_pid: process.pid,
      tmux_pane_id: "%914",
      thread_id: thread,
    });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ folded: 1, migrated: 1 });

    const claim = await call("/claim-by-thread", {
      thread_id: thread,
      caller_pid: process.pid,
      client_type: "codex",
      receiver_mode: "codex-hook",
      drain_id: "dead-pane-resume",
    });
    expect((claim.json.messages as Array<{ text: string }>).map((message) => message.text))
      .toEqual(["mail survives dead-pane resume"]);
  });

  test("rolls back every fold write on a mid-transaction SQLite failure and retries cleanly", async () => {
    const thread = "88888888-9999-4aaa-8bbb-cccccccccccc";
    const hostPid = spawnHolder();
    const panePid = spawnHolder();
    const senderPid = spawnHolder();
    const duplicate = await register(hostPid, {
      name: "rollback-thread",
      thread_id: thread,
      receiver_mode: "codex-hook",
      summary: "rollback duplicate summary",
    });
    const pane = await register(panePid, {
      name: "rollback-pane",
      tty: "pts/915",
      tmux_session: "infra",
      tmux_pane_id: "%915",
      summary: "rollback target summary",
    });
    const sender = await register(senderPid, { name: "rollback-sender", client_type: "claude" });
    await call("/send-message", {
      id: sender.json.id,
      from_id: sender.json.id,
      to_id: duplicate.json.id,
      text: "must survive rollback",
    });

    const claimed = await call("/claim-by-thread", {
      thread_id: thread,
      caller_pid: process.pid,
      client_type: "codex",
      receiver_mode: "codex-hook",
      drain_id: "rollback-claim",
    });
    expect((claimed.json.messages as Array<{ text: string }>).map((message) => message.text))
      .toEqual(["must survive rollback"]);

    const writable = new Database(broker.dbPath);
    writable.run(`
      UPDATE peers
      SET last_hook_seen_at = '2026-08-12T13:00:01.000Z',
          last_drain_at = '2026-08-12T13:00:02.000Z',
          last_drain_error = 'rollback duplicate error'
      WHERE id = ?
    `, [String(duplicate.json.id)]);
    writable.run(`
      UPDATE peers
      SET last_hook_seen_at = '2026-08-12T13:00:03.000Z',
          last_drain_at = '2026-08-12T13:00:00.000Z',
          last_drain_error = 'rollback target error'
      WHERE id = ?
    `, [String(pane.json.id)]);
    const peersBefore = writable.query(`
      SELECT id, thread_id, receiver_mode, summary, last_hook_seen_at, last_drain_at, last_drain_error, unread_episode
      FROM peers WHERE id IN (?, ?) ORDER BY id
    `).all(String(duplicate.json.id), String(pane.json.id));
    const mailBefore = writable.query(`
      SELECT to_id, delivered, claimed_by, claimed_at
      FROM messages WHERE text = 'must survive rollback'
    `).get();
    writable.run(`
      CREATE TRIGGER fail_reconcile_final_thread_update
      BEFORE UPDATE OF thread_id ON peers
      WHEN OLD.id = '${String(pane.json.id)}' AND NEW.thread_id = '${thread}'
      BEGIN
        SELECT RAISE(ABORT, 'planted reconcile failure');
      END
    `);
    const body = {
      id: pane.json.id,
      pid: panePid,
      caller_pid: process.pid,
      tmux_pane_id: "%915",
      thread_id: thread,
    };
    const failed = await call("/reconcile-pane-thread", body);
    expect(failed.status).toBe(500);
    expect(failed.json.error).toBe("internal error");

    const peersAfterFailure = writable.query(`
      SELECT id, thread_id, receiver_mode, summary, last_hook_seen_at, last_drain_at, last_drain_error, unread_episode
      FROM peers WHERE id IN (?, ?) ORDER BY id
    `).all(String(duplicate.json.id), String(pane.json.id));
    const mailAfterFailure = writable.query(`
      SELECT to_id, delivered, claimed_by, claimed_at
      FROM messages WHERE text = 'must survive rollback'
    `).get();
    expect(peersAfterFailure).toEqual(peersBefore);
    expect(mailAfterFailure).toEqual(mailBefore);

    writable.run("DROP TRIGGER fail_reconcile_final_thread_update");
    writable.close();
    const retried = await call("/reconcile-pane-thread", body);
    expect(retried.status).toBe(200);
    expect(retried.json).toMatchObject({ folded: 1, migrated: 1 });
    const afterRetryDb = new Database(broker.dbPath, { readonly: true });
    expect(afterRetryDb.query("SELECT unread_episode FROM peers WHERE id = ?").get(String(pane.json.id)))
      .toEqual({ unread_episode: 1 });
    afterRetryDb.close();
    const repeated = await call("/reconcile-pane-thread", body);
    expect(repeated.status).toBe(200);
    expect(repeated.json).toMatchObject({ folded: 0, migrated: 0 });
    const afterRepeatDb = new Database(broker.dbPath, { readonly: true });
    expect(afterRepeatDb.query("SELECT unread_episode FROM peers WHERE id = ?").get(String(pane.json.id)))
      .toEqual({ unread_episode: 1 });
    afterRepeatDb.close();
  });

  test("rejects malformed identity and an id/pid/pane mismatch", async () => {
    const panePid = spawnHolder();
    const otherPid = spawnHolder();
    const pane = await register(panePid, {
      name: "validation.1",
      tty: "pts/908",
      tmux_session: "infra",
      tmux_pane_id: "%908",
    });

    const malformed = await call("/reconcile-pane-thread", {
      id: pane.json.id,
      pid: panePid,
      caller_pid: process.pid,
      tmux_pane_id: "%908",
      thread_id: "not-a-thread",
    });
    expect(malformed.status).toBe(400);

    const mismatch = await call("/reconcile-pane-thread", {
      id: pane.json.id,
      pid: otherPid,
      caller_pid: process.pid,
      tmux_pane_id: "%908",
      thread_id: THREAD,
    });
    expect(mismatch.status).toBe(404);
    expect(mismatch.json.error).toBe("pane peer not found");
  });

  test("requires the exact pane peer token", async () => {
    const panePid = spawnHolder();
    const pane = await register(panePid, {
      name: "auth.1",
      tty: "pts/909",
      tmux_session: "infra",
      tmux_pane_id: "%909",
    });
    const body = {
      id: pane.json.id,
      pid: panePid,
      caller_pid: process.pid,
      tmux_pane_id: "%909",
      thread_id: "33333333-4444-4555-8666-777777777777",
    };

    const missing = await call("/reconcile-pane-thread", body, { "X-Peer-Token": "" });
    expect(missing.status).toBe(401);
    expect(missing.json.error).toBe("missing x-peer-token");

    const wrong = await call("/reconcile-pane-thread", body, { "X-Peer-Token": "wrong-token" });
    expect(wrong.status).toBe(401);
    expect(wrong.json.error).toBe("invalid token for peer");

    const db = new Database(broker.dbPath, { readonly: true });
    const stored = db.query("SELECT thread_id FROM peers WHERE id = ?").get(String(pane.json.id)) as { thread_id: string | null };
    db.close();
    expect(stored.thread_id).toBeNull();
  });

  test("rejects dead PID proof, non-Codex targets, and pane mismatches", async () => {
    const panePid = spawnHolder();
    const pane = await register(panePid, {
      name: "guard.1",
      tty: "pts/911",
      tmux_session: "infra",
      tmux_pane_id: "%911",
    });
    const base = {
      id: pane.json.id,
      pid: panePid,
      caller_pid: process.pid,
      tmux_pane_id: "%911",
      thread_id: "55555555-6666-4777-8888-999999999999",
    };

    const deadCaller = await call("/reconcile-pane-thread", {
      ...base,
      caller_pid: 2_147_483_647,
    });
    expect(deadCaller.status).toBe(403);
    expect(String(deadCaller.json.error)).toStartWith("caller rejected:");

    const wrongPane = await call("/reconcile-pane-thread", {
      ...base,
      tmux_pane_id: "%999",
    });
    expect(wrongPane.status).toBe(404);

    const claudePid = spawnHolder();
    const claude = await register(claudePid, {
      name: "guard-claude",
      tty: "pts/912",
      tmux_session: "infra",
      tmux_pane_id: "%912",
      client_type: "claude",
    });
    const wrongClient = await call("/reconcile-pane-thread", {
      ...base,
      id: claude.json.id,
      pid: claudePid,
      tmux_pane_id: "%912",
    });
    expect(wrongClient.status).toBe(404);

    await stopHolder(panePid);
    const deadTarget = await call("/reconcile-pane-thread", base);
    expect(deadTarget.status).toBe(403);
    expect(String(deadTarget.json.error)).toStartWith("target rejected:");
  });
});
