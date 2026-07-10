import { Database } from "bun:sqlite";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { detectClientFromProcessChain, findBgSpareAncestor, findClientPidFromProcessChain, isClientProcess, isCodexAppServerProcess, type ProcessInfo } from "./client.ts";
import { ownerProcessIsCurrent, readOwnerMetadata } from "./broker-lifecycle.ts";
import { classifyClientHooks, type HookClassification, type HookClient } from "./hook-config.ts";
import { STORAGE_SCHEMA_VERSION, storageTableColumns, storageUserVersion } from "./storage.ts";

export type SurfaceState = "current" | "stale" | "missing" | "malformed" | "unsafe";

export interface HookSurface extends HookClassification {
  state: SurfaceState;
}

export interface McpSurface {
  state: SurfaceState;
}

export interface ClientSurface {
  hooks: { user: HookSurface; project: HookSurface };
  mcp: { user: McpSurface; project: McpSurface };
  duplicate_scope: boolean;
  trust_confirmation_required: boolean;
  restart_required_to_apply: boolean;
}

export interface ProcessSummary {
  client_roots: { claude: number; codex: number; gemini: number };
  adapters: { claude: number; codex: number; gemini: number; unknown: number };
  orphaned_adapters: number;
  spare_parented_adapters: number;
}

export interface DatabaseAggregates {
  peers: { total: number; targetable: number; active: number };
  clients: Record<string, number>;
  receiver_modes: Record<string, number>;
  receiver_health: { observed: number; errors: number };
  queue: { queued: number; claimed: number; acknowledged: number; total: number };
  correlation: { registered_processes: number; live_registered_processes: number; adapters_with_registered_client: number; adapters_without_registered_client: number };
}

export interface DatabaseReport {
  state: "ready" | "legacy" | "skipped" | "missing" | "refused" | "unsupported" | "error";
  schema_version: number | null;
  owner: "live" | "stale" | "none" | "ambiguous";
  aggregates: DatabaseAggregates | null;
  reason?: "broker_not_ready" | "live_owner_without_health" | "ambiguous_owner" | "unsupported_schema" | "invalid_database";
}

export interface DoctorReport {
  report_version: 1;
  status: "healthy" | "degraded" | "failed";
  broker: {
    reachable: boolean;
    readiness: "ready" | "starting" | "migrating" | "unreachable" | "invalid";
    version: string | null;
    schema_version: number | null;
    peer_count: number | null;
    hook_drain_capable: boolean | null;
  };
  database: DatabaseReport;
  processes: ProcessSummary;
  clients: { claude: ClientSurface; codex: ClientSurface; gemini: ClientSurface };
  summary: { warnings: number; errors: number };
}

type HealthReport = DoctorReport["broker"];

const emptyHooks = (state: SurfaceState): HookSurface => ({ state, expected: 0, exact: 0, stale: 0, missing: 0 });

function safeJson(path: string): { state: "ok"; document: Record<string, unknown> } | { state: "missing" | "malformed" | "unsafe" } {
  if (!existsSync(path)) return { state: "missing" };
  try {
    const stat = lstatSync(path);
    const uid = process.getuid?.() ?? -1;
    if (stat.isSymbolicLink() || !stat.isFile() || (uid >= 0 && stat.uid !== uid) || (stat.mode & 0o022) !== 0) return { state: "unsafe" };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "malformed" };
    return { state: "ok", document: parsed as Record<string, unknown> };
  } catch {
    return { state: "malformed" };
  }
}

function hookSurface(path: string, client: HookClient, repoRoot: string): HookSurface {
  const loaded = safeJson(path);
  if (loaded.state !== "ok") return emptyHooks(loaded.state);
  const classification = classifyClientHooks(loaded.document, client, repoRoot);
  const state: SurfaceState = classification.exact === classification.expected && classification.stale === 0
    ? "current"
    : classification.exact > 0 || classification.stale > 0
      ? "stale"
      : "missing";
  return { state, ...classification };
}

function mcpEntry(document: Record<string, unknown>): unknown {
  const servers = (document.mcpServers ?? document.mcp_servers) as Record<string, unknown> | undefined;
  return servers?.["claude-peers"];
}

function classifyMcpDocument(document: Record<string, unknown>, configPath: string, repoRoot: string): McpSurface {
  const entry = mcpEntry(document) as { command?: unknown; args?: unknown } | undefined;
  if (!entry) return { state: "missing" };
  if (typeof entry !== "object" || typeof entry.command !== "string" || !Array.isArray(entry.args) || !entry.args.every((arg) => typeof arg === "string")) {
    return { state: "stale" };
  }
  const command = basename(entry.command).toLowerCase();
  const bunCommand = command === "bun" || resolve(entry.command) === resolve(process.execPath);
  const expectedServer = resolve(repoRoot, "server.ts");
  const serverCurrent = (entry.args as string[]).some((arg) => resolve(dirname(configPath), arg) === expectedServer);
  return { state: bunCommand && serverCurrent ? "current" : "stale" };
}

function jsonMcpSurface(path: string, repoRoot: string): McpSurface {
  const loaded = safeJson(path);
  if (loaded.state !== "ok") return { state: loaded.state };
  return classifyMcpDocument(loaded.document, path, repoRoot);
}

function tomlMcpSurface(path: string, repoRoot: string): McpSurface {
  if (!existsSync(path)) return { state: "missing" };
  try {
    const stat = lstatSync(path);
    const uid = process.getuid?.() ?? -1;
    if (stat.isSymbolicLink() || !stat.isFile() || (uid >= 0 && stat.uid !== uid) || (stat.mode & 0o022) !== 0) return { state: "unsafe" };
    const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return classifyMcpDocument(parsed, path, repoRoot);
  } catch {
    return { state: "malformed" };
  }
}

function installed(state: SurfaceState): boolean {
  return state === "current" || state === "stale";
}

export function inspectClientSurfaces(home: string, projectRoot: string, repoRoot: string): DoctorReport["clients"] {
  const paths = {
    claude: {
      hooks: { user: resolve(home, ".claude/settings.json"), project: resolve(projectRoot, ".claude/settings.json") },
      mcp: { user: resolve(home, ".claude.json"), project: resolve(projectRoot, ".mcp.json") },
    },
    codex: {
      hooks: { user: resolve(home, ".codex/hooks.json"), project: resolve(projectRoot, ".codex/hooks.json") },
      mcp: { user: resolve(home, ".codex/config.toml"), project: resolve(projectRoot, ".codex/config.toml") },
    },
    gemini: {
      hooks: { user: resolve(home, ".gemini/settings.json"), project: resolve(projectRoot, ".gemini/settings.json") },
      mcp: { user: resolve(home, ".gemini/settings.json"), project: resolve(projectRoot, ".gemini/settings.json") },
    },
  } as const;

  const result = {} as DoctorReport["clients"];
  for (const client of ["claude", "codex", "gemini"] as const) {
    const hooks = {
      user: hookSurface(paths[client].hooks.user, client, repoRoot),
      project: hookSurface(paths[client].hooks.project, client, repoRoot),
    };
    const mcp = client === "codex"
      ? { user: tomlMcpSurface(paths.codex.mcp.user, repoRoot), project: tomlMcpSurface(paths.codex.mcp.project, repoRoot) }
      : {
        user: jsonMcpSurface(paths[client].mcp.user, repoRoot),
        project: jsonMcpSurface(paths[client].mcp.project, repoRoot),
      };
    const duplicateScope = (installed(hooks.user.state) && installed(hooks.project.state)) || (installed(mcp.user.state) && installed(mcp.project.state));
    const anyConfigured = installed(hooks.user.state) || installed(hooks.project.state) || installed(mcp.user.state) || installed(mcp.project.state);
    result[client] = {
      hooks,
      mcp,
      duplicate_scope: duplicateScope,
      trust_confirmation_required: client === "codex" && anyConfigured,
      restart_required_to_apply: anyConfigured,
    };
  }
  return result;
}

export function readProcessSnapshot(procRoot = "/proc"): Map<number, ProcessInfo> {
  const uid = process.getuid?.() ?? -1;
  const rows = new Map<number, ProcessInfo>();
  for (const name of readdirSync(procRoot)) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const stat = lstatSync(resolve(procRoot, name));
      if (uid >= 0 && stat.uid !== uid) continue;
      const status = readFileSync(resolve(procRoot, name, "status"), "utf8");
      const ppid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1] ?? "0");
      const comm = readFileSync(resolve(procRoot, name, "comm"), "utf8").trim();
      const args = readFileSync(resolve(procRoot, name, "cmdline"), "utf8").split("\0").filter(Boolean).join(" ");
      rows.set(pid, { pid, ppid, comm, args });
    } catch {
      // Processes may exit while /proc is being enumerated.
    }
  }
  return rows;
}

function isPeerAdapterProcess(row: ProcessInfo, expectedServer: string): boolean {
  return row.args.includes(expectedServer) || (/\bserver\.ts(?:\s|$)/.test(row.args) && /claude-peers/.test(row.args));
}

export function summarizeProcesses(processes: Map<number, ProcessInfo>, repoRoot: string): ProcessSummary {
  const clientRoots = { claude: 0, codex: 0, gemini: 0 };
  for (const row of processes.values()) {
    if (isClientProcess(row, "claude")) clientRoots.claude++;
    if (isClientProcess(row, "codex") && !isCodexAppServerProcess(row)) clientRoots.codex++;
    if (isClientProcess(row, "gemini")) clientRoots.gemini++;
  }

  const adapters = { claude: 0, codex: 0, gemini: 0, unknown: 0 };
  let orphaned = 0;
  let spareParented = 0;
  const expectedServer = resolve(repoRoot, "server.ts");
  for (const row of processes.values()) {
    if (!isPeerAdapterProcess(row, expectedServer)) continue;
    const client = detectClientFromProcessChain(row.ppid, processes, {});
    adapters[client]++;
    if (row.ppid <= 1) orphaned++;
    if (findBgSpareAncestor(row.ppid, processes)) spareParented++;
  }
  return { client_roots: clientRoots, adapters, orphaned_adapters: orphaned, spare_parented_adapters: spareParented };
}

function ownerState(dbPath: string): DatabaseReport["owner"] {
  const lockPath = `${dbPath}.owner`;
  if (!existsSync(lockPath)) return "none";
  try {
    return ownerProcessIsCurrent(readOwnerMetadata(lockPath)) ? "live" : "stale";
  } catch {
    return "ambiguous";
  }
}

function grouped(db: Database, sql: string, key: string): Record<string, number> {
  const rows = db.query(sql).all() as Array<Record<string, unknown>>;
  const result: Record<string, number> = {};
  for (const row of rows) result[String(row[key] ?? "unknown")] = Number(row.count ?? 0);
  return result;
}

function adapterClientPids(processes: Map<number, ProcessInfo>, repoRoot: string): Array<number | null> {
  const expectedServer = resolve(repoRoot, "server.ts");
  const result: Array<number | null> = [];
  for (const row of processes.values()) {
    if (!isPeerAdapterProcess(row, expectedServer)) continue;
    const client = detectClientFromProcessChain(row.ppid, processes, {});
    result.push(client === "unknown" ? null : findClientPidFromProcessChain(row.ppid, processes, client));
  }
  return result;
}

function decodeDatabase(db: Database, version: number, processes: Map<number, ProcessInfo>, repoRoot: string): DatabaseAggregates {
  const peerColumns = storageTableColumns(db, "peers");
  const messageColumns = storageTableColumns(db, "messages");
  if (!["id", "last_seen"].every((column) => peerColumns.has(column)) || !["id", "delivered"].every((column) => messageColumns.has(column))) {
    throw new Error("unsupported schema shape");
  }
  if (version === STORAGE_SCHEMA_VERSION && (
    !["client_type", "receiver_mode", "last_hook_seen_at", "last_drain_error", "non_targetable"].every((column) => peerColumns.has(column)) ||
    !["claimed_by", "retention_at"].every((column) => messageColumns.has(column))
  )) throw new Error("invalid current schema shape");

  const peer = db.query(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN ${peerColumns.has("non_targetable") ? "non_targetable = 0" : "1"} THEN 1 ELSE 0 END) AS targetable,
      SUM(CASE WHEN julianday(last_seen) >= julianday('now', '-60 seconds') THEN 1 ELSE 0 END) AS active
    FROM peers
  `).get() as { total: number; targetable: number; active: number };
  const queue = db.query(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN delivered = 0 AND ${messageColumns.has("claimed_by") ? "claimed_by IS NULL" : "1"} THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN delivered = 0 AND ${messageColumns.has("claimed_by") ? "claimed_by IS NOT NULL" : "0"} THEN 1 ELSE 0 END) AS claimed,
      SUM(CASE WHEN delivered = 1 THEN 1 ELSE 0 END) AS acknowledged
    FROM messages
  `).get() as { total: number; queued: number; claimed: number; acknowledged: number };
  const health = peerColumns.has("last_hook_seen_at") && peerColumns.has("last_drain_error")
    ? db.query("SELECT SUM(last_hook_seen_at IS NOT NULL) AS observed, SUM(last_drain_error IS NOT NULL) AS errors FROM peers").get() as { observed: number; errors: number }
    : { observed: 0, errors: 0 };
  const registeredPids = peerColumns.has("pid")
    ? (db.query("SELECT pid FROM peers").all() as Array<{ pid: number }>).map((row) => Number(row.pid)).filter(Number.isInteger)
    : [];
  const registeredSet = new Set(registeredPids);
  const adapterPids = adapterClientPids(processes, repoRoot);
  return {
    peers: { total: Number(peer.total ?? 0), targetable: Number(peer.targetable ?? 0), active: Number(peer.active ?? 0) },
    clients: peerColumns.has("client_type") ? grouped(db, "SELECT client_type, COUNT(*) AS count FROM peers GROUP BY client_type ORDER BY client_type", "client_type") : { unknown: Number(peer.total ?? 0) },
    receiver_modes: peerColumns.has("receiver_mode") ? grouped(db, "SELECT receiver_mode, COUNT(*) AS count FROM peers GROUP BY receiver_mode ORDER BY receiver_mode", "receiver_mode") : { unknown: Number(peer.total ?? 0) },
    receiver_health: { observed: Number(health.observed ?? 0), errors: Number(health.errors ?? 0) },
    queue: { queued: Number(queue.queued ?? 0), claimed: Number(queue.claimed ?? 0), acknowledged: Number(queue.acknowledged ?? 0), total: Number(queue.total ?? 0) },
    correlation: {
      registered_processes: registeredPids.length,
      live_registered_processes: registeredPids.filter((pid) => processes.has(pid)).length,
      adapters_with_registered_client: adapterPids.filter((pid) => pid !== null && registeredSet.has(pid)).length,
      adapters_without_registered_client: adapterPids.filter((pid) => pid === null || !registeredSet.has(pid)).length,
    },
  };
}

export function inspectDatabase(
  dbPath: string,
  brokerReadiness: HealthReport["readiness"],
  processes: Map<number, ProcessInfo> = new Map(),
  repoRoot = resolve(import.meta.dir, ".."),
): DatabaseReport {
  const owner = ownerState(dbPath);
  if (brokerReadiness === "starting" || brokerReadiness === "migrating") {
    return { state: "skipped", schema_version: null, owner, aggregates: null, reason: "broker_not_ready" };
  }
  if (brokerReadiness === "unreachable" && owner === "live") {
    return { state: "refused", schema_version: null, owner, aggregates: null, reason: "live_owner_without_health" };
  }
  if (brokerReadiness === "unreachable" && owner === "ambiguous") {
    return { state: "refused", schema_version: null, owner, aggregates: null, reason: "ambiguous_owner" };
  }
  if (!existsSync(dbPath)) return { state: "missing", schema_version: null, owner, aggregates: null };
  try {
    const stat = lstatSync(dbPath);
    const uid = process.getuid?.() ?? -1;
    if (stat.isSymbolicLink() || !stat.isFile() || (uid >= 0 && stat.uid !== uid)) throw new Error("unsafe database");
    const db = new Database(dbPath, { readonly: true, strict: true });
    try {
      db.run("PRAGMA query_only = ON");
      const version = storageUserVersion(db);
      if (version !== 0 && version !== STORAGE_SCHEMA_VERSION) {
        return { state: "unsupported", schema_version: version, owner, aggregates: null, reason: "unsupported_schema" };
      }
      const aggregates = decodeDatabase(db, version, processes, repoRoot);
      return { state: version === 0 ? "legacy" : "ready", schema_version: version, owner, aggregates };
    } finally {
      db.close(false);
    }
  } catch {
    return { state: "error", schema_version: null, owner, aggregates: null, reason: "invalid_database" };
  }
}

export async function inspectHealth(port: number): Promise<HealthReport> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    const value = await response.json() as Record<string, unknown>;
    const rawStatus = typeof value.status === "string" ? value.status : "invalid";
    const readiness = value.ready === true || rawStatus === "ok" || rawStatus === "ready"
      ? "ready"
      : rawStatus === "starting" || rawStatus === "migrating"
        ? rawStatus
        : "invalid";
    const hookDrain = value.capabilities && typeof value.capabilities === "object"
      ? (value.capabilities as { hookDrain?: { claimByPid?: unknown; ackByPid?: unknown; hookHeartbeatByPid?: unknown } }).hookDrain
      : undefined;
    return {
      reachable: true,
      readiness,
      version: typeof value.version === "string" ? value.version : null,
      schema_version: Number.isInteger(value.schema_version) ? Number(value.schema_version) : null,
      peer_count: Number.isInteger(value.peers) ? Number(value.peers) : null,
      hook_drain_capable: hookDrain ? hookDrain.claimByPid === true && hookDrain.ackByPid === true && hookDrain.hookHeartbeatByPid === true : null,
    };
  } catch {
    return { reachable: false, readiness: "unreachable", version: null, schema_version: null, peer_count: null, hook_drain_capable: null };
  }
}

export async function buildDoctorReport(options: { port: number; dbPath: string; home: string; projectRoot: string; repoRoot: string; processes?: Map<number, ProcessInfo> }): Promise<DoctorReport> {
  const broker = await inspectHealth(options.port);
  const processSnapshot = options.processes ?? readProcessSnapshot();
  const database = inspectDatabase(options.dbPath, broker.readiness, processSnapshot, options.repoRoot);
  const processes = summarizeProcesses(processSnapshot, options.repoRoot);
  const clients = inspectClientSurfaces(options.home, options.projectRoot, options.repoRoot);

  let errors = 0;
  let warnings = 0;
  if (broker.readiness !== "ready") errors++;
  if (["refused", "unsupported", "error"].includes(database.state) || (broker.readiness === "ready" && database.state !== "ready")) errors++;
  if (broker.schema_version !== null && database.schema_version !== null && broker.schema_version !== database.schema_version) errors++;
  if (database.state === "legacy" || database.state === "missing") warnings++;
  if (processes.orphaned_adapters > 0 || processes.spare_parented_adapters > 0) warnings++;
  for (const client of Object.values(clients)) {
    if (client.duplicate_scope) warnings++;
    for (const state of [client.hooks.user.state, client.hooks.project.state, client.mcp.user.state, client.mcp.project.state]) {
      if (state === "stale" || state === "malformed" || state === "unsafe") warnings++;
    }
  }
  return {
    report_version: 1,
    status: errors > 0 ? "failed" : warnings > 0 ? "degraded" : "healthy",
    broker,
    database,
    processes,
    clients,
    summary: { warnings, errors },
  };
}

export function renderDoctorHuman(report: DoctorReport): string {
  const lines = [
    "claude-peers doctor",
    `broker: ${report.broker.readiness}${report.broker.version ? ` version=${report.broker.version}` : ""}${report.broker.schema_version === null ? "" : ` schema=${report.broker.schema_version}`}`,
    `database: ${report.database.state}${report.database.schema_version === null ? "" : ` schema=${report.database.schema_version}`} owner=${report.database.owner}`,
  ];
  if (report.database.aggregates) {
    const a = report.database.aggregates;
    lines.push(`peers: total=${a.peers.total} active=${a.peers.active} targetable=${a.peers.targetable}`);
    lines.push(`queue: queued=${a.queue.queued} claimed=${a.queue.claimed} acknowledged=${a.queue.acknowledged} total=${a.queue.total}`);
    lines.push(`receiver-health: observed=${a.receiver_health.observed} errors=${a.receiver_health.errors}`);
    lines.push(`correlation: registered=${a.correlation.registered_processes} live=${a.correlation.live_registered_processes} matched-adapters=${a.correlation.adapters_with_registered_client} unmatched-adapters=${a.correlation.adapters_without_registered_client}`);
  }
  lines.push(`processes: clients=${report.processes.client_roots.claude + report.processes.client_roots.codex + report.processes.client_roots.gemini} adapters=${report.processes.adapters.claude + report.processes.adapters.codex + report.processes.adapters.gemini + report.processes.adapters.unknown} orphaned=${report.processes.orphaned_adapters} spare=${report.processes.spare_parented_adapters}`);
  for (const client of ["claude", "codex", "gemini"] as const) {
    const c = report.clients[client];
    lines.push(`${client}: hooks[user=${c.hooks.user.state},project=${c.hooks.project.state}] mcp[user=${c.mcp.user.state},project=${c.mcp.project.state}] duplicate=${c.duplicate_scope ? "yes" : "no"} trust=${c.trust_confirmation_required ? "confirm" : "none"} restart=${c.restart_required_to_apply ? "required-to-apply" : "none"}`);
  }
  lines.push(`summary: status=${report.status} warnings=${report.summary.warnings} errors=${report.summary.errors}`);
  return `${lines.join("\n")}\n`;
}
