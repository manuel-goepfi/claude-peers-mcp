import { expect, test } from "bun:test";
import { freshSubmissionObserved } from "../bin/codex-autodrain-poller.ts";

const wake = "[peer-mail] Process attached peer messages first.";
const idle = "→ Add a follow-up";
const old = `${wake}\nEarlier response.\n${idle}`;

test("unchanged historical wake cannot confirm a new submission", () => {
  expect(freshSubmissionObserved(old, old, wake)).toBe(false);
});

test("unrelated output below an old wake is not a fresh submission", () => {
  expect(freshSubmissionObserved(old, `${wake}\nUpdated status.\n${idle}`, wake)).toBe(false);
});

test("a new transcript echo confirms submission with or without history", () => {
  expect(freshSubmissionObserved(idle, `${wake}\n${idle}`, wake)).toBe(true);
  expect(freshSubmissionObserved(old, `${wake}\nEarlier response.\n${wake}\n${idle}`, wake)).toBe(true);
});

test("held input must leave the composer and gain a fresh transcript echo", () => {
  const held = `${wake}\nEarlier response.\n→ ${wake}`;
  expect(freshSubmissionObserved(held, held, wake)).toBe(false);
  expect(freshSubmissionObserved(held, old, wake)).toBe(false);
  expect(freshSubmissionObserved(held, `${wake}\nEarlier response.\n${wake}\n${idle}`, wake)).toBe(true);
});

test("ANSI styling and visual wrapping do not create a new echo", () => {
  const styled = `\x1b[2m${wake}\x1b[0m\n${idle}`;
  const wrapped = `${wake.slice(0, 18)}\n${wake.slice(18)}\n${idle}`;
  expect(freshSubmissionObserved(styled, wrapped, wake)).toBe(false);
});
