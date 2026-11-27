import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../bin/deploy-live", import.meta.url).pathname;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

function commit(dir: string, files: Record<string, string>, message: string): string {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

/** A published repo, a writer clone that pushes to it, and a live clone with bin/deploy-live. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "claude-peers-deploy-"));
  roots.push(root);
  const pub = join(root, "pub.git");
  const writer = join(root, "writer");
  const live = join(root, "live");
  git(root, "init", "-q", "--bare", pub);
  git(root, "clone", "-q", pub, writer);
  commit(writer, { "broker.ts": "v1\n", "hooks/drain.sh": "v1\n", "README.md": "r\n" }, "init");
  git(writer, "push", "-q", "origin", "HEAD:main");
  git(root, "clone", "-q", "-o", "pub", "-b", "main", pub, live);
  mkdirSync(join(live, "bin"), { recursive: true });
  copyFileSync(SCRIPT, join(live, "bin", "deploy-live"));
  writeFileSync(join(live, ".git", "info", "exclude"), "bin/deploy-live\n");

  const calls = join(root, "systemctl.calls");
  const systemctl = join(root, "systemctl");
  writeFileSync(systemctl, `#!/usr/bin/env bash\necho "$*" >> ${JSON.stringify(calls)}\nexit 0\n`);
  chmodSync(systemctl, 0o755);
  return { root, writer, live, calls, systemctl, log: join(root, "deploys.log") };
}

function publish(writer: string, files: Record<string, string>, message: string): string {
  const sha = commit(writer, files, message);
  git(writer, "push", "-q", "origin", "HEAD:main");
  return sha;
}

async function run(f: ReturnType<typeof fixture>, healthUrl: string, ...args: string[]) {
  return runWith(f, healthUrl, {}, ...args);
}

async function runWith(f: ReturnType<typeof fixture>, healthUrl: string, extraEnv: Record<string, string>, ...args: string[]) {
  const proc = Bun.spawn(["bash", join(f.live, "bin", "deploy-live"), "--remote", "pub", ...args], {
    env: {
      ...extraEnv,
      PATH: process.env.PATH ?? "",
      HOME: f.root,
      CLAUDE_PEERS_DEPLOY_SYSTEMCTL: f.systemctl,
      CLAUDE_PEERS_DEPLOY_HEALTH_URL: healthUrl,
      CLAUDE_PEERS_DEPLOY_LOG: f.log,
      CLAUDE_PEERS_DEPLOY_READY_SECONDS: "2",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

function health(ready: boolean) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ status: ready ? "ok" : "starting", ready }) });
  return { url: `http://127.0.0.1:${server.port}/health`, stop: () => server.stop(true) };
}

const calls = (f: ReturnType<typeof fixture>) => (existsSync(f.calls) ? readFileSync(f.calls, "utf8") : "");

/** A systemctl stand-in whose nudger restart writes a fresh heartbeat, as the real poller does on its first tick. */
function heartbeatingSystemctl(f: ReturnType<typeof fixture>) {
  const heartbeat = join(f.root, ".claude-peers-autodrain.heartbeat");
  writeFileSync(f.systemctl, `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(f.calls)}
if [[ "$*" == "--user restart claude-peers-codex-autodrain.service" ]]; then date -u +%FT%TZ > ${JSON.stringify(heartbeat)}; fi
exit 0
`);
  return heartbeat;
}

describe("bin/deploy-live", () => {
  test("a hook-only change fast-forwards without restarting the broker", async () => {
    const f = fixture();
    const sha = publish(f.writer, { "hooks/drain.sh": "v2\n" }, "hook");
    const r = await run(f, "http://127.0.0.1:9/health");
    expect(r.code).toBe(0);
    expect(git(f.live, "rev-parse", "HEAD")).toBe(sha);
    expect(r.stdout).toContain("broker restart: no");
    expect(calls(f)).not.toContain("restart");
    expect(readFileSync(f.log, "utf8")).toContain("broker_restart=0 poller_restart=0 status=ok");
  });

  test("a broker change restarts the active unit and waits for ready", async () => {
    const f = fixture();
    const sha = publish(f.writer, { "broker.ts": "v2\n" }, "broker");
    const h = health(true);
    try {
      const r = await run(f, h.url);
      expect(r.code).toBe(0);
      expect(git(f.live, "rev-parse", "HEAD")).toBe(sha);
      expect(calls(f)).toContain("--user restart claude-peers-broker.service");
    } finally {
      h.stop();
    }
  });

  test("a broker that never reports ready is returned to the old commit", async () => {
    const f = fixture();
    const old = git(f.live, "rev-parse", "HEAD");
    publish(f.writer, { "broker.ts": "v2\n" }, "broker");
    const h = health(false);
    try {
      const r = await run(f, h.url);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("returned to");
      expect(git(f.live, "rev-parse", "HEAD")).toBe(old);
      expect(calls(f).match(/restart/g)?.length).toBe(2);
      expect(readFileSync(f.log, "utf8")).toContain("status=rolled-back");
    } finally {
      h.stop();
    }
  });

  test("a poller change restarts the nudger and waits for its heartbeat", async () => {
    const f = fixture();
    heartbeatingSystemctl(f);
    const sha = publish(f.writer, { "bin/codex-autodrain-poller.ts": "v2\n" }, "poller");
    const r = await run(f, "http://127.0.0.1:9/health");
    expect(r.code).toBe(0);
    expect(git(f.live, "rev-parse", "HEAD")).toBe(sha);
    expect(r.stdout).toContain("nudger restart: yes");
    expect(r.stdout).toContain("broker restart: no");
    expect(calls(f)).toContain("--user restart claude-peers-codex-autodrain.service");
    expect(calls(f)).not.toContain("restart claude-peers-broker.service");
    expect(readFileSync(f.log, "utf8")).toContain("broker_restart=0 poller_restart=1 status=ok");
  });

  test("a shared/ change restarts both the broker and the nudger", async () => {
    const f = fixture();
    heartbeatingSystemctl(f);
    publish(f.writer, { "shared/tmux.ts": "v2\n" }, "shared");
    const h = health(true);
    try {
      const r = await run(f, h.url);
      expect(r.code).toBe(0);
      const order = calls(f).split("\n").filter((l) => l.includes("restart"));
      expect(order).toEqual([
        "--user restart claude-peers-broker.service",
        "--user restart claude-peers-codex-autodrain.service",
      ]);
    } finally {
      h.stop();
    }
  });

  test("a nudger that never writes a heartbeat is returned to the old commit", async () => {
    const f = fixture();
    const old = git(f.live, "rev-parse", "HEAD");
    publish(f.writer, { "bin/codex-autodrain-poller.ts": "v2\n" }, "poller");
    const r = await run(f, "http://127.0.0.1:9/health");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("returned to");
    expect(git(f.live, "rev-parse", "HEAD")).toBe(old);
    expect(calls(f).match(/restart claude-peers-codex-autodrain/g)?.length).toBe(2);
    expect(readFileSync(f.log, "utf8")).toContain("poller_restart=1 status=rolled-back");
  });

  test("a nudger stuck mid-tick is still restarted after the idle bound", async () => {
    const f = fixture();
    const heartbeat = heartbeatingSystemctl(f);
    writeFileSync(`${heartbeat}.stage`, JSON.stringify({ stage: "nudge", started_at: "x", elapsed_ms: 1 }));
    publish(f.writer, { "bin/codex-autodrain-poller.ts": "v2\n" }, "poller");
    const r = await runWith(f, "http://127.0.0.1:9/health", { CLAUDE_PEERS_DEPLOY_POLLER_IDLE_SECONDS: "1" });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("nudger still busy after 1s");
    expect(calls(f)).toContain("--user restart claude-peers-codex-autodrain.service");
  });

  test("a dirty live clone is refused and an identical hand edit is named", async () => {
    const f = fixture();
    const old = git(f.live, "rev-parse", "HEAD");
    publish(f.writer, { "hooks/drain.sh": "v2\n" }, "hook");
    writeFileSync(join(f.live, "hooks/drain.sh"), "v2\n");
    const r = await run(f, "http://127.0.0.1:9/health");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("refusing: the live clone has local changes");
    expect(r.stderr).toContain("hooks/drain.sh  (identical to pub/main");
    expect(git(f.live, "rev-parse", "HEAD")).toBe(old);
  });

  test("a non-fast-forward target is refused", async () => {
    const f = fixture();
    commit(f.live, { "broker.ts": "local\n" }, "local-only");
    const local = git(f.live, "rev-parse", "HEAD");
    publish(f.writer, { "hooks/drain.sh": "v2\n" }, "hook");
    const r = await run(f, "http://127.0.0.1:9/health");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not a fast-forward");
    expect(git(f.live, "rev-parse", "HEAD")).toBe(local);
  });

  test("a branch other than main is refused", async () => {
    const f = fixture();
    git(f.live, "checkout", "-q", "-b", "fix/something");
    const r = await run(f, "http://127.0.0.1:9/health");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("the live clone tracks main only");
  });

  test("a dry run reports the plan and changes nothing", async () => {
    const f = fixture();
    const old = git(f.live, "rev-parse", "HEAD");
    publish(f.writer, { "broker.ts": "v2\n" }, "broker");
    const r = await run(f, "http://127.0.0.1:9/health", "--dry-run");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("broker restart: yes");
    expect(r.stdout).toContain("rollback:");
    expect(r.stdout).toContain("dry run, nothing changed");
    expect(git(f.live, "rev-parse", "HEAD")).toBe(old);
    expect(calls(f)).not.toContain("restart");
  });

  test("an up-to-date clone is a no-op", async () => {
    const f = fixture();
    const r = await run(f, "http://127.0.0.1:9/health");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("already at pub/main");
  });
});
