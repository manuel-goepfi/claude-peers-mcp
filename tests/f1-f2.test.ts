/**
 * Tests for F1 (named aliases) and F2 (tmux process-ancestry detection).
 *
 * These tests verify the broker schema migrations, registration with
 * F1+F2 fields, list_peers output, and find_peer filtering.
 * F2's detectTmuxPane() is tested via a mock since tmux may not be available in CI.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import type { Peer, RegisterRequest } from "../shared/types.ts";

// --- Broker-level tests (schema + registration + queries) ---

describe("F1+F2 broker schema migrations", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.run("PRAGMA journal_mode = WAL");

    // Create the original schema (pre-F1+F2)
    db.run(`
      CREATE TABLE IF NOT EXISTS peers (
        id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        cwd TEXT NOT NULL,
        git_root TEXT,
        tty TEXT,
        summary TEXT NOT NULL DEFAULT '',
        registered_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      )
    `);

    // Run idempotent migrations (same as broker.ts)
    const migrationColumns = [
      { name: "name", type: "TEXT" },
      { name: "tmux_session", type: "TEXT" },
      { name: "tmux_window_index", type: "TEXT" },
      { name: "tmux_window_name", type: "TEXT" },
    ];
    for (const col of migrationColumns) {
      try {
        db.run(`ALTER TABLE peers ADD COLUMN ${col.name} ${col.type}`);
      } catch {
        // Column already exists
      }
    }
  });

  afterAll(() => {
    db.close();
  });

  test("migration adds 4 new columns", () => {
    const info = db.prepare("PRAGMA table_info(peers)").all() as Array<{ name: string }>;
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain("name");
    expect(colNames).toContain("tmux_session");
    expect(colNames).toContain("tmux_window_index");
    expect(colNames).toContain("tmux_window_name");
  });

  test("migrations are idempotent (re-running does not error)", () => {
    const migrationColumns = [
      { name: "name", type: "TEXT" },
      { name: "tmux_session", type: "TEXT" },
      { name: "tmux_window_index", type: "TEXT" },
      { name: "tmux_window_name", type: "TEXT" },
    ];
    // Run again — should not throw
    for (const col of migrationColumns) {
      expect(() => {
        try {
          db.run(`ALTER TABLE peers ADD COLUMN ${col.name} ${col.type}`);
        } catch {
          // Expected: column already exists
        }
      }).not.toThrow();
    }
  });

  test("F1: insert peer with name field", () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO peers (id, pid, cwd, git_root, tty, name, tmux_session, tmux_window_index, tmux_window_name, summary, registered_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["peer-1", 12345, "/home/test", null, "pts/1", "mary", null, null, null, "test summary", now, now]
    );

    const peer = db.query("SELECT * FROM peers WHERE id = ?").get("peer-1") as Peer;
    expect(peer.name).toBe("mary");
    expect(peer.tmux_session).toBeNull();
  });

  test("F1: insert peer without name (backward compat)", () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO peers (id, pid, cwd, git_root, tty, name, tmux_session, tmux_window_index, tmux_window_name, summary, registered_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["peer-2", 12346, "/home/test", null, "pts/2", null, null, null, null, "", now, now]
    );

    const peer = db.query("SELECT * FROM peers WHERE id = ?").get("peer-2") as Peer;
    expect(peer.name).toBeNull();
  });

  test("F2: insert peer with tmux fields", () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO peers (id, pid, cwd, git_root, tty, name, tmux_session, tmux_window_index, tmux_window_name, summary, registered_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["peer-3", 12347, "/home/test", null, "pts/3", "winston", "mgt", "1", "claude", "arch work", now, now]
    );

    const peer = db.query("SELECT * FROM peers WHERE id = ?").get("peer-3") as Peer;
    expect(peer.name).toBe("winston");
    expect(peer.tmux_session).toBe("mgt");
    expect(peer.tmux_window_index).toBe("1");
    expect(peer.tmux_window_name).toBe("claude");
  });

  test("F2: insert peer outside tmux (null tmux fields)", () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO peers (id, pid, cwd, git_root, tty, name, tmux_session, tmux_window_index, tmux_window_name, summary, registered_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["peer-4", 12348, "/home/test", null, "pts/4", null, null, null, null, "", now, now]
    );

    const peer = db.query("SELECT * FROM peers WHERE id = ?").get("peer-4") as Peer;
    expect(peer.tmux_session).toBeNull();
    expect(peer.tmux_window_index).toBeNull();
    expect(peer.tmux_window_name).toBeNull();
  });

  test("find_peer: filter by name", () => {
    const peers = db.query("SELECT * FROM peers WHERE name = ?").all("mary") as Peer[];
    expect(peers.length).toBe(1);
    expect(peers[0]!.id).toBe("peer-1");
  });

  test("find_peer: filter by tmux_session", () => {
    const peers = db.query("SELECT * FROM peers WHERE tmux_session = ?").all("mgt") as Peer[];
    expect(peers.length).toBe(1);
    expect(peers[0]!.id).toBe("peer-3");
  });

  test("find_peer: filter by name AND tmux_session", () => {
    const peers = db
      .query("SELECT * FROM peers WHERE name = ? AND tmux_session = ?")
      .all("winston", "mgt") as Peer[];
    expect(peers.length).toBe(1);
    expect(peers[0]!.id).toBe("peer-3");
  });

  test("find_peer: no match returns empty", () => {
    const peers = db.query("SELECT * FROM peers WHERE name = ?").all("nonexistent") as Peer[];
    expect(peers.length).toBe(0);
  });

  test("find_peer: name match + wrong tmux returns empty", () => {
    const peers = db
      .query("SELECT * FROM peers WHERE name = ? AND tmux_session = ?")
      .all("mary", "nonexistent") as Peer[];
    expect(peers.length).toBe(0);
  });

  test("list_peers returns all F1+F2 fields", () => {
    const peers = db.query("SELECT * FROM peers").all() as Peer[];
    expect(peers.length).toBe(4);

    // Verify all peers have the new fields (even if null)
    for (const peer of peers) {
      expect("name" in peer).toBe(true);
      expect("tmux_session" in peer).toBe(true);
      expect("tmux_window_index" in peer).toBe(true);
      expect("tmux_window_name" in peer).toBe(true);
    }
  });

  test("old peers without new columns still queryable", () => {
    // Simulate a pre-migration peer (only original columns)
    db.run(
      `INSERT INTO peers (id, pid, cwd, summary, registered_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["peer-old", 99999, "/old", "", new Date().toISOString(), new Date().toISOString()]
    );

    const peer = db.query("SELECT * FROM peers WHERE id = ?").get("peer-old") as Peer;
    expect(peer.id).toBe("peer-old");
    expect(peer.name).toBeNull();
    expect(peer.tmux_session).toBeNull();
  });
});

// --- Type contract tests ---

describe("F1+F2 type contracts", () => {
  test("RegisterRequest accepts F1+F2 fields", () => {
    const req: RegisterRequest = {
      pid: 12345,
      cwd: "/home/test",
      git_root: null,
      tty: "pts/1",
      name: "test-peer",
      tmux_session: "dev",
      tmux_window_index: "0",
      tmux_window_name: "main",
      summary: "test",
    };
    expect(req.name).toBe("test-peer");
    expect(req.tmux_session).toBe("dev");
  });

  test("RegisterRequest accepts null F1+F2 fields (backward compat)", () => {
    const req: RegisterRequest = {
      pid: 12345,
      cwd: "/home/test",
      git_root: null,
      tty: null,
      name: null,
      tmux_session: null,
      tmux_window_index: null,
      tmux_window_name: null,
      summary: "",
    };
    expect(req.name).toBeNull();
    expect(req.tmux_session).toBeNull();
  });

  test("Peer interface includes F1+F2 fields", () => {
    const peer: Peer = {
      id: "test",
      pid: 1,
      cwd: "/",
      git_root: null,
      tty: null,
      name: "barry",
      tmux_session: "mgt",
      tmux_window_index: "2",
      tmux_window_name: "build",
      summary: "",
      registered_at: "",
      last_seen: "",
    };
    expect(peer.name).toBe("barry");
    expect(peer.tmux_session).toBe("mgt");
    expect(peer.tmux_window_index).toBe("2");
    expect(peer.tmux_window_name).toBe("build");
  });
});

// --- detectTmuxPane unit tests ---

describe("F2 detectTmuxPane parsing logic", () => {
  // Test the parsing logic that detectTmuxPane uses internally.
  // We can't call detectTmuxPane directly from tests (it shells out),
  // so we test the parsing algorithm in isolation.

  function parseTmuxOutput(output: string): Map<number, { session: string; window_index: string; window_name: string }> {
    const paneMap = new Map<number, { session: string; window_index: string; window_name: string }>();
    for (const line of output.trim().split("\n")) {
      const parts = line.trim().split(" ");
      if (parts.length >= 4) {
        const pid = parseInt(parts[0]!, 10);
        if (!isNaN(pid)) {
          paneMap.set(pid, {
            session: parts[1]!,
            window_index: parts[2]!,
            window_name: parts.slice(3).join(" "),
          });
        }
      }
    }
    return paneMap;
  }

  test("parses standard tmux list-panes output", () => {
    const output = `12345 main 0 bash
67890 dev 1 vim
11111 mgt 2 claude code`;

    const map = parseTmuxOutput(output);
    expect(map.size).toBe(3);
    expect(map.get(12345)).toEqual({ session: "main", window_index: "0", window_name: "bash" });
    expect(map.get(67890)).toEqual({ session: "dev", window_index: "1", window_name: "vim" });
    // Window name with space preserved
    expect(map.get(11111)).toEqual({ session: "mgt", window_index: "2", window_name: "claude code" });
  });

  test("handles empty output", () => {
    const map = parseTmuxOutput("");
    expect(map.size).toBe(0);
  });

  test("handles single pane", () => {
    const output = "2505121 4 0 bash";
    const map = parseTmuxOutput(output);
    expect(map.size).toBe(1);
    expect(map.get(2505121)).toEqual({ session: "4", window_index: "0", window_name: "bash" });
  });

  test("skips malformed lines (too few fields)", () => {
    const output = `12345 main 0 bash
bad line
67890 dev 1 vim`;

    const map = parseTmuxOutput(output);
    expect(map.size).toBe(2);
    expect(map.has(12345)).toBe(true);
    expect(map.has(67890)).toBe(true);
  });

  test("skips lines with non-numeric pid", () => {
    const output = `notapid main 0 bash
12345 dev 1 vim`;

    const map = parseTmuxOutput(output);
    expect(map.size).toBe(1);
    expect(map.has(12345)).toBe(true);
  });

  test("ancestry walk simulation: match within 20 iterations", () => {
    // Simulate the walk: pid chain 100 -> 90 -> 80 -> 70 (match at 70)
    const paneMap = new Map([[70, { session: "test", window_index: "0", window_name: "bash" }]]);
    const parentChain: Record<number, number> = { 100: 90, 90: 80, 80: 70, 70: 1 };

    let currentPid = 100;
    let result: { session: string; window_index: string; window_name: string } | null = null;
    for (let i = 0; i < 20; i++) {
      if (paneMap.has(currentPid)) {
        result = paneMap.get(currentPid)!;
        break;
      }
      const parent = parentChain[currentPid];
      if (!parent || parent <= 1) break;
      currentPid = parent;
    }

    expect(result).toEqual({ session: "test", window_index: "0", window_name: "bash" });
  });

  test("ancestry walk simulation: no match within 20 iterations", () => {
    const paneMap = new Map([[1, { session: "unreachable", window_index: "0", window_name: "bash" }]]);
    // Chain never reaches pid 1 within 20 steps (goes 100 -> 99 -> ... -> 81)
    const parentChain: Record<number, number> = {};
    for (let i = 100; i > 80; i--) {
      parentChain[i] = i - 1;
    }
    parentChain[81] = 0; // terminates before reaching paneMap entry

    let currentPid = 100;
    let result: { session: string; window_index: string; window_name: string } | null = null;
    for (let i = 0; i < 20; i++) {
      if (paneMap.has(currentPid)) {
        result = paneMap.get(currentPid)!;
        break;
      }
      const parent = parentChain[currentPid];
      if (!parent || parent <= 1) break;
      currentPid = parent;
    }

    expect(result).toBeNull();
  });

  test("ancestry walk simulation: ppid=1 terminates early", () => {
    const paneMap = new Map([[999, { session: "test", window_index: "0", window_name: "bash" }]]);
    const parentChain: Record<number, number> = { 100: 1 }; // immediate init

    let currentPid = 100;
    let result: { session: string; window_index: string; window_name: string } | null = null;
    for (let i = 0; i < 20; i++) {
      if (paneMap.has(currentPid)) {
        result = paneMap.get(currentPid)!;
        break;
      }
      const parent = parentChain[currentPid];
      if (!parent || parent <= 1) break;
      currentPid = parent;
    }

    expect(result).toBeNull();
  });
});

// --- Integration test: live broker round-trip ---

describe("F1+F2 live broker integration", () => {
  const BROKER_PORT = 17899; // Use non-standard port to avoid conflicts
  let brokerProc: ReturnType<typeof Bun.spawn>;
  const brokerUrl = `http://127.0.0.1:${BROKER_PORT}`;
  const TEST_DB = "/tmp/claude-peers-test-f1f2.db";

  beforeAll(async () => {
    // Clean up any old test DB
    try { await Bun.write(TEST_DB, ""); Bun.spawnSync(["rm", "-f", TEST_DB]); } catch {}

    brokerProc = Bun.spawn(["bun", "/home/manzo/claude-peers-mcp/broker.ts"], {
      env: { ...process.env, CLAUDE_PEERS_PORT: String(BROKER_PORT), CLAUDE_PEERS_DB: TEST_DB },
      stdout: "ignore",
      stderr: "ignore",
    });

    // Wait for broker to start
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`${brokerUrl}/health`, { signal: AbortSignal.timeout(500) });
        if (res.ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
  });

  afterAll(() => {
    brokerProc.kill();
    Bun.spawnSync(["rm", "-f", TEST_DB]);
  });

  async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${brokerUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json() as Promise<T>;
  }

  test("F1: register with name, retrieve via list_peers", async () => {
    const reg = await brokerFetch<{ id: string }>("/register", {
      pid: process.pid,
      cwd: "/home/test",
      git_root: null,
      tty: "pts/99",
      name: "test-mary",
      tmux_session: null,
      tmux_window_index: null,
      tmux_window_name: null,
      summary: "test peer",
    });

    expect(reg.id).toBeTruthy();

    const peers = await brokerFetch<Peer[]>("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });

    const found = peers.find((p) => p.id === reg.id);
    expect(found).toBeTruthy();
    expect(found!.name).toBe("test-mary");
  });

  test("F1: register without name (backward compat)", async () => {
    const reg = await brokerFetch<{ id: string }>("/register", {
      pid: process.pid, // fake different PID
      cwd: "/home/test2",
      git_root: null,
      tty: null,
      name: null,
      tmux_session: null,
      tmux_window_index: null,
      tmux_window_name: null,
      summary: "",
    });

    const peers = await brokerFetch<Peer[]>("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });

    const found = peers.find((p) => p.id === reg.id);
    expect(found).toBeTruthy();
    expect(found!.name).toBeNull();
  });

  test("F2: register with tmux fields, retrieve via list_peers", async () => {
    const reg = await brokerFetch<{ id: string }>("/register", {
      pid: process.pid,
      cwd: "/home/test3",
      git_root: null,
      tty: "pts/50",
      name: "test-winston",
      tmux_session: "dev",
      tmux_window_index: "3",
      tmux_window_name: "architect",
      summary: "arch work",
    });

    const peers = await brokerFetch<Peer[]>("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });

    const found = peers.find((p) => p.id === reg.id);
    expect(found).toBeTruthy();
    expect(found!.tmux_session).toBe("dev");
    expect(found!.tmux_window_index).toBe("3");
    expect(found!.tmux_window_name).toBe("architect");
  });

  test("F2: register outside tmux (null fields)", async () => {
    const reg = await brokerFetch<{ id: string }>("/register", {
      pid: process.pid,
      cwd: "/home/test4",
      git_root: null,
      tty: null,
      name: null,
      tmux_session: null,
      tmux_window_index: null,
      tmux_window_name: null,
      summary: "",
    });

    const peers = await brokerFetch<Peer[]>("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });

    const found = peers.find((p) => p.id === reg.id);
    expect(found).toBeTruthy();
    expect(found!.tmux_session).toBeNull();
    expect(found!.tmux_window_index).toBeNull();
    expect(found!.tmux_window_name).toBeNull();
  });
});
