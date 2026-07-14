import { describe, expect, test } from "bun:test";
import { benchmarkAdapterIdentityEnv, evaluateCampaign, latencyStats, type FleetRunRecord } from "../bench/peer-fleet.ts";

function record(stage: FleetRunRecord["stage"], overrides: Partial<FleetRunRecord> = {}): FleetRunRecord {
  return {
    record_version: 1,
    stage,
    revision: "test",
    fleet_size: 50,
    scenario: "all-idle",
    repetition: 1,
    seed: 1,
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:03:30.000Z",
    warmup_ms: 30_000,
    steady_ms: 180_000,
    window_ms: 60_000,
    environment: { bun: "1.3.11", kernel: "test", cpu: "test", clock_ticks_per_second: 100 },
    capabilities: { metrics: stage !== "baseline", tmux_write_suppression: stage === "tmux-suppressed" || stage === "adaptive", adaptive_polling: stage === "adaptive", heartbeat_phase_spread: stage === "adaptive" },
    windows: [1, 2, 3].map((index) => ({
      index,
      total_requests: 300,
      requests_per_second: 5,
      max_one_second_requests: 5,
      one_second_buckets: Array.from({ length: 60 }, (_, second) => ({ second, total: 5, routes: { "POST /poll-messages": 5 } })),
      routes: { "POST /poll-messages": 300 },
      errors: 0,
      rate_limited: 0,
    })),
    route_totals: { "POST /poll-messages": 900 },
    cpu_seconds: stage === "adaptive" ? 40 : 100,
    cpu_seconds_by_process: { broker: 20, adapters: stage === "adaptive" ? 20 : 80 },
    pss_kb: { samples: [1000], average: 1000, max: 1000 },
    queue_to_buffer: { active: { count: 0, p50_ms: null, p95_ms: null, max_ms: null }, idle: { count: 3, p50_ms: 5000, p95_ms: 9000, max_ms: 10_000 } },
    queue_to_ack: { active: { count: 0, p50_ms: null, p95_ms: null, max_ms: null }, idle: { count: 0, p50_ms: null, p95_ms: null, max_ms: null } },
    poll_state_transitions: stage === "adaptive" ? [{ adapter: 0, observed_at: "2026-01-01T00:00:00.000Z", from: "active", to: "backoff", reason: "empty-poll", delay_ms: 2_000 }] : [],
    errors: 0,
    rate_limited: 0,
    fake_tmux_writes: stage === "tmux-suppressed" || stage === "adaptive" ? 10 : 100,
    end_health: { adapters_responding: 50, targetable_peers: 50, expected: 50 },
    ...overrides,
  };
}

function passingCampaign(): FleetRunRecord[] {
  const records: FleetRunRecord[] = [];
  const scenarios = ["all-idle", "one-active", "randomized-phase"] as const;
  for (const stage of ["baseline", "instrumented", "tmux-suppressed", "adaptive"] as const) {
    for (const fleetSize of [1, 10, 50]) {
      for (const scenario of scenarios) {
        for (let repetition = 1; repetition <= 3; repetition++) {
          const baselineCpu = fleetSize * 2;
          const cpu = stage === "instrumented" ? baselineCpu * 1.04 : stage === "adaptive" ? baselineCpu * 0.4 : baselineCpu;
          const baselinePss = fleetSize * 1_000;
          const pss = stage === "instrumented" ? baselinePss * 1.04 : baselinePss;
          records.push(record(stage, {
            fleet_size: fleetSize,
            scenario,
            repetition,
            seed: fleetSize * 100_000 + scenarios.indexOf(scenario) * 1_000 + repetition,
            cpu_seconds: cpu,
            cpu_seconds_by_process: { broker: cpu * 0.2, adapters: cpu * 0.8 },
            pss_kb: { samples: [pss], average: pss, max: pss },
            end_health: { adapters_responding: fleetSize, targetable_peers: fleetSize, expected: fleetSize },
            queue_to_buffer: scenario === "one-active"
              ? { active: { count: 3, p50_ms: 500, p95_ms: 1_000, max_ms: 1_000 }, idle: { count: 0, p50_ms: null, p95_ms: null, max_ms: null } }
              : { active: { count: 0, p50_ms: null, p95_ms: null, max_ms: null }, idle: { count: 3, p50_ms: 5_000, p95_ms: 9_000, max_ms: 10_000 } },
          }));
        }
      }
    }
  }
  return records;
}

describe("peer fleet evidence evaluation", () => {
  test("gives every simulated adapter a canonical unique tmux seat", () => {
    expect(benchmarkAdapterIdentityEnv(0)).toMatchObject({
      CLAUDE_PEER_TMUX_SESSION: "peer-fleet",
      CLAUDE_PEER_TMUX_PANE_ID: "%1",
    });
    expect(benchmarkAdapterIdentityEnv(9).CLAUDE_PEER_TMUX_PANE_ID).toBe("%10");
  });

  test("latency summaries retain state-specific p50/p95/max", () => {
    const samples = [
      { milliseconds: 10, state: "active" as const },
      { milliseconds: 20, state: "active" as const },
      { milliseconds: 100, state: "idle" as const },
    ];
    expect(latencyStats(samples, "active")).toEqual({ count: 2, p50_ms: 10, p95_ms: 20, max_ms: 20 });
    expect(latencyStats(samples, "idle")).toEqual({ count: 1, p50_ms: 100, p95_ms: 100, max_ms: 100 });
  });

  test("passes the paired CPU, PSS, request, herd, and idle latency gates", () => {
    const summary = evaluateCampaign(passingCampaign());
    expect(summary.records).toBe(108);
    expect(summary.passed).toBe(true);
  });

  test("fails and names a missed adaptive gate", () => {
    const records = [record("baseline"), record("instrumented"), record("adaptive", { cpu_seconds: 60 })];
    const summary = evaluateCampaign(records);
    expect(summary.passed).toBe(false);
    expect(summary.checks.some((check) => check.name.startsWith("final CPU reduction") && !check.passed)).toBe(true);
  });

  test("rejects duplicate coordinates even when stage counts look complete", () => {
    const records = passingCampaign();
    records[1] = structuredClone(records[0]!);
    const summary = evaluateCampaign(records);
    expect(summary.passed).toBe(false);
    expect(summary.checks.some((check) => check.name === "unique campaign coordinates" && !check.passed)).toBe(true);
    expect(summary.checks.some((check) => check.name === "exact campaign topology" && !check.passed)).toBe(true);
  });

  test("rejects a run whose adapters disappeared before final proof", () => {
    const records = passingCampaign();
    records[0]!.end_health.adapters_responding = records[0]!.fleet_size - 1;
    const summary = evaluateCampaign(records);
    expect(summary.passed).toBe(false);
    expect(summary.checks.some((check) => check.name.startsWith("fleet alive at end") && !check.passed)).toBe(true);
  });

  test("rejects missing adaptive transitions and ineffective tmux suppression", () => {
    const records = passingCampaign();
    records.find((entry) => entry.stage === "adaptive")!.poll_state_transitions = [];
    const instrumented = records.find((entry) => entry.stage === "instrumented")!;
    records.find((entry) => entry.stage === "tmux-suppressed" && entry.fleet_size === instrumented.fleet_size && entry.scenario === instrumented.scenario && entry.repetition === instrumented.repetition)!.fake_tmux_writes = instrumented.fake_tmux_writes;
    const summary = evaluateCampaign(records);
    expect(summary.passed).toBe(false);
    expect(summary.checks.some((check) => check.name.startsWith("adaptive transition evidence") && !check.passed)).toBe(true);
    expect(summary.checks.some((check) => check.name.startsWith("tmux-suppressed tmux write suppression") && !check.passed)).toBe(true);
  });

  test("rejects contradictory one-second evidence even when trusted scalars look healthy", () => {
    const records = passingCampaign();
    const window = records[0]!.windows[0]!;
    window.one_second_buckets = [{ second: 0, total: 1, routes: { "POST /poll-messages": 1 } }];
    const summary = evaluateCampaign(records);
    expect(summary.passed).toBe(false);
    expect(summary.checks.some((check) => check.name.startsWith("one-second evidence") && !check.passed)).toBe(true);
  });

  test("requests a transport proposal only after two adaptive misses", () => {
    const oneMiss = passingCampaign();
    oneMiss.find((entry) => entry.stage === "adaptive" && entry.fleet_size === 50 && entry.scenario === "all-idle" && entry.repetition === 1)!.cpu_seconds = 60;
    expect(evaluateCampaign(oneMiss).transport_proposal_required).toBe(false);

    const twoMisses = passingCampaign();
    for (const entry of twoMisses.filter((candidate) => candidate.stage === "adaptive" && candidate.fleet_size === 50 && candidate.scenario === "all-idle" && candidate.repetition <= 2)) {
      entry.cpu_seconds = 60;
    }
    expect(evaluateCampaign(twoMisses).transport_proposal_required).toBe(true);
  });

  test("emits one p95 assertion per final adaptive run", () => {
    const summary = evaluateCampaign(passingCampaign());
    expect(summary.checks.filter((check) => check.name.startsWith("buffer p95 "))).toHaveLength(6);
  });

  test("rejects non-monotonic fleet scaling", () => {
    const records = [
      record("baseline", { fleet_size: 1, cpu_seconds: 10 }),
      record("baseline", { fleet_size: 10, cpu_seconds: 9 }),
    ];
    const summary = evaluateCampaign(records, true);
    expect(summary.passed).toBe(false);
    expect(summary.checks.some((check) => check.name.startsWith("CPU scaling") && !check.passed)).toBe(true);
  });
});
