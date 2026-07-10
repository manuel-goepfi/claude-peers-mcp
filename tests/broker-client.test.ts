import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openOwnerOnlyAppendLog } from "../shared/broker-client.ts";

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "claude-peers-log-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("broker direct-start log hardening", () => {
  test("creates a new append log as 0600", () => {
    const path = join(root(), "broker.log");
    const fd = openOwnerOnlyAppendLog(path);
    closeSync(fd);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  test("remediates an existing permissive log before append", () => {
    const path = join(root(), "broker.log");
    writeFileSync(path, "old\n", { mode: 0o666 });
    const fd = openOwnerOnlyAppendLog(path);
    closeSync(fd);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  test("refuses a symlink log target", () => {
    const dir = root();
    const target = join(dir, "target.log");
    writeFileSync(target, "operator\n", { mode: 0o600 });
    const link = join(dir, "broker.log");
    symlinkSync(target, link);
    expect(() => openOwnerOnlyAppendLog(link)).toThrow(/not a regular file/);
  });
});
