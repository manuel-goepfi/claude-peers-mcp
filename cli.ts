#!/usr/bin/env bun
import { existsSync, realpathSync } from "node:fs";
import { BrokerRequestError, ensureBrokerRunning, requestBroker } from "./shared/broker-client.ts";
import {
  listenerPidsForLoopbackPort,
  processStartIdentity,
  verifyLifecycleIdentity,
  type BrokerLifecycleIdentity,
} from "./shared/broker-lifecycle.ts";
import { brokerServiceConfig, installedBrokerServiceIsCurrent } from "./shared/broker-service.ts";
import type { DeliveryState, Peer, RegisterCliResponse, SendMessageResponse } from "./shared/types.ts";

const EXIT = {
  usage: 2,
  transport: 3,
  timeout: 4,
  malformed: 5,
  compatibility: 6,
  auth: 7,
  rate: 8,
  target: 9,
  partial: 10,
  cleanup: 11,
  unsafe: 12,
} as const;

type ExitKind = keyof typeof EXIT;

class CliError extends Error {
  constructor(readonly kind: ExitKind, message: string) {
    super(message);
    this.name = "CliError";
  }
}

interface CliIdentity {
  id: string;
  token: string;
}

interface CliContext {
  baseUrl: string;
  timeoutMs: number;
  json: boolean;
  identity: CliIdentity;
  cleaned: boolean;
}

function configuredTimeout(): number {
  const parsed = Number(process.env.CLAUDE_PEERS_CLI_TIMEOUT_MS ?? "3000");
  return Number.isFinite(parsed) && parsed >= 100 ? Math.floor(parsed) : 3000;
}

function mapRequestError(error: unknown, operation: string): CliError {
  if (!(error instanceof BrokerRequestError)) {
    return new CliError("transport", `${operation} failed`);
  }
  if (error.kind === "timeout") return new CliError("timeout", `${operation} timed out`);
  if (error.kind === "malformed") return new CliError("malformed", `${operation} returned malformed data`);
  if (error.kind === "transport") return new CliError("transport", `${operation} could not reach the broker`);
  if (error.status === 401 || error.status === 403) return new CliError("auth", `${operation} was rejected by broker authentication`);
  if (error.status === 429) return new CliError("rate", `${operation} was rate limited`);
  return new CliError("transport", `${operation} failed with broker HTTP ${error.status ?? "error"}`);
}

function validateRegistration(value: RegisterCliResponse): CliIdentity {
  if (
    !value ||
    typeof value.id !== "string" || !value.id ||
    typeof value.token !== "string" || !value.token ||
    value.non_targetable !== true
  ) {
    throw new CliError("malformed", "CLI registration returned an invalid identity");
  }
  return { id: value.id, token: value.token };
}

async function registerCli(baseUrl: string, timeoutMs: number): Promise<CliIdentity> {
  try {
    const response = await requestBroker<RegisterCliResponse>({
      baseUrl,
      path: "/register-cli",
      body: { pid: process.pid },
      timeoutMs,
    });
    return validateRegistration(response);
  } catch (error) {
    if (error instanceof BrokerRequestError && error.kind === "http" && (error.status === 401 || error.status === 404)) {
      throw new CliError("compatibility", "broker does not support constrained CLI identities; upgrade the broker before using this CLI");
    }
    throw mapRequestError(error, "CLI registration");
  }
}

async function authedRequest<T>(context: CliContext, path: string, body: Record<string, unknown>): Promise<T> {
  try {
    return await requestBroker<T>({
      baseUrl: context.baseUrl,
      path,
      body: { ...body, id: context.identity.id },
      token: context.identity.token,
      timeoutMs: context.timeoutMs,
    });
  } catch (error) {
    throw mapRequestError(error, path.slice(1) || "broker request");
  }
}

async function unregisterCli(context: CliContext): Promise<void> {
  if (context.cleaned) return;
  try {
    await requestBroker<{ ok: boolean }>({
      baseUrl: context.baseUrl,
      path: "/unregister",
      body: { id: context.identity.id },
      token: context.identity.token,
      timeoutMs: Math.min(context.timeoutMs, 1000),
    });
    context.cleaned = true;
  } catch {
    throw new CliError("cleanup", "transient CLI identity cleanup failed");
  }
}

function validateLifecycleIdentity(value: BrokerLifecycleIdentity): BrokerLifecycleIdentity {
  if (
    !value ||
    !Number.isInteger(value.pid) || value.pid <= 1 ||
    typeof value.process_start !== "string" || !value.process_start ||
    typeof value.instance_nonce !== "string" || !value.instance_nonce ||
    typeof value.database_path !== "string" || !value.database_path ||
    typeof value.lock_path !== "string" || !value.lock_path ||
    (value.owner_mode !== "direct" && value.owner_mode !== "systemd") ||
    typeof value.executable_path !== "string" || !value.executable_path ||
    typeof value.broker_script_path !== "string" || !value.broker_script_path ||
    value.ready !== true ||
    value.capabilities?.procSocketIdentity !== true ||
    value.capabilities?.nonceProtectedOwnership !== true ||
    value.capabilities?.verifiedShutdown !== true ||
    value.capabilities?.storageSchema !== 1
  ) {
    throw new CliError("unsafe", "broker lifecycle identity is missing required verification fields");
  }
  return value;
}

function sameLifecycleIdentity(left: BrokerLifecycleIdentity, right: BrokerLifecycleIdentity): boolean {
  return left.pid === right.pid &&
    left.process_start === right.process_start &&
    left.instance_nonce === right.instance_nonce &&
    left.database_path === right.database_path &&
    left.lock_path === right.lock_path &&
    left.owner_mode === right.owner_mode &&
    left.executable_path === right.executable_path &&
    left.broker_script_path === right.broker_script_path;
}

async function systemctl(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["systemctl", "--user", ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  } catch {
    throw new CliError("unsafe", "managed broker identity requires an available systemctl --user");
  }
  const stdoutPromise = new Response(proc.stdout as ReadableStream<Uint8Array>).text();
  const outcome = await Promise.race([
    proc.exited.then((code) => ({ code })),
    Bun.sleep(timeoutMs).then(() => null),
  ]);
  if (!outcome) {
    proc.kill("SIGKILL");
    await proc.exited;
    throw new CliError("timeout", "systemctl --user timed out");
  }
  return { code: outcome.code, stdout: await stdoutPromise };
}

async function managedMainPid(timeoutMs: number): Promise<number> {
  const result = await systemctl(["show", "claude-peers-broker.service", "--property=MainPID", "--value"], timeoutMs);
  const pid = Number(result.stdout.trim());
  if (result.code !== 0 || !Number.isInteger(pid) || pid <= 1) {
    throw new CliError("unsafe", "managed broker MainPID is unavailable");
  }
  return pid;
}

async function waitForBrokerStop(identity: BrokerLifecycleIdentity, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listeners = listenerPidsForLoopbackPort(port);
    if (listeners.some((pid) => pid !== identity.pid)) {
      throw new CliError("unsafe", "broker listener was replaced during shutdown");
    }
    if (listeners.length === 0 && !existsSync(identity.lock_path)) return;
    await Bun.sleep(50);
  }
  throw new CliError("timeout", "broker did not stop before the shutdown deadline");
}

async function killBroker(context: CliContext, port: number): Promise<void> {
  const localBrokerScript = realpathSync(new URL("./broker.ts", import.meta.url).pathname);
  const first = validateLifecycleIdentity(await authedRequest<BrokerLifecycleIdentity>(context, "/lifecycle-identity", {}));
  try {
    verifyLifecycleIdentity(first, { port, brokerScriptPath: localBrokerScript });
  } catch {
    throw new CliError("unsafe", "listener, process, script, or ownership identity could not be verified");
  }

  const unitPath = `${process.env.HOME}/.config/systemd/user/claude-peers-broker.service`;
  let mainPid: number | null = null;
  if (first.owner_mode === "systemd") {
    if (!existsSync(unitPath)) throw new CliError("unsafe", "managed broker unit is missing");
    const serviceConfig = brokerServiceConfig();
    if (!installedBrokerServiceIsCurrent(serviceConfig)) {
      throw new CliError("unsafe", "managed broker unit or path drop-in is stale or unverifiable");
    }
    mainPid = await managedMainPid(context.timeoutMs);
    if (mainPid !== first.pid) throw new CliError("unsafe", "managed broker MainPID does not match the listener");
  }

  const second = validateLifecycleIdentity(await authedRequest<BrokerLifecycleIdentity>(context, "/lifecycle-identity", {}));
  if (!sameLifecycleIdentity(first, second)) throw new CliError("unsafe", "broker lifecycle identity changed during shutdown verification");
  try {
    verifyLifecycleIdentity(second, { port, brokerScriptPath: localBrokerScript });
  } catch {
    throw new CliError("unsafe", "broker listener identity changed during shutdown verification");
  }

  // Remove the transient caller while its token is still valid. From this point
  // onward, only immutable kernel/owner evidence is used before the signal.
  await unregisterCli(context);
  if (processStartIdentity(second.pid) !== second.process_start) {
    throw new CliError("unsafe", "broker PID was reused before shutdown");
  }
  const listeners = listenerPidsForLoopbackPort(port);
  if (listeners.length !== 1 || listeners[0] !== second.pid) {
    throw new CliError("unsafe", "broker listener was replaced before shutdown");
  }

  if (second.owner_mode === "systemd") {
    const revalidatedMainPid = await managedMainPid(context.timeoutMs);
    if (revalidatedMainPid !== mainPid || revalidatedMainPid !== second.pid) {
      throw new CliError("unsafe", "managed broker MainPID changed before shutdown");
    }
    const stopped = await systemctl(["stop", "claude-peers-broker.service"], context.timeoutMs);
    if (stopped.code !== 0) throw new CliError("unsafe", "systemd refused to stop the verified broker");
  } else {
    try {
      process.kill(second.pid, "SIGTERM");
    } catch {
      throw new CliError("unsafe", "verified broker disappeared before SIGTERM");
    }
  }
  await waitForBrokerStop(second, port, Math.max(context.timeoutMs, 3000));
}

function publicPeer(peer: Peer): Record<string, unknown> {
  return {
    id: peer.id,
    pid: peer.pid,
    cwd: peer.cwd,
    git_root: peer.git_root,
    name: peer.name,
    resolved_name: peer.resolved_name,
    client_type: peer.client_type ?? "unknown",
    receiver_mode: peer.receiver_mode ?? "unknown",
    summary: peer.summary,
    last_seen: peer.last_seen,
  };
}

function printPeers(peers: Peer[], json: boolean, command: "status" | "peers", health?: { status: string; peers: number }): void {
  if (json) {
    console.log(JSON.stringify({ ok: true, command, ...(health ? { broker: health } : {}), peers: peers.map(publicPeer) }));
    return;
  }
  if (health) console.log(`Broker: ${health.status} (${health.peers} targetable peer(s))`);
  if (peers.length === 0) {
    console.log("No peers registered.");
    return;
  }
  if (health) console.log("\nPeers:");
  for (const peer of peers) {
    const label = peer.name ?? peer.resolved_name ?? peer.id;
    console.log(`  ${label}  [${peer.id}]  PID:${peer.pid}  ${peer.cwd}`);
    if (peer.summary) console.log(`    ${peer.summary}`);
    console.log(`    ${peer.client_type ?? "unknown"}/${peer.receiver_mode ?? "unknown"}  last seen ${peer.last_seen}`);
  }
}

async function listPeers(context: CliContext): Promise<Peer[]> {
  const peers = await authedRequest<Peer[]>(context, "/list-peers", {
    scope: "machine",
    cwd: "/",
    git_root: null,
  });
  if (!Array.isArray(peers)) throw new CliError("malformed", "peer inventory was not an array");
  return peers;
}

async function runCommand(command: string, args: string[], context: CliContext, port: number): Promise<void> {
  if (command === "status") {
    let health: { status: string; peers: number };
    try {
      health = await requestBroker({ baseUrl: context.baseUrl, path: "/health", timeoutMs: context.timeoutMs });
    } catch (error) {
      throw mapRequestError(error, "broker status");
    }
    if (health.status !== "ok" || !Number.isInteger(health.peers)) {
      throw new CliError("malformed", "broker health response is invalid");
    }
    printPeers(await listPeers(context), context.json, "status", health);
    return;
  }

  if (command === "peers") {
    printPeers(await listPeers(context), context.json, "peers");
    return;
  }

  if (command === "send") {
    const [toId, ...messageParts] = args;
    const message = messageParts.join(" ").trim();
    if (!toId || !message) throw new CliError("usage", "usage: claude-peers send <peer-id> <message>");
    const result = await authedRequest<SendMessageResponse>(context, "/send-message", {
      from_id: context.identity.id,
      to_id: toId,
      text: message,
    });
    if (!result || result.ok !== true || typeof result.id !== "number") {
      if (result?.ok === false) throw new CliError("target", "broker refused the message target");
      throw new CliError("malformed", "send response is invalid");
    }
    const state: DeliveryState = result.state ?? "queued";
    if (state !== "queued") throw new CliError("malformed", `send returned unexpected state ${state}`);
    if (context.json) console.log(JSON.stringify({ ok: true, command: "send", target: toId, message_id: result.id, state }));
    else console.log(`Message queued to ${toId} (id ${result.id}).`);
    return;
  }

  if (command === "kill-broker") {
    await killBroker(context, port);
    if (context.json) console.log(JSON.stringify({ ok: true, command: "kill-broker", state: "stopped" }));
    else console.log("Broker stopped.");
    return;
  }

  throw new CliError("usage", "usage: claude-peers [--json] status|peers|send <peer-id> <message>|kill-broker");
}

function reportError(error: CliError, json: boolean): void {
  if (json) console.error(JSON.stringify({ ok: false, error: error.kind, message: error.message }));
  else console.error(`${error.kind}: ${error.message}`);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const json = argv.includes("--json");
  const args = argv.filter((arg) => arg !== "--json");
  const command = args[0];
  if (!command) {
    const error = new CliError("usage", "usage: claude-peers [--json] status|peers|send <peer-id> <message>|kill-broker");
    reportError(error, json);
    return EXIT[error.kind];
  }

  const port = Number(process.env.CLAUDE_PEERS_PORT ?? "7899");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const error = new CliError("usage", "CLAUDE_PEERS_PORT must be an integer from 1 to 65535");
    reportError(error, json);
    return EXIT[error.kind];
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  const timeoutMs = configuredTimeout();
  try {
    await ensureBrokerRunning({
      baseUrl,
      brokerScript: realpathSync(new URL("./broker.ts", import.meta.url).pathname),
      logPath: process.env.CLAUDE_PEERS_BROKER_LOG ?? `${process.env.HOME}/.claude-peers-broker.log`,
      timeoutMs: Math.max(timeoutMs, 1000),
      allowStart: process.env.CLAUDE_PEERS_NO_AUTOSTART !== "1",
    });
  } catch (error) {
    const mapped = mapRequestError(error, "broker startup");
    reportError(mapped, json);
    return EXIT[mapped.kind];
  }

  let identity: CliIdentity;
  try {
    identity = await registerCli(baseUrl, timeoutMs);
  } catch (error) {
    const mapped = error instanceof CliError ? error : mapRequestError(error, "CLI registration");
    reportError(mapped, json);
    return EXIT[mapped.kind];
  }

  const context: CliContext = { baseUrl, timeoutMs, json, identity, cleaned: false };
  let signalCleanup = false;
  const signalHandler = (signal: "SIGINT" | "SIGTERM") => {
    if (signalCleanup) return;
    signalCleanup = true;
    void unregisterCli(context).finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);

  let primaryError: CliError | null = null;
  try {
    await runCommand(command, args.slice(1), context, port);
  } catch (error) {
    primaryError = error instanceof CliError ? error : mapRequestError(error, command);
  }

  let cleanupError: CliError | null = null;
  try {
    await unregisterCli(context);
  } catch (error) {
    cleanupError = error instanceof CliError ? error : new CliError("cleanup", "transient CLI identity cleanup failed");
  }
  process.removeListener("SIGINT", signalHandler);
  process.removeListener("SIGTERM", signalHandler);

  if (primaryError && cleanupError) {
    const partial = new CliError("partial", `${primaryError.message}; ${cleanupError.message}`);
    reportError(partial, json);
    return EXIT.partial;
  }
  const finalError = primaryError ?? cleanupError;
  if (finalError) {
    reportError(finalError, json);
    return EXIT[finalError.kind];
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
