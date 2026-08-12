/**
 * kimi-code support.
 *
 * Found live 2026-07-30: two kimi lanes sat in real tmux panes, each running a
 * claude-peers MCP server (so fully capable of check_messages), each holding
 * queued mail — and nothing could ever deliver it. They registered as
 * client_type=unknown, which disables background polling, and the poller had no
 * idle profile for them so it never nudged. Sends to them even reported "healthy".
 */

import { describe, expect, test } from "bun:test";
import { isClientProcess, detectClientFromProcessChain, initialReceiverMode, type ProcessInfo } from "../shared/client.ts";
import { profileFor, parseNudgeClients, paneQuiescent, paneFromPidAncestry } from "../bin/codex-autodrain-poller.ts";
import { shouldDisableBackgroundPolling } from "../server.ts";

const row = (comm: string, args: string, pid = 10, ppid = 1): ProcessInfo => ({ pid, ppid, comm, args });

describe("kimi detection", () => {
  test("recognises both process names it appears under", () => {
    expect(isClientProcess(row("kimi", "/home/manzo/.kimi-code/bin/kimi"), "kimi")).toBe(true);
    expect(isClientProcess(row("kimi-code", "kimi-code"), "kimi")).toBe(true);
  });

  test("does not claim unrelated processes", () => {
    expect(isClientProcess(row("bash", "bash -c kimi-ish"), "kimi")).toBe(false);
    expect(isClientProcess(row("claude", "claude"), "kimi")).toBe(false);
    // and a kimi process must not be mistaken for another client
    expect(isClientProcess(row("kimi", "kimi"), "codex")).toBe(false);
    expect(isClientProcess(row("kimi", "kimi"), "claude")).toBe(false);
  });

  test("resolves through a process chain, as a real lane does", () => {
    // pane bash → kimi → bun server.ts (the shape observed on panes %36/%189)
    const table = new Map<number, ProcessInfo>([
      [1, row("bash", "-bash", 1, 0)],
      [2, row("kimi", "/home/manzo/.kimi-code/bin/kimi", 2, 1)],
      [3, row("bun", "bun /home/manzo/claude-peers-mcp/server.ts", 3, 2)],
    ]);
    expect(detectClientFromProcessChain(3, table, {})).toBe("kimi");
  });

  test("drains manually — it has no hook, so mail arrives via nudge + check_messages", () => {
    expect(initialReceiverMode("kimi")).toBe("manual-drain");
    // Background polling stays off for the same reason it is off for codex: the
    // server cannot inject into that TUI, so a poll would hold a connection open
    // and deliver nothing.
    expect(shouldDisableBackgroundPolling("kimi", "manual-drain")).toBe(true);
  });

  test("is nudgeable — without this its mail has no path at all", () => {
    expect(parseNudgeClients("codex,claude,kimi")).toContain("kimi");
  });
});

describe("kimi idle profile", () => {
  const kimi = profileFor("kimi");

  test("matches the real prompt line captured from a live lane", () => {
    // Verbatim shape from pane %36: U+2502, space, '>'.
    const promptLine = " │ >                                   ";
    expect(kimi.promptLine.test(promptLine.trim() === "" ? promptLine : promptLine.replace(/^\s/, " "))).toBe(true);
    expect(kimi.prompt.test("\n │ > ")).toBe(true);
  });

  test("does not match kimi's own output/box lines", () => {
    // Rounded box corners and transcript lines must never read as a prompt.
    expect(kimi.promptLine.test(" ╭────────────")).toBe(false);
    expect(kimi.promptLine.test(" ╰────────────")).toBe(false);
    expect(kimi.promptLine.test("   ✓ Fetch origin/main + all 170 issue bodies")).toBe(false);
    expect(kimi.promptLine.test(" auto  K3-256k thinking: high  ~/Clause5  main")).toBe(false);
  });

  test("declares that its busy vocabulary is unknown, so quiescence is required", () => {
    // The safety contract: no busy markers means idle detection alone cannot tell
    // mid-turn from at-the-prompt, so the poller must fall back to quiescence.
    expect(kimi.busy).toHaveLength(0);
    expect(kimi.requiresQuiescence).toBe(true);
  });

  test("clients with known busy vocabulary do NOT require quiescence", () => {
    expect(profileFor("codex").requiresQuiescence).toBeUndefined();
    expect(profileFor("claude").requiresQuiescence).toBeUndefined();
    expect(profileFor("codex").busy.length).toBeGreaterThan(0);
  });

  test("an unknown client still falls back to the codex profile", () => {
    expect(profileFor("something-new")).toBe(profileFor("codex"));
  });
});

describe("quiescence gate (real tmux)", () => {
  const tmuxAvailable = Bun.spawnSync(["tmux", "-V"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

  (tmuxAvailable ? test : test.skip)("first sight is never quiescent; unchanged is; changed is not", () => {
    const session = `quiescence-${process.pid}`;
    Bun.spawnSync(["tmux", "kill-session", "-t", session], { stdout: "ignore", stderr: "ignore" });
    // Use a deterministic echoing process instead of the operator's login shell.
    // A freshly spawned shell can paint its prompt after the first two captures,
    // making an unchanged pane look active for reasons unrelated to quiescence.
    Bun.spawnSync(["tmux", "new-session", "-d", "-s", session, "-x", "80", "-y", "20", "cat"], { stdout: "ignore", stderr: "ignore" });
    try {
      const pane = new TextDecoder()
        .decode(Bun.spawnSync(["tmux", "list-panes", "-t", session, "-F", "#{pane_id}"]).stdout).trim().split("\n")[0]!;

      // First observation has no prior sample — must NOT nudge on it.
      expect(paneQuiescent(pane)).toBe(false);
      // Second observation with nothing happening — quiescent.
      expect(paneQuiescent(pane)).toBe(true);

      // Now change the pane, as a mid-turn TUI repaint would.
      Bun.spawnSync(["tmux", "send-keys", "-t", pane, "-l", "working on something"]);
      Bun.spawnSync(["sleep", "0.4"]);
      expect(paneQuiescent(pane)).toBe(false);   // changed → never nudge
      expect(paneQuiescent(pane)).toBe(true);    // settled again → nudgeable
    } finally {
      Bun.spawnSync(["tmux", "kill-session", "-t", session], { stdout: "ignore", stderr: "ignore" });
    }
  });
});

describe("pane resolution for lanes whose row has no pane id", () => {
  // Cursor registers with tty set and tmux fields empty, so its row says "no pane"
  // while the process sits in one. The poller nudges by pane, and for a
  // manual-drain client the nudge is the ONLY delivery path — a live cursor lane
  // (GROK-JUDGMENT) accumulated 4 unread messages exactly this way.
  const procs = [
    { pid: 100, ppid: 1, comm: "bash", args: "-bash" },          // pane process
    { pid: 200, ppid: 100, comm: "MainThread", args: "cursor-agent --use-system-ca" },
    { pid: 300, ppid: 200, comm: "bun", args: "bun server.ts" },
  ];
  const snap = {
    procs,
    paneByPid: new Map<string, number>(),
    paneMap: new Map<number, { pane_id: string }>([[100, { pane_id: "%187" }]]),
  } as never;

  test("finds the pane by walking the lane's ancestry", () => {
    expect(paneFromPidAncestry(300, snap)).toBe("%187");   // from the MCP server
    expect(paneFromPidAncestry(200, snap)).toBe("%187");   // from the agent itself
    expect(paneFromPidAncestry(100, snap)).toBe("%187");   // the pane process itself
  });

  test("returns null for a process genuinely outside tmux", () => {
    expect(paneFromPidAncestry(999, snap)).toBeNull();
  });

  test("cursor requires quiescence too — its busy vocabulary is provisional", () => {
    expect(profileFor("cursor").requiresQuiescence).toBe(true);
  });
});
