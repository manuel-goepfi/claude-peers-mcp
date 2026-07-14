import { describe, expect, test } from "bun:test";
import { AdaptivePollScheduler, cadencePhaseDelay, deterministicPollPhase, phaseSpreadDelay, POLL_BACKOFF_MS } from "../shared/poll-scheduler.ts";
import { shouldReplacePollDeadline, successfulPollOutcome } from "../server.ts";

describe("adaptive Claude polling", () => {
  test("rapid activity can pull a poll earlier but cannot postpone its deadline", () => {
    expect(shouldReplacePollDeadline(null, 1_000)).toBe(true);
    expect(shouldReplacePollDeadline(1_000, 1_500)).toBe(false);
    expect(shouldReplacePollDeadline(1_000, 900)).toBe(true);
  });

  test("uses the exact 1s, 1s, 2s, 4s, 8s, 10s empty-poll sequence", () => {
    const scheduler = new AdaptivePollScheduler("peer-a", 0);
    const bases: number[] = [];
    let now = 0;
    let decision = scheduler.activity("startup", now);
    for (let i = 0; i < POLL_BACKOFF_MS.length; i++) {
      bases.push(decision.base_delay_ms);
      now += decision.delay_ms;
      decision = scheduler.afterPoll("empty", now < 5_000 ? 5_000 : now);
    }
    expect(bases).toEqual([...POLL_BACKOFF_MS]);
  });

  test("active grace holds one-second polling and activity resets backoff", () => {
    const scheduler = new AdaptivePollScheduler("peer-b", 0);
    expect(scheduler.afterPoll("empty", 1_000).state).toBe("active");
    expect(scheduler.afterPoll("empty", 4_999).state).toBe("active");
    expect(scheduler.afterPoll("empty", 5_000).state).toBe("backoff");
    expect(scheduler.activity("tool-call", 6_000).state).toBe("active");
    expect(scheduler.afterPoll("empty", 10_999).state).toBe("active");
  });

  test("idle requires 30 seconds without a trigger and two empty ceiling polls", () => {
    const scheduler = new AdaptivePollScheduler("peer-c", 0);
    let now = 5_000;
    let decision = scheduler.afterPoll("empty", now);
    for (let i = 0; i < 7; i++) {
      now += decision.delay_ms;
      decision = scheduler.afterPoll("empty", now);
    }
    expect(now).toBeGreaterThanOrEqual(30_000);
    expect(decision.state).toBe("idle");
  });

  test("nonempty polls, recovery, and errors return to the active cadence", () => {
    const scheduler = new AdaptivePollScheduler("peer-d", 0);
    scheduler.afterPoll("empty", 5_000);
    scheduler.afterPoll("empty", 7_000);
    expect(scheduler.afterPoll("nonempty", 8_000).state).toBe("active");
    scheduler.afterPoll("empty", 14_000);
    expect(scheduler.afterPoll("recovered", 15_000).state).toBe("active");
    scheduler.afterPoll("empty", 21_000);
    expect(scheduler.afterPoll("error", 22_000).state).toBe("active");
  });

  test("the first successful empty poll after a transport error reports recovery", () => {
    expect(successfulPollOutcome(0, true)).toBe("recovered");
    expect(successfulPollOutcome(0, false)).toBe("empty");
    expect(successfulPollOutcome(1, true)).toBe("nonempty");
  });

  test("phase spreading is deterministic and keeps active under 2s and idle under 11s", () => {
    expect(deterministicPollPhase("same-peer")).toBe(deterministicPollPhase("same-peer"));
    const phases = new Set(Array.from({ length: 50 }, (_, i) => deterministicPollPhase(`peer-${i}`)));
    expect(phases.size).toBeGreaterThan(40);
    for (const phase of phases) {
      expect(phaseSpreadDelay(1_000, 123_456, phase)).toBeLessThan(2_000);
      expect(phaseSpreadDelay(10_000, 123_456, phase)).toBeLessThan(11_000);
    }
    const idlePhases = new Set(Array.from({ length: 50 }, (_, i) => deterministicPollPhase(`peer-${i}`, 10_000)));
    expect(idlePhases.size).toBeGreaterThan(45);
    for (const phase of idlePhases) expect(cadencePhaseDelay(10_000, 123_456, phase)).toBeLessThanOrEqual(10_000);
    const heartbeatSeconds = new Set(Array.from({ length: 50 }, (_, i) => Math.floor(deterministicPollPhase(`peer-${i}`, 15_000) / 1_000)));
    expect(heartbeatSeconds.size).toBeGreaterThan(10);
  });
});
