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
import {
  publishBrokerIdentityToTmux,
  chooseOperatorLabel,
  isHumanOperatorLabel,
  resolvePeerName,
  stripResolvedNameSuffix,
} from "../server";

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

// Operator-label regression (2026-05-15): operator-facing peer names must
// match the tmux top bar (`session.N`). `pane_id` remains stable metadata and
// the last fallback, but must not displace the human label used by find_peer().
describe("Operator-label fallback — human name first, pane_id metadata last", () => {
  test("server.ts resolves a human tmux operator label before pane_id fallback", async () => {
    const source = await Bun.file(`${import.meta.dir}/../server.ts`).text();

    const labelIdx = source.indexOf("const tmuxOperatorLabel =");
    expect(labelIdx).toBeGreaterThanOrEqual(0);
    const formulaSlice = source.slice(labelIdx, labelIdx + 360);

    expect(formulaSlice).toMatch(/resolveTmuxOperatorLabel\(tmuxInfo\)/);
    expect(formulaSlice).toMatch(/tmuxOperatorLabel\s*\?\?/);
    // pane_id remains only as the last fallback/metadata-derived address,
    // not as the first operator-facing name.
    expect(formulaSlice).toMatch(/\$\{tmuxInfo\.session\}\.\$\{tmuxInfo\.pane_id\}/);
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

  test("resolvePeerName still passes pane_id-shaped final fallback names through unchanged", () => {
    // pane_id names are allowed only as the final no-human-label fallback.
    // resolvePeerName must not strip, escape, or transform the % char there.
    expect(resolvePeerName(null, "claude_agents.%5", false, 12345)).toBe("claude_agents.%5");
    expect(resolvePeerName(null, "infra.%6", false, 12345)).toBe("infra.%6");
    expect(resolvePeerName(null, "session.%999", false, 12345)).toBe("session.%999");
  });

  test("operator labels accept session.N and reject pane-id names", () => {
    expect(isHumanOperatorLabel("infra.2", "infra")).toBe(true);
    expect(isHumanOperatorLabel("infra.2#4", "infra")).toBe(true);
    expect(isHumanOperatorLabel("infra.%24", "infra")).toBe(false);
    expect(isHumanOperatorLabel("marketing.2", "infra")).toBe(false);
  });

  test("operator-label allocation prefers pane_index when it is free", () => {
    expect(chooseOperatorLabel("infra", "2", ["infra.1", "infra.3"])).toBe("infra.2");
  });

  test("operator-label allocation falls back to the lowest free session.N", () => {
    expect(chooseOperatorLabel("infra", "2", ["infra.1", "infra.2", "infra.2#4"])).toBe("infra.3");
  });

  test("operator-label allocation ignores pane-id-shaped broker fallbacks as human seats", () => {
    expect(chooseOperatorLabel("infra", "2", ["infra.%19", "infra.%24"])).toBe("infra.2");
  });

  test("resolved-name suffix stripping is limited to broker numeric suffixes", () => {
    expect(stripResolvedNameSuffix("infra.2#4")).toBe("infra.2");
    expect(stripResolvedNameSuffix("custom#name")).toBe("custom#name");
  });

  test("broker identity mirror preserves operator label and writes peer metadata", async () => {
    const source = await Bun.file(`${import.meta.dir}/../server.ts`).text();

    expect(source).toContain("function publishBrokerIdentityToTmux");
    const helperStart = source.indexOf("function publishBrokerIdentityToTmux");
    const helperSlice = source.slice(helperStart, helperStart + 1200);

    expect(helperSlice).toContain('readTmuxPaneOption(paneTarget, "@operator_label")');
    expect(helperSlice).toContain("if (!existingOperatorLabel && displayLabel)");
    expect(helperSlice).toContain('setTmuxPaneOption(paneTarget, "@peer_id", identity.id)');
    expect(helperSlice).toContain('setTmuxPaneOption(paneTarget, "@peer_label", displayLabel)');
    expect(helperSlice).toContain('setTmuxPaneOption(paneTarget, "@peer_resolved_name", identity.resolved_name ?? "")');
    expect(helperSlice).toContain('setTmuxPaneOption(paneTarget, "@peer_client_type", identity.client_type)');
    expect(helperSlice).toContain('setTmuxPaneOption(paneTarget, "@peer_receiver_mode", identity.receiver_mode)');
  });

  test("broker identity mirror only targets stable pane ids", async () => {
    const source = await Bun.file(`${import.meta.dir}/../server.ts`).text();
    const helperStart = source.indexOf("function brokerIdentityPaneTarget");
    const helperSlice = source.slice(helperStart, helperStart + 360);

    expect(helperSlice).toContain("tmuxInfo?.pane_id");
    expect(helperSlice).toContain("process.env.TMUX_PANE");
    expect(helperSlice).not.toContain("tmuxInfo.session}:${tmuxInfo.window_index");
  });

  test("broker identity mirror writes tmux pane options without overwriting operator label", () => {
    const tmuxVersion = Bun.spawnSync(["tmux", "-V"], { stdout: "ignore", stderr: "ignore" });
    if (tmuxVersion.exitCode !== 0) return;

    const session = `claude-peers-test-${process.pid}-${Date.now()}`;
    const created = Bun.spawnSync(["tmux", "new-session", "-d", "-s", session], { stdout: "ignore", stderr: "ignore" });
    if (created.exitCode !== 0) return;

    try {
      const paneIdResult = Bun.spawnSync(["tmux", "display-message", "-p", "-t", `${session}:0.0`, "#{pane_id}"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const paneId = new TextDecoder().decode(paneIdResult.stdout).trim();
      expect(paneId).toMatch(/^%/);

      Bun.spawnSync(["tmux", "set-option", "-p", "-t", paneId, "@operator_label", "human.7"], {
        stdout: "ignore",
        stderr: "ignore",
      });

      publishBrokerIdentityToTmux({
        id: "peer123",
        name: "broker.7",
        resolved_name: "broker.7#2",
        client_type: "codex",
        receiver_mode: "codex-hook",
      }, {
        session,
        window_index: "0",
        window_name: "0",
        pane_id: paneId,
      });

      const readOption = (name: string): string => {
        const result = Bun.spawnSync(["tmux", "show-options", "-p", "-t", paneId, "-v", name], {
          stdout: "pipe",
          stderr: "ignore",
        });
        return new TextDecoder().decode(result.stdout).trim();
      };

      expect(readOption("@operator_label")).toBe("human.7");
      expect(readOption("@peer_id")).toBe("peer123");
      expect(readOption("@peer_label")).toBe("broker.7");
      expect(readOption("@peer_resolved_name")).toBe("broker.7#2");
      expect(readOption("@peer_client_type")).toBe("codex");
      expect(readOption("@peer_receiver_mode")).toBe("codex-hook");
    } finally {
      Bun.spawnSync(["tmux", "kill-session", "-t", session], { stdout: "ignore", stderr: "ignore" });
    }
  });

  test("registration, re-registration, and set_name publish through the same tmux mirror helper", async () => {
    const source = await Bun.file(`${import.meta.dir}/../server.ts`).text();
    const calls = source.match(/publishBrokerIdentityToTmux\(/g) ?? [];

    // Function definition plus initial register, auth-reset re-register, and set_name.
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(source).not.toContain("tmuxInfo && process.env.TMUX && tmuxInfo.window_index");
  });
});
