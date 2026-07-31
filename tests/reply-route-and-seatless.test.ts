/**
 * Three delivery-honesty fixes, all from one live incident (2026-07-30):
 *  1. A send-only CLI identity left recipients unable to reply, with nobody told.
 *  2. The codex nudge asked lanes to fetch mail "if relevant" — unknowable
 *     before fetching, so a lane answered "no action needed" without looking.
 *  3. Seatless app-server threads logged a drain failure on every prompt,
 *     burying real failures.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestBroker, type TestBroker } from "./helpers/test-broker.ts";
import { nudgeText } from "../bin/codex-autodrain-poller.ts";
import { isHostedWithoutSeat } from "../hooks/codex-drain-peer-inbox.ts";

describe("sender reply-route honesty", () => {
  let broker: TestBroker;
  const tokens = new Map<string, string>();
  const children = new Set<ReturnType<typeof Bun.spawn>>();

  beforeAll(async () => {
    broker = await startTestBroker({ prefix: "reply-route" });
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
    const claimed = (body.id as string | undefined) ?? (body.from_id as string | undefined);
    if (claimed && tokens.has(claimed)) headers["X-Peer-Token"] = tokens.get(claimed)!;
    const res = await fetch(`${broker.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const json = (await res.json()) as Record<string, unknown>;
    if (json.id && json.token) tokens.set(json.id as string, json.token as string);
    return json as T;
  }

  type Send = { ok: boolean; warning?: string; recipient?: { state: string; nudgeable?: boolean } };

  async function registerTarget(name: string, pane: string) {
    return call<{ id: string }>("/register", {
      pid: spawnHolder(), cwd: `/rr/${name}`, git_root: `/rr/${name}`, name,
      client_type: "claude", receiver_mode: "claude-channel",
      tmux_session: "rr", tmux_window_index: "0", tmux_window_name: "w", tmux_pane_id: pane,
    });
  }

  test("a send-only CLI identity is told the recipient cannot reply", async () => {
    const cli = await call<{ id: string; non_targetable?: boolean }>("/register-cli", { pid: spawnHolder() });
    const target = await registerTarget("rr-target", "%900");
    const sent = await call<Send>("/send-message", {
      id: cli.id, from_id: cli.id, to_id: target.id, text: "from the CLI",
    });
    expect(sent.ok).toBe(true);
    // The recipient itself is perfectly healthy — the problem is the return path.
    expect(sent.recipient?.state).toBe("healthy");
    expect(sent.warning).toContain("send-only");
    expect(sent.warning).toContain("CANNOT reply");
  });

  test("a normal peer sender gets no reply-route warning", async () => {
    const sender = await registerTarget("rr-sender", "%901");
    const target = await registerTarget("rr-target2", "%902");
    const sent = await call<Send>("/send-message", {
      id: sender.id, from_id: sender.id, to_id: target.id, text: "peer to peer",
    });
    expect(sent.ok).toBe(true);
    expect(sent.warning).toBeUndefined();
  });

  test("a pane alone is not a drain path when the client has no nudge profile", async () => {
    // Live case: kimi-code lanes registered as client_type=unknown sat in real tmux
    // panes with queued mail, and sends to them reported "healthy". Nothing could
    // ever deliver: background polling is disabled for unknown clients, and the
    // poller has no idle profile for an unrecognised TUI so it never types into
    // that pane. Reporting a pane as nudgeable is the silent success this field
    // exists to prevent.
    const sender = await registerTarget("rr-sender-u", "%903");
    const unknownSeat = await call<{ id: string }>("/register", {
      pid: spawnHolder(), cwd: "/rr/unknownclient", git_root: "/rr/unknownclient",
      name: "mystery.1", client_type: "totally-unrecognised",
      tmux_session: "rr", tmux_window_index: "0", tmux_window_name: "w", tmux_pane_id: "%904",
    });
    const sent = await call<Send>("/send-message", {
      id: sender.id, from_id: sender.id, to_id: unknownSeat.id, text: "can this ever land?",
    });
    expect(sent.ok).toBe(true);
    expect(sent.recipient?.state).toBe("no_drain_path");
    expect(sent.warning).toContain("no automatic drain path");
  });

  test("a recognised client WITH a pane is still nudgeable", async () => {
    const sender = await registerTarget("rr-sender-k", "%905");
    const target = await registerTarget("rr-known", "%906");   // claude/claude-channel
    const sent = await call<Send>("/send-message", {
      id: sender.id, from_id: sender.id, to_id: target.id, text: "normal path",
    });
    expect(sent.recipient?.state).toBe("healthy");
    expect(sent.warning).toBeUndefined();
  });

  // Cursor registers tmux_pane_id but not tmux_session (its env is stripped, so the
  // pane is recovered from the client process and the session name is not). The
  // poller nudges by pane id alone, so such a lane IS reachable — and a health
  // check demanding session+pane told senders the opposite while mail was landing.
  test("a pane id with no session still counts as a drain path", async () => {
    const sender = await registerTarget("rr-sender-p", "%907");
    const paneOnly = await call<{ id: string }>("/register", {
      pid: spawnHolder(), cwd: "/rr/paneonly", git_root: "/rr/paneonly", name: "rr-paneonly",
      client_type: "cursor", receiver_mode: "manual-drain",
      tmux_session: null, tmux_window_index: null, tmux_window_name: null, tmux_pane_id: "%908",
    });
    const sent = await call<Send>("/send-message", {
      id: sender.id, from_id: sender.id, to_id: paneOnly.id, text: "reachable via pane id",
    });
    expect(sent.ok).toBe(true);
    expect(sent.recipient?.nudgeable).toBe(true);
    expect(sent.recipient?.state).toBe("healthy");
    expect(sent.warning).toBeUndefined();
  });

  test("no pane at all is still no drain path", async () => {
    const sender = await registerTarget("rr-sender-n", "%909");
    const noPane = await call<{ id: string }>("/register", {
      pid: spawnHolder(), cwd: "/rr/nopane", git_root: "/rr/nopane", name: "rr-nopane",
      client_type: "cursor", receiver_mode: "manual-drain",
    });
    const sent = await call<Send>("/send-message", {
      id: sender.id, from_id: sender.id, to_id: noPane.id, text: "truly unreachable",
    });
    expect(sent.recipient?.state).toBe("no_drain_path");
  });

  test("the reply-route warning composes with a recipient-health warning", async () => {
    const cli = await call<{ id: string }>("/register-cli", { pid: spawnHolder() });
    // No pane and manual drain: unreachable recipient AND unreplyable sender.
    const stranded = await call<{ id: string }>("/register", {
      pid: spawnHolder(), cwd: "/rr/stranded", git_root: "/rr/stranded", name: "rr-stranded",
      client_type: "codex", receiver_mode: "manual-drain",
    });
    const sent = await call<Send>("/send-message", {
      id: cli.id, from_id: cli.id, to_id: stranded.id, text: "doubly stuck",
    });
    expect(sent.recipient?.state).toBe("no_drain_path");
    expect(sent.warning).toContain("no automatic drain path");
    expect(sent.warning).toContain("send-only");
  });
});

describe("codex nudge text", () => {
  const lane = (n: number, client: string) => ({ unread: n, client_type: client } as never);

  test("tells a codex lane to fetch unconditionally", () => {
    const text = nudgeText(lane(1, "codex"));
    expect(text).toContain("check_messages");
    // The old wording made the FETCH conditional, which a lane cannot evaluate.
    expect(text).not.toMatch(/check_messages if\s+relevant/);
    expect(text).toContain("cannot tell whether");
  });

  test("keeps the non-actionable declaration that guards against nudge-as-work hijack", () => {
    // The exact phrase is a standing invariant from an earlier incident where a
    // lane adopted the nudge as its assignment; making the FETCH unconditional
    // must not weaken it. Only the fetch is mandatory, never the contents.
    expect(nudgeText(lane(3, "codex"))).toContain("not a task");
    expect(nudgeText(lane(3, "codex"))).toContain("act only if relevant");
    expect(nudgeText(lane(3, "codex")).toLowerCase().startsWith("check ")).toBe(false);
  });

  test("pluralises and keeps the claude branch untouched", () => {
    expect(nudgeText(lane(2, "codex"))).toContain("2 unread messages");
    expect(nudgeText(lane(1, "codex"))).toContain("1 unread message");
    // Claude drains via the prompt hook, so it must NOT be told to fetch again.
    expect(nudgeText(lane(1, "claude"))).not.toContain("Call check_messages");
  });
});

describe("seatless app-server detection", () => {
  const APP_SERVER = 100;
  const table = new Map<number, { pid: number; ppid: number; comm: string; args: string }>([
    [APP_SERVER, { pid: APP_SERVER, ppid: 1, comm: "codex", args: "codex -c features.code_mode_host=true app-server --listen unix://" }],
    [200, { pid: 200, ppid: APP_SERVER, comm: "codex", args: "codex" }],
    [300, { pid: 300, ppid: 200, comm: "bash", args: "bash drain-peer-inbox.sh" }],
    // A visible lane: same app-server host, but a real tty exists on the chain.
    [400, { pid: 400, ppid: APP_SERVER, comm: "codex", args: "codex" }],
    [500, { pid: 500, ppid: 400, comm: "bash", args: "bash drain-peer-inbox.sh" }],
  ]);

  test("a hosted thread with no tty anywhere is seatless (stay silent)", () => {
    expect(isHostedWithoutSeat(table, 300, () => null)).toBe(true);
  });

  test("a hosted thread WITH a tty on the chain is a real seat (log failures)", () => {
    expect(isHostedWithoutSeat(table, 500, (pid) => (pid === 400 ? "pts/9" : null))).toBe(false);
  });

  test("a hook with no app-server ancestor is never classified as seatless", () => {
    // A plain tmux codex lane: its failures must still be reported.
    const plain = new Map(table);
    plain.set(600, { pid: 600, ppid: 1, comm: "codex", args: "codex resume" });
    plain.set(700, { pid: 700, ppid: 600, comm: "bash", args: "bash drain-peer-inbox.sh" });
    expect(isHostedWithoutSeat(plain, 700, () => null)).toBe(false);
  });

  // NOTE: the exit-code half of this fix (seatless → exit 0, so the wrapper logs
  // no `drain-failed rc=1`) is NOT unit-tested. A spawned harness cannot build a
  // faithful app-server tree: the shim inherits a controlling tty, and `setsid`
  // forks and reparents, so the ancestor walk sees a different chain than in
  // production. It was verified by hand (EXIT=0) and is confirmed in production by
  // the absence of new `drain-failed` lines while app-server hooks keep firing.
  // The classifier those exits depend on IS covered by the cases above.

  test("terminates on a broken chain instead of looping", () => {
    const orphan = new Map(table);
    orphan.set(800, { pid: 800, ppid: 999999, comm: "bash", args: "bash" });
    expect(isHostedWithoutSeat(orphan, 800, () => null)).toBe(false);
  });
});
