import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestBroker, type TestBroker } from "./helpers/test-broker.ts";

const FIXTURE = new URL("./fixtures/codex-pane-bind-client.ts", import.meta.url).pathname;
const THREAD_A = "01a003f0-20ec-7ae2-aba4-6c526ab304e9";
const THREAD_B = "01a003f0-20ec-7ae2-aba4-6c526ab304ea";
const canUseTmux = Bun.spawnSync(["tmux", "list-sessions"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

interface FixtureState {
  broker: TestBroker;
  root: string;
  session: string;
}

const states: FixtureState[] = [];

afterEach(async () => {
  while (states.length > 0) {
    const state = states.pop()!;
    Bun.spawnSync(["tmux", "kill-session", "-t", state.session], { stdout: "ignore", stderr: "ignore" });
    await state.broker.stop();
    rmSync(state.root, { recursive: true, force: true });
  }
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${path}`);
}

(canUseTmux ? describe : describe.skip)("Codex pane/thread relay binding", () => {
  test("upserts a pane seat, folds a thread-only row, and is idempotent", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-codex-bind-"));
    const broker = await startTestBroker({ prefix: "codex-pane-bind" });
    const session = `cp-codex-bind-${process.pid}-${Date.now()}`;
    states.push({ broker, root, session });

    const holder = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    try {
      const registered = await fetch(`${broker.url}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pid: holder.pid,
          cwd: root,
          git_root: null,
          absolute_git_dir: null,
          tty: null,
          name: "thread-only",
          tmux_session: null,
          tmux_window_index: null,
          tmux_window_name: null,
          tmux_pane_id: null,
          thread_id: THREAD_A,
          client_type: "codex",
          receiver_mode: "codex-hook",
          summary: "",
        }),
      });
      expect(registered.status).toBe(200);

      const codexBinary = join(root, "codex");
      copyFileSync("/usr/bin/sleep", codexBinary);
      chmodSync(codexBinary, 0o755);
      const resultPath = join(root, "bind-results.json");
      const mainConflictPath = join(root, "bind-main-conflict.json");
      const mainConflictTrigger = join(root, "bind-main-conflict.trigger");
      // Deliberately give the native process a different /proc cwd. Production
      // broker hardening cannot read that magic link; binding must use the
      // tmux-proven pane path instead.
      const command = `(cd /; exec "${codexBinary}" 60) & tui=$!; bun "${FIXTURE}" "${broker.port}" "${resultPath}" "${THREAD_A}" "${THREAD_B}" "${THREAD_A}"; while [ ! -f "${mainConflictTrigger}" ]; do sleep 0.05; done; bun "${FIXTURE}" "${broker.port}" "${mainConflictPath}" "${THREAD_B}"; wait "$tui"`;
      const created = Bun.spawnSync([
        "tmux", "new-session", "-d", "-s", session, "-n", "bind", "-c", root,
        "bash", "-c", command,
      ], { stdout: "pipe", stderr: "pipe" });
      expect(created.exitCode).toBe(0);
      const paneId = new TextDecoder().decode(Bun.spawnSync([
        "tmux", "list-panes", "-t", session, "-F", "#{pane_id}",
      ]).stdout).trim();
      expect(paneId).toMatch(/^%\d+$/);
      expect(Bun.spawnSync([
        "tmux", "set-option", "-p", "-t", paneId, "@operator_label", "bind.test",
      ]).exitCode).toBe(0);

      await waitForFile(resultPath);
      const results = JSON.parse(readFileSync(resultPath, "utf8")) as Array<{
        status: number;
        body: Record<string, unknown>;
      }>;
      expect(results.map((result) => result.status)).toEqual([200, 200, 200]);
      expect(results[0]!.body.thread_id).toBe(THREAD_A);
      expect(results[0]!.body.folded).toBe(1);
      expect(results[2]!.body.id).toBe(results[0]!.body.id);
      const panePeerId = String(results[0]!.body.id);
      const mirrored = new TextDecoder().decode(Bun.spawnSync([
        "tmux", "display-message", "-p", "-t", paneId,
        "#{@peer_id}\t#{@peer_label}\t#{@peer_resolved_name}\t#{@peer_client_type}\t#{@peer_receiver_mode}\t#{@operator_label}",
      ]).stdout).trim().split("\t");
      expect(mirrored).toEqual([
        String(results[0]!.body.id),
        "bind.test",
        "bind.test",
        "codex",
        "manual-drain",
        "bind.test",
      ]);

      const db = new Database(broker.dbPath, { readonly: true });
      const rows = db.query(
        "SELECT pid, cwd, name, client_type, tmux_pane_id, thread_id FROM peers ORDER BY id",
      ).all() as Array<{
        pid: number;
        cwd: string;
        name: string | null;
        client_type: string;
        tmux_pane_id: string | null;
        thread_id: string | null;
      }>;
      db.close();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        cwd: root,
        name: "bind.test",
        client_type: "codex",
        tmux_pane_id: paneId,
        thread_id: THREAD_A,
      });
      const tuiPid = rows[0]!.pid;
      expect(tuiPid).not.toBe(holder.pid);

      // Reversed production ordering: the relay may bind before SessionStart
      // reaches the shared app-server hook. The later headless registration
      // must adopt the exact pane-bound thread, not mint a second live row.
      const hookAfterBind = await fetch(`${broker.url}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pid: holder.pid,
          cwd: root,
          git_root: null,
          absolute_git_dir: null,
          tty: null,
          name: `codex-t${THREAD_A.slice(-8)}`,
          tmux_session: null,
          tmux_window_index: null,
          tmux_window_name: null,
          tmux_pane_id: null,
          thread_id: THREAD_A.toUpperCase(),
          client_type: "codex",
          receiver_mode: "codex-hook",
          preserve_token: true,
          summary: "",
        }),
      });
      expect(hookAfterBind.status).toBe(200);
      const hookRegistration = await hookAfterBind.json() as {
        id: string;
        name: string | null;
        receiver_mode: string;
      };
      expect(hookRegistration).toMatchObject({
        id: results[0]!.body.id,
        name: "bind.test",
        receiver_mode: "manual-drain",
      });
      const hookHeartbeat = await fetch(`${broker.url}/hook-heartbeat-by-thread`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread_id: THREAD_A,
          caller_pid: process.pid,
          client_type: "codex",
          receiver_mode: "codex-hook",
          status: "ok",
          drained: 0,
        }),
      });
      expect(hookHeartbeat.status).toBe(200);

      // An adapter that cached the relay's initial manual-drain proof must not
      // downgrade a later hook capability when it claims by exact thread.
      const staleAdapterClaim = await fetch(`${broker.url}/claim-by-thread`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread_id: THREAD_A,
          caller_pid: holder.pid,
          client_type: "codex",
          receiver_mode: "manual-drain",
          drain_id: "stale-adapter-proof",
        }),
      });
      expect(staleAdapterClaim.status).toBe(200);

      const afterHookDb = new Database(broker.dbPath, { readonly: true });
      const afterHookRows = afterHookDb.query(
        "SELECT id, pid, name, tmux_pane_id, lower(thread_id) AS thread_id, receiver_mode, seat_pids FROM peers WHERE lower(thread_id) = ?",
      ).all(THREAD_A) as Array<{
        id: string;
        pid: number;
        name: string | null;
        tmux_pane_id: string | null;
        thread_id: string;
        receiver_mode: string;
        seat_pids: string;
      }>;
      afterHookDb.close();
      expect(afterHookRows).toHaveLength(1);
      expect(afterHookRows[0]).toMatchObject({
        id: results[0]!.body.id,
        pid: tuiPid,
        name: "bind.test",
        tmux_pane_id: paneId,
        thread_id: THREAD_A,
        receiver_mode: "codex-hook",
      });
      expect(JSON.parse(afterHookRows[0]!.seat_pids)).toContain(tuiPid);
      expect(JSON.parse(afterHookRows[0]!.seat_pids)).not.toContain(holder.pid);

      const seededDb = new Database(broker.dbPath);
      seededDb.run(
        "INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?, ?, ?, ?, 0)",
        ["review-sender", panePeerId, "preserve through rejected bind", new Date().toISOString()],
      );
      seededDb.run("UPDATE peers SET unread_episode = 7 WHERE id = ?", [panePeerId]);
      seededDb.close();

      const exactIdentity = await fetch(`${broker.url}/identity-by-thread`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: THREAD_A, caller_pid: holder.pid }),
      });
      expect(exactIdentity.status).toBe(200);

      const conflictPath = join(root, "bind-conflict.json");
      const conflictRetryPath = join(root, "bind-conflict-retry.json");
      const conflictRetryTrigger = join(root, "bind-conflict-retry.trigger");
      const shimDir = join(root, "node-shim");
      const shimCodex = join(shimDir, "codex");
      mkdirSync(shimDir);
      await Bun.write(shimCodex, "setInterval(() => {}, 60_000);\n");
      const conflictCommand = `node "${shimCodex}" --remote unix:///tmp/relay.sock --cd "${root}" resume "${THREAD_A}" & tui=$!; bun "${FIXTURE}" "${broker.port}" "${conflictPath}" "${THREAD_A}" "${THREAD_B}"; while [ ! -f "${conflictRetryTrigger}" ]; do sleep 0.05; done; bun "${FIXTURE}" "${broker.port}" "${conflictRetryPath}" "${THREAD_A}"; wait "$tui"`;
      const conflictWindow = Bun.spawnSync([
        "tmux", "new-window", "-d", "-t", session, "-n", "conflict", "-c", root,
        "bash", "-c", conflictCommand,
      ], { stdout: "pipe", stderr: "pipe" });
      expect(conflictWindow.exitCode).toBe(0);
      const conflictPaneId = new TextDecoder().decode(Bun.spawnSync([
        "tmux", "list-panes", "-t", `${session}:conflict`, "-F", "#{pane_id}",
      ]).stdout).trim();
      expect(conflictPaneId).toMatch(/^%\d+$/);
      await waitForFile(conflictPath);
      const conflictResults = JSON.parse(readFileSync(conflictPath, "utf8")) as Array<{
        status: number;
        body: Record<string, unknown>;
      }>;
      expect(conflictResults).toHaveLength(2);
      expect(conflictResults.map((result) => result.status)).toEqual([409, 200]);
      expect(conflictResults[0]!.body.error).toBe("thread is already bound to another live pane");
      expect(conflictResults[1]!.body.thread_id).toBe(THREAD_B);

      await Bun.write(mainConflictTrigger, "bind\n");
      await waitForFile(mainConflictPath);
      const mainConflictResults = JSON.parse(readFileSync(mainConflictPath, "utf8")) as Array<{
        status: number;
        body: Record<string, unknown>;
      }>;
      expect(mainConflictResults).toHaveLength(1);
      expect(mainConflictResults[0]!.status).toBe(409);
      expect(mainConflictResults[0]!.body.error).toBe("thread is already bound to another live pane");

      const preservedDb = new Database(broker.dbPath, { readonly: true });
      const preserved = preservedDb.query(`
        SELECT lower(thread_id) AS thread_id, unread_episode,
               (SELECT COUNT(*) FROM messages WHERE to_id = peers.id AND delivered = 0) AS queued
        FROM peers WHERE id = ?
      `).get(panePeerId) as { thread_id: string; unread_episode: number; queued: number };
      preservedDb.close();
      expect(preserved).toEqual({ thread_id: THREAD_A, unread_episode: 7, queued: 1 });

      const outside = await fetch(`${broker.url}/bind-codex-pane-thread`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caller_pid: process.pid,
          tmux_pane_id: paneId,
          thread_id: THREAD_A,
        }),
      });
      expect(outside.status).toBe(403);

      // A live shared app-server must not keep a departed pane identity alive.
      // Once the native TUI exits, exact identity becomes absent (404), ready
      // for a resumed pane to bind and for the existing adapter to migrate.
      process.kill(tuiPid, "SIGTERM");
      const deathDeadline = Date.now() + 2_000;
      while (Date.now() < deathDeadline) {
        try {
          process.kill(tuiPid, 0);
          await Bun.sleep(25);
        } catch {
          break;
        }
      }
      const afterTuiExit = await fetch(`${broker.url}/identity-by-thread`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: THREAD_A, caller_pid: holder.pid }),
      });
      expect(afterTuiExit.status).toBe(404);

      await Bun.write(conflictRetryTrigger, "retry\n");
      await waitForFile(conflictRetryPath);
      const retryResults = JSON.parse(readFileSync(conflictRetryPath, "utf8")) as Array<{
        status: number;
        body: Record<string, unknown>;
      }>;
      expect(retryResults).toHaveLength(1);
      expect(retryResults[0]!.status).toBe(200);
      expect(retryResults[0]!.body.thread_id).toBe(THREAD_A);

      const reboundDb = new Database(broker.dbPath, { readonly: true });
      const reboundRows = reboundDb.query(
        "SELECT tmux_pane_id, lower(thread_id) AS thread_id FROM peers WHERE lower(thread_id) = ?",
      ).all(THREAD_A) as Array<{ tmux_pane_id: string | null; thread_id: string }>;
      reboundDb.close();
      expect(reboundRows).toEqual([{ tmux_pane_id: conflictPaneId, thread_id: THREAD_A }]);
    } finally {
      holder.kill();
      await holder.exited;
    }
  }, 20_000);
});
