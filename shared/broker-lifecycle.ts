import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fsyncDirectory } from "./fs-durability.ts";

export type BrokerOwnerMode = "direct" | "systemd";

export interface BrokerOwnerMetadata {
  schema: 1;
  uid: number;
  pid: number;
  process_start: string;
  database_path: string;
  lock_path: string;
  instance_nonce: string;
  owner_mode: BrokerOwnerMode;
  executable_path: string;
  broker_script_path: string;
  created_at: string;
}

export interface BrokerOwnershipHandle {
  readonly metadata: BrokerOwnerMetadata;
  readonly canonicalDatabasePath: string;
  readonly lockPath: string;
  release(): boolean;
}

export interface BrokerLifecycleIdentity {
  pid: number;
  process_start: string;
  instance_nonce: string;
  database_path: string;
  lock_path: string;
  owner_mode: BrokerOwnerMode;
  executable_path: string;
  broker_script_path: string;
  ready: true;
  capabilities: {
    procSocketIdentity: true;
    nonceProtectedOwnership: true;
    verifiedShutdown: true;
    storageSchema: number;
  };
}

export function isBrokerLifecycleIdentity(value: unknown, expectedStorageSchema: number): value is BrokerLifecycleIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<BrokerLifecycleIdentity>;
  return Number.isInteger(identity.pid) && (identity.pid ?? 0) > 1 &&
    typeof identity.process_start === "string" && identity.process_start.length > 0 &&
    typeof identity.instance_nonce === "string" && identity.instance_nonce.length > 0 &&
    typeof identity.database_path === "string" && identity.database_path.length > 0 &&
    typeof identity.lock_path === "string" && identity.lock_path.length > 0 &&
    (identity.owner_mode === "direct" || identity.owner_mode === "systemd") &&
    typeof identity.executable_path === "string" && identity.executable_path.length > 0 &&
    typeof identity.broker_script_path === "string" && identity.broker_script_path.length > 0 &&
    identity.ready === true &&
    identity.capabilities?.procSocketIdentity === true &&
    identity.capabilities?.nonceProtectedOwnership === true &&
    identity.capabilities?.verifiedShutdown === true &&
    identity.capabilities?.storageSchema === expectedStorageSchema;
}

export function sameLifecycleIdentity(left: BrokerLifecycleIdentity, right: BrokerLifecycleIdentity): boolean {
  return left.pid === right.pid &&
    left.process_start === right.process_start &&
    left.instance_nonce === right.instance_nonce &&
    left.database_path === right.database_path &&
    left.lock_path === right.lock_path &&
    left.owner_mode === right.owner_mode &&
    left.executable_path === right.executable_path &&
    left.broker_script_path === right.broker_script_path;
}

export type OwnershipCheckpoint =
  | "staging-created"
  | "metadata-written"
  | "staging-fsynced"
  | "published";

export interface AcquireBrokerOwnershipOptions {
  databasePath: string;
  brokerScriptPath: string;
  ownerMode?: BrokerOwnerMode;
  onCheckpoint?: (checkpoint: OwnershipCheckpoint) => void;
}

export class BrokerOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerOwnershipError";
  }
}

function randomNonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function assertOwnedDirectory(path: string, uid: number): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new BrokerOwnershipError(`database parent is not a real directory: ${path}`);
  }
  if (uid >= 0 && stat.uid !== uid) {
    throw new BrokerOwnershipError(`database parent is not owned by uid ${uid}: ${path}`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new BrokerOwnershipError(`database parent is group/world writable: ${path}`);
  }
}

export function canonicalizeDatabasePath(databasePath: string, uid = process.getuid?.() ?? -1): string {
  if (!databasePath) throw new BrokerOwnershipError("database path is empty");
  const absolute = isAbsolute(databasePath) ? resolve(databasePath) : resolve(process.cwd(), databasePath);
  const parent = dirname(absolute);
  const canonicalParent = realpathSync(parent);
  assertOwnedDirectory(canonicalParent, uid);

  if (!existsSync(absolute)) return join(canonicalParent, basename(absolute));
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    throw new BrokerOwnershipError(`database path must not be a symlink: ${absolute}`);
  }
  if (!stat.isFile()) {
    throw new BrokerOwnershipError(`database path is not a regular file: ${absolute}`);
  }
  const canonical = realpathSync(absolute);
  if (dirname(canonical) !== canonicalParent) {
    throw new BrokerOwnershipError(`database identity escaped its configured parent: ${absolute}`);
  }
  return canonical;
}

export function processStartIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
    // /proc/<pid>/stat field 22 is starttime. fieldsAfterCommand starts at field 3.
    const startTime = fieldsAfterCommand[19];
    return startTime && /^\d+$/.test(startTime) ? startTime : null;
  } catch {
    return null;
  }
}

function processExecutable(pid: number): string {
  try {
    return realpathSync(`/proc/${pid}/exe`);
  } catch (error) {
    throw new BrokerOwnershipError(`cannot resolve executable for pid ${pid}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeMetadata(path: string, metadata: BrokerOwnerMetadata): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(metadata)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readOwnerMetadata(lockPath: string): BrokerOwnerMetadata {
  const lockStat = lstatSync(lockPath);
  if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
    throw new BrokerOwnershipError(`ownership lock is not a real directory: ${lockPath}`);
  }
  const metadataPath = join(lockPath, "owner.json");
  const metadataStat = lstatSync(metadataPath);
  if (metadataStat.isSymbolicLink() || !metadataStat.isFile()) {
    throw new BrokerOwnershipError(`ownership metadata is not a regular file: ${metadataPath}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch (error) {
    throw new BrokerOwnershipError(`ownership metadata is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const m = value as Partial<BrokerOwnerMetadata>;
  if (
    m.schema !== 1 ||
    !Number.isInteger(m.uid) ||
    !Number.isInteger(m.pid) ||
    typeof m.process_start !== "string" || !m.process_start ||
    typeof m.database_path !== "string" || !m.database_path ||
    typeof m.lock_path !== "string" || !m.lock_path ||
    typeof m.instance_nonce !== "string" || !m.instance_nonce ||
    (m.owner_mode !== "direct" && m.owner_mode !== "systemd") ||
    typeof m.executable_path !== "string" || !m.executable_path ||
    typeof m.broker_script_path !== "string" || !m.broker_script_path ||
    typeof m.created_at !== "string" || !m.created_at
  ) {
    throw new BrokerOwnershipError(`ownership metadata is incomplete: ${metadataPath}`);
  }
  return m as BrokerOwnerMetadata;
}

export function ownerProcessIsCurrent(metadata: BrokerOwnerMetadata): boolean {
  const currentStart = processStartIdentity(metadata.pid);
  return currentStart !== null && currentStart === metadata.process_start;
}

function cleanupAbandonedStaging(
  parent: string,
  prefix: string,
  uid: number,
  lockPath: string,
  databasePath: string,
): void {
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(prefix)) continue;
    const candidate = join(parent, name);
    try {
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory() || (uid >= 0 && stat.uid !== uid)) continue;
      const metadata = readOwnerMetadata(candidate);
      if (
        metadata.uid !== uid ||
        metadata.lock_path !== lockPath ||
        metadata.database_path !== databasePath ||
        ownerProcessIsCurrent(metadata)
      ) continue;
      rmSync(candidate, { recursive: true, force: false });
      fsyncDirectory(parent);
    } catch {
      // Incomplete or unverifiable staging belongs to neither this process nor a
      // proven-dead owner. Leave it for explicit operator inspection.
    }
  }
}

function releasePublishedLock(lockPath: string, nonce: string): boolean {
  let published: BrokerOwnerMetadata;
  try {
    published = readOwnerMetadata(lockPath);
  } catch {
    return false;
  }
  if (published.instance_nonce !== nonce) return false;

  const parent = dirname(lockPath);
  const releasePath = `${lockPath}.release-${process.pid}-${randomNonce()}`;
  try {
    renameSync(lockPath, releasePath);
    fsyncDirectory(parent);
    const moved = readOwnerMetadata(releasePath);
    if (moved.instance_nonce !== nonce) {
      if (!existsSync(lockPath)) renameSync(releasePath, lockPath);
      fsyncDirectory(parent);
      return false;
    }
    rmSync(releasePath, { recursive: true, force: false });
    fsyncDirectory(parent);
    return true;
  } catch {
    return false;
  }
}

export function acquireBrokerOwnership(options: AcquireBrokerOwnershipOptions): BrokerOwnershipHandle {
  const uid = process.getuid?.() ?? -1;
  if (uid < 0) throw new BrokerOwnershipError("database ownership requires process.getuid() on Linux");
  const canonicalDatabasePath = canonicalizeDatabasePath(options.databasePath, uid);
  const lockPath = `${canonicalDatabasePath}.owner`;
  const parent = dirname(lockPath);
  const stagingPrefix = `${basename(lockPath)}.staging-`;
  cleanupAbandonedStaging(parent, stagingPrefix, uid, lockPath, canonicalDatabasePath);

  const processStart = processStartIdentity(process.pid);
  if (!processStart) throw new BrokerOwnershipError(`cannot read process-start identity for pid ${process.pid}`);
  const instanceNonce = randomNonce();
  const stagingPath = join(parent, `${stagingPrefix}${process.pid}-${instanceNonce}`);
  const metadata: BrokerOwnerMetadata = {
    schema: 1,
    uid,
    pid: process.pid,
    process_start: processStart,
    database_path: canonicalDatabasePath,
    lock_path: lockPath,
    instance_nonce: instanceNonce,
    owner_mode: options.ownerMode ?? (process.env.INVOCATION_ID ? "systemd" : "direct"),
    executable_path: processExecutable(process.pid),
    broker_script_path: realpathSync(options.brokerScriptPath),
    created_at: new Date().toISOString(),
  };

  mkdirSync(stagingPath, { mode: 0o700 });
  let published = false;
  try {
    options.onCheckpoint?.("staging-created");
    writeMetadata(join(stagingPath, "owner.json"), metadata);
    options.onCheckpoint?.("metadata-written");
    fsyncDirectory(stagingPath);
    options.onCheckpoint?.("staging-fsynced");

    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        renameSync(stagingPath, lockPath);
        published = true;
        fsyncDirectory(parent);
        options.onCheckpoint?.("published");
        break;
      } catch (error) {
        if (!new Set(["EEXIST", "ENOTEMPTY"]).has(errno(error) ?? "")) throw error;
      }

      let existing: BrokerOwnerMetadata;
      try {
        existing = readOwnerMetadata(lockPath);
      } catch (error) {
        throw new BrokerOwnershipError(`existing ownership lock is unverifiable: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (existing.database_path !== canonicalDatabasePath || existing.lock_path !== lockPath || existing.uid !== uid) {
        throw new BrokerOwnershipError(`existing ownership lock identity does not match ${canonicalDatabasePath}`);
      }
      if (ownerProcessIsCurrent(existing)) {
        throw new BrokerOwnershipError(`database already owned by live pid ${existing.pid} (${existing.owner_mode})`);
      }

      const stalePath = `${lockPath}.stale-${existing.pid}-${existing.instance_nonce}-${randomNonce()}`;
      try {
        renameSync(lockPath, stalePath);
        fsyncDirectory(parent);
        const displaced = readOwnerMetadata(stalePath);
        if (displaced.instance_nonce !== existing.instance_nonce || ownerProcessIsCurrent(displaced)) {
          if (!existsSync(lockPath)) renameSync(stalePath, lockPath);
          fsyncDirectory(parent);
          throw new BrokerOwnershipError("stale-lock identity changed during recovery");
        }
        rmSync(stalePath, { recursive: true, force: false });
        fsyncDirectory(parent);
      } catch (error) {
        if (errno(error) === "ENOENT") continue;
        throw error;
      }
    }

    if (!published) throw new BrokerOwnershipError(`could not publish ownership lock after repeated contention: ${lockPath}`);
  } catch (error) {
    if (!published && existsSync(stagingPath)) rmSync(stagingPath, { recursive: true, force: true });
    throw error;
  }

  let released = false;
  return {
    metadata,
    canonicalDatabasePath,
    lockPath,
    release() {
      if (released) return true;
      const ok = releasePublishedLock(lockPath, instanceNonce);
      if (ok) released = true;
      return ok;
    },
  };
}

export function assertDatabaseIdentity(databasePath: string, expectedCanonicalPath: string): void {
  const canonical = canonicalizeDatabasePath(databasePath);
  if (canonical !== expectedCanonicalPath) {
    throw new BrokerOwnershipError(`database identity changed before open: expected ${expectedCanonicalPath}, got ${canonical}`);
  }
}

function listeningSocketInodes(port: number): Set<string> {
  const inodes = new Set<string>();
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = readFileSync(table, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10) continue;
      const local = fields[1]?.split(":");
      if (local?.[1]?.toUpperCase() !== portHex || fields[3] !== "0A") continue;
      const address = local[0]?.toUpperCase();
      const loopback4 = address === "0100007F";
      const loopback6 = address === "00000000000000000000000001000000";
      if (!loopback4 && !loopback6) continue;
      const inode = fields[9];
      if (inode && /^\d+$/.test(inode)) inodes.add(inode);
    }
  }
  return inodes;
}

export function listenerPidsForLoopbackPort(port: number, uid = process.getuid?.() ?? -1): number[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BrokerOwnershipError(`invalid listener port: ${port}`);
  }
  const inodes = listeningSocketInodes(port);
  if (inodes.size === 0) return [];
  const pids = new Set<number>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const procStat = lstatSync(`/proc/${pid}`);
      if (uid >= 0 && procStat.uid !== uid) continue;
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        let target: string;
        try {
          target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        } catch {
          continue;
        }
        const match = target.match(/^socket:\[(\d+)\]$/);
        if (match?.[1] && inodes.has(match[1])) {
          pids.add(pid);
          break;
        }
      }
    } catch {
      continue;
    }
  }
  return [...pids].sort((a, b) => a - b);
}

function cmdlineContainsScript(pid: number, expectedScript: string): boolean {
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    return args.some((arg) => {
      try {
        return realpathSync(arg) === expectedScript;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export function verifyLifecycleIdentity(
  identity: BrokerLifecycleIdentity,
  expected: { port: number; brokerScriptPath: string; uid?: number },
): void {
  const uid = expected.uid ?? (process.getuid?.() ?? -1);
  const listeners = listenerPidsForLoopbackPort(expected.port, uid);
  if (listeners.length !== 1 || listeners[0] !== identity.pid) {
    throw new BrokerOwnershipError(`listener owner mismatch on port ${expected.port}`);
  }
  const procStat = lstatSync(`/proc/${identity.pid}`);
  if (uid >= 0 && procStat.uid !== uid) throw new BrokerOwnershipError("listener uid mismatch");
  if (processStartIdentity(identity.pid) !== identity.process_start) {
    throw new BrokerOwnershipError("listener process-start identity mismatch");
  }
  if (realpathSync(`/proc/${identity.pid}/exe`) !== identity.executable_path) {
    throw new BrokerOwnershipError("listener executable mismatch");
  }
  const expectedScript = realpathSync(expected.brokerScriptPath);
  if (realpathSync(identity.broker_script_path) !== expectedScript || !cmdlineContainsScript(identity.pid, expectedScript)) {
    throw new BrokerOwnershipError("listener broker-script path mismatch");
  }
  if (identity.lock_path !== `${identity.database_path}.owner`) {
    throw new BrokerOwnershipError("lifecycle lock identity is inconsistent");
  }
  const owner = readOwnerMetadata(identity.lock_path);
  if (
    owner.pid !== identity.pid ||
    owner.process_start !== identity.process_start ||
    owner.instance_nonce !== identity.instance_nonce ||
    owner.database_path !== identity.database_path ||
    owner.lock_path !== identity.lock_path ||
    owner.owner_mode !== identity.owner_mode ||
    owner.executable_path !== identity.executable_path ||
    owner.broker_script_path !== identity.broker_script_path ||
    owner.uid !== uid
  ) {
    throw new BrokerOwnershipError("published ownership metadata does not match lifecycle identity");
  }
}
