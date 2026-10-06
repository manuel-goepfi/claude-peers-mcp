/**
 * Fake shared Codex app-server speaking the v2 JSON-RPC subset that
 * bin/codex-thread-stop uses. Error strings and state transitions mirror a
 * private codex 0.160.1 app-server probed on 2026-10-06 (temp CODEX_HOME):
 *   - thread/read of an unknown thread  -> error "thread not loaded: <id>"
 *   - thread/archive of a loaded thread -> {} and the thread unloads (notLoaded)
 *   - thread/archive again              -> error "no rollout found for thread id <id>"
 *   - turn/interrupt with no live turn  -> error "no active turn to interrupt"
 * Every request is recorded with its threadId so tests can prove which
 * threads were touched.
 *
 * Runs in-process (FakeCodexAppServer.handle) or, under
 * `node --experimental-strip-types`, as a real ws+unix server:
 *   node --experimental-strip-types fake-codex-app-server.ts SOCKET STATE_JSON CALLS_JSON
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface FakeThread {
  status: "idle" | "active" | "notLoaded";
  archived?: boolean;
  turns?: Array<{ id: string; status: "inProgress" | "completed" | "interrupted" }>;
  /** Reads that still report "active" after an interrupt (settle latency). */
  settleReads?: number;
}

export interface FakeCall {
  method: string;
  threadId: string | null;
  params: unknown;
}

export class FakeCodexAppServer {
  readonly threads: Map<string, FakeThread>;
  readonly calls: FakeCall[] = [];
  initialized = false;

  constructor(threads: Record<string, FakeThread>) {
    this.threads = new Map(Object.entries(threads));
  }

  callsFor(threadId: string): string[] {
    return this.calls.filter((call) => call.threadId === threadId).map((call) => call.method);
  }

  mutatingCalls(): FakeCall[] {
    return this.calls.filter((call) => call.method === "turn/interrupt" || call.method === "thread/archive"
      || call.method === "turn/start" || call.method === "thread/unsubscribe");
  }

  loadedIds(): string[] {
    return [...this.threads].filter(([, thread]) => thread.status !== "notLoaded" && !thread.archived).map(([id]) => id);
  }

  /** One JSON text frame in, zero or more JSON text frames out. */
  handle(text: string): string[] {
    const message = JSON.parse(text) as { id?: string | number; method?: string; params?: Record<string, unknown> };
    const threadId = typeof message.params?.threadId === "string" ? message.params.threadId : null;
    if (message.method) this.calls.push({ method: message.method, threadId, params: message.params ?? null });
    if (message.id === undefined) {
      if (message.method === "initialized") this.initialized = true;
      return [];
    }
    const reply = (result: unknown) => [JSON.stringify({ id: message.id, result })];
    const fail = (text: string) => [JSON.stringify({ id: message.id, error: { code: -32600, message: text } })];
    const thread = threadId ? this.threads.get(threadId) : undefined;
    switch (message.method) {
      case "initialize":
        return reply({ userAgent: "fake/0.160.1", platformFamily: "unix", platformOs: "linux" });
      case "thread/loaded/list":
        return reply({ data: this.loadedIds(), nextCursor: null });
      case "thread/read": {
        // An archived thread still reads (status notLoaded), as on the real server.
        if (!thread) return fail(`thread not loaded: ${threadId}`);
        let status: FakeThread["status"] = thread.status;
        if (status === "active" && thread.turns?.every((turn) => turn.status !== "inProgress")) {
          if ((thread.settleReads ?? 0) > 0) thread.settleReads! -= 1;
          else { thread.status = "idle"; status = "idle"; }
        }
        return reply({ thread: { id: threadId, status: status === "active" ? { type: "active", activeFlags: [] } : { type: status } } });
      }
      case "thread/turns/list": {
        if (!thread) return fail(`thread not loaded: ${threadId}`);
        if (!thread.turns || thread.turns.length === 0) {
          return fail(`thread ${threadId} is not materialized yet; thread/turns/list is unavailable before first user message`);
        }
        return reply({ data: [...thread.turns].reverse(), nextCursor: null, backwardsCursor: null });
      }
      case "turn/interrupt": {
        const turn = thread?.turns?.find((candidate) => candidate.id === message.params?.turnId && candidate.status === "inProgress");
        if (!thread || !turn) return fail("no active turn to interrupt");
        turn.status = "interrupted";
        return reply({});
      }
      case "thread/archive": {
        if (!thread || thread.archived) return fail(`no rollout found for thread id ${threadId}`);
        thread.archived = true;
        thread.status = "notLoaded";
        for (const turn of thread.turns ?? []) if (turn.status === "inProgress") turn.status = "interrupted";
        return reply({});
      }
      case "turn/start":
        if (!thread || thread.archived || thread.status === "notLoaded") return fail(`thread not found: ${threadId}`);
        thread.status = "active";
        (thread.turns ??= []).push({ id: `turn-${thread.turns.length + 1}`, status: "inProgress" });
        return reply({ turn: { id: thread.turns.at(-1)!.id } });
      default:
        return fail(`unsupported method in fake: ${message.method}`);
    }
  }
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  const [socketPath, stateJson, callsPath] = process.argv.slice(2);
  if (!socketPath || !stateJson || !callsPath) process.exit(64);
  const require = createRequire(import.meta.url);
  const WebSocket = require("../../node_modules/ws/index.js");
  const { createServer } = require("node:http");
  const fake = new FakeCodexAppServer(JSON.parse(stateJson));
  const httpServer = createServer();
  const socketServer = new WebSocket.WebSocketServer({ noServer: true, perMessageDeflate: false });
  httpServer.on("upgrade", (request: unknown, socket: unknown, head: unknown) => {
    socketServer.handleUpgrade(request, socket, head, (client: unknown) => socketServer.emit("connection", client, request));
  });
  socketServer.on("connection", (client: { on: (event: string, listener: (data: unknown) => void) => void; send: (text: string) => void }) => {
    client.on("message", (data) => {
      for (const frame of fake.handle(String(data))) client.send(frame);
      writeFileSync(callsPath, JSON.stringify({ calls: fake.calls, loaded: fake.loadedIds() }));
    });
  });
  httpServer.listen(socketPath, () => console.log("ready"));
  process.on("SIGTERM", () => {
    for (const client of socketServer.clients) client.terminate();
    httpServer.close(() => process.exit(0));
  });
}
