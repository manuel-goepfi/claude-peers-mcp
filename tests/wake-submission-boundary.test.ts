import { expect, test } from "bun:test";
import { submitPaneText } from "../bin/codex-autodrain-poller.ts";

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
      writes.push("Enter");
      return { ok: true, out: "" };
    },
    enterText: () => { writes.push("paste"); return true; },
    sleep: () => {},
  })).toBe(true);
  expect(writes).toEqual(["paste", "Enter"]);
});
