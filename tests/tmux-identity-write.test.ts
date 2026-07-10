import { describe, expect, test } from "bun:test";
import { TmuxIdentityWriteTracker, tmuxIdentityWriteKey } from "../shared/tmux-identity.ts";

const identity = { id: "peer-1", name: "lane.1", resolved_name: "lane.1", client_type: "claude" as const, receiver_mode: "claude-channel" as const };

describe("unchanged tmux identity write suppression", () => {
  test("successful unchanged identity is not republished", () => {
    const tracker = new TmuxIdentityWriteTracker();
    const key = tmuxIdentityWriteKey(identity, "%1");
    expect(tracker.shouldWrite(key, 0)).toBe(true);
    tracker.record(key, { ok: true, target: "%1", failedOptions: [] }, 0);
    expect(tracker.shouldWrite(key, 1_000_000)).toBe(false);
    expect(tracker.skippedResult("%1")).toEqual({ ok: true, target: "%1", failedOptions: [], skipped: true });
  });

  test("identity or pane changes force a write", () => {
    const tracker = new TmuxIdentityWriteTracker();
    const key = tmuxIdentityWriteKey(identity, "%1");
    tracker.record(key, { ok: true, target: "%1", failedOptions: [] }, 0);
    expect(tracker.shouldWrite(tmuxIdentityWriteKey({ ...identity, receiver_mode: "manual-drain" }, "%1"), 1)).toBe(true);
    expect(tracker.shouldWrite(tmuxIdentityWriteKey(identity, "%2"), 1)).toBe(true);
  });

  test("failed writes receive exactly three bounded retries", () => {
    const tracker = new TmuxIdentityWriteTracker();
    const key = tmuxIdentityWriteKey(identity, "%1");
    tracker.record(key, { ok: false, target: "%1", failedOptions: ["@peer_id"] }, 0);
    expect(tracker.shouldWrite(key, 14_999)).toBe(false);
    expect(tracker.shouldWrite(key, 15_000)).toBe(true);
    tracker.record(key, { ok: false, target: "%1", failedOptions: ["@peer_id"] }, 15_000);
    expect(tracker.shouldWrite(key, 44_999)).toBe(false);
    expect(tracker.shouldWrite(key, 45_000)).toBe(true);
    tracker.record(key, { ok: false, target: "%1", failedOptions: ["@peer_id"] }, 45_000);
    expect(tracker.shouldWrite(key, 104_999)).toBe(false);
    expect(tracker.shouldWrite(key, 105_000)).toBe(true);
    tracker.record(key, { ok: false, target: "%1", failedOptions: ["@peer_id"] }, 105_000);
    expect(tracker.shouldWrite(key, 1_000_000)).toBe(false);
  });
});
