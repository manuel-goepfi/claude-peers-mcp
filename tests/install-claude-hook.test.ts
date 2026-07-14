import { describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyClientHooks, installClientHooks } from "../shared/hook-config.ts";
import { missingClaudeHookDependencies } from "../bin/install-claude-hook.ts";

const installer = new URL("../bin/install-claude-hook.ts", import.meta.url).pathname;
const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

async function run(repo: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", installer, repo, ...args], { env: { ...process.env, HOME: repo }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

describe("Claude hook installer", () => {
  test("reports missing runtime dependencies before an inert install", () => {
    expect(missingClaudeHookDependencies((command) => command === "bash" ? "/bin/bash" : null)).toEqual([
      "awk", "curl", "flock", "jq", "ps", "sed", "tail",
    ]);
  });

  test("merges registration hooks, then remains byte and mtime stable", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claude-peers-claude-install-"));
    try {
      const path = join(repo, ".claude", "settings.json");
      mkdirSync(join(repo, ".claude"), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ permissions: { allow: ["Read"] }, hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "existing.sh" }] }] } }, null, 2)}\n`, { mode: 0o600 });
      const first = await run(repo);
      expect(first.code).toBe(0);
      expect(first.stderr).toBe("");
      const firstBytes = readFileSync(path);
      const firstMtime = statSync(path).mtimeMs;
      const backupCount = readdirSync(join(repo, ".claude")).filter((name) => name.includes(".bak-")).length;
      await Bun.sleep(20);
      const second = await run(repo);
      expect(second.code).toBe(0);
      expect(readFileSync(path)).toEqual(firstBytes);
      expect(statSync(path).mtimeMs).toBe(firstMtime);
      expect(readdirSync(join(repo, ".claude")).filter((name) => name.includes(".bak-")).length).toBe(backupCount);

      const doc = JSON.parse(readFileSync(path, "utf8")) as {
        permissions: { allow: string[] };
        hooks: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string; async?: boolean; asyncRewake?: boolean; timeout?: number }> }>>;
      };
      expect(doc.permissions.allow).toEqual(["Read"]);
      const sessionBuckets = doc.hooks.SessionStart!;
      const session = sessionBuckets.flatMap((bucket) => bucket.hooks ?? []);
      expect(sessionBuckets[0]?.matcher).toBe("startup|resume");
      expect(session.filter((hook) => hook.command?.includes("claude-register-peer-session.sh"))).toHaveLength(1);
      const promptHooks = doc.hooks.UserPromptSubmit!.flatMap((bucket) => bucket.hooks ?? []);
      expect(promptHooks.filter((hook) => hook.command?.includes("claude-drain-peer-inbox.sh"))).toHaveLength(1);
      const stopHooks = doc.hooks.Stop!.flatMap((bucket) => bucket.hooks ?? []);
      const standby = stopHooks.find((hook) => hook.command?.includes("claude-standby-watcher.sh"));
      expect(standby).toMatchObject({ async: true, asyncRewake: true, timeout: 2_592_000 });
      expect(doc.hooks.PreToolUse![0]?.hooks?.[0]?.command).toBe("existing.sh");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("check is non-mutating and uninstall preserves unrelated configuration", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claude-peers-claude-check-"));
    try {
      const path = join(repo, ".claude", "settings.json");
      mkdirSync(join(repo, ".claude"), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ theme: "dark" }, null, 2)}\n`, { mode: 0o600 });
      const before = readFileSync(path);
      expect((await run(repo, "--check")).code).toBe(1);
      expect(readFileSync(path)).toEqual(before);
      expect((await run(repo)).code).toBe(0);
      expect((await run(repo, "--check")).code).toBe(0);
      expect((await run(repo, "--uninstall")).code).toBe(0);
      const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(doc.theme).toBe("dark");
      expect(doc.hooks).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("invalid JSON is never overwritten", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claude-peers-claude-bad-"));
    try {
      const path = join(repo, ".claude", "settings.json");
      mkdirSync(join(repo, ".claude"), { recursive: true });
      writeFileSync(path, "{bad", { mode: 0o600 });
      expect((await run(repo)).code).toBe(1);
      expect(readFileSync(path, "utf8")).toBe("{bad");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("restores a generated backup only while the installed bytes are unchanged", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claude-peers-claude-restore-"));
    try {
      const path = join(repo, ".claude", "settings.json");
      mkdirSync(join(repo, ".claude"), { recursive: true, mode: 0o700 });
      const original = "{\n  \"theme\": \"dark\"\n}\n";
      writeFileSync(path, original, { mode: 0o600 });
      const installed = await run(repo);
      expect(installed.code).toBe(0);
      const backupPath = installed.stdout.split("\n").find((line) => line.startsWith("backup: "))?.slice("backup: ".length);
      expect(backupPath).toBeDefined();
      expect(statSync(backupPath!).mode & 0o777).toBe(0o600);
      expect((await run(repo, "--restore", backupPath!)).code).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(statSync(path).mode & 0o777).toBe(0o600);

      const reinstalled = await run(repo);
      const secondBackup = reinstalled.stdout.split("\n").find((line) => line.startsWith("backup: "))?.slice("backup: ".length);
      const edited = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      edited.theme = "operator-edit";
      writeFileSync(path, `${JSON.stringify(edited, null, 2)}\n`, { mode: 0o600 });
      expect((await run(repo, "--restore", secondBackup!)).code).toBe(1);
      expect((JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>).theme).toBe("operator-edit");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("refuses duplicate scopes unless replace transfers hook ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-claude-scope-"));
    try {
      const home = join(root, "home");
      const project = join(root, "project");
      mkdirSync(join(home, ".claude"), { recursive: true, mode: 0o700 });
      mkdirSync(project, { mode: 0o700 });
      const userPath = join(home, ".claude", "settings.json");
      writeFileSync(userPath, `${JSON.stringify(installClientHooks({}, "claude", repoRoot), null, 2)}\n`, { mode: 0o600 });
      const invoke = async (...args: string[]) => {
        const proc = Bun.spawn(["bun", installer, ...args], {
          cwd: project,
          env: { ...process.env, HOME: home },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
        return { code, stderr };
      };

      const rejected = await invoke("--scope", "project", project);
      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toContain("duplicate Claude hook scope");
      expect(() => readFileSync(join(project, ".claude", "settings.json"))).toThrow();

      mkdirSync(join(project, ".claude"), { mode: 0o700 });
      chmodSync(join(project, ".claude"), 0o770);
      expect((await invoke("--scope", "project", project, "--replace")).code).toBe(1);
      const preservedUser = JSON.parse(readFileSync(userPath, "utf8")) as Record<string, unknown>;
      expect(classifyClientHooks(preservedUser, "claude", repoRoot).exact).toBe(3);
      chmodSync(join(project, ".claude"), 0o700);

      expect((await invoke("--scope", "project", project, "--replace")).code).toBe(0);
      const user = JSON.parse(readFileSync(userPath, "utf8")) as Record<string, unknown>;
      const projectDoc = JSON.parse(readFileSync(join(project, ".claude", "settings.json"), "utf8")) as Record<string, unknown>;
      expect(classifyClientHooks(user, "claude", repoRoot).exact).toBe(0);
      expect(classifyClientHooks(projectDoc, "claude", repoRoot).exact).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("default user install rejects a project owner and failed replace rolls the target back", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-claude-default-scope-"));
    try {
      const home = join(root, "home");
      const project = join(root, "project");
      const safeClone = join(home, "clone");
      mkdirSync(join(home, ".claude"), { recursive: true, mode: 0o700 });
      mkdirSync(safeClone, { mode: 0o700 });
      for (const entry of ["bin", "shared", "hooks"]) cpSync(join(repoRoot, entry), join(safeClone, entry), { recursive: true });
      const safeInstaller = join(safeClone, "bin", "install-claude-hook.ts");
      mkdirSync(join(project, ".claude"), { recursive: true, mode: 0o700 });
      const projectPath = join(project, ".claude", "settings.json");
      writeFileSync(projectPath, `${JSON.stringify(installClientHooks({}, "claude", repoRoot), null, 2)}\n`, { mode: 0o600 });
      const invoke = async (...args: string[]) => {
        const proc = Bun.spawn(["bun", safeInstaller, ...args], {
          cwd: project,
          env: { ...process.env, HOME: home },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
        return { code, stderr };
      };

      const duplicate = await invoke();
      expect(duplicate.code).toBe(1);
      expect(duplicate.stderr).toContain("duplicate Claude hook scope");
      expect(() => readFileSync(join(home, ".claude", "settings.json"))).toThrow();

      rmSync(projectPath);
      const userPath = join(home, ".claude", "settings.json");
      writeFileSync(userPath, `${JSON.stringify(installClientHooks({}, "claude", repoRoot), null, 2)}\n`, { mode: 0o600 });
      chmodSync(join(home, ".claude"), 0o770);
      const failedTransfer = await invoke("--scope", "project", project, "--replace");
      expect(failedTransfer.code).toBe(1);
      expect(classifyClientHooks(JSON.parse(readFileSync(userPath, "utf8")), "claude", repoRoot).exact).toBe(3);
      const rolledBack = JSON.parse(readFileSync(projectPath, "utf8")) as Record<string, unknown>;
      expect(classifyClientHooks(rolledBack, "claude", repoRoot).exact).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("replaces legacy user-level receive hooks instead of installing duplicate drains", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claude-peers-claude-legacy-"));
    try {
      const path = join(repo, ".claude", "settings.json");
      mkdirSync(join(repo, ".claude"), { recursive: true });
      writeFileSync(path, `${JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "$HOME/.claude/hooks/drain-peer-inbox.sh" }] }],
          Stop: [{ hooks: [{ type: "command", command: "$HOME/.claude/hooks/claude-peers-standby-watcher.sh", timeout: 3600, asyncRewake: true }] }],
          PreToolUse: [{ hooks: [{ type: "command", command: "/opt/custom/drain-peer-inbox.sh" }] }],
        },
      }, null, 2)}\n`, { mode: 0o600 });

      expect((await run(repo)).code).toBe(0);
      const doc = JSON.parse(readFileSync(path, "utf8")) as {
        hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
      };
      const commands = Object.values(doc.hooks).flatMap((buckets) => buckets.flatMap((bucket) => bucket.hooks ?? [])).map((hook) => hook.command ?? "");
      expect(commands.filter((command) => command.includes("claude-drain-peer-inbox.sh"))).toHaveLength(1);
      expect(commands).toContain("/opt/custom/drain-peer-inbox.sh");
      expect(commands.filter((command) => command.includes("standby-watcher.sh"))).toEqual([expect.stringContaining("claude-standby-watcher.sh")]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("honors CLAUDE_CONFIG_DIR for alternate user profiles", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-claude-profile-"));
    try {
      const home = join(root, "home");
      const safeClone = join(home, "clone");
      const profile = join(home, ".claude-b");
      mkdirSync(safeClone, { recursive: true, mode: 0o700 });
      mkdirSync(profile, { mode: 0o700 });
      for (const entry of ["bin", "shared", "hooks"]) cpSync(join(repoRoot, entry), join(safeClone, entry), { recursive: true });
      const safeInstaller = join(safeClone, "bin", "install-claude-hook.ts");
      const proc = Bun.spawn(["bun", safeInstaller], {
        cwd: home,
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: profile },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(code).toBe(0);
      expect(stderr).toBe("");

      const profilePath = join(profile, "settings.json");
      const profileDoc = JSON.parse(readFileSync(profilePath, "utf8")) as Record<string, unknown>;
      expect(classifyClientHooks(profileDoc, "claude", safeClone).exact).toBe(3);
      expect(() => readFileSync(join(home, ".claude", "settings.json"))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
