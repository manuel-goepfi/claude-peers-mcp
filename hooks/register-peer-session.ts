#!/usr/bin/env bun
import { closeSync, existsSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { isClientProcess as sharedIsClientProcess, isCodexAppServerProcess, type ProcessInfo } from "../shared/client.ts";
import {
  brokerIdentityPaneTarget as sharedBrokerIdentityPaneTarget,
  publishBrokerIdentityToTmux as sharedPublishBrokerIdentityToTmux,
  registrationTmuxPaneId as sharedRegistrationTmuxPaneId,
  type TmuxMirrorResult,
} from "../shared/tmux-identity.ts";
import type { ClientType, ReceiverMode, RegisterResponse } from "../shared/types.ts";
import { composeTmuxFromEnv, parsePsTree, parseTmuxPanes, type TmuxPaneInfo } from "../shared/tmux.ts";
import { findSingleVisibleCodexProcess, findVisibleCodexProcessByPaneId } from "../shared/visible-codex.ts";
import { brokerIsReady, openOwnerOnlyAppendLog, requestBroker } from "../shared/broker-client.ts";
import { brokerServiceConfig, installedBrokerServiceIsCurrent } from "../shared/broker-service.ts";

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const BROKER_SCRIPT = new URL("../broker.ts", import.meta.url).pathname;
const BROKER_LOG = process.env.CLAUDE_PEERS_BROKER_LOG ?? `${process.env.HOME}/.claude-peers-broker.log`;
const BROKER_LOG_MAX_BYTES = 10 * 1024 * 1024;
const BROKER_SYSTEMD_UNIT_PATH = `${process.env.HOME}/.config/systemd/user/claude-peers-broker.service`;
const SYSTEMD_START_TIMEOUT_SECONDS = "3";
type HookClientType = Extract<ClientType, "claude" | "codex" | "gemini">;
type HookReceiverMode = Extract<ReceiverMode, "claude-channel" | "codex-hook" | "gemini-hook">;
const receiverModeByClient: Record<HookClientType, HookReceiverMode> = {
  claude: "claude-channel",
  codex: "codex-hook",
  gemini: "gemini-hook",
};
function hookClientType(value: string | undefined): HookClientType {
  return value === "claude" || value === "gemini" ? value : "codex";
}
const CLIENT_TYPE = hookClientType(process.env.CLAUDE_PEERS_CLIENT_TYPE);
const RECEIVER_MODE = receiverModeByClient[CLIENT_TYPE];

interface RegisterMetadata {
  pid: number;
  cwd: string;
  git_root: string | null;
  absolute_git_dir: string | null;
  tty: string | null;
  name: string;
  tmux: TmuxPaneInfo | null;
  identity_env: Record<string, string | undefined>;
}

function log(msg: string): void {
  console.error(`[claude-peers ${CLIENT_TYPE}-register] ${msg}`);
}

export function sessionIdFromHookInput(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sessionId = (value as { session_id?: unknown }).session_id;
  if (typeof sessionId !== "string") return null;
  const trimmed = sessionId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

type TranscriptEvidence = "absent" | "present";
type RootSessionMatch = "unknown" | "yes" | "no";

export interface CodexHookSessionDiagnostic {
  eventName: string;
  source: string;
  sessionId: string | null;
  transcript: TranscriptEvidence;
  rootMatch: RootSessionMatch;
}

function boundedHookLabel(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const trimmed = value.trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(trimmed) ? trimmed : "unknown";
}

function transcriptSessionId(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const filename = value.trim().replaceAll("\\", "/").split("/").at(-1) ?? "";
  const match = filename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Report whether a Codex hook looks like the durable root session without
 * reading the transcript from disk. SessionStart can race transcript creation,
 * so field evidence is diagnostic while file existence is deliberately not.
 */
export function codexHookSessionDiagnostic(value: unknown): CodexHookSessionDiagnostic {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const sessionId = sessionIdFromHookInput(input);
  const transcriptPresent = typeof input.transcript_path === "string" && input.transcript_path.trim().length > 0;
  const transcriptId = transcriptSessionId(input.transcript_path);
  return {
    eventName: boundedHookLabel(input.hook_event_name),
    source: boundedHookLabel(input.source),
    sessionId,
    transcript: transcriptPresent ? "present" : "absent",
    rootMatch: !sessionId || !transcriptPresent || !transcriptId
      ? "unknown"
      : sessionId.toLowerCase() === transcriptId ? "yes" : "no",
  };
}

export type CodexHookRootRefusalReason =
  | "event-mismatch"
  | "missing-session-id"
  | "subagent-context"
  | "missing-transcript-path"
  | "transcript-session-mismatch";

export type CodexHookRootDegradedReason = "unparseable-transcript-path";

export function codexHookRefusalDiagnostic(reason: CodexHookRootRefusalReason): string {
  if (reason === "missing-transcript-path") {
    return "reason=missing-transcript-path possible=internal-session-or-root-rollout-io correlate=codex-warning-log";
  }
  return `reason=${reason}`;
}

/**
 * Codex runs user hooks for more than the operator-facing root thread. A
 * thread-spawned child is serialized as SubagentStart, while internal sessions
 * such as memory consolidation can be serialized as SessionStart. The durable
 * root is the event whose transcript filename carries the same UUID as the
 * hook session_id. This is field comparison only: the file may not exist yet.
 */
export function codexHookRootRefusalReason(
  value: unknown,
  expectedEventName: "SessionStart" | "UserPromptSubmit" | "Stop" | ReadonlyArray<"SessionStart" | "UserPromptSubmit" | "Stop">,
): CodexHookRootRefusalReason | null {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const allowedEvents = Array.isArray(expectedEventName) ? expectedEventName : [expectedEventName];
  if (typeof input.hook_event_name !== "string" || !allowedEvents.includes(
    input.hook_event_name as "SessionStart" | "UserPromptSubmit" | "Stop",
  )) return "event-mismatch";
  const sessionId = sessionIdFromHookInput(input);
  if (!sessionId) return "missing-session-id";
  // Codex serializes subagent turn context as top-level agent_id/agent_type
  // (schema.rs SubagentCommandInputFields, omitted for the root). A subagent
  // turn carries the ROOT thread's session_id, so it would pass every
  // session/transcript comparison — this is the one imposter the thread join
  // cannot filter, and it must be refused on the field Codex provides for it.
  if (codexHookSubagentContext(input)) return "subagent-context";
  if (typeof input.transcript_path !== "string" || !input.transcript_path.trim()) {
    return "missing-transcript-path";
  }
  const transcriptId = transcriptSessionId(input.transcript_path);
  // A present-but-unparseable path is not proof of a child session. Codex owns
  // the rollout filename format, so a future upstream rename must not darken
  // every root lane. Callers log the degraded proof and continue fail-open.
  if (!transcriptId) return null;
  return transcriptId === sessionId.toLowerCase() ? null : "transcript-session-mismatch";
}

/** True when the hook payload carries Codex's serialized subagent turn context. */
function codexHookSubagentContext(input: Record<string, unknown>): boolean {
  return [input.agent_id, input.agent_type].some(
    (field) => typeof field === "string" && field.trim().length > 0,
  );
}

export type CodexDrainRootDecision =
  | { action: "refuse"; reason: CodexHookRootRefusalReason }
  | { action: "thread-only" }
  | { action: "proven"; degraded: CodexHookRootDegradedReason | null };

/**
 * Drain-side root decision. Registration keeps the strict transcript proof —
 * it MINTS identity, and an internal session registering itself was the
 * original observer-row bug. A drain only ever CLAIMS against an existing row,
 * and the thread-routed claim (`/claim-by-thread`) resolves the broker row by
 * exact thread id — Codex's hook session_id IS the ThreadId, and an internal
 * session's own id matches no registered row (404, nothing drained).
 *
 * So a missing transcript_path must not refuse a drain: Codex omits it
 * whenever the thread has no materialized rollout (session persistence off,
 * or rollout IO pending — measured 326 refused drains on live root lanes),
 * and the transcript was only load-bearing for the PID-routed fallback, where
 * any same-process hook could reach the root's mailbox. The caller must
 * honor "thread-only": exact thread join, no PID fallback, no
 * self-registration (registration would refuse the same unproven payload).
 */
export function codexDrainRootDecision(
  value: unknown,
  expectedEventName: "SessionStart" | "UserPromptSubmit" | "Stop" | ReadonlyArray<"SessionStart" | "UserPromptSubmit" | "Stop">,
): CodexDrainRootDecision {
  const refusal = codexHookRootRefusalReason(value, expectedEventName);
  if (refusal === "missing-transcript-path") return { action: "thread-only" };
  if (refusal) return { action: "refuse", reason: refusal };
  return { action: "proven", degraded: codexHookRootDegradedReason(value) };
}

export function codexHookRootDegradedReason(value: unknown): CodexHookRootDegradedReason | null {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  if (!sessionIdFromHookInput(input)) return null;
  if (typeof input.transcript_path !== "string" || !input.transcript_path.trim()) return null;
  return transcriptSessionId(input.transcript_path) ? null : "unparseable-transcript-path";
}

async function readHookInput(): Promise<Record<string, unknown> | null> {
  if (process.stdin.isTTY) return null;
  try {
    const text = await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 1500)),
    ]);
    if (!text.trim()) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch (error) {
    log(`hook input unreadable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
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

export function findClientPidFromTable(
  table: Map<number, ProcessInfo>,
  startPid = process.ppid,
  clientType: HookClientType = CLIENT_TYPE,
): number | null {
  let current = startPid;
  for (let i = 0; i < 30; i++) {
    const row = table.get(current);
    if (!row) return null;
    if (sharedIsClientProcess(row, clientType)) {
      if (clientType === "codex" && isCodexAppServerProcess(row)) return null;
      return row.pid;
    }
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

function environOf(pid: number): Record<string, string | undefined> {
  try {
    const text = readFileSync(`/proc/${pid}/environ`, "utf8");
    const env: Record<string, string | undefined> = {};
    for (const entry of text.split("\0")) {
      const idx = entry.indexOf("=");
      if (idx <= 0) continue;
      env[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
    return env;
  } catch {
    return {};
  }
}

function findCodexAppServerAncestor(startPid: number, table: Map<number, ProcessInfo>): ProcessInfo | null {
  let current = startPid;
  for (let i = 0; i < 30; i++) {
    const row = table.get(current);
    if (!row) return null;
    if (isCodexAppServerProcess(row)) return row;
    if (row.ppid <= 1 || row.ppid === row.pid) return null;
    current = row.ppid;
  }
  return null;
}


function detectTmuxPane(pid: number, env: Record<string, string | undefined> = process.env): TmuxPaneInfo | null {
  try {
    const listProc = Bun.spawnSync([
      "tmux",
      "list-panes",
      "-a",
      "-F",
      "#{pane_pid}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_id}",
    ]);
    if (listProc.exitCode !== 0) return composeTmuxFromEnv(env);
    const paneMap = parseTmuxPanes(new TextDecoder().decode(listProc.stdout));
    const psProc = Bun.spawnSync(["ps", "-eo", "pid,ppid"]);
    if (psProc.exitCode !== 0) return composeTmuxFromEnv(env);
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
  return composeTmuxFromEnv(env);
}

export function registrationTmuxPaneId(tmuxInfo: TmuxPaneInfo | null, env: Record<string, string | undefined> = process.env): string | null {
  return sharedRegistrationTmuxPaneId(tmuxInfo, env);
}

export function brokerIdentityPaneTarget(tmuxInfo: TmuxPaneInfo | null, env: Record<string, string | undefined> = process.env): string | null {
  return sharedBrokerIdentityPaneTarget(tmuxInfo, env);
}

export function tmuxIdentityMirrorEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.CLAUDE_PEERS_TMUX_IDENTITY_MIRROR?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return true;
}

export function publishBrokerIdentityToTmux(identity: {
  id: string;
  name: string | null;
  resolved_name: string | null;
  client_type: ClientType;
  receiver_mode: ReceiverMode;
}, tmuxInfo: TmuxPaneInfo | null, identityEnv: Record<string, string | undefined> = process.env, controlEnv: Record<string, string | undefined> = process.env): TmuxMirrorResult {
  if (!tmuxIdentityMirrorEnabled(controlEnv)) return { ok: true, target: null, failedOptions: [], skipped: true };
  const result = sharedPublishBrokerIdentityToTmux(identity, tmuxInfo, {
    env: identityEnv,
    writeOperatorLabel: false,
  });
  if (!result.target) return result;
  const displayLabel = identity.name || identity.resolved_name || identity.id;
  const ok = result.failedOptions.length === 0;
  const failed = ok ? "" : ` failed_options=${result.failedOptions.join(",")}`;
  log(`tmux broker identity ${ok ? "mirrored" : "partially failed"} from hook: @peer_id=${identity.id} @peer_label=${displayLabel} (target=${result.target})${failed}`);
  return result;
}

interface PaneLabelRead {
  ok: boolean;
  peerResolvedName: string | null;
  operatorLabel: string | null;
}

type PaneLabelReader = (paneId: string) => PaneLabelRead;

function readPaneLabels(paneId: string): PaneLabelRead {
  try {
    const result = Bun.spawnSync([
      "tmux", "display-message", "-p", "-t", paneId,
      "#{@peer_resolved_name}\t#{@operator_label}",
    ], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return { ok: false, peerResolvedName: null, operatorLabel: null };
    const [peerResolvedName = "", operatorLabel = ""] = new TextDecoder()
      .decode(result.stdout)
      .replace(/\0/g, "")
      .trimEnd()
      .split("\t", 2);
    return {
      ok: true,
      peerResolvedName: peerResolvedName.trim() || null,
      operatorLabel: operatorLabel.trim() || null,
    };
  } catch {
    return { ok: false, peerResolvedName: null, operatorLabel: null };
  }
}

export function readPaneLabel(
  paneId: string | undefined,
  readLabels: PaneLabelReader = readPaneLabels,
  warn: (message: string) => void = log,
): string | null {
  if (!paneId) return null;
  // tmux can briefly reject a read while another client updates pane options.
  // One display-message reads the full precedence chain. Retry only genuine
  // failures or a transient empty snapshot. A pane that remains unlabeled may
  // use its launch identity without producing log noise.
  let failures = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = readLabels(paneId);
    if (!result.ok) {
      failures++;
      continue;
    }
    const label = result.peerResolvedName ?? result.operatorLabel;
    if (label) return label;
  }
  if (failures === 2) {
    warn(`tmux pane-label read failed twice pane=${paneId}; falling back to launch identity`);
  }
  return null;
}

export function peerName(clientType: HookClientType, pid: number, tmux: TmuxPaneInfo | null, env: Record<string, string | undefined>, paneLabel: string | null = readPaneLabel(tmux?.pane_id)): string {
  if (clientType === "codex" && paneLabel) return paneLabel;
  const envName = env.CLAUDE_PEER_NAME?.trim();
  if (envName) return envName;
  if (tmux?.session && tmux.pane_index) return `${tmux.session}.${tmux.pane_index}`;
  if (tmux?.session && tmux.window_index) return `${tmux.session}.${tmux.window_index}`;
  return `${clientType}-${pid}`;
}

async function metadata(): Promise<RegisterMetadata | null> {
  const table = processTable();
  let identityEnv: Record<string, string | undefined> = process.env;
  let pid = findClientPidFromTable(table);
  if (!pid && CLIENT_TYPE === "codex") {
    const appServer = findCodexAppServerAncestor(process.ppid, table);
    const visibleCwdHint = appServer ? (cwdOf(appServer.pid) ?? process.cwd()) : process.cwd();
    const readers = { getTty, cwdOf, environOf };
    const inheritedPaneId = process.env.TMUX_PANE ?? process.env.CLAUDE_PEER_TMUX_PANE_ID;
    const exactVisible = inheritedPaneId
      ? findVisibleCodexProcessByPaneId(table, null, inheritedPaneId, readers)
      : null;
    const visible = inheritedPaneId
      ? exactVisible
      : findSingleVisibleCodexProcess(table, visibleCwdHint, readers);
    if (visible) {
      pid = visible.pid;
      identityEnv = visible.env;
      log(exactVisible
        ? `app-server hook identity resolved via inherited pane ${inheritedPaneId} pid=${pid} cwd=${visible.cwd}`
        : `app-server hook identity resolved via sole visible TTY pid=${pid} cwd=${visibleCwdHint}`);
    }
  }
  if (!pid) {
    log(`no ${CLIENT_TYPE} ancestor found`);
    return null;
  }
  const cwd = cwdOf(pid) ?? process.cwd();
  const tmux = detectTmuxPane(pid, identityEnv);
  return {
    pid,
    cwd,
    git_root: await getGitRoot(cwd),
    absolute_git_dir: await getAbsoluteGitDir(cwd),
    tty: getTty(pid),
    name: peerName(CLIENT_TYPE, pid, tmux, identityEnv),
    tmux,
    identity_env: identityEnv,
  };
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return requestBroker<T>({ baseUrl: BROKER_URL, path, body, timeoutMs: 3000 });
}

async function isBrokerAlive(): Promise<boolean> {
  return brokerIsReady(BROKER_URL, 1000);
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

function startBrokerViaSystemd(): boolean {
  if (!existsSync(BROKER_SYSTEMD_UNIT_PATH)) return false;
  const serviceConfig = brokerServiceConfig();
  if (!installedBrokerServiceIsCurrent(serviceConfig)) {
    log("systemd broker unit/drop-in is stale, unsafe, or configured for different paths; refusing managed start and using verified direct startup");
    return false;
  }
  try {
    const proc = Bun.spawnSync(["timeout", SYSTEMD_START_TIMEOUT_SECONDS, "systemctl", "--user", "start", "claude-peers-broker.service"], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if (proc.exitCode === 0) return true;
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    log(`systemd broker start failed; falling back to direct spawn${stderr ? `: ${stderr}` : ""}`);
  } catch (e) {
    log(`systemd broker start failed; falling back to direct spawn: ${e instanceof Error ? e.message : String(e)}`);
  }
  return false;
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) return;
  if (startBrokerViaSystemd()) {
    for (let i = 0; i < 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (await isBrokerAlive()) return;
    }
    log("systemd broker start did not become healthy; falling back to direct spawn");
  }
  rotateBrokerLogIfLarge();
  const logFd = openOwnerOnlyAppendLog(BROKER_LOG);
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

export async function runRegistration(): Promise<void> {
  const hookInput = await readHookInput();
  const threadId = sessionIdFromHookInput(hookInput);
  if (CLIENT_TYPE === "codex") {
    const diagnostic = codexHookSessionDiagnostic(hookInput);
    log(
      `hook-input event=${diagnostic.eventName} source=${diagnostic.source} ` +
      `session_id=${diagnostic.sessionId ?? "absent"} transcript=${diagnostic.transcript} ` +
      `root_match=${diagnostic.rootMatch}`,
    );
    const refusalReason = codexHookRootRefusalReason(
      hookInput,
      ["SessionStart", "UserPromptSubmit", "Stop"],
    );
    if (refusalReason) {
      if (refusalReason === "missing-session-id") {
        log("hook input has no session_id; refusing an unbound Codex registration");
        process.exitCode = 1;
      } else {
        log(`skipping unproven Codex registration ${codexHookRefusalDiagnostic(refusalReason)}`);
      }
      return;
    }
    const degradedReason = codexHookRootDegradedReason(hookInput);
    if (degradedReason) {
      log(`Codex root proof degraded reason=${degradedReason}; continuing fail-open`);
    }
  }
  const meta = await metadata();
  if (!meta) {
    process.exitCode = 1;
    return;
  }

  try {
    await ensureBroker();
    const reg = await post<RegisterResponse>("/register", {
      pid: meta.pid,
      cwd: meta.cwd,
      git_root: meta.git_root,
      absolute_git_dir: meta.absolute_git_dir,
      tty: meta.tty,
      name: meta.name,
      tmux_session: meta.tmux?.session ?? null,
      tmux_window_index: meta.tmux?.window_index ?? null,
      tmux_window_name: meta.tmux?.window_name ?? null,
      tmux_pane_id: registrationTmuxPaneId(meta.tmux, meta.identity_env),
      thread_id: threadId,
      client_type: CLIENT_TYPE,
      receiver_mode: RECEIVER_MODE,
      preserve_token: true,
      summary: "",
    });
    publishBrokerIdentityToTmux(reg, meta.tmux, meta.identity_env);
    await post("/hook-heartbeat-by-pid", {
      pid: meta.pid,
      caller_pid: process.pid,
      client_type: CLIENT_TYPE,
      receiver_mode: RECEIVER_MODE,
      status: "ok",
      drained: 0,
    });
    publishBrokerIdentityToTmux({
      ...reg,
      client_type: CLIENT_TYPE,
      receiver_mode: RECEIVER_MODE,
    }, meta.tmux, meta.identity_env);
  } catch (e) {
    process.exitCode = 1;
    log(`registration failed: ${e instanceof Error ? e.message : String(e)}`);
  }

}

if (import.meta.main) {
  runRegistration().catch(async (e) => {
    process.exitCode = 1;
    log(`unexpected failure: ${e instanceof Error ? e.message : String(e)}`);
  });
}
