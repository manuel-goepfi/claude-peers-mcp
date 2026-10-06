#!/usr/bin/env bun
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { startTestBroker } from "../tests/helpers/test-broker.ts";
import { summarizeLatency } from "../shared/runtime-metrics.ts";

/** Current explicit MCP receive path, on a private broker and database.
 * Unknown fixture clients intentionally make no claim about native hook proof.
 */
export async function runDeliveryFleet(count: number, rounds = 3) {
  if (!Number.isInteger(count) || count < 2 || count > 50) throw new Error("peers must be 2..50");
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error("rounds must be 1..10");
  const startedAt = new Date().toISOString();
  const broker = await startTestBroker({ prefix: "delivery-fleet" });
  const db = new Database(broker.dbPath, { readonly: true });
  const clients: Client[] = [];
  const rendered = Array.from({ length: count }, () => "");
  const healthMs: number[] = [];
  const exchangeMs: number[] = [];
  async function health() {
    const start = performance.now();
    const response = await fetch(broker.url + "/health", { signal: AbortSignal.timeout(3000) });
    if (!response.ok || !(await response.json() as { ready: boolean }).ready) throw new Error("broker not ready");
    healthMs.push(performance.now() - start);
  }
  async function call(index: number, name: string, args: Record<string, unknown>) {
    // send_message includes a 2s receipt probe plus several individually bounded
    // broker requests. Its whole-tool budget must accommodate that contract.
    const result = await clients[index]!.callTool({ name, arguments: args }, undefined, { timeout: 15000 })
      .catch(error => { throw new Error(`adapter ${index} ${name}: ${error instanceof Error ? error.message : String(error)}`); });
    if (result.isError) throw new Error(`adapter ${index}: ${name} refused`);
    const content = JSON.stringify(result.content);
    rendered[index] += content;
    return content;
  }
  try {
    // Bound startup fan-out without changing the requested connected fleet size.
    for (let base = 0; base < count; base += 5) {
      const results = await Promise.allSettled(Array.from({ length: Math.min(5, count - base) }, async (_, offset) => {
        const index = base + offset;
        const client = new Client({ name: `delivery-fleet-${index}`, version: "1" });
        clients[index] = client;
        const transport = new StdioClientTransport({ command: process.execPath,
          args: [new URL("../server.ts", import.meta.url).pathname],
          cwd: new URL("..", import.meta.url).pathname,
          env: { HOME: broker.root, PATH: process.env.PATH ?? "", CLAUDE_PEERS_PORT: String(broker.port),
            CLAUDE_PEERS_DB: broker.dbPath, CLAUDE_PEERS_BRIDGE_TOKEN_FILE: broker.tokenPath,
            CLAUDE_PEERS_BROKER_LOG: broker.logPath, CLAUDE_PEERS_CLIENT_TYPE: "unknown",
            CLAUDE_PEER_NAME: `delivery-fleet-${index}`, CLAUDE_PEERS_TMUX_IDENTITY_MIRROR: "0" },
          stderr: "pipe" });
        // Drain stderr without retaining private runtime data.
        transport.stderr?.on("data", () => {});
        await client.connect(transport, { timeout: 5000 })
          .catch(error => { throw new Error(`adapter ${index} startup: ${error instanceof Error ? error.message : String(error)}`); });
      }));
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
    const peers = Array.from({ length: count }, (_, index) => {
      const rows = db.query("SELECT id FROM peers WHERE name = ?").all(`delivery-fleet-${index}`) as { id: string }[];
      if (rows.length !== 1) throw new Error(`adapter ${index}: expected one registration`);
      return rows[0]!.id;
    });
    for (let round = 0; round < rounds; round++) {
      rendered.fill("");
      const starts = Array.from({ length: count }, () => performance.now());
      await Promise.all([health(), ...peers.map((_, index) => call(index, "send_message", {
        to_id: peers[(index + 1) % count], message: `fixture-request-${round}-${index}:end`,
        request_id: `delivery-${round}-${index}`,
      }))]);
      await Promise.all(peers.map(async (_, index) => {
        const sender = (index + count - 1) % count;
        await call(index, "check_messages", {});
        if (!rendered[index]!.includes(`fixture-request-${round}-${sender}:end`)) throw new Error("request not rendered");
      }));
      await Promise.all(peers.map((_, index) => {
        const sender = (index + count - 1) % count;
        return call(index, "send_message", { to_id: peers[sender], message: `fixture-reply-${round}-${sender}:end`,
          request_id: `reply-${round}-${sender}`, reply_to_id: `delivery-${round}-${sender}` });
      }));
      await Promise.all([health(), ...peers.map(async (_, index) => {
        await call(index, "check_messages", {});
        if (!rendered[index]!.includes(`fixture-reply-${round}-${index}:end`)) throw new Error("reply not rendered");
        exchangeMs.push(performance.now() - starts[index]!);
      })]);
    }
    const totals = db.query(`SELECT count(*) AS total,
      sum(delivered_at IS NOT NULL) AS acknowledged,
      sum(reply_to_id IS NOT NULL) AS replies FROM messages`).get() as { total: number; acknowledged: number; replies: number };
    if (totals.total !== count * rounds * 2 || totals.acknowledged !== totals.total || totals.replies !== count * rounds)
      throw new Error("message count, acknowledgement or correlation mismatch");
    return { mode: "explicit-mcp-delivery", started_at: startedAt, finished_at: new Date().toISOString(),
      peers: count, rounds, ...totals, health_ms: summarizeLatency(healthMs), exchange_ms: summarizeLatency(exchangeMs),
      native_hooks_verified: false };
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    db.close();
    await broker.stop();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1]! : fallback;
  try {
    const result = await runDeliveryFleet(Number(value("--peers", "50")), Number(value("--rounds", "3")));
    const output = value("--output", "");
    if (output) {
      const path = resolve(output);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
