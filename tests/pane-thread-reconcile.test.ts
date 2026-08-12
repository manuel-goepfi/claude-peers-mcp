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
    for (const child of children) child.kill();
    await broker.stop();
  });

  function spawnHolder(): number {
    const child = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    children.add(child);
    return child.pid;
  }

  async function call(path: string, body: Record<string, unknown>) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const claimedId = (body.id as string | undefined) ?? (body.from_id as string | undefined);
    if (claimedId && tokens.has(claimedId)) headers["X-Peer-Token"] = tokens.get(claimedId)!;
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
      "SELECT id, pid, tmux_pane_id, thread_id FROM peers WHERE thread_id = ? ORDER BY id",
    ).all(THREAD) as Array<{ id: string; pid: number; tmux_pane_id: string | null; thread_id: string }>;
    const mail = db.query(
      "SELECT to_id, text, delivered FROM messages WHERE text = 'stranded before reconcile'",
    ).get() as { to_id: string; text: string; delivered: number };
    db.close();
    expect(rows).toEqual([{ id: paneRowId, pid: panePid, tmux_pane_id: "%904", thread_id: THREAD }]);
    expect(mail).toEqual({ to_id: paneRowId, text: "stranded before reconcile", delivered: 0 });

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

  test("refuses to replace a pane row's existing different thread", async () => {
    const panePid = spawnHolder();
    const pane = await register(panePid, {
      name: "conflict.1",
      tty: "pts/905",
      tmux_session: "infra",
      tmux_pane_id: "%905",
      thread_id: "11111111-2222-4333-8444-555555555555",
    });

    const response = await call("/reconcile-pane-thread", {
      id: pane.json.id,
      pid: panePid,
      caller_pid: process.pid,
      tmux_pane_id: "%905",
      thread_id: THREAD,
    });
    expect(response.status).toBe(409);
    expect(response.json.error).toBe("pane already belongs to a different thread");
  });

  test("refuses to fold a thread identity that is already bound to another concrete pane", async () => {
    const firstPid = spawnHolder();
    const secondPid = spawnHolder();
    await register(firstPid, {
      name: "concrete.1",
      tty: "pts/906",
      tmux_session: "infra",
      tmux_pane_id: "%906",
      thread_id: "22222222-3333-4444-8555-666666666666",
    });
    const second = await register(secondPid, {
      name: "concrete.2",
      tty: "pts/907",
      tmux_session: "infra",
      tmux_pane_id: "%907",
    });

    const response = await call("/reconcile-pane-thread", {
      id: second.json.id,
      pid: secondPid,
      caller_pid: process.pid,
      tmux_pane_id: "%907",
      thread_id: "22222222-3333-4444-8555-666666666666",
    });
    expect(response.status).toBe(409);
    expect(response.json.error).toBe("thread is already bound to another pane");
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
});
