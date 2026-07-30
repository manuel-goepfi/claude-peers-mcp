/**
 * /send-by-pid — send AS the seat the caller occupies.
 *
 * Why it exists, measured end-to-end 2026-07-30: the CLI registered a throwaway
 * non_targetable identity, sent, and exited. A codex lane received the message,
 * tried to answer twice, and both replies died with "peer not found" because the
 * sender no longer resolved. Queued mail with an unreachable sender is a
 * conversation that cannot happen.
 *
 * The authorisation property is the interesting part and is asserted below: the
 * seat is DERIVED from the caller's process ancestry, never asserted by the caller,
 * so a process outside any seat gets no attribution rather than a seat of its
 * choosing. Ancestry (not /proc/<pid>/environ) because environ is ptrace-gated:
 * under kernel.yama.ptrace_scope=1 the broker can only read the environment of its
 * own descendants, so an env-based proof fails closed for every real caller.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { startTestBroker, type TestBroker } from "./helpers/test-broker.ts";

describe("/send-by-pid", () => {
  let broker: TestBroker;
  const tokens = new Map<string, string>();
  const children = new Set<ReturnType<typeof Bun.spawn>>();

  beforeAll(async () => {
    broker = await startTestBroker({ prefix: "send-by-pid" });
  }, 35_000);

  afterAll(async () => {
    for (const child of children) child.kill();
    await broker.stop();
  });

  /** A plain live process, used as a seat occupant or an unrelated caller. */
  function spawnHolder(): number {
    const child = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    children.add(child);
    return child.pid;
  }

  /**
   * A seat process plus a live DESCENDANT of it. The descendant stands in for
   * `claude-peers send` typed inside that session — which is exactly the
   * relationship the endpoint requires, since the seat is derived from ancestry.
   */
  async function spawnSeatWithChild(): Promise<{ seatPid: number; childPid: number }> {
    const proc = Bun.spawn(["bash", "-c", "sleep 60 & echo $! ; wait"], { stdout: "pipe", stderr: "ignore" });
    children.add(proc);
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    const childPid = Number(new TextDecoder().decode(value).trim());
    return { seatPid: proc.pid!, childPid };
  }

  async function call<T>(path: string, body: Record<string, unknown>): Promise<{ status: number; json: T }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const claimed = (body.id as string | undefined) ?? (body.from_id as string | undefined);
    if (claimed && tokens.has(claimed)) headers["X-Peer-Token"] = tokens.get(claimed)!;
    const res = await fetch(`${broker.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const json = (await res.json()) as Record<string, unknown>;
    if (json.id && json.token) tokens.set(json.id as string, json.token as string);
    return { status: res.status, json: json as T };
  }

  async function registerSeat(name: string, pane: string, pid: number) {
    const { json } = await call<{ id: string }>("/register", {
      pid, cwd: `/sbp/${name}`, git_root: `/sbp/${name}`, name,
      client_type: "claude", receiver_mode: "claude-channel",
      tmux_session: "sbp", tmux_window_index: "0", tmux_window_name: "w", tmux_pane_id: pane,
    });
    return json.id;
  }

  type Send = {
    ok?: boolean; id?: number; error?: string;
    sender?: { id: string; name: string | null };
    target?: { id: string };
    warning?: string;
  };

  test("attributes the message to the seat the caller sits inside, and it is replyable", async () => {
    const { seatPid, childPid } = await spawnSeatWithChild();
    const senderSeat = await registerSeat("sbp-sender", "%2001", seatPid);
    const targetSeat = await registerSeat("sbp-target", "%2002", spawnHolder());

    // caller_pid is a DESCENDANT of the seat process — the real shape of
    // `claude-peers send` typed inside a session.
    const { status, json } = await call<Send>("/send-by-pid", {
      caller_pid: childPid, to_id: targetSeat, text: "hello from my seat",
    });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.sender?.id).toBe(senderSeat);

    // The whole point: the stored from_id is a real, live, TARGETABLE seat, so the
    // recipient can reply to it.
    const db = new Database(broker.dbPath, { readonly: true });
    const row = db.query("SELECT from_id FROM messages WHERE id = ?").get(json.id!) as { from_id: string };
    const resolves = db.query("SELECT COUNT(*) n FROM peers WHERE id = ? AND non_targetable = 0")
      .get(row.from_id) as { n: number };
    db.close();
    expect(row.from_id).toBe(senderSeat);
    expect(resolves.n).toBe(1);
    expect(json.warning).toBeUndefined();   // sender IS reachable
  });

  test("the seat process itself may send, not just a descendant", async () => {
    const seatPid = spawnHolder();
    const seat = await registerSeat("sbp-self", "%2020", seatPid);
    const target = await registerSeat("sbp-target-self", "%2021", spawnHolder());
    const { status, json } = await call<Send>("/send-by-pid", {
      caller_pid: seatPid, to_id: target, text: "from the seat process",
    });
    expect(status).toBe(200);
    expect(json.sender?.id).toBe(seat);
  });

  test("refuses a caller that is inside NO registered seat", async () => {
    // The authorisation property: the seat is derived from ancestry, never
    // asserted, so an unrelated process cannot pick a seat to speak as.
    const outsider = spawnHolder();          // child of the test runner, not of any seat
    await registerSeat("sbp-victim", "%2003", spawnHolder());
    const target = await registerSeat("sbp-target2", "%2004", spawnHolder());
    const { status, json } = await call<Send>("/send-by-pid", {
      caller_pid: outsider, to_id: target, text: "forged",
    });
    expect(status).toBe(404);
    expect(json.error).toContain("not inside any registered peer seat");
  });

  test("refuses ambiguity rather than guessing which seat spoke", async () => {
    // Two live rows both matching the caller's ancestry (an uncollapsed duplicate,
    // or a session launched inside another). Attributing to either is a coin flip.
    const { seatPid, childPid } = await spawnSeatWithChild();
    await registerSeat("sbp-twinA", "%2007", seatPid);
    const db = new Database(broker.dbPath);
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO peers (id,pid,cwd,git_root,tty,name,resolved_name,tmux_session,tmux_window_index,
        tmux_window_name,tmux_pane_id,client_type,receiver_mode,summary,registered_at,last_seen,token,
        non_targetable,seat_key,seat_pids)
       VALUES ('sbptwin2',?,'/sbp/twin','/sbp/twin',NULL,'sbp-twinB','sbp-twinB','sbp','0','w','%2007b',
        'claude','claude-channel','',?,?,'tok-twin2',0,'pane:sbp:%2007b','[]')`,
      [seatPid, now, now],
    );
    db.close();

    const target = await registerSeat("sbp-target5", "%2008", spawnHolder());
    const { status, json } = await call<Send>("/send-by-pid", {
      caller_pid: childPid, to_id: target, text: "which of us?",
    });
    expect(status).toBe(409);
    expect(json.error).toContain("cannot attribute the sender");
  });

  test("matches a seat via seat_pids, not only the row's own pid", async () => {
    // A Claude seat registers twice (MCP server + SessionStart hook); the row keeps
    // one pid and records the rest in seat_pids. A caller descended from EITHER must
    // still resolve, or delivery depends on which registrar happened to write last.
    const { seatPid, childPid } = await spawnSeatWithChild();
    const seat = await registerSeat("sbp-seatpids", "%2030", spawnHolder());  // row pid is someone else
    const db = new Database(broker.dbPath);
    db.run("UPDATE peers SET seat_pids = ? WHERE id = ?", [JSON.stringify([seatPid]), seat]);
    db.close();
    const target = await registerSeat("sbp-target7", "%2031", spawnHolder());
    const { status, json } = await call<Send>("/send-by-pid", {
      caller_pid: childPid, to_id: target, text: "via seat_pids",
    });
    expect(status).toBe(200);
    expect(json.sender?.id).toBe(seat);
  });

  test("rejects an oversized body and a bad caller_pid", async () => {
    const seatPid = spawnHolder();
    await registerSeat("sbp-sender6", "%2009", seatPid);
    const target = await registerSeat("sbp-target6", "%2010", spawnHolder());

    const big = await call<Send>("/send-by-pid", {
      caller_pid: seatPid, to_id: target, text: "x".repeat(40_000),
    });
    expect(big.status).toBe(413);

    const badPid = await call<Send>("/send-by-pid", { caller_pid: 1, to_id: target, text: "hi" });
    expect(badPid.status).toBe(400);
  });

  test("still reports recipient delivery health", async () => {
    const seatPid = spawnHolder();
    await registerSeat("sbp-sender7", "%2011", seatPid);
    const { json: stranded } = await call<{ id: string }>("/register", {
      pid: spawnHolder(), cwd: "/sbp/stranded", git_root: "/sbp/stranded",
      name: "sbp-stranded", client_type: "codex", receiver_mode: "manual-drain",
    });
    const { json } = await call<Send>("/send-by-pid", {
      caller_pid: seatPid, to_id: stranded.id, text: "will this land?",
    });
    expect(json.ok).toBe(true);
    expect(json.warning).toContain("no automatic drain path");
    expect(json.warning).not.toContain("send-only");   // this sender IS reachable
  });
});
