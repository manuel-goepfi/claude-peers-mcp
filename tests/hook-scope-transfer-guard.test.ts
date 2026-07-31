/**
 * The scope transfer must not silently delete an ACCOUNT's peer hooks.
 *
 * Measured 2026-07-31. `~/.claude-b/settings.json` lost exactly three peer hooks
 * — SessionStart, Stop, UserPromptSubmit — while `~/.claude` kept its identical
 * set. Every unrelated hook in the same file survived, so this was never a stale
 * whole-file overwrite; something removed peer hooks by identity.
 *
 * The consequence was a full day of silent mail loss on account B, and it was
 * invisible for two reasons that this file pins down:
 *
 *  1. userConfigPath is resolved from CLAUDE_CONFIG_DIR *at install time*, so a
 *     project-scope install run from an account-B shell treats account B's global
 *     config as "the duplicate scope" and removes it. The operator never named
 *     that account; the invoking shell chose it.
 *  2. The removal printed nothing at all — the success line names only the
 *     install TARGET, never the file hooks were taken out of.
 *
 * Losing user scope is a downgrade, not a de-duplication: user-scope hooks serve
 * every session of that account, project-scope hooks serve one repo. Trading the
 * first for the second leaves every other repo's lanes with no drain path.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClientHooks } from "../shared/hook-config.ts";

const installer = new URL("../bin/install-claude-hook.ts", import.meta.url).pathname;
const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const dirs: string[] = [];

function sandbox(): { home: string; project: string; userSettings: string } {
  const home = mkdtempSync(join(tmpdir(), "hook-guard-"));
  dirs.push(home);
  const configDir = join(home, ".claude-b");
  const project = join(home, "proj");
  // mode 0o700 is required, not tidiness: ensureParent rejects any config
  // directory with (mode & 0o022) — and the default umask here is 0002, so a
  // plain mkdirSync yields 0775, which is group-writable and fails with
  // "unsafe configuration directory" before the code under test ever runs.
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(project, ".claude"), { recursive: true, mode: 0o700 });
  return { home, project, userSettings: join(configDir, "settings.json") };
}

/**
 * Seed peer hooks into the account's user-scope config the way a healthy box has
 * them. Written directly rather than by invoking `--scope user`, because that path
 * calls assertSafeCloneForUserInstall, which walks the REPO path up to $HOME — and
 * these tests override HOME to a sandbox, so the walk overshoots to root-owned
 * /home and throws. That is a separate pre-existing defect (it keeps ~11 installer
 * tests red); seeding directly keeps this file testing the scope transfer instead
 * of inheriting an unrelated failure.
 */
function seedUserScope(userSettings: string, home: string): void {
  writeFileSync(userSettings, `${JSON.stringify(installClientHooks({}, "claude", repoRoot), null, 2)}\n`, { mode: 0o600 });
  void home;
  const doc = JSON.parse(readFileSync(userSettings, "utf8"));
  if (!doc.hooks?.UserPromptSubmit) throw new Error("seed did not install UserPromptSubmit");
}

function runProjectInstall(home: string, project: string, extra: string[] = []) {
  return Bun.spawnSync(["bun", installer, project, "--replace", ...extra], {
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude-b") },
    stdout: "pipe", stderr: "pipe",
  });
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("scope transfer must not silently drop an account's user-scope hooks", () => {
  test("a project-scope install REFUSES to strip user-scope hooks, and leaves them intact", () => {
    const { home, project, userSettings } = sandbox();
    seedUserScope(userSettings, home);
    const before = readFileSync(userSettings, "utf8");

    const r = runProjectInstall(home, project);

    expect(r.exitCode).not.toBe(0);
    const err = new TextDecoder().decode(r.stderr);
    expect(err).toContain("refusing to remove user-scope");
    // The whole point: the account's hooks are still there afterwards.
    expect(readFileSync(userSettings, "utf8")).toBe(before);
    const doc = JSON.parse(before);
    expect(doc.hooks.UserPromptSubmit).toBeDefined();
    expect(doc.hooks.SessionStart).toBeDefined();
    expect(doc.hooks.Stop).toBeDefined();
  });

  test("the error names the consequence and the escape hatch, not just the refusal", () => {
    // A refusal the operator cannot act on gets worked around with --force-something
    // until it is effectively off. Name what breaks and how to proceed deliberately.
    const { home, project, userSettings } = sandbox();
    seedUserScope(userSettings, home);
    const err = new TextDecoder().decode(runProjectInstall(home, project).stderr);
    expect(err).toContain("every OTHER project of this account");
    expect(err).toContain("--drop-user-scope");
    expect(err).toContain("--scope user");
  });

  test("--drop-user-scope still allows the transfer, but records it", () => {
    // The removal remains possible — it just cannot happen by accident, and it
    // leaves evidence. That audit line is what turns a day of backup-diffing into
    // a lookup.
    const { home, project, userSettings } = sandbox();
    seedUserScope(userSettings, home);

    const r = runProjectInstall(home, project, ["--drop-user-scope"]);
    expect(r.exitCode).toBe(0);

    const doc = JSON.parse(readFileSync(userSettings, "utf8"));
    expect(doc.hooks?.UserPromptSubmit).toBeUndefined();

    const stderr = new TextDecoder().decode(r.stderr);
    expect(stderr).toContain("peer hooks REMOVED from");
    expect(stderr).toContain(userSettings);

    const auditPath = join(home, ".claude-peers-hook-audit.log");
    expect(existsSync(auditPath)).toBe(true);
    const entry = JSON.parse(readFileSync(auditPath, "utf8").trim().split("\n").pop()!);
    expect(entry.removed_from).toBe(userSettings);
    expect(entry.reason).toBe("scope-transfer");
    expect(entry.hooks_removed).toBeGreaterThan(0);
    // The field that would have identified the culprit on day one.
    expect(entry.claude_config_dir).toBe(join(home, ".claude-b"));
  });

  test("an unrelated hook in the same file is never touched by the transfer", () => {
    // CHARACTERIZATION TEST, NOT A REGRESSION GUARD — stated because the label would
    // otherwise imply cover it does not give. Run against the unfixed installer at
    // df4d22e this test PASSES: identity-scoped removal is pre-existing behaviour,
    // so it cannot fail on the bug this file exists for. The other four tests here
    // all fail at df4d22e and are the real guards.
    //
    // Kept anyway because it pins the blast radius, which is the diagnostic that
    // ruled out "the installer rewrote the whole file" when ~/.claude-b shrank —
    // and would rule it out again next time. If identity matching ever broadens,
    // this is what catches it.
    const { home, project, userSettings } = sandbox();
    seedUserScope(userSettings, home);
    const doc = JSON.parse(readFileSync(userSettings, "utf8"));
    doc.hooks.PreToolUse = [{ matcher: "Bash", hooks: [{ type: "command", command: "/opt/unrelated.sh" }] }];
    writeFileSync(userSettings, JSON.stringify(doc, null, 2));

    expect(runProjectInstall(home, project, ["--drop-user-scope"]).exitCode).toBe(0);

    const after = JSON.parse(readFileSync(userSettings, "utf8"));
    expect(after.hooks.PreToolUse[0].hooks[0].command).toBe("/opt/unrelated.sh");
    expect(after.hooks?.UserPromptSubmit).toBeUndefined();
  });

  test("an explicit uninstall is audited too", () => {
    // The forensic gap was not specific to the transfer: any path that removes peer
    // hooks must leave a trace, or the next disappearance is unattributable again.
    const { home, project, userSettings } = sandbox();
    seedUserScope(userSettings, home);

    // Project scope on purpose: `--scope user` calls the clone guard described in
    // seedUserScope. The audit behaviour under test is scope-independent.
    Bun.spawnSync(["bun", installer, project, "--replace", "--drop-user-scope"], {
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude-b") },
      stdout: "pipe", stderr: "pipe",
    });
    const r = Bun.spawnSync(["bun", installer, project, "--uninstall"], {
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude-b") },
      stdout: "pipe", stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);

    const entry = JSON.parse(
      readFileSync(join(home, ".claude-peers-hook-audit.log"), "utf8").trim().split("\n").pop()!,
    );
    expect(entry.reason).toBe("explicit-uninstall");
    expect(entry.removed_from).toContain("settings.json");
  });
});
