import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const LAUNCHER = new URL("../bin/codex-seat", import.meta.url).pathname;
const roots: string[] = [];
const EXPECTED_CODEX_GLOBAL_OPTIONS = [
  "--add-dir",
  "--ask-for-approval",
  "--cd",
  "--config",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--disable",
  "--enable",
  "--help",
  "--image",
  "--local-provider",
  "--model",
  "--no-alt-screen",
  "--oss",
  "--profile",
  "--remote",
  "--remote-auth-token-env",
  "--sandbox",
  "--search",
  "--strict-config",
  "--version",
  "-C",
  "-V",
  "-a",
  "-c",
  "-h",
  "-i",
  "-m",
  "-p",
  "-s",
].sort();

function fixture(): { root: string; state: string; fakeCodex: string } {
  const root = mkdtempSync(join(tmpdir(), "claude-peers-codex-seat-"));
  roots.push(root);
  const state = join(root, "state");
  const fakeCodex = join(root, "codex");
  Bun.spawnSync(["mkdir", "-p", state]);
  writeFileSync(fakeCodex, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${FAKE_CODEX_RECORD_ONLY:-}" != "1" && " $* " == *" app-server "* ]]; then
  port=""
  previous=""
  for argument in "$@"; do
    if [[ "$previous" == "--listen" ]]; then port="\${argument##*:}"; fi
    previous="$argument"
  done
  printf '%s\\n' "$$" >"$FAKE_CODEX_STATE/app.pid"
  printf 'name=%s\\npane=%s\\n' "\${CLAUDE_PEER_NAME:-}" "\${TMUX_PANE:-}" >"$FAKE_CODEX_STATE/app.env"
  exec bun -e 'const port = Number(process.argv[1]); const ignore = process.env.FAKE_CODEX_IGNORE_TERM === "1"; if (ignore) process.on("SIGTERM", () => {}); const child = ignore ? Bun.spawn(["bun", "-e", "process.on(\\"SIGTERM\\", () => {}); await new Promise(() => {})"]) : Bun.spawn(["sleep", "60"]); await Bun.write(process.env.FAKE_CODEX_STATE + "/app.child.pid", String(child.pid)); Bun.serve({ port, hostname: "127.0.0.1", fetch() { return new Response("ready"); } }); await new Promise(() => {});' "$port"
fi
printf '%s\\n' "$$" >"$FAKE_CODEX_STATE/tui.pid"
printf '%s\\n' "$@" >"$FAKE_CODEX_STATE/tui.args"
printf 'name=%s\\npane=%s\\n' "\${CLAUDE_PEER_NAME:-}" "\${TMUX_PANE:-}" >"$FAKE_CODEX_STATE/tui.env"
if [[ -n "\${FAKE_CODEX_TUI_SLEEP:-}" ]]; then
  if [[ "\${FAKE_CODEX_IGNORE_TERM:-}" == "1" ]]; then
    trap '' TERM
    bun -e 'process.on("SIGTERM", () => {}); await new Promise(() => {})' &
  else
    sleep "$FAKE_CODEX_TUI_SLEEP" &
  fi
  child=$!
  printf '%s\\n' "$child" >"$FAKE_CODEX_STATE/tui.child.pid"
  wait "$child"
fi
exit "\${FAKE_CODEX_TUI_EXIT:-0}"
`);
  chmodSync(fakeCodex, 0o755);
  return { root, state, fakeCodex };
}

function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error("Bun did not assign a probe port");
  return port;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function directChildren(pid: number): number[] {
  const result = Bun.spawnSync(["ps", "-o", "pid=", "--ppid", String(pid)], { stdout: "pipe", stderr: "ignore" });
  if (result.exitCode !== 0) return [];
  return new TextDecoder().decode(result.stdout).trim().split(/\s+/)
    .filter(Boolean)
    .map(Number);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(50);
  }
  return predicate();
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("codex-seat launcher", () => {
  const installedCodex = Bun.which("codex");
  (installedCodex ? test : test.skip)("pins the launcher audit table to the installed Codex --help", () => {
    const result = Bun.spawnSync([installedCodex!, "--help"], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    const help = new TextDecoder().decode(result.stdout);
    const optionsSection = help.slice(help.indexOf("Options:"));
    const discovered = new Set<string>();
    for (const line of optionsSection.split("\n")) {
      for (const match of line.matchAll(/(?:^|[,\s])(-{1,2}[A-Za-z][A-Za-z0-9-]*)/g)) {
        discovered.add(match[1]!);
      }
    }
    expect([...discovered].sort()).toEqual(EXPECTED_CODEX_GLOBAL_OPTIONS);
  });

  test("passes noninteractive subcommands directly without seat dependencies", () => {
    const { root, state, fakeCodex } = fixture();
    const bin = join(root, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    for (const command of ["bash", "readlink"]) {
      const resolved = Bun.which(command);
      if (resolved === null) throw new Error(`${command} is required by this test`);
      symlinkSync(resolved, join(bin, command));
    }

    const result = Bun.spawnSync([
      LAUNCHER,
      "--strict-config",
      "--enable",
      "hooks",
      "--search",
      "-c",
      'model="test"',
      "exec",
      "--json",
    ], {
      env: {
        PATH: bin,
        HOME: root,
        CLAUDE_PEERS_REAL_CODEX: fakeCodex,
        FAKE_CODEX_STATE: state,
        FAKE_CODEX_RECORD_ONLY: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(state, "app.pid"))).toBe(false);
    expect(readFileSync(join(state, "tui.args"), "utf8")).toBe(
      '--strict-config\n--enable\nhooks\n--search\n-c\nmodel="test"\nexec\n--json\n',
    );
  });

  test("does not mistake a variadic image value for the exec alias", () => {
    const { root, state, fakeCodex } = fixture();
    const result = Bun.spawnSync([LAUNCHER, "-i", "a.png", "e"], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        CODEX_HOME: join(root, ".codex"),
        CLAUDE_PEERS_REAL_CODEX: fakeCodex,
        CLAUDE_PEERS_CODEX_SEAT_PORT: String(freePort()),
        FAKE_CODEX_STATE: state,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(state, "app.pid"))).toBe(true);
  });

  test("does not mistake an option value named -h for a help request", () => {
    const { root, state, fakeCodex } = fixture();
    const result = Bun.spawnSync([LAUNCHER, "--model", "-h"], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        CODEX_HOME: join(root, ".codex"),
        CLAUDE_PEERS_REAL_CODEX: fakeCodex,
        CLAUDE_PEERS_CODEX_SEAT_PORT: String(freePort()),
        FAKE_CODEX_STATE: state,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(state, "app.pid"))).toBe(true);
  });

  test("fails toward a registered seat when an unknown future option is ambiguous", () => {
    const { root, state, fakeCodex } = fixture();
    const port = freePort();
    const result = Bun.spawnSync([LAUNCHER, "--future-option", "value", "exec", "--json"], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        CODEX_HOME: join(root, ".codex"),
        CLAUDE_PEERS_REAL_CODEX: fakeCodex,
        CLAUDE_PEERS_CODEX_SEAT_PORT: String(port),
        FAKE_CODEX_STATE: state,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(state, "app.pid"))).toBe(true);
    expect(readFileSync(join(state, "tui.args"), "utf8")).toBe(
      `--remote\nws://127.0.0.1:${port}\n--cd\n${process.cwd()}\n--future-option\nvalue\nexec\n--json\n`,
    );
  });

  test("fails toward a registered seat for an unknown future short option", () => {
    const { root, state, fakeCodex } = fixture();
    const port = freePort();
    const result = Bun.spawnSync([LAUNCHER, "-x", "exec", "--json"], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        CODEX_HOME: join(root, ".codex"),
        CLAUDE_PEERS_REAL_CODEX: fakeCodex,
        CLAUDE_PEERS_CODEX_SEAT_PORT: String(port),
        FAKE_CODEX_STATE: state,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(state, "app.pid"))).toBe(true);
  });

  test.each([
    ["separate", ["--future-option", "--remote", "ws://127.0.0.1:45678", "resume"]],
    ["attached", ["--future-option", "--remote=ws://127.0.0.1:45678", "resume"]],
  ])("fails loudly instead of wrapping an explicit remote after an unknown option (%s)", (_label, args) => {
    const { root, state, fakeCodex } = fixture();
    const result = Bun.spawnSync([LAUNCHER, ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        CODEX_HOME: join(root, ".codex"),
        CLAUDE_PEERS_REAL_CODEX: fakeCodex,
        CLAUDE_PEERS_CODEX_SEAT_PORT: String(freePort()),
        FAKE_CODEX_STATE: state,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(2);
    expect(new TextDecoder().decode(result.stderr)).toContain("explicit --remote conflicts with a pane-local seat");
    expect(new TextDecoder().decode(result.stderr)).toContain("CLAUDE_PEERS_CODEX_SEAT=0");
    expect(existsSync(join(state, "app.pid"))).toBe(false);
    expect(existsSync(join(state, "tui.pid"))).toBe(false);
  });

  test("passes an explicit remote through when it precedes an unknown option", () => {
    const { root, state, fakeCodex } = fixture();
    const args = ["--remote", "ws://127.0.0.1:45678", "--future-option", "resume"];
    const result = Bun.spawnSync([LAUNCHER, ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        CLAUDE_PEERS_REAL_CODEX: fakeCodex,
        FAKE_CODEX_STATE: state,
        FAKE_CODEX_RECORD_ONLY: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(state, "app.pid"))).toBe(false);
    expect(readFileSync(join(state, "tui.args"), "utf8")).toBe(`${args.join("\n")}\n`);
  });

  test("keeps an unknown-option help request on the fail-toward-seat path", () => {
    const { root, state, fakeCodex } = fixture();
    const result = Bun.spawnSync([LAUNCHER, "--future-option", "--help"], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        CODEX_HOME: join(root, ".codex"),
        CLAUDE_PEERS_REAL_CODEX: fakeCodex,
        CLAUDE_PEERS_CODEX_SEAT_PORT: String(freePort()),
        FAKE_CODEX_STATE: state,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(state, "app.pid"))).toBe(true);
  });

  test.each([
    ["interactive help", ["resume", "--help"]],
    ["app-server", ["app-server", "--listen", "ws://127.0.0.1:45678"]],
  ])("passes %s directly without seat dependencies", (_label, args) => {
    const { root, state, fakeCodex } = fixture();
    const bin = join(root, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    for (const command of ["bash", "readlink"]) {
      const resolved = Bun.which(command);
      if (resolved === null) throw new Error(`${command} is required by this test`);
      symlinkSync(resolved, join(bin, command));
    }

    const result = Bun.spawnSync([LAUNCHER, ...args], {
      env: {
        PATH: bin,
        HOME: root,
        CLAUDE_PEERS_REAL_CODEX: fakeCodex,
        FAKE_CODEX_STATE: state,
        FAKE_CODEX_RECORD_ONLY: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(state, "app.pid"))).toBe(false);
    expect(readFileSync(join(state, "tui.args"), "utf8")).toBe(`${args.join("\n")}\n`);
  });

  test("fails before spawning children when pgrep is unavailable", () => {
    const { root, state, fakeCodex } = fixture();
    const bin = join(root, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    for (const command of ["bash", "readlink", "ss"]) {
      const resolved = Bun.which(command);
      if (resolved === null) throw new Error(`${command} is required by this test`);
      symlinkSync(resolved, join(bin, command));
    }

    const result = Bun.spawnSync([LAUNCHER, "resume"], {
      env: {
        PATH: bin,
        HOME: root,
        CODEX_HOME: join(root, ".codex"),
        CLAUDE_PEERS_REAL_CODEX: fakeCodex,
        CLAUDE_PEERS_CODEX_SEAT_PORT: String(freePort()),
        FAKE_CODEX_STATE: state,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(127);
    expect(new TextDecoder().decode(result.stderr)).toContain("pgrep is required for process cleanup");
    expect(existsSync(join(state, "app.pid"))).toBe(false);
    expect(existsSync(join(state, "tui.pid"))).toBe(false);
  });

  test("passes exact pane identity through a dedicated app-server and reaps it after the TUI exits", () => {
    const { root, state, fakeCodex } = fixture();
    const bin = join(root, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    const fakeTmux = join(bin, "tmux");
    writeFileSync(fakeTmux, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "show-options" ]]; then
  case "\${*: -1}" in
    @operator_label) printf 'orch.5\\n' ;;
    @peer_resolved_name) printf 'orch.5#stale\\n' ;;
  esac
  exit 0
fi
if [[ "\${1:-}" == "display-message" ]]; then
  case "\${*: -1}" in
    '#S') printf 'orch\\n' ;;
    '#I') printf '1\\n' ;;
    '#W') printf 'peers\\n' ;;
  esac
fi
`);
    chmodSync(fakeTmux, 0o755);
    const port = freePort();
    const result = Bun.spawnSync([LAUNCHER, "resume"], {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: root,
        CODEX_HOME: join(root, ".codex"),
        CLAUDE_PEERS_REAL_CODEX: fakeCodex,
        CLAUDE_PEERS_CODEX_SEAT_PORT: String(port),
        CLAUDE_PEER_NAME: "orch.5",
        TMUX_PANE: "%2432",
        FAKE_CODEX_STATE: state,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(state, "app.env"), "utf8")).toBe("name=orch.5\npane=%2432\n");
    expect(readFileSync(join(state, "tui.env"), "utf8")).toBe("name=orch.5\npane=%2432\n");
    expect(readFileSync(join(state, "tui.args"), "utf8")).toBe(
      `--remote\nws://127.0.0.1:${port}\n--cd\n${process.cwd()}\nresume\n`,
    );
    const appPid = Number(readFileSync(join(state, "app.pid"), "utf8").trim());
    const appChildPid = Number(readFileSync(join(state, "app.child.pid"), "utf8").trim());
    expect(isAlive(appPid)).toBe(false);
    expect(isAlive(appChildPid)).toBe(false);
    expect(existsSync(join(root, ".codex", "logs", "codex-seat-2432.app-server.log"))).toBe(true);
  });

  test("supplies the launcher cwd as --cd, because wrapping always adds --remote", () => {
    // A remote workspace does not inherit the launching cwd, and the launcher
    // adds --remote on every wrap. Two things broke without this: `codex resume`
    // refused outright while tui.resume_cwd is "current", and peer registration
    // keys on the hook environment's cwd, so a lane registered under whichever
    // directory the launcher happened to sit in rather than the one it was
    // asked for.
    const { root, state, fakeCodex } = fixture();
    const port = freePort();
    const result = Bun.spawnSync([LAUNCHER, "resume"], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        CODEX_HOME: join(root, ".codex"),
        CLAUDE_PEERS_REAL_CODEX: fakeCodex,
        CLAUDE_PEERS_CODEX_SEAT_PORT: String(port),
        FAKE_CODEX_STATE: state,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    const args = readFileSync(join(state, "tui.args"), "utf8").split("\n").filter(Boolean);
    expect(args).toContain("--cd");
    expect(args[args.indexOf("--cd") + 1]).toBe(process.cwd());
  });

  test.each([
    ["separate long form", ["--cd", "/tmp"]],
    ["separate short form", ["-C", "/tmp"]],
    ["attached form", ["--cd=/tmp"]],
  ])("leaves a caller-supplied workspace root alone (%s)", (_label, caller) => {
    // An explicit -C/--cd must win. Injecting a second one hands Codex two
    // conflicting workspace roots for one session, which is worse than the bug
    // the injection exists to fix.
    const { root, state, fakeCodex } = fixture();
    const port = freePort();
    const result = Bun.spawnSync([LAUNCHER, ...caller, "resume"], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        CODEX_HOME: join(root, ".codex"),
        CLAUDE_PEERS_REAL_CODEX: fakeCodex,
        CLAUDE_PEERS_CODEX_SEAT_PORT: String(port),
        FAKE_CODEX_STATE: state,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    const args = readFileSync(join(state, "tui.args"), "utf8").split("\n").filter(Boolean);
    const supplied = args.filter((a) => a === "--cd" || a === "-C" || a.startsWith("--cd=")).length;
    expect(supplied).toBe(1);
    expect(args).not.toContain(process.cwd());
  });

  test("the detached owner watchdog reaps both children if the launcher is killed", async () => {
    const { root, state, fakeCodex } = fixture();
    const port = freePort();
    const launcher = Bun.spawn([LAUNCHER, "resume"], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        CODEX_HOME: join(root, ".codex"),
        CLAUDE_PEERS_REAL_CODEX: fakeCodex,
        CLAUDE_PEERS_CODEX_SEAT_PORT: String(port),
        CLAUDE_PEER_NAME: "orch.5",
        TMUX_PANE: "%2432",
        FAKE_CODEX_STATE: state,
        FAKE_CODEX_TUI_SLEEP: "60",
        FAKE_CODEX_IGNORE_TERM: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let appPid = 0;
    let appChildPid = 0;
    let tuiPid = 0;
    let tuiChildPid = 0;
    let watchdogPid = 0;
    try {
      expect(await waitFor(() => ["app.pid", "app.child.pid", "tui.pid", "tui.child.pid"]
        .every((file) => existsSync(join(state, file))))).toBe(true);
      appPid = Number(readFileSync(join(state, "app.pid"), "utf8").trim());
      appChildPid = Number(readFileSync(join(state, "app.child.pid"), "utf8").trim());
      tuiPid = Number(readFileSync(join(state, "tui.pid"), "utf8").trim());
      tuiChildPid = Number(readFileSync(join(state, "tui.child.pid"), "utf8").trim());
      expect(await waitFor(() => directChildren(launcher.pid).length >= 3)).toBe(true);
      watchdogPid = directChildren(launcher.pid).find((pid) => pid !== appPid && pid !== tuiPid) ?? 0;
      expect(watchdogPid).toBeGreaterThan(0);
      expect(isAlive(appPid)).toBe(true);
      expect(isAlive(appChildPid)).toBe(true);
      expect(isAlive(tuiPid)).toBe(true);
      expect(isAlive(tuiChildPid)).toBe(true);
      expect(isAlive(watchdogPid)).toBe(true);

      launcher.kill("SIGKILL");
      await launcher.exited;
      expect(await waitFor(() => [appPid, appChildPid, tuiPid, tuiChildPid, watchdogPid].every((pid) => !isAlive(pid)))).toBe(true);
    } finally {
      launcher.kill("SIGKILL");
      try {
        if (appPid) process.kill(-appPid, "SIGKILL");
      } catch {
        // The owner watchdog already reaped the process group.
      }
      try {
        if (tuiPid) process.kill(tuiPid, "SIGKILL");
      } catch {
        // The owner watchdog already reaped the TUI.
      }
      for (const pid of [appChildPid, tuiChildPid, watchdogPid]) {
        try {
          if (pid) process.kill(pid, "SIGKILL");
        } catch {
          // Already reaped.
        }
      }
    }
  }, 10_000);

  test("rejects readiness served by a different process on the requested port", async () => {
    const { root, state, fakeCodex } = fixture();
    const port = freePort();
    const occupier = Bun.spawn([process.execPath, "-e", `
      Bun.serve({ port: Number(process.argv[1]), hostname: "127.0.0.1", fetch: () => new Response("occupied") });
      await new Promise(() => {});
    `, String(port)], { stdout: "ignore", stderr: "pipe" });
    try {
      expect(await waitFor(() => Bun.spawnSync([
        "curl", "-fsS", "--max-time", "0.2", `http://127.0.0.1:${port}/readyz`,
      ]).exitCode === 0)).toBe(true);
      const result = Bun.spawnSync([LAUNCHER, "resume"], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: root,
          CODEX_HOME: join(root, ".codex"),
          CLAUDE_PEERS_REAL_CODEX: fakeCodex,
          CLAUDE_PEERS_CODEX_SEAT_PORT: String(port),
          CLAUDE_PEER_NAME: "orch.5",
          TMUX_PANE: "%2432",
          FAKE_CODEX_STATE: state,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(1);
      expect(new TextDecoder().decode(result.stderr)).toContain("could not start a pane-local app-server");
      expect(existsSync(join(state, "tui.pid"))).toBe(false);
      const failedAppPid = Number(readFileSync(join(state, "app.pid"), "utf8").trim());
      const failedChildPid = Number(readFileSync(join(state, "app.child.pid"), "utf8").trim());
      expect(isAlive(failedAppPid)).toBe(false);
      expect(isAlive(failedChildPid)).toBe(false);
    } finally {
      occupier.kill("SIGKILL");
      await occupier.exited;
    }
  });

  test("propagates a nonzero TUI exit after reaping the app-server tree", async () => {
    const { root, state, fakeCodex } = fixture();
    const result = Bun.spawnSync([LAUNCHER, "resume"], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        CODEX_HOME: join(root, ".codex"),
        CLAUDE_PEERS_REAL_CODEX: fakeCodex,
        CLAUDE_PEERS_CODEX_SEAT_PORT: String(freePort()),
        CLAUDE_PEER_NAME: "orch.5",
        TMUX_PANE: "%2432",
        FAKE_CODEX_STATE: state,
        FAKE_CODEX_TUI_EXIT: "23",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(23);
    for (const file of ["app.pid", "app.child.pid", "tui.pid"]) {
      const pid = Number(readFileSync(join(state, file), "utf8").trim());
      expect(await waitFor(() => !isAlive(pid))).toBe(true);
    }
  });
});
