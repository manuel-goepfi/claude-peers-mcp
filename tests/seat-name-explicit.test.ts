/**
 * An explicit seat name outranks the launch-order auto label.
 *
 * Incident (2026-10-06): a dozen control seats were launched into one tmux
 * session within minutes. Each pane got the auto label `<session>.<n>` in
 * launch order, which has the same shape as the fleet's role labels, so seats
 * came up holding other seats' role names. Repair by `set_name` failed three ways:
 *   1. the rename reported success, then the next heartbeat or hook re-sync wrote
 *      the auto label back (whoami kept the launch-order label);
 *   2. a rename onto a name another live seat held was silently suffixed, so
 *      routing by the requested name still reached the OTHER seat;
 *   3. nothing named the seat that held the name.
 *
 * Every test here fails against the broker before this change.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestBroker, type TestBroker } from "./helpers/test-broker.ts";

describe("explicit seat names at the broker", () => {
  let broker: TestBroker;
  const children = new Set<ReturnType<typeof Bun.spawn>>();
  const tokens = new Map<string, string>();

  beforeAll(async () => { broker = await startTestBroker({ prefix: "seat-name-explicit" }); }, 35_000);
  afterAll(async () => { for (const child of children) child.kill(); await broker.stop(); });

  function spawnHolder(): ReturnType<typeof Bun.spawn> {
    const child = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    children.add(child);
    return child;
  }

  async function call<T>(path: string, body: Record<string, unknown>): Promise<{ status: number; json: T }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const claimed = body.id as string | undefined;
    if (claimed && tokens.has(claimed)) headers["X-Peer-Token"] = tokens.get(claimed)!;
    const res = await fetch(`${broker.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const json = (await res.json()) as Record<string, unknown>;
    if (path === "/register" && json.id && json.token) tokens.set(json.id as string, json.token as string);
    return { status: res.status, json: json as T };
  }

  type Registered = { id: string; name: string | null; resolved_name: string | null; name_explicit?: boolean };
  type Named = { ok?: boolean; error?: string; name?: string | null; resolved_name?: string | null; holder?: { id: string } };

  const register = (pid: number, name: string, pane: string, extra: Record<string, unknown> = {}) => call<Registered>("/register", {
    pid, cwd: `/seat/${pane}`, git_root: null, tty: null, name,
    client_type: "claude", receiver_mode: "claude-channel",
    tmux_session: "Orch", tmux_window_index: "0", tmux_window_name: `w${pane.slice(1)}`, tmux_pane_id: pane,
    summary: "", ...extra,
  });

  async function storedName(id: string): Promise<{ name: string | null; resolved_name: string | null }> {
    const { json } = await call<Array<{ id: string; name: string | null; resolved_name: string | null }>>("/list-peers", {
      id, scope: "machine", cwd: "/", git_root: null, include_inactive: true,
    });
    const row = json.find((peer) => peer.id === id);
    if (!row) throw new Error(`peer ${id} missing from list-peers`);
    return { name: row.name, resolved_name: row.resolved_name };
  }

  test("planted collision: set_name onto a live seat's name is refused and names the holder", async () => {
    // The reviewer's pane was auto-labelled with the coordinator's role label.
    const holder = await register(spawnHolder().pid!, "Orch.142", "%9101");
    const coordinator = await register(spawnHolder().pid!, "Orch.140", "%9102");

    const { status, json } = await call<Named>("/set-name", { id: coordinator.json.id, name: "Orch.142", explicit: true });
    expect(status).toBe(409);
    expect(json.error).toContain(`"Orch.142" is held by live peer ${holder.json.id}`);
    expect(json.error).toContain("%9101");
    expect(json.holder?.id).toBe(holder.json.id);
    // Refused means unchanged: no suffixed half-rename that still routes elsewhere.
    expect(await storedName(coordinator.json.id)).toEqual({ name: "Orch.140", resolved_name: "Orch.140" });
  });

  test("a resolved-name holder blocks too", async () => {
    // Two seats already share an operator name; the second resolved to a suffix.
    await register(spawnHolder().pid!, "Orch.150", "%9111");
    const suffixed = await register(spawnHolder().pid!, "Orch.150", "%9112");
    expect(suffixed.json.resolved_name).not.toBe("Orch.150");
    const claimant = await register(spawnHolder().pid!, "Orch.151", "%9113");
    const { status, json } = await call<Named>("/set-name", { id: claimant.json.id, name: suffixed.json.resolved_name!, explicit: true });
    expect(status).toBe(409);
    expect(json.holder?.id).toBe(suffixed.json.id);
  });

  test("a dead holder does not block the name", async () => {
    const holderProc = spawnHolder();
    await register(holderProc.pid!, "Orch.160", "%9121");
    const claimant = await register(spawnHolder().pid!, "Orch.161", "%9122");
    holderProc.kill();
    await holderProc.exited;
    const { status, json } = await call<Named>("/set-name", { id: claimant.json.id, name: "Orch.160", explicit: true });
    expect(status).toBe(200);
    expect(json.name).toBe("Orch.160");
    expect(json.resolved_name).toBe("Orch.160");
  });

  test("an explicit name survives a re-registration that carries the auto label", async () => {
    const pid = spawnHolder().pid!;
    const seat = await register(pid, "Orch.170", "%9131");
    const renamed = await call<Named>("/set-name", { id: seat.json.id, name: "Orch.172", explicit: true });
    expect(renamed.status).toBe(200);
    expect(renamed.json.name).toBe("Orch.172");

    // The SessionStart / prompt hook re-registers the same seat with the pane's
    // auto label. Before this change that silently undid the rename.
    const again = await register(pid, "Orch.170", "%9131", { preserve_token: true });
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(seat.json.id);
    expect(again.json.name).toBe("Orch.172");
    expect(again.json.name_explicit).toBe(true);
    expect(await storedName(seat.json.id)).toEqual({ name: "Orch.172", resolved_name: "Orch.172" });
  });

  test("an adapter's automatic re-sync cannot overwrite an explicit name", async () => {
    const seat = await register(spawnHolder().pid!, "Orch.180", "%9141");
    await call<Named>("/set-name", { id: seat.json.id, name: "Orch.182", explicit: true });
    // The adapter heartbeat pushes the pane's auto label without `explicit`.
    const resync = await call<Named>("/set-name", { id: seat.json.id, name: "Orch.180" });
    expect(resync.status).toBe(200);
    expect(resync.json.name).toBe("Orch.182");
    expect(await storedName(seat.json.id)).toEqual({ name: "Orch.182", resolved_name: "Orch.182" });
  });

  test("a registration with a new explicit name replaces the pinned one", async () => {
    const pid = spawnHolder().pid!;
    const seat = await register(pid, "Orch.190", "%9151");
    await call<Named>("/set-name", { id: seat.json.id, name: "Orch.192", explicit: true });
    const relabelled = await register(pid, "Orch.193", "%9151", { preserve_token: true, name_explicit: true });
    expect(relabelled.json.id).toBe(seat.json.id);
    expect(relabelled.json.name).toBe("Orch.193");
  });

  test("clearing the explicit name hands the seat back to its auto label", async () => {
    const seat = await register(spawnHolder().pid!, "Orch.200", "%9161");
    await call<Named>("/set-name", { id: seat.json.id, name: "Orch.202", explicit: true });
    const cleared = await call<Named>("/set-name", { id: seat.json.id, name: "", explicit: true });
    expect(cleared.status).toBe(200);
    expect(cleared.json.name).toBeNull();
    const resync = await call<Named>("/set-name", { id: seat.json.id, name: "Orch.200" });
    expect(resync.json.name).toBe("Orch.200");
  });

  test("a rename-lane rename (/set-name-by-pid) is pinned against auto-label re-registration", async () => {
    const proc = Bun.spawn(["bash", "-c", "sleep 60 & echo $! ; wait"], { stdout: "pipe", stderr: "ignore" });
    children.add(proc);
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    const childPid = Number(new TextDecoder().decode(value).trim());
    const seat = await register(proc.pid!, "Orch.210", "%9181");
    const renamed = await call<Named>("/set-name-by-pid", { caller_pid: childPid, name: "Orch.212" });
    expect(renamed.status).toBe(200);
    const again = await register(proc.pid!, "Orch.210", "%9181", { preserve_token: true });
    expect(again.json.id).toBe(seat.json.id);
    expect(again.json.name).toBe("Orch.212");
  });

  test("a non-explicit set-name keeps the legacy suffix behaviour", async () => {
    await register(spawnHolder().pid!, "legacy-held", "%9171");
    const seat = await register(spawnHolder().pid!, "legacy-other", "%9172");
    const { status, json } = await call<Named>("/set-name", { id: seat.json.id, name: "legacy-held" });
    expect(status).toBe(200);
    expect(json.name).toBe("legacy-held");
    expect(json.resolved_name).not.toBe("legacy-held");
  });
});
