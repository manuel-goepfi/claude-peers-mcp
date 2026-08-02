/**
 * Giving up on a lane must not be a one-way door.
 *
 * The poller stops nudging after MAX_NUDGE_ATTEMPTS so a lane with a broken drain
 * hook is not keystroke-bombed forever. That cap is right. What was wrong is how a
 * lane got OUT of it: the attempt counter reset only when the lane's queue reached
 * zero.
 *
 * For a manual-drain lane that is a deadlock, because the nudge is how its queue
 * reaches zero:
 *     no nudge -> no drain -> unread never hits 0 -> counter never resets -> no nudge
 *
 * Live instance 2026-08-01: "giving up on orch.1: 5 nudges, still 4 unread". The
 * lane went silent and the operator had to ask it to drain by hand — which is the
 * symptom that started this investigation.
 *
 * A RISING unread count is proof someone is still talking to that lane, and new
 * mail earns a fresh budget. A lane whose queue never grows stays given-up exactly
 * as before, so the keystroke-bomb protection is intact.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../bin/codex-autodrain-poller.ts", import.meta.url), "utf8");

/**
 * Model of the two reset rules, mirroring the tick loop's prune block. Kept as a
 * pure function so the deadlock is demonstrable without standing up a poller,
 * tmux, and a broker — the bug is in the state machine, not the plumbing.
 */
function runPrune(
  lanes: Array<{ id: string; unread: number }>,
  attempts: Map<string, number>,
  lastSeen: Map<string, number>,
  opts: { newMailResets: boolean },
): void {
  for (const lane of lanes) if (lane.unread <= 0) attempts.delete(lane.id);
  if (opts.newMailResets) {
    for (const lane of lanes) {
      const previous = lastSeen.get(lane.id);
      if (previous !== undefined && lane.unread > previous && attempts.has(lane.id)) {
        attempts.delete(lane.id);
      }
      lastSeen.set(lane.id, lane.unread);
    }
  }
}

const MAX = 5;
const givenUp = (a: Map<string, number>, id: string) => (a.get(id) ?? 0) >= MAX;

describe("a given-up lane recovers when new mail arrives", () => {
  test("WITHOUT the new-mail reset a manual-drain lane is permanently deaf", () => {
    // The regression this file exists for, stated as an executable fact.
    const attempts = new Map([["orch1", MAX + 1]]);   // already gave up, 4 unread
    const lastSeen = new Map([["orch1", 4]]);
    // more mail arrives, repeatedly — the lane still cannot drain it
    for (const unread of [5, 6, 7]) {
      runPrune([{ id: "orch1", unread }], attempts, lastSeen, { newMailResets: false });
      expect(givenUp(attempts, "orch1")).toBe(true);   // never recovers
    }
  });

  test("WITH the new-mail reset the same lane gets its budget back", () => {
    const attempts = new Map([["orch1", MAX + 1]]);
    const lastSeen = new Map([["orch1", 4]]);
    runPrune([{ id: "orch1", unread: 5 }], attempts, lastSeen, { newMailResets: true });
    expect(givenUp(attempts, "orch1")).toBe(false);
    expect(attempts.has("orch1")).toBe(false);
  });

  test("a stuck lane whose queue does NOT grow stays given up — no keystroke bombing", () => {
    // The protection the cap exists for must survive. A lane with a genuinely
    // broken hook sits at a constant unread count; nothing here rescues it.
    const attempts = new Map([["stuck", MAX + 1]]);
    const lastSeen = new Map([["stuck", 3]]);
    for (let tick = 0; tick < 10; tick++) {
      runPrune([{ id: "stuck", unread: 3 }], attempts, lastSeen, { newMailResets: true });
    }
    expect(givenUp(attempts, "stuck")).toBe(true);
  });

  test("a DROP in unread does not reset — that path is the zero-queue rule's job", () => {
    // Partial drains must not hand out fresh budget on every tick; only reaching
    // zero (handled by the pre-existing rule) or genuinely new mail should.
    const attempts = new Map([["partial", MAX + 1]]);
    const lastSeen = new Map([["partial", 9]]);
    runPrune([{ id: "partial", unread: 4 }], attempts, lastSeen, { newMailResets: true });
    expect(givenUp(attempts, "partial")).toBe(true);
  });

  test("a lane with no prior observation is not reset on first sight", () => {
    // First tick after a poller restart must not be read as "new mail".
    const attempts = new Map([["fresh", MAX + 1]]);
    const lastSeen = new Map<string, number>();
    runPrune([{ id: "fresh", unread: 7 }], attempts, lastSeen, { newMailResets: true });
    expect(givenUp(attempts, "fresh")).toBe(true);
    expect(lastSeen.get("fresh")).toBe(7);            // but it is now tracked
  });

  test("reaching zero still resets, and the tracker is pruned with the lane set", () => {
    const attempts = new Map([["done", 3]]);
    const lastSeen = new Map([["done", 2]]);
    runPrune([{ id: "done", unread: 0 }], attempts, lastSeen, { newMailResets: true });
    expect(attempts.has("done")).toBe(false);
    expect(source).toContain("lastUnreadSeen.delete(id)");   // pruned, not unbounded
  });
});

describe("the shipped poller implements this rule", () => {
  test("the tick loop resets the budget on a rising unread count", () => {
    expect(source).toContain("lane.unread > previous");
    expect(source).toContain("restoring nudge budget");
  });
});
