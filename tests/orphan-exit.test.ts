/**
 * Orphan self-reap decision (shouldOrphanExit).
 *
 * Bug: a Codex/Claude session that re-spawns its claude-peers MCP server leaves
 * the OLD server.ts process running. The broker reclaims that old peer's row, so
 * the orphan's token is invalid — every heartbeat 401s, and the re-register
 * recovery path mints throwaway rows that dedup immediately reclaims, looping
 * forever. Observed live 2026-06-19: 21 orphaned ghosts → 387,823 auth-fails /
 * 24MB broker log. From a peer's seat this reads as "broker is down" (it cannot
 * distinguish a 401 auth-reject from broker-unreachable), though the broker is
 * healthy (2d+ uptime, 0 restarts).
 *
 * Fix: count CONSECUTIVE unrecoverable 401s (those that survive re-register+retry)
 * and exit after a threshold — an orphaned server should die, not flood. Any
 * successful broker call resets the count, so a transient broker restart (which
 * recovery DOES fix) never trips it. shouldOrphanExit is the pure decision.
 */
import { describe, test, expect } from "bun:test";
import { shouldOrphanExit } from "../server.ts";

describe("shouldOrphanExit", () => {
  test("does NOT exit below the threshold (transient 401s recover)", () => {
    for (let n = 0; n < 10; n++) expect(shouldOrphanExit(n, 10)).toBe(false);
  });

  test("exits exactly AT the threshold", () => {
    expect(shouldOrphanExit(10, 10)).toBe(true);
    expect(shouldOrphanExit(11, 10)).toBe(true);
  });

  test("REGRESSION GUARD: a single 401 must NEVER exit (recovery handles it)", () => {
    // If a future edit makes the guard fire on 1 failure, a transient broker
    // restart would kill every healthy server. This pins that it does not.
    expect(shouldOrphanExit(1, 10)).toBe(false);
    expect(shouldOrphanExit(0, 10)).toBe(false);
  });

  test("threshold floor: a misconfigured threshold < 2 is clamped to 2", () => {
    // CLAUDE_PEERS_ORPHAN_EXIT_THRESHOLD=1 (or 0/negative) must NOT make the server
    // exit on a single transient 401 — the floor of 2 prevents that footgun.
    expect(shouldOrphanExit(1, 1)).toBe(false); // clamped to 2 → 1 < 2 → no exit
    expect(shouldOrphanExit(1, 0)).toBe(false);
    expect(shouldOrphanExit(2, 1)).toBe(true);  // 2 reaches the clamped floor
    expect(shouldOrphanExit(2, -5)).toBe(true);
  });

  test("realistic orphan: 10 consecutive failed heartbeats (~2.5min) → exit", () => {
    // At a 15s heartbeat, 10 consecutive unrecoverable 401s ≈ 2.5 minutes of being
    // orphaned — well past any transient broker blip — so the server reaps itself.
    expect(shouldOrphanExit(10, 10)).toBe(true);
  });
});
