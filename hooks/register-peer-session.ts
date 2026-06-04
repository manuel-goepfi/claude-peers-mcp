#!/usr/bin/env bun
import { closeSync, existsSync, openSync, readlinkSync, statSync } from "node:fs";
import type { ProcessInfo } from "../shared/client.ts";
import type { ClientType, ReceiverMode, RegisterResponse } from "../shared/types.ts";
import { composeTmuxFromEnv, parsePsTree, parseTmuxPanes, type TmuxPaneInfo } from "../shared/tmux.ts";

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const BROKER_SCRIPT = new URL("../broker.ts", import.meta.url).pathname;
const BROKER_LOG = `${process.env.HOME}/.claude-peers-broker.log`;
const BROKER_LOG_MAX_BYTES = 10 * 1024 * 1024;
const CLIENT_TYPE: Extract<ClientType, "codex" | "gemini"> =
  process.env.CLAUDE_PEERS_CLIENT_TYPE === "gemini" ? "gemini" : "codex";
const RECEIVER_MODE: Extract<ReceiverMode, "codex-hook" | "gemini-hook"> =
  CLIENT_TYPE === "gemini" ? "gemini-hook" : "codex-hook";

interface RegisterMetadata {
  pid: number;
  cwd: string;
  git_root: string | null;
  absolute_git_dir: string | null;
  tty: string | null;
  name: string;
  tmux: TmuxPaneInfo | null;
}

function log(msg: string): void {
  console.error(`[claude-peers ${CLIENT_TYPE}-register] ${msg}`);
}

function processTable(): Map<number, ProcessInfo> {
  const table = new Map<number, ProcessInfo>();
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

function hasGeminiCliLauncher(args: string): boolean {
  return argTokens(args).some((token) => {
    const normalized = token.replace(/^['"]|['"]$/g, "").toLowerCase();
    const base = normalized.replace(/^.*\//, "");
    return normalized.includes("@google/gemini-cli/") || base === "gemini.js" || base === "gemini-cli.js";
  });
}

function isClientProcess(row: ProcessInfo, clientType: Extract<ClientType, "codex" | "gemini">): boolean {
  const comm = commandName(row.comm);
  const firstArg = commandName(row.args);
  if (comm === clientType || comm.startsWith(`${clientType}-`)) return true;
  if (firstArg === clientType || firstArg.startsWith(`${clientType}-`)) return true;
  return clientType === "gemini" && (comm === "node" || comm === "bun" || comm === "npx") && hasGeminiCliLauncher(row.args);
}

export function findClientPidFromTable(
  table: Map<number, ProcessInfo>,
  startPid = process.ppid,
  clientType: Extract<ClientType, "codex" | "gemini"> = CLIENT_TYPE,
): number | null {
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

function cwdOf(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

async function gitValue(cwd: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    return await proc.exited === 0 ? text.trim() : null;
  } catch {
    return null;
  }
}

async function getGitRoot(cwd: string): Promise<string | null> {
  return gitValue(cwd, ["rev-parse", "--show-toplevel"]);
}

async function getAbsoluteGitDir(cwd: string): Promise<string | null> {
  const bare = await gitValue(cwd, ["rev-parse", "--is-bare-repository"]);
  if (bare === "true") return null;
  return gitValue(cwd, ["rev-parse", "--absolute-git-dir"]);
}

function getTty(pid: number): string | null {
  try {
    const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(pid)]);
    const tty = new TextDecoder().decode(proc.stdout).trim();
    return tty && tty !== "?" && tty !== "??" ? tty : null;
  } catch {
    return null;
  }
}

function detectTmuxPane(pid: number): TmuxPaneInfo | null {
  try {
    const listProc = Bun.spawnSync([
      "tmux",
      "list-panes",
      "-a",
      "-F",
      "#{pane_pid}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_id}",
    ]);
    if (listProc.exitCode !== 0) return composeTmuxFromEnv(process.env);
    const paneMap = parseTmuxPanes(new TextDecoder().decode(listProc.stdout));
    const psProc = Bun.spawnSync(["ps", "-eo", "pid,ppid"]);
    if (psProc.exitCode !== 0) return composeTmuxFromEnv(process.env);
    const ppidMap = parsePsTree(new TextDecoder().decode(psProc.stdout));

    let current = pid;
    for (let i = 0; i < 30; i++) {
      const pane = paneMap.get(current);
      if (pane) return pane;
      const parent = ppidMap.get(current);
      if (parent === undefined || parent <= 1 || parent === current) break;
      current = parent;
    }
  } catch {
    // Fall through to env hints.
  }
  return composeTmuxFromEnv(process.env);
}

function peerName(clientType: Extract<ClientType, "codex" | "gemini">, pid: number, tmux: TmuxPaneInfo | null): string {
  const envName = process.env.CLAUDE_PEER_NAME?.trim();
  if (envName) return envName;
  if (tmux?.session && tmux.pane_index) return `${tmux.session}.${tmux.pane_index}`;
  if (tmux?.session && tmux.window_index) return `${tmux.session}.${tmux.window_index}`;
  return `${clientType}-${pid}`;
}

async function metadata(): Promise<RegisterMetadata | null> {
  const table = processTable();
  const pid = findClientPidFromTable(table);
  if (!pid) {
    log(`no ${CLIENT_TYPE} ancestor found`);
    return null;
  }
  const cwd = cwdOf(pid) ?? process.cwd();
  const tmux = detectTmuxPane(pid);
  return {
    pid,
    cwd,
    git_root: await getGitRoot(cwd),
    absolute_git_dir: await getAbsoluteGitDir(cwd),
    tty: getTty(pid),
    name: peerName(CLIENT_TYPE, pid, tmux),
    tmux,
  };
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

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

function rotateBrokerLogIfLarge(): void {
  try {
    if (!existsSync(BROKER_LOG)) return;
    if (statSync(BROKER_LOG).size <= BROKER_LOG_MAX_BYTES) return;
    Bun.spawnSync(["mv", "-f", BROKER_LOG, `${BROKER_LOG}.old`]);
  } catch (e) {
    log(`log rotation failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) return;
  rotateBrokerLogIfLarge();
  const logFd = openSync(BROKER_LOG, "a");
  try {
    const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
      stdio: ["ignore", "ignore", logFd],
    });
    proc.unref();
  } finally {
    closeSync(logFd);
  }
  for (let i = 0; i < 15; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (await isBrokerAlive()) return;
  }
}

async function main(): Promise<void> {
  const meta = await metadata();
  if (!meta) {
    await Bun.write(Bun.stdout, `${JSON.stringify({ suppressOutput: true })}\n`);
    return;
  }

  const summary = meta.tmux?.session
    ? `[tmux ${meta.tmux.window_name ? `${meta.tmux.session}:${meta.tmux.window_name}` : meta.tmux.session}] ${CLIENT_TYPE} startup registered`
    : `${CLIENT_TYPE} startup registered`;

  try {
    await ensureBroker();
    await post<RegisterResponse>("/register", {
      pid: meta.pid,
      cwd: meta.cwd,
      git_root: meta.git_root,
      absolute_git_dir: meta.absolute_git_dir,
      tty: meta.tty,
      name: meta.name,
      tmux_session: meta.tmux?.session ?? null,
      tmux_window_index: meta.tmux?.window_index ?? null,
      tmux_window_name: meta.tmux?.window_name ?? null,
      tmux_pane_id: meta.tmux?.pane_id ?? (process.env.TMUX_PANE ?? null),
      client_type: CLIENT_TYPE,
      receiver_mode: RECEIVER_MODE,
      preserve_token: true,
      summary,
    });
    await post("/hook-heartbeat-by-pid", {
      pid: meta.pid,
      caller_pid: process.pid,
      client_type: CLIENT_TYPE,
      receiver_mode: RECEIVER_MODE,
      status: "ok",
      drained: 0,
    });
  } catch (e) {
    log(`registration failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  await Bun.write(Bun.stdout, `${JSON.stringify({ suppressOutput: true })}\n`);
}

if (import.meta.main) {
  main().catch(async (e) => {
    log(`unexpected failure: ${e instanceof Error ? e.message : String(e)}`);
    await Bun.write(Bun.stdout, `${JSON.stringify({ suppressOutput: true })}\n`);
  });
}
