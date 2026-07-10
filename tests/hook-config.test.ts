import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalHooks, classifyClientHooks, installClientHooks } from "../shared/hook-config.ts";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

describe("canonical hook configuration", () => {
  test("tracked Codex fixture is rendered from the canonical hook definitions", () => {
    const tracked = readFileSync(join(repoRoot, ".codex", "hooks.json"), "utf8");
    const rendered = `${JSON.stringify(installClientHooks({}, "codex", repoRoot), null, 2)}\n`;
    expect(tracked).toBe(rendered);
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
