import { describe, expect, test } from "bun:test";
import { operatorTypedRecently, submitPaneText } from "../bin/codex-autodrain-poller.ts";

for (const [name, capture] of [
  ["failed final capture", { ok: false, out: "" }],
  ["operator input arrived after idle check", { ok: true, out: "› deploy production" }],
  ["work started after idle check", { ok: true, out: "Working (esc to interrupt)\n› " }],
] as const) {
  test(`submission refuses ${name}`, () => {
    const writes: string[] = [];
    expect(submitPaneText("%1", "[peer-mail] Process the attached peer messages.", "codex", {
      command: (args) => {
        if (args.includes("capture-pane")) return capture;
        writes.push(args.join(" "));
        return { ok: true, out: "" };
      },
      enterText: () => { writes.push("paste"); return true; },
      sleep: () => {},
    })).toBe(false);
    expect(writes).toEqual([]);
  });
}

test("a verified idle pane still receives one wake and Enter", () => {
  const writes: string[] = [];
  let captures = 0;
  const text = "[peer-mail] Process the attached peer messages.";
  expect(submitPaneText("%1", text, "codex", {
    command: (args) => {
      if (args.includes("capture-pane")) {
        return { ok: true, out: captures++ === 0 ? "› " : `› ${text}\n\nWorking (esc to interrupt)\n› ` };
      }
      if (args.includes("list-clients")) return { ok: true, out: "1000\t%1\n" };   // last key 1000 s before now
      writes.push("Enter");
      return { ok: true, out: "" };
    },
    enterText: () => { writes.push("paste"); return true; },
    sleep: () => {},
    nowSec: () => 2000,
  })).toBe(true);
  expect(writes).toEqual(["paste", "Enter"]);
});

// Live 2026-10-11 (C5 Orch.296, pane %22377): a wake landed while the operator
// was typing and split their input ("y" ... "ou") around the injected prompt.
// The idle capture alone cannot see keys pressed after it is taken.
describe("an operator typing in the pane is never typed over", () => {
  const text = "[peer-mail] Process the attached peer messages.";
  function run(listClients: (call: number) => { ok: boolean; out: string }) {
    const writes: string[] = [];
    let calls = 0;
    const result = submitPaneText("%1", text, "claude", {
      command: (args) => {
        if (args.includes("capture-pane")) return { ok: true, out: writes.includes("Enter") ? `❯ ${text}\n\n✻ Working\n❯ ` : "❯ " };
        if (args.includes("list-clients")) return listClients(calls++);
        writes.push("Enter");
        return { ok: true, out: "" };
      },
      enterText: () => { writes.push("paste"); return true; },
      sleep: () => {},
      nowSec: () => 5000,
    });
    return { result, writes };
  }

  test("a key pressed in the last few seconds defers the wake: nothing is typed", () => {
    expect(run(() => ({ ok: true, out: "4997\t%1\n" }))).toEqual({ result: false, writes: [] });
  });

  test("keys pressed while the wake was entered withhold Enter: nothing is submitted", () => {
    const outcome = run((call) => ({ ok: true, out: call === 0 ? "4000\t%1\n" : "4999.5\t%1\n" }));
    expect(outcome).toEqual({ result: false, writes: ["paste"] });
  });

  test("tmux unable to list clients fails closed: nothing is typed", () => {
    expect(run(() => ({ ok: false, out: "" }))).toEqual({ result: false, writes: [] });
  });

  test("a client typing in another pane, or no client at all, does not block the wake", () => {
    expect(run(() => ({ ok: true, out: "4999\t%7\n" })).writes).toEqual(["paste", "Enter"]);
    expect(run(() => ({ ok: true, out: "" })).writes).toEqual(["paste", "Enter"]);
  });

  test("operatorTypedRecently reads activity per pane and treats an unreadable time as active", () => {
    expect(operatorTypedRecently("4995\t%1", "%1", 5000, 10)).toBe(true);
    expect(operatorTypedRecently("4989\t%1", "%1", 5000, 10)).toBe(false);
    expect(operatorTypedRecently("4999\t%2\n4000\t%1", "%1", 5000, 10)).toBe(false);
    expect(operatorTypedRecently("4000\t%1\n4999\t%1", "%1", 5000, 10)).toBe(true);   // any viewing client counts
    expect(operatorTypedRecently("\t%1", "%1", 5000, 10)).toBe(true);
    expect(operatorTypedRecently("", "%1", 5000, 10)).toBe(false);
  });
});
