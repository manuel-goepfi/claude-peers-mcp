import { join } from "node:path";

const MCP_KEY = "claude-peers";

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function managedOpenCodeMcpEntry(repoRoot: string): Record<string, unknown> {
  return {
    type: "local",
    command: ["bun", join(repoRoot, "server.ts")],
    enabled: true,
    environment: { CLAUDE_PEERS_CLIENT_TYPE: "opencode" },
  };
}

export function installOpenCodeMcp(
  document: Record<string, unknown>,
  repoRoot: string,
): Record<string, unknown> {
  const mcp = objectValue(document.mcp);
  return {
    ...document,
    mcp: { ...mcp, [MCP_KEY]: managedOpenCodeMcpEntry(repoRoot) },
  };
}

export function uninstallOpenCodeMcp(
  document: Record<string, unknown>,
  repoRoot: string,
): Record<string, unknown> {
  const mcp = objectValue(document.mcp);
  const current = JSON.stringify(mcp[MCP_KEY]);
  if (current !== JSON.stringify(managedOpenCodeMcpEntry(repoRoot))) return document;
  const { [MCP_KEY]: _managed, ...remaining } = mcp;
  const next = { ...document };
  if (Object.keys(remaining).length > 0) next.mcp = remaining;
  else delete next.mcp;
  return next;
}
