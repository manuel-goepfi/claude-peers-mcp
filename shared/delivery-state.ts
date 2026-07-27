export const CLAIM_TTL_MS = 30_000;

export function claimCutoffIso(nowMs = Date.now()): string {
  return new Date(nowMs - CLAIM_TTL_MS).toISOString();
}

/**
 * How long a recipient may sit on queued mail before the sender is told.
 *
 * Not an error threshold — a working seat drains on its next prompt, which for
 * a busy lane is seconds and for an idle one can legitimately be minutes. This
 * is the point past which "queued" stops being useful information to a sender
 * who is waiting on a reply.
 */
export const UNDRAINED_WARN_MS = 10 * 60_000;

export type RecipientDrainState =
  /** Draining normally, or the queue is too young to judge. */
  | "healthy"
  /** Has a drain path but has not used it while mail waits. */
  | "undrained"
  /** Nothing will nudge this seat; it delivers only if it asks. */
  | "no_drain_path";

export interface RecipientDeliveryHealth {
  state: RecipientDrainState;
  /** Undelivered messages queued for this recipient, including the new one. */
  pending: number;
  /** Age of the oldest queued message, or null when nothing is queued. */
  oldest_pending_ms: number | null;
  last_drain_at: string | null;
  /** Whether anything (poller nudge or client hook) can prompt a drain. */
  nudgeable: boolean;
  /** Human-readable sender warning; null when there is nothing to say. */
  warning: string | null;
}

export interface RecipientDrainFacts {
  pending: number;
  oldestPendingMs: number | null;
  lastDrainAt: string | null;
  /** Seat has a tmux pane the autodrain poller can send keys to. */
  hasPane: boolean;
  /** Client drains itself via a prompt hook rather than needing a nudge. */
  hookDriven: boolean;
  undrainedWarnMs?: number;
}

function humanizeMs(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h${remainder}m`;
}

/**
 * Turn a recipient's queue and drain history into something a sender can act on.
 *
 * A send that returns nothing but "queued" is indistinguishable from a send
 * that will never be read: over one night this fleet piled finished handoffs on
 * an idle seat, and every sender saw success. The queue state is knowable at
 * send time — so say it.
 */
export function recipientDeliveryHealth(facts: RecipientDrainFacts): RecipientDeliveryHealth {
  const warnMs = facts.undrainedWarnMs ?? UNDRAINED_WARN_MS;
  const nudgeable = facts.hasPane || facts.hookDriven;
  const base = {
    pending: facts.pending,
    oldest_pending_ms: facts.oldestPendingMs,
    last_drain_at: facts.lastDrainAt,
    nudgeable,
  };

  if (!nudgeable) {
    return {
      ...base,
      state: "no_drain_path",
      warning:
        `Recipient has no automatic drain path (no tmux pane, manual drain): ${facts.pending} message(s) queued. ` +
        "It will see them only when it calls check_messages itself.",
    };
  }

  if (facts.oldestPendingMs !== null && facts.oldestPendingMs > warnMs) {
    const drained = facts.lastDrainAt ? `last drained ${facts.lastDrainAt}` : "has never drained";
    return {
      ...base,
      state: "undrained",
      warning:
        `Recipient has not drained for ${humanizeMs(facts.oldestPendingMs)} (${drained}): ` +
        `${facts.pending} message(s) queued. Treat this as undelivered, not received.`,
    };
  }

  return { ...base, state: "healthy", warning: null };
}
