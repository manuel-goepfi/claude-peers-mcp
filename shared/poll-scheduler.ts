export type PollState = "active" | "backoff" | "idle";
export type PollOutcome = "empty" | "nonempty" | "error" | "recovered";

export interface PollTransition {
  from: PollState;
  to: PollState;
  reason: string;
  delay_ms: number;
  at_monotonic_ms: number;
}

export interface PollDecision {
  base_delay_ms: number;
  delay_ms: number;
  state: PollState;
  transition?: PollTransition;
}

export const POLL_BACKOFF_MS = [1_000, 1_000, 2_000, 4_000, 8_000, 10_000] as const;
export const POLL_ACTIVE_GRACE_MS = 5_000;
export const POLL_IDLE_AFTER_MS = 30_000;

function identityHash(identity: string): number {
  let hash = 2166136261;
  for (let i = 0; i < identity.length; i++) {
    hash ^= identity.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function deterministicPollPhase(identity: string, periodMs = 1_000): number {
  return identityHash(identity) % Math.max(1, Math.floor(periodMs));
}

export function cadencePhaseDelay(periodMs: number, nowMonotonicMs: number, phaseMs: number): number {
  const period = Math.max(1, Math.floor(periodMs));
  const normalizedPhase = ((Math.floor(phaseMs) % period) + period) % period;
  const currentPhase = ((Math.floor(nowMonotonicMs) % period) + period) % period;
  const delay = (normalizedPhase - currentPhase + period) % period;
  return delay === 0 ? period : delay;
}

export function phaseSpreadDelay(baseDelayMs: number, nowMonotonicMs: number, phaseMs: number): number {
  const normalizedPhase = ((Math.floor(phaseMs) % 1_000) + 1_000) % 1_000;
  const currentPhase = ((Math.floor(nowMonotonicMs) % 1_000) + 1_000) % 1_000;
  const adjustment = (normalizedPhase - currentPhase + 1_000) % 1_000;
  return Math.max(1, Math.floor(baseDelayMs)) + adjustment;
}

export class AdaptivePollScheduler {
  readonly phaseMs: number;
  readonly idlePhaseMs: number;
  private stateValue: PollState = "active";
  private delayIndex = 0;
  private activeUntil: number;
  private lastTrigger: number;
  private ceilingEmptyPolls = 0;

  constructor(identity: string, nowMonotonicMs: number) {
    this.phaseMs = deterministicPollPhase(identity);
    this.idlePhaseMs = deterministicPollPhase(identity, 10_000);
    this.lastTrigger = nowMonotonicMs;
    this.activeUntil = nowMonotonicMs + POLL_ACTIVE_GRACE_MS;
  }

  get state(): PollState {
    return this.stateValue;
  }

  private decision(previous: PollState, previousBaseDelay: number, reason: string, now: number): PollDecision {
    const baseDelay = POLL_BACKOFF_MS[this.delayIndex]!;
    const delay = baseDelay === 10_000
      ? cadencePhaseDelay(baseDelay, now, this.idlePhaseMs)
      : phaseSpreadDelay(baseDelay, now, this.phaseMs);
    const transition = previous !== this.stateValue || previousBaseDelay !== baseDelay
      ? { from: previous, to: this.stateValue, reason, delay_ms: delay, at_monotonic_ms: now }
      : undefined;
    return { base_delay_ms: baseDelay, delay_ms: delay, state: this.stateValue, ...(transition ? { transition } : {}) };
  }

  activity(reason: string, nowMonotonicMs: number): PollDecision {
    const previous = this.stateValue;
    const previousBaseDelay = POLL_BACKOFF_MS[this.delayIndex]!;
    this.stateValue = "active";
    this.delayIndex = 0;
    this.ceilingEmptyPolls = 0;
    this.lastTrigger = nowMonotonicMs;
    this.activeUntil = nowMonotonicMs + POLL_ACTIVE_GRACE_MS;
    return this.decision(previous, previousBaseDelay, reason, nowMonotonicMs);
  }

  afterPoll(outcome: PollOutcome, nowMonotonicMs: number): PollDecision {
    if (outcome === "nonempty" || outcome === "recovered") {
      return this.activity(outcome === "nonempty" ? "nonempty-poll" : "broker-recovery", nowMonotonicMs);
    }

    const previous = this.stateValue;
    const previousBaseDelay = POLL_BACKOFF_MS[this.delayIndex]!;
    if (outcome === "error") {
      this.stateValue = "active";
      this.delayIndex = 0;
      this.ceilingEmptyPolls = 0;
      return this.decision(previous, previousBaseDelay, "poll-error", nowMonotonicMs);
    }
    if (nowMonotonicMs < this.activeUntil) {
      this.stateValue = "active";
      this.delayIndex = 0;
      return this.decision(previous, previousBaseDelay, "active-grace", nowMonotonicMs);
    }

    if (this.delayIndex < POLL_BACKOFF_MS.length - 1) {
      this.delayIndex++;
      this.ceilingEmptyPolls = 0;
    } else {
      this.ceilingEmptyPolls++;
    }
    const idleReady = nowMonotonicMs - this.lastTrigger >= POLL_IDLE_AFTER_MS && this.delayIndex === POLL_BACKOFF_MS.length - 1 && this.ceilingEmptyPolls >= 2;
    this.stateValue = idleReady ? "idle" : "backoff";
    return this.decision(previous, previousBaseDelay, idleReady ? "idle-ceiling-confirmed" : "empty-poll", nowMonotonicMs);
  }
}
