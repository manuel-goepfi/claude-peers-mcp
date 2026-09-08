import { expect, test } from "bun:test";
import { runtimePaneRow, withRuntimePaneSnapshot } from "../shared/runtime-pane-snapshot.ts";

test("one request shares pane reads but the next sees a changed owner", async () => {
  let reads = 0;
  let owner = "100";
  const read = () => { reads++; return `1\t${owner}\t%1\t$1\twork\n1\t200\t%2\t$1\twork`; };
  await withRuntimePaneSnapshot(async () => {
    expect(runtimePaneRow("socket", "%1", read)).toContain("100");
    await Promise.resolve();
    expect(runtimePaneRow("socket", "%2", read)).toContain("200");
    expect(runtimePaneRow("socket", "%1", read)).toContain("100");
    expect(reads).toBe(1);
  });
  owner = "300";
  withRuntimePaneSnapshot(() => expect(runtimePaneRow("socket", "%1", read)).toContain("300"));
  expect(reads).toBe(2);
});

test("missing proof stays refused within a request and can recover on the next", () => {
  let reads = 0;
  const read = () => { reads++; return reads === 1 ? null : "1\t100\t%1\t$1\twork"; };
  withRuntimePaneSnapshot(() => {
    expect(runtimePaneRow("socket", "%1", read)).toBeNull();
    expect(runtimePaneRow("socket", "%1", read)).toBeNull();
    expect(reads).toBe(1);
  });
  withRuntimePaneSnapshot(() => expect(runtimePaneRow("socket", "%1", read)).not.toBeNull());
});
