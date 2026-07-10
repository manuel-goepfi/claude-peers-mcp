import { describe, expect, test } from "bun:test";
import { evaluateCampaign, latencyStats, type FleetRunRecord } from "../bench/peer-fleet.ts";

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
    environment: { bun: "1", kernel: "test", cpu: "test", clock_ticks_per_second: 100 },
    capabilities: { metrics: stage !== "baseline", tmux_write_suppression: stage === "adaptive", adaptive_polling: stage === "adaptive", heartbeat_phase_spread: stage === "adaptive" },
    windows: [1, 2, 3].map((index) => ({ index, total_requests: 300, requests_per_second: 5, max_one_second_requests: 8, one_second_buckets: [{ second: 0, total: 8, routes: { "POST /poll-messages": 8 } }], routes: { "POST /poll-messages": 300 }, errors: 0, rate_limited: 0 })),
    route_totals: { "POST /poll-messages": 900 },
    cpu_seconds: stage === "adaptive" ? 40 : 100,
    cpu_seconds_by_process: { broker: 20, adapters: stage === "adaptive" ? 20 : 80 },
    pss_kb: { samples: [1000], average: 1000, max: 1000 },
    queue_to_buffer: { active: { count: 0, p50_ms: null, p95_ms: null, max_ms: null }, idle: { count: 3, p50_ms: 5000, p95_ms: 9000, max_ms: 10_000 } },
    queue_to_ack: { active: { count: 0, p50_ms: null, p95_ms: null, max_ms: null }, idle: { count: 0, p50_ms: null, p95_ms: null, max_ms: null } },
    poll_state_transitions: [],
    errors: 0,
    rate_limited: 0,
    fake_tmux_writes: 0,
    ...overrides,
  };
}

describe("peer fleet evidence evaluation", () => {
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
    const records = [record("baseline"), record("instrumented", { cpu_seconds: 104, pss_kb: { samples: [1040], average: 1040, max: 1040 } }), record("adaptive")];
    expect(evaluateCampaign(records).passed).toBe(true);
  });

  test("fails and names a missed adaptive gate", () => {
    const records = [record("baseline"), record("instrumented"), record("adaptive", { cpu_seconds: 60 })];
    const summary = evaluateCampaign(records);
    expect(summary.passed).toBe(false);
    expect(summary.checks.some((check) => check.name.startsWith("final CPU reduction") && !check.passed)).toBe(true);
  });
});
