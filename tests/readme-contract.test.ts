import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PEERS_VERSION } from "../shared/version.ts";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const toolNames = [
  "list_peers",
  "send_message",
  "send_to_peer",
  "inspect_peer_pane",
  "broadcast_message",
  "set_summary",
  "set_name",
  "find_peer",
  "check_messages",
  "whoami",
] as const;

const publicVariables = [
  "CLAUDE_PEERS_PORT",
  "CLAUDE_PEERS_HOST",
  "CLAUDE_PEERS_HOSTNAME",
  "CLAUDE_PEERS_DB",
  "CLAUDE_PEERS_BACKUP",
  "CLAUDE_PEERS_BROKER_LOG",
  "CLAUDE_PEERS_OWNER_MODE",
  "CLAUDE_PEERS_BRIDGE_ENABLED",
  "CLAUDE_PEERS_BRIDGE_TOKEN_FILE",
  "CLAUDE_PEERS_METRICS_ENABLED",
  "CLAUDE_PEERS_ADAPTIVE_POLLING",
  "CLAUDE_PEERS_TMUX_UNCHANGED_WRITE_SUPPRESSION",
  "CLAUDE_PEERS_HEARTBEAT_PHASE_SPREAD",
  "CLAUDE_PEERS_HEARTBEAT_MS",
  "CLAUDE_PEERS_TMUX_REDETECT_EVERY",
  "CLAUDE_PEERS_ORPHAN_EXIT_GRACE_MS",
  "CLAUDE_PEERS_DEAD_MAIL_TTL_MS",
  "CLAUDE_PEERS_DELIVERED_MSG_TTL_MS",
  "CLAUDE_PEERS_UNDELIVERED_MSG_TTL_MS",
  "CLAUDE_PEERS_CLI_TIMEOUT_MS",
  "CLAUDE_PEERS_NO_AUTOSTART",
  "CLAUDE_PEER_NAME",
] as const;

describe("public distribution contract", () => {
  test("README matches the runtime tool inventory", () => {
    const readme = read("README.md");
    const server = read("server.ts");
    const runtimeTools = [...server.matchAll(/\n\s{4}name: "([a-z_]+)",/g)].map((match) => match[1]);
    expect(runtimeTools).toEqual([...toolNames]);
    for (const name of toolNames) expect(readme).toContain(`\`${name}\``);
  });

  test("README documents the supported public configuration", () => {
    const readme = read("README.md");
    const runtime = [
      "server.ts",
      "broker.ts",
      "cli.ts",
      "shared/broker-service.ts",
    ].map(read).join("\n");
    for (const variable of publicVariables) {
      expect(runtime).toContain(variable);
      expect(readme).toContain(`\`${variable}\``);
    }
    expect(readme).toContain("Linux");
    expect(readme).toContain("Bun 1.3.11");
    expect(readme).toContain("--json");
    expect(readme).toContain("manual-drain");
    for (const state of ["queued", "claimed", "acknowledged", "unknown"]) {
      expect(readme).toContain(`\`${state}\``);
    }
  });

  test("package, version, repository, fixture, and license agree", () => {
    const pkg = JSON.parse(read("package.json")) as {
      version: string;
      license: string;
      repository: { url: string };
      engines: { bun: string };
      packageManager: string;
    };
    const mcp = JSON.parse(read(".mcp.json")) as { mcpServers: Record<string, { command: string; args: string[] }> };
    const license = read("LICENSE");
    const readme = read("README.md");

    expect(pkg.version).toBe(PEERS_VERSION);
    expect(pkg.license).toBe("MIT");
    expect(pkg.repository.url).toBe("https://github.com/manuel-goepfi/claude-peers-mcp.git");
    expect(pkg.engines.bun).toBe("1.3.11");
    expect(pkg.packageManager).toBe("bun@1.3.11");
    expect(readme).toContain(pkg.repository.url);
    expect(mcp.mcpServers["claude-peers"]).toEqual({ command: "bun", args: ["./server.ts"] });
    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) 2026 Louis Arge");
  });

  test("public docs do not retain removed summary dependencies or local paths", () => {
    const publicDocs = [
      "README.md",
      "CLAUDE.md",
      "docs/operations.md",
      "docs/systemd/README.md",
      "docs/systemd/claude-peers-broker.service",
      "docs/systemd/claude-peers-codex-autodrain.service",
    ].map(read).join("\n");
    expect(publicDocs).not.toContain("OPENAI_API_KEY");
    expect(publicDocs).not.toContain("gpt-5.4-nano");
    expect(publicDocs).not.toContain("Auto-summary");
    expect(publicDocs).not.toContain("/home/manzo");
  });
});
