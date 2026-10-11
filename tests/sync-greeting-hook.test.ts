/**
 * The SessionStart greeting runs from a copy in each Claude config home, so the
 * repo file changes nothing until it is copied and the copies drift. Live
 * 2026-10-11: all four homes ran an August copy that printed a peer policy the
 * repo removed on 2026-10-06. sync-greeting-hook checks and installs the repo
 * copy into every home; these tests run it against temporary homes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_NAME, defaultHomes, inspect, install } from "../bin/sync-greeting-hook.ts";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function homes() {
  const home = mkdtempSync(join(tmpdir(), "greeting-sync-")); roots.push(home);
  const canonical = join(home, "canonical.sh");
  writeFileSync(canonical, "#!/bin/bash\necho current-greeting\n");
  const withHook = (dir: string, body: string) => {
    mkdirSync(join(home, dir, "hooks"), { recursive: true });
    writeFileSync(join(home, dir, "hooks", HOOK_NAME), body);
  };
  withHook(".claude", "#!/bin/bash\necho stale-greeting PEER_POLICY\n");
  withHook(".claude-b", "#!/bin/bash\necho stale-greeting PEER_POLICY\n");
  withHook(".claude-c", "#!/bin/bash\necho current-greeting\n");
  mkdirSync(join(home, ".claude-x", "hooks"), { recursive: true });     // a home without the greeting
  mkdirSync(join(home, ".claude-y"), { recursive: true });              // a home without hooks at all
  return { home, canonical };
}

describe("sync-greeting-hook", () => {
  test("default homes: ~/.claude plus each ~/.claude-* that already has the hook", () => {
    const { home } = homes();
    expect(defaultHomes(home).map((h) => h.slice(home.length + 1)).sort()).toEqual([".claude", ".claude-b", ".claude-c"]);
  });

  test("check reports drift per home and changes nothing", () => {
    const { home, canonical } = homes();
    const before = readFileSync(join(home, ".claude", "hooks", HOOK_NAME), "utf8");
    const result = inspect(defaultHomes(home), canonical);
    expect(result.homes.map((h) => h.state)).toEqual(["drift", "drift", "same"]);
    expect(readFileSync(join(home, ".claude", "hooks", HOOK_NAME), "utf8")).toBe(before);
    expect(readdirSync(join(home, ".claude", "hooks"))).toEqual([HOOK_NAME]);
  });

  test("install backs up each drifted copy, makes every home identical and executable", () => {
    const { home, canonical } = homes();
    const states = install(defaultHomes(home), canonical, "20261011T1030");
    expect(states.every((s) => s.state === "same")).toBe(true);
    for (const dir of [".claude", ".claude-b"]) {
      const hooks = join(home, dir, "hooks");
      expect(readFileSync(join(hooks, HOOK_NAME), "utf8")).toBe(readFileSync(canonical, "utf8"));
      expect(readFileSync(join(hooks, `${HOOK_NAME}.bak-20261011T1030`), "utf8")).toContain("PEER_POLICY");
      expect(statSync(join(hooks, HOOK_NAME)).mode & 0o777).toBe(0o755);
    }
    // An identical home is left alone: no backup is written.
    expect(readdirSync(join(home, ".claude-c", "hooks"))).toEqual([HOOK_NAME]);
  });

  test("install is idempotent and never creates a config home or hooks directory", () => {
    const { home, canonical } = homes();
    install(defaultHomes(home), canonical, "first");
    install([...defaultHomes(home), join(home, ".claude-y"), join(home, ".claude-z")], canonical, "second");
    expect(readdirSync(join(home, ".claude", "hooks")).filter((f) => f.includes(".bak-second"))).toEqual([]);
    expect(existsSync(join(home, ".claude-y", "hooks"))).toBe(false);
    expect(existsSync(join(home, ".claude-z"))).toBe(false);
  });

  test("an explicitly named home without the hook gets it on install when its hooks dir exists", () => {
    const { home, canonical } = homes();
    expect(inspect([join(home, ".claude-x")], canonical).homes[0]!.state).toBe("missing");
    expect(install([join(home, ".claude-x")], canonical)[0]!.state).toBe("same");
  });

  test("the canonical repo greeting renders reply correlation and no retired peer policy", () => {
    const repo = readFileSync(new URL(`../hooks/${HOOK_NAME}`, import.meta.url), "utf8");
    expect(repo).toContain("request_id");
    expect(repo).toContain("reply_to_id");
    expect(repo).not.toContain("PEER_POLICY");
    expect(repo).not.toContain('<peer-receive-policy source=');
  });
});
