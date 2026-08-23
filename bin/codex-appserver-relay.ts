#!/usr/bin/env bun

import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type WebSocketType from "ws";
import type { RawData, WebSocketServer as WebSocketServerType } from "ws";
import type { BindCodexPaneThreadResponse } from "../shared/types.ts";

// Bun aliases the package name `ws` to its compatibility class, which does not
// implement the package's ws+unix transport. Load the installed package entry
// explicitly so the relay uses the upstream library implementation we pin.
const wsRuntime = createRequire(import.meta.url)("../node_modules/ws/index.js") as typeof WebSocketType & {
  WebSocketServer: typeof WebSocketServerType;
};
const WebSocket = wsRuntime;
const WebSocketServer = wsRuntime.WebSocketServer;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type JsonRpcId = string | number;

export interface PendingCodexLifecycle {
  method: "thread/start" | "thread/resume";
}

function requestKey(id: unknown): string | null {
  if (typeof id !== "string" && typeof id !== "number") return null;
  return `${typeof id}:${String(id)}`;
}

function parsedObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Record only top-level TUI lifecycle requests that make a pane own a task. */
export function observeCodexLifecycleRequest(
  text: string,
  pending: Map<string, PendingCodexLifecycle>,
): void {
  const message = parsedObject(text);
  if (!message) return;
  if (message.method !== "thread/start" && message.method !== "thread/resume") return;
  const key = requestKey(message.id);
  if (!key) return;
  pending.set(key, { method: message.method });
}

/**
 * Resolve the exact thread returned for a request observed above. Errors,
 * notifications, detached reviews, subagents, and thread/fork are deliberately
 * ignored so a background thread can never replace the pane's root identity.
 */
export function successfulCodexLifecycleThreadId(
  text: string,
  pending: Map<string, PendingCodexLifecycle>,
): string | null {
  const message = parsedObject(text);
  if (!message) return null;
  const key = requestKey(message.id);
  if (!key || !pending.has(key)) return null;
  pending.delete(key);
  if (message.error !== undefined) return null;
  const result = message.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const thread = (result as Record<string, unknown>).thread;
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) return null;
  const id = (thread as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

interface RelayOptions {
  paneId: string;
  socketPath: string;
  upstreamSocketPath: string;
  readyPath: string;
  brokerPort: number;
}

function parseOptions(args: string[]): RelayOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("usage: codex-appserver-relay --pane %N --socket PATH --upstream PATH --ready PATH --broker-port N");
    }
    values.set(key, value);
  }
  const paneId = values.get("--pane") ?? "";
  const socketPath = values.get("--socket") ?? "";
  const upstreamSocketPath = values.get("--upstream") ?? "";
  const readyPath = values.get("--ready") ?? "";
  const brokerPort = Number(values.get("--broker-port"));
  if (!/^%\d+$/.test(paneId)) throw new Error("invalid --pane");
  if (!socketPath.startsWith("/") || !upstreamSocketPath.startsWith("/") || !readyPath.startsWith("/")) {
    throw new Error("relay paths must be absolute");
  }
  if (!Number.isInteger(brokerPort) || brokerPort < 1 || brokerPort > 65535) {
    throw new Error("invalid --broker-port");
  }
  return { paneId, socketPath, upstreamSocketPath, readyPath, brokerPort };
}

function textMessage(data: RawData, binary: boolean): string | null {
  if (binary) return null;
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
}

export function codexUpstreamWebSocketUrl(socketPath: string): string {
  return `ws+unix://${socketPath}:/`;
}

export function openCodexUpstreamWebSocket(socketPath: string): WebSocketType {
  return new WebSocket(codexUpstreamWebSocketUrl(socketPath), {
    perMessageDeflate: false,
  });
}

async function bindPaneThread(options: RelayOptions, threadId: string): Promise<boolean> {
  const suffix = threadId.slice(-8);
  let lastError = "unknown broker error";
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${options.brokerPort}/bind-codex-pane-thread`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caller_pid: process.pid,
          tmux_pane_id: options.paneId,
          thread_id: threadId,
        }),
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) {
        const result = await response.json() as BindCodexPaneThreadResponse;
        console.error(`[codex-relay] bound pane=${options.paneId} thread=t${suffix} peer=${result.id} folded=${result.folded}`);
        return true;
      }
      const responseText = (await response.text()).slice(0, 240);
      lastError = `${response.status} ${responseText}`;
      if (!retryableCodexPaneBindFailure(response.status, responseText)) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  }
  console.error(`[codex-relay] bind failed pane=${options.paneId} thread=t${suffix}: ${lastError}`);
  return false;
}

export function retryableCodexPaneBindFailure(status: number, responseText: string): boolean {
  if (status === 400 || status === 403) return false;
  if (status !== 409) return true;
  // A resume response can race the native TUI process-table snapshot by a few
  // milliseconds. Retry only that local discovery state. A live-thread owner
  // conflict is authoritative and must stay fail-closed.
  return responseText.includes("pane does not contain exactly one interactive native Codex TUI");
}

function closeWebSocket(socket: WebSocketType, code: number, reason: Buffer): void {
  if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) return;
  if (code === 1000 || (code >= 3000 && code <= 4999)) socket.close(code, reason.toString("utf8"));
  else socket.terminate();
}

export async function runCodexAppserverRelay(options: RelayOptions): Promise<void> {
  const boundThreads = new Set<string>();
  const bindsInFlight = new Set<string>();
  const httpServer = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const socketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  httpServer.on("upgrade", (request, socket, head) => {
    socketServer.handleUpgrade(request, socket, head, (client) => {
      socketServer.emit("connection", client, request);
    });
  });

  socketServer.on("connection", (client) => {
    const pending = new Map<string, PendingCodexLifecycle>();
    const queued: Array<{ data: RawData; binary: boolean }> = [];
    const upstream = openCodexUpstreamWebSocket(options.upstreamSocketPath);

    upstream.on("open", () => {
      for (const item of queued.splice(0)) upstream.send(item.data, { binary: item.binary });
    });
    client.on("message", (data, binary) => {
      const text = textMessage(data, binary);
      if (text !== null) observeCodexLifecycleRequest(text, pending);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      else if (upstream.readyState === WebSocket.CONNECTING) queued.push({ data, binary });
    });
    upstream.on("message", (data, binary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
      const text = textMessage(data, binary);
      const threadId = text === null ? null : successfulCodexLifecycleThreadId(text, pending);
      if (!threadId || boundThreads.has(threadId) || bindsInFlight.has(threadId)) return;
      bindsInFlight.add(threadId);
      void bindPaneThread(options, threadId).then((bound) => {
        if (bound) boundThreads.add(threadId);
      }).finally(() => {
        bindsInFlight.delete(threadId);
      });
    });
    client.on("close", (code, reason) => {
      closeWebSocket(upstream, code, reason);
    });
    upstream.on("close", (code, reason) => {
      closeWebSocket(client, code, reason);
    });
    client.on("error", () => upstream.terminate());
    upstream.on("error", (error) => {
      console.error(`[codex-relay] upstream connection failed: ${error.message}`);
      client.terminate();
    });
  });

  const cleanup = () => {
    for (const client of socketServer.clients) client.terminate();
    socketServer.close();
    httpServer.close();
    try { unlinkSync(options.socketPath); } catch {}
    try { unlinkSync(options.readyPath); } catch {}
  };
  const shutdown = () => {
    cleanup();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("exit", cleanup);

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.socketPath, () => resolve());
  });
  chmodSync(options.socketPath, 0o600);
  writeFileSync(options.readyPath, `${process.pid}\n`, { mode: 0o600 });
  console.error(`[codex-relay] ready pane=${options.paneId}`);
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  try {
    await runCodexAppserverRelay(parseOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(`[codex-relay] fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
