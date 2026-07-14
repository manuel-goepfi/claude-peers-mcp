/**
 * Unit tests for the standby watcher's auto-mode regex.
 *
 * The regex is load-bearing: a false positive triggers AUTONOMOUS wake
 * (Claude proceeds without asking), a false negative forces ASK-FIRST.
 * Errors here are safety-relevant — autonomous execution of peer
 * instructions without user confirmation is the dangerous failure mode.
 *
 * Exercise the same helper the watcher invokes against realistic summaries.
 */
import { describe, test, expect } from "bun:test";
import { autoWakeEnabled } from "../hooks/claude-wake-mode.ts";

async function modeFor(summary: string): Promise<string> {
  return autoWakeEnabled(summary) ? "auto" : "ask";
}

describe("standby watcher — auto-mode regex", () => {
  test("'standby auto' → auto", async () => {
    expect(await modeFor("standby auto — reply ack")).toBe("auto");
  });

  test("'auto standby' → auto (reverse order)", async () => {
    expect(await modeFor("auto standby for phase 3")).toBe("auto");
  });

  test("'standby' alone (no auto) → ask", async () => {
    expect(await modeFor("standby — waiting for handoff")).toBe("ask");
  });

  test("'awaiting auto X' → auto (standalone auto token)", async () => {
    expect(await modeFor("awaiting auto approval from executor")).toBe("auto");
  });

  test("'waiting for auto-merge' → ask (hyphenated, not adjacent token)", async () => {
    expect(await modeFor("waiting for auto-merge CI run")).toBe("ask");
  });

  test("'automation standby' → ask (auto is a substring, not token)", async () => {
    expect(await modeFor("automation standby mode")).toBe("ask");
  });

  test("'standby auto-detect' → ask (auto-detect is not 'auto' token)", async () => {
    expect(await modeFor("standby auto-detect verification")).toBe("ask");
  });

  test("'autonomous standby' → ask (autonomous is not 'auto' token)", async () => {
    expect(await modeFor("autonomous standby daemon")).toBe("ask");
  });

  test("empty summary → ask", async () => {
    expect(await modeFor("")).toBe("ask");
  });

  test("'editing CLAUDE.md' (typical work summary) → ask", async () => {
    expect(await modeFor("[tmux rag:claude] Clause5 — editing CLAUDE.md +9")).toBe("ask");
  });

  test("'standby-auto' (dash-joined, not token-separated) → ask", async () => {
    // Dashes are NOT [[:space:]] in bash regex — so 'standby-auto' has
    // no whitespace between tokens and does NOT match.
    expect(await modeFor("standby-auto mode")).toBe("ask");
  });

  test("'Standing By Auto' → auto (case-insensitive)", async () => {
    expect(await modeFor("Standing By Auto — launch pad green")).toBe("auto");
  });

  test("'auto' alone → auto", async () => {
    expect(await modeFor("auto")).toBe("auto");
  });
});
