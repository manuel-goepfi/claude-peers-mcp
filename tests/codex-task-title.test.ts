import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskFileTitle, taskAwareTitle, accountTitleUpdate } from "../bin/codex-appserver-relay.ts";

test("TASK.md names replace bootstrap titles without overwriting descriptive names", () => {
  const cwd = mkdtempSync(join(tmpdir(), "task-title-"));
  try {
    expect(taskAwareTitle("Read TASK.md", cwd)).toBe("Read TASK.md");
    writeFileSync(join(cwd, "TASK.md"), "# Lane: wps-intake-20260908 (Codex account C, high effort)\n\nDo work.");
    expect(taskFileTitle(cwd)).toBe("Wps intake");
    expect(taskAwareTitle("4Read TASK.md in this worktree", cwd)).toBe("Wps intake");
    const msg = { method: "thread/name/updated", params: { threadId: "root", threadName: "[C] Read TASK.md and execute" } };
    expect(accountTitleUpdate(msg, "root", "C", cwd)).toEqual({threadId: "root", name: "[C] Wps intake"});
    expect(accountTitleUpdate(msg, "other", "C", cwd)).toBeNull();
    expect(taskAwareTitle("My chosen title", cwd)).toBe("My chosen title");
    expect(accountTitleUpdate({...msg, params: {...msg.params, threadName: "[C] Wps intake"}}, "root", "C", cwd)).toBeNull();
    writeFileSync(join(cwd, "TASK.md"), "# Task: Add missing WPS intake facts\n");
    expect(taskFileTitle(cwd)).toBe("Add missing WPS intake facts");
    writeFileSync(join(cwd, "TASK.md"), "# TASK\nNo descriptive heading");
    expect(taskFileTitle(cwd)).toBeUndefined();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
