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
  const proc = Bun.spawn(["bash", join(f.live, "bin", "deploy-live"), "--remote", "pub", ...args], {
    env: {
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

describe("bin/deploy-live", () => {
  test("a hook-only change fast-forwards without restarting the broker", async () => {
    const f = fixture();
    const sha = publish(f.writer, { "hooks/drain.sh": "v2\n" }, "hook");
    const r = await run(f, "http://127.0.0.1:9/health");
    expect(r.code).toBe(0);
    expect(git(f.live, "rev-parse", "HEAD")).toBe(sha);
    expect(r.stdout).toContain("broker restart: no");
    expect(calls(f)).not.toContain("restart");
    expect(readFileSync(f.log, "utf8")).toContain("broker_restart=0 status=ok");
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
