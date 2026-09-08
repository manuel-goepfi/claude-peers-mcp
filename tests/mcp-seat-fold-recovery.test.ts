import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestBroker } from "./helpers/test-broker.ts";

const SERVER_SCRIPT = new URL("../server.ts", import.meta.url).pathname;
const APP_SERVER_FIXTURE = new URL("./fixtures/codex-app-server-parent.ts", import.meta.url).pathname;
const APP_SERVER_FIXTURE_DIR = new URL("./fixtures/", import.meta.url).pathname;

function appServerFixtureCommand(targetScript: string): string {
  return `cd ${JSON.stringify(APP_SERVER_FIXTURE_DIR)} && exec -a codex bun app-server ${JSON.stringify(targetScript)}`;
}



test("already-connected MCP survives exact-thread folding and exchanges messages", async () => {
  const broker = await startTestBroker({ prefix: "desktop-thread-proof" });
  const cwd = mkdtempSync(join(tmpdir(), "claude-peers-desktop-proof-"));
  const thread = crypto.randomUUID();
  const app = Bun.spawn(["bash", "-c", appServerFixtureCommand(SERVER_SCRIPT)], {
    cwd, env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined,
      CLAUDE_PEER_NAME: undefined, MCP_PROBE_THREAD_ID: undefined,
      CLAUDE_PEERS_HEARTBEAT_MS: "100", CLAUDE_PEERS_HEARTBEAT_PHASE_SPREAD: "0",
      CLAUDE_PEERS_PORT: String(broker.port), CLAUDE_PEERS_DB: broker.dbPath,
      CLAUDE_PEERS_BRIDGE_TOKEN_FILE: broker.tokenPath, CLAUDE_PEERS_TMUX_IDENTITY_MIRROR: "0",
      CLAUDE_PEERS_TEST_APP_SERVER_MODULE: APP_SERVER_FIXTURE,
      CLAUDE_PEERS_TEST_APP_SERVER_CHILD_CWD: cwd },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const stderr = new Response(app.stderr).text();
  const reader = app.stdout.getReader();
  let buffered = "";
  const responseFor = async (id: number): Promise<any> => {
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id === id) return message;
      } else {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Desktop fixture closed before tool response");
        buffered += new TextDecoder().decode(chunk.value);
      }
    }
  };
  const frame = (value: object) => app.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  const request = async (path: string, body: object, token?: string) => {
    const result = await fetch(broker.url + path, { method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { "X-Peer-Token": token } : {}) },
      body: JSON.stringify(body) });
    if (!result.ok) throw new Error(`fixture ${path}: ${result.status} ${await result.text()}`);
    return await result.json() as any;
  };
  try {
    const base = { cwd, git_root: null, tty: null, tmux_session: null,
      tmux_window_index: null, tmux_window_name: null, tmux_pane_id: null, summary: "" };
    const receiver = await request("/register", { ...base, pid: app.pid, name: "desktop-proof",
      client_type: "codex", receiver_mode: "codex-hook", thread_id: thread });
    await request("/hook-heartbeat-by-thread", { thread_id: thread, caller_pid: process.pid,
      client_type: "codex", receiver_mode: "codex-hook" });
    frame({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05",
      capabilities: {}, clientInfo: { name: "desktop-proof", version: "1" } } });
    await responseFor(1);
    frame({ method: "notifications/initialized" });
    frame({ id: 2, method: "tools/call", params: { name: "whoami", arguments: {}, _meta: { threadId: thread } } });
    const self = await responseFor(2);
    expect(self.result.isError).not.toBe(true);
    expect(JSON.stringify(self.result)).toContain(receiver.id);
    const sender = await request("/register", { ...base, pid: process.pid, name: "sender-proof", client_type: "claude" });
    const pane = await request("/register", { ...base, pid: app.pid, name: "fold-destination",
      client_type: "codex", receiver_mode: "codex-hook", tmux_session: "fixture",
      tmux_pane_id: "%998" });
    expect(pane.id).not.toBe(receiver.id);
    await request("/reconcile-pane-thread", { id: pane.id, pid: app.pid, caller_pid: process.pid,
      tmux_pane_id: "%998", thread_id: thread }, pane.token);
    // Let the existing connection's heartbeat encounter its removed identity.
    // Do not reconnect: that would hide the transport-closed regression.
    await Bun.sleep(700);
    frame({ id: 6, method: "tools/call", params: { name: "send_message",
      arguments: { to_id: sender.id, message: "outgoing after fold", request_id: "fold-reply" },
      _meta: { threadId: thread } } });
    const outgoing = await responseFor(6);
    expect(outgoing.result.isError).not.toBe(true);
    expect(JSON.stringify(outgoing.result)).toContain("queued");
    const reply = await request("/poll-messages", { id: sender.id, drain_id: "fold-test" }, sender.token);
    expect(reply.messages.map((m: { text: string }) => m.text)).toContain("outgoing after fold");
    const ack = await request("/ack-messages", { id: sender.id,
      ids: reply.messages.map((m: { id: number }) => m.id) }, sender.token);
    expect(ack.acked).toBe(1);
    const marker = `desktop-receipt-${crypto.randomUUID()}`;
    await request("/send-message", { from_id: sender.id, to_id: pane.id, text: marker }, sender.token);
    frame({ id: 3, method: "tools/call", params: { name: "check_messages", arguments: {}, _meta: { threadId: thread } } });
    expect(JSON.stringify((await responseFor(3)).result)).toContain(marker);
    frame({ id: 4, method: "tools/call", params: { name: "check_messages", arguments: {}, _meta: { threadId: thread } } });
    expect(JSON.stringify((await responseFor(4)).result)).not.toContain(marker);
    frame({ id: 5, method: "tools/call", params: { name: "whoami", arguments: {}, _meta: { threadId: crypto.randomUUID() } } });
    expect((await responseFor(5)).result.isError).toBe(true);
    const db = new Database(broker.dbPath, { readonly: true });
    try {
      expect(db.query("SELECT id, tmux_pane_id, seat_key FROM peers WHERE thread_id = ?").all(thread))
        .toEqual([{ id: pane.id, tmux_pane_id: "%998", seat_key: "pane:fixture:%998" }]);
      expect(db.query("SELECT delivered FROM messages WHERE to_id = ? AND text = ?").get(pane.id, marker))
        .toEqual({ delivered: 1 });
    } finally { db.close(); }
  } finally {
    app.stdin.end();
    const timer = setTimeout(() => app.kill(), 3000);
    await app.exited; clearTimeout(timer);
    reader.releaseLock(); await stderr;
    await broker.stop(); rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);
