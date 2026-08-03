import { describe, expect, test } from "bun:test";
import { verifyCodexAppServerSeatProof } from "../shared/appserver-seat-proof.ts";
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
});
