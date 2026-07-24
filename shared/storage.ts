import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fsyncDirectory } from "./fs-durability.ts";

export const STORAGE_SCHEMA_VERSION = 1;
export const OWNER_ONLY_UMASK = 0o077;

export function hardenSqliteArtifacts(databasePath: string, uid = process.getuid?.() ?? -1): void {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || (uid >= 0 && stat.uid !== uid)) {
      throw new Error(`unsafe SQLite artifact: ${path}`);
    }
    if ((stat.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
  }
}

export function positiveMilliseconds(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export type StorageReadiness = "starting" | "migrating" | "ready";

export interface StorageSnapshot {
  message_count: number;
  message_digest: string;
  message_ids_digest: string;
  queued_count: number;
  claimed_count: number;
  delivered_count: number;
  sequence_high_water: number;
  peer_count: number;
  peer_digest: string;
  non_targetable_count: number;
}

export interface StorageBackupManifest {
  manifest_version: 1;
  created_at: string;
  source_user_version: number;
  target_user_version: number;
  backup_sha256: string;
  snapshot: StorageSnapshot;
}

export interface InitializeStorageOptions {
  databasePath: string;
  backupPath?: string;
  migrationTimestamp?: string;
  onReadiness?: (state: StorageReadiness) => void;
  onCheckpoint?: (checkpoint: StorageMigrationCheckpoint) => void;
}

export type StorageMigrationCheckpoint =
  | "backup-complete"
  | "copy-complete"
  | "before-version"
  | "after-commit";

export interface InitializeStorageResult {
  version: number;
  migrated: boolean;
  backupPath?: string;
  backupManifestPath?: string;
}

export class PostCommitStorageVerificationError extends Error {
  constructor(
    message: string,
    readonly backupPath: string,
    readonly backupManifestPath: string,
    readonly originalError: unknown,
  ) {
    super(message);
    this.name = "PostCommitStorageVerificationError";
  }
}

class CommittedMigrationError extends Error {
  constructor(readonly originalError: unknown) {
    super(originalError instanceof Error ? originalError.message : String(originalError));
    this.name = "CommittedMigrationError";
  }
}

const peerColumns = [
  { name: "name", type: "TEXT" },
  { name: "tmux_session", type: "TEXT" },
  { name: "tmux_window_index", type: "TEXT" },
  { name: "tmux_window_name", type: "TEXT" },
  { name: "tmux_pane_id", type: "TEXT" },
  { name: "token", type: "TEXT" },
  { name: "resolved_name", type: "TEXT" },
  { name: "absolute_git_dir", type: "TEXT" },
  { name: "client_type", type: "TEXT NOT NULL DEFAULT 'unknown'" },
  { name: "receiver_mode", type: "TEXT NOT NULL DEFAULT 'unknown'" },
  { name: "last_hook_seen_at", type: "TEXT" },
  { name: "last_drain_at", type: "TEXT" },
  { name: "last_drain_error", type: "TEXT" },
  { name: "non_targetable", type: "INTEGER NOT NULL DEFAULT 0" },
] as const;

const requiredMessageColumns = [
  "id",
  "from_id",
  "to_id",
  "text",
  "sent_at",
  "delivered",
  "delivered_at",
  "retention_at",
  "claimed_by",
  "claimed_at",
] as const;

export const storageIndexes = {
  recipientQueue: "idx_messages_recipient_queue",
  senderStatus: "idx_messages_sender_status",
  deliveredRetention: "idx_messages_delivered_retention",
  unknownReceiverRetention: "idx_messages_unknown_retention",
  peerReceiverMode: "idx_peers_receiver_mode",
} as const;

function tableExists(db: Database, table: string): boolean {
  return Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

export function storageTableColumns(db: Database, table: string): Set<string> {
  if (!tableExists(db, table)) return new Set();
  return new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}

export function storageUserVersion(db: Database): number {
  return Number((db.query("PRAGMA user_version").get() as { user_version: number }).user_version);
}

function integrity(db: Database): void {
  const rows = db.query("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
  if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
    throw new Error(`SQLite integrity_check failed: ${rows.map((row) => row.integrity_check).join(", ")}`);
  }
}

function sequenceHighWater(db: Database): number {
  if (!tableExists(db, "sqlite_sequence")) return 0;
  const row = db.query("SELECT seq FROM sqlite_sequence WHERE name='messages'").get() as { seq: number } | null;
  return Number(row?.seq ?? 0);
}

function digest(values: unknown[]): string {
  const hash = createHash("sha256");
  for (const value of values) hash.update(`${JSON.stringify(value)}\n`);
  return hash.digest("hex");
}

export function maximumSequenceHighWater(sequence: number, ids: unknown[]): number {
  return ids.reduce<number>((maximum, id) => Math.max(maximum, Number(id) || 0), Math.max(0, sequence));
}

export function storageSnapshot(db: Database): StorageSnapshot {
  const messageCols = storageTableColumns(db, "messages");
  const peerCols = storageTableColumns(db, "peers");
  const deliveredAt = messageCols.has("delivered_at") ? "delivered_at" : "NULL AS delivered_at";
  const claimedBy = messageCols.has("claimed_by") ? "claimed_by" : "NULL AS claimed_by";
  const claimedAt = messageCols.has("claimed_at") ? "claimed_at" : "NULL AS claimed_at";
  const rows = tableExists(db, "messages")
    ? db.query(`SELECT id, from_id, to_id, text, sent_at, delivered, ${deliveredAt}, ${claimedBy}, ${claimedAt} FROM messages ORDER BY id`).all() as Array<Record<string, unknown>>
    : [];
  const ids = rows.map((row) => row.id);
  const queued = rows.filter((row) => Number(row.delivered) === 0 && !row.claimed_by).length;
  const claimed = rows.filter((row) => Number(row.delivered) === 0 && Boolean(row.claimed_by)).length;
  const delivered = rows.filter((row) => Number(row.delivered) === 1).length;
  const peerCount = tableExists(db, "peers")
    ? Number((db.query("SELECT COUNT(*) AS count FROM peers").get() as { count: number }).count)
    : 0;
  const optionalPeerFields: Array<[string, string]> = [
    ["absolute_git_dir", "NULL"],
    ["name", "NULL"],
    ["resolved_name", "NULL"],
    ["tmux_session", "NULL"],
    ["tmux_window_index", "NULL"],
    ["tmux_window_name", "NULL"],
    ["tmux_pane_id", "NULL"],
    ["client_type", "'unknown'"],
    ["receiver_mode", "'unknown'"],
    ["last_hook_seen_at", "NULL"],
    ["last_drain_at", "NULL"],
    ["last_drain_error", "NULL"],
    ["token", "NULL"],
    ["non_targetable", "0"],
  ];
  const peerSelect = optionalPeerFields
    .map(([name, fallback]) => peerCols.has(name) ? name : `${fallback} AS ${name}`)
    .join(", ");
  const peerRows = tableExists(db, "peers")
    ? db.query(`SELECT id, pid, cwd, git_root, tty, summary, registered_at, last_seen, ${peerSelect} FROM peers ORDER BY id`).all() as Array<Record<string, unknown>>
    : [];
  const nonTargetableCount = peerCols.has("non_targetable")
    ? Number((db.query("SELECT COUNT(*) AS count FROM peers WHERE non_targetable = 1").get() as { count: number }).count)
    : 0;
  return {
    message_count: rows.length,
    message_digest: digest(rows),
    message_ids_digest: digest(ids),
    queued_count: queued,
    claimed_count: claimed,
    delivered_count: delivered,
    sequence_high_water: maximumSequenceHighWater(sequenceHighWater(db), ids),
    peer_count: peerCount,
    peer_digest: digest(peerRows),
    non_targetable_count: nonTargetableCount,
  };
}

function createPeersTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS peers (
      id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      git_root TEXT,
      absolute_git_dir TEXT,
      tty TEXT,
      name TEXT,
      resolved_name TEXT,
      tmux_session TEXT,
      tmux_window_index TEXT,
      tmux_window_name TEXT,
      tmux_pane_id TEXT,
      client_type TEXT NOT NULL DEFAULT 'unknown',
      receiver_mode TEXT NOT NULL DEFAULT 'unknown',
      last_hook_seen_at TEXT,
      last_drain_at TEXT,
      last_drain_error TEXT,
      summary TEXT NOT NULL DEFAULT '',
      registered_at TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      token TEXT,
      non_targetable INTEGER NOT NULL DEFAULT 0
    )
  `);
}

function ensurePeerColumns(db: Database): void {
  createPeersTable(db);
  const existing = storageTableColumns(db, "peers");
  for (const column of peerColumns) {
    if (!existing.has(column.name)) db.run(`ALTER TABLE peers ADD COLUMN ${column.name} ${column.type}`);
  }
}

function createMessagesTable(db: Database, name = "messages"): void {
  db.run(`
    CREATE TABLE ${name} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      text TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      delivered_at TEXT,
      retention_at TEXT,
      claimed_by TEXT,
      claimed_at TEXT
    )
  `);
}

function createIndexes(db: Database): void {
  db.run(`CREATE INDEX ${storageIndexes.recipientQueue} ON messages(to_id, delivered, sent_at, claimed_at)`);
  db.run(`CREATE INDEX ${storageIndexes.senderStatus} ON messages(from_id, id)`);
  db.run(`CREATE INDEX ${storageIndexes.deliveredRetention} ON messages(delivered, retention_at)`);
  db.run(`CREATE INDEX ${storageIndexes.unknownReceiverRetention} ON messages(delivered, sent_at, to_id)`);
  db.run(`CREATE INDEX ${storageIndexes.peerReceiverMode} ON peers(receiver_mode, id)`);
}

function schemaObjectsExist(db: Database): boolean {
  return tableExists(db, "peers") || tableExists(db, "messages");
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fsyncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeManifest(path: string, manifest: StorageBackupManifest): void {
  const tmp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  fsyncDirectory(dirname(path));
}

function sameSnapshot(left: StorageSnapshot, right: StorageSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function verifyBackup(path: string, manifest: StorageBackupManifest, expected: StorageSnapshot): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error(`backup is not a restrictive regular file: ${path}`);
  }
  if (fileSha256(path) !== manifest.backup_sha256) throw new Error("backup checksum mismatch");
  const backup = new Database(path, { readonly: true });
  try {
    integrity(backup);
    if (storageUserVersion(backup) !== manifest.source_user_version) throw new Error("backup user_version mismatch");
    const snapshot = storageSnapshot(backup);
    if (!sameSnapshot(snapshot, expected) || !sameSnapshot(snapshot, manifest.snapshot)) {
      throw new Error("backup row digest or partition mismatch");
    }
  } finally {
    backup.close();
  }
}

function readManifest(path: string): StorageBackupManifest {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error(`backup manifest is not a restrictive regular file: ${path}`);
  }
  const manifest = JSON.parse(readFileSync(path, "utf8")) as StorageBackupManifest;
  if (manifest.manifest_version !== 1 || manifest.target_user_version !== STORAGE_SCHEMA_VERSION) {
    throw new Error("backup manifest version is unsupported");
  }
  return manifest;
}

function createOrVerifyBackup(
  db: Database,
  backupPath: string,
  sourceVersion: number,
  snapshot: StorageSnapshot,
): { backupPath: string; manifestPath: string } {
  const manifestPath = `${backupPath}.manifest.json`;
  if (existsSync(backupPath) || existsSync(manifestPath)) {
    if (!existsSync(backupPath) || !existsSync(manifestPath)) {
      throw new Error("incomplete prior migration backup requires operator inspection");
    }
    const manifest = readManifest(manifestPath);
    verifyBackup(backupPath, manifest, snapshot);
    return { backupPath, manifestPath };
  }

  db.run("PRAGMA wal_checkpoint(FULL)");
  const tmp = `${backupPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const escaped = tmp.replace(/'/g, "''");
  try {
    db.run(`VACUUM INTO '${escaped}'`);
    chmodSync(tmp, 0o600);
    const backup = new Database(tmp, { readonly: true });
    try {
      integrity(backup);
      if (!sameSnapshot(storageSnapshot(backup), snapshot)) throw new Error("temporary backup verification mismatch");
    } finally {
      backup.close();
    }
    fsyncFile(tmp);
    renameSync(tmp, backupPath);
    fsyncDirectory(dirname(backupPath));
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }

  const manifest: StorageBackupManifest = {
    manifest_version: 1,
    created_at: new Date().toISOString(),
    source_user_version: sourceVersion,
    target_user_version: STORAGE_SCHEMA_VERSION,
    backup_sha256: fileSha256(backupPath),
    snapshot,
  };
  writeManifest(manifestPath, manifest);
  verifyBackup(backupPath, manifest, snapshot);
  return { backupPath, manifestPath };
}

function migrateLegacy(
  db: Database,
  migrationTimestamp: string,
  highWater: number,
  onCheckpoint?: (checkpoint: StorageMigrationCheckpoint) => void,
): void {
  db.exec("BEGIN IMMEDIATE");
  let committed = false;
  try {
    ensurePeerColumns(db);
    const oldColumns = storageTableColumns(db, "messages");
    if (oldColumns.size > 0) {
      createMessagesTable(db, "messages_v1");
      const deliveredAt = oldColumns.has("delivered_at") ? "delivered_at" : "NULL";
      const claimedBy = oldColumns.has("claimed_by") ? "claimed_by" : "NULL";
      const claimedAt = oldColumns.has("claimed_at") ? "claimed_at" : "NULL";
      const retentionAt = oldColumns.has("retention_at")
        ? "CASE WHEN delivered = 1 THEN COALESCE(retention_at, ?) ELSE retention_at END"
        : "CASE WHEN delivered = 1 THEN ? ELSE NULL END";
      db.prepare(`
        INSERT INTO messages_v1 (
          id, from_id, to_id, text, sent_at, delivered,
          delivered_at, retention_at, claimed_by, claimed_at
        )
        SELECT id, from_id, to_id, text, sent_at, delivered,
               ${deliveredAt}, ${retentionAt}, ${claimedBy}, ${claimedAt}
        FROM messages ORDER BY id
      `).run(migrationTimestamp);
      onCheckpoint?.("copy-complete");
      db.run("DROP TABLE messages");
      db.run("ALTER TABLE messages_v1 RENAME TO messages");
    } else {
      createMessagesTable(db);
    }
    db.run("DELETE FROM sqlite_sequence WHERE name='messages'");
    db.run("INSERT INTO sqlite_sequence(name, seq) VALUES('messages', ?)", [highWater]);
    createIndexes(db);
    onCheckpoint?.("before-version");
    db.run(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION}`);
    db.exec("COMMIT");
    committed = true;
    onCheckpoint?.("after-commit");
  } catch (error) {
    if (committed) throw new CommittedMigrationError(error);
    try { db.exec("ROLLBACK"); } catch { /* transaction may already be gone */ }
    throw error;
  }
}

function createFresh(db: Database): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    createPeersTable(db);
    createMessagesTable(db);
    createIndexes(db);
    db.run(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction may already be gone */ }
    throw error;
  }
}

function validateCurrentSchema(db: Database): void {
  const messageCols = storageTableColumns(db, "messages");
  for (const column of requiredMessageColumns) {
    if (!messageCols.has(column)) throw new Error(`storage v${STORAGE_SCHEMA_VERSION} is missing messages.${column}`);
  }
  const peerCols = storageTableColumns(db, "peers");
  if (!peerCols.has("non_targetable")) throw new Error(`storage v${STORAGE_SCHEMA_VERSION} is missing peers.non_targetable`);
  const indexes = new Set((db.query("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>).map((row) => row.name));
  for (const name of Object.values(storageIndexes)) {
    if (!indexes.has(name)) throw new Error(`storage v${STORAGE_SCHEMA_VERSION} is missing index ${name}`);
  }
  const foreignKeys = db.query("PRAGMA foreign_key_list(messages)").all();
  if (foreignKeys.length !== 0) throw new Error("messages table must not retain peer foreign keys");
  integrity(db);
}

export function initializeStorage(db: Database, options: InitializeStorageOptions): InitializeStorageResult {
  options.onReadiness?.("starting");
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 3000");
  const version = storageUserVersion(db);
  if (version > STORAGE_SCHEMA_VERSION) throw new Error(`database user_version ${version} is newer than supported ${STORAGE_SCHEMA_VERSION}`);
  if (version === STORAGE_SCHEMA_VERSION) {
    validateCurrentSchema(db);
    options.onReadiness?.("ready");
    return { version, migrated: false };
  }

  options.onReadiness?.("migrating");
  if (!schemaObjectsExist(db)) {
    createFresh(db);
    validateCurrentSchema(db);
    options.onReadiness?.("ready");
    return { version: STORAGE_SCHEMA_VERSION, migrated: true };
  }

  integrity(db);
  const before = storageSnapshot(db);
  const backupPath = resolve(options.backupPath ?? `${options.databasePath}.backup`);
  if (backupPath === resolve(options.databasePath)) throw new Error("backup path must differ from the live database path");
  const backup = createOrVerifyBackup(db, backupPath, version, before);
  options.onCheckpoint?.("backup-complete");
  const migrationTimestamp = options.migrationTimestamp ?? new Date().toISOString();
  try {
    migrateLegacy(db, migrationTimestamp, before.sequence_high_water, options.onCheckpoint);
    validateCurrentSchema(db);
    const after = storageSnapshot(db);
    if (!sameSnapshot(before, after)) {
      throw new Error("post-migration message/peer digest, partition, or sequence verification failed");
    }
  } catch (error) {
    if (error instanceof CommittedMigrationError || storageUserVersion(db) === STORAGE_SCHEMA_VERSION) {
      const original = error instanceof CommittedMigrationError ? error.originalError : error;
      throw new PostCommitStorageVerificationError(
        `post-commit storage verification failed: ${original instanceof Error ? original.message : String(original)}`,
        backup.backupPath,
        backup.manifestPath,
        original,
      );
    }
    throw error;
  }
  options.onReadiness?.("ready");
  return {
    version: STORAGE_SCHEMA_VERSION,
    migrated: true,
    backupPath: backup.backupPath,
    backupManifestPath: backup.manifestPath,
  };
}

function restoreVerifiedStorageBackup(
  options: { databasePath: string; backupPath: string },
  preserveClosedSidecars: boolean,
): { displacedPath?: string } {
  const databasePath = resolve(options.databasePath);
  const backupPath = resolve(options.backupPath);
  const manifestPath = `${backupPath}.manifest.json`;
  if (!existsSync(backupPath) || !existsSync(manifestPath)) throw new Error("verified backup and manifest are both required");
  const sidecarSuffixes = ["-wal", "-shm"].filter((suffix) => existsSync(`${databasePath}${suffix}`));
  if (!preserveClosedSidecars && sidecarSuffixes.length > 0) {
    throw new Error("refusing restore while SQLite WAL/SHM sidecars exist; stop and checkpoint the broker first");
  }
  const manifest = readManifest(manifestPath);
  verifyBackup(backupPath, manifest, manifest.snapshot);

  const tmp = `${databasePath}.restore-${process.pid}-${crypto.randomUUID()}`;
  copyFileSync(backupPath, tmp);
  chmodSync(tmp, 0o600);
  fsyncFile(tmp);
  if (fileSha256(tmp) !== manifest.backup_sha256) {
    rmSync(tmp, { force: true });
    throw new Error("restored temporary database checksum mismatch");
  }
  const restored = new Database(tmp, { readonly: true });
  try {
    integrity(restored);
    if (!sameSnapshot(storageSnapshot(restored), manifest.snapshot)) throw new Error("restored temporary database row digest mismatch");
  } finally {
    restored.close();
  }

  let displacedPath: string | undefined;
  try {
    if (existsSync(databasePath)) {
      displacedPath = `${databasePath}.pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      renameSync(databasePath, displacedPath);
      for (const suffix of sidecarSuffixes) renameSync(`${databasePath}${suffix}`, `${displacedPath}${suffix}`);
    }
    renameSync(tmp, databasePath);
    fsyncDirectory(dirname(databasePath));
  } catch (error) {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
    if (displacedPath && existsSync(displacedPath) && !existsSync(databasePath)) {
      renameSync(displacedPath, databasePath);
      for (const suffix of sidecarSuffixes) {
        if (existsSync(`${displacedPath}${suffix}`) && !existsSync(`${databasePath}${suffix}`)) {
          renameSync(`${displacedPath}${suffix}`, `${databasePath}${suffix}`);
        }
      }
    }
    fsyncDirectory(dirname(databasePath));
    throw error;
  }
  return displacedPath ? { displacedPath } : {};
}

export function restoreStorageBackup(options: { databasePath: string; backupPath: string }): { displacedPath?: string } {
  return restoreVerifiedStorageBackup(options, false);
}

export function restoreStorageAfterFailedMigration(options: { databasePath: string; backupPath: string }): { displacedPath?: string } {
  return restoreVerifiedStorageBackup(options, true);
}

export function retentionPurgeSql(): string {
  return `DELETE FROM messages INDEXED BY ${storageIndexes.deliveredRetention} WHERE delivered = 1 AND retention_at IS NOT NULL AND retention_at < ?`;
}

export function unknownReceiverPurgeSql(): string {
  return `DELETE FROM messages INDEXED BY ${storageIndexes.unknownReceiverRetention} WHERE delivered = 0 AND sent_at < ? AND to_id IN (SELECT id FROM peers WHERE receiver_mode = 'unknown')`;
}

export function staleUndeliveredPurgeSql(): string {
  return `DELETE FROM messages INDEXED BY ${storageIndexes.unknownReceiverRetention} WHERE delivered = 0 AND sent_at < ?`;
}

export function explainUsesIndex(db: Database, sql: string, params: Array<string | number | null>, indexName: string): boolean {
  const rows = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>;
  return rows.some((row) => row.detail.includes(indexName));
}
