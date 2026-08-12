/**
 * A nudge budget belongs to one unread episode.
 *
 * Incoming mail must not replenish a lane that already exhausted its budget:
 * repeated senders can otherwise turn a bounded wake mechanism into an
 * unbounded stream of real user turns. The budget resets only after the inbox
 * reaches zero and the broker records a later refill as a new episode.
 */

import { describe, expect, test } from "bun:test";
import {
  nudgeAttemptCountAfterUnread,
  unreadEpisodeRestartedBetweenTicks,
} from "../bin/codex-autodrain-poller.ts";

const MAX = 5;

describe("nudge budget is bounded for one unread episode", () => {
  test("a rising unread count does not replenish an exhausted budget", () => {
    let attempts: number | undefined = MAX + 1;
    for (const unread of [5, 6, 7]) {
      attempts = nudgeAttemptCountAfterUnread(attempts, unread);
    }
    expect(attempts).toBe(MAX + 1);
  });

  test("a partial drain does not replenish the budget", () => {
    expect(nudgeAttemptCountAfterUnread(MAX + 1, 2)).toBe(MAX + 1);
  });

  test("reaching zero starts a fresh future episode", () => {
    expect(nudgeAttemptCountAfterUnread(3, 0)).toBeUndefined();
    expect(nudgeAttemptCountAfterUnread(MAX + 1, -1)).toBeUndefined();
  });

  test("a lane first observed with unread mail has no fabricated attempts", () => {
    expect(nudgeAttemptCountAfterUnread(undefined, 7)).toBeUndefined();
  });
});

describe("unread episode boundaries between ticks", () => {
  test("a broker-authored episode advance starts a new budget", () => {
    expect(unreadEpisodeRestartedBetweenTicks(7, 8)).toBe(true);
  });

  test("overlapping mail and partial drains keep the same episode", () => {
    expect(unreadEpisodeRestartedBetweenTicks(7, 7)).toBe(false);
  });
});
