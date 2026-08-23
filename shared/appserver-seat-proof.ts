import { durableSeatKey } from "./seat.ts";
import type { ThreadIdentityProofResponse } from "./types.ts";

export type SeatProofVerdict = { ok: true } | { ok: false; reason: string };

export type SeatProofWaitResult =
  | { ok: true; proof: ThreadIdentityProofResponse }
  | { ok: false; reason: string };

export interface SeatProofWaitOptions {
  attempts?: number;
  delayMs?: number;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  boundThreadId?: () => string | null;
}

/**
 * Verify the exact identity join Codex provides:
 *
 * - every hook input carries the owning ThreadId as `session_id`;
 * - every MCP tool request carries that same value as `_meta.threadId`;
 * - the broker row supplies the pane/TTY identity already established by the
 *   hook, with no process-tree, cwd-uniqueness, or launch-time inference.
 */
export function verifyCodexAppServerSeatProof(
  requestThreadId: string,
  proof: ThreadIdentityProofResponse,
  boundThreadId: string | null = null,
): SeatProofVerdict {
  // Re-check after the broker await. Two tool calls can enter while the
  // connection is still unbound; one may bind it before the other's proof
  // returns. The post-await check prevents that second request from switching
  // this process-global sender/mailbox identity.
  if (boundThreadId && boundThreadId.toLowerCase() !== requestThreadId.toLowerCase()) {
    return { ok: false, reason: "connection is already bound to a different Codex thread" };
  }
  if (proof.thread_id.toLowerCase() !== requestThreadId.toLowerCase()) return { ok: false, reason: "thread mismatch" };
  if (proof.client_type !== "codex") return { ok: false, reason: "not a Codex seat" };
  if (!proof.tmux_pane_id) return { ok: false, reason: "pane missing" };
  if (!proof.seat_key) return { ok: false, reason: "durable seat missing" };
  if (proof.seat_key !== durableSeatKey(proof)) return { ok: false, reason: "durable seat mismatch" };
  return { ok: true };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Only transient states created while the relay folds a root row are retried. */
export function retryableCodexSeatProofReason(reason: string): boolean {
  return reason === "pane missing" || reason === "identity proof request timed out" ||
    /Broker error \(\/identity-by-thread\): 404\b/.test(reason) ||
    /Broker error \(\/identity-by-thread\): 409\b.*ambiguous live thread identity/.test(reason);
}

/**
 * Wait for the relay publication that races the first MCP tool request. The
 * window is intentionally bounded: a missing adapter or wrong identity still
 * fails loudly instead of turning into an unbounded tool stall.
 */
export async function waitForCodexAppServerSeatProof(
  requestThreadId: string,
  fetchProof: (signal: AbortSignal) => Promise<ThreadIdentityProofResponse>,
  options: SeatProofWaitOptions = {},
): Promise<SeatProofWaitResult> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 30));
  const delayMs = Math.max(0, Math.floor(options.delayMs ?? 100));
  const requestTimeoutMs = Math.max(1, Math.floor(options.requestTimeoutMs ?? 1_000));
  const totalTimeoutMs = Math.max(1, Math.floor(options.totalTimeoutMs ?? 3_000));
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const boundThreadId = options.boundThreadId ?? (() => null);
  const deadline = Date.now() + totalTimeoutMs;
  let lastReason = "identity proof unavailable";

  for (let attempt = 0; attempt < attempts; attempt++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    try {
      const proof = await fetchProof(AbortSignal.timeout(Math.min(requestTimeoutMs, remainingMs)));
      const verdict = verifyCodexAppServerSeatProof(requestThreadId, proof, boundThreadId());
      if (verdict.ok) return { ok: true, proof };
      lastReason = verdict.reason;
    } catch (error) {
      lastReason = error instanceof DOMException && error.name === "TimeoutError"
        ? "identity proof request timed out"
        : errorMessage(error);
    }
    if (!retryableCodexSeatProofReason(lastReason) || attempt === attempts - 1) break;
    const remainingAfterAttempt = deadline - Date.now();
    if (remainingAfterAttempt <= 0) break;
    if (delayMs > 0) await sleep(Math.min(delayMs, remainingAfterAttempt));
  }
  return { ok: false, reason: lastReason };
}
