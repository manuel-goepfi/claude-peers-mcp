import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenSqliteArtifacts, OWNER_ONLY_UMASK } from "../shared/storage.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SQLite state permissions", () => {
  test("broker owner-only umask is 0077", () => {
    expect(OWNER_ONLY_UMASK).toBe(0o077);
  });

  test("remediates an existing database and WAL/SHM sidecars to 0600", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-sqlite-modes-"));
    roots.push(root);
    const dbPath = join(root, "peers.db");
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      writeFileSync(path, "state", { mode: 0o644 });
      chmodSync(path, 0o644);
    }

    hardenSqliteArtifacts(dbPath);
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  test("rejects a symlinked SQLite sidecar", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-sqlite-symlink-"));
    roots.push(root);
    const dbPath = join(root, "peers.db");
    writeFileSync(dbPath, "state", { mode: 0o600 });
    const target = join(root, "target");
    writeFileSync(target, "state", { mode: 0o600 });
    symlinkSync(target, `${dbPath}-wal`);
    expect(() => hardenSqliteArtifacts(dbPath)).toThrow("unsafe SQLite artifact");
  });
});
