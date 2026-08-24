import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  explainUsesIndex,
  initializeStorage,
  maximumSequenceHighWater,
  restoreStorageBackup,
  retentionPurgeSql,
  STORAGE_SCHEMA_VERSION,
  storageIndexes,
  storageTriggers,
  storageSnapshot,
  storageUserVersion,
  unknownReceiverPurgeSql,
  type StorageBackupManifest,
} from "../shared/storage.ts";

const roots: string[] = [];
const brokerScript = new URL("../broker.ts", import.meta.url).pathname;

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "claude-peers-storage-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function legacyDatabase(path: string): Database {
  const db = new Database(path);
  db.run(`
    CREATE TABLE peers (
      id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      git_root TEXT,
      tty TEXT,
      summary TEXT NOT NULL DEFAULT '',
      registered_at TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      non_targetable INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      text TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      delivered_at TEXT,
      claimed_by TEXT,
      claimed_at TEXT,
      FOREIGN KEY (from_id) REFERENCES peers(id),
      FOREIGN KEY (to_id) REFERENCES peers(id)
    )
  `);
  const now = "2026-07-10T00:00:00.000Z";
  db.run("INSERT INTO peers (id,pid,cwd,summary,registered_at,last_seen,non_targetable) VALUES ('p1',101,'/one','',?,?,0)", [now, now]);
  db.run("INSERT INTO peers (id,pid,cwd,summary,registered_at,last_seen,non_targetable) VALUES ('cli-old',102,'','',?,?,1)", [now, now]);
  const insert = db.prepare("INSERT INTO messages (id,from_id,to_id,text,sent_at,delivered,delivered_at,claimed_by,claimed_at) VALUES (?,?,?,?,?,?,?,?,?)");
  insert.run(2, "p1", "p1", "queued \0 unicode 🦊", now, 0, null, null, null);
  insert.run(5, "p1", "p1", "claimed", now, 0, null, "drain-old", "2026-07-10T00:01:00.000Z");
  insert.run(9, "gone-sender", "gone-target", "legacy delivered without timestamp", now, 1, null, null, null);
  insert.run(12, "p1", "gone-target", "delivered with timestamp", now, 1, "2026-07-10T00:02:00.000Z", null, null);
  insert.run(50, "p1", "p1", "deleted high water", now, 0, null, null, null);
  db.run("DELETE FROM messages WHERE id=50");
  return db;
}

describe("versioned historical-message migration", () => {
  test("sequence high-water calculation stays bounded for million-row histories", () => {
    const ids = Array.from({ length: 1_000_000 }, (_, index) => index + 1);
    expect(maximumSequenceHighWater(5, ids)).toBe(1_000_000);
    expect(maximumSequenceHighWater(1_000_001, ids)).toBe(1_000_001);
  });

  test("fresh database creates the final schema without a legacy backup", () => {
    const dir = root();
    const dbPath = join(dir, "fresh.db");
    const db = new Database(dbPath);
    const result = initializeStorage(db, { databasePath: dbPath });
    expect(result).toMatchObject({ version: STORAGE_SCHEMA_VERSION, migrated: true });
    expect(result.backupPath).toBeUndefined();
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(STORAGE_SCHEMA_VERSION);
    expect(db.query("PRAGMA foreign_key_list(messages)").all()).toHaveLength(0);
    expect(db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?").get(storageTriggers.unreadEpisode)).toEqual({ name: storageTriggers.unreadEpisode });
    expect(() => initializeStorage(db, { databasePath: dbPath })).not.toThrow();
    db.close();
  });

  test("correlation uniqueness is owner-scoped and reply-direction-scoped", () => {
    const dir = root();
    const dbPath = join(dir, "correlation-uniqueness.db");
    const db = new Database(dbPath);
    initializeStorage(db, { databasePath: dbPath });
    const insert = db.prepare(`INSERT INTO messages
      (from_id,to_id,text,sent_at,delivered,request_id,reply_to_id)
      VALUES (?,?,?,'2026-08-24T00:00:00.000Z',0,?,?)`);

    insert.run("alice", "bob", "request", "same-request", null);
    expect(() => insert.run("alice", "carol", "conflict", "same-request", null)).toThrow();
    expect(() => insert.run("other", "bob", "allowed", "same-request", null)).not.toThrow();

    insert.run("bob", "alice", "reply", "reply-one", "same-request");
    expect(() => insert.run("bob", "alice", "second reply", "reply-two", "same-request")).toThrow();
    expect(() => insert.run("carol", "other", "independent direction", "reply-three", "same-request")).not.toThrow();
    db.close();
  });

  test("unread episodes distinguish same-millisecond overlap from drain and refill", () => {
    const dir = root();
    const dbPath = join(dir, "unread-episodes.db");
    const db = new Database(dbPath);
    initializeStorage(db, { databasePath: dbPath });
    db.run(`INSERT INTO peers (id,pid,cwd,summary,registered_at,last_seen)
      VALUES ('receiver',1,'/','','2026-08-12T00:00:00.000Z','2026-08-12T00:00:00.000Z')`);
    const send = db.prepare(`INSERT INTO messages (from_id,to_id,text,sent_at,delivered)
      VALUES ('sender','receiver',?,'2026-08-12T00:00:00.000Z',0)`);

    send.run("first");
    send.run("overlap-before-partial-ack");
    expect(db.query("SELECT unread_episode FROM peers WHERE id='receiver'").get()).toEqual({ unread_episode: 1 });
    db.run("UPDATE messages SET delivered=1 WHERE text='first'");
    expect(db.query("SELECT unread_episode FROM peers WHERE id='receiver'").get()).toEqual({ unread_episode: 1 });

    db.run("UPDATE messages SET delivered=1 WHERE to_id='receiver'");
    send.run("refill-after-zero");
    expect(db.query("SELECT unread_episode FROM peers WHERE id='receiver'").get()).toEqual({ unread_episode: 2 });
    db.close();
  });

  test("current-version startup additively restores the episode column and trigger", () => {
    const dir = root();
    const dbPath = join(dir, "current-additive.db");
    const db = new Database(dbPath);
    initializeStorage(db, { databasePath: dbPath });
    db.run(`DROP TRIGGER ${storageTriggers.unreadEpisode}`);
    db.run("ALTER TABLE peers DROP COLUMN unread_episode");
    expect(storageUserVersion(db)).toBe(STORAGE_SCHEMA_VERSION);

    expect(initializeStorage(db, { databasePath: dbPath })).toMatchObject({
      version: STORAGE_SCHEMA_VERSION,
      migrated: false,
    });
    expect(db.query("PRAGMA table_info(peers)").all())
      .toContainEqual(expect.objectContaining({ name: "unread_episode" }));
    expect(db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?").get(storageTriggers.unreadEpisode))
      .toEqual({ name: storageTriggers.unreadEpisode });

    db.run(`INSERT INTO peers (id,pid,cwd,summary,registered_at,last_seen)
      VALUES ('receiver',1,'/','','2026-08-12T00:00:00.000Z','2026-08-12T00:00:00.000Z')`);
    db.run(`INSERT INTO messages (from_id,to_id,text,sent_at,delivered)
      VALUES ('sender','receiver','first','2026-08-12T00:00:00.000Z',0)`);
    db.run(`INSERT INTO messages (from_id,to_id,text,sent_at,delivered)
      VALUES ('sender','receiver','overlap','2026-08-12T00:00:00.000Z',0)`);
    expect(db.query("SELECT unread_episode FROM peers WHERE id='receiver'").get()).toEqual({ unread_episode: 1 });
    db.close();
  });

  test("legacy rebuild preserves ids, bytes, claims, history, flags, and sequence high-water", () => {
    const dir = root();
    const dbPath = join(dir, "legacy.db");
    const backupPath = join(dir, "legacy.backup");
    const migrationTimestamp = "2026-07-10T12:34:56.000Z";
    const db = legacyDatabase(dbPath);
    const before = storageSnapshot(db);
    const readiness: string[] = [];

    const result = initializeStorage(db, {
      databasePath: dbPath,
      backupPath,
      migrationTimestamp,
      onReadiness(state) { readiness.push(state); },
    });
    expect(result).toMatchObject({ version: STORAGE_SCHEMA_VERSION, migrated: true, backupPath });
    expect(readiness).toEqual(["starting", "migrating", "ready"]);
    expect(storageSnapshot(db)).toEqual(before);
    expect(db.query("PRAGMA foreign_key_list(messages)").all()).toHaveLength(0);
    expect((db.query("SELECT non_targetable FROM peers WHERE id='cli-old'").get() as { non_targetable: number }).non_targetable).toBe(1);

    const rows = db.query("SELECT id,text,delivered_at,retention_at,claimed_by,claimed_at FROM messages ORDER BY id").all() as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.id)).toEqual([2, 5, 9, 12]);
    expect(rows[0]?.text).toBe("queued \0 unicode 🦊");
    expect(rows[1]).toMatchObject({ claimed_by: "drain-old", claimed_at: "2026-07-10T00:01:00.000Z", retention_at: null });
    expect(rows[2]).toMatchObject({ delivered_at: null, retention_at: migrationTimestamp });
    expect(rows[3]).toMatchObject({ delivered_at: "2026-07-10T00:02:00.000Z", retention_at: migrationTimestamp });

    db.run("INSERT INTO messages (from_id,to_id,text,sent_at,delivered) VALUES ('p1','p1','next','2026-07-10T13:00:00Z',0)");
    expect((db.query("SELECT MAX(id) AS id FROM messages").get() as { id: number }).id).toBe(51);
    db.run("DELETE FROM messages WHERE id=51");

    expect(lstatSync(backupPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(`${backupPath}.manifest.json`).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(readFileSync(`${backupPath}.manifest.json`, "utf8")) as StorageBackupManifest;
    expect(manifest.source_user_version).toBe(0);
    expect(manifest.target_user_version).toBe(STORAGE_SCHEMA_VERSION);
    expect(manifest.snapshot).toEqual(before);
    const backup = new Database(backupPath, { readonly: true });
    expect(storageSnapshot(backup)).toEqual(before);
    expect((backup.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(0);
    backup.close();

    const afterFirst = storageSnapshot(db);
    expect(initializeStorage(db, { databasePath: dbPath, backupPath }).migrated).toBe(false);
    expect(storageSnapshot(db)).toEqual(afterFirst);
    db.close();
  });

  test("v1 to v2 migration rolls over an older verified backup without changing it", () => {
    const dir = root();
    const dbPath = join(dir, "v1-live.db");
    const backupPath = join(dir, "retained.backup");
    const oldBackup = legacyDatabase(backupPath);
    const currentShape = storageSnapshot(oldBackup);
    const oldSnapshot = storageSnapshot(oldBackup, { includeCorrelation: false });
    expect(oldSnapshot.message_digest).not.toBe(currentShape.message_digest);
    oldBackup.close();
    chmodSync(backupPath, 0o600);
    const oldManifest: StorageBackupManifest = {
      manifest_version: 1,
      created_at: "2026-08-01T00:00:00.000Z",
      source_user_version: 0,
      target_user_version: 1,
      backup_sha256: createHash("sha256").update(readFileSync(backupPath)).digest("hex"),
      snapshot: oldSnapshot,
    };
    writeFileSync(`${backupPath}.manifest.json`, `${JSON.stringify(oldManifest, null, 2)}\n`, { mode: 0o600 });
    chmodSync(`${backupPath}.manifest.json`, 0o600);
    const retainedDatabaseBytes = readFileSync(backupPath);
    const retainedManifestBytes = readFileSync(`${backupPath}.manifest.json`);

    const db = legacyDatabase(dbPath);
    db.run("ALTER TABLE peers ADD COLUMN receiver_mode TEXT NOT NULL DEFAULT 'unknown'");
    db.run("ALTER TABLE peers ADD COLUMN seat_key TEXT");
    db.run("ALTER TABLE peers ADD COLUMN thread_id TEXT");
    db.run(`CREATE INDEX ${storageIndexes.peerReceiverMode} ON peers(receiver_mode)`);
    db.run(`CREATE INDEX ${storageIndexes.peerSeatKey} ON peers(seat_key)`);
    db.run(`CREATE INDEX ${storageIndexes.peerThreadId} ON peers(thread_id)`);
    db.run("PRAGMA user_version = 1");
    const before = storageSnapshot(db);
    const result = initializeStorage(db, { databasePath: dbPath, backupPath });
    const rolloverPath = `${backupPath}.v1-to-v2`;

    expect(result).toMatchObject({
      version: STORAGE_SCHEMA_VERSION,
      migrated: true,
      backupPath: rolloverPath,
      backupManifestPath: `${rolloverPath}.manifest.json`,
    });
    expect(storageSnapshot(db)).toEqual(before);
    expect(readFileSync(backupPath)).toEqual(retainedDatabaseBytes);
    expect(readFileSync(`${backupPath}.manifest.json`)).toEqual(retainedManifestBytes);
    expect(lstatSync(rolloverPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(`${rolloverPath}.manifest.json`).mode & 0o777).toBe(0o600);
    const rolloverManifest = JSON.parse(readFileSync(`${rolloverPath}.manifest.json`, "utf8")) as StorageBackupManifest;
    expect(rolloverManifest.source_user_version).toBe(1);
    expect(rolloverManifest.target_user_version).toBe(2);
    expect(db.query("PRAGMA table_info(messages)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "request_id" }),
      expect.objectContaining({ name: "reply_to_id" }),
    ]));
    expect(db.query("SELECT name,sql FROM sqlite_master WHERE type='index' AND name IN (?,?,?) ORDER BY name")
      .all(storageIndexes.peerReceiverMode, storageIndexes.peerSeatKey, storageIndexes.peerThreadId))
      .toEqual([
        { name: storageIndexes.peerReceiverMode, sql: `CREATE INDEX ${storageIndexes.peerReceiverMode} ON peers(receiver_mode, id)` },
        { name: storageIndexes.peerSeatKey, sql: `CREATE INDEX ${storageIndexes.peerSeatKey} ON peers(seat_key)` },
        { name: storageIndexes.peerThreadId, sql: `CREATE INDEX ${storageIndexes.peerThreadId} ON peers(thread_id)` },
      ].sort((a, b) => a.name.localeCompare(b.name)));
    db.close();
  });

  test("a derived versioned backup path can never alias the live database", () => {
    const dir = root();
    const backupPath = join(dir, "collision.backup");
    const dbPath = `${backupPath}.v1-to-v2`;
    const retained = legacyDatabase(backupPath);
    const retainedSnapshot = storageSnapshot(retained, { includeCorrelation: false });
    retained.close();
    chmodSync(backupPath, 0o600);
    const retainedManifest: StorageBackupManifest = {
      manifest_version: 1,
      created_at: "2026-08-01T00:00:00.000Z",
      source_user_version: 0,
      target_user_version: 1,
      backup_sha256: createHash("sha256").update(readFileSync(backupPath)).digest("hex"),
      snapshot: retainedSnapshot,
    };
    writeFileSync(`${backupPath}.manifest.json`, `${JSON.stringify(retainedManifest, null, 2)}\n`, { mode: 0o600 });
    chmodSync(`${backupPath}.manifest.json`, 0o600);

    const live = legacyDatabase(dbPath);
    live.run("PRAGMA user_version = 1");
    expect(() => initializeStorage(live, { databasePath: dbPath, backupPath }))
      .toThrow("versioned backup path must differ from the live database path");
    expect(storageUserVersion(live)).toBe(1);
    live.close();
  });

  test("partial v0 schema backfills only missing delivered retention anchors", () => {
    const dir = root();
    const dbPath = join(dir, "partial-v0.db");
    const migrationTimestamp = "2026-07-10T12:34:56.000Z";
    const preservedAnchor = "2026-07-01T00:00:00.000Z";
    const db = new Database(dbPath);
    db.run("CREATE TABLE peers (id TEXT PRIMARY KEY,pid INTEGER NOT NULL,cwd TEXT NOT NULL,git_root TEXT,tty TEXT,summary TEXT NOT NULL DEFAULT '',registered_at TEXT NOT NULL,last_seen TEXT NOT NULL)");
    db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT,from_id TEXT NOT NULL,to_id TEXT NOT NULL,text TEXT NOT NULL,sent_at TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0,delivered_at TEXT,retention_at TEXT,claimed_by TEXT,claimed_at TEXT)");
    db.run("INSERT INTO peers VALUES ('p',1,'/',NULL,NULL,'','2026','2026')");
    db.run("INSERT INTO messages (from_id,to_id,text,sent_at,delivered,delivered_at,retention_at) VALUES ('p','p','missing','2026',1,NULL,NULL)");
    db.run("INSERT INTO messages (from_id,to_id,text,sent_at,delivered,delivered_at,retention_at) VALUES ('p','p','preserved','2026',1,'2026',?)", [preservedAnchor]);
    db.run("INSERT INTO messages (from_id,to_id,text,sent_at,delivered,retention_at) VALUES ('p','p','queued','2026',0,NULL)");

    initializeStorage(db, { databasePath: dbPath, backupPath: join(dir, "partial-v0.backup"), migrationTimestamp });
    const rows = db.query("SELECT text,retention_at FROM messages ORDER BY id").all() as Array<{ text: string; retention_at: string | null }>;
    expect(rows).toEqual([
      { text: "missing", retention_at: migrationTimestamp },
      { text: "preserved", retention_at: preservedAnchor },
      { text: "queued", retention_at: null },
    ]);
    expect(initializeStorage(db, { databasePath: dbPath }).migrated).toBe(false);
    expect(db.query("SELECT text,retention_at FROM messages ORDER BY id").all()).toEqual(rows);
    db.close();
  });

  test("pre-commit interruption rolls back and reuses the verified backup", () => {
    const dir = root();
    const dbPath = join(dir, "rollback.db");
    const backupPath = join(dir, "rollback.backup");
    const db = legacyDatabase(dbPath);
    const before = storageSnapshot(db);
    expect(() => initializeStorage(db, {
      databasePath: dbPath,
      backupPath,
      onCheckpoint(checkpoint) {
        if (checkpoint === "before-version") throw new Error("injected pre-commit stop");
      },
    })).toThrow("injected pre-commit stop");
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(0);
    expect(storageSnapshot(db)).toEqual(before);
    expect(existsSync(backupPath)).toBe(true);
    expect(initializeStorage(db, { databasePath: dbPath, backupPath }).version).toBe(STORAGE_SCHEMA_VERSION);
    db.close();
  });

  test("post-commit interruption is recognized as a complete migration on restart", () => {
    const dir = root();
    const dbPath = join(dir, "post-commit.db");
    const backupPath = join(dir, "post-commit.backup");
    const db = legacyDatabase(dbPath);
    expect(() => initializeStorage(db, {
      databasePath: dbPath,
      backupPath,
      onCheckpoint(checkpoint) {
        if (checkpoint === "after-commit") throw new Error("injected post-commit stop");
      },
    })).toThrow("injected post-commit stop");
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(STORAGE_SCHEMA_VERSION);
    expect(initializeStorage(db, { databasePath: dbPath, backupPath }).migrated).toBe(false);
    db.close();
  });

  test("broker automatically restores the verified backup after a post-commit failure", async () => {
    const dir = root();
    const dbPath = join(dir, "automatic-restore.db");
    const backupPath = join(dir, "automatic-restore.backup");
    const legacy = legacyDatabase(dbPath);
    const before = storageSnapshot(legacy);
    legacy.close();
    const proc = Bun.spawn(["bun", brokerScript], {
      env: {
        ...process.env,
        HOME: dir,
        NODE_ENV: "test",
        CLAUDE_PEERS_PORT: "0",
        CLAUDE_PEERS_TEST_PORT_ZERO: "1",
        CLAUDE_PEERS_DB: dbPath,
        CLAUDE_PEERS_BACKUP: backupPath,
        CLAUDE_PEERS_BRIDGE_TOKEN_FILE: join(dir, "automatic-restore.token"),
        CLAUDE_PEERS_TEST_FAIL_AFTER_MIGRATION_COMMIT: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("restored verified backup");
    const restored = new Database(dbPath, { readonly: true });
    expect(storageUserVersion(restored)).toBe(0);
    expect(storageSnapshot(restored)).toEqual(before);
    restored.close();
    expect(readdirSync(dir).some((name) => name.startsWith("automatic-restore.db.pre-restore-"))).toBe(true);
  });

  test("large legacy table without sqlite_sequence migrates with exact gaps and future ids", () => {
    const dir = root();
    const dbPath = join(dir, "large-no-sequence.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE peers (id TEXT PRIMARY KEY,pid INTEGER NOT NULL,cwd TEXT NOT NULL,git_root TEXT,tty TEXT,summary TEXT NOT NULL DEFAULT '',registered_at TEXT NOT NULL,last_seen TEXT NOT NULL)");
    db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY,from_id TEXT NOT NULL,to_id TEXT NOT NULL,text TEXT NOT NULL,sent_at TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0)");
    db.run("INSERT INTO peers VALUES ('p',1,'/',NULL,NULL,'','2026','2026')");
    const insert = db.prepare("INSERT INTO messages (id,from_id,to_id,text,sent_at,delivered) VALUES (?,'p','p',?,'2026',0)");
    db.transaction(() => {
      for (let id = 1; id <= 750; id++) {
        if (id % 11 !== 0) insert.run(id, `payload-${id}-🦊`);
      }
    })();
    expect((db.query("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get())).toBeNull();
    const before = storageSnapshot(db);
    initializeStorage(db, { databasePath: dbPath, backupPath: join(dir, "large.backup") });
    expect(storageSnapshot(db)).toEqual(before);
    db.run("INSERT INTO messages (from_id,to_id,text,sent_at,delivered) VALUES ('p','p','next','2027',0)");
    expect((db.query("SELECT MAX(id) AS id FROM messages").get() as { id: number }).id).toBe(751);
    db.close();
  });

  test("bound broker reports migrating and returns 503 before operational routes become ready", async () => {
    const dir = root();
    const dbPath = join(dir, "readiness.db");
    legacyDatabase(dbPath).close();
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
    const port = probe.port!;
    probe.stop(true);
    const proc = Bun.spawn(["bun", brokerScript], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        CLAUDE_PEERS_PORT: String(port),
        CLAUDE_PEERS_DB: dbPath,
        CLAUDE_PEERS_BACKUP: join(dir, "readiness.backup"),
        CLAUDE_PEERS_BRIDGE_TOKEN_FILE: join(dir, "readiness.token"),
        CLAUDE_PEERS_TEST_MIGRATION_PAUSE_MS: "600",
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    try {
      let response: Response | null = null;
      const deadline = Date.now() + 1000;
      while (!response && Date.now() < deadline) {
        try { response = await fetch(`http://127.0.0.1:${port}/health`); } catch { await Bun.sleep(20); }
      }
      expect(response?.status).toBe(503);
      expect(await response!.json()).toEqual({ status: "migrating", ready: false, schema_version: STORAGE_SCHEMA_VERSION });
      const operational = await fetch(`http://127.0.0.1:${port}/list-peers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(operational.status).toBe(503);

      let ready = false;
      const readyDeadline = Date.now() + 4000;
      while (!ready && Date.now() < readyDeadline) {
        await Bun.sleep(50);
        try { ready = (await fetch(`http://127.0.0.1:${port}/health`)).status === 200; } catch { /* keep waiting */ }
      }
      expect(ready).toBe(true);
    } finally {
      proc.kill("SIGTERM");
      await proc.exited;
    }
  });

  test("offline restore atomically reinstates the independently verified legacy snapshot", () => {
    const dir = root();
    const dbPath = join(dir, "restore.db");
    const backupPath = join(dir, "restore.backup");
    const db = legacyDatabase(dbPath);
    const before = storageSnapshot(db);
    initializeStorage(db, { databasePath: dbPath, backupPath });
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });

    const restored = restoreStorageBackup({ databasePath: dbPath, backupPath });
    expect(restored.displacedPath && existsSync(restored.displacedPath)).toBe(true);
    const legacy = new Database(dbPath, { readonly: true });
    expect((legacy.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(0);
    expect(storageSnapshot(legacy)).toEqual(before);
    legacy.close();
  });
});

describe("retention and index contracts", () => {
  test("peer deletion retains historical messages because the final schema has no peer foreign keys", () => {
    const db = new Database(":memory:");
    initializeStorage(db, { databasePath: ":memory:" });
    db.run("INSERT INTO peers (id,pid,cwd,summary,registered_at,last_seen) VALUES ('gone',1,'/','','2026','2026')");
    db.run("INSERT INTO messages (from_id,to_id,text,sent_at,delivered,delivered_at,retention_at) VALUES ('gone','gone','history','2026',1,'2026','2026')");
    db.run("DELETE FROM peers WHERE id='gone'");
    expect((db.query("SELECT text FROM messages").get() as { text: string }).text).toBe("history");
    db.close();
  });

  test("delivered TTL uses retention_at rather than unknown legacy delivered_at", () => {
    const db = new Database(":memory:");
    initializeStorage(db, { databasePath: ":memory:" });
    db.run("INSERT INTO peers (id,pid,cwd,summary,registered_at,last_seen) VALUES ('p',1,'/','','2026-01-01','2026-01-01')");
    db.run("INSERT INTO messages (id,from_id,to_id,text,sent_at,delivered,delivered_at,retention_at) VALUES (1,'p','p','keep','2020',1,NULL,'2030')");
    db.run("INSERT INTO messages (id,from_id,to_id,text,sent_at,delivered,delivered_at,retention_at) VALUES (2,'p','p','purge','2020',1,'2020','2020')");
    expect(db.run(retentionPurgeSql(), ["2025"]).changes).toBe(1);
    expect((db.query("SELECT text FROM messages").get() as { text: string }).text).toBe("keep");
    db.close();
  });

  test("query plans use the dedicated storage indexes", () => {
    const db = new Database(":memory:");
    initializeStorage(db, { databasePath: ":memory:" });
    expect(explainUsesIndex(
      db,
      "SELECT * FROM messages WHERE to_id=? AND delivered=0 AND (claimed_at IS NULL OR claimed_at < ?) ORDER BY sent_at",
      ["p", "2026"],
      storageIndexes.recipientQueue,
    )).toBe(true);
    expect(explainUsesIndex(
      db,
      "SELECT id FROM messages WHERE from_id=? ORDER BY id",
      ["p"],
      storageIndexes.senderStatus,
    )).toBe(true);
    expect(explainUsesIndex(
      db,
      retentionPurgeSql(),
      ["2026"],
      storageIndexes.deliveredRetention,
    )).toBe(true);
    expect(explainUsesIndex(
      db,
      retentionPurgeSql(),
      ["2026"],
      storageIndexes.replyUniqueness,
    )).toBe(true);
    expect(explainUsesIndex(
      db,
      "SELECT id FROM messages WHERE from_id=? AND request_id=? AND request_id IS NOT NULL",
      ["p", "request-1"],
      storageIndexes.requestIdempotency,
    )).toBe(true);
    expect(explainUsesIndex(
      db,
      unknownReceiverPurgeSql(),
      ["2026"],
      storageIndexes.unknownReceiverRetention,
    )).toBe(true);
    expect(explainUsesIndex(
      db,
      "SELECT id FROM peers WHERE receiver_mode=?",
      ["unknown"],
      storageIndexes.peerReceiverMode,
    )).toBe(true);
    db.close();
  });
});
