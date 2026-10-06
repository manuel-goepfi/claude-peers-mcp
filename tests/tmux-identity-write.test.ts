import { describe, expect, test } from "bun:test";
import { TmuxIdentityWriteTracker, tmuxIdentityWriteKey } from "../shared/tmux-identity.ts";

const identity = { id: "peer-1", name: "lane.1", resolved_name: "lane.1", client_type: "claude" as const, receiver_mode: "claude-channel" as const };

describe("unchanged tmux identity write suppression", () => {
  test("successful unchanged identity is not republished", () => {
    const tracker = new TmuxIdentityWriteTracker();
    const key = tmuxIdentityWriteKey(identity, "%1");
    expect(tracker.shouldWrite(key, 0)).toBe(true);
    tracker.record(key, { ok: true, target: "%1", failedOptions: [] }, 0);
    expect(tracker.shouldWrite(key, 1_000_000)).toBe(false);
    expect(tracker.skippedResult("%1")).toEqual({ ok: true, target: "%1", failedOptions: [], skipped: true });
  });

  test("identity or pane changes force a write", () => {
    const tracker = new TmuxIdentityWriteTracker();
    const key = tmuxIdentityWriteKey(identity, "%1");
    tracker.record(key, { ok: true, target: "%1", failedOptions: [] }, 0);
    expect(tracker.shouldWrite(tmuxIdentityWriteKey({ ...identity, receiver_mode: "manual-drain" }, "%1"), 1)).toBe(true);
    expect(tracker.shouldWrite(tmuxIdentityWriteKey(identity, "%2"), 1)).toBe(true);
  });

  test("failed writes receive exactly three bounded retries", () => {
    const tracker = new TmuxIdentityWriteTracker();
    const key = tmuxIdentityWriteKey(identity, "%1");
    tracker.record(key, { ok: false, target: "%1", failedOptions: ["@peer_id"] }, 0);
    expect(tracker.shouldWrite(key, 14_999)).toBe(false);
    expect(tracker.shouldWrite(key, 15_000)).toBe(true);
    tracker.record(key, { ok: false, target: "%1", failedOptions: ["@peer_id"] }, 15_000);
    expect(tracker.shouldWrite(key, 44_999)).toBe(false);
    expect(tracker.shouldWrite(key, 45_000)).toBe(true);
    tracker.record(key, { ok: false, target: "%1", failedOptions: ["@peer_id"] }, 45_000);
    expect(tracker.shouldWrite(key, 104_999)).toBe(false);
    expect(tracker.shouldWrite(key, 105_000)).toBe(true);
    tracker.record(key, { ok: false, target: "%1", failedOptions: ["@peer_id"] }, 105_000);
    expect(tracker.shouldWrite(key, 1_000_000)).toBe(false);
  });
});

for (const status of [0, 1]) {
  test(`default mirror writes five fields in one invocation, status=${status}`, async () => {
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "peer-mirror-batch-"));
    try {
      const log = join(root, "argv");
      writeFileSync(join(root, "tmux"), `#!/bin/bash\nprintf 'CALL\\0' >> '${log}'\nprintf '%s\\0' "$@" >> '${log}'\nexit ${status}\n`, { mode: 0o755 });
      const child = Bun.spawn([process.execPath, "-e", `
        import { publishBrokerIdentityToTmux } from ${JSON.stringify(new URL("../shared/tmux-identity.ts", import.meta.url).pathname)};
        console.log(JSON.stringify(publishBrokerIdentityToTmux(${JSON.stringify(identity)}, null,
          { env: { TMUX_PANE: "%123" }, readPaneOption: () => "lane.1" })));
      `], { env: { ...process.env, PATH: root + ":" + process.env.PATH }, stdout: "pipe", stderr: "pipe" });
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      const fields = ["@peer_id", "@peer_label", "@peer_resolved_name", "@peer_client_type", "@peer_receiver_mode"];
      expect(JSON.parse(output)).toEqual({ ok: status === 0, target: "%123", failedOptions: status === 0 ? [] : fields });
      const args = readFileSync(log, "utf8").split("\0").filter(Boolean);
      expect(args.filter((arg) => arg === "CALL")).toHaveLength(1);
      expect(args.filter((arg) => arg === "set-option")).toHaveLength(5);
      expect(args.filter((arg) => arg === ";")).toHaveLength(4);
      expect(args.filter((arg) => arg.startsWith("@"))).toEqual(fields);
      const values = [identity.id, "lane.1", identity.resolved_name, identity.client_type, identity.receiver_mode];
      expect(args).toEqual(["CALL", ...fields.flatMap((field, i) => [
        ...(i ? [";"] : []), "set-option", "-p", "-t", "%123", field, values[i]!,
      ])]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
