/**
 * Unit tests for the codex-autodrain poller's idle/empty-input decision
 * (paneTextIsIdle). This is the safety-critical gate: it must NEVER return true
 * when the lane is busy OR has real queued operator text, or the poller would
 * inject keystrokes that disrupt active work / submit the operator's text.
 *
 * The dim-placeholder rule is the robust signal: Codex renders idle-prompt
 * placeholder text dim (ESC[2m); real typed input is bright. Captured live from
 * marketing.1 (pane %200): the prompt line read
 *   ESC[1m›ESC[0m ESC[2mImplement {feature}ESC[0m
 * i.e. a dim placeholder = empty input = nudgeable.
 */
import { describe, test, expect } from "bun:test";
import { paneTextIsIdle, everyVisibleCharIsDim } from "../bin/codex-autodrain-poller.ts";

const ESC = "\x1b";
const dim = (s: string) => `${ESC}[2m${s}${ESC}[0m`;
const bold = (s: string) => `${ESC}[1m${s}${ESC}[0m`;
const prompt = bold("›"); // bright › glyph, as Codex renders it

// A realistic idle capture: some prior output + the prompt line.
function idleCapture(afterGlyph: string): string {
  return [
    "  Bottom line: acquisition is healthy; conversion is the bottleneck.",
    "─".repeat(20),
    `${prompt} ${afterGlyph}`,
    "  ~/Clause5 · main · gpt-5.5 high · Context 43% left",
  ].join("\n");
}

describe("paneTextIsIdle", () => {
  test("NUDGE: idle prompt with a DIM placeholder (empty input)", () => {
    // the exact live shape from marketing.1
    expect(paneTextIsIdle(idleCapture(dim("Implement {feature}")))).toBe(true);
  });

  test("NUDGE: idle prompt with a different dim placeholder", () => {
    expect(paneTextIsIdle(idleCapture(dim("Find and fix a bug in @filename")))).toBe(true);
  });

  test("NUDGE: truly empty input line (glyph, no text)", () => {
    expect(paneTextIsIdle(idleCapture(""))).toBe(true);
  });

  test("SKIP: BRIGHT (real) queued operator text after the glyph", () => {
    // operator typed a real command — bright, not dim — must NOT be submitted
    expect(paneTextIsIdle(idleCapture("deploy to production now"))).toBe(false);
  });

  test("SKIP: bold/bright queued text (explicit SGR) is not a placeholder", () => {
    expect(paneTextIsIdle(idleCapture(bold("rm -rf build")))).toBe(false);
  });

  test("SKIP: lane is mid-turn (busy marker present)", () => {
    const busy = [
      "• Working (7s · esc to interrupt)",
      `${prompt} ${dim("Implement {feature}")}`,
    ].join("\n");
    expect(paneTextIsIdle(busy)).toBe(false); // busy marker wins even with dim prompt
  });

  test("SKIP: no prompt glyph at all (not at an input prompt)", () => {
    expect(paneTextIsIdle("• Running 2 PostToolUse hooks\n  some output")).toBe(false);
  });

  test("SKIP: 'Reviewing approval request' busy state", () => {
    const approving = [
      "◦ Reviewing approval request (55s · esc to interrupt)",
      `${prompt} ${dim("Implement {feature}")}`,
    ].join("\n");
    expect(paneTextIsIdle(approving)).toBe(false);
  });

  // ADVERSARIAL (review finding, high/conf90): real BRIGHT operator input with a
  // dim ghost-autocomplete suffix or dim @mention must NOT be misread as idle —
  // a substring "contains [2m" check would submit the operator's text. The
  // whole-input-must-be-dim rule defends this.
  test("SKIP: bright command + dim ghost-autocomplete suffix (the attack)", () => {
    const ghost = `deploy to prod${dim("uction now")}`; // bright "deploy to prod" + dim suffix
    expect(paneTextIsIdle(idleCapture(ghost))).toBe(false);
  });

  test("SKIP: bright command with a dim inline @mention", () => {
    const mention = `please review ${dim("@deploy.yaml")} and run it`; // mostly bright
    expect(paneTextIsIdle(idleCapture(mention))).toBe(false);
  });

  test("SKIP: real input that merely ends before a dim hint", () => {
    const mixed = `rm -rf build ${dim("(press enter)")}`;
    expect(paneTextIsIdle(idleCapture(mixed))).toBe(false);
  });
});

// --- Claude lane idle/busy gate (bg-claude wake support) ---
// Same safety contract as the Codex gate, against Claude's TUI: the prompt glyph
// is ❯ (U+276F, not ›) and the busy vocabulary is Claude's spinner verbs + the
// "· N tokens" in-flight status row. These fixtures replicate shapes captured
// live from a real backgrounded Claude pane (2026-06-15).
import { profileFor } from "../bin/codex-autodrain-poller.ts";
const CLAUDE = profileFor("claude");
const cPrompt = bold("❯"); // bright ❯ glyph, as Claude renders the input prompt

function claudeIdleCapture(afterGlyph: string): string {
  return [
    "● I'll start by registering my name as instructed.",
    "● ready",
    "─".repeat(20),
    `${cPrompt} ${afterGlyph}`,
    "─".repeat(20),
    "  [B] Clause5 | main | 92% left | Opus 4.8 (1M context) (xhigh)",
  ].join("\n");
}

describe("paneTextIsIdle — claude profile", () => {
  test("NUDGE: idle ❯ prompt, empty input", () => {
    expect(paneTextIsIdle(claudeIdleCapture(""), CLAUDE)).toBe(true);
  });

  test("NUDGE: idle ❯ prompt with a dim placeholder", () => {
    // Claude renders its ghost suggestion dim, same as Codex
    expect(paneTextIsIdle(claudeIdleCapture(dim('Try "create a util logging.py that..."')), CLAUDE)).toBe(true);
  });

  test("SKIP: bright (real) queued operator text after ❯ — must not submit", () => {
    expect(paneTextIsIdle(claudeIdleCapture("git push origin main"), CLAUDE)).toBe(false);
  });

  // Boundary the room cared about most — busy vs done. Grounded in live captures:
  // a COMPLETED turn prints a PAST-tense "Cogitated for 11s" (no ellipsis, no
  // active "(Ns ·" timer) and the lane IS idle → safe to nudge. An IN-FLIGHT turn
  // prints "Verb… (Ns · ↑ tokens)" → busy → never nudge. The active-timer shape
  // "(\d+s ·" is the discriminator; matching the bare word would wrongly freeze a
  // just-finished idle lane forever (it would never be woken).
  test("NUDGE: 'Cogitated for 11s' is a DONE turn (past tense) — lane is idle", () => {
    const done = ["✻ Cogitated for 11s", `${cPrompt} `].join("\n");
    expect(paneTextIsIdle(done, CLAUDE)).toBe(true);
  });

  test("SKIP: busy — 'Warping… (18s · ↑ 355 tokens)'", () => {
    const busy = ["✻ Warping… (18s · ↑ 355 tokens)", `${cPrompt} `].join("\n");
    expect(paneTextIsIdle(busy, CLAUDE)).toBe(false);
  });

  test("SKIP: busy — 'Evaporating… (6s · ↑ 122 tokens)'", () => {
    const busy = ["✽ Evaporating… (6s · ↑ 122 tokens)", `${cPrompt} `].join("\n");
    expect(paneTextIsIdle(busy, CLAUDE)).toBe(false);
  });

  test("SKIP: busy — generic '(Ns ·' in-flight timer", () => {
    const busy = ["✻ Synthesizing… (3s · ↓ 1.2k tokens)", `${cPrompt} `].join("\n");
    expect(paneTextIsIdle(busy, CLAUDE)).toBe(false);
  });

  // Cross-profile guard: a Codex pane fed the CLAUDE profile must NOT be seen as
  // idle (different glyph), so the poller can never nudge with the wrong profile.
  test("SKIP: a Codex › pane judged under the claude profile is NOT idle", () => {
    expect(paneTextIsIdle(idleCapture(""), CLAUDE)).toBe(false); // › glyph, ❯ profile
  });

  test("SKIP: a Claude ❯ pane judged under the codex profile is NOT idle", () => {
    expect(paneTextIsIdle(claudeIdleCapture(""), profileFor("codex"))).toBe(false);
  });
});

// --- bg-claude pane resolution (the two bugs live-testing caught) ---
import { sessionIdFromEnvironText, attachIdInTree } from "../bin/codex-autodrain-poller.ts";

describe("sessionIdFromEnvironText", () => {
  const NUL = "\0";
  // REGRESSION: a spare-hosted bg session's pty-host .sock basename is the SPARE
  // id (e.g. fdf1dffd), NOT the promoted session id the attach client uses
  // (719595a7). The promoted id is the one in CLAUDE_CODE_SESSION_ID. Reading it
  // here is what makes resolveBgAttachPane find the right pane.
  test("extracts CLAUDE_CODE_SESSION_ID 8-hex prefix", () => {
    const env = ["PATH=/usr/bin", "CLAUDE_CODE_SESSION_ID=719595a7-8fba-4907-a321-6ad48d8de97d", "HOME=/home/manzo"].join(NUL);
    expect(sessionIdFromEnvironText(env)).toBe("719595a7");
  });
  test("returns null when the var is absent", () => {
    expect(sessionIdFromEnvironText(["PATH=/usr/bin", "HOME=/home/manzo"].join(NUL))).toBeNull();
  });
  test("CLAUDE_JOB_DIR (a different var with an id) does NOT false-match", () => {
    expect(sessionIdFromEnvironText(["CLAUDE_JOB_DIR=/home/manzo/.claude-b/jobs/719595a7"].join(NUL))).toBeNull();
  });
});

describe("attachIdInTree", () => {
  // REGRESSION: `pstree -pa` renders the attach client as `claude,<pid> attach
  // <id>` — matching the literal "claude attach <id>" MISSES it (the comma+pid
  // sits between "claude" and "attach"). This is the exact shape that made the
  // ownership check skip a real idle bg-Claude.
  test("matches the real pstree -pa shape: 'claude,684836 attach 9c27fddd'", () => {
    const tree = "bash,1646219\n  `-claude,684836 attach 9c27fddd\n      |-{claude},684837";
    expect(attachIdInTree(tree, "9c27fddd")).toBe(true);
  });
  test("does NOT match a different session id in the tree", () => {
    const tree = "  `-claude,684836 attach 9c27fddd";
    expect(attachIdInTree(tree, "fdf1dffd")).toBe(false); // the spare id must NOT match
  });
  test("exact-id boundary: a longer id sharing the prefix does not ghost-match", () => {
    const tree = "  `-claude,684836 attach 9c27fddddead"; // 12 hex, prefix collides
    expect(attachIdInTree(tree, "9c27fddd")).toBe(false);
  });
  test("rejects a non-8-hex sessionId (guards the dynamic RegExp)", () => {
    expect(attachIdInTree("attach .* anything", ".*")).toBe(false);
  });
  test("no attach client in the tree → false", () => {
    expect(attachIdInTree("bash,1646219\n  `-claude,684836\n      |-{claude},684837", "9c27fddd")).toBe(false);
  });
});

describe("everyVisibleCharIsDim", () => {
  const E = "\x1b";
  test("all-dim text => true", () => {
    expect(everyVisibleCharIsDim(`${E}[2mImplement {feature}${E}[0m`)).toBe(true);
  });
  test("bright text => false", () => {
    expect(everyVisibleCharIsDim("deploy now")).toBe(false);
  });
  test("bright + dim suffix => false (the attack shape)", () => {
    expect(everyVisibleCharIsDim(`bright${E}[2mdim${E}[0m`)).toBe(false);
  });
  test("dim cleared by [22m mid-string, then bright => false", () => {
    expect(everyVisibleCharIsDim(`${E}[2mdim${E}[22mbright`)).toBe(false);
  });
  test("only whitespace (no visible char) => false", () => {
    expect(everyVisibleCharIsDim(`${E}[2m   ${E}[0m`)).toBe(false);
  });
  test("dim spanning the whole thing across multiple SGR resets => true", () => {
    expect(everyVisibleCharIsDim(`${E}[2mone ${E}[2mtwo${E}[0m`)).toBe(true);
  });
});

// --- resolveLanePane wiring (the integration the two 6039612 bugs lived in) ---
// The leaf matchers (sessionIdFromEnvironText, attachIdInTree) are tested above,
// but the BUGS were in the WIRING: (1) environ id must win over the spare .sock
// id, and (2) the returned attachId must be non-null on the bg path so tick picks
// paneOwnedByAttachId. These tests drive resolveLanePane directly with a synthetic
// snapshot + an injected environ reader — no /proc, no live tmux. Without them, an
// inverted environ/fallback order or a dropped attachId would pass the whole suite.
import { resolveLanePane } from "../bin/codex-autodrain-poller.ts";
import { bgSessionIdFromPtyHostArgs } from "../shared/tmux.ts";

const SPARE_ID = "fdf1dffd";     // the pre-warm spare slot id (in the .sock ancestry)
const PROMOTED_ID = "719595a7";  // the promoted session id the attach client uses

// Build a snapshot where: the lane's MCP server (pid 500) sits under a bg-pty-host
// (pid 400) whose args carry the SPARE id; a `claude attach <PROMOTED_ID>` client
// (pid 700) lives in a tmux pane (pane_pid 600 → pane %wt). resolveBgAttachPane
// keys on the PROMOTED id, so the lane resolves only if environ supplies it.
function bgSnapshot() {
  const procs = [
    { pid: 500, ppid: 400, args: "bun /home/manzo/claude-peers-mcp/server.ts" },
    { pid: 400, ppid: 300, args: "/v/2.1.177 --bg-pty-host /tmp/cc-daemon-1000/d/spare/fdf1dffd.pty.sock 200 50" },
    { pid: 700, ppid: 600, args: "claude attach 719595a7" },     // attach client in the pane
    { pid: 600, ppid: 1,   args: "-bash" },                        // pane shell (pane_pid)
  ];
  // parseTmuxPanes is keyed by pane_pid; one pane %wt owned by shell pid 600.
  const paneMap = new Map([[600, { session: "1", pane_id: "%wt" }]]) as any;
  return { procs, paneMap, paneByPid: new Map([["%wt", 600]]) } as any;
}
function bgLane(id: string) {
  return { id, name: id, pid: 500, client_type: "claude", tmux_pane_id: null, unread: 1 } as any;
}

describe("resolveLanePane wiring", () => {
  test("premise: the ancestry .sock yields the SPARE id, not the promoted id", () => {
    // Confirms the snapshot is set up so environ and ancestry genuinely DISAGREE —
    // otherwise the environ-wins test below would pass trivially.
    const ptyHostArgs = bgSnapshot().procs.find((p: any) => p.pid === 400).args;
    expect(bgSessionIdFromPtyHostArgs(ptyHostArgs)).toBe(SPARE_ID);
    expect(SPARE_ID).not.toBe(PROMOTED_ID);
  });

  test("environ id WINS over the spare .sock id (Bug-1 regression)", () => {
    // environ returns the PROMOTED id; ancestry walk would return the SPARE id.
    const r = resolveLanePane(bgLane("L1"), bgSnapshot(), () => PROMOTED_ID);
    expect(r.paneId).toBe("%wt");            // resolved via the promoted id
    expect(r.attachId).toBe(PROMOTED_ID);    // NOT the spare id → tick uses attach-id ownership
  });

  test("falls back to .sock ancestry walk when environ is null", () => {
    // With environ null, the only id available is the SPARE id from the ancestry.
    // The attach client runs the PROMOTED id, so resolveBgAttachPane finds NO pane
    // → empty pane (this is exactly why the spare id is the wrong source, and why
    // environ-first matters). attachId stays null when no pane resolves.
    const r = resolveLanePane(bgLane("L2"), bgSnapshot(), () => null);
    expect(r.paneId).toBe("");               // spare id can't match the promoted attach client
    expect(r.attachId).toBeNull();
  });

  test("environ-first ordering is observable: same lane resolves with environ, fails without", () => {
    const snap = bgSnapshot();
    const withEnviron = resolveLanePane(bgLane("L3a"), snap, () => PROMOTED_ID);
    const withoutEnviron = resolveLanePane(bgLane("L3b"), snap, () => null);
    expect(withEnviron.paneId).toBe("%wt");  // environ path resolves
    expect(withoutEnviron.paneId).toBe("");  // fallback path can't (spare id ≠ attach id)
  });

  test("a directly-registered lane (tmux_pane_id set) returns attachId=null → tick uses pid ownership", () => {
    const lane = { id: "L4", name: "codex.1", pid: 9, client_type: "codex", tmux_pane_id: "%5", unread: 1 } as any;
    const r = resolveLanePane(lane, bgSnapshot(), () => "deadbeef");
    expect(r.paneId).toBe("%5");
    expect(r.attachId).toBeNull();           // null → paneOwnedByPid branch, not attach-id
  });
});

// --- paneSubtree builds the subtree from the per-tick snapshot, NOT pstree ---
// REGRESSION (perf): paneSubtree used to fork `pstree -pa` PER LANE — O(all
// processes), ~3s on a loaded host, which pushed ticks past the poll interval
// (SLOW TICK, observed live: 18.5s over 4 lanes). It now walks DOWN from the
// pane's pane_pid through snap.procs (already captured this tick). These tests
// pin that behavior: the subtree text is derived purely from the snapshot, with
// the `(pid)` + args shapes the ownership checks depend on.
import { paneSubtree } from "../bin/codex-autodrain-poller.ts";

function snapOf(procs: { pid: number; ppid: number; args: string }[], paneByPid: [string, number][]) {
  return { procs, paneByPid: new Map(paneByPid), paneMap: new Map() } as any;
}

describe("paneSubtree (snapshot walk, no pstree fork)", () => {
  // pane %p → shell 100 → claude 200 → {bun 300, helper 400}
  const procs = [
    { pid: 100, ppid: 1, args: "-bash" },
    { pid: 200, ppid: 100, args: "claude attach 9c27fddd" },
    { pid: 300, ppid: 200, args: "bun server.ts" },
    { pid: 400, ppid: 200, args: "some-helper" },
    { pid: 999, ppid: 1, args: "unrelated-process" },   // NOT in the subtree
  ];
  const snap = snapOf(procs, [["%p", 100]]);

  test("collects every descendant pid of the pane shell", () => {
    const tree = paneSubtree("%p", snap)!;
    expect(tree.panePid).toBe(100);
    for (const pid of [100, 200, 300, 400]) expect(tree.text).toContain(`(${pid})`);
  });

  test("does NOT include unrelated processes outside the subtree", () => {
    const tree = paneSubtree("%p", snap)!;
    expect(tree.text).not.toContain("(999)");
    expect(tree.text).not.toContain("unrelated-process");
  });

  test("subtree text carries args so attachIdInTree still matches the attach client", () => {
    const tree = paneSubtree("%p", snap)!;
    expect(attachIdInTree(tree.text, "9c27fddd")).toBe(true);   // the ownership check
    expect(attachIdInTree(tree.text, "deadbeef")).toBe(false);
  });

  test("returns null when the pane id is not in the snapshot (pane gone)", () => {
    expect(paneSubtree("%gone", snap)).toBeNull();
  });

  test("cycle guard: a ppid loop does not hang the walk", () => {
    const looped = snapOf(
      [{ pid: 10, ppid: 20, args: "a" }, { pid: 20, ppid: 10, args: "b" }],
      [["%c", 10]],
    );
    const tree = paneSubtree("%c", looped)!;       // must terminate
    expect(tree.text).toContain("(10)");
    expect(tree.text).toContain("(20)");
  });
});
