import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { fsyncDirectory } from "./fs-durability.ts";

interface Fingerprint {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export interface JsonInstallResult {
  changed: boolean;
  needsChange: boolean;
  backupPath?: string;
}

export function readSafeJsonConfig(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  assertSafeFile(path);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`configuration root must be an object: ${path}`);
  return parsed as Record<string, unknown>;
}

function fingerprint(path: string): Fingerprint {
  const stat = lstatSync(path);
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function assertSafeFile(path: string): void {
  const stat = lstatSync(path);
  const uid = process.getuid?.() ?? -1;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`configuration target is not a regular file: ${path}`);
  if (uid >= 0 && stat.uid !== uid) throw new Error(`configuration target is not owned by uid ${uid}: ${path}`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`configuration target is group/world writable: ${path}`);
}

function ensureParent(path: string): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = lstatSync(parent);
  const uid = process.getuid?.() ?? -1;
  if (stat.isSymbolicLink() || !stat.isDirectory() || (uid >= 0 && stat.uid !== uid) || (stat.mode & 0o022) !== 0) {
    throw new Error(`unsafe configuration directory: ${parent}`);
  }
}

function atomicReplace(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  fsyncDirectory(dirname(path));
}

export function installJsonConfig(
  path: string,
  transform: (document: Record<string, unknown>) => Record<string, unknown>,
  options: { check?: boolean; pauseBeforeWriteMs?: number } = {},
): JsonInstallResult {
  if (options.check && !existsSync(dirname(path))) return { changed: false, needsChange: true };
  ensureParent(path);
  const existed = existsSync(path);
  let originalBytes = "";
  let before: Fingerprint | null = null;
  let originalMode = 0o600;
  let document: Record<string, unknown> = {};
  if (existed) {
    assertSafeFile(path);
    before = fingerprint(path);
    originalMode = lstatSync(path).mode & 0o777;
    originalBytes = readFileSync(path, "utf8");
    const parsed = JSON.parse(originalBytes) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`configuration root must be an object: ${path}`);
    document = parsed as Record<string, unknown>;
  }

  const desired = `${JSON.stringify(transform(structuredClone(document)), null, 2)}\n`;
  const contentChange = desired !== originalBytes;
  const modeChange = existed && originalMode !== 0o600;
  if (!contentChange && !modeChange) {
    return { changed: false, needsChange: false };
  }
  if (options.check) return { changed: false, needsChange: true };

  if (!contentChange) {
    chmodSync(path, 0o600);
    fsyncDirectory(dirname(path));
    return { changed: true, needsChange: false };
  }

  if (options.pauseBeforeWriteMs && options.pauseBeforeWriteMs > 0) {
    Bun.sleepSync(options.pauseBeforeWriteMs);
  }
  if (before) {
    assertSafeFile(path);
    if (!sameFingerprint(before, fingerprint(path)) || readFileSync(path, "utf8") !== originalBytes) {
      throw new Error(`configuration changed while it was being prepared: ${path}`);
    }
  } else if (existsSync(path)) {
    throw new Error(`configuration appeared while it was being prepared: ${path}`);
  }

  let backupPath: string | undefined;
  if (existed) {
    backupPath = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
    const backupFd = openSync(backupPath, "wx", 0o600);
    try {
      writeFileSync(backupFd, originalBytes, "utf8");
      fsyncSync(backupFd);
    } finally {
      closeSync(backupFd);
    }
    chmodSync(backupPath, 0o600);
  }

  atomicReplace(path, desired);
  return { changed: true, needsChange: false, ...(backupPath ? { backupPath } : {}) };
}

export function restoreJsonConfig(
  path: string,
  backupPath: string,
  expectedCurrentTransform: (document: Record<string, unknown>) => Record<string, unknown>,
  options: { pauseBeforeWriteMs?: number } = {},
): JsonInstallResult {
  ensureParent(path);
  if (dirname(backupPath) !== dirname(path) || !backupPath.startsWith(`${path}.bak-`)) {
    throw new Error(`backup must be a generated sibling of the configuration target: ${backupPath}`);
  }
  if (!existsSync(path) || !existsSync(backupPath)) throw new Error("configuration target and backup must both exist");
  assertSafeFile(path);
  assertSafeFile(backupPath);

  const currentBytes = readFileSync(path, "utf8");
  const currentBefore = fingerprint(path);
  const backupBytes = readFileSync(backupPath, "utf8");
  const backup = JSON.parse(backupBytes) as unknown;
  if (!backup || typeof backup !== "object" || Array.isArray(backup)) {
    throw new Error(`backup configuration root must be an object: ${backupPath}`);
  }
  const expectedCurrent = `${JSON.stringify(expectedCurrentTransform(structuredClone(backup) as Record<string, unknown>), null, 2)}\n`;
  if (currentBytes !== expectedCurrent) {
    throw new Error("configuration changed after installation; refusing to overwrite newer operator edits");
  }

  if (options.pauseBeforeWriteMs && options.pauseBeforeWriteMs > 0) Bun.sleepSync(options.pauseBeforeWriteMs);
  assertSafeFile(path);
  if (!sameFingerprint(currentBefore, fingerprint(path)) || readFileSync(path, "utf8") !== currentBytes) {
    throw new Error(`configuration changed while restore was being prepared: ${path}`);
  }

  atomicReplace(path, backupBytes);
  return { changed: true, needsChange: false, backupPath };
}

export function assertSafeCloneForUserInstall(repoPath: string): void {
  const uid = process.getuid?.() ?? -1;
  let current = repoPath;
  while (true) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`clone path component is not a real directory: ${current}`);
    if (uid >= 0 && stat.uid !== uid) throw new Error(`clone path component is not owned by uid ${uid}: ${current}`);
    if ((stat.mode & 0o022) !== 0) throw new Error(`clone path component is group/world writable: ${current}`);
    const parent = dirname(current);
    if (parent === current || current === (process.env.HOME ?? "")) break;
    current = parent;
  }
}
