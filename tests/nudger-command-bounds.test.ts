import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { boundedCommand, withCommandBudget } from "../shared/bounded-command.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a stalled process snapshot returns failure before the watchdog window", () => {
  const root = mkdtempSync(join(tmpdir(), "nudger-stalled-command-"));
  try {
    const ps = join(root, "ps");
    writeFileSync(ps, "#!/bin/sh\nexec /bin/sleep 30\n");
    chmodSync(ps, 0o700);
    const module = new URL("../bin/codex-autodrain-poller.ts", import.meta.url).pathname;
    const result = Bun.spawnSync(["timeout", "--kill-after=1s", "4s", process.execPath, "-e",
      `import { takeSnapshot } from ${JSON.stringify(module)}; console.log(takeSnapshot() === null);`], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, HOME: root },
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("true");
    expect(result.stderr.toString()).toContain("command_timeout");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 7000);

test("an exhausted shared budget prevents subsequent commands from launching", () => {
  const root = mkdtempSync(join(tmpdir(), "nudger-command-budget-"));
  const marker = join(root, "must-not-exist");
  try {
    const start = Date.now();
    withCommandBudget(80, () => {
      expect(boundedCommand(["/bin/sleep", "30"], { operation: "test-budget" }).ok).toBe(false);
      expect(withCommandBudget(5000, () => boundedCommand(["touch", marker], { operation: "test-after-expiry" })).ok).toBe(false);
    });
    expect(Date.now() - start).toBeLessThan(2000);
    expect(existsSync(marker)).toBe(false);
    expect(boundedCommand(["/bin/echo", "recovered"], { operation: "test-new-cycle" })).toEqual({ok: true, out: "recovered\n"});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reconciliation bounds all stalled TTY fallbacks together and permits the next cycle", () => {
  const root = mkdtempSync(join(tmpdir(), "nudger-stalled-tty-"));
  try {
    const ps = join(root, "ps");
    writeFileSync(ps, "#!/bin/sh\nprintf 'probe\\n' >> \"$HOME/tty-probes\"\nexec /bin/sleep 30\n");
    chmodSync(ps, 0o700);
    const module = new URL("../bin/codex-autodrain-poller.ts", import.meta.url).pathname;
    const script = `
      import { readFileSync, writeFileSync } from "node:fs";
      import { reconcileVisibleCodexSeats, visibleCodexSeatsFromSnapshot } from ${JSON.stringify(module)};
      const root = process.env.HOME;
      const pids = [2000000000, 2000000001, 2000000002, 2000000003];
      const snap = {
        procs: pids.map(pid => ({ pid, ppid: 1, args: "codex resume" })),
        paneByPid: new Map(pids.map(pid => ["%" + pid, pid])),
        paneMap: new Map(pids.map(pid => [pid, { session: "fixture", pane_id: "%" + pid }])),
      };
      let collected = [];
      const deps = {
        enabled: true, dryRun: false, intervalMs: 0,
        visibleSeats: snapshot => {
          // Real collector and ttyOfPid: nonexistent PIDs force the ps fallback.
          collected = visibleCodexSeatsFromSnapshot(snapshot, {
            environOf: pid => ({ CLAUDE_PEER_NAME: "fixture-" + pid, TMUX_PANE: "%" + pid, PWD: root }),
          });
          return collected;
        },
        boundIdentityForSeat: () => ({ kind: "ambiguous" }),
        postBroker: () => { throw new Error("unexpected broker request"); },
        publishBrokerIdentityToTmux: () => { throw new Error("unexpected tmux write"); },
      };
      const count = () => readFileSync(root + "/tty-probes", "utf8").trim().split("\\n").length;
      const started = Date.now();
      await reconcileVisibleCodexSeats(snap, deps);
      const stalledMs = Date.now() - started;
      const stalledProbes = count();
      const stalledSeats = collected.length;
      const missingTtys = collected.every(seat => seat.tty === null);
      writeFileSync(root + "/ps", ${JSON.stringify("#!/bin/sh\nprintf 'probe\\n' >> \"$HOME/tty-probes\"\nprintf '?\\n'\n")});
      const recovered = Date.now();
      await reconcileVisibleCodexSeats(snap, deps);
      console.log(JSON.stringify({ stalledMs, stalledProbes, stalledSeats, missingTtys,
        recoveredMs: Date.now() - recovered, recoveredProbes: count() - stalledProbes, recoveredSeats: collected.length }));
    `;
    const result = Bun.spawnSync(["timeout", "--kill-after=1s", "8s", process.execPath, "-e", script], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, HOME: root },
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const observed = JSON.parse(result.stdout.toString());
    expect(observed.stalledMs).toBeLessThan(4000);
    expect(observed.stalledProbes).toBeGreaterThan(0);
    expect(observed.stalledProbes).toBeLessThan(4);
    expect(observed.stalledSeats).toBe(4);
    expect(observed.missingTtys).toBe(true);
    expect(observed.recoveredMs).toBeLessThan(2000);
    expect(observed.recoveredProbes).toBe(4);
    expect(observed.recoveredSeats).toBe(4);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 11000);
