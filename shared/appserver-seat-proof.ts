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
): SeatProofVerdict {
  if (proof.thread_id !== requestThreadId) return { ok: false, reason: "thread mismatch" };
  if (proof.client_type !== "codex") return { ok: false, reason: "not a Codex seat" };
  if (!proof.tmux_pane_id) return { ok: false, reason: "pane missing" };
  if (!proof.seat_key) return { ok: false, reason: "durable seat missing" };
  if (proof.seat_key !== durableSeatKey(proof)) return { ok: false, reason: "durable seat mismatch" };
  return { ok: true };
}
