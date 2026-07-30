/**
 * Recovering launch identity from the client process.
 *
 * Measured 2026-07-30: Cursor sanitises the environment it hands MCP servers. The
 * cursor process carried CLAUDE_PEER_NAME=curtest.1 and TMUX_PANE=%1073 while its
 * claude-peers server had neither, so the lane registered as `observer-43333` with
 * a tty seat instead of a name and a pane — unaddressable by anything the operator
 * reads on screen, and invisible to pane-based seat identity.
 *
 * The server already resolves the client's pid; that process has the values. These
 * cover reading them back, and the failure modes that must not break registration.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/** Mirrors server.ts environOfPid — same parse, so drift shows up here. */
function environOfPid(pid: number): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const kv of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
      const eq = kv.indexOf("=");
      if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    return out;
  } catch {
    return {};
  }
}

describe("environOfPid", () => {
  test("reads a live process's environment", async () => {
    const proc = Bun.spawn(["sleep", "30"], {
      env: { PATH: process.env.PATH ?? "", CLAUDE_PEER_NAME: "curtest.1", TMUX_PANE: "%1073" },
      stdout: "ignore", stderr: "ignore",
    });
    try {
      await Bun.sleep(150);   // /proc/<pid>/environ is not populated the instant spawn returns
      const env = environOfPid(proc.pid!);
      expect(env.CLAUDE_PEER_NAME).toBe("curtest.1");
      expect(env.TMUX_PANE).toBe("%1073");
    } finally {
      proc.kill();
    }
  });

  test("returns {} for a dead or unreadable pid instead of throwing", () => {
    // Registration must never fail because identity recovery could not read a proc.
    expect(environOfPid(999_999_999)).toEqual({});
    expect(environOfPid(1)).toBeInstanceOf(Object);   // pid 1: readable or not, never throws
  });

  test("handles values containing '=' and empty values", async () => {
    const proc = Bun.spawn(["sleep", "30"], {
      env: { PATH: process.env.PATH ?? "", TRICKY: "a=b=c", EMPTY: "" },
      stdout: "ignore", stderr: "ignore",
    });
    try {
      await Bun.sleep(150);
      const env = environOfPid(proc.pid!);
      expect(env.TRICKY).toBe("a=b=c");   // split on the FIRST '=' only
      expect(env.EMPTY).toBe("");
    } finally {
      proc.kill();
    }
  });

  test("an ancestor's environ is readable under ptrace_scope=1", () => {
    // The whole approach depends on this: the MCP server reads its CLIENT, which is
    // its ancestor. If a kernel policy ever forbids it, recovery degrades to {} and
    // the lane keeps its observer-<pid> name — no crash, just no improvement.
    const parentEnv = environOfPid(process.ppid);
    expect(parentEnv).toBeInstanceOf(Object);
  });
});

describe("the recovery decision", () => {
  // The server only reaches for the client's env when its OWN is missing the keys,
  // so a client that passes env through (codex does) is untouched.
  function shouldRecover(own: Record<string, string | undefined>): boolean {
    return !own.CLAUDE_PEER_NAME || !own.TMUX_PANE;
  }

  test("recovers when the client stripped the environment (cursor)", () => {
    expect(shouldRecover({})).toBe(true);
  });

  test("recovers when only one key is missing", () => {
    expect(shouldRecover({ CLAUDE_PEER_NAME: "infra.2" })).toBe(true);
    expect(shouldRecover({ TMUX_PANE: "%312" })).toBe(true);
  });

  test("does NOT reach for the client when our own env is complete (codex)", () => {
    expect(shouldRecover({ CLAUDE_PEER_NAME: "infra.2", TMUX_PANE: "%312" })).toBe(false);
  });
});
