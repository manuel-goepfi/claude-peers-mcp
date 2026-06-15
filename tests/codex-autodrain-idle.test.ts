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
