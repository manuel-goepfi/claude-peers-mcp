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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("a name another live seat holds is refused, naming the holder", async () => {
    // A rename is pinned, so a suffixed accept would leave two live seats
    // answering to one operator name across heartbeats and restarts.
    const { json: holder } = await register(spawnHolder(), "taken", "%3006");
    const { seatPid, childPid } = await spawnSeatWithChild();
    await register(seatPid, "rl-collider", "%3007");
    const { status, json } = await call<R & { holder?: { id: string } }>("/set-name-by-pid", { caller_pid: childPid, name: "taken" });
    expect(status).toBe(409);
    expect(json.error).toContain(`is held by live peer ${holder.id}`);
    expect(json.holder?.id).toBe(holder.id);
    // Nothing was stored: the next rename still reports the original name.
    const next = await call<R>("/set-name-by-pid", { caller_pid: childPid, name: "rl-free" });
    expect(next.json.previous_name).toBe("rl-collider");
  });
});

describe.skipIf(!Bun.which("tmux") || !Bun.which("flock"))("rename-lane on a scratch tmux server", () => {
  const root = mkdtempSync(join(tmpdir(), "rename-lane-tmux-"));
  const socket = join(root, "tmux");
  const tool = new URL("../bin/rename-lane.ts", import.meta.url).pathname;
  const env = { ...process.env, TMUX: undefined, TMUX_PANE: undefined, CLAUDE_PEERS_TMUX_SOCKET: socket };
  let broker: TestBroker;
  const holders = new Set<ReturnType<typeof Bun.spawn>>();

  const tmux = (args: string[]) => {
    const result = Bun.spawnSync(["tmux", "-S", socket, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  const seatName = (pane: string) => {
    const result = Bun.spawnSync(["tmux", "-S", socket, "show-options", "-p", "-t", pane, "-v", "@peer_seat_name"], { env, stdout: "pipe", stderr: "ignore" });
    return result.stdout.toString().trim();
  };

  beforeAll(async () => {
    broker = await startTestBroker({ prefix: "rename-lane-tmux", env: { CLAUDE_PEERS_TMUX_SOCKET: socket, TMUX: undefined, TMUX_PANE: undefined } });
  }, 35_000);
  afterAll(async () => {
    for (const c of holders) c.kill();
    Bun.spawnSync(["tmux", "-S", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
    await broker.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("a held name is refused on the pane and at the broker, and no pane is stamped", async () => {
    // Pane B runs rename-lane on request, so the tool is a descendant of B's
    // registered seat process exactly as when an operator types it there.
    const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(join(root, "lane.sh"), [
      `export CLAUDE_PEERS_PORT=${broker.port} CLAUDE_PEERS_TMUX_SOCKET=${q(socket)}`,
      "i=0",
      "while :; do",
      `  while [ ! -e ${q(root)}/go.$i ]; do sleep 0.05; done`,
      `  ${q(process.execPath)} ${q(tool)} "$(cat ${q(root)}/go.$i)" >${q(root)}/out.$i 2>${q(root)}/err.$i`,
      `  echo $? >${q(root)}/rc.$i`,
      "  i=$((i+1))",
      "done",
    ].join("\n"));
    tmux(["-f", "/dev/null", "new-session", "-d", "-s", "Orch", "-x", "200", "-y", "50", "sleep", "120"]);
    tmux(["split-window", "-d", "-t", "Orch", "bash", join(root, "lane.sh")]);
    const panes = tmux(["list-panes", "-s", "-t", "Orch", "-F", "#{pane_id}\t#{pane_pid}"]).split("\n").map((line) => line.split("\t"));
    const [[paneA], [paneB, paneBPid]] = panes as [[string, string], [string, string]];
    tmux(["set-option", "-p", "-t", paneA, "@peer_seat_name", "Orch.135"]);
    tmux(["set-option", "-p", "-t", paneB, "@peer_seat_name", "Orch.140"]);
    const seatB = await fetch(`${broker.url}/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pid: Number(paneBPid), cwd: "/rl/b", git_root: "/rl/b", name: "Orch.140", client_type: "claude",
        receiver_mode: "claude-channel", tmux_session: "Orch", tmux_window_index: "0", tmux_window_name: "w", tmux_pane_id: paneB }),
    }).then((r) => r.json()) as { id: string };
    expect(seatB.id).toBeTruthy();

    let run = 0;
    const renameInB = async (name: string) => {
      const i = run++;
      writeFileSync(join(root, `go.${i}`), name);
      const rc = join(root, `rc.${i}`);
      for (let waited = 0; !existsSync(rc) || readFileSync(rc, "utf8").trim() === ""; waited += 50) {
        if (waited > 20_000) throw new Error(`rename-lane run ${i} did not finish`);
        await Bun.sleep(50);
      }
      return { code: Number(readFileSync(rc, "utf8").trim()), err: readFileSync(join(root, `err.${i}`), "utf8") };
    };

    // 1. Pane A holds the name only on its pane, as after a broker restart before
    //    A re-registers. The broker sees no holder; the pane check must refuse.
    const paneHeld = await renameInB("Orch.135");
    expect(paneHeld.code).not.toBe(0);
    expect(paneHeld.err).toContain(`pane ${paneA}`);
    expect(seatName(paneA)).toBe("Orch.135");
    expect(seatName(paneB)).toBe("Orch.140");

    // 2. A live seat holds the name at the broker but on no pane of this server.
    //    The broker's 409 must name it and the pane must stay as it was.
    const elsewhere = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    holders.add(elsewhere);
    const remote = await fetch(`${broker.url}/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pid: elsewhere.pid, cwd: "/rl/r", git_root: "/rl/r", name: "Orch.150", client_type: "claude",
        receiver_mode: "claude-channel", tmux_session: "Remote", tmux_window_index: "0", tmux_window_name: "r", tmux_pane_id: "%9999" }),
    }).then((r) => r.json()) as { id: string };
    const brokerHeld = await renameInB("Orch.150");
    expect(brokerHeld.code).not.toBe(0);
    expect(brokerHeld.err).toContain(`is held by live peer ${remote.id}`);
    expect(seatName(paneA)).toBe("Orch.135");
    expect(seatName(paneB)).toBe("Orch.140");

    // 3. A free name goes through and is stamped on B alone.
    const free = await renameInB("Orch.160");
    expect(free.code).toBe(0);
    expect(seatName(paneB)).toBe("Orch.160");
    expect(seatName(paneA)).toBe("Orch.135");
  }, 60_000);
});
