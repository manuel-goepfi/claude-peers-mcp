import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexUpstreamWebSocketUrl,
  observeCodexLifecycleRequest,
  retryableCodexPaneBindFailure,
  successfulCodexLifecycleThreadId,
  type PendingCodexLifecycle,
} from "../bin/codex-appserver-relay.ts";

const THREAD = "01a003f0-20ec-7ae2-aba4-6c526ab304e9";
const RELAY = new URL("../bin/codex-appserver-relay.ts", import.meta.url).pathname;
const WS_RUNTIME = new URL("../node_modules/ws/index.js", import.meta.url).pathname;

describe("Codex shared-app-server relay observation", () => {
  test("the production Node runtime forwards a Unix-domain WebSocket", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-peers-relay-ws-"));
    const upstreamSocket = join(root, "upstream.sock");
    const upstreamReady = join(root, "upstream.ready");
    const relaySocket = join(root, "relay.sock");
    const readyPath = join(root, "ready");
    const bindRequests: Array<Record<string, unknown>> = [];
    const broker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname !== "/bind-codex-pane-thread") {
          return new Response("not found", { status: 404 });
        }
        bindRequests.push(await request.json() as Record<string, unknown>);
        if (bindRequests.length === 1) {
          return Response.json({
            error: "pane does not contain exactly one interactive native Codex TUI",
          }, { status: 409 });
        }
        return Response.json({
          ok: true,
          id: "relay-peer",
          thread_id: THREAD,
          folded: 0,
          migrated: 0,
        });
      },
    });
    const upstreamScript = `
const { writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
const WebSocket = require(process.env.WS_RUNTIME);
const httpServer = createServer();
const socketServer = new WebSocket.WebSocketServer({ noServer: true });
httpServer.on("upgrade", (request, socket, head) => {
  socketServer.handleUpgrade(request, socket, head, (client) => {
    socketServer.emit("connection", client, request);
  });
});
socketServer.on("connection", (client) => {
  client.on("message", (data, binary) => {
    if (binary) return client.send(data, { binary });
    let request;
    try { request = JSON.parse(String(data)); } catch { return client.send(data); }
    if (request.method !== "thread/start") return client.send(data);
    const response = JSON.stringify({ id: request.id, result: { thread: { id: process.env.THREAD_ID } } });
    client.send(response);
    client.send(response);
  });
});
httpServer.listen(process.env.UPSTREAM_SOCKET, () => writeFileSync(process.env.UPSTREAM_READY, "ready"));
const stop = () => {
  for (const client of socketServer.clients) client.terminate();
  socketServer.close();
  httpServer.closeAllConnections();
  httpServer.close(() => process.exit(0));
};
process.on("SIGTERM", stop);
`;
    const upstream = Bun.spawn(["node", "-e", upstreamScript], {
      env: {
        ...process.env,
        WS_RUNTIME,
        UPSTREAM_SOCKET: upstreamSocket,
        UPSTREAM_READY: upstreamReady,
        THREAD_ID: THREAD,
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    const upstreamStderr = new Response(upstream.stderr as ReadableStream<Uint8Array>).text();
    let relay: ReturnType<typeof Bun.spawn> | null = null;
    let relayStderr: Promise<string> | null = null;
    try {
      const upstreamDeadline = Date.now() + 5_000;
      while (Date.now() < upstreamDeadline && !existsSync(upstreamReady)) await Bun.sleep(25);
      expect(existsSync(upstreamReady)).toBe(true);
      expect(codexUpstreamWebSocketUrl(upstreamSocket)).toBe(`ws+unix://${upstreamSocket}:/`);
      relay = Bun.spawn([
        "node", "--experimental-strip-types", RELAY,
        "--pane", "%4242",
        "--socket", relaySocket,
        "--upstream", upstreamSocket,
        "--ready", readyPath,
        "--broker-port", String(broker.port),
      ], { stdout: "ignore", stderr: "pipe" });
      relayStderr = new Response(relay.stderr as ReadableStream<Uint8Array>).text();
      const readyDeadline = Date.now() + 5_000;
      while (Date.now() < readyDeadline && (!existsSync(readyPath) || !existsSync(relaySocket))) {
        await Bun.sleep(25);
      }
      expect(existsSync(readyPath)).toBe(true);
      expect(existsSync(relaySocket)).toBe(true);
      expect(statSync(readyPath).mode & 0o777).toBe(0o600);
      expect(statSync(relaySocket).mode & 0o777).toBe(0o600);

      const clientScript = `
const WebSocket = require(process.env.WS_RUNTIME);
const client = new WebSocket(process.env.RELAY_URL);
const timer = setTimeout(() => process.exit(3), 4000);
client.on("open", () => client.send(JSON.stringify({ method: "thread/start", id: 7, params: { cwd: "/repo" } })));
client.on("message", (data) => {
  clearTimeout(timer);
  process.stdout.write(String(data));
  client.terminate();
  process.exit(0);
});
client.on("error", (error) => {
  clearTimeout(timer);
  process.stderr.write(error.message);
  process.exit(2);
});
`;
      const client = Bun.spawnSync(["node", "-e", clientScript], {
        env: {
          ...process.env,
          WS_RUNTIME,
          RELAY_URL: codexUpstreamWebSocketUrl(relaySocket),
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 6_000,
      });
      if (client.exitCode !== 0) {
        const clientError = new TextDecoder().decode(client.stderr);
        relay.kill("SIGTERM");
        await relay.exited;
        relay = null;
        throw new Error(`relay client exit=${client.exitCode}: ${clientError}; relay=${await relayStderr}`);
      }
      expect(JSON.parse(new TextDecoder().decode(client.stdout))).toEqual({
        id: 7,
        result: { thread: { id: THREAD } },
      });
      const bindDeadline = Date.now() + 5_000;
      while (Date.now() < bindDeadline && bindRequests.length < 2) await Bun.sleep(25);
      expect(bindRequests).toHaveLength(2);
      expect(bindRequests[0]).toEqual({
        caller_pid: relay.pid,
        tmux_pane_id: "%4242",
        thread_id: THREAD,
      });
      expect(bindRequests[1]).toEqual(bindRequests[0]);
    } finally {
      if (relay) {
        relay.kill("SIGTERM");
        await relay.exited;
      }
      upstream.kill("SIGTERM");
      await upstream.exited;
      await broker.stop(true);
      expect(await upstreamStderr).toBe("");
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("binds only a successful top-level thread/start response", () => {
    const pending = new Map<string, PendingCodexLifecycle>();
    const request = JSON.stringify({ method: "thread/start", id: 7, params: { cwd: "/repo" } });
    observeCodexLifecycleRequest(request, pending);
    expect(successfulCodexLifecycleThreadId(JSON.stringify({
      id: 7,
      result: { thread: { id: THREAD } },
    }), pending)).toBe(THREAD);
    expect(pending.size).toBe(0);
  });

  test("binds an exact resume picker result", () => {
    const pending = new Map<string, PendingCodexLifecycle>();
    observeCodexLifecycleRequest(JSON.stringify({
      method: "thread/resume",
      id: "resume-picker",
      params: { threadId: THREAD },
    }), pending);
    expect(successfulCodexLifecycleThreadId(JSON.stringify({
      id: "resume-picker",
      result: { thread: { id: THREAD, turns: [] } },
    }), pending)).toBe(THREAD);
  });

  test("ignores forks, detached reviews, notifications, errors, and malformed payloads", () => {
    const pending = new Map<string, PendingCodexLifecycle>();
    for (const request of [
      { method: "thread/fork", id: 1, params: { threadId: THREAD } },
      { method: "review/start", id: 2, params: { threadId: THREAD } },
      { method: "turn/start", id: 3, params: { threadId: THREAD } },
    ]) observeCodexLifecycleRequest(JSON.stringify(request), pending);
    expect(pending.size).toBe(0);
    expect(successfulCodexLifecycleThreadId(JSON.stringify({
      method: "thread/started",
      params: { thread: { id: THREAD } },
    }), pending)).toBeNull();

    observeCodexLifecycleRequest(JSON.stringify({ method: "thread/start", id: 4, params: {} }), pending);
    expect(successfulCodexLifecycleThreadId(JSON.stringify({
      id: 4,
      error: { code: -32600, message: "failed" },
    }), pending)).toBeNull();
    expect(pending.size).toBe(0);
    observeCodexLifecycleRequest("not json", pending);
    expect(successfulCodexLifecycleThreadId("not json", pending)).toBeNull();
  });

  test("does not consume an unrelated response id", () => {
    const pending = new Map<string, PendingCodexLifecycle>();
    observeCodexLifecycleRequest(JSON.stringify({ method: "thread/start", id: 9, params: {} }), pending);
    expect(successfulCodexLifecycleThreadId(JSON.stringify({
      id: 10,
      result: { thread: { id: THREAD } },
    }), pending)).toBeNull();
    expect(pending.size).toBe(1);
  });

  test("retries only the transient native-TUI discovery 409", () => {
    expect(retryableCodexPaneBindFailure(
      409,
      '{"error":"pane does not contain exactly one interactive native Codex TUI"}',
    )).toBe(true);
    expect(retryableCodexPaneBindFailure(
      409,
      '{"error":"thread is already bound to another live pane"}',
    )).toBe(false);
    expect(retryableCodexPaneBindFailure(403, '{"error":"caller rejected"}')).toBe(false);
    expect(retryableCodexPaneBindFailure(404, '{"error":"tmux pane not found"}')).toBe(true);
  });
});
