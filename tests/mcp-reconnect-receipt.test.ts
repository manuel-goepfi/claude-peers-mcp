import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startTestBroker } from "./helpers/test-broker.ts";

test("fresh MCP adapter reconnects and receives and acknowledges a new message", async () => {
  const broker = await startTestBroker({ prefix: "rollout-reconnect" });
  let client: Client | undefined;
  const db = new Database(broker.dbPath, { readonly: true });
  const env = Object.fromEntries(Object.entries({
    ...process.env,
    CLAUDE_PEERS_PORT: String(broker.port),
    CLAUDE_PEERS_DB: broker.dbPath,
    CLAUDE_PEERS_BRIDGE_TOKEN_FILE: broker.tokenPath,
    CLAUDE_PEERS_CLIENT_TYPE: "unknown",
    CLAUDE_PEER_NAME: "rollout-reconnect-receiver",
    CLAUDE_PEERS_TMUX_IDENTITY_MIRROR: "0",
    TMUX: undefined, TMUX_PANE: undefined,
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  async function connect() {
    const next = new Client({ name: "rollout-reconnect", version: "1" });
    client = next;
    await next.connect(new StdioClientTransport({ command: "bun",
      args: [new URL("../server.ts", import.meta.url).pathname],
      cwd: new URL("..", import.meta.url).pathname, env, stderr: "pipe" }));
    return next;
  }
  async function post(path: string, body: unknown, token?: string) {
    const response = await fetch(`${broker.url}${path}`, { method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { "X-Peer-Token": token } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    expect(response.ok).toBe(true);
    return response.json();
  }
  try {
    await connect();
    await client!.close();
    const reconnected = await connect();
    const receiver = db.query("SELECT id FROM peers WHERE name = ? ORDER BY last_seen DESC LIMIT 1")
      .get("rollout-reconnect-receiver") as { id: string };
    expect(receiver).toBeTruthy();
    const sender = await post("/register", { pid: process.pid, cwd: "/rollout-test-sender",
      git_root: null, tty: null, name: "rollout-test-sender", summary: "",
      client_type: "unknown", receiver_mode: "unknown" }) as { id: string; token: string };
    const marker = `receipt-${crypto.randomUUID()}`;
    const sent = await post("/send-message", { from_id: sender.id,
      to_id: receiver.id, text: marker }, sender.token) as { id: number };
    const result = await reconnected.callTool({ name: "check_messages", arguments: {} });
    expect(JSON.stringify(result.content)).toContain(marker);
    const row = db.query("SELECT delivered, delivered_at FROM messages WHERE id = ?")
      .get(sent.id) as { delivered: number; delivered_at: string | null };
    expect(row.delivered).toBe(1);
    expect(row.delivered_at).toBeTruthy();
    const again = await reconnected.callTool({ name: "check_messages", arguments: {} });
    expect(JSON.stringify(again.content)).not.toContain(marker);
  } finally {
    await client?.close();
    db.close();
    await broker.stop();
  }
}, 15000);
