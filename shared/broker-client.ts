import { chmodSync, closeSync, existsSync, lstatSync, openSync } from "node:fs";

export type BrokerFailureKind = "transport" | "timeout" | "malformed" | "http";

export class BrokerRequestError extends Error {
  constructor(
    readonly kind: BrokerFailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BrokerRequestError";
  }
}

export interface BrokerRequestOptions {
  baseUrl: string;
  path: string;
  body?: unknown;
  peerId?: string;
  token?: string;
  timeoutMs?: number;
}

export async function requestBroker<T>(options: BrokerRequestOptions): Promise<T> {
  const headers: Record<string, string> = {};
  let method = "GET";
  let body: string | undefined;
  if (options.body !== undefined) {
    method = "POST";
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  if (options.token) headers["X-Peer-Token"] = options.token;

  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}${options.path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
    });
  } catch (error) {
    const name = (error as { name?: string } | undefined)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new BrokerRequestError("timeout", `broker request timed out on ${options.path}`);
    }
    throw new BrokerRequestError("transport", `broker transport failed on ${options.path}`);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new BrokerRequestError("malformed", `broker returned malformed JSON on ${options.path}`, response.status);
  }
  if (!response.ok) {
    // Do not include the response body in errors. A compromised or confused
    // local service could reflect bearer credentials into its payload.
    throw new BrokerRequestError("http", `broker returned HTTP ${response.status} on ${options.path}`, response.status);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new BrokerRequestError("malformed", `broker returned a non-object response on ${options.path}`, response.status);
  }
  return parsed as T;
}

export async function brokerIsReady(baseUrl: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const health = await requestBroker<{ status?: string }>({ baseUrl, path: "/health", timeoutMs });
    return health.status === "ok";
  } catch {
    return false;
  }
}

export function openOwnerOnlyAppendLog(path: string): number {
  const uid = process.getuid?.() ?? -1;
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`broker log is not a regular file: ${path}`);
    if (uid >= 0 && stat.uid !== uid) throw new Error(`broker log is not owned by uid ${uid}: ${path}`);
    if ((stat.mode & 0o077) !== 0) chmodSync(path, 0o600);
  }
  const fd = openSync(path, "a", 0o600);
  chmodSync(path, 0o600);
  return fd;
}

export interface EnsureBrokerOptions {
  baseUrl: string;
  brokerScript: string;
  logPath: string;
  timeoutMs?: number;
  allowStart?: boolean;
  env?: Record<string, string | undefined>;
}

export async function ensureBrokerRunning(options: EnsureBrokerOptions): Promise<"already-running" | "started"> {
  const timeoutMs = options.timeoutMs ?? 6000;
  if (await brokerIsReady(options.baseUrl, Math.min(timeoutMs, 2000))) return "already-running";
  if (options.allowStart === false) throw new BrokerRequestError("transport", "broker is not running and auto-start is disabled");

  const logFd = openOwnerOnlyAppendLog(options.logPath);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["bun", options.brokerScript], {
      env: options.env ?? process.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: logFd,
    });
  } finally {
    closeSync(logFd);
  }
  proc.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await brokerIsReady(options.baseUrl, 500)) return "started";
    if (proc.exitCode !== null) {
      throw new BrokerRequestError("transport", `broker failed to start (exit ${proc.exitCode})`);
    }
    await Bun.sleep(100);
  }
  throw new BrokerRequestError("timeout", "broker did not become ready before the startup deadline");
}
