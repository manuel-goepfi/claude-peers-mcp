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
import {
  BrokerHttpError,
  isMissingClaimEndpointError,
  readThreadId,
  resolveDrainRoute,
  shouldSelfRegisterAfterClaimError,
} from "../hooks/codex-drain-peer-inbox.ts";

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

describe("stale-broker diagnostic covers BOTH claim route families", () => {
  // Found by infra.7 reviewing the first cut, and reproduced before fixing: a
  // hook installed before the broker restarts 404s on whichever claim route it
  // uses. Recognising only /claim-by-pid dropped the "restart the broker" hint
  // for every thread-routed drain — the NEWER path, so exactly the one most
  // likely to outrun a running broker.
  test.each(["/claim-by-pid", "/claim-by-thread"])("%s 404 is a missing-endpoint error", (path) => {
    expect(isMissingClaimEndpointError(new BrokerHttpError(path, 404, "Not Found"))).toBe(true);
  });

  test.each(["/claim-by-pid", "/claim-by-thread"])("the string form is recognised for %s", (path) => {
    expect(isMissingClaimEndpointError(new Error(`cannot POST ${path}`))).toBe(true);
  });

  test("a peer-not-found 404 is NOT a missing endpoint, on either family", () => {
    // Load-bearing distinction: peer-not-found must stay eligible for
    // self-registration, while a missing endpoint must not (registering cannot
    // conjure a route). Collapsing them would make the drain retry forever
    // against a broker that can never answer.
    for (const path of ["/claim-by-pid", "/claim-by-thread"]) {
      const err = new BrokerHttpError(path, 404, "peer not found");
      expect(isMissingClaimEndpointError(err)).toBe(false);
      expect(shouldSelfRegisterAfterClaimError(err)).toBe(true);
    }
  });
});

describe("self-registration must not drop the thread", () => {
  test("the drain replays its hook payload into the registration child", () => {
    // Also from infra.7's review. register-peer-session.ts reads session_id from
    // ITS OWN stdin, and this hook has already consumed stdin — so a child
    // spawned without a replay registers thread_id = NULL, and the
    // /claim-by-thread retry that triggered the registration then 404s against
    // the row it just created. Silent, and indistinguishable from "the thread
    // join doesn't work".
    expect(source).toContain("activeHookInput = hookInput");
    expect(source).toMatch(/stdin:\s*replay === null \? "ignore" :/);
  });

  test("a null payload degrades to no stdin rather than sending 'null'", () => {
    // Writing the literal string "null" would make the child's JSON.parse
    // succeed with a non-object and mask the absence.
    expect(source).toContain("activeHookInput === null ? null : JSON.stringify(activeHookInput)");
  });
});

describe("the shipped drain wires it up", () => {
  test.each([
    ["SubagentStart", {
      hook_event_name: "SubagentStart",
      session_id: "019fc273-a35b-78f0-9a70-f63b5905540f",
      transcript_path: "/tmp/rollout-019fc273-a35b-78f0-9a70-f63b5905540f.jsonl",
    }, "event-mismatch"],
    ["internal SessionStart", {
      hook_event_name: "SessionStart",
      session_id: "019fd84b-4556-7fd2-8e21-3fac2582d757",
    }, "missing-transcript-path"],
  ])("%s returns before process discovery, claim, or self-registration", (_label, payload, reason) => {
    const hookPath = new URL("../hooks/codex-drain-peer-inbox.ts", import.meta.url).pathname;
    const proc = Bun.spawnSync([process.execPath, hookPath], {
      env: {
        CLAUDE_PEERS_CLIENT_TYPE: "codex",
        CLAUDE_PEERS_HOOK_EVENT_NAME: "SessionStart",
        PATH: "/definitely-missing",
      },
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new TextDecoder().decode(proc.stderr);

    expect(proc.exitCode).toBe(0);
    expect(new TextDecoder().decode(proc.stdout)).toBe("");
    expect(stderr).toContain(`skipping non-root Codex drain reason=${reason}`);
    expect(stderr).not.toContain("no codex ancestor found");
  });

  test("an unparseable transcript filename is logged and allowed through to thread routing", () => {
    const hookPath = new URL("../hooks/codex-drain-peer-inbox.ts", import.meta.url).pathname;
    const proc = Bun.spawnSync([process.execPath, hookPath], {
      env: {
        CLAUDE_PEERS_CLIENT_TYPE: "codex",
        CLAUDE_PEERS_HOOK_EVENT_NAME: "SessionStart",
        CLAUDE_PEERS_PORT: "1",
        PATH: process.env.PATH,
      },
      stdin: new TextEncoder().encode(JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "019fc273-a35b-78f0-9a70-f63b5905540f",
        transcript_path: "/future-codex/thread-transcript.jsonl",
      })),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new TextDecoder().decode(proc.stderr);

    expect(stderr).toContain("root proof degraded reason=unparseable-transcript-path; continuing fail-open");
    expect(stderr).not.toContain("skipping non-root Codex drain");
  });

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
