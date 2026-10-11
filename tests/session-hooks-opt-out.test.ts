/**
 * CLAUDE_PEERS_SESSION_HOOKS_ENABLED=false turns the Claude session hooks into
 * no-ops. A cloud launcher's short-lived `claude` child inherits the operator's
 * TMUX_PANE; without an opt-out its SessionStart register hook enrolled it as
 * that pane's seat, leaving a ghost row under the seat's name every launch
 * (C5 Orch.290, 2026-10-11, about one row a minute).
 *
 * Shims for bun, sqlite3 and jq record every call. With the opt-out set, none
 * may run (nothing reaches the broker); with it unset, each hook reaches them.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOKS = ["claude-register-peer-session.sh", "claude-peers-session-greeting.sh", "claude-drain-peer-inbox.sh"];

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "peers-hooks-optout-"));
  const bin = join(root, "bin"), home = join(root, "home"), calls = join(root, "calls.log");
  mkdirSync(bin); mkdirSync(home);
  writeFileSync(join(home, ".claude-peers.db"), "");          // the greeting hook needs a DB file to proceed
  for (const tool of ["bun", "sqlite3", "jq"]) {
    const shim = join(bin, tool);
    writeFileSync(shim, `#!/bin/bash\necho "${tool} $*" >> '${calls}'\ncat >/dev/null 2>&1 || true\nexit 0\n`);
    chmodSync(shim, 0o755);
  }
  return { root, bin, home, calls };
}

async function runHook(hook: string, optOut: string | null) {
  const box = sandbox();
  try {
    const env: Record<string, string> = {
      PATH: `${box.bin}:/usr/bin:/bin`, HOME: box.home, CLAUDE_CONFIG_DIR: join(box.home, ".claude"),
      CLAUDE_PEERS_DRAIN_MCP_PID: "999999", CLAUDE_PEERS_DRAIN_CLAUDE_PID: "999999",
    };
    if (optOut !== null) env.CLAUDE_PEERS_SESSION_HOOKS_ENABLED = optOut;
    const proc = Bun.spawn(["bash", new URL(`../hooks/${hook}`, import.meta.url).pathname], {
      env, stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1" })),
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { code, stdout, calls: existsSync(box.calls) ? readFileSync(box.calls, "utf8") : "" };
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
}

describe("CLAUDE_PEERS_SESSION_HOOKS_ENABLED opt-out", () => {
  for (const hook of HOOKS) {
    for (const value of ["false", "0", "off", "no"]) {
      test(`${hook} with ${value}: exits 0 and touches nothing`, async () => {
        const run = await runHook(hook, value);
        expect(run.code).toBe(0);
        expect(run.stdout).toBe("");
        expect(run.calls).toBe("");
      });
    }

    test(`${hook} by default still runs (the opt-out is not the default)`, async () => {
      for (const value of [null, "true", ""]) {
        const run = await runHook(hook, value);
        expect(run.calls).not.toBe("");
      }
    }, 60_000);   // the greeting hook's normal path walks processes and waits briefly for registration
  }
});
