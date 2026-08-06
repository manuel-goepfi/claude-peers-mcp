import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHELL_WRAPPER = new URL("../hooks/codex-register-peer-session.sh", import.meta.url).pathname;
const BUN_WRAPPER = new URL("../hooks/codex-register-peer-session.ts", import.meta.url).pathname;
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function runWrapper(
  registrationBody: string | null,
  options: { input?: string; minimalEnv?: boolean; codexHome?: string; installWrapper?: boolean; path?: string } = {},
): { exitCode: number; stdout: string; stderr: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), "codex-register-wrapper-"));
  roots.push(root);
  const hooks = join(root, "hooks");
  const codexHome = options.codexHome ?? join(root, "codexhome");
  mkdirSync(hooks, { recursive: true });
  if (options.installWrapper ?? true) copyFileSync(BUN_WRAPPER, join(hooks, "codex-register-peer-session.ts"));
  if (registrationBody !== null) writeFileSync(join(hooks, "register-peer-session.ts"), registrationBody);
  const env = options.minimalEnv
    ? { PATH: options.path ?? process.env.PATH ?? "", CLAUDE_PEERS_ROOT: root }
    : { ...process.env, PATH: options.path ?? process.env.PATH ?? "", CLAUDE_PEERS_ROOT: root, CODEX_HOME: codexHome };
  const proc = Bun.spawnSync(["/usr/bin/bash", SHELL_WRAPPER], {
    env,
    stdin: options.input === undefined ? "ignore" : new TextEncoder().encode(options.input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const logPath = join(codexHome, "logs", "register-peer-session.log");
  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
    log: existsSync(logPath) ? readFileSync(logPath, "utf8") : "",
  };
}

function expectVisibleWarning(stdout: string, logged = true): void {
  expect(JSON.parse(stdout)).toEqual({
    systemMessage: logged
      ? "claude-peers registration failed; automatic peer messaging is unavailable for this session. See register-peer-session.log."
      : "claude-peers registration failed; automatic peer messaging is unavailable for this session. Diagnostics logging is also unavailable.",
  });
}

describe("Codex registration wrapper", () => {
  test("executes registration in the hook process with the original input", () => {
    const input = JSON.stringify({ session_id: "thread-123", hook_event_name: "SessionStart" });
    const result = runWrapper(`
      export async function runRegistration() {
        const input = await Bun.stdin.text();
        if (input !== ${JSON.stringify(input)}) throw new Error("hook input changed");
      }
    `, { input });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
    expect(result.log).toBe("");
  });

  test("converts a failed registration into a visible warning and retained log", () => {
    const result = runWrapper(`
      export async function runRegistration() {
        console.error("planted registration failure");
        process.exitCode = 1;
      }
    `);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expectVisibleWarning(result.stdout);
    expect(result.log).toContain("planted registration failure");
  });

  test("the registration implementation structurally reserves stdout for the wrapper", () => {
    const source = readFileSync(new URL("../hooks/register-peer-session.ts", import.meta.url), "utf8");
    expect(source).not.toContain("console.log");
    expect(source).not.toContain("process.stdout");
    expect(source).not.toContain("Bun.stdout");
  });

  test("the real missing-session path emits exactly one parseable warning", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-register-real-"));
    roots.push(root);
    const proc = Bun.spawnSync(["/usr/bin/bash", SHELL_WRAPPER], {
      env: {
        ...process.env,
        CLAUDE_PEERS_ROOT: new URL("..", import.meta.url).pathname,
        CODEX_HOME: join(root, "codexhome"),
      },
      stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "SessionStart" })),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new TextDecoder().decode(proc.stdout);

    expect(proc.exitCode).toBe(0);
    expect(new TextDecoder().decode(proc.stderr)).toBe("");
    expectVisibleWarning(stdout);
    expect(stdout.trim().split("\n")).toHaveLength(1);
  });

  test("a missing registration implementation is caught by the Bun wrapper", () => {
    const result = runWrapper(null);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expectVisibleWarning(result.stdout);
    expect(result.log).toContain("unexpected failure");
  });

  test("a registration implementation that throws is caught by the Bun wrapper", () => {
    const result = runWrapper(`export async function runRegistration() { throw new Error("planted throw"); }\n`);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expectVisibleWarning(result.stdout);
    expect(result.log).toContain("planted throw");
  });

  test("a missing Bun wrapper produces the same warning without a red hook failure", () => {
    const result = runWrapper(null, { installWrapper: false });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expectVisibleWarning(result.stdout);
    expect(result.log).toContain("[SessionStart] missing-script");
  });

  test("a missing Bun executable produces a visible warning and retained log", () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "codex-register-no-bun-"));
    roots.push(isolatedRoot);
    const bin = join(isolatedRoot, "bin");
    mkdirSync(bin);
    for (const command of ["date", "dirname", "mkdir"]) {
      const resolved = Bun.which(command);
      if (resolved === null) throw new Error(`${command} is required by this test`);
      symlinkSync(resolved, join(bin, command));
    }
    const result = runWrapper(`export async function runRegistration() {}\n`, { path: bin });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expectVisibleWarning(result.stdout);
    expect(result.log).toContain("[SessionStart] missing-bun");
  });

  test("survives a minimal environment with no HOME", () => {
    const result = runWrapper(`export async function runRegistration() { console.log("{}"); }\n`, { minimalEnv: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("{}\n");
  });

  test("an unusable log path never prevents a healthy registration", () => {
    const result = runWrapper(`export async function runRegistration() { console.log('{"ran":true}'); }\n`, {
      codexHome: "/dev/null",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ ran: true });
  });

  test("an unusable log path still emits a truthful failure warning", () => {
    const result = runWrapper(`export async function runRegistration() { process.exitCode = 1; }\n`, {
      codexHome: "/dev/null",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expectVisibleWarning(result.stdout, false);
  });

  test("forced termination cannot orphan a separate registration child", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-register-kill-"));
    roots.push(root);
    const hooks = join(root, "hooks");
    const pidFile = join(root, "pid");
    mkdirSync(hooks, { recursive: true });
    copyFileSync(BUN_WRAPPER, join(hooks, "codex-register-peer-session.ts"));
    writeFileSync(join(hooks, "register-peer-session.ts"), `
      export async function runRegistration() {
        await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));
        await new Promise(() => {});
      }
    `);
    const wrapper = Bun.spawn(["bash", SHELL_WRAPPER], {
      env: { ...process.env, CLAUDE_PEERS_ROOT: root, CODEX_HOME: join(root, "codexhome") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const deadline = Date.now() + 3_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(25);
      expect(existsSync(pidFile)).toBe(true);
      expect(Number(readFileSync(pidFile, "utf8"))).toBe(wrapper.pid);
      wrapper.kill("SIGKILL");
      expect(await wrapper.exited).toBe(137);
    } finally {
      wrapper.kill("SIGKILL");
      await wrapper.exited;
    }
  });
});
