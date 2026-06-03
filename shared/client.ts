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
  return argTokens(args).some((token) => {
    const normalized = token.replace(/^['"]|['"]$/g, "").toLowerCase();
    const base = normalized.replace(/^.*\//, "");
    return normalized.includes("@google/gemini-cli/") || base === "gemini.js" || base === "gemini-cli.js";
  });
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
    const comm = commandName(p.comm);
    if (comm === "codex" || comm.startsWith("codex-")) return "codex";
    if (comm === "gemini" || comm.startsWith("gemini-")) return "gemini";
    if (comm === "claude") return "claude";
    const firstArg = commandName(p.args);
    if (firstArg === "codex" || firstArg.startsWith("codex-")) return "codex";
    if (firstArg === "gemini" || firstArg.startsWith("gemini-")) return "gemini";
    if (firstArg === "claude") return "claude";
    if ((comm === "node" || comm === "bun" || comm === "npx") && hasGeminiCliLauncher(p.args)) return "gemini";
    if (p.ppid <= 1 || p.ppid === current) break;
    current = p.ppid;
  }
  return "unknown";
}

export function initialReceiverMode(clientType: ClientType): ReceiverMode {
  if (clientType === "claude") return "claude-channel";
  if (clientType === "codex") return "manual-drain";
  if (clientType === "gemini") return "manual-drain";
  return "unknown";
}
