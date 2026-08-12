import type { ClientType, ReceiverMode } from "./types.ts";

export interface ProcessInfo {
  pid: number;
  ppid: number;
  comm: string;
  args: string;
}

function normalizedClient(value: string | undefined): ClientType | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v === "claude" || v === "claude-code") return "claude";
  if (v === "codex") return "codex";
  if (v === "gemini" || v === "gemini-cli") return "gemini";
  if (v === "cursor" || v === "cursor-agent") return "cursor";
  if (v === "agy") return "agy";
  if (v === "kimi" || v === "kimi-code") return "kimi";
  if (v === "unknown") return "unknown";
  return null;
}

function commandName(value: string): string {
  return value.trim().split(/\s+/)[0]?.toLowerCase().replace(/^.*\//, "") ?? "";
}

function argTokens(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

function hasGeminiCliLauncher(args: string): boolean {
  const tokens = argTokens(args);
  // nvm/npm bin-shim shape: node executes a script literally named `gemini`
  // (e.g. `node ~/.nvm/versions/node/v22.22.2/bin/gemini`). Only the SCRIPT
  // position (token 1) counts, and it must be a path — a bare `gemini` word
  // appearing as a later argument is not a launcher.
  const script = tokens[1]?.replace(/^['"]|['"]$/g, "").toLowerCase() ?? "";
  if (script.includes("/") && script.replace(/^.*\//, "") === "gemini") return true;
  return tokens.some((token) => {
    const normalized = token.replace(/^['"]|['"]$/g, "").toLowerCase();
    const base = normalized.replace(/^.*\//, "");
    return normalized.includes("@google/gemini-cli/") || base === "gemini.js" || base === "gemini-cli.js";
  });
}

// Cursor's CLI installs as `~/.local/bin/agent` running
// `agent --use-system-ca ~/.local/share/cursor-agent/versions/<v>/index.js`
// (comm is often "MainThread", not "agent"). A bare `agent` binary name is far
// too generic to classify on its own — require the cursor-agent install path
// in the argv before calling it Cursor.
function hasCursorAgentLauncher(args: string): boolean {
  return argTokens(args).some((token) => {
    const normalized = token.replace(/^['"]|['"]$/g, "").toLowerCase();
    return normalized.includes("cursor-agent/") || normalized.replace(/^.*\//, "") === "cursor-agent";
  });
}

export function isClientProcess(row: ProcessInfo, clientType: Exclude<ClientType, "unknown">): boolean {
  const comm = commandName(row.comm);
  const firstArg = commandName(row.args);
  // Node-shim launch shape: `node /.../bin/codex --remote unix:// ...` — the
  // Codex TUI attached to an app-server runs under the npm bin shim, so its
  // first token classifies as "node" and the ancestor walk saw no codex client
  // at all. Registration then refused the lane's hooks outright ("no codex
  // ancestor found"), which kept codexd relaunches off the peers bus even
  // after thread-keyed seats landed. The client identity is the SECOND token.
  if (clientType === "codex" && (comm === "node" || firstArg === "node" || comm === "bun")) {
    const second = row.args.split(/\s+/)[1];
    if (second && commandName(second) === "codex") return true;
  }
  if (clientType === "claude") return comm === "claude" || firstArg === "claude";
  // kimi ships as `kimi` (installed at ~/.kimi-code/bin/kimi) but its process is
  // commonly seen as `kimi-code`. Match both; the generic prefix rule below would
  // catch "kimi-code" only, and lanes registered as client_type=unknown get NO
  // delivery path at all — background polling is disabled for unknown clients and
  // the poller has no idle profile for them, so their mail simply sits.
  if (clientType === "kimi") return comm === "kimi" || comm === "kimi-code" || firstArg === "kimi" || firstArg === "kimi-code";
  if (clientType === "cursor") return hasCursorAgentLauncher(row.args);
  if (comm === clientType || comm.startsWith(`${clientType}-`)) return true;
  if (firstArg === clientType || firstArg.startsWith(`${clientType}-`)) return true;
  return clientType === "gemini" && (comm === "node" || comm === "bun" || comm === "npx") && hasGeminiCliLauncher(row.args);
}

export function isCodexAppServerProcess(row: ProcessInfo): boolean {
  const comm = commandName(row.comm);
  const firstArg = commandName(row.args);
  if (comm !== "codex" && firstArg !== "codex") return false;
  return /\bapp-server\b/.test(row.args);
}

export function findClientPidFromProcessChain(
  startPid: number,
  processes: Map<number, ProcessInfo>,
  clientType: Exclude<ClientType, "unknown">,
): number | null {
  let current = startPid;
  for (let i = 0; i < 30; i++) {
    const p = processes.get(current);
    if (!p) break;
    if (isClientProcess(p, clientType)) {
      // Codex Desktop runs MCP servers and hooks under a long-lived
      // `codex app-server` process. That process is a transport host, not the
      // visible tmux lane that should receive peer mail. Return null here so
      // callers can fall back to a visible TTY Codex resolver instead of
      // registering the app-server as a routable peer.
      if (clientType === "codex" && isCodexAppServerProcess(p)) return null;
      return p.pid;
    }
    if (p.ppid <= 1 || p.ppid === current) break;
    current = p.ppid;
  }
  return null;
}

// Claude Code pre-warms spare sessions (`claude --bg-spare /tmp/cc-daemon-...`)
// that load MCP servers before any real session exists. A spare inherits stale
// CLAUDE_PEER_NAME / TMUX_PANE env from the shell that started the daemon, so
// registering it creates a ghost duplicate on a pane it does not occupy
// (observed 2026-06-10: ux.2#3 squatting pane %34). Returns the spare ancestor
// row when the chain contains one, else null.
export function findBgSpareAncestor(
  startPid: number,
  processes: Map<number, ProcessInfo>,
): ProcessInfo | null {
  let current = startPid;
  for (let i = 0; i < 30; i++) {
    const p = processes.get(current);
    if (!p) break;
    if (/(^|\s)--bg-spare(\s|$)/.test(p.args)) return p;
    if (p.ppid <= 1 || p.ppid === current) break;
    current = p.ppid;
  }
  return null;
}

export function detectClientFromProcessChain(
  startPid: number,
  processes: Map<number, ProcessInfo>,
  env: Record<string, string | undefined> = process.env,
): ClientType {
  const override = normalizedClient(env.CLAUDE_PEERS_CLIENT_TYPE);
  if (override) return override;

  let current = startPid;
  for (let i = 0; i < 30; i++) {
    const p = processes.get(current);
    if (!p) break;
    if (isClientProcess(p, "codex")) return "codex";
    if (isClientProcess(p, "gemini")) return "gemini";
    if (isClientProcess(p, "cursor")) return "cursor";
    if (isClientProcess(p, "agy")) return "agy";
    if (isClientProcess(p, "kimi")) return "kimi";
    if (isClientProcess(p, "claude")) return "claude";
    if (p.ppid <= 1 || p.ppid === current) break;
    current = p.ppid;
  }
  return "unknown";
}

export function initialReceiverMode(clientType: ClientType): ReceiverMode {
  if (clientType === "claude") return "claude-channel";
  if (clientType === "codex") return "manual-drain";
  if (clientType === "gemini") return "manual-drain";
  if (clientType === "cursor") return "manual-drain";
  if (clientType === "agy") return "manual-drain";
  // kimi has no drain hook: it receives by calling check_messages after a nudge,
  // the same path codex uses and which was proven end-to-end on 2026-07-30.
  if (clientType === "kimi") return "manual-drain";
  return "unknown";
}
