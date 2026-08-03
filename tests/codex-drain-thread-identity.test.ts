/**
 * The Codex drain must address its own row by THREAD identity, not by ancestry.
 *
 * Why (measured 2026-08-03, ~/.codex/logs/drain-peer-inbox.log): 553
 * `drain-failed rc=1` entries, 541 immediately preceded by
 * "no codex ancestor found". Under a long-lived `codex app-server` the MCP
 * guard/server children are owned by the app-server, not by the pane TUI, so a
 * hook walking up its own process tree finds no codex parent and the drain
 * aborts. Correlating by process start time was considered and rejected: server
 * children are spawned continuously (one app-server went 27 -> 28 children in
 * 2.5 minutes), so any launch-time window either rejects healthy respawned
 * lanes or, worse, misbinds one lane to another.
 *
 * Codex hands every hook the SAME ThreadId it stamps into `_meta.threadId` on
 * MCP tool calls — SessionStart, UserPromptSubmit and StopCommandInput all carry
 * `session_id` (codex-rs/hooks/src/schema.rs). That is an exact join, so these
 * tests pin the two decisions that make it exact: reading the id, and choosing
 * the atomic `-by-thread` route family over `-by-pid`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readThreadId, resolveDrainRoute } from "../hooks/codex-drain-peer-inbox.ts";

const source = readFileSync(new URL("../hooks/codex-drain-peer-inbox.ts", import.meta.url), "utf8");

describe("readThreadId extracts Codex session_id", () => {
  test("reads a session_id from the hook payload", () => {
    expect(readThreadId({ session_id: "01999abc-thread" })).toBe("01999abc-thread");
  });

  test("trims surrounding whitespace", () => {
    expect(readThreadId({ session_id: "  t-1  " })).toBe("t-1");
  });

  test.each([
    ["null payload", null],
    ["absent key", { hook_event_name: "Stop" }],
    ["empty string", { session_id: "" }],
    ["whitespace only", { session_id: "   " }],
    ["non-string", { session_id: 12345 }],
    ["explicit null", { session_id: null }],
  ])("returns null for %s — never a bogus identity", (_label, payload) => {
    expect(readThreadId(payload as Record<string, unknown> | null)).toBeNull();
  });
});

describe("route selection prefers the exact join", () => {
  test("with a thread id, claim/ack/heartbeat all use the -by-thread family", () => {
    for (const base of ["claim", "ack", "hook-heartbeat"]) {
      const route = resolveDrainRoute(base, 4242, "t-9");
      expect(route.path).toBe(`/${base}-by-thread`);
      expect(route.identity).toEqual({ thread_id: "t-9" });
    }
  });

  test("the thread route never leaks a pid as identity", () => {
    // The pid travelling alongside is for log lines only. Sending it as identity
    // would let the broker resolve a DIFFERENT row than the thread names.
    const route = resolveDrainRoute("claim", 4242, "t-9");
    expect(route.identity).not.toHaveProperty("pid");
  });

  test("without a thread id it falls back to -by-pid, unchanged", () => {
    // Gemini, legacy Codex, and unreadable payloads must keep working exactly as
    // before — this change adds a path, it does not replace one.
    const route = resolveDrainRoute("claim", 4242, null);
    expect(route.path).toBe("/claim-by-pid");
    expect(route.identity).toEqual({ pid: 4242 });
  });
});

describe("the shipped drain wires it up", () => {
  test("thread identity is resolved BEFORE any process-table walk", () => {
    // The whole point: when the join is available the ancestry walk that
    // produced "no codex ancestor found" must never run.
    const threadIdx = source.indexOf("activeThreadId = readThreadId(hookInput)");
    const walkIdx = source.indexOf("findHookPeerPids()", threadIdx);
    expect(threadIdx).toBeGreaterThan(0);
    expect(walkIdx).toBeGreaterThan(threadIdx);
  });

  test("the ancestry walk is inside the no-thread-id branch, not unconditional", () => {
    expect(source).toContain("if (activeThreadId) {");
    expect(source).toMatch(/} else \{[\s\S]{0,200}findHookPeerPids\(\)/);
  });

  test("all three broker calls route through drainRoute", () => {
    for (const base of ['drainRoute("claim"', 'drainRoute("ack"', 'drainRoute("hook-heartbeat"']) {
      expect(source).toContain(base);
    }
  });

  test("no hardcoded -by-pid path survives in the call sites", () => {
    // A leftover literal would silently pin one of the three calls to the pid
    // family while the others used thread identity — a split-brain drain.
    expect(source).not.toContain('post("/claim-by-pid"');
    expect(source).not.toContain('post("/hook-heartbeat-by-pid"');
    expect(source).not.toContain('post<AckByPidResponse>("/ack-by-pid"');
  });
});
