/**
 * Operator-facing lane names.
 *
 * Measured 2026-07-31: SIXTEEN live lanes were all named `C5_lanes.1`,
 * distinguishable only by a #suffix bolted on afterwards — so the orchestrator
 * quoted opaque ids at the operator instead of names, and the operator could not
 * tell which lane a message referred to.
 *
 * Two causes, both here:
 *   1. `tmux list-panes -t <session>` returns only the ACTIVE WINDOW's panes (1 on
 *      the live session; 27 with -s). Every lane was told no labels were taken.
 *   2. Even unique, `<session>.<n>` is an ordinal the operator must map back to a
 *      task. Their window names already say REVIEW-1996, MECH-DRAIN, TERRA-ISSUES.
 */

import { describe, expect, test } from "bun:test";
import {
  chooseOperatorLabel,
  isHumanOperatorLabel,
  isOperatorChosenWindowName,
  preservedTmuxOperatorLabel,
} from "../server.ts";

describe("isOperatorChosenWindowName", () => {
  test("accepts labels the operator clearly chose", () => {
    for (const name of ["REVIEW-1996", "MECH-DRAIN", "TERRA-ISSUES", "wall", "story-678"]) {
      expect(isOperatorChosenWindowName(name, "C5_lanes")).toBe(true);
    }
  });

  test("rejects names a shell or tool sets on its own", () => {
    // Without this, every lane in the fleet would be called "claude".
    for (const name of ["bash", "zsh", "claude", "codex", "cursor", "node", "npm", "vim", "git"]) {
      expect(isOperatorChosenWindowName(name, "C5_lanes")).toBe(false);
    }
  });

  test("rejects numerics, blanks, and the session's own name", () => {
    expect(isOperatorChosenWindowName("3", "C5_lanes")).toBe(false);
    expect(isOperatorChosenWindowName("", "C5_lanes")).toBe(false);
    expect(isOperatorChosenWindowName(undefined, "C5_lanes")).toBe(false);
    expect(isOperatorChosenWindowName("C5_lanes", "C5_lanes")).toBe(false);
    expect(isOperatorChosenWindowName("c5_lanes", "C5_lanes")).toBe(false);  // case-insensitive
  });
});

describe("chooseOperatorLabel", () => {
  test("prefers the operator's window name over an ordinal", () => {
    expect(chooseOperatorLabel("C5_lanes", "1", [], "REVIEW-1996")).toBe("REVIEW-1996");
  });

  test("falls back to the ordinal when the window name is generic", () => {
    expect(chooseOperatorLabel("C5_lanes", "1", [], "claude")).toBe("C5_lanes.1");
    expect(chooseOperatorLabel("C5_lanes", "1", [], undefined)).toBe("C5_lanes.1");
  });

  test("never hands out a window name another lane already holds", () => {
    expect(chooseOperatorLabel("C5_lanes", "1", ["REVIEW-1996"], "REVIEW-1996")).toBe("C5_lanes.1");
  });

  test("walks ordinals when both the window name and low ordinals are taken", () => {
    const used = ["REVIEW-1996", "C5_lanes.1", "C5_lanes.2"];
    expect(chooseOperatorLabel("C5_lanes", "1", used, "REVIEW-1996")).toBe("C5_lanes.3");
  });

  test("allocates after the highest live ordinal instead of reusing a closed-pane gap", () => {
    expect(chooseOperatorLabel("traffic", "1", ["traffic.2", "traffic.5"], "bash")).toBe("traffic.6");
  });

  test("pane index changes never rename the next seat", () => {
    const used = ["traffic.2", "traffic.5"];
    expect(chooseOperatorLabel("traffic", "1", used, "bash")).toBe("traffic.6");
    expect(chooseOperatorLabel("traffic", "9", used, "bash")).toBe("traffic.6");
  });

  test("ignores unsafe numeric suffixes instead of emitting an imprecise ordinal", () => {
    expect(chooseOperatorLabel("traffic", "1", ["traffic.9007199254740992"], "bash")).toBe("traffic.1");
  });

  test("the collision that actually happened: seeing siblings prevents it", () => {
    // Each lane is pane_index 1 in its own window. Blind to siblings (the pre--s
    // behaviour) they all chose C5_lanes.1; seeing them, they separate.
    expect(chooseOperatorLabel("C5_lanes", "1", [], "claude")).toBe("C5_lanes.1");
    expect(chooseOperatorLabel("C5_lanes", "1", ["C5_lanes.1"], "claude")).toBe("C5_lanes.2");
    expect(chooseOperatorLabel("C5_lanes", "1", ["C5_lanes.1", "C5_lanes.2"], "claude")).toBe("C5_lanes.3");
  });
});

describe("preservedTmuxOperatorLabel", () => {
  test("keeps every non-empty pane-scoped operator label verbatim", () => {
    expect(preservedTmuxOperatorLabel("traffic.1.3", "traffic.9", "traffic")).toBe("traffic.1.3");
    expect(preservedTmuxOperatorLabel("human.pr", null, "traffic")).toBe("human.pr");
  });

  test("promotes only a recognized legacy peer label", () => {
    expect(preservedTmuxOperatorLabel(null, "traffic.2#4", "traffic")).toBe("traffic.2");
    expect(preservedTmuxOperatorLabel(null, "traffic.%24", "traffic")).toBeNull();
  });
});

describe("isHumanOperatorLabel", () => {
  test("accepts the ordinal form", () => {
    expect(isHumanOperatorLabel("C5_lanes.1", "C5_lanes")).toBe(true);
    expect(isHumanOperatorLabel("C5_lanes.1#REVIEW-1996", "C5_lanes")).toBe(true);
  });

  test("accepts an operator-chosen label, so it is not re-derived away", () => {
    // The load-bearing arm: without it a window-named lane fails the check, gets
    // treated as garbage and reset to an ordinal on the next registration — and it
    // would not count as "used", so a sibling could claim the same name.
    expect(isHumanOperatorLabel("REVIEW-1996", "C5_lanes")).toBe(true);
    expect(isHumanOperatorLabel("peers", "infra")).toBe(true);
  });

  test("still rejects junk", () => {
    expect(isHumanOperatorLabel(null, "C5_lanes")).toBe(false);
    expect(isHumanOperatorLabel("", "C5_lanes")).toBe(false);
    expect(isHumanOperatorLabel("claude", "C5_lanes")).toBe(false);
  });
});

describe("pane-id names are metadata, not operator choices", () => {
  test("a pane-id-derived label is never treated as chosen", () => {
    // infra.%24 is the machine's last-resort label. Accepting it would preserve it
    // as a name AND let it block the ordinal it was standing in for.
    expect(isOperatorChosenWindowName("infra.%24", "infra")).toBe(false);
    expect(isHumanOperatorLabel("infra.%24", "infra")).toBe(false);
    expect(isOperatorChosenWindowName("%1442", "C5_lanes")).toBe(false);
  });

  test("another session's ordinal label is not a choice for this one", () => {
    expect(isHumanOperatorLabel("marketing.2", "infra")).toBe(false);
    expect(isOperatorChosenWindowName("marketing.2", "infra")).toBe(false);
    // ...but a hyphenated operator name is unaffected.
    expect(isOperatorChosenWindowName("story-678", "infra")).toBe(true);
    expect(isOperatorChosenWindowName("REVIEW-1996", "C5_lanes")).toBe(true);
  });
});
