import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStorage } from "../shared/storage.ts";

const doctor = new URL("../bin/peers-doctor.ts", import.meta.url).pathname;
const doctorWrapper = new URL("../bin/peers-doctor.sh", import.meta.url).pathname;
const doctorLibrary = new URL("../shared/doctor.ts", import.meta.url).pathname;
const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function fixtureDatabase(): { home: string; dbPath: string } {
  const home = mkdtempSync(join(tmpdir(), "claude-peers-doctor-"));
  roots.add(home);
  mkdirSync(join(home, ".claude"), { recursive: true, mode: 0o700 });
  const dbPath = join(home, "peers.db");
  const db = new Database(dbPath);
  initializeStorage(db, { databasePath: dbPath });
  db.close();
  return { home, dbPath };
}

async function runDoctor(port: number, fixture: { home: string; dbPath: string }, json = false): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn([process.execPath, doctor, ...(json ? ["--json"] : [])], {
    cwd: fixture.home,
    env: {
      ...process.env,
      HOME: fixture.home,
      PATH: join(fixture.home, "empty-bin"),
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: fixture.dbPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

function healthServer(requests: Array<{ method: string; path: string }>): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });
      return Response.json({
        status: "ok",
        ready: true,
        peers: 2,
        version: "0.1.0",
        schema_version: 1,
        capabilities: { hookDrain: { claimByPid: true, ackByPid: true, hookHeartbeatByPid: true } },
      });
    },
  });
}

function stateSnapshot(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    return JSON.stringify({
      messages: db.query("SELECT id, delivered, delivered_at, claimed_by, claimed_at FROM messages ORDER BY id").all(),
      receivers: db.query("SELECT id, last_hook_seen_at, last_drain_at, last_drain_error FROM peers ORDER BY id").all(),
    });
  } finally {
    db.close();
  }
}

describe("peers doctor safety", () => {
  test("all doctor source is limited to the coarse health endpoint", () => {
    const source = [doctorWrapper, doctor, doctorLibrary].map((path) => readFileSync(path, "utf8")).join("\n");
    expect(source).toContain("/health");
    for (const forbidden of ["/poll-by-pid", "/claim-by-pid", "/ack-by-pid", "/hook-heartbeat-by-pid", "/poll-messages", "/ack-messages"]) {
      expect(source).not.toContain(forbidden);
    }
  });

  test("healthy broker receives one GET and doctor needs neither jq nor sqlite3", async () => {
    const fixture = fixtureDatabase();
    const requests: Array<{ method: string; path: string }> = [];
    const server = healthServer(requests);
    try {
      const result = await runDoctor(server.port!, fixture);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("broker: ready version=0.1.0 schema=1");
      expect(result.output).toContain("database: ready schema=1");
      expect(requests).toEqual([{ method: "GET", path: "/health" }]);
    } finally {
      server.stop(true);
    }
  });

  test("human and JSON modes leave queue and receiver-health fields byte-identical", async () => {
    const fixture = fixtureDatabase();
    const db = new Database(fixture.dbPath);
    const now = new Date().toISOString();
    db.run("INSERT INTO peers (id, pid, cwd, client_type, receiver_mode, registered_at, last_seen, last_hook_seen_at, last_drain_at, last_drain_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ["sender", process.pid, "/sender", "claude", "claude-channel", now, now, now, now, null]);
    db.run("INSERT INTO peers (id, pid, cwd, client_type, receiver_mode, registered_at, last_seen, last_hook_seen_at, last_drain_at, last_drain_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ["receiver", process.pid + 1, "/receiver", "codex", "codex-hook", now, now, now, null, "kept-error"]);
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered, claimed_by, claimed_at) VALUES (?, ?, ?, ?, 0, NULL, NULL)", ["sender", "receiver", "secret queued text", now]);
    db.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered, claimed_by, claimed_at) VALUES (?, ?, ?, ?, 0, ?, ?)", ["sender", "receiver", "secret claimed text", now, "lease", now]);
    db.close();
    const before = stateSnapshot(fixture.dbPath);
    const requests: Array<{ method: string; path: string }> = [];
    const server = healthServer(requests);
    try {
      const human = await runDoctor(server.port!, fixture);
      const json = await runDoctor(server.port!, fixture, true);
      expect(human.exitCode).toBe(0);
      expect(json.exitCode).toBe(0);
      expect(JSON.parse(json.output).database.aggregates.queue).toEqual({ queued: 1, claimed: 1, acknowledged: 0, total: 2 });
      expect(human.output).not.toContain("secret");
      expect(json.output).not.toContain("secret");
      expect(stateSnapshot(fixture.dbPath)).toBe(before);
      expect(requests).toEqual([{ method: "GET", path: "/health" }, { method: "GET", path: "/health" }]);
    } finally {
      server.stop(true);
    }
  });

  test("unreachable broker remains a critical failure after one health read", async () => {
    const fixture = fixtureDatabase();
    const requests: Array<{ method: string; path: string }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push({ method: request.method, path: url.pathname });
        return new Response("unavailable", { status: 503 });
      },
    });
    try {
      const result = await runDoctor(server.port!, fixture);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("broker: unreachable");
      expect(requests).toEqual([{ method: "GET", path: "/health" }]);
    } finally {
      server.stop(true);
    }
  });
});
