import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const brokerScript = new URL("../../broker.ts", import.meta.url).pathname;

export interface TestBrokerOptions {
  cleanupOnStop?: boolean;
  dbPath?: string;
  env?: Record<string, string | undefined>;
  prefix?: string;
  prepare?: (paths: { root: string; dbPath: string; tokenPath: string; logPath: string }) => void;
  root?: string;
  startupTimeoutMs?: number;
  tokenPath?: string;
}

export interface TestBroker {
  root: string;
  dbPath: string;
  tokenPath: string;
  logPath: string;
  port: number;
  url: string;
  proc: ReturnType<typeof Bun.spawn>;
  stderr(): string;
  stop(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readReadyLine(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("broker stdout closed before readiness");
      buffered += decoder.decode(value, { stream: true });
      const newline = buffered.indexOf("\n");
      if (newline < 0) continue;

      const line = buffered.slice(0, newline);
      const ready = JSON.parse(line) as { event?: unknown; port?: unknown };
      if (ready.event !== "claude-peers-test-ready" || !Number.isInteger(ready.port)) {
        throw new Error(`invalid broker readiness line: ${line}`);
      }
      const port = ready.port as number;
      if (port < 1 || port > 65535) throw new Error(`invalid assigned broker port: ${port}`);
      return port;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function waitForBrokerHealth(url: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(50);
  }
  throw new Error(`broker health timeout (${lastError})`);
}

export async function startTestBroker(options: TestBrokerOptions = {}): Promise<TestBroker> {
  const prefix = (options.prefix ?? "broker").replace(/[^a-zA-Z0-9_-]/g, "-");
  const root = options.root ?? mkdtempSync(join(tmpdir(), `claude-peers-${prefix}-`));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dbPath = options.dbPath ?? join(root, "broker.db");
  const tokenPath = options.tokenPath ?? join(root, "bridge.token");
  const logPath = join(root, ".claude-peers-broker.log");
  const cleanupOnStop = options.cleanupOnStop ?? true;
  try {
    options.prepare?.({ root, dbPath, tokenPath, logPath });
  } catch (error) {
    if (cleanupOnStop) rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const proc = Bun.spawn(["bun", brokerScript], {
    cwd: dirname(brokerScript),
    env: {
      ...process.env,
      ...options.env,
      HOME: root,
      NODE_ENV: "test",
      CLAUDE_PEERS_TEST_PORT_ZERO: "1",
      CLAUDE_PEERS_PORT: "0",
      CLAUDE_PEERS_DB: dbPath,
      CLAUDE_PEERS_BRIDGE_TOKEN_FILE: tokenPath,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let stderrText = "";
  const stderrDone = (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrText += decoder.decode(value, { stream: true });
      }
      stderrText += decoder.decode();
      return stderrText;
    } finally {
      reader.releaseLock();
    }
  })();
  const timeoutMs = options.startupTimeoutMs ?? 8000;

  try {
    const outcome = await Promise.race([
      readReadyLine(proc.stdout).then((port) => ({ kind: "ready" as const, port })),
      proc.exited.then((code) => ({ kind: "exit" as const, code })),
      delay(timeoutMs).then(() => ({ kind: "timeout" as const })),
    ]);

    if (outcome.kind !== "ready") {
      if (outcome.kind === "timeout") proc.kill("SIGKILL");
      await proc.exited;
      const stderr = await stderrDone;
      throw new Error(
        outcome.kind === "exit"
          ? `broker exited before readiness (${outcome.code}): ${stderr}`
          : `broker readiness timed out after ${timeoutMs}ms: ${stderr}`,
      );
    }

    const url = `http://127.0.0.1:${outcome.port}`;
    await waitForBrokerHealth(url, timeoutMs);
    let stopped = false;
    return {
      root,
      dbPath,
      tokenPath,
      logPath,
      port: outcome.port,
      url,
      proc,
      stderr: () => stderrText,
      async stop() {
        if (stopped) return;
        stopped = true;
        proc.kill("SIGTERM");
        const exited = await Promise.race([
          proc.exited.then(() => true),
          delay(2000).then(() => false),
        ]);
        if (!exited) {
          proc.kill("SIGKILL");
          await proc.exited;
        }
        await stderrDone;
        if (cleanupOnStop) rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (proc.exitCode === null) proc.kill("SIGKILL");
    await proc.exited;
    await stderrDone;
    if (cleanupOnStop) rmSync(root, { recursive: true, force: true });
    const label = basename(root);
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
