import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { startTestBroker, type TestBroker } from "./helpers/test-broker.ts";

const THREAD_A = "01A003F0-20EC-7AE2-ABA4-6C526AB304E9";
const THREAD_B = "01a003f0-20ec-7ae2-aba4-6c526ab304ea";

const brokers: TestBroker[] = [];
const holders: Array<ReturnType<typeof Bun.spawn>> = [];

afterEach(async () => {
  while (holders.length > 0) holders.pop()!.kill();
  while (brokers.length > 0) await brokers.pop()!.stop();
});

async function broker(prefix: string): Promise<TestBroker> {
  const started = await startTestBroker({ prefix });
  brokers.push(started);
  return started;
}

/** A long-lived process whose comm is `codex`, so the broker classifies it as a Codex client. */
function codexProcess(root: string): ReturnType<typeof Bun.spawn> {
  const binary = join(root, "codex");
  if (!existsSync(binary)) {
    copyFileSync("/usr/bin/sleep", binary);
    chmodSync(binary, 0o755);
  }
  const proc = Bun.spawn([binary, "60"], { stdout: "ignore", stderr: "ignore" });
  holders.push(proc);
  return proc;
}

function plainProcess(): ReturnType<typeof Bun.spawn> {
  const proc = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  holders.push(proc);
  return proc;
}

async function deadPid(): Promise<number> {
  const proc = Bun.spawn(["true"]);
  await proc.exited;
  return proc.pid;
}

async function register(target: TestBroker, fields: Record<string, unknown>): Promise<{ id: string; token: string }> {
  const response = await fetch(`${target.url}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd: target.root,
      git_root: null,
      absolute_git_dir: null,
      tty: null,
      tmux_session: null,
      tmux_window_index: null,
      tmux_window_name: null,
      tmux_pane_id: null,
      thread_id: null,
      summary: "",
      client_type: "codex",
      receiver_mode: "codex-hook",
      ...fields,
    }),
  });
  expect(response.status).toBe(200);
  return await response.json() as { id: string; token: string };
}

async function post(target: TestBroker, body: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${target.url}/codex-pane-bindings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const bindings = (target: TestBroker, callerPid: unknown = process.pid) =>
  post(target, JSON.stringify({ caller_pid: callerPid }));

/** Write row fields the HTTP surface cannot set, as a fixture would. */
function updatePeer(target: TestBroker, id: string, sql: string, ...values: Array<string | number | null>): void {
  const db = new Database(target.dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    db.query(`UPDATE peers SET ${sql} WHERE id = ?`).run(...values, id);
  } finally {
    db.close();
  }
}

describe("/codex-pane-bindings", () => {
  test("returns only live Codex pane bindings, newest first, without names or secrets", async () => {
    const target = await broker("codex-pane-bindings");
    const older = codexProcess(target.root);
    const newer = codexProcess(target.root);
    const olderPeer = await register(target, { pid: older.pid, name: "lane.1", tmux_pane_id: "%41", thread_id: THREAD_A });
    const newerPeer = await register(target, { pid: newer.pid, name: "lane.2", tmux_pane_id: "%42", thread_id: THREAD_B });
    updatePeer(target, olderPeer.id, "last_seen = ?", "2026-10-05T08:00:00.000Z");
    updatePeer(target, newerPeer.id, "last_seen = ?", "2026-10-05T09:00:00.000Z");

    // Excluded: a non-Codex client type, a process that is not Codex, a
    // non-targetable row, and rows without a pane or thread.
    await register(target, { pid: plainProcess().pid, name: "lane.3", tmux_pane_id: "%43", thread_id: THREAD_B, client_type: "claude", receiver_mode: "claude-channel" });
    await register(target, { pid: plainProcess().pid, name: "lane.4", tmux_pane_id: "%44", thread_id: THREAD_B });
    const hidden = codexProcess(target.root);
    const hiddenPeer = await register(target, { pid: hidden.pid, name: "lane.5", tmux_pane_id: "%45", thread_id: THREAD_B });
    updatePeer(target, hiddenPeer.id, "non_targetable = 1");
    const paneless = codexProcess(target.root);
    const panelessPeer = await register(target, { pid: paneless.pid, name: "lane.6", tmux_pane_id: "%46", thread_id: THREAD_B });
    updatePeer(target, panelessPeer.id, "tmux_pane_id = NULL");
    const threadless = codexProcess(target.root);
    await register(target, { pid: threadless.pid, name: "lane.7", tmux_pane_id: "%47", thread_id: null });

    const live = await bindings(target);
    expect(live.status).toBe(200);
    const rows = live.body.bindings as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      { pid: newer.pid, tmux_pane_id: "%42", thread_id: THREAD_B, last_seen: "2026-10-05T09:00:00.000Z" },
      { pid: older.pid, tmux_pane_id: "%41", thread_id: THREAD_A.toLowerCase(), last_seen: "2026-10-05T08:00:00.000Z" },
    ]);
    const raw = JSON.stringify(live.body);
    for (const secret of [olderPeer.token, newerPeer.token, "seat_pids", "resolved_name", "name", "token"]) {
      expect(raw).not.toContain(secret);
    }

    older.kill();
    await older.exited;
    const afterExit = await bindings(target);
    expect(afterExit.status).toBe(200);
    expect((afterExit.body.bindings as Array<{ pid: number }>).map((row) => row.pid)).toEqual([newer.pid]);
  });

  test("rejects a malformed body or caller pid with 400 and a dead or foreign caller with 403", async () => {
    const target = await broker("codex-pane-bindings-auth");
    for (const body of ["null", "[]", "\"x\"", "not json", "{}"]) {
      expect((await post(target, body)).status).toBe(400);
    }
    for (const callerPid of [String(process.pid), 1, 1.5, -4, null]) {
      expect((await bindings(target, callerPid)).status).toBe(400);
    }
    expect((await bindings(target, await deadPid())).status).toBe(403);
    // pid 2 is a root-owned kernel thread: verifyPidUid refuses another UID.
    const foreign = await bindings(target, 2);
    expect(foreign.status).toBe(403);
    expect(String(foreign.body.error)).toContain("caller rejected");
  });

  test("rate-limits per caller pid before verifying it", async () => {
    const target = await broker("codex-pane-bindings-rate");
    const caller = await deadPid();
    const statuses = await Promise.all(Array.from({ length: 600 }, () => bindings(target, caller).then((r) => r.status)));
    expect(new Set(statuses)).toEqual(new Set([403]));
    const limited = await bindings(target, caller);
    expect(limited.status).toBe(429);
    expect(String(limited.body.error)).toContain("rate limit");
    expect((await bindings(target)).status).toBe(200);
  });

  test("advertises the observation capability on /health", async () => {
    const target = await broker("codex-pane-bindings-health");
    const health = await (await fetch(`${target.url}/health`)).json() as {
      capabilities?: { observation?: { codexPaneBindings?: boolean } };
    };
    expect(health.capabilities?.observation?.codexPaneBindings).toBe(true);
  });
});
