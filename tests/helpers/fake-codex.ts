import { lstatSync, symlinkSync } from "node:fs";
import { join } from "node:path";

const SLEEPER = join(import.meta.dir, "..", "fixtures", "fake-codex-sleep.ts");

/**
 * Create `<dir>/codex`, a stand-in for a running Codex TUI, and return the
 * argv that keeps it alive for `seconds`.
 *
 * The broker recognizes a Codex client by /proc/<pid>/comm and by the basename
 * of argv[0] (shared/client.ts isClientProcess, isInteractiveCodexArgv), so
 * both must read `codex`. A copy of /usr/bin/sleep only satisfies that when
 * sleep is a single-purpose binary. A multicall coreutils (uutils, the default
 * on Ubuntu 26.04 runners, or busybox) dispatches on argv[0], rejects `codex`
 * as an unknown utility and exits at once, so the registered pid is dead.
 *
 * A symlink to the Bun runtime does not dispatch on argv[0], and the kernel
 * still takes comm from the symlink name.
 */
export function fakeCodexCommand(dir: string, seconds: number): string[] {
  const binary = join(dir, "codex");
  try {
    lstatSync(binary);
  } catch {
    symlinkSync(process.execPath, binary);
  }
  return [binary, SLEEPER, String(seconds)];
}

/** The same command, double-quoted for a `bash -c` script. */
export function fakeCodexShell(dir: string, seconds: number): string {
  return fakeCodexCommand(dir, seconds).map((arg) => `"${arg}"`).join(" ");
}
