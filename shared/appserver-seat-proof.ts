import { durableSeatKey } from "./seat.ts";
import type { ThreadIdentityProofResponse } from "./types.ts";

export type SeatProofVerdict = { ok: true } | { ok: false; reason: string };

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
  if (boundThreadId && boundThreadId !== requestThreadId) {
    return { ok: false, reason: "connection is already bound to a different Codex thread" };
  }
  if (proof.thread_id !== requestThreadId) return { ok: false, reason: "thread mismatch" };
  if (proof.client_type !== "codex") return { ok: false, reason: "not a Codex seat" };
  if (!proof.tmux_pane_id) return { ok: false, reason: "pane missing" };
  if (!proof.seat_key) return { ok: false, reason: "durable seat missing" };
  if (proof.seat_key !== durableSeatKey(proof)) return { ok: false, reason: "durable seat mismatch" };
  return { ok: true };
}
