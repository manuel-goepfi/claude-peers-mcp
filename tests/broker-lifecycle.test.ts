import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  acquireBrokerOwnership,
  BrokerOwnershipError,
  canonicalizeDatabasePath,
  readOwnerMetadata,
  verifyLifecycleIdentity,
  type BrokerLifecycleIdentity,
} from "../shared/broker-lifecycle.ts";
import { startTestBroker } from "./helpers/test-broker.ts";

const roots: string[] = [];
const brokerScriptPath = new URL("../broker.ts", import.meta.url).pathname;

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "claude-peers-owner-test-"));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("broker database lifetime ownership", () => {
  test("publishes complete owner-only metadata and rejects a second live owner", () => {
    const dir = root();
    const dbPath = join(dir, "broker.db");
    const owner = acquireBrokerOwnership({ databasePath: dbPath, brokerScriptPath });
    expect(owner.canonicalDatabasePath).toBe(canonicalizeDatabasePath(dbPath));
    expect(existsSync(owner.lockPath)).toBe(true);
    expect(lstatSync(owner.lockPath).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(owner.lockPath, "owner.json")).mode & 0o777).toBe(0o600);
    const metadata = readOwnerMetadata(owner.lockPath);
    expect(metadata.pid).toBe(process.pid);
    expect(metadata.instance_nonce).toBe(owner.metadata.instance_nonce);

    expect(() => acquireBrokerOwnership({ databasePath: dbPath, brokerScriptPath })).toThrow(BrokerOwnershipError);
    expect(owner.release()).toBe(true);
    expect(existsSync(owner.lockPath)).toBe(false);
  });

  test("verified-dead published owner is atomically displaced", () => {
    const dir = root();
    const dbPath = join(dir, "broker.db");
    const first = acquireBrokerOwnership({ databasePath: dbPath, brokerScriptPath });
    const stale = { ...readOwnerMetadata(first.lockPath), pid: 999_999_999, process_start: "1" };
    writeFileSync(join(first.lockPath, "owner.json"), `${JSON.stringify(stale)}\n`, { mode: 0o600 });

    const second = acquireBrokerOwnership({ databasePath: dbPath, brokerScriptPath });
    expect(second.metadata.instance_nonce).not.toBe(first.metadata.instance_nonce);
    expect(readOwnerMetadata(second.lockPath).instance_nonce).toBe(second.metadata.instance_nonce);
    expect(first.release()).toBe(false);
    expect(second.release()).toBe(true);
  });

  test("nonce mismatch prevents one owner from deleting another lock", () => {
    const dir = root();
    const owner = acquireBrokerOwnership({ databasePath: join(dir, "broker.db"), brokerScriptPath });
    const metadataPath = join(owner.lockPath, "owner.json");
    const original = readFileSync(metadataPath, "utf8");
    const replaced = { ...JSON.parse(original), instance_nonce: "replacement-owner-nonce" };
    writeFileSync(metadataPath, `${JSON.stringify(replaced)}\n`, { mode: 0o600 });

    expect(owner.release()).toBe(false);
    expect(existsSync(owner.lockPath)).toBe(true);
    writeFileSync(metadataPath, original, { mode: 0o600 });
    expect(owner.release()).toBe(true);
  });

  test("rejects a symlink database identity", () => {
    const dir = root();
    const target = join(dir, "real.db");
    writeFileSync(target, "");
    const link = join(dir, "linked.db");
    symlinkSync(target, link);
    expect(() => acquireBrokerOwnership({ databasePath: link, brokerScriptPath })).toThrow(/symlink/);
  });

  test("failures at every pre-publish checkpoint leave no visible lock", () => {
    const dir = root();
    for (const checkpointName of ["staging-created", "metadata-written", "staging-fsynced"] as const) {
      const dbPath = join(dir, `${checkpointName}.db`);
      expect(() => acquireBrokerOwnership({
        databasePath: dbPath,
        brokerScriptPath,
        onCheckpoint(checkpoint) {
          if (checkpoint === checkpointName) throw new Error("injected crash");
        },
      })).toThrow("injected crash");
      expect(existsSync(`${dbPath}.owner`)).toBe(false);
    }
  });

  test("failure immediately after publish leaves complete live-owner evidence", () => {
    const dir = root();
    const dbPath = join(dir, "post-publish.db");
    expect(() => acquireBrokerOwnership({
      databasePath: dbPath,
      brokerScriptPath,
      onCheckpoint(checkpoint) {
        if (checkpoint === "published") throw new Error("injected crash");
      },
    })).toThrow("injected crash");
    const lockPath = `${dbPath}.owner`;
    const metadata = readOwnerMetadata(lockPath);
    expect(metadata.pid).toBe(process.pid);
    expect(() => acquireBrokerOwnership({ databasePath: dbPath, brokerScriptPath })).toThrow(/live pid/);
    rmSync(lockPath, { recursive: true });
  });

  test("two broker ports cannot own the same database", async () => {
    const dir = root();
    const dbPath = join(dir, "shared.db");
    const first = await startTestBroker({
      root: dir,
      dbPath,
      tokenPath: join(dir, "first.token"),
      cleanupOnStop: false,
    });
    try {
      await expect(startTestBroker({
        root: dir,
        dbPath,
        tokenPath: join(dir, "second.token"),
        cleanupOnStop: false,
      })).rejects.toThrow(/already owned by live pid/);
    } finally {
      await first.stop();
    }
    expect(existsSync(`${dbPath}.owner`)).toBe(false);
  });

  test("authenticated lifecycle identity matches kernel listener and published owner", async () => {
    const dir = root();
    const live = await startTestBroker({
      root: dir,
      dbPath: join(dir, "identity.db"),
      tokenPath: join(dir, "identity.token"),
      cleanupOnStop: false,
    });
    try {
      const registration = await fetch(`${live.url}/register-cli`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid: process.pid }),
      }).then((response) => response.json()) as { id: string; token: string };
      const response = await fetch(`${live.url}/lifecycle-identity`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Peer-Token": registration.token },
        body: JSON.stringify({ id: registration.id }),
      });
      expect(response.status).toBe(200);
      const identity = await response.json() as BrokerLifecycleIdentity;
      expect(() => verifyLifecycleIdentity(identity, { port: live.port, brokerScriptPath })).not.toThrow();

      const unauthenticated = await fetch(`${live.url}/lifecycle-identity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: registration.id }),
      });
      expect(unauthenticated.status).toBe(401);
      const health = await fetch(`${live.url}/health`).then((item) => item.json()) as Record<string, unknown>;
      expect(health.pid).toBeUndefined();
      expect(health.database_path).toBeUndefined();
    } finally {
      await live.stop();
    }
  });

  test("same port with a different database loses the bind before creating storage", async () => {
    const dir = root();
    const first = await startTestBroker({
      root: dir,
      dbPath: join(dir, "first.db"),
      tokenPath: join(dir, "first.token"),
      cleanupOnStop: false,
    });
    const otherDb = join(dir, "must-not-exist.db");
    const contender = Bun.spawn(["bun", brokerScriptPath], {
      cwd: dirname(brokerScriptPath),
      env: {
        ...process.env,
        NODE_ENV: "test",
        CLAUDE_PEERS_PORT: String(first.port),
        CLAUDE_PEERS_DB: otherDb,
        CLAUDE_PEERS_BRIDGE_TOKEN_FILE: join(dir, "other.token"),
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      expect(await contender.exited).not.toBe(0);
      expect(existsSync(otherDb)).toBe(false);
      expect(existsSync(`${otherDb}.owner`)).toBe(false);
    } finally {
      contender.kill();
      await first.stop();
    }
  });

  test("non-targetable CLI identity stays hidden across a broker restart", async () => {
    const dir = root();
    const dbPath = join(dir, "restart.db");
    const tokenPath = join(dir, "restart.token");
    const first = await startTestBroker({ root: dir, dbPath, tokenPath, cleanupOnStop: false });
    const cli = await fetch(`${first.url}/register-cli`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pid: process.pid }),
    }).then((response) => response.json()) as { id: string };
    await first.stop();

    const second = await startTestBroker({ root: dir, dbPath, tokenPath, cleanupOnStop: false });
    const sleeper = Bun.spawn(["sleep", "60"]);
    try {
      const persisted = new Database(dbPath, { readonly: true });
      const row = persisted.query("SELECT non_targetable FROM peers WHERE id = ?").get(cli.id) as { non_targetable: number };
      persisted.close();
      expect(row.non_targetable).toBe(1);

      const ordinary = await fetch(`${second.url}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pid: sleeper.pid, cwd: "/restart-visible", git_root: null, tty: null, name: "restart-visible",
          tmux_session: null, tmux_window_index: null, tmux_window_name: null, summary: "",
        }),
      }).then((response) => response.json()) as { id: string; token: string };
      const peers = await fetch(`${second.url}/list-peers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Peer-Token": ordinary.token },
        body: JSON.stringify({ id: ordinary.id, scope: "machine", cwd: "/", git_root: null }),
      }).then((response) => response.json()) as Array<{ id: string }>;
      expect(peers.some((peer) => peer.id === cli.id)).toBe(false);
    } finally {
      sleeper.kill();
      await second.stop();
    }
  });
});
