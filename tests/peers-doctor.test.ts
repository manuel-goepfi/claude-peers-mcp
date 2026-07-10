import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireBrokerOwnership } from "../shared/broker-lifecycle.ts";
import { inspectClientSurfaces, inspectDatabase, summarizeProcesses } from "../shared/doctor.ts";
import { installClientHooks } from "../shared/hook-config.ts";
import { initializeStorage } from "../shared/storage.ts";
import type { ProcessInfo } from "../shared/client.ts";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const brokerScript = join(repoRoot, "broker.ts");

function temporaryRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `claude-peers-${prefix}-`));
}

describe("schema-aware doctor", () => {
  test("starting and migrating readiness never open an invalid database", () => {
    const root = temporaryRoot("doctor-not-ready");
    try {
      const dbPath = join(root, "invalid.db");
      writeFileSync(dbPath, "not sqlite", { mode: 0o600 });
      expect(inspectDatabase(dbPath, "starting")).toMatchObject({ state: "skipped", schema_version: null, reason: "broker_not_ready" });
      expect(inspectDatabase(dbPath, "migrating")).toMatchObject({ state: "skipped", schema_version: null, reason: "broker_not_ready" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dispatches a known legacy decoder and refuses unsupported versions", () => {
    const root = temporaryRoot("doctor-schema");
    try {
      const legacyPath = join(root, "legacy.db");
      const legacy = new Database(legacyPath);
      legacy.run("CREATE TABLE peers (id TEXT PRIMARY KEY, pid INTEGER NOT NULL, last_seen TEXT NOT NULL)");
      legacy.run("CREATE TABLE messages (id INTEGER PRIMARY KEY, delivered INTEGER NOT NULL DEFAULT 0)");
      legacy.run("INSERT INTO peers VALUES ('legacy', ?, datetime('now'))", [process.pid]);
      legacy.run("INSERT INTO messages VALUES (1, 0)");
      legacy.close();
      const decoded = inspectDatabase(legacyPath, "ready", new Map([[process.pid, { pid: process.pid, ppid: 1, comm: "claude", args: "claude" }]]), repoRoot);
      expect(decoded.state).toBe("legacy");
      expect(decoded.schema_version).toBe(0);
      expect(decoded.aggregates?.peers.total).toBe(1);
      expect(decoded.aggregates?.queue.queued).toBe(1);

      const futurePath = join(root, "future.db");
      const future = new Database(futurePath);
      initializeStorage(future, { databasePath: futurePath });
      future.run("PRAGMA user_version = 99");
      future.close();
      expect(inspectDatabase(futurePath, "ready")).toMatchObject({ state: "unsupported", schema_version: 99, reason: "unsupported_schema" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unreachable health refuses schema reads while a live owner exists", () => {
    const root = temporaryRoot("doctor-owner");
    try {
      const dbPath = join(root, "owned.db");
      writeFileSync(dbPath, "deliberately invalid", { mode: 0o600 });
      const owner = acquireBrokerOwnership({ databasePath: dbPath, brokerScriptPath: brokerScript });
      try {
        expect(inspectDatabase(dbPath, "unreachable")).toMatchObject({
          state: "refused",
          schema_version: null,
          owner: "live",
          reason: "live_owner_without_health",
        });
      } finally {
        expect(owner.release()).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("enumerates every client adapter and correlates registered parents without exposing ids", () => {
    const processes = new Map<number, ProcessInfo>([
      [10, { pid: 10, ppid: 2, comm: "claude", args: "claude" }],
      [11, { pid: 11, ppid: 10, comm: "bun", args: `bun ${join(repoRoot, "server.ts")}` }],
      [20, { pid: 20, ppid: 2, comm: "claude", args: "claude --bg-spare /tmp/spare" }],
      [21, { pid: 21, ppid: 20, comm: "bun", args: `bun ${join(repoRoot, "server.ts")}` }],
      [30, { pid: 30, ppid: 2, comm: "codex", args: "codex" }],
      [31, { pid: 31, ppid: 30, comm: "bun", args: `bun ${join(repoRoot, "server.ts")}` }],
      [40, { pid: 40, ppid: 1, comm: "bun", args: `bun ${join(repoRoot, "server.ts")}` }],
    ]);
    expect(summarizeProcesses(processes, repoRoot)).toEqual({
      client_roots: { claude: 2, codex: 1, gemini: 0 },
      adapters: { claude: 2, codex: 1, gemini: 0, unknown: 1 },
      orphaned_adapters: 1,
      spare_parented_adapters: 1,
    });

    const root = temporaryRoot("doctor-correlation");
    try {
      const dbPath = join(root, "peers.db");
      const db = new Database(dbPath);
      initializeStorage(db, { databasePath: dbPath });
      const now = new Date().toISOString();
      db.run("INSERT INTO peers (id, pid, cwd, client_type, receiver_mode, registered_at, last_seen) VALUES ('later-match', 30, '/', 'codex', 'codex-hook', ?, ?)", [now, now]);
      db.run("INSERT INTO peers (id, pid, cwd, client_type, receiver_mode, registered_at, last_seen) VALUES ('first-unrelated', 999999, '/', 'claude', 'claude-channel', ?, ?)", [now, now]);
      db.close();
      const report = inspectDatabase(dbPath, "ready", processes, repoRoot);
      expect(report.aggregates?.correlation).toEqual({
        registered_processes: 2,
        live_registered_processes: 1,
        adapters_with_registered_client: 1,
        adapters_without_registered_client: 3,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("classifies exact, stale, missing, malformed, and duplicate scopes", () => {
    const root = temporaryRoot("doctor-config");
    const home = join(root, "home");
    const project = join(root, "project");
    try {
      for (const path of [join(home, ".claude"), join(home, ".codex"), join(home, ".gemini"), join(project, ".claude"), join(project, ".codex"), join(project, ".gemini")]) {
        mkdirSync(path, { recursive: true, mode: 0o700 });
      }
      const exactClaude = `${JSON.stringify(installClientHooks({}, "claude", repoRoot), null, 2)}\n`;
      writeFileSync(join(home, ".claude", "settings.json"), exactClaude, { mode: 0o600 });
      writeFileSync(join(project, ".claude", "settings.json"), exactClaude, { mode: 0o600 });
      writeFileSync(join(home, ".codex", "hooks.json"), "{bad", { mode: 0o600 });
      writeFileSync(join(project, ".gemini", "settings.json"), `${JSON.stringify(installClientHooks({}, "gemini", "/old/clone"), null, 2)}\n`, { mode: 0o600 });

      const report = inspectClientSurfaces(home, project, repoRoot);
      expect(report.claude.hooks.user.state).toBe("current");
      expect(report.claude.hooks.project.state).toBe("current");
      expect(report.claude.duplicate_scope).toBe(true);
      expect(report.codex.hooks.user.state).toBe("malformed");
      expect(report.codex.hooks.project.state).toBe("missing");
      expect(report.gemini.hooks.project.state).toBe("stale");
      expect(report.gemini.mcp.project.state).toBe("stale");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
