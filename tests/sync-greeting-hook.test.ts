/**
 * The SessionStart greeting runs from a copy in each Claude config home, so the
 * repo file changes nothing until it is copied and the copies drift. Live
 * 2026-10-11: all four homes ran an August copy that printed a peer policy the
 * repo removed on 2026-10-06. sync-greeting-hook checks and installs the repo
 * copy into every home; these tests run it against temporary homes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_NAME, defaultHomes, failed, inspect, install } from "../bin/sync-greeting-hook.ts";

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
  chmodSync(join(home, ".claude-c", "hooks", HOOK_NAME), 0o755);
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

  // R2 fence 273 on 4514a1f0: six probes, each a temporary-home regression here.
  describe("fence 273 probes: never write through a symlink, never lose a backup, require 0755", () => {
    function foreign(home: string) {
      const target = join(home, "foreign-sentinel");
      writeFileSync(target, "FOREIGN\n");
      return target;
    }

    test("a symlinked hook file is unsafe and its target is untouched", () => {
      const { home, canonical } = homes();
      const target = foreign(home);
      const hook = join(home, ".claude", "hooks", HOOK_NAME);
      rmSync(hook); symlinkSync(target, hook);
      expect(install([join(home, ".claude")], canonical)[0]!.state).toBe("unsafe");
      expect(readFileSync(target, "utf8")).toBe("FOREIGN\n");
      expect(lstatSync(hook).isSymbolicLink()).toBe(true);
    });

    test("a symlinked hooks directory is unsafe and nothing is written through it", () => {
      const { home, canonical } = homes();
      const real = join(home, "elsewhere"); mkdirSync(real);
      writeFileSync(join(real, HOOK_NAME), "FOREIGN\n");
      rmSync(join(home, ".claude", "hooks"), { recursive: true });
      symlinkSync(real, join(home, ".claude", "hooks"));
      expect(install([join(home, ".claude")], canonical)[0]!.state).toBe("unsafe");
      expect(readdirSync(real)).toEqual([HOOK_NAME]);
      expect(readFileSync(join(real, HOOK_NAME), "utf8")).toBe("FOREIGN\n");
    });

    test("a symlinked config home is unsafe", () => {
      const { home, canonical } = homes();
      symlinkSync(join(home, ".claude-b"), join(home, ".claude-link"));
      expect(inspect([join(home, ".claude-link")], canonical).homes[0]!.state).toBe("unsafe");
      expect(install([join(home, ".claude-link")], canonical)[0]!.state).toBe("unsafe");
      expect(readFileSync(join(home, ".claude-b", "hooks", HOOK_NAME), "utf8")).toContain("PEER_POLICY");
    });

    test("a backup path that is already a symlink is never written through", () => {
      const { home, canonical } = homes();
      const target = foreign(home);
      const hooks = join(home, ".claude", "hooks");
      symlinkSync(target, join(hooks, `${HOOK_NAME}.bak-STAMP`));
      expect(install([join(home, ".claude")], canonical, "STAMP")[0]!.state).toBe("same");
      expect(readFileSync(target, "utf8")).toBe("FOREIGN\n");
      expect(readFileSync(join(hooks, `${HOOK_NAME}.bak-STAMP-1`), "utf8")).toContain("PEER_POLICY");
    });

    test("an existing backup with the same stamp is kept; the new one gets a unique name, mode 0600", () => {
      const { home, canonical } = homes();
      const hooks = join(home, ".claude", "hooks");
      writeFileSync(join(hooks, `${HOOK_NAME}.bak-STAMP`), "OLDER BACKUP\n");
      install([join(home, ".claude")], canonical, "STAMP");
      expect(readFileSync(join(hooks, `${HOOK_NAME}.bak-STAMP`), "utf8")).toBe("OLDER BACKUP\n");
      expect(readFileSync(join(hooks, `${HOOK_NAME}.bak-STAMP-1`), "utf8")).toContain("PEER_POLICY");
      expect(statSync(join(hooks, `${HOOK_NAME}.bak-STAMP-1`)).mode & 0o777).toBe(0o600);
    });

    test("identical content at mode 0644 is drift; install repairs the mode without a backup", () => {
      const { home, canonical } = homes();
      const hook = join(home, ".claude-c", "hooks", HOOK_NAME);
      chmodSync(hook, 0o644);
      expect(inspect([join(home, ".claude-c")], canonical).homes[0]!.state).toBe("drift");
      expect(install([join(home, ".claude-c")], canonical)[0]!.state).toBe("same");
      expect(statSync(hook).mode & 0o777).toBe(0o755);
      expect(readdirSync(join(home, ".claude-c", "hooks"))).toEqual([HOOK_NAME]);
    });

    test("a home whose hooks dir aliases another managed home's real hooks dir is shared, never written", () => {
      // Live host: ~/.claude-c/hooks and ~/.claude-d/hooks -> ~/.claude/hooks.
      const { home, canonical } = homes();
      rmSync(join(home, ".claude-c", "hooks"), { recursive: true });
      symlinkSync(join(home, ".claude", "hooks"), join(home, ".claude-c", "hooks"));
      const set = [join(home, ".claude"), join(home, ".claude-c")];
      const before = inspect(set, canonical).homes;
      expect(before.map((s) => s.state)).toEqual(["drift", "shared"]);
      expect(failed(before).map((s) => s.home)).toEqual(set);        // shared fails while its owner drifts
      const after = install(set, canonical, "STAMP");
      expect(after.map((s) => s.state)).toEqual(["same", "shared"]);
      expect(failed(after)).toEqual([]);
      expect(lstatSync(join(home, ".claude-c", "hooks")).isSymbolicLink()).toBe(true);
    });

    test("a hooks symlink to anything other than a managed home's real hooks dir stays unsafe", () => {
      const { home, canonical } = homes();
      const real = join(home, "elsewhere"); mkdirSync(real);
      rmSync(join(home, ".claude-c", "hooks"), { recursive: true });
      symlinkSync(real, join(home, ".claude-c", "hooks"));
      const states = inspect([join(home, ".claude"), join(home, ".claude-c")], canonical).homes;
      expect(states[1]!.state).toBe("unsafe");
      // ...and so does an alias of a home that is not part of the set.
      rmSync(join(home, ".claude-c", "hooks"));
      symlinkSync(join(home, ".claude-b", "hooks"), join(home, ".claude-c", "hooks"));
      expect(inspect([join(home, ".claude"), join(home, ".claude-c")], canonical).homes[1]!.state).toBe("unsafe");
    });

    test("an install leaves no staged temporary files behind", () => {
      const { home, canonical } = homes();
      install(defaultHomes(home), canonical, "STAMP");
      for (const dir of [".claude", ".claude-b", ".claude-c"]) {
        expect(readdirSync(join(home, dir, "hooks")).filter((f) => f.includes(".new-"))).toEqual([]);
      }
    });
  });

  test("the canonical repo greeting renders reply correlation and no retired peer policy", () => {
    const repo = readFileSync(new URL(`../hooks/${HOOK_NAME}`, import.meta.url), "utf8");
    expect(repo).toContain("request_id");
    expect(repo).toContain("reply_to_id");
    expect(repo).not.toContain("PEER_POLICY");
    expect(repo).not.toContain('<peer-receive-policy source=');
  });
});
