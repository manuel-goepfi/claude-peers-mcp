/**
 * The Codex drain wrapper must FAIL OPEN, and it must leave a trace when it fails.
 *
 * Why this file exists (measured 2026-08-03):
 *
 * hooks/codex-drain-peer-inbox.sh did a bare `exec bun "$SCRIPT"`, so the .ts's
 * exitCode=1 propagated straight to Codex. But exitCode=1 is ALSO how the .ts
 * reports the benign "peer not resolvable yet" case, which produced two failures
 * at once:
 *
 *   1. Codex rendered a red `hook exited with code 1` on SessionStart and Stop
 *      for an entirely expected condition.
 *   2. The wrapper wrote no log, so the Stop path failed SILENTLY. Its sibling
 *      ~/.codex/hooks/drain-peer-inbox.sh — which does log — had accumulated 553
 *      `drain-failed rc=1` entries, 541 immediately preceded by "no codex
 *      ancestor found". None of that was visible from the Stop side.
 *
 * The silence was the expensive half. A drain that fails loudly gets fixed; a
 * drain that fails invisibly leaves 12 codex lanes that have never once drained.
 *
 * These tests drive the wrapper with a STUB .ts via CLAUDE_PEERS_ROOT, so they
 * assert the wrapper's error contract without a broker, a pane, or real mail.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WRAPPER = new URL("../hooks/codex-drain-peer-inbox.sh", import.meta.url).pathname;

/** Run the wrapper against a stub .ts whose body we control. */
function runWrapper(
  stubBody: string | null,
  event = "Stop",
): { exitCode: number; stdout: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), "codex-drain-wrapper-"));
  const codexHome = join(root, "codexhome");
  if (stubBody !== null) {
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "hooks", "codex-drain-peer-inbox.ts"), stubBody);
  }
  const proc = Bun.spawnSync(["bash", WRAPPER], {
    env: {
      ...process.env,
      CLAUDE_PEERS_ROOT: root,
      CODEX_HOME: codexHome,
      CLAUDE_PEERS_HOOK_EVENT_NAME: event,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const logPath = join(codexHome, "logs", "drain-peer-inbox.log");
  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    log: existsSync(logPath) ? readFileSync(logPath, "utf8") : "",
  };
}

describe("codex drain wrapper fails open", () => {
  test("a .ts exiting 1 must NOT surface as a hook failure to Codex", () => {
    // The regression this file exists for. exitCode=1 is the .ts's signal for
    // "peer not resolvable yet" — an expected condition, not a hook error.
    const r = runWrapper("process.exitCode = 1;\n");
    expect(r.exitCode).toBe(0);
  });

  test("a missing .ts must not fail the turn either", () => {
    const r = runWrapper(null);
    expect(r.exitCode).toBe(0);
    expect(r.log).toContain("missing-script");
  });

  test("a .ts that THROWS must not fail the turn", () => {
    const r = runWrapper("throw new Error('boom');\n");
    expect(r.exitCode).toBe(0);
  });
});

describe("failures leave a trace — the silence is the bug", () => {
  test("a failed drain is logged, not swallowed", () => {
    const r = runWrapper("process.exitCode = 1;\n");
    expect(r.log).toContain("drain-failed");
  });

  test("the log names the EVENT, so Stop is distinguishable from UserPromptSubmit", () => {
    // Without this the Stop path is indistinguishable from its sibling in a
    // shared log, which is how 553 failures stayed unattributed.
    expect(runWrapper("process.exitCode = 1;\n", "Stop").log).toContain("[Stop]");
    expect(runWrapper("process.exitCode = 1;\n", "UserPromptSubmit").log).toContain("[UserPromptSubmit]");
  });

  test("a SUCCESSFUL drain writes no failure line", () => {
    const r = runWrapper("console.log('{}');\n");
    expect(r.log).not.toContain("drain-failed");
  });
});

describe("stdout discipline — Codex must never see a partial payload", () => {
  test("stdout is forwarded verbatim on success", () => {
    const r = runWrapper(`console.log(JSON.stringify({hookSpecificOutput:{ok:true}}));\n`);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { ok: true } });
  });

  test("stdout is SUPPRESSED when the .ts fails, even if it printed first", () => {
    // A hook emitting malformed/partial JSON is worse than one emitting nothing:
    // Codex parses stdout, so a half-written payload is a parse error on the
    // client. Suppression is why the wrapper buffers to a temp file.
    const r = runWrapper(`console.log('{"partial":');\nprocess.exitCode = 1;\n`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });
});
