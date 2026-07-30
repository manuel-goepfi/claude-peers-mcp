#!/usr/bin/env bun
/**
 * rename-lane — give the lane you are sitting in a name you will recognise, and
 * make every surface that shows a lane name agree on it.
 *
 * The problem it solves: a seat has several labels and they drift apart.
 *   - peer `name`          — what send_to_peer matches (e.g. infra.2)
 *   - peer `resolved_name` — collision-suffixed (C5_lanes.1#WALL-SUPABASE)
 *   - `observer-<pid>`     — the anonymous fallback when a lane starts with no
 *                            CLAUDE_PEER_NAME at all
 *   - tmux window name     — what you read at the top (and NOT unique: three
 *                            panes shared "mq-steward")
 *   - tmux pane border     — renders @peer_resolved_name
 * The operator navigates by what is on screen, so when the on-screen label is not
 * the routable one, messages go to the wrong lane. That happened: a /goal was
 * misrouted because four seats shared one window label.
 *
 * This sets all of them at once:
 *   1. the broker peer name (via /set-name-by-pid — proves the seat by process
 *      ancestry, so you can only rename the lane you are actually in)
 *   2. the tmux window name
 *   3. the pane identity options the border renders
 *
 * Usage:  bun bin/rename-lane.ts <new-name>
 *         bun bin/rename-lane.ts --show
 */

const BROKER_PORT = process.env.CLAUDE_PEERS_PORT ?? "7899";
const BROKER = `http://127.0.0.1:${BROKER_PORT}`;

function tmux(args: string[]): { ok: boolean; out: string } {
  try {
    const p = Bun.spawnSync(["tmux", ...args], { stdout: "pipe", stderr: "ignore" });
    return { ok: p.exitCode === 0, out: new TextDecoder().decode(p.stdout).trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

/** This pane, from TMUX_PANE — the only reliable answer to "which pane am I". */
function currentPane(): string | null {
  return process.env.TMUX_PANE || null;
}

async function post<T>(path: string, body: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${BROKER}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

type NameResult = {
  ok?: boolean; error?: string;
  id?: string; name?: string | null; resolved_name?: string | null; previous_name?: string | null;
};

async function main(): Promise<number> {
  const arg = process.argv[2];
  if (!arg || arg === "--help" || arg === "-h") {
    console.log("usage: rename-lane <new-name>   |   rename-lane --show");
    return arg ? 0 : 64;
  }

  const pane = currentPane();

  if (arg === "--show") {
    console.log(`pane:            ${pane ?? "(not in tmux)"}`);
    if (pane) {
      console.log(`window name:     ${tmux(["display-message", "-p", "-t", pane, "#{window_name}"]).out}`);
      console.log(`border shows:    ${tmux(["show-options", "-p", "-t", pane, "-v", "@peer_resolved_name"]).out || "(unset)"}`);
      console.log(`operator label:  ${tmux(["show-options", "-p", "-t", pane, "-v", "@operator_label"]).out || "(unset)"}`);
    }
    return 0;
  }

  // The broker derives WHICH seat from our process ancestry, so this renames the
  // lane this command runs inside and nothing else.
  const { status, json } = await post<NameResult>("/set-name-by-pid", {
    caller_pid: process.pid,
    name: arg,
  });
  if (status !== 200 || json.ok !== true) {
    console.error(`rename failed (HTTP ${status}): ${json.error ?? "unknown error"}`);
    if (status === 404) console.error("  → this process is not inside a registered peer seat");
    if (status === 409) console.error("  → ancestry matches more than one seat; the seat rows need to collapse first");
    return 1;
  }

  const applied = json.name ?? arg;
  const routable = json.resolved_name ?? applied;
  console.log(`peer name:  ${json.previous_name ?? "(none)"} -> ${applied}   [id ${json.id}]`);
  if (routable !== applied) {
    console.log(`  note: another live seat holds "${applied}", so the routable name is "${routable}"`);
  }

  if (!pane) {
    console.log("not in tmux — peer name set, no window/border to update");
    return 0;
  }

  // Keep the screen in step with the routing. Without this the border keeps
  // rendering the OLD identity until the next heartbeat mirror, which is exactly
  // the drift this command exists to remove.
  const failures: string[] = [];
  if (!tmux(["rename-window", "-t", pane, applied]).ok) failures.push("window name");
  for (const [option, value] of [
    ["@peer_label", applied],
    ["@peer_resolved_name", routable],
    ["@operator_label", applied],
  ] as const) {
    if (!tmux(["set-option", "-p", "-t", pane, option, value]).ok) failures.push(option);
  }

  console.log(`tmux window: ${applied}`);
  console.log(`border:      ${routable}`);
  if (failures.length > 0) console.error(`warning: could not set ${failures.join(", ")}`);
  return 0;
}

process.exit(await main());
