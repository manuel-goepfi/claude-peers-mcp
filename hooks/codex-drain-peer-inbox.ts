#!/usr/bin/env bun
import { readlinkSync } from "node:fs";
import { renderInboundLine } from "../shared/render.ts";
import type { ClientType, Message, ReceiverMode } from "../shared/types.ts";

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const MAX_MESSAGES = 25;
const MAX_BYTES = 64 * 1024;
const CLIENT_TYPE: Extract<ClientType, "codex" | "gemini"> =
  process.env.CLAUDE_PEERS_CLIENT_TYPE === "gemini" ? "gemini" : "codex";
const RECEIVER_MODE: Extract<ReceiverMode, "codex-hook" | "gemini-hook"> =
  CLIENT_TYPE === "gemini" ? "gemini-hook" : "codex-hook";
const HOOK_EVENT_NAME = process.env.CLAUDE_PEERS_HOOK_EVENT_NAME ??
  (CLIENT_TYPE === "gemini" ? "BeforeAgent" : "UserPromptSubmit");

interface ProcRow {
  pid: number;
  ppid: number;
  comm: string;
  args: string;
}

interface AckByPidResponse {
  ok: boolean;
  peer_id?: string;
  acked?: number;
  error?: string;
}

function log(msg: string): void {
  console.error(`[claude-peers ${CLIENT_TYPE}-hook] ${msg}`);
}

function processTable(): Map<number, ProcRow> {
  const table = new Map<number, ProcRow>();
  const proc = Bun.spawnSync(["ps", "-eo", "pid=,ppid=,comm=,args="]);
  if (proc.exitCode !== 0) return table;
  const text = new TextDecoder().decode(proc.stdout);
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    table.set(Number(m[1]), {
      pid: Number(m[1]),
      ppid: Number(m[2]),
      comm: m[3] ?? "",
      args: m[4] ?? "",
    });
  }
  return table;
}

function commandName(value: string): string {
  return value.trim().split(/\s+/)[0]?.toLowerCase().replace(/^.*\//, "") ?? "";
}

function argTokens(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

function isClientCommand(name: string, clientType: Extract<ClientType, "codex" | "gemini">): boolean {
  return name === clientType || name.startsWith(`${clientType}-`);
}

function hasGeminiCliLauncher(args: string): boolean {
  return argTokens(args).some((token) => {
    const normalized = token.replace(/^['"]|['"]$/g, "").toLowerCase();
    const base = normalized.replace(/^.*\//, "");
    return normalized.includes("@google/gemini-cli/") || base === "gemini.js" || base === "gemini-cli.js";
  });
}

function isClientProcess(row: ProcRow, clientType = CLIENT_TYPE): boolean {
  const comm = commandName(row.comm);
  const firstArg = commandName(row.args);
  if (isClientCommand(comm, clientType) || isClientCommand(firstArg, clientType)) return true;
  return clientType === "gemini" && (comm === "node" || comm === "bun" || comm === "npx") &&
    hasGeminiCliLauncher(row.args);
}

function isPeersServer(row: ProcRow): boolean {
  return /claude-peers-mcp\/server\.ts/.test(row.args) || (/\/server\.ts/.test(row.args) && /claude-peers/.test(row.args));
}

function descendants(rootPid: number, table: Map<number, ProcRow>): ProcRow[] {
  const children = new Map<number, ProcRow[]>();
  for (const row of table.values()) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const out: ProcRow[] = [];
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    out.push(next);
    stack.push(...(children.get(next.pid) ?? []));
  }
  return out;
}

function cwdOf(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function findClientAncestor(table: Map<number, ProcRow>, startPid = process.ppid, clientType = CLIENT_TYPE): number | null {
  let current = startPid;
  for (let i = 0; i < 30; i++) {
    const row = table.get(current);
    if (!row) return null;
    if (isClientProcess(row, clientType)) return row.pid;
    if (row.ppid <= 1 || row.ppid === row.pid) return null;
    current = row.ppid;
  }
  return null;
}

export function findMcpPidFromTable(
  table: Map<number, ProcRow>,
  startPid: number,
  hookCwd: string,
  cwdResolver: (pid: number) => string | null = cwdOf,
  clientType = CLIENT_TYPE,
): number | null {
  const clientPid = findClientAncestor(table, startPid, clientType);
  if (!clientPid) return null;

  const candidates = descendants(clientPid, table)
    .filter(isPeersServer)
    .filter((row) => row.pid !== process.pid);
  const cwdMatches = candidates.filter((row) => cwdResolver(row.pid) === hookCwd);
  const selected = cwdMatches.length > 0 ? cwdMatches : candidates;
  if (selected.length === 1) return selected[0]!.pid;
  return null;
}

export function findClientPidFromTable(
  table: Map<number, ProcRow>,
  startPid = process.ppid,
  clientType = CLIENT_TYPE,
): number | null {
  return findClientAncestor(table, startPid, clientType);
}

export function findHookPeerPidsFromTable(
  table: Map<number, ProcRow>,
  startPid = process.ppid,
  hookCwd = process.cwd(),
  cwdReader: (pid: number) => string | null = cwdOf,
  clientType = CLIENT_TYPE,
  envPid: number | null = null,
): { primary: number; fallbacks: number[] } | null {
  const hasEnvPid = Number.isInteger(envPid) && envPid > 1;
  const clientPid = findClientAncestor(table, startPid, clientType);
  if (!clientPid) {
    if (!hasEnvPid) log(`no ${CLIENT_TYPE} ancestor found`);
    return hasEnvPid ? { primary: envPid!, fallbacks: [] } : null;
  }

  const candidates = descendants(clientPid, table)
    .filter(isPeersServer)
    .filter((row) => row.pid !== process.pid);
  const cwdMatches = candidates.filter((row) => cwdReader(row.pid) === hookCwd);
  const selected = cwdMatches.length > 0 ? cwdMatches : candidates;
  if (selected.length === 1) {
    const mcpPid = selected[0]!.pid;
    const fallbacks = [mcpPid, hasEnvPid ? envPid! : null]
      .filter((pid): pid is number => Number.isInteger(pid) && pid > 1 && pid !== clientPid)
      .filter((pid, index, all) => all.indexOf(pid) === index);
    return { primary: clientPid, fallbacks };
  }
  if (selected.length > 1 && !hasEnvPid) {
    log(`multiple claude-peers MCP candidates: ${selected.map((p) => p.pid).join(",")}`);
  }
  if (hasEnvPid && envPid !== clientPid) return { primary: clientPid, fallbacks: [envPid!] };
  return { primary: clientPid, fallbacks: [] };
}

function findHookPeerPids(): { primary: number; fallbacks: number[] } | null {
  const envPid = Number(process.env.CLAUDE_PEERS_MCP_PID ?? "");
  return findHookPeerPidsFromTable(
    processTable(),
    process.ppid,
    process.cwd(),
    cwdOf,
    CLIENT_TYPE,
    Number.isInteger(envPid) && envPid > 1 ? envPid : null,
  );
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = typeof json === "object" && json && "error" in json ? String((json as { error: unknown }).error) : res.statusText;
    throw new Error(`${path} ${res.status}: ${err}`);
  }
  return json as T;
}

async function heartbeat(pid: number, status: "ok" | "error", drained = 0, error?: string): Promise<void> {
  try {
    await post("/hook-heartbeat-by-pid", {
      pid,
      caller_pid: process.pid,
      client_type: CLIENT_TYPE,
      receiver_mode: RECEIVER_MODE,
      status,
      drained,
      error,
    });
  } catch (e) {
    log(`heartbeat failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function claim(pid: number, drainId: string): Promise<{ peer_id?: string; drain_id?: string; messages?: Message[] }> {
  return post("/claim-by-pid", {
    pid,
    caller_pid: process.pid,
    client_type: CLIENT_TYPE,
    receiver_mode: RECEIVER_MODE,
    drain_id: drainId,
    limit: MAX_MESSAGES,
    max_bytes: MAX_BYTES,
  });
}

async function main(): Promise<void> {
  const pids = findHookPeerPids();
  if (!pids) {
    process.exitCode = 1;
    return;
  }

  const drainId = `${RECEIVER_MODE}:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let claimed: { peer_id?: string; drain_id?: string; messages?: Message[] } | null = null;
  let pid = pids.primary;
  const claimPids = [pids.primary, ...pids.fallbacks].filter((candidate, index, all) => all.indexOf(candidate) === index);
  let lastClaimError = "";
  for (const candidatePid of claimPids) {
    pid = candidatePid;
    try {
      claimed = await claim(pid, drainId);
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastClaimError = msg;
      if (!/unknown target pid|no peer|peer not found/i.test(msg)) {
        log(`claim failed: ${msg}`);
        await heartbeat(pid, "error", 0, msg);
        return;
      }
    }
  }
  if (!claimed) {
    log(`claim failed: ${lastClaimError}`);
    await heartbeat(pid, "error", 0, lastClaimError);
    return;
  }

  const messages = claimed.messages ?? [];
  if (messages.length === 0 || !claimed.drain_id) {
    await heartbeat(pid, "ok", 0);
    return;
  }

  try {
    const ack = await post<AckByPidResponse>("/ack-by-pid", {
      pid,
      caller_pid: process.pid,
      client_type: CLIENT_TYPE,
      receiver_mode: RECEIVER_MODE,
      drain_id: claimed.drain_id,
      ids: messages.map((m) => m.id),
      via: RECEIVER_MODE,
    });
    if (ack.acked !== messages.length) {
      throw new Error(`ack mismatch: expected ${messages.length}, got ${ack.acked ?? 0}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`ack failed before stdout emit: ${msg}`);
    await heartbeat(pid, "error", 0, msg);
    process.exitCode = 1;
    return;
  }

  const lines = messages.map(renderInboundLine);
  const context = `---\n${messages.length} pending peer message(s):\n\n${lines.join("\n\n")}`;
  const output = {
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT_NAME,
      additionalContext: context,
    },
  };

  try {
    await Bun.write(Bun.stdout, `${JSON.stringify(output)}\n`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`stdout emit failed after ack: ${msg}`);
    await heartbeat(pid, "error", 0, msg);
    process.exitCode = 1;
    return;
  }
  await heartbeat(pid, "ok", messages.length);
}

if (import.meta.main) {
  main().catch((e) => {
    log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
