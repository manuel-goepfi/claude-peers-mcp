/**
 * Orphan self-reap decision (shouldOrphanExit) — TIME-BASED.
 *
 * Bug: a Codex/Claude session that re-spawns its claude-peers MCP server leaves
 * the OLD server.ts process running. The broker reclaims that old peer's row, so
 * the orphan's token is invalid — every heartbeat 401s, and the re-register
 * recovery mints throwaway rows that dedup immediately reclaims, looping forever.
 * Observed live 2026-06-19: 21 orphaned ghosts → 387,823 auth-fails / 24MB broker
 * log. From a peer's seat this reads as "broker is down" (a 401 auth-reject is
 * indistinguishable from broker-unreachable), though the broker is healthy.
 *
 * Fix: exit when auth has been continuously broken for a wall-clock GRACE window.
 * TIME-based, NOT count-based — brokerFetch is driven by the 15s heartbeat, the 1s
 * background poll (Claude), AND user tool calls, so a raw COUNT would cross a small
 * threshold in seconds on the 1s poll and risk a mass false self-kill of HEALTHY
 * servers during a transient broker restart/flap. A wall-clock window is cadence-
 * independent: a transient blip (which the re-register path recovers, landing a
 * SUCCESS that clears the streak) never reaches it. shouldOrphanExit(streakStart,
 * now, graceMs) is the pure decision; brokerFetch records the streak start / clears
 * it on success, and the HEARTBEAT TIMER (not brokerFetch) calls it + exits — so a
 * user tool call never dies mid-request.
 */
import { describe, test, expect } from "bun:test";
import { shouldOrphanExit } from "../server.ts";

const T0 = 1_000_000_000_000; // fixed base epoch (Date.now is banned in some harnesses; use literals)
const GRACE = 300_000;        // 5 min default

describe("shouldOrphanExit (time-based)", () => {
  test("no active streak (null) → never exits", () => {
    expect(shouldOrphanExit(null, T0, GRACE)).toBe(false);
    expect(shouldOrphanExit(null, T0 + 10 * GRACE, GRACE)).toBe(false);
  });

  test("streak shorter than the grace window → does NOT exit", () => {
    expect(shouldOrphanExit(T0, T0 + 1_000, GRACE)).toBe(false);        // 1s in
    expect(shouldOrphanExit(T0, T0 + GRACE - 1, GRACE)).toBe(false);    // 1ms short
  });

  test("streak at/over the grace window → exits", () => {
    expect(shouldOrphanExit(T0, T0 + GRACE, GRACE)).toBe(true);         // exactly at
    expect(shouldOrphanExit(T0, T0 + GRACE + 60_000, GRACE)).toBe(true);// well past
  });

  test("REGRESSION GUARD: cadence-independence — a 1s-poll storm cannot trip it early", () => {
    // The whole point of going time-based: no matter HOW MANY 401s arrive (the 1s
    // poll could log hundreds), only WALL-CLOCK elapsed matters. 10 seconds of
    // continuous 401s (what a count-based threshold of 10 would have killed on the
    // 1s poll) must NOT exit under the 5-min window.
    expect(shouldOrphanExit(T0, T0 + 10_000, GRACE)).toBe(false);
  });

  test("grace-window floor: a misconfigured tiny window is clamped to 60s", () => {
    // CLAUDE_PEERS_ORPHAN_EXIT_GRACE_MS=1000 (or 0/negative) must NOT let a healthy
    // server exit after 1s of transient 401s — the 60s floor prevents that footgun.
    expect(shouldOrphanExit(T0, T0 + 1_000, 1_000)).toBe(false);  // 1s elapsed, clamped floor 60s
    expect(shouldOrphanExit(T0, T0 + 1_000, 0)).toBe(false);
    expect(shouldOrphanExit(T0, T0 + 60_000, 1_000)).toBe(true);  // 60s reaches the clamped floor
    expect(shouldOrphanExit(T0, T0 + 60_000, -5)).toBe(true);
  });

  test("realistic orphan: continuously 401'd for 5 min → exit", () => {
    expect(shouldOrphanExit(T0, T0 + 300_000, GRACE)).toBe(true);
  });

  test("a success-cleared streak (null again) never exits even long after", () => {
    // After any successful broker call brokerFetch sets firstUnrecoverable401At=null;
    // a later check must see no streak.
    expect(shouldOrphanExit(null, T0 + 999_999_999, GRACE)).toBe(false);
  });
});
