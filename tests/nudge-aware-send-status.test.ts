/**
 * A sender must not be told that a nudge-driven lane needs rescuing.
 *
 * `receiver_mode: "manual-drain"` names the API the lane calls (check_messages),
 * NOT who calls it — the autodrain poller does the calling. Measured 2026-07-31:
 * a codex lane on manual-drain completed a full round trip in 56 seconds that way;
 * agy and cursor drained the same way.
 *
 * But the reassurance must rest on EVIDENCE, not on a pane. parseNudgeClients
 * defaults to [] ("nudge nobody"), and the poller can be stopped, scoped to other
 * clients, or have given up on a lane after MAX_NUDGE_ATTEMPTS — none of which the
 * server can see. So a prior successful drain is what licenses the promise; a pane
 * alone licenses only "probably".
 *
 * The old wording said the opposite — "has no active hook yet and must use
 * check_messages" — and never mentioned the poller at all. The cost was not
 * cosmetic: lanes reading it concluded that manual-drain peers do not receive,
 * and senders read queued mail as stranded when it was in fact seconds away.
 * The word "manual" was doing damage the mechanism never did.
 */

import { describe, expect, test } from "bun:test";
import { manualDrainRoutingHint, sendStatusHint } from "../server.ts";
import type { SendMessageResponse } from "../shared/types.ts";

type Target = NonNullable<SendMessageResponse["target"]>;

function target(over: Partial<Target>): Target {
  return {
    id: "abc123", name: "lane.1", resolved_name: "lane.1", seat_key: "pane:s:%1",
    cwd: "/w", git_root: "/w", tmux_session: "s", tmux_window_index: "0",
    tmux_window_name: "w", tmux_pane_id: "%1",
    client_type: "codex", receiver_mode: "manual-drain",
    last_hook_seen_at: null, last_drain_at: null, last_drain_error: null, last_seen: null,
    ...over,
  } as Target;
}

describe("send status hint for nudge-driven lanes", () => {
  test("a pane-backed Codex manual-drain seat is described as automatic, not a human chore", () => {
    const hint = manualDrainRoutingHint(target({}));
    expect(hint).toContain("automatic Codex pane-autodrain");
    expect(hint).toContain("no human manual drain");
    expect(hint).not.toContain("fallback=check_messages");
  });

  test("a seatless manual-drain target remains honestly unreachable", () => {
    const hint = manualDrainRoutingHint(target({ tmux_pane_id: null }));
    expect(hint).toContain("no pane");
    expect(hint).toContain("check_messages");
  });

  test("a lane that HAS drained before is reported as an automatic path", () => {
    // Evidence, not assumption: a prior drain proves a working path exists.
    const hint = sendStatusHint(target({ last_drain_at: "2026-08-01T08:00:00Z" }), false);
    expect(hint).toContain("has drained before");
    expect(hint).toContain("bounded attempt budget");
    expect(hint).toContain("check_messages if this handoff is urgent");
    // The specific phrasings that taught senders the mail was stranded.
    expect(hint).not.toContain("must use check_messages");
    expect(hint).not.toContain("no active hook");
  });

  test("every nudgeable client type gets the automatic wording, not just codex", () => {
    // cursor / agy / kimi have no hook API at all, so manual-drain is their ONLY
    // mode. If the wording implied breakage they would look permanently broken.
    for (const client_type of ["codex", "cursor", "agy", "kimi"] as const) {
      const hint = sendStatusHint(target({ client_type, last_drain_at: "2026-08-01T08:00:00Z" }), false);
      expect(hint).toContain("has drained before");
      expect(hint).not.toContain("must use check_messages");
      expect(hint).toContain("if this handoff is urgent");
    }
  });

  test("a seat with NO pane is still reported as unreachable — the warning must stay real", () => {
    // The fix must not flip into blanket reassurance. With no pane there is
    // genuinely nothing to nudge, and a sender needs to know that.
    const hint = sendStatusHint(target({ tmux_pane_id: null }), false);
    expect(hint).toContain("nothing can nudge it");
    expect(hint).not.toContain("no action required");
  });

  test("an unknown client with a pane is NOT claimed to be nudgeable", () => {
    // The poller has no idle profile for an unknown client, so it never types
    // into that pane. Claiming otherwise is the silent-success this field exists
    // to prevent.
    const hint = sendStatusHint(target({ client_type: "unknown", receiver_mode: "unknown" }), false);
    expect(hint).not.toContain("no action required");
    expect(hint).toContain("check_messages");
  });

  test("a pane-backed lane that has NEVER drained is not promised delivery", () => {
    // parseNudgeClients defaults to [] — nudge nobody. A pane proves the poller
    // COULD reach the lane, never that it will, so this must stay conditional.
    const hint = sendStatusHint(target({ last_drain_at: null }), false);
    expect(hint).toContain("never drained on record");
    expect(hint).toContain("check_messages");
    expect(hint).not.toContain("without action from you");
  });

  test("a delivered message produces no hint at all", () => {
    expect(sendStatusHint(target({}), true)).toBe("");
  });

  test("hook-backed lanes keep their own wording", () => {
    // codex-hook drains on the lane's own prompt cycle; that message is accurate
    // and should not be replaced by the nudge wording.
    const hint = sendStatusHint(
      target({ receiver_mode: "codex-hook", last_hook_seen_at: new Date().toISOString() }),
      false,
    );
    expect(hint).toContain("hook-enabled");
  });

  test("a reported drain error still wins over the reassurance", () => {
    const hint = sendStatusHint(target({ last_drain_error: "boom" }), false);
    expect(hint).toContain("boom");
    expect(hint).not.toContain("no action required");
  });
});
