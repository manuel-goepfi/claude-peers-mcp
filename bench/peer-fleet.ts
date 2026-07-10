#!/usr/bin/env bun
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { summarizeLatency, type LatencySummary } from "../shared/runtime-metrics.ts";
import { startTestBroker, type TestBroker } from "../tests/helpers/test-broker.ts";

export const BENCHMARK_STAGES = ["baseline", "instrumented", "tmux-suppressed", "adaptive"] as const;
export const BENCHMARK_SCENARIOS = ["all-idle", "one-active", "randomized-phase"] as const;
export type BenchmarkStage = typeof BENCHMARK_STAGES[number];
export type BenchmarkScenario = typeof BENCHMARK_SCENARIOS[number];
type ReceiverState = "active" | "idle";

export type LatencyStats = LatencySummary;

export interface WindowRecord {
  index: number;
  total_requests: number;
  requests_per_second: number;
  max_one_second_requests: number;
  one_second_buckets: Array<{ second: number; total: number; routes: Record<string, number> }>;
  routes: Record<string, number>;
  errors: number;
  rate_limited: number;
}

export interface FleetRunRecord {
  record_version: 1;
  stage: BenchmarkStage;
  revision: string;
  fleet_size: number;
  scenario: BenchmarkScenario;
  repetition: number;
  seed: number;
  started_at: string;
  finished_at: string;
  warmup_ms: number;
  steady_ms: number;
  window_ms: number;
  environment: { bun: string; kernel: string; cpu: string; clock_ticks_per_second: number };
  capabilities: { metrics: boolean; tmux_write_suppression: boolean; adaptive_polling: boolean; heartbeat_phase_spread: boolean };
  windows: WindowRecord[];
  route_totals: Record<string, number>;
  cpu_seconds: number;
  cpu_seconds_by_process: { broker: number; adapters: number };
  pss_kb: { samples: number[]; average: number; max: number };
  queue_to_buffer: { active: LatencyStats; idle: LatencyStats };
  queue_to_ack: { active: LatencyStats; idle: LatencyStats };
  poll_state_transitions: Array<{ adapter: number; observed_at: string; from: string; to: string; reason: string; delay_ms: number }>;
  errors: number;
  rate_limited: number;
  fake_tmux_writes: number;
  end_health: { adapters_responding: number; targetable_peers: number; expected: number };
}

interface ProxyEvent { at: number; route: string; status: number }
interface SentMessage { sentAt: number; state: ReceiverState }
interface LatencySample { milliseconds: number; state: ReceiverState }
interface AdapterHandle { client: Client; transport: StdioClientTransport }

const repoRoot = resolve(import.meta.dir, "..");
const serverScript = join(repoRoot, "server.ts");
export function latencyStats(samples: LatencySample[], state: ReceiverState): LatencyStats {
  const values = samples.filter((sample) => sample.state === state).map((sample) => sample.milliseconds);
  return summarizeLatency(values);
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function commandText(command: string, args: string[] = []): string {
  const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : "unknown";
}

function environment(clockTicks: number): FleetRunRecord["environment"] {
  const cpu = readFileSync("/proc/cpuinfo", "utf8").match(/^model name\s*:\s*(.+)$/m)?.[1]?.trim() ?? "unknown";
  return { bun: Bun.version, kernel: commandText("uname", ["-r"]), cpu, clock_ticks_per_second: clockTicks };
}

function processCpuTicks(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    return Number(fields[11] ?? 0) + Number(fields[12] ?? 0);
  } catch {
    return 0;
  }
}

function processPssKb(pid: number): number {
  try {
    return Number(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8").match(/^Pss:\s+(\d+)\s+kB$/m)?.[1] ?? 0);
  } catch {
    return 0;
  }
}

function stageCapabilities(stage: BenchmarkStage): FleetRunRecord["capabilities"] {
  return {
    metrics: stage !== "baseline",
    tmux_write_suppression: stage === "tmux-suppressed" || stage === "adaptive",
    adaptive_polling: stage === "adaptive",
    heartbeat_phase_spread: stage === "adaptive",
  };
}

function writeFakeTmux(root: string): { bin: string; writes: string } {
  const bin = join(root, "bin");
  const state = join(root, "tmux-state");
  const writes = join(state, "writes.log");
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  const script = join(bin, "tmux");
  writeFileSync(script, `#!/bin/sh
set -eu
state="$CLAUDE_PEERS_FAKE_TMUX_STATE"
safe() { printf '%s' "$1" | tr '/@:%' '____'; }
case "$1" in
  show-options)
    file="$state/$(safe "$4")-$(safe "$6")"
    [ ! -f "$file" ] || cat "$file"
    ;;
  set-option)
    target="$4"
    if [ "$5" = "-u" ]; then
      option="$6"
      rm -f "$state/$(safe "$target")-$(safe "$option")"
    else
      option="$5"
      value="$6"
      printf '%s\n' "$value" > "$state/$(safe "$target")-$(safe "$option")"
    fi
    printf '%s\t%s\n' "$target" "$option" >> "$state/writes.log"
    ;;
  list-panes) ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
  chmodSync(script, 0o700);
  return { bin, writes };
}

class CountingProxy {
  readonly events: ProxyEvent[] = [];
  readonly sentMessages = new Map<number, SentMessage>();
  readonly bufferedIds = new Set<number>();
  readonly bufferLatency: LatencySample[] = [];
  readonly ackLatency: LatencySample[] = [];
  readonly server: ReturnType<typeof Bun.serve>;

  constructor(private readonly upstream: string) {
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => this.forward(request) });
  }

  get port(): number { return this.server.port!; }

  private async forward(request: Request): Promise<Response> {
    const at = Date.now();
    const url = new URL(request.url);
    const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
    let requestBody: Record<string, unknown> = {};
    if (body?.byteLength) {
      try { requestBody = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>; } catch { requestBody = {}; }
    }
    let upstream: Response;
    try {
      upstream = await fetch(`${this.upstream}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        ...(body ? { body } : {}),
      });
    } catch {
      this.events.push({ at, route: `${request.method} ${url.pathname}`, status: 599 });
      return new Response("proxy upstream failure", { status: 502 });
    }
    const responseBytes = await upstream.arrayBuffer();
    this.events.push({ at, route: `${request.method} ${url.pathname}`, status: upstream.status });
    if (upstream.ok && responseBytes.byteLength > 0) {
      try {
        const responseBody = JSON.parse(new TextDecoder().decode(responseBytes)) as Record<string, unknown>;
        if (url.pathname === "/poll-messages" && Array.isArray(responseBody.messages)) {
          for (const message of responseBody.messages as Array<{ id?: unknown }>) {
            const id = Number(message.id);
            const sent = this.sentMessages.get(id);
            if (!sent || this.bufferedIds.has(id)) continue;
            this.bufferedIds.add(id);
            this.bufferLatency.push({ milliseconds: Date.now() - sent.sentAt, state: sent.state });
          }
        }
        if (url.pathname === "/ack-messages" && Number(responseBody.acked ?? 0) > 0 && Array.isArray(requestBody.ids)) {
          for (const rawId of requestBody.ids) {
            const sent = this.sentMessages.get(Number(rawId));
            if (sent) this.ackLatency.push({ milliseconds: Date.now() - sent.sentAt, state: sent.state });
          }
        }
      } catch {
        // Non-JSON responses are still counted by route and status.
      }
    }
    return new Response(responseBytes, { status: upstream.status, headers: upstream.headers });
  }

  stop(): void { this.server.stop(true); }
}

async function post<T>(proxy: CountingProxy, path: string, body: Record<string, unknown>, token?: string): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${proxy.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { "X-Peer-Token": token } : {}) },
    body: JSON.stringify(body),
  });
  const value = await response.json() as Record<string, unknown>;
  if (!response.ok || value.error) throw new Error(`${path} failed with ${response.status}`);
  return value as T;
}

async function startAdapters(options: {
  count: number;
  proxy: CountingProxy;
  broker: TestBroker;
  stage: BenchmarkStage;
  fakeTmuxBin: string;
  fakeTmuxState: string;
  transitions: FleetRunRecord["poll_state_transitions"];
}): Promise<AdapterHandle[]> {
  const capabilities = stageCapabilities(options.stage);
  const results = await Promise.allSettled(Array.from({ length: options.count }, async (_, index) => {
    const client = new Client({ name: `peer-fleet-${index}`, version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverScript],
      cwd: repoRoot,
      env: {
        HOME: options.broker.root,
        PATH: `${options.fakeTmuxBin}:${process.env.PATH ?? ""}`,
        CLAUDE_PEERS_PORT: String(options.proxy.port),
        CLAUDE_PEERS_DB: options.broker.dbPath,
        CLAUDE_PEERS_BROKER_LOG: options.broker.logPath,
        CLAUDE_PEERS_CLIENT_TYPE: "claude",
        CLAUDE_PEER_NAME: `bench-${index}`,
        TMUX_PANE: `%${index + 1}`,
        CLAUDE_PEERS_FAKE_TMUX_STATE: options.fakeTmuxState,
        CLAUDE_PEERS_METRICS_ENABLED: capabilities.metrics ? "true" : "false",
        CLAUDE_PEERS_TMUX_UNCHANGED_WRITE_SUPPRESSION: capabilities.tmux_write_suppression ? "true" : "false",
        CLAUDE_PEERS_ADAPTIVE_POLLING: capabilities.adaptive_polling ? "true" : "false",
        CLAUDE_PEERS_HEARTBEAT_PHASE_SPREAD: capabilities.heartbeat_phase_spread ? "true" : "false",
      },
      stderr: "pipe",
    });
    let buffered = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      while (buffered.includes("\n")) {
        const newline = buffered.indexOf("\n");
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const marker = line.indexOf("poll-state ");
        if (marker < 0) continue;
        try {
          const transition = JSON.parse(line.slice(marker + "poll-state ".length)) as { from: string; to: string; reason: string; delay_ms: number };
          options.transitions.push({ adapter: index, observed_at: new Date().toISOString(), ...transition });
        } catch {
          // A partial or malformed diagnostic line is ignored, never retained.
        }
      }
    });
    await client.connect(transport);
    return { client, transport };
  }));
  const handles = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) {
    await Promise.allSettled(handles.map((handle) => handle.client.close()));
    throw failure.reason;
  }
  return handles;
}

function summarizeWindows(events: ProxyEvent[], steadyStart: number, steadyMs: number, windowMs: number): WindowRecord[] {
  const count = Math.round(steadyMs / windowMs);
  return Array.from({ length: count }, (_, index) => {
    const start = steadyStart + index * windowMs;
    const end = start + windowMs;
    const selected = events.filter((event) => event.at >= start && event.at < end);
    const routes: Record<string, number> = {};
    const seconds = new Map<number, Map<string, number>>();
    for (const event of selected) {
      routes[event.route] = (routes[event.route] ?? 0) + 1;
      const second = Math.floor((event.at - start) / 1_000);
      let bucket = seconds.get(second);
      if (!bucket) {
        bucket = new Map();
        seconds.set(second, bucket);
      }
      bucket.set(event.route, (bucket.get(event.route) ?? 0) + 1);
    }
    const oneSecondBuckets = [...seconds.entries()].sort(([a], [b]) => a - b).map(([second, bucket]) => ({
      second,
      total: [...bucket.values()].reduce((sum, value) => sum + value, 0),
      routes: Object.fromEntries([...bucket.entries()].sort(([a], [b]) => a.localeCompare(b))),
    }));
    return {
      index: index + 1,
      total_requests: selected.length,
      requests_per_second: selected.length / (windowMs / 1_000),
      max_one_second_requests: Math.max(0, ...oneSecondBuckets.map((bucket) => bucket.total)),
      one_second_buckets: oneSecondBuckets,
      routes: Object.fromEntries(Object.entries(routes).sort(([a], [b]) => a.localeCompare(b))),
      errors: selected.filter((event) => event.status >= 400).length,
      rate_limited: selected.filter((event) => event.status === 429).length,
    };
  });
}

function fileLineCount(path: string): number {
  try { return readFileSync(path, "utf8").split("\n").filter(Boolean).length; } catch { return 0; }
}

async function runFleet(options: {
  fleetSize: number;
  scenario: BenchmarkScenario;
  stage: BenchmarkStage;
  repetition: number;
  seed: number;
  warmupMs: number;
  steadyMs: number;
  windowMs: number;
  revision: string;
  clockTicks: number;
}): Promise<FleetRunRecord> {
  const root = mkdtempSync(join(tmpdir(), `claude-peers-fleet-${options.stage}-${options.fleetSize}-`));
  const fakeTmux = writeFakeTmux(root);
  const broker = await startTestBroker({ root: join(root, "broker"), cleanupOnStop: false, prefix: "fleet", env: { CLAUDE_PEERS_METRICS_ENABLED: stageCapabilities(options.stage).metrics ? "true" : "false" } });
  const proxy = new CountingProxy(broker.url);
  const transitions: FleetRunRecord["poll_state_transitions"] = [];
  let adapters: AdapterHandle[] = [];
  let activityTimer: ReturnType<typeof setInterval> | null = null;
  let pssTimer: ReturnType<typeof setInterval> | null = null;
  const startedAt = new Date().toISOString();
  try {
    adapters = await startAdapters({
      count: options.fleetSize,
      proxy,
      broker,
      stage: options.stage,
      fakeTmuxBin: fakeTmux.bin,
      fakeTmuxState: join(root, "tmux-state"),
      transitions,
    });
    const registration = await post<{ id: string; token: string }>(proxy, "/register-cli", { pid: process.pid });
    const peers = await post<Array<{ id: string; name: string | null }>>(proxy, "/list-peers", { id: registration.id, scope: "machine", cwd: repoRoot, git_root: null }, registration.token);
    const targets = [...peers].filter((peer) => peer.name?.startsWith("bench-")).sort((a, b) => Number(a.name!.slice(6)) - Number(b.name!.slice(6)));
    if (targets.length !== options.fleetSize) throw new Error(`expected ${options.fleetSize} adapters, found ${targets.length}`);

    const random = mulberry32(options.seed);
    const lastActivity = Array.from({ length: options.fleetSize }, () => Number.NEGATIVE_INFINITY);
    const runStart = Date.now();
    let tick = 0;
    let sentIndex = 0;
    let activityBusy = false;
    let scenarioError: Error | null = null;
    let rejectScenario: (error: Error) => void = () => {};
    const scenarioFailure = new Promise<never>((_resolve, reject) => { rejectScenario = reject; });
    const tickScenario = async () => {
      if (activityBusy) return;
      activityBusy = true;
      try {
        const elapsed = Date.now() - runStart;
        if (tick % 10 === 0) await post(proxy, "/heartbeat", { id: registration.id }, registration.token);
        if (options.scenario === "one-active" && tick % 2 === 0) {
          lastActivity[0] = Date.now();
          await adapters[0]!.client.callTool({ name: "whoami", arguments: {} });
        } else if (options.scenario === "randomized-phase" && tick % 3 === 0) {
          const index = Math.floor(random() * adapters.length);
          lastActivity[index] = Date.now();
          await adapters[index]!.client.callTool({ name: "whoami", arguments: {} });
        }

        const inSteady = elapsed >= options.warmupMs && elapsed < options.warmupMs + options.steadyMs;
        const sendEveryTicks = options.scenario === "one-active" ? 15 : options.scenario === "all-idle" ? 20 : 10;
        const sendPhase = options.scenario === "one-active" ? 7 : 0;
        if (inSteady && tick % sendEveryTicks === sendPhase) {
          const targetIndex = options.scenario === "one-active" ? 0 : options.scenario === "all-idle" ? sentIndex % targets.length : Math.floor(random() * targets.length);
          const state: ReceiverState = Date.now() - lastActivity[targetIndex]! <= 5_000 ? "active" : "idle";
          const sentAt = Date.now();
          const sent = await post<{ id: number }>(proxy, "/send-message", { from_id: registration.id, to_id: targets[targetIndex]!.id, text: `fleet-${options.seed}-${sentIndex}` }, registration.token);
          proxy.sentMessages.set(sent.id, { sentAt, state });
          sentIndex++;
        }
        if (inSteady && options.scenario !== "all-idle" && tick % 5 === 0) {
          const targetIndex = options.scenario === "one-active" ? 0 : Math.floor(random() * adapters.length);
          lastActivity[targetIndex] = Date.now();
          await adapters[targetIndex]!.client.callTool({ name: "check_messages", arguments: {} });
        }
      } finally {
        tick++;
        activityBusy = false;
      }
    };
    const failScenario = (error: unknown) => {
      scenarioError = error instanceof Error ? error : new Error(String(error));
      rejectScenario(scenarioError);
    };
    activityTimer = setInterval(() => void tickScenario().catch(failScenario), 1_000);
    await tickScenario();
    await Promise.race([Bun.sleep(options.warmupMs), scenarioFailure]);

    const pids = [broker.proc.pid, ...adapters.map((adapter) => adapter.transport.pid).filter((pid): pid is number => pid !== null)];
    const brokerCpuStart = processCpuTicks(broker.proc.pid);
    const adapterCpuStart = pids.slice(1).reduce((sum, pid) => sum + processCpuTicks(pid), 0);
    const steadyStart = Date.now();
    const pssSamples: number[] = [];
    const samplePss = () => pssSamples.push(pids.reduce((sum, pid) => sum + processPssKb(pid), 0));
    samplePss();
    pssTimer = setInterval(samplePss, Math.min(5_000, Math.max(1_000, options.windowMs / 2)));
    await Promise.race([Bun.sleep(options.steadyMs), scenarioFailure]);
    if (activityTimer) clearInterval(activityTimer);
    activityTimer = null;
    while (activityBusy) await Bun.sleep(10);
    if (scenarioError) throw scenarioError;
    if (pssTimer) clearInterval(pssTimer);
    pssTimer = null;
    samplePss();
    const brokerCpuEnd = processCpuTicks(broker.proc.pid);
    const adapterCpuEnd = pids.slice(1).reduce((sum, pid) => sum + processCpuTicks(pid), 0);

    const adapterProofs = await Promise.all(adapters.map((adapter) => adapter.client.callTool({ name: "whoami", arguments: {} })));
    const adaptersResponding = adapterProofs.filter((proof) => !proof.isError).length;
    const endPeers = await post<Array<{ id: string; name: string | null }>>(proxy, "/list-peers", { id: registration.id, scope: "machine", cwd: repoRoot, git_root: null }, registration.token);
    const targetIds = new Set(targets.map((target) => target.id));
    const targetablePeers = endPeers.filter((peer) => targetIds.has(peer.id)).length;
    if (adaptersResponding !== options.fleetSize || targetablePeers !== options.fleetSize) {
      throw new Error(`fleet lost adapters: responding=${adaptersResponding}/${options.fleetSize}, targetable=${targetablePeers}/${options.fleetSize}`);
    }

    const windows = summarizeWindows(proxy.events, steadyStart, options.steadyMs, options.windowMs);
    const steadyEvents = proxy.events.filter((event) => event.at >= steadyStart && event.at < steadyStart + options.steadyMs);
    const routeTotals: Record<string, number> = {};
    for (const event of steadyEvents) routeTotals[event.route] = (routeTotals[event.route] ?? 0) + 1;
    return {
      record_version: 1,
      stage: options.stage,
      revision: options.revision,
      fleet_size: options.fleetSize,
      scenario: options.scenario,
      repetition: options.repetition,
      seed: options.seed,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      warmup_ms: options.warmupMs,
      steady_ms: options.steadyMs,
      window_ms: options.windowMs,
      environment: environment(options.clockTicks),
      capabilities: stageCapabilities(options.stage),
      windows,
      route_totals: Object.fromEntries(Object.entries(routeTotals).sort(([a], [b]) => a.localeCompare(b))),
      cpu_seconds: (brokerCpuEnd - brokerCpuStart + adapterCpuEnd - adapterCpuStart) / options.clockTicks,
      cpu_seconds_by_process: { broker: (brokerCpuEnd - brokerCpuStart) / options.clockTicks, adapters: (adapterCpuEnd - adapterCpuStart) / options.clockTicks },
      pss_kb: { samples: pssSamples, average: pssSamples.reduce((sum, value) => sum + value, 0) / Math.max(1, pssSamples.length), max: Math.max(0, ...pssSamples) },
      queue_to_buffer: { active: latencyStats(proxy.bufferLatency, "active"), idle: latencyStats(proxy.bufferLatency, "idle") },
      queue_to_ack: { active: latencyStats(proxy.ackLatency, "active"), idle: latencyStats(proxy.ackLatency, "idle") },
      poll_state_transitions: transitions,
      errors: steadyEvents.filter((event) => event.status >= 400).length,
      rate_limited: steadyEvents.filter((event) => event.status === 429).length,
      fake_tmux_writes: fileLineCount(fakeTmux.writes),
      end_health: { adapters_responding: adaptersResponding, targetable_peers: targetablePeers, expected: options.fleetSize },
    };
  } finally {
    if (activityTimer) clearInterval(activityTimer);
    if (pssTimer) clearInterval(pssTimer);
    await Promise.allSettled(adapters.map((adapter) => adapter.client.close()));
    proxy.stop();
    await broker.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

interface CampaignCheck { name: string; passed: boolean; actual: number | string | null; limit: number | string }
export interface CampaignSummary {
  summary_version: 1;
  quick: boolean;
  passed: boolean;
  records: number;
  transport_proposal_required: boolean;
  checks: CampaignCheck[];
}

function pairKey(record: FleetRunRecord): string {
  return `${record.fleet_size}|${record.scenario}|${record.repetition}|${record.seed}`;
}

export function evaluateCampaign(records: FleetRunRecord[], quick = false): CampaignSummary {
  const checks: CampaignCheck[] = [];
  const coordinateCounts = new Map<string, number>();
  const byStage = new Map<BenchmarkStage, Map<string, FleetRunRecord>>();
  for (const stage of BENCHMARK_STAGES) byStage.set(stage, new Map());
  for (const record of records) {
    const coordinate = `${record.stage}|${pairKey(record)}`;
    coordinateCounts.set(coordinate, (coordinateCounts.get(coordinate) ?? 0) + 1);
    byStage.get(record.stage)!.set(pairKey(record), record);
  }

  const duplicates = [...coordinateCounts.entries()].filter(([, count]) => count !== 1).map(([coordinate, count]) => `${coordinate}x${count}`);
  checks.push({ name: "unique campaign coordinates", passed: duplicates.length === 0, actual: duplicates.length ? duplicates.join(",") : "unique", limit: "exactly once" });

  if (!quick) {
    checks.push({ name: "exact campaign record count", passed: records.length === 108, actual: records.length, limit: 108 });
    for (const stage of BENCHMARK_STAGES) {
      const count = records.filter((record) => record.stage === stage).length;
      checks.push({ name: `${stage} stage record count`, passed: count === 27, actual: count, limit: 27 });
    }
    const expectedCoordinates = new Set<string>();
    for (const stage of BENCHMARK_STAGES) {
      for (const fleetSize of [1, 10, 50]) {
        for (const scenario of BENCHMARK_SCENARIOS) {
          for (let repetition = 1; repetition <= 3; repetition++) {
            const seed = fleetSize * 100_000 + BENCHMARK_SCENARIOS.indexOf(scenario) * 1_000 + repetition;
            expectedCoordinates.add(`${stage}|${fleetSize}|${scenario}|${repetition}|${seed}`);
          }
        }
      }
    }
    const actualCoordinates = new Set(records.map((record) => `${record.stage}|${pairKey(record)}`));
    const missing = [...expectedCoordinates].filter((coordinate) => !actualCoordinates.has(coordinate));
    const unexpected = [...actualCoordinates].filter((coordinate) => !expectedCoordinates.has(coordinate));
    checks.push({
      name: "exact campaign topology",
      passed: missing.length === 0 && unexpected.length === 0,
      actual: missing.length === 0 && unexpected.length === 0 ? "complete" : `missing=${missing.length},unexpected=${unexpected.length}`,
      limit: "108 expected stage/fleet/scenario/repetition/seed coordinates",
    });
  }

  for (const record of records) {
    const expectedCapabilities = stageCapabilities(record.stage);
    const capabilitiesMatch = Object.entries(expectedCapabilities).every(([name, enabled]) => record.capabilities[name as keyof typeof expectedCapabilities] === enabled);
    checks.push({ name: `stage capabilities ${record.stage} ${pairKey(record)}`, passed: capabilitiesMatch, actual: JSON.stringify(record.capabilities), limit: JSON.stringify(expectedCapabilities) });
    const windowsValid = record.windows.length === 3 && record.steady_ms === record.window_ms * 3 && record.windows.every((window, index) => window.index === index + 1);
    checks.push({ name: `three measurement windows ${record.stage} ${pairKey(record)}`, passed: windowsValid, actual: `${record.windows.map((window) => window.index).join(",")}/${record.steady_ms}/${record.window_ms}`, limit: "windows 1,2,3 and steady=3*window" });
    const windowRoutes: Record<string, number> = {};
    for (const window of record.windows) {
      for (const [route, count] of Object.entries(window.routes)) windowRoutes[route] = (windowRoutes[route] ?? 0) + count;
    }
    const routeTotalsMatch = JSON.stringify(Object.entries(windowRoutes).sort()) === JSON.stringify(Object.entries(record.route_totals).sort());
    const errorsMatch = record.windows.reduce((sum, window) => sum + window.errors, 0) === record.errors;
    const rateLimitsMatch = record.windows.reduce((sum, window) => sum + window.rate_limited, 0) === record.rate_limited;
    checks.push({ name: `window aggregates ${record.stage} ${pairKey(record)}`, passed: routeTotalsMatch && errorsMatch && rateLimitsMatch, actual: `${routeTotalsMatch}/${errorsMatch}/${rateLimitsMatch}`, limit: "routes/errors/rate-limits match" });
    const metadataValid = record.record_version === 1 && record.revision.length > 0 && record.environment.kernel.length > 0 && record.environment.cpu.length > 0 && record.environment.clock_ticks_per_second > 0 && (quick || record.environment.bun === "1.3.11");
    checks.push({ name: `record metadata ${record.stage} ${pairKey(record)}`, passed: metadataValid, actual: `${record.record_version}/${record.revision}/${record.environment.bun}`, limit: quick ? "complete" : "v1/revision/Bun 1.3.11" });
    const resourcesValid = record.cpu_seconds >= 0 && record.pss_kb.samples.length > 0 && record.pss_kb.average > 0 && record.pss_kb.max >= record.pss_kb.average;
    checks.push({ name: `resource samples ${record.stage} ${pairKey(record)}`, passed: resourcesValid, actual: `${record.cpu_seconds}/${record.pss_kb.samples.length}/${record.pss_kb.average}/${record.pss_kb.max}`, limit: "nonnegative CPU and nonempty positive PSS" });
    const expectedEnd = record.fleet_size;
    const endHealthy = record.end_health.expected === expectedEnd && record.end_health.adapters_responding === expectedEnd && record.end_health.targetable_peers === expectedEnd;
    checks.push({ name: `fleet alive at end ${record.stage} ${pairKey(record)}`, passed: endHealthy, actual: `${record.end_health.adapters_responding}/${record.end_health.targetable_peers}/${record.end_health.expected}`, limit: `${expectedEnd}/${expectedEnd}/${expectedEnd}` });
    if (record.stage === "adaptive") {
      checks.push({ name: `adaptive transition evidence ${pairKey(record)}`, passed: quick || record.poll_state_transitions.length > 0, actual: record.poll_state_transitions.length, limit: ">0" });
    }
  }

  for (const [key, baseline] of byStage.get("baseline")!) {
    const instrumented = byStage.get("instrumented")!.get(key);
    if (!instrumented) continue;
    const cpuRatio = baseline.cpu_seconds > 0 ? instrumented.cpu_seconds / baseline.cpu_seconds : Number.POSITIVE_INFINITY;
    const pssRatio = baseline.pss_kb.average > 0 ? instrumented.pss_kb.average / baseline.pss_kb.average : Number.POSITIVE_INFINITY;
    checks.push({ name: `instrumentation CPU overhead ${key}`, passed: quick || cpuRatio <= 1.05, actual: cpuRatio, limit: "<=1.05" });
    checks.push({ name: `instrumentation PSS overhead ${key}`, passed: quick || pssRatio <= 1.05, actual: pssRatio, limit: "<=1.05" });
  }

  for (const [key, instrumented] of byStage.get("instrumented")!) {
    for (const stage of ["tmux-suppressed", "adaptive"] as const) {
      const suppressed = byStage.get(stage)!.get(key);
      if (!suppressed) continue;
      const reduced = suppressed.fake_tmux_writes < instrumented.fake_tmux_writes;
      checks.push({ name: `${stage} tmux write suppression ${key}`, passed: quick || reduced, actual: `${suppressed.fake_tmux_writes}/${instrumented.fake_tmux_writes}`, limit: "suppressed < instrumented" });
    }
  }

  const adaptiveMisses = new Map<"all-idle" | "one-active", number>([["all-idle", 0], ["one-active", 0]]);
  for (const [key, adaptive] of byStage.get("adaptive")!) {
    const baseline = byStage.get("baseline")!.get(key);
    if (!baseline || adaptive.fleet_size !== 50 || !["all-idle", "one-active"].includes(adaptive.scenario)) continue;
    let adaptiveRunPassed = true;
    const addAdaptiveCheck = (name: string, passed: boolean, actual: number | null, limit: string) => {
      const gated = quick || passed;
      checks.push({ name, passed: gated, actual, limit });
      if (!gated) adaptiveRunPassed = false;
    };
    const reduction = baseline.cpu_seconds > 0 ? 1 - adaptive.cpu_seconds / baseline.cpu_seconds : Number.NEGATIVE_INFINITY;
    const pssRatio = baseline.pss_kb.average > 0 ? adaptive.pss_kb.average / baseline.pss_kb.average : Number.POSITIVE_INFINITY;
    addAdaptiveCheck(`final CPU reduction ${key}`, reduction >= 0.5, reduction, ">=0.50");
    addAdaptiveCheck(`final PSS ratio ${key}`, pssRatio <= 1.10, pssRatio, "<=1.10");
    for (const window of adaptive.windows) {
      addAdaptiveCheck(`request budget ${key} window ${window.index}`, window.requests_per_second <= 10, window.requests_per_second, "<=10/s");
      addAdaptiveCheck(`one-second herd ${key} window ${window.index}`, window.max_one_second_requests <= 20, window.max_one_second_requests, "<=20");
    }
    const latency = adaptive.scenario === "one-active" ? adaptive.queue_to_buffer.active : adaptive.queue_to_buffer.idle;
    const p95Limit = adaptive.scenario === "one-active" ? 2_000 : 11_000;
    addAdaptiveCheck(`buffer p95 ${key}`, latency.p95_ms !== null && latency.p95_ms <= p95Limit, latency.p95_ms, `<=${p95Limit}`);
    if (adaptive.scenario === "all-idle") addAdaptiveCheck(`buffer max ${key}`, latency.max_ms !== null && latency.max_ms <= 12_000, latency.max_ms, "<=12000");
    if (!adaptiveRunPassed) {
      const scenario = adaptive.scenario as "all-idle" | "one-active";
      adaptiveMisses.set(scenario, adaptiveMisses.get(scenario)! + 1);
    }
  }

  for (const record of records) {
    checks.push({ name: `no request errors ${record.stage} ${pairKey(record)}`, passed: record.errors === 0 && record.rate_limited === 0, actual: `${record.errors}/${record.rate_limited}`, limit: "0/0" });
  }
  for (const stage of BENCHMARK_STAGES) {
    for (const scenario of BENCHMARK_SCENARIOS) {
      for (let repetition = 1; repetition <= 3; repetition++) {
        const scaling = records.filter((record) => record.stage === stage && record.scenario === scenario && record.repetition === repetition).sort((a, b) => a.fleet_size - b.fleet_size);
        if (scaling.length < 2) continue;
        const cpuMonotonic = scaling.every((record, index) => index === 0 || record.cpu_seconds >= scaling[index - 1]!.cpu_seconds);
        const pssMonotonic = scaling.every((record, index) => index === 0 || record.pss_kb.average >= scaling[index - 1]!.pss_kb.average);
        checks.push({ name: `CPU scaling ${stage} ${scenario} r${repetition}`, passed: cpuMonotonic, actual: scaling.map((record) => record.cpu_seconds).join(","), limit: "monotonic" });
        checks.push({ name: `PSS scaling ${stage} ${scenario} r${repetition}`, passed: pssMonotonic, actual: scaling.map((record) => Math.round(record.pss_kb.average)).join(","), limit: "monotonic" });
      }
    }
  }
  const transportProposalRequired = !quick && [...adaptiveMisses.values()].some((misses) => misses >= 2);
  return { summary_version: 1, quick, passed: checks.every((check) => check.passed), records: records.length, transport_proposal_required: transportProposalRequired, checks };
}

function argValue(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}

async function main(args = process.argv.slice(2)): Promise<number> {
  const quick = args.includes("--quick");
  const fleets = argValue(args, "--peers", "1,10,50").split(",").map(Number);
  const repetitions = Number(argValue(args, "--repetitions", quick ? "1" : "3"));
  const stages = argValue(args, "--stages", BENCHMARK_STAGES.join(",")).split(",") as BenchmarkStage[];
  const selectedScenarios = argValue(args, "--scenarios", BENCHMARK_SCENARIOS.join(",")).split(",") as BenchmarkScenario[];
  const warmupMs = Number(argValue(args, "--warmup-ms", quick ? "2000" : "30000"));
  const steadyMs = Number(argValue(args, "--steady-ms", quick ? "6000" : "180000"));
  const windowMs = Number(argValue(args, "--window-ms", quick ? "2000" : "60000"));
  if (!quick && process.platform !== "linux") throw new Error("release campaign supports Linux only");
  if (!quick && Bun.version !== "1.3.11") throw new Error(`release campaign requires Bun 1.3.11, found ${Bun.version}`);
  if (!quick && Bun.spawnSync(["git", "diff", "--quiet", "HEAD", "--"]).exitCode !== 0) throw new Error("release campaign requires a clean tracked worktree");
  if (!quick && JSON.stringify(fleets) !== JSON.stringify([1, 10, 50])) throw new Error("release campaign requires peer fleets 1,10,50 in canonical order");
  if (!quick && JSON.stringify(stages) !== JSON.stringify(BENCHMARK_STAGES)) throw new Error("release campaign requires all four stages in canonical order");
  if (!quick && JSON.stringify(selectedScenarios) !== JSON.stringify(BENCHMARK_SCENARIOS)) throw new Error("release campaign requires all three scenarios in canonical order");
  if (!quick && (warmupMs !== 30_000 || steadyMs !== 180_000 || windowMs !== 60_000 || repetitions !== 3)) throw new Error("release campaign requires 30s warmup, 180s steady, 60s windows, and 3 repetitions");
  if (steadyMs / windowMs !== 3) throw new Error("campaign must contain exactly three steady-state windows");
  if (fleets.some((value) => !Number.isInteger(value) || value < 1) || repetitions < 1) throw new Error("invalid fleet or repetition count");
  if (stages.some((stage) => !(BENCHMARK_STAGES as readonly string[]).includes(stage))) throw new Error("invalid benchmark stage");
  if (selectedScenarios.some((scenario) => !(BENCHMARK_SCENARIOS as readonly string[]).includes(scenario))) throw new Error("invalid benchmark scenario");
  const revision = commandText("git", ["rev-parse", "HEAD"]);
  const clockTicks = Number(commandText("getconf", ["CLK_TCK"])) || 100;
  const output = resolve(argValue(args, "--output", join(repoRoot, "bench/results", new Date().toISOString().replace(/[:.]/g, "-"))));
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  mkdirSync(output, { mode: 0o700 });
  const records: FleetRunRecord[] = [];
  for (const stage of stages) {
    for (const fleetSize of fleets) {
      for (const scenario of selectedScenarios) {
        for (let repetition = 1; repetition <= repetitions; repetition++) {
          const seed = fleetSize * 100_000 + BENCHMARK_SCENARIOS.indexOf(scenario) * 1_000 + repetition;
          const record = await runFleet({ fleetSize, scenario, stage, repetition, seed, warmupMs, steadyMs, windowMs, revision, clockTicks });
          records.push(record);
          const filename = `${stage}-${fleetSize}-${scenario}-r${repetition}.json`;
          writeFileSync(join(output, filename), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
          console.log(JSON.stringify({ event: "run-complete", stage, fleet_size: fleetSize, scenario, repetition, cpu_seconds: record.cpu_seconds, pss_kb: record.pss_kb.average }));
        }
      }
    }
  }
  const summary = evaluateCampaign(records, quick);
  writeFileSync(join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  if (summary.transport_proposal_required) {
    const failures = summary.checks.filter((check) => !check.passed);
    writeFileSync(join(output, "transport-proposal-required.md"), `# Adaptive polling gate failed\n\nThe measured repair stops here. No long-poll or replacement transport was implemented.\n\nFailed checks:\n${failures.map((failure) => `- ${failure.name}: actual ${failure.actual}, required ${failure.limit}`).join("\n")}\n`, { mode: 0o600 });
  }
  console.log(JSON.stringify({ event: "campaign-complete", output, passed: summary.passed, records: records.length }));
  return summary.passed ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`peer fleet benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
