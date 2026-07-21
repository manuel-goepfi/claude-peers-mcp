/**
 * Watchdog opt-in gate (bin/ensure-codex-autodrain) — the block that decides
 * whether the poller may start at all runs BEFORE any tmux call, so it is
 * testable hermetically:
 *   - env unset  → config file consulted (single-source opt-in)
 *   - env SET    → wins outright, including set-but-EMPTY = explicit OFF
 *   - both paths whitespace-normalized before the allowlist (grep anchors
 *     bind per-line, so a raw newline would smuggle text past ^...$)
 *   - invalid value → refuse to start (exit 1) + log
 *   - resolved OFF + a running poller → kill-on-disable (idempotent controller)
 *
 * Isolation: _AUTODRAIN_LOCKED=1 skips the flock self-re-exec (no contention
 * with the real cron watchdog), a PATH shim stubs pgrep/pkill (so tests never
 * see or signal the REAL poller), and TMUX_TMPDIR points at an empty dir so
 * the tmux socket never resolves — a gate-passing run stops at the tmux check
 * instead of spawning anything. "Gate passed" is observed via the heartbeat
 * file: the script rm -f's it just before the tmux check, so seeded-heartbeat
 * removed ⇔ validation passed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../bin/ensure-codex-autodrain", import.meta.url).pathname;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface RunOpts {
  env?: Record<string, string>;      // extra env (e.g. NUDGE_CLIENTS)
  file?: string | null;              // nudge-clients file content (null = absent)
  pollerRunning?: boolean;           // pgrep stub reports a live poller
}

async function runWatchdog(opts: RunOpts = {}) {
  const root = mkdtempSync(join(tmpdir(), "autodrain-watchdog-"));
  roots.push(root);
  const shim = join(root, "shim");
  mkdirSync(shim);
  const pkillLog = join(root, "pkill.log");
  const pgrepExit = opts.pollerRunning ? 0 : 1;
  const pgrepOut = opts.pollerRunning ? "echo 99999" : ":";
  writeFileSync(join(shim, "pgrep"), `#!/bin/bash\n${pgrepOut}\nexit ${pgrepExit}\n`);
  writeFileSync(join(shim, "pkill"), `#!/bin/bash\necho "pkill $@" >> '${pkillLog}'\nexit 0\n`);
  chmodSync(join(shim, "pgrep"), 0o755);
  chmodSync(join(shim, "pkill"), 0o755);
  const nudgeFile = join(root, "nudge-clients");
  if (opts.file !== null && opts.file !== undefined) writeFileSync(nudgeFile, opts.file);
  const log = join(root, "watchdog.log");
  const heartbeat = join(root, "heartbeat");
  writeFileSync(heartbeat, "seed");
  const tmuxTmp = join(root, "tmux-empty");
  mkdirSync(tmuxTmp);
  const child = Bun.spawn(["bash", script], {
    env: {
      PATH: `${shim}:/usr/bin:/bin`,
      HOME: root,
      _AUTODRAIN_LOCKED: "1",
      NUDGE_CLIENTS_FILE: nudgeFile,
      AUTODRAIN_LOG: log,
      AUTODRAIN_HEARTBEAT: heartbeat,
      TMUX_TMPDIR: tmuxTmp,
      ...(opts.env ?? {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await child.exited;
  return {
    code,
    gatePassed: !existsSync(heartbeat), // rm -f fires only after validation
    log: existsSync(log) ? readFileSync(log, "utf8") : "",
    pkills: existsSync(pkillLog) ? readFileSync(pkillLog, "utf8") : "",
  };
}

describe("opt-in resolution: env unset → file is the single source", () => {
  test("absent file = off: exits 0 without touching anything", async () => {
    const r = await runWatchdog({ file: null });
    expect(r.code).toBe(0);
    expect(r.gatePassed).toBe(false);
  });
  test("whitespace-only file = off", async () => {
    const r = await runWatchdog({ file: " \n\t\n" });
    expect(r.code).toBe(0);
    expect(r.gatePassed).toBe(false);
  });
  test("valid file passes the gate (trailing newline tolerated)", async () => {
    const r = await runWatchdog({ file: "codex,claude\n" });
    expect(r.code).toBe(0); // stops at the unreachable-tmux check, after the gate
    expect(r.gatePassed).toBe(true);
  });
  test("injection attempt in the file refuses to start", async () => {
    const r = await runWatchdog({ file: "codex; rm -rf /\n" });
    expect(r.code).toBe(1);
    expect(r.gatePassed).toBe(false);
    expect(r.log).toContain("invalid NUDGE_CLIENTS");
  });
  test("leading comma is malformed, not tolerated (planted-error guard for the old '(|...)' regex)", async () => {
    const r = await runWatchdog({ file: ",codex" });
    expect(r.code).toBe(1);
    expect(r.log).toContain("invalid NUDGE_CLIENTS");
  });
});

describe("opt-in resolution: SET env wins over the file", () => {
  test("invalid env + valid file → refused (file must NOT rescue a bad env)", async () => {
    const r = await runWatchdog({ env: { NUDGE_CLIENTS: "bogus" }, file: "codex\n" });
    expect(r.code).toBe(1);
    expect(r.log).toContain("invalid NUDGE_CLIENTS");
  });
  test("set-but-EMPTY env is an explicit per-invocation OFF that a populated file cannot override", async () => {
    const r = await runWatchdog({ env: { NUDGE_CLIENTS: "" }, file: "codex,claude\n" });
    expect(r.code).toBe(0);
    expect(r.gatePassed).toBe(false);
  });
  test("valid env with no file passes the gate", async () => {
    const r = await runWatchdog({ env: { NUDGE_CLIENTS: "codex,claude" }, file: null });
    expect(r.code).toBe(0);
    expect(r.gatePassed).toBe(true);
  });
  test("embedded newline in a raw env value cannot smuggle text past the per-line grep anchors", async () => {
    const r = await runWatchdog({ env: { NUDGE_CLIENTS: "codex\nrm -rf /" }, file: null });
    expect(r.code).toBe(1);
    expect(r.log).toContain("invalid NUDGE_CLIENTS");
  });
});

describe("kill-on-disable: resolved OFF converges a running poller to stopped", () => {
  test("off + running poller → pkill fired + logged", async () => {
    const r = await runWatchdog({ file: null, pollerRunning: true });
    expect(r.code).toBe(0);
    expect(r.pkills).toContain("codex-autodrain-poller");
    expect(r.log).toContain("kill-on-disable");
  });
  test("off + no poller → silent no-op (no pkill, no log noise)", async () => {
    const r = await runWatchdog({ file: null, pollerRunning: false });
    expect(r.code).toBe(0);
    expect(r.pkills).toBe("");
    expect(r.log).not.toContain("kill-on-disable");
  });
});
