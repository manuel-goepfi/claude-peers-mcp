/**
 * One pane, one row, whatever session name a registrar reports for it.
 *
 * The session prefix of a `pane:<session>:%N` seat key is descriptive: the pane
 * id is what is unique on a tmux server. A live seat registered under one
 * session name (a grouped viewer session, recorded before the home-session
 * rule, or a session since renamed) must be merged when the same pane
 * re-registers under another name, never left beside a second active row that
 * makes every `tmux_pane_id` selector ambiguous.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { startTestBroker, type TestBroker } from "./helpers/test-broker.ts";

describe("seat merge across session names of one pane", () => {
  let broker: TestBroker;
  const tokens = new Map<string, string>();
  const children = new Set<ReturnType<typeof Bun.spawn>>();

  beforeAll(async () => {
    broker = await startTestBroker({ prefix: "seat-merge-session" });
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

  function register(pid: number, over: Record<string, unknown>) {
    return call<{ id: string; token: string }>("/register", {
      pid,
      cwd: "/seat-session/project",
      git_root: "/seat-session/project",
      name: "work.3",
      tmux_window_index: "1",
      tmux_window_name: "lane",
      client_type: "codex",
      receiver_mode: "manual-drain",
      ...over,
    });
  }

  function rowsOnPane(paneId: string) {
    const db = new Database(broker.dbPath, { readonly: true });
    try {
      return db.query(
        "SELECT id, pid, seat_key, tmux_session, seat_pids FROM peers WHERE tmux_pane_id = ? AND non_targetable = 0 ORDER BY registered_at",
      ).all(paneId) as Array<{ id: string; pid: number; seat_key: string | null; tmux_session: string | null; seat_pids: string }>;
    } finally {
      db.close();
    }
  }

  test("a pane recorded under a viewer session merges into its home-session registration", async () => {
    const tuiPid = spawnHolder();
    const hookPid = spawnHolder();
    // The seat was recorded through a grouped viewer session.
    const viewerRow = await register(tuiPid, { tmux_session: "viewer-3-abc", tmux_pane_id: "%810", tty: "pts/81" });
    expect(viewerRow.id).toBeTruthy();
    // A hook (or a reconnect) now registers the same pane under its home session.
    const homeRow = await register(hookPid, { tmux_session: "work", tmux_pane_id: "%810", tty: "pts/81" });

    expect(homeRow.id).toBe(viewerRow.id);
    const rows = rowsOnPane("%810");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seat_key).toBe("pane:work:%810");
    expect(rows[0]!.tmux_session).toBe("work");
    expect(JSON.parse(rows[0]!.seat_pids)).toEqual(expect.arrayContaining([tuiPid, hookPid]));

    // The pane resolves to one peer, not AMBIGUOUS_TARGET.
    const sender = await call<{ id: string }>("/register", {
      pid: spawnHolder(), cwd: "/seat-session/sender", git_root: null, tty: null, name: "sender",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, client_type: "claude", receiver_mode: "claude-channel",
    });
    const sent = await call<{ ok: boolean; code?: string }>("/send-to-peer", {
      from_id: sender.id,
      selector: { tmux_pane_id: "%810" },
      text: "one seat",
    });
    expect(sent.code).toBeUndefined();
    expect(sent.ok).toBe(true);
  });

  test("a pane that lost its session name (pane-only key) merges too", async () => {
    const first = await register(spawnHolder(), { tmux_session: null, tmux_pane_id: "%811", tty: "pts/82" });
    const second = await register(spawnHolder(), { tmux_session: "work", tmux_pane_id: "%811", tty: "pts/82" });
    expect(second.id).toBe(first.id);
    expect(rowsOnPane("%811").map((row) => row.seat_key)).toEqual(["pane:work:%811"]);
  });

  test("the same pane id with a different tty is another tmux server's pane and stays separate", async () => {
    const first = await register(spawnHolder(), { tmux_session: "alpha", tmux_pane_id: "%812", tty: "pts/83" });
    const second = await register(spawnHolder(), { tmux_session: "beta", tmux_pane_id: "%812", tty: "pts/84" });
    expect(second.id).not.toBe(first.id);
    expect(rowsOnPane("%812").map((row) => row.seat_key).sort()).toEqual(["pane:alpha:%812", "pane:beta:%812"]);
  });

  test("a different project on the same pane id is not adopted", async () => {
    const first = await register(spawnHolder(), { tmux_session: "gamma", tmux_pane_id: "%813", tty: "pts/85" });
    const second = await register(spawnHolder(), {
      tmux_session: "delta", tmux_pane_id: "%813", tty: "pts/85", cwd: "/seat-session/other", git_root: "/seat-session/other",
    });
    expect(second.id).not.toBe(first.id);
  });
});
