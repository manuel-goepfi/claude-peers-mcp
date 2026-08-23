import { describe, expect, test } from "bun:test";
import {
  retryableCodexSeatProofReason,
  verifyCodexAppServerSeatProof,
  waitForCodexAppServerSeatProof,
} from "../shared/appserver-seat-proof.ts";
import type { ThreadIdentityProofResponse } from "../shared/types.ts";

const THREAD_ID = "019fc273-a35b-78f0-9a70-f63b5905540f";

function proof(overrides: Partial<ThreadIdentityProofResponse> = {}): ThreadIdentityProofResponse {
  return {
    id: "seat-1",
    pid: 200,
    cwd: "/repo",
    git_root: "/repo",
    absolute_git_dir: "/repo/.git",
    tty: "/dev/pts/4",
    name: "infra.7",
    resolved_name: "infra.7",
    tmux_session: "infra",
    tmux_window_index: "1",
    tmux_window_name: "peers",
    tmux_pane_id: "%2484",
    thread_id: THREAD_ID,
    seat_key: "pane:infra:%2484",
    client_type: "codex",
    receiver_mode: "codex-hook",
    ...overrides,
  };
}

describe("app-server Codex thread seat proof", () => {
  test("accepts the hook-owned durable pane for the request's exact thread", () => {
    expect(verifyCodexAppServerSeatProof(THREAD_ID, proof())).toEqual({ ok: true });
    expect(verifyCodexAppServerSeatProof(THREAD_ID.toUpperCase(), proof())).toEqual({ ok: true });
  });

  test("rejects a hook proof that disagrees on any authoritative axis", () => {
    expect(verifyCodexAppServerSeatProof("other-thread", proof())).toEqual({ ok: false, reason: "thread mismatch" });
    expect(verifyCodexAppServerSeatProof(THREAD_ID, proof({ client_type: "claude" }))).toEqual({ ok: false, reason: "not a Codex seat" });
    expect(verifyCodexAppServerSeatProof(THREAD_ID, proof({ tmux_pane_id: null, seat_key: "tty:/dev/pts/4" }))).toEqual({ ok: false, reason: "pane missing" });
    expect(verifyCodexAppServerSeatProof(THREAD_ID, proof({ seat_key: null }))).toEqual({ ok: false, reason: "durable seat missing" });
    expect(verifyCodexAppServerSeatProof(THREAD_ID, proof({ seat_key: "pane:infra:%9999" }))).toEqual({ ok: false, reason: "durable seat mismatch" });
  });

  test("rejects a second request that lost the race to another thread binding", () => {
    expect(verifyCodexAppServerSeatProof(THREAD_ID, proof(), "019fc273-other-thread")).toEqual({
      ok: false,
      reason: "connection is already bound to a different Codex thread",
    });
  });

  test("waits through thread-only and ambiguous fold states until the pane proof exists", async () => {
    const steps: Array<ThreadIdentityProofResponse | Error> = [
      proof({ tmux_pane_id: null, seat_key: null }),
      new Error('Broker error (/identity-by-thread): 409 {"error":"ambiguous live thread identity"}'),
      proof(),
    ];
    const sleeps: number[] = [];
    const result = await waitForCodexAppServerSeatProof(THREAD_ID, async () => {
      const step = steps.shift()!;
      if (step instanceof Error) throw step;
      return step;
    }, {
      attempts: 5,
      delayMs: 75,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    expect(result).toEqual({ ok: true, proof: proof() });
    expect(sleeps).toEqual([75, 75]);
  });

  test("does not retry a non-transient identity disagreement", async () => {
    let calls = 0;
    const result = await waitForCodexAppServerSeatProof(THREAD_ID, async () => {
      calls++;
      return proof({ client_type: "claude" });
    }, { attempts: 30, sleep: async () => { throw new Error("must not sleep"); } });

    expect(result).toEqual({ ok: false, reason: "not a Codex seat" });
    expect(calls).toBe(1);
    expect(retryableCodexSeatProofReason("pane missing")).toBe(true);
  });

  test("bounds and retries a broker request that never answers", async () => {
    let calls = 0;
    const result = await waitForCodexAppServerSeatProof(THREAD_ID, async (signal) => {
      calls++;
      return await new Promise<ThreadIdentityProofResponse>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }, {
      attempts: 2,
      delayMs: 0,
      requestTimeoutMs: 10,
    });

    expect(result).toEqual({ ok: false, reason: "identity proof request timed out" });
    expect(calls).toBe(2);
  });
});
