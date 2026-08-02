/**
 * The test preload is load-bearing safety code. It needs a test that FAILS when
 * it is weakened.
 *
 * What this guards: on 2026-07-31 the suite escaped its sandbox through
 * CLAUDE_CONFIG_DIR, deleted the operator's three peer hooks, and cost a day of
 * lost mail across every account-B lane. The fix lives entirely in
 * tests/setup-no-live-tmux.ts — and until this file existed, deleting any line of
 * it left the suite green.
 *
 * ⚠ WHY THIS SPAWNS A CHILD instead of asserting on its own process.
 * A same-process postcondition ("expect CLAUDE_CONFIG_DIR to be undefined") is
 * hollow: it passes on any machine where the operator's shell does not happen to
 * set that variable, which is most machines and every CI runner. It would have
 * been green for the entire week the bug was live. So we spawn a child with
 * SENTINEL values deliberately set, load the preload inside it, and assert the
 * preload actually neutralised them. That tests the failure mode rather than the
 * current machine.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const preload = new URL("./setup-no-live-tmux.ts", import.meta.url).pathname;

/** Variables the preload must REMOVE outright. */
const MUST_BE_ABSENT = [
  "TMUX_PANE",
  "TMUX",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PEER_NAME",
  "CLAUDE_PEERS_PORT",
] as const;

/** Variables the preload must REDIRECT into its private sandbox, never delete. */
const MUST_BE_REDIRECTED = [
  "CLAUDE_PEERS_DB",
  "CLAUDE_PEERS_AUTODRAIN_HEARTBEAT",
  "CLAUDE_PEERS_BROKER_LOG",
  "CLAUDE_PEERS_BACKUP",
  "CLAUDE_PEERS_BRIDGE_TOKEN_FILE",
] as const;

/**
 * Run the preload in a child whose environment is hostile, and report what it did.
 * The sentinel root is a real directory so we can also prove nothing was written
 * into it.
 */
function runPreloadWithSentinels(): { env: Record<string, string | undefined>; sentinelRoot: string } {
  const sentinelRoot = mkdtempSync(join(tmpdir(), "claude-peers-SENTINEL-"));
  const hostile: Record<string, string> = {
    TMUX_PANE: "%99999",
    TMUX: "/tmp/tmux-sentinel/default,99999,0",
    CLAUDE_CONFIG_DIR: join(sentinelRoot, "config"),
    CLAUDE_PEER_NAME: "SENTINEL-LANE",
    CLAUDE_PEERS_PORT: "7899",
    CLAUDE_PEERS_DB: join(sentinelRoot, "peers.db"),
    CLAUDE_PEERS_AUTODRAIN_HEARTBEAT: join(sentinelRoot, "heartbeat"),
    CLAUDE_PEERS_BROKER_LOG: join(sentinelRoot, "broker.log"),
    CLAUDE_PEERS_BACKUP: join(sentinelRoot, "backup"),
    CLAUDE_PEERS_BRIDGE_TOKEN_FILE: join(sentinelRoot, "token"),
  };
  const keys = [...MUST_BE_ABSENT, ...MUST_BE_REDIRECTED];
  const proc = Bun.spawnSync(
    ["bun", "-e", `await import(${JSON.stringify(preload)}); console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map((k) => [k, process.env[k] ?? null]))));`],
    { env: { ...process.env, ...hostile }, stdout: "pipe", stderr: "pipe" },
  );
  const out = new TextDecoder().decode(proc.stdout).trim();
  if (proc.exitCode !== 0 || !out) {
    throw new Error(`preload child failed (${proc.exitCode}): ${new TextDecoder().decode(proc.stderr)}`);
  }
  return { env: JSON.parse(out.split("\n").pop()!), sentinelRoot };
}

describe("test preload neutralises a hostile environment", () => {
  test("variables that must be REMOVED are gone even when the host sets them", () => {
    // Each of these caused real damage or a real misroute: CLAUDE_CONFIG_DIR ate
    // the operator's hooks, TMUX_PANE stamped a fixture identity onto a live pane
    // ("wedge"), CLAUDE_PEER_NAME makes a live lane ambiguous to send_to_peer,
    // and CLAUDE_PEERS_PORT would point a test server at the live broker.
    const { env } = runPreloadWithSentinels();
    for (const key of MUST_BE_ABSENT) {
      expect(`${key}=${env[key] ?? "(absent)"}`).toBe(`${key}=(absent)`);
    }
  });

  test("path overrides are REDIRECTED into a private sandbox, never left on the sentinel", () => {
    // Deleting these would be worse than leaving them: several fall back to
    // homedir(), which ignores $HOME, so removal GUARANTEES the operator's real
    // path. They must be pointed somewhere private instead.
    const { env, sentinelRoot } = runPreloadWithSentinels();
    for (const key of MUST_BE_REDIRECTED) {
      const value = env[key];
      expect(`${key} set?`).toBe(value ? `${key} set?` : `${key} MISSING`);
      expect(value!.startsWith(sentinelRoot)).toBe(false);   // not the hostile value
      expect(value!.includes("claude-peers-test-")).toBe(true); // inside the preload's own root
    }
  });

  test("every redirect lands in ONE private root, not scattered", () => {
    const { env } = runPreloadWithSentinels();
    const roots = new Set(MUST_BE_REDIRECTED.map((k) => env[k]!.split("/").slice(0, -1).join("/")));
    expect(roots.size).toBe(1);
  });

  test("the hostile sentinel directory is never written to", () => {
    // The property that actually matters. Redirection could be correct in the
    // env and still wrong in behaviour if something resolved a path before the
    // preload ran.
    const { sentinelRoot } = runPreloadWithSentinels();
    expect(existsSync(sentinelRoot)).toBe(true);
    expect(readdirSync(sentinelRoot)).toEqual([]);
  });

  test("the preload leaves no live tmux identity for a spawned server to adopt", () => {
    // TMUX must go too, not just TMUX_PANE: with TMUX set, tmux resolves a client
    // and a server can find the operator's active pane even with no pane id.
    const { env } = runPreloadWithSentinels();
    expect(env.TMUX).toBeNull();
    expect(env.TMUX_PANE).toBeNull();
  });
});
