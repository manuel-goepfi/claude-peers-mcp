import { describe, expect, test } from "bun:test";
import {
  ReleaseSmokeFailure,
  runReleaseSmoke,
  type CommandOptions,
  type CommandResult,
  type ReleaseClient,
} from "../scripts/smoke-real-clients.ts";

function armedEnvironment(): Record<string, string | undefined> {
  return {
    HOME: "/release/home",
    PATH: "/fake/bin",
    CLAUDE_PEERS_RELEASE_HOME: "/release/home",
    CLAUDE_PEERS_RELEASE_SMOKE: "1",
    CLAUDE_PEERS_RELEASE_TIMEOUT_MS: "10000",
    CLAUDE_PEERS_RELEASE_CLAUDE_VERSION: "1.0.0",
    CLAUDE_PEERS_RELEASE_CODEX_VERSION: "1.0.0",
    CLAUDE_PEERS_RELEASE_GEMINI_VERSION: "1.0.0",
  };
}

describe("authenticated real-client release smoke", () => {
  test("blocks before invoking clients when the isolated account is not armed", async () => {
    let calls = 0;
    const result = await runReleaseSmoke({
      env: { HOME: "/release/home", PATH: "/fake/bin" },
      platform: "linux",
      sourceRoot: "/release/home/clone",
      pathExists: () => true,
      ensureDirectory: () => undefined,
      runCommand: async () => { calls++; return { code: 0, stdout: "", stderr: "" }; },
    });
    expect(result).toEqual({ status: "blocked", reason: "isolated release host/account is not explicitly armed" });
    expect(calls).toBe(0);
  });

  test("requires explicit release version pins", async () => {
    const env = armedEnvironment();
    delete env.CLAUDE_PEERS_RELEASE_GEMINI_VERSION;
    const result = await runReleaseSmoke({
      env,
      platform: "linux",
      sourceRoot: "/release/home/clone",
      pathExists: () => true,
      ensureDirectory: () => undefined,
      findBinary: (client) => `/fake/bin/${client}`,
    });
    expect(result).toEqual({ status: "blocked", reason: "one or more release client version pins are missing" });
  });

  test("executes onboarding, auth, three-client send/ack journey, and cleanup", async () => {
    const calls: Array<{ command: string[]; options: CommandOptions }> = [];
    const runCommand = async (command: string[], options: CommandOptions): Promise<CommandResult> => {
      calls.push({ command, options });
      if (options.phase === "version") return { code: 0, stdout: `${options.client} 1.0.0\n`, stderr: "" };
      const marker = command.join(" ").match(/CLAUDE_PEERS_(?:AUTH|JOURNEY)_OK:[a-z]+:fixednonce/)?.[0] ?? "";
      return { code: 0, stdout: marker, stderr: "sensitive transcript is ignored" };
    };

    const result = await runReleaseSmoke({
      env: armedEnvironment(),
      platform: "linux",
      sourceRoot: "/release/home/clone",
      pathExists: () => true,
      ensureDirectory: () => undefined,
      findBinary: (client) => `/fake/bin/${client}`,
      runCommand,
      nonce: () => "fixednonce",
      now: (() => { let tick = 0; return () => `2026-07-11T00:00:0${tick++}.000Z`; })(),
    });

    expect(result.status).toBe("passed");
    if (result.status !== "passed") throw new Error("expected pass");
    expect(result.journey).toBe("three-client-cycle-send-ack");
    expect(result.transcripts).toBe("not-retained");
    expect(Object.values(result.clients).every((client) => client.auth === "passed" && client.journey === "passed")).toBe(true);
    expect(calls.filter((call) => call.options.phase === "auth")).toHaveLength(3);
    expect(calls.filter((call) => call.options.phase === "journey")).toHaveLength(3);
    expect(calls.filter((call) => call.options.phase === "hook-uninstall")).toHaveLength(3);
    expect(calls.filter((call) => call.options.phase === "mcp-uninstall")).toHaveLength(3);
    for (const client of ["claude", "codex", "gemini"] as ReleaseClient[]) {
      expect(calls.some((call) => call.options.phase === "journey" && call.options.client === client && call.options.env.CLAUDE_PEER_NAME === `release-${client}-fixednonce`)).toBe(true);
    }
  });

  test("fails closed without transcripts and still runs cleanup", async () => {
    const phases: string[] = [];
    const runCommand = async (command: string[], options: CommandOptions): Promise<CommandResult> => {
      phases.push(`${options.phase}:${options.client ?? "none"}`);
      if (options.phase === "version") return { code: 0, stdout: "1.0.0", stderr: "" };
      const marker = command.join(" ").match(/CLAUDE_PEERS_(?:AUTH|JOURNEY)_OK:[a-z]+:fixednonce/)?.[0] ?? "";
      if (options.phase === "journey" && options.client === "codex") return { code: 0, stdout: "no success marker", stderr: "secret" };
      return { code: 0, stdout: marker, stderr: "" };
    };

    let failure: unknown;
    try {
      await runReleaseSmoke({
        env: armedEnvironment(),
        platform: "linux",
        sourceRoot: "/release/home/clone",
        pathExists: () => true,
        ensureDirectory: () => undefined,
        findBinary: (client) => `/fake/bin/${client}`,
        runCommand,
        nonce: () => "fixednonce",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ReleaseSmokeFailure);
    expect(failure).toMatchObject({ phase: "journey", client: "codex" });
    expect(phases.filter((phase) => phase.startsWith("hook-uninstall:"))).toHaveLength(3);
    expect(phases.filter((phase) => phase.startsWith("mcp-uninstall:"))).toHaveLength(3);
  });
});
