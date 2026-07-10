import { describe, expect, test } from "bun:test";
import { canonicalHooks, classifyClientHooks, installClientHooks } from "../shared/hook-config.ts";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

describe("canonical hook configuration", () => {
  test("moves a stale managed hook without changing an unrelated bucket matcher", () => {
    const document = {
      hooks: {
        SessionStart: [{ matcher: "other-event", hooks: [
          { type: "command", command: "bun unrelated.ts" },
          { name: "claude-peers-codex-register", type: "command", command: "bun /old/codex-register-peer-session.ts" },
        ] }],
      },
    };
    const installed = installClientHooks(document, "codex", repoRoot) as typeof document;
    expect(installed.hooks.SessionStart[0]!.matcher).toBe("other-event");
    expect(installed.hooks.SessionStart[0]!.hooks).toEqual([{ type: "command", command: "bun unrelated.ts" }]);
    expect(classifyClientHooks(installed as Record<string, unknown>, "codex", repoRoot).exact).toBe(4);
  });

  test("classification requires exact matcher and does not confuse missing specs", () => {
    const specs = canonicalHooks("codex", repoRoot);
    const oneHook = {
      hooks: {
        [specs[0]!.event]: [{ matcher: specs[0]!.matcher, hooks: [specs[0]!.entry] }],
      },
    };
    expect(classifyClientHooks(oneHook, "codex", repoRoot)).toEqual({ expected: 4, exact: 1, stale: 0, missing: 3 });

    const wrongMatcher = structuredClone(oneHook) as { hooks: Record<string, Array<{ matcher?: string }>> };
    wrongMatcher.hooks.SessionStart![0]!.matcher = "startup";
    expect(classifyClientHooks(wrongMatcher as Record<string, unknown>, "codex", repoRoot)).toEqual({ expected: 4, exact: 0, stale: 1, missing: 3 });
  });
});
