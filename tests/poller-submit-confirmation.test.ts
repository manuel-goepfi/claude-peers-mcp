/**
 * ACK must mean the model SAW the mail, not that tmux accepted a keystroke.
 *
 * Live P1, 2026-08-03: the autodrain poller delivered a 3-message batch into
 * infra.7's pane and immediately acked it. `submitPaneText()` returned the exit
 * code of `tmux send-keys ... C-m`, which only proves tmux handed the keystroke
 * to the pane — not that the TUI consumed it as a submit. The text sat unsent in
 * the composer until the operator pressed Enter roughly a minute later, by which
 * point messages 14677/14688/14691 were already stamped
 * delivered_at 10:01:39.143 and gone from the queue.
 *
 * That is silent LOSS rather than delay: an acked message is never retried, so
 * had the operator cleared the composer instead of submitting it, three messages
 * would have vanished with no trace anywhere except a "delivered" row.
 *
 * The repair is to OBSERVE submission and, when it cannot be observed, leave the
 * batch unacked so the next tick retries. These tests pin the observation logic,
 * which is pure and needs no tmux; the discriminator it encodes is the subtle
 * part, so it is asserted from both directions.
 */

import { describe, expect, test } from "bun:test";
import { composerStillHolds, submissionProbe } from "../bin/codex-autodrain-poller.ts";

const PROMPT = "› ";

describe("submissionProbe picks a recognisable fragment", () => {
  test("collapses whitespace so a re-wrapped composer still matches", () => {
    expect(submissionProbe("peer   message\n\n  from infra.2")).toBe("peer message from infra.2");
  });

  test("is bounded — a whole batch is not used as the probe", () => {
    expect(submissionProbe("x".repeat(500)).length).toBeLessThanOrEqual(48);
  });

  test("empty text yields an empty probe", () => {
    expect(submissionProbe("   \n  ")).toBe("");
  });
});

describe("composerStillHolds distinguishes UNSENT from SENT", () => {
  const probe = submissionProbe("[peer-mail] 3 pending peer message(s) from infra.2");

  test("text sitting in the composer reads as UNSENT", () => {
    // The live failure: typed, not submitted.
    const capture = ["some earlier output", "", `${PROMPT}[peer-mail] 3 pending peer message(s) from infra.2`].join("\n");
    expect(composerStillHolds(capture, probe)).toBe(true);
  });

  test("the SAME text in the transcript above an empty composer reads as SENT", () => {
    // The discriminator that matters. After submission the text is still on
    // screen — it moved up into the transcript. A naive "does the capture
    // contain it" check would call every successful submit a failure and the
    // poller would never ack anything.
    const capture = [
      "[peer-mail] 3 pending peer message(s) from infra.2",
      "• Working (2s)",
      `${PROMPT}Find and fix a bug in @filename`,
    ].join("\n");
    expect(composerStillHolds(capture, probe)).toBe(false);
  });

  test("wrapped composer text still counts as held", () => {
    const capture = [`${PROMPT}[peer-mail] 3 pending peer`, "message(s) from infra.2"].join("\n");
    expect(composerStillHolds(capture, probe)).toBe(true);
  });

  test("a capture with no visible composer never claims the text is held", () => {
    // Fail toward "submitted" here: with no prompt marker we have no evidence of
    // holding, and inventing one would block delivery on every unusual pane.
    expect(composerStillHolds("no prompt marker anywhere\njust output", probe)).toBe(false);
  });

  test("an empty probe never reports held", () => {
    expect(composerStillHolds(`${PROMPT}anything at all`, "")).toBe(false);
  });

  test("a different message in the composer does not match ours", () => {
    const capture = `${PROMPT}some unrelated thing the operator typed`;
    expect(composerStillHolds(capture, probe)).toBe(false);
  });

  test("the LAST prompt marker delimits the composer, not the first", () => {
    // Earlier turns leave their own prompt markers in the scrollback; using the
    // first would treat the whole transcript as composer and report everything
    // as unsent.
    const capture = [
      `${PROMPT}[peer-mail] 3 pending peer message(s) from infra.2`,
      "• Working (2s)",
      `${PROMPT}`,
    ].join("\n");
    expect(composerStillHolds(capture, probe)).toBe(false);
  });
});

describe("the shipped poller acks only on observed submission", () => {
  const source = require("node:fs").readFileSync(
    new URL("../bin/codex-autodrain-poller.ts", import.meta.url).pathname,
    "utf8",
  ) as string;

  test("submitPaneText no longer returns the C-m exit code directly", () => {
    // The exact regression: `return sh([... "C-m"]).ok` was the whole failure.
    expect(source).not.toMatch(/return sh\(\["tmux", "send-keys", "-t", paneId, "C-m"\]\)\.ok;/);
  });

  test("an unconfirmed submit is logged and left for retry", () => {
    expect(source).toContain("leaving batch unacked for retry");
  });

  test("a vanished pane is never treated as delivered", () => {
    expect(source).toContain("cannot claim delivery");
  });
});
