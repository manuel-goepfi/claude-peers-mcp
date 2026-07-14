import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeCloneForUserInstall, installJsonConfig } from "../shared/config-installer.ts";

const claudeInstaller = new URL("../bin/install-claude-hook.ts", import.meta.url).pathname;

describe("configuration installer safety", () => {
  test("rejects symlink targets and group/world-writable targets", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-config-safety-"));
    try {
      const directory = join(root, ".client");
      mkdirSync(directory, { mode: 0o700 });
      const real = join(directory, "real.json");
      writeFileSync(real, "{}\n", { mode: 0o600 });
      const target = join(directory, "settings.json");
      symlinkSync(real, target);
      expect(() => installJsonConfig(target, (document) => document)).toThrow("not a regular file");

      rmSync(target);
      writeFileSync(target, "{}\n", { mode: 0o622 });
      chmodSync(target, 0o622);
      expect(() => installJsonConfig(target, (document) => document)).toThrow("group/world writable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("check reports a restrictive-mode repair without mutating", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-config-check-"));
    try {
      const target = join(root, "settings.json");
      writeFileSync(target, "{}\n", { mode: 0o640 });
      chmodSync(target, 0o640);
      const result = installJsonConfig(target, (document) => document, { check: true });
      expect(result).toEqual({ changed: false, needsChange: true });
      expect(lstatSync(target).mode & 0o777).toBe(0o640);
      expect(readFileSync(target, "utf8")).toBe("{}\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("check does not create a missing configuration directory", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-config-missing-check-"));
    try {
      const target = join(root, ".client", "settings.json");
      expect(installJsonConfig(target, (document) => document, { check: true })).toEqual({ changed: false, needsChange: true });
      expect(existsSync(join(root, ".client"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects unsafe clone path components for user installs", () => {
    const root = mkdtempSync(join(process.env.HOME!, ".claude-peers-clone-safety-"));
    try {
      const clone = join(root, "clone");
      mkdirSync(clone, { mode: 0o700 });
      expect(() => assertSafeCloneForUserInstall(clone)).not.toThrow();
      chmodSync(clone, 0o770);
      expect(() => assertSafeCloneForUserInstall(clone)).toThrow("group/world writable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a concurrent external edit and preserves the operator bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-config-race-"));
    try {
      const target = join(root, ".claude", "settings.json");
      mkdirSync(join(root, ".claude"), { mode: 0o700 });
      writeFileSync(target, "{\n  \"theme\": \"before\"\n}\n", { mode: 0o600 });
      const proc = Bun.spawn(["bun", claudeInstaller, root], {
        env: { ...process.env, HOME: root, CLAUDE_PEERS_INSTALL_TEST_PAUSE_MS: "250" },
        stdout: "pipe",
        stderr: "pipe",
      });
      await Bun.sleep(100);
      const operatorBytes = "{\n  \"theme\": \"operator-edit\"\n}\n";
      writeFileSync(target, operatorBytes, { mode: 0o600 });
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(code).toBe(1);
      expect(stderr).toContain("changed while it was being prepared");
      expect(readFileSync(target, "utf8")).toBe(operatorBytes);
      expect(readdirSync(join(root, ".claude")).some((name) => name.includes(".tmp-") || name.includes(".bak-"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("concurrent first installs converge without corrupting JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-config-concurrent-"));
    try {
      const env = { ...process.env, HOME: root, CLAUDE_PEERS_INSTALL_TEST_PAUSE_MS: "150" };
      const processes = [0, 1].map(() => Bun.spawn(["bun", claudeInstaller, root], { env, stdout: "pipe", stderr: "pipe" }));
      const codes = await Promise.all(processes.map((proc) => proc.exited));
      expect(codes.every((code) => code === 0 || code === 1)).toBe(true);
      expect(codes.some((code) => code === 0)).toBe(true);
      const target = join(root, ".claude", "settings.json");
      expect(() => JSON.parse(readFileSync(target, "utf8"))).not.toThrow();
      expect(readdirSync(join(root, ".claude")).some((name) => name.includes(".tmp-") || name.includes(".bak-"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
