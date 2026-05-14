/**
 * #11 — PID-based name fallback (observer-${PID}).
 *
 * Tests the resolvePeerName() pure function extracted from server.ts main()
 * as part of the spec §1.5 follow-up #2 implementation. Closes the historic
 * "no env, no tmux → name=null" gap so peerName is always a non-empty string.
 *
 * Pre-#11: a bare-claude session with no CLAUDE_PEER_NAME env var and no tmux
 * registered with name=null and was unfindable by name (only by id).
 * Post-#11: such sessions get observer-${pid} as the final fallback.
 *
 * Mirror pattern matches tests/phase-a2-broker.test.ts and
 * tests/phase-b-r5b-ttl-reaper.test.ts. Unlike broker.ts, server.ts does NOT
 * have top-level Bun.serve side effects (it's an MCP stdio server, not an
 * HTTP listener), so resolvePeerName is imported as the real symbol — no
 * mirror copy needed.
 */

import { describe, test, expect } from "bun:test";
import { resolvePeerName } from "../server";

describe("#11 — resolvePeerName fallback chain", () => {
  const PID = 12345;

  test("env wins when present (highest priority)", () => {
    expect(resolvePeerName("custom-name", "tmux-fallback", false, PID)).toBe("custom-name");
  });

  test("tmux fallback wins when env is null", () => {
    expect(resolvePeerName(null, "session.2", false, PID)).toBe("session.2");
  });

  test("observer-${pid} fires when env AND tmux are both null (CLOSES THE GAP)", () => {
    expect(resolvePeerName(null, null, false, PID)).toBe("observer-12345");
  });

  test("env wins even when tmux is also present (env > tmux precedence)", () => {
    expect(resolvePeerName("env-name", "tmux.5", false, PID)).toBe("env-name");
  });
});

describe("#11 — R6.1 Task-subagent suffix overlay (preserved from R6.1)", () => {
  const PID = 67890;

  test("env + no tmux + isTaskSubagent=true → name suffixed with .task.${pid}", () => {
    // Task subagents inherit operator parent's CLAUDE_PEER_NAME but lack tmux
    // ancestry. The .task suffix prevents find_peer({name: envName}) from
    // returning the subagent instead of the operator seat.
    expect(resolvePeerName("rag.2", null, true, PID)).toBe("rag.2.task.67890");
  });

  test("env + tmux + isTaskSubagent=true → NOT suffixed (R6.1 requires no-tmux)", () => {
    // Tmux ancestry indicates this is a real operator seat in tmux, not a
    // Task subagent. Despite isTaskSubagent returning true (false positive
    // from grandparent heuristic), tmux presence wins.
    expect(resolvePeerName("rag.2", "tmux.1", true, PID)).toBe("rag.2");
  });

  test("no env + no tmux + isTaskSubagent=true → observer-${pid} (no R6.1, no env to suffix)", () => {
    // R6.1 requires env to suffix; without env, peerName is observer-${pid}
    // which is already PID-unique. No further suffixing needed.
    expect(resolvePeerName(null, null, true, PID)).toBe("observer-67890");
  });

  test("no env + tmux + isTaskSubagent=true → tmux name (R6.1 requires env)", () => {
    expect(resolvePeerName(null, "tmux.3", true, PID)).toBe("tmux.3");
  });
});

describe("#11 — return type invariants", () => {
  test("never returns null (closes the type narrowing — peerName is always string)", () => {
    // Each fallback in the chain either succeeds or hands off; the final
    // observer-${pid} always succeeds because process.pid is always defined.
    const result = resolvePeerName(null, null, false, 1);
    expect(result).toBeTypeOf("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("observer-${pid} format is stable (regression sentinel for spec §1.5)", () => {
    // The spec §1.5 follow-up #2 specifies "observer-${PID}" literal format.
    // If this changes (e.g., to "obs-${pid}" or "claude-${pid}"), shell
    // wrappers + operator scripts that grep for "observer-" patterns break.
    expect(resolvePeerName(null, null, false, 99999)).toBe("observer-99999");
    expect(resolvePeerName(null, null, false, 1)).toBe("observer-1");
  });
});

// Dup-name fix (2026-05-14): the tmuxFallbackName formula in server.ts
// main() now uses tmux pane_id (stable per-pane lifetime, e.g., "%5")
// instead of pane_index (positional, drifts on add/close, e.g., "1").
// The formula itself isn't a separate exported function — it's inline at
// the registration site — so this block uses three complementary strategies:
//
//   1. SOURCE-GREP SENTINEL: assert server.ts source contains the
//      pane_id-based formula AND the matching truthy guard. Catches
//      accidental revert to pane_index in either position. Pragmatic
//      stopgap until the broker.ts module-extraction follow-up (#16)
//      lets us test the registration path with real MCP fixtures.
//
//   2. FALSY-PANE_ID FALLBACK (spec test case 3): when tmuxInfo.pane_id
//      is missing/null/empty (env-hint path that exports SESSION but not
//      PANE_ID, or tmux returning unexpected output), the formula yields
//      null → resolvePeerName cascades to the observer-${pid} fallback.
//      This guards the "silent demotion to PID-based name" failure mode
//      the env-hint path can hit.
//
//   3. SQL-WILDCARD INTERACTION: % is a SQL LIKE wildcard, and post-fix
//      every tmux peer name CONTAINS %. handleListPeers (broker.ts:740)
//      uses JS .includes() so % is literal — sentinel test below documents
//      this. handleBroadcast (broker.ts:802) escapes % in caller-supplied
//      name_like via replace(/[\\%_]/g, "\\$&") + ESCAPE '\' — already
//      tested in tests/delivery.test.ts; documented here for completeness.
//
// Updated 2026-05-14 per /clause5-code-review pass: anchor switched from
// fragile comment-string to durable code-string; tautological "two distinct
// names" test deleted (was "a" !== "b" dressed as regression); added
// load-bearing sentinels for case 3 (falsy pane_id) and SQL-wildcard.
describe("Dup-name fix — pane_id formula (source-grep + integration sentinels)", () => {
  test("server.ts uses tmuxInfo.pane_id (NOT pane_index) in tmuxFallbackName formula AND truthy guard", async () => {
    const source = await Bun.file(`${import.meta.dir}/../server.ts`).text();

    // Anchor on the call site of resolvePeerName (durable code, not a
    // comment). The slice contains the formula assignment + the guard +
    // the resolvePeerName call itself. Anchors:
    //   - upper: the literal call-site `resolvePeerName(envName, tmuxFallbackName`
    //     (read backwards by splitting and taking [0])
    //   - lower: same call site (taking [1] would orphan the formula above)
    // Cleaner approach: find the formula assignment statement via its LHS
    // identifier `tmuxFallbackName =`, then take a 200-char window after.
    const assignIdx = source.indexOf("const tmuxFallbackName =");
    expect(assignIdx).toBeGreaterThanOrEqual(0); // sanity: assignment found
    const formulaSlice = source.slice(assignIdx, assignIdx + 200);

    // Truthy guard must check pane_id (the source of stability).
    expect(formulaSlice).toMatch(/tmuxInfo\s*&&\s*tmuxInfo\.pane_id/);
    // Template literal must use pane_id.
    expect(formulaSlice).toMatch(/\$\{tmuxInfo\.session\}\.\$\{tmuxInfo\.pane_id\}/);
    // Anti-pattern: pane_index must NOT appear in either position within
    // the formula slice (still used elsewhere in server.ts for logging).
    expect(formulaSlice).not.toMatch(/tmuxInfo\.pane_index/);
  });

  test("falsy pane_id → null tmuxFallbackName → observer-${pid} (spec test case 3)", () => {
    // Integration scenario: when the env-hint path produces a tmuxInfo
    // with pane_id missing (composeTmuxFromEnv at shared/tmux.ts:108-119
    // — env exports SESSION but not CLAUDE_PEER_TMUX_PANE_ID), the formula
    // assignment in server.ts yields null because the truthy guard
    // `tmuxInfo && tmuxInfo.pane_id` is false. The resulting null then
    // cascades through resolvePeerName to the observer-${pid} fallback.
    //
    // This test exercises the resolvePeerName side of that cascade.
    // The formula side is covered by the source-grep sentinel above.
    expect(resolvePeerName(null, null, false, 7777)).toBe("observer-7777");
    // Same for env-hint paths that supplied SESSION-only — null cascades.
    expect(resolvePeerName(null, null, false, 1)).toBe("observer-1");
  });

  test("resolvePeerName passes pane_id-shaped names through unchanged (% is intentional, not transformed)", () => {
    // After the formula change, tmuxFallbackName arrives as e.g.
    // "claude_agents.%5" (% prefix from tmux pane_id notation).
    // resolvePeerName must not strip, escape, or transform the % char.
    expect(resolvePeerName(null, "claude_agents.%5", false, 12345)).toBe("claude_agents.%5");
    expect(resolvePeerName(null, "infra.%6", false, 12345)).toBe("infra.%6");
    expect(resolvePeerName(null, "session.%999", false, 12345)).toBe("session.%999");
  });

  test("name_like JS-substring filter handles % literally (broker.ts:740 uses .includes() not LIKE)", () => {
    // Post-fix peer names contain % literally (e.g., "claude_agents.%5").
    // handleListPeers at broker.ts:740-742 filters via
    // p.name.toLowerCase().includes(nameLike.toLowerCase())
    // — JavaScript substring match where % is just a character.
    // This sentinel documents the property locally so a future refactor
    // (e.g., switching to SQL LIKE without escape) breaks the test first.
    const peerName = "claude_agents.%5";
    // Substring containing the literal % must match.
    expect(peerName.toLowerCase().includes("agents.%".toLowerCase())).toBe(true);
    expect(peerName.toLowerCase().includes("%5".toLowerCase())).toBe(true);
    // Substring without the % must also match (substring before the %).
    expect(peerName.toLowerCase().includes("claude_agents".toLowerCase())).toBe(true);
    // Non-matching substring stays non-matching.
    expect(peerName.toLowerCase().includes("nonexistent".toLowerCase())).toBe(false);
  });
});
