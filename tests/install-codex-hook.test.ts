import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installer = new URL("../bin/install-codex-hook.ts", import.meta.url).pathname;
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const expectedCommand = `/usr/bin/env bash ${shellQuote(new URL("../hooks/codex-drain-peer-inbox.sh", import.meta.url).pathname)}`;

describe("Codex hook installer", () => {
  test("merges into existing hooks and remains idempotent", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claude-peers-install-"));
    try {
      const hooksPath = join(repo, ".codex", "hooks.json");
      mkdirSync(join(repo, ".codex"), { recursive: true });
      await Bun.write(hooksPath, JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: "/usr/bin/env bash existing-rule-router.sh",
                  timeout: 5,
                },
              ],
            },
          ],
        },
      }, null, 2));

      for (let i = 0; i < 2; i++) {
        const proc = Bun.spawn(["bun", installer, repo], { stdout: "ignore", stderr: "pipe" });
        const stderr = await new Response(proc.stderr).text();
        expect(await proc.exited).toBe(0);
        expect(stderr).toBe("");
      }

      const doc = JSON.parse(readFileSync(hooksPath, "utf8")) as {
        hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string; name?: string; timeout?: number }> }> };
      };
      const hooks = doc.hooks.UserPromptSubmit.flatMap((bucket) => bucket.hooks);
      const commands = hooks.map((hook) => hook.command);
      expect(commands).toContain("/usr/bin/env bash existing-rule-router.sh");
      expect(commands.filter((command) => command === expectedCommand).length).toBe(1);
      expect(hooks.find((hook) => hook.command === expectedCommand)?.name).toBe("claude-peers-codex-inbox");
      expect(hooks.find((hook) => hook.command === expectedCommand)?.timeout).toBe(10);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("rejects invalid existing JSON instead of overwriting it", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claude-peers-install-bad-"));
    try {
      const hooksPath = join(repo, ".codex", "hooks.json");
      mkdirSync(join(repo, ".codex"), { recursive: true });
      writeFileSync(hooksPath, "{not-json");
      const proc = Bun.spawn(["bun", installer, repo], { stdout: "ignore", stderr: "pipe" });
      await new Response(proc.stderr).text();
      expect(await proc.exited).not.toBe(0);
      expect(readFileSync(hooksPath, "utf8")).toBe("{not-json");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("replaces stale legacy hook command instead of appending a duplicate", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claude-peers-install-stale-"));
    try {
      const hooksPath = join(repo, ".codex", "hooks.json");
      mkdirSync(join(repo, ".codex"), { recursive: true });
      await Bun.write(hooksPath, JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: "/usr/bin/env bash /old/hooks/codex-drain-peer-inbox.sh",
                  timeout: 5,
                },
              ],
            },
            {
              hooks: [
                {
                  name: "claude-peers-codex-inbox",
                  type: "command",
                  command: expectedCommand,
                  timeout: 10,
                },
              ],
            },
          ],
        },
      }, null, 2));

      const proc = Bun.spawn(["bun", installer, repo], { stdout: "ignore", stderr: "pipe" });
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(0);
      expect(stderr).toBe("");

      const doc = JSON.parse(readFileSync(hooksPath, "utf8")) as {
        hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string; name?: string; timeout?: number }> }> };
      };
      const hooks = doc.hooks.UserPromptSubmit.flatMap((bucket) => bucket.hooks);
      const peerHooks = hooks.filter((hook) => hook.command.includes("codex-drain-peer-inbox.sh"));
      expect(peerHooks).toHaveLength(1);
      expect(peerHooks[0]?.command).toBe(expectedCommand);
      expect(peerHooks[0]?.name).toBe("claude-peers-codex-inbox");
      expect(peerHooks[0]?.timeout).toBe(10);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
