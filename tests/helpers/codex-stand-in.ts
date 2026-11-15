import { chmodSync, copyFileSync, existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A stand-in native Codex process for tests: an executable named `codex` whose
 * /proc comm and argv[0] both read `codex`, and which stays alive for a bounded
 * number of seconds.
 *
 * It is a copy of the system shell running a hold script. It must not be a
 * renamed copy of `sleep`: on images that ship a multicall coreutils (Ubuntu
 * 26.04), a copy of `sleep` named `codex` exits at once with "unknown program
 * 'codex'", so every test that needs a live Codex process fails.
 *
 * The hold script path is the stand-in's first positional argument. It is not
 * a Codex subcommand, so the process classifies as an interactive Codex.
 */
export interface CodexStandIn {
  /** Path of the executable named `codex`. */
  binary: string;
  /** argv that runs the stand-in for `seconds`. */
  argv(seconds: number): string[];
  /** The same invocation as a double-quoted shell command fragment. */
  shellCommand(seconds: number): string;
}

const HOLD_SCRIPT = [
  'sleep "${1:-60}" &',
  "trap 'kill $! 2>/dev/null' TERM INT HUP",
  "wait $!",
  "",
].join("\n");

export function codexStandIn(root: string): CodexStandIn {
  const binary = join(root, "codex");
  const hold = join(root, "codex-hold.sh");
  if (!existsSync(binary)) {
    copyFileSync(realpathSync("/bin/sh"), binary);
    chmodSync(binary, 0o755);
    const probe = Bun.spawnSync([binary, "-c", "exit 0"], { stdout: "ignore", stderr: "pipe" });
    if (probe.exitCode !== 0) {
      throw new Error(
        `codex stand-in: a copy of /bin/sh named codex does not run here (exit ${probe.exitCode}): ${probe.stderr.toString().trim()}`,
      );
    }
  }
  if (!existsSync(hold)) writeFileSync(hold, HOLD_SCRIPT, { mode: 0o644 });
  return {
    binary,
    argv: (seconds) => [binary, hold, String(seconds)],
    shellCommand: (seconds) => `"${binary}" "${hold}" ${seconds}`,
  };
}
