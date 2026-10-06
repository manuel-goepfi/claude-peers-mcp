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

describe("survives a minimal environment", () => {
  test("runs with only PATH set — no HOME", () => {
    // Regression: the first cut of this wrapper did LOG_DIR="${CODEX_HOME:-$HOME/.codex}/logs"
    // under `set -u`. Codex (and tests/hook-wrapper.test.ts) can invoke a hook
    // with PATH and nothing else, where a bare $HOME is an unbound-variable
    // fatal — the wrapper died before reaching the .ts AND wrote to stderr,
    // which is exactly what a fail-open hook must never do.
    const root = mkdtempSync(join(tmpdir(), "codex-drain-minenv-"));
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "hooks", "codex-drain-peer-inbox.ts"), `console.log("{}");\n`);
    const proc = Bun.spawnSync(["bash", WRAPPER], {
      env: { PATH: process.env.PATH ?? "", CLAUDE_PEERS_ROOT: root },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(new TextDecoder().decode(proc.stderr)).toBe("");
    expect(new TextDecoder().decode(proc.stdout).trim()).toBe("{}");
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

/**
 * PostToolUse throttle (2026-10-06): every Codex tool call started bash + bun,
 * ~14% of all host process launches. A thread now drains on PostToolUse at most
 * once per CLAUDE_PEERS_CODEX_POSTTOOL_MIN_INTERVAL_SECONDS; turn boundaries are
 * never throttled.
 */
describe("PostToolUse drain throttle", () => {
  const COUNTER_STUB = (counter: string) =>
    `const t = await Bun.stdin.text();\n` +
    `require("node:fs").appendFileSync(${JSON.stringify(counter)}, JSON.stringify(t) + "\\n");\n` +
    `console.log("{}");\n`;

  function setup() {
    const root = mkdtempSync(join(tmpdir(), "codex-drain-throttle-"));
    mkdirSync(join(root, "hooks"), { recursive: true });
    const counter = join(root, "calls.log");
    writeFileSync(join(root, "hooks", "codex-drain-peer-inbox.ts"), COUNTER_STUB(counter));
    return { root, counter, stamps: join(root, "stamps") };
  }
  function fire(s: ReturnType<typeof setup>, event: string, payload: string, interval = "15") {
    return Bun.spawnSync(["bash", WRAPPER], {
      env: {
        ...process.env,
        CLAUDE_PEERS_ROOT: s.root,
        CODEX_HOME: join(s.root, "codexhome"),
        CLAUDE_PEERS_HOOK_EVENT_NAME: event,
        CLAUDE_PEERS_DRAIN_THROTTLE_DIR: s.stamps,
        CLAUDE_PEERS_CODEX_POSTTOOL_MIN_INTERVAL_SECONDS: interval,
      },
      stdin: new TextEncoder().encode(payload),
      stdout: "pipe",
      stderr: "pipe",
    });
  }
  const calls = (s: ReturnType<typeof setup>) =>
    existsSync(s.counter) ? readFileSync(s.counter, "utf8").trim().split("\n").filter(Boolean) : [];
  const P = (sid: string) => JSON.stringify({ session_id: sid, hook_event_name: "PostToolUse" });

  test("a second PostToolUse in the same thread within the window does not start bun", () => {
    const s = setup();
    expect(fire(s, "PostToolUse", P("thread-a")).exitCode).toBe(0);
    expect(fire(s, "PostToolUse", P("thread-a")).exitCode).toBe(0);
    expect(calls(s).length).toBe(1);
  });

  test("the .ts still receives the exact hook payload on stdin", () => {
    const s = setup();
    fire(s, "PostToolUse", P("thread-a"));
    expect(JSON.parse(JSON.parse(calls(s)[0] ?? "\"{}\"").trim()).session_id).toBe("thread-a");
  });

  test("threads are throttled independently", () => {
    const s = setup();
    fire(s, "PostToolUse", P("thread-a"));
    fire(s, "PostToolUse", P("thread-b"));
    expect(calls(s).length).toBe(2);
  });

  test("Stop and UserPromptSubmit are never throttled", () => {
    const s = setup();
    fire(s, "PostToolUse", P("thread-a"));
    fire(s, "Stop", P("thread-a"));
    fire(s, "UserPromptSubmit", P("thread-a"));
    fire(s, "Stop", P("thread-a"));
    expect(calls(s).length).toBe(4);
  });

  test("an interval of 0 disables the throttle", () => {
    const s = setup();
    fire(s, "PostToolUse", P("thread-a"), "0");
    fire(s, "PostToolUse", P("thread-a"), "0");
    expect(calls(s).length).toBe(2);
  });

  test("a payload without session_id is never throttled", () => {
    const s = setup();
    fire(s, "PostToolUse", "{}");
    fire(s, "PostToolUse", "{}");
    expect(calls(s).length).toBe(2);
  });

  test("an expired stamp lets the next PostToolUse drain", () => {
    const s = setup();
    fire(s, "PostToolUse", P("thread-a"));
    writeFileSync(join(s.stamps, "thread-a"), "1\n");
    fire(s, "PostToolUse", P("thread-a"));
    expect(calls(s).length).toBe(2);
  });
});
