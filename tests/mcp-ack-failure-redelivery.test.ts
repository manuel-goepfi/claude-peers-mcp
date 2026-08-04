import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startTestBroker, type TestBroker } from "./helpers/test-broker.ts";

const SERVER_SCRIPT = new URL("../server.ts", import.meta.url).pathname;

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

async function waitFor<T>(probe: () => T | null, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== null) return value;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function post<T>(broker: TestBroker, path: string, body: unknown, token?: string): Promise<T> {
  const response = await fetch(`${broker.url}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Peer-Token": token } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await response.json() as T;
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

test("check_messages returns a claimed body when ACK fails and the lease can be reclaimed", async () => {
  const broker = await startTestBroker({ prefix: "mcp-ack-failure" });
  cleanup.push(() => broker.stop());

  let ackAttempts = 0;
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const source = new URL(request.url);
      if (request.method === "POST" && source.pathname === "/ack-by-pid") {
        ackAttempts++;
        return Response.json({ ok: true, acked: 0 });
      }
      const target = new URL(source.pathname + source.search, broker.url);
      return fetch(new Request(target.href, request));
    },
  });
  cleanup.push(() => proxy.stop(true));

  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      CLAUDE_PEERS_PORT: String(proxy.port),
      CLAUDE_PEERS_DB: broker.dbPath,
      CLAUDE_PEERS_BRIDGE_TOKEN_FILE: broker.tokenPath,
      CLAUDE_PEERS_CLIENT_TYPE: "unknown",
      CLAUDE_PEER_NAME: "mcp-ack-failure-receiver",
      CLAUDE_PEERS_TMUX_IDENTITY_MIRROR: "0",
      TMUX: undefined,
      TMUX_PANE: undefined,
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const transport = new StdioClientTransport({
    command: "bun",
    args: [SERVER_SCRIPT],
    cwd: new URL("..", import.meta.url).pathname,
    env,
    stderr: "pipe",
  });
  let serverStderr = "";
  transport.stderr?.on("data", (chunk) => {
    serverStderr += String(chunk);
  });
  const client = new Client({ name: "mcp-ack-failure-test", version: "1" });
  cleanup.push(async () => client.close());
  await client.connect(transport);

  const receiver = await waitFor(() => {
    const db = new Database(broker.dbPath, { readonly: true });
    try {
      return db.query("SELECT id, pid FROM peers WHERE name = ?").get("mcp-ack-failure-receiver") as
        { id: string; pid: number } | null;
    } finally {
      db.close();
    }
  }, "MCP receiver registration");
  expect(transport.pid).not.toBeNull();
  expect(receiver.pid).toBe(transport.pid!);

  const sender = await post<{ id: string; token: string }>(broker, "/register", {
    pid: process.pid,
    cwd: "/mcp-ack-failure-sender",
    git_root: null,
    tty: null,
    name: "mcp-ack-failure-sender",
    tmux_session: null,
    tmux_window_index: null,
    tmux_window_name: null,
    client_type: "unknown",
    receiver_mode: "unknown",
    summary: "",
  });
  const sent = await post<{ id: number }>(broker, "/send-message", {
    from_id: sender.id,
    to_id: receiver.id,
    text: "survives failed acknowledgement",
  }, sender.token);

  const toolResult = await client.callTool({ name: "check_messages", arguments: {} });
  expect(toolResult.content).toEqual([
    expect.objectContaining({
      type: "text",
      text: expect.stringContaining("survives failed acknowledgement"),
    }),
  ]);
  expect(ackAttempts).toBe(1);
  await waitFor(
    () => serverStderr.includes("claimed inbox ack failed; message may be retried") ? true : null,
    "observable ACK failure log",
  );

  const db = new Database(broker.dbPath);
  try {
    const afterFailure = db.query(
      "SELECT delivered, claimed_by, claimed_at FROM messages WHERE id = ?",
    ).get(sent.id) as { delivered: number; claimed_by: string | null; claimed_at: string | null };
    expect(afterFailure.delivered).toBe(0);
    expect(afterFailure.claimed_by).not.toBeNull();
    expect(afterFailure.claimed_at).not.toBeNull();

    db.query("UPDATE messages SET claimed_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), sent.id);
  } finally {
    db.close();
  }

  const reclaimed = await post<{ ok: boolean; messages: Array<{ id: number; text: string }> }>(
    broker,
    "/claim-by-pid",
    {
      pid: receiver.pid,
      caller_pid: process.pid,
      drain_id: "mcp-ack-failure-reclaim",
    },
  );
  expect(reclaimed.ok).toBe(true);
  expect(reclaimed.messages).toEqual([
    expect.objectContaining({ id: sent.id, text: "survives failed acknowledgement" }),
  ]);
});
