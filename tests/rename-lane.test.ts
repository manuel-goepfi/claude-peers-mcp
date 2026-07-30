/**
 * /set-name-by-pid — rename the seat you are sitting in.
 *
 * Exists because a lane's labels drift apart: the peer name routes, the tmux
 * border renders, and the operator navigates by what is on screen. When those
 * disagree, mail goes to the wrong lane — a /goal was misrouted on 2026-07-30
 * because four seats shared one window label, and a cursor lane registered as the
 * anonymous "observer-2500422" because it started with no CLAUDE_PEER_NAME.
 *
 * Authorisation is the same ancestry proof as /send-by-pid: you can rename the
 * seat you are inside, and nothing else.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestBroker, type TestBroker } from "./helpers/test-broker.ts";

describe("/set-name-by-pid", () => {
  let broker: TestBroker;
  const children = new Set<ReturnType<typeof Bun.spawn>>();

  beforeAll(async () => { broker = await startTestBroker({ prefix: "rename-lane" }); }, 35_000);
  afterAll(async () => { for (const c of children) c.kill(); await broker.stop(); });

  function spawnHolder(): number {
    const c = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    children.add(c);
    return c.pid;
  }

  async function spawnSeatWithChild(): Promise<{ seatPid: number; childPid: number }> {
    const proc = Bun.spawn(["bash", "-c", "sleep 60 & echo $! ; wait"], { stdout: "pipe", stderr: "ignore" });
    children.add(proc);
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    return { seatPid: proc.pid!, childPid: Number(new TextDecoder().decode(value).trim()) };
  }

  // Token-authed routes (/send-to-peer) need the peer's token; pid-authed ones
  // (/set-name-by-pid) do not. Cache tokens from registration so both work.
  const tokens = new Map<string, string>();
  async function call<T>(path: string, body: Record<string, unknown>): Promise<{ status: number; json: T }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const claimed = (body.id as string | undefined) ?? (body.from_id as string | undefined);
    if (claimed && tokens.has(claimed)) headers["X-Peer-Token"] = tokens.get(claimed)!;
    const res = await fetch(`${broker.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const json = (await res.json()) as Record<string, unknown>;
    if (json.id && json.token) tokens.set(json.id as string, json.token as string);
    return { status: res.status, json: json as T };
  }

  const register = (pid: number, name: string, pane: string) => call<{ id: string }>("/register", {
    pid, cwd: `/rl/${name}`, git_root: `/rl/${name}`, name,
    client_type: "claude", receiver_mode: "claude-channel",
    tmux_session: "rl", tmux_window_index: "0", tmux_window_name: "w", tmux_pane_id: pane,
  });

  type R = { ok?: boolean; error?: string; id?: string; name?: string | null; resolved_name?: string | null; previous_name?: string | null };

  test("renames the seat the caller sits inside, reporting the previous name", async () => {
    const { seatPid, childPid } = await spawnSeatWithChild();
    const { json: seat } = await register(seatPid, "rl-before", "%3001");

    const { status, json } = await call<R>("/set-name-by-pid", { caller_pid: childPid, name: "peers" });
    expect(status).toBe(200);
    expect(json.id).toBe(seat.id);
    expect(json.previous_name).toBe("rl-before");
    expect(json.name).toBe("peers");
  });

  test("the new name is what send_to_peer resolves", async () => {
    const { seatPid, childPid } = await spawnSeatWithChild();
    await register(seatPid, "rl-old", "%3002");
    await call<R>("/set-name-by-pid", { caller_pid: childPid, name: "wall" });

    const senderPid = spawnHolder();
    const { json: sender } = await register(senderPid, "rl-sender", "%3003");
    const sent = await call<{ ok: boolean; target?: { name: string | null } }>("/send-to-peer", {
      id: sender.id, from_id: sender.id, selector: { name: "wall" }, text: "routed by the new name",
    });
    expect(sent.json.ok).toBe(true);
    expect(sent.json.target?.name).toBe("wall");
  });

  test("refuses a caller inside no seat — you cannot rename a lane you are not in", async () => {
    const outsider = spawnHolder();
    await register(spawnHolder(), "rl-victim", "%3004");
    const { status, json } = await call<R>("/set-name-by-pid", { caller_pid: outsider, name: "hijack" });
    expect(status).toBe(404);
    expect(json.error).toContain("not inside any registered peer seat");
  });

  test("rejects a bad caller_pid and an oversized name", async () => {
    const { seatPid, childPid } = await spawnSeatWithChild();
    await register(seatPid, "rl-guard", "%3005");
    expect((await call<R>("/set-name-by-pid", { caller_pid: 1, name: "x" })).status).toBe(400);
    expect((await call<R>("/set-name-by-pid", { caller_pid: childPid, name: "x".repeat(200) })).status).toBe(413);
    expect((await call<R>("/set-name-by-pid", { caller_pid: childPid, name: 42 })).status).toBe(400);
  });

  test("a colliding name still yields a routable resolved_name", async () => {
    // Two live seats cannot share one routable label; the broker disambiguates.
    const holder = spawnHolder();
    await register(holder, "taken", "%3006");
    const { seatPid, childPid } = await spawnSeatWithChild();
    await register(seatPid, "rl-collider", "%3007");
    const { json } = await call<R>("/set-name-by-pid", { caller_pid: childPid, name: "taken" });
    expect(json.name).toBe("taken");
    expect(json.resolved_name).not.toBe("taken");   // suffixed, and still unique
    expect(json.resolved_name).toBeTruthy();
  });
});
