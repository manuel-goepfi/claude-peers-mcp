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
// the registration site — so this block uses two complementary strategies:
//
//   1. SOURCE-GREP SENTINEL: assert server.ts source contains the
//      pane_id-based formula. Catches accidental revert to pane_index.
//      Pragmatic stopgap until the broker.ts module-extraction follow-up
//      (#16) lets us test the registration path with real MCP fixtures.
//
//   2. PASSTHROUGH BEHAVIOR: assert resolvePeerName treats pane_id-shaped
//      strings (containing "%") identically to other strings. Documents
//      that the "%" prefix in the resulting peer name is intentional and
//      passes through to the broker without escaping/transformation.
describe("Dup-name fix — pane_id formula (source-grep + passthrough)", () => {
  test("server.ts uses tmuxInfo.pane_id, NOT tmuxInfo.pane_index, in tmuxFallbackName", async () => {
    const source = await Bun.file(`${import.meta.dir}/../server.ts`).text();

    // Carve out the slice around the tmuxFallbackName formula. Use the
    // surrounding comment anchors so the regex doesn't match unrelated
    // pane_index references elsewhere in the file (e.g., logging,
    // env-hint export, tmux detection).
    const formulaSlice = source
      .split("Name fallback resolution: env → tmux pane")[1]
      ?.split("const isSubagent = isTaskSubagent()")[0] ?? "";

    expect(formulaSlice.length).toBeGreaterThan(0); // sanity: anchors found
    expect(formulaSlice).toMatch(/tmuxInfo\.pane_id/);
    expect(formulaSlice).toMatch(/\$\{tmuxInfo\.session\}\.\$\{tmuxInfo\.pane_id\}/);
    // Anti-pattern: pane_index must NOT appear in the formula slice
    // (it's still used elsewhere in server.ts for logging, but not here).
    expect(formulaSlice).not.toMatch(/tmuxInfo\.pane_index/);
  });

  test("resolvePeerName passes pane_id-shaped tmux names through unchanged", () => {
    // After the formula change, tmuxFallbackName arrives as e.g.
    // "claude_agents.%5" (% prefix from tmux pane_id notation).
    // resolvePeerName must not strip, escape, or transform the % char.
    expect(resolvePeerName(null, "claude_agents.%5", false, 12345)).toBe("claude_agents.%5");
    expect(resolvePeerName(null, "infra.%6", false, 12345)).toBe("infra.%6");
    expect(resolvePeerName(null, "session.%999", false, 12345)).toBe("session.%999");
  });

  test("two different pane_ids in same session produce two distinct names (regression for operator's bug)", () => {
    // Pre-fix: pane_index could collide (both panes computed e.g.
    // "claude_agents.1") → broker dedup → second peer became
    // "claude_agents.1#2". Post-fix: pane_id is unique per pane lifetime,
    // so the two names differ from the start. This test documents the
    // bug shape and the post-fix invariant.
    const paneAName = resolvePeerName(null, "claude_agents.%4", false, 100);
    const paneBName = resolvePeerName(null, "claude_agents.%5", false, 200);
    expect(paneAName).not.toBe(paneBName);
    expect(paneAName).toBe("claude_agents.%4");
    expect(paneBName).toBe("claude_agents.%5");
  });
});
