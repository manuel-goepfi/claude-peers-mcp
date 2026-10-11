#!/usr/bin/env bun
/**
 * sync-greeting-hook: keep every deployed SessionStart greeting hook identical
 * to the repo's canonical hooks/claude-peers-session-greeting.sh.
 *
 * The greeting runs from a copy in each Claude config home
 * (~/.claude/hooks/, ~/.claude-b/hooks/, ...), not from the repo, so a repo
 * change does nothing until it is copied, and copies drift. On 2026-10-11 all
 * four homes still ran an August copy: it printed a peer policy the repo
 * removed on 2026-10-06 and lacked the request_id/reply_to_id rendering.
 *
 *   sync-greeting-hook.ts [--check]          report per home; exit 1 on any drift
 *   sync-greeting-hook.ts --install          back up each drifted copy (0600, exclusive),
 *                                             replace it atomically (0755), then verify
 *                                             (exit 1 if any home differs or is unsafe)
 *   --home DIR (repeatable)                  limit to these config homes
 *
 * Default homes: ~/.claude plus every ~/.claude-* that already has the hook.
 * A home without the hook is reported as missing and never created by --check.
 * Symlinks on the path (home, hooks dir, hook) or foreign-owned entries are
 * reported as unsafe and never written.
 */
import { closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const HOOK_NAME = "claude-peers-session-greeting.sh";
const CANONICAL = resolve(import.meta.dir, "..", "hooks", HOOK_NAME);

export type HomeState = {
  home: string;
  path: string;
  state: "same" | "drift" | "missing" | "unsafe" | "shared";
  sha: string | null;
  reason?: string;
};

/** The hook must be installed as an executable regular file. */
const HOOK_MODE = 0o755;

/**
 * A home, its hooks directory and the hook itself must be real directories and
 * a regular file owned by this user: a symlink anywhere on the path would let
 * an install overwrite whatever it points to, so it is refused (fail closed).
 */
/**
 * Every ancestor of `path` must be a real directory: the path must equal its
 * own resolved real path. A symlink anywhere above it would redirect writes
 * outside the intended tree (R2 fence 273, second round).
 */
function ancestorReason(path: string): string | null {
  let real: string;
  try { real = realpathSync(path); } catch { return `${path} cannot be resolved`; }
  return real === resolve(path) ? null : `${path} has a symlink on its path (resolves to ${real})`;
}

function unsafeReason(home: string): string | null {
  const ancestor = ancestorReason(home);
  if (ancestor) return ancestor;
  const uid = process.getuid?.();
  const check = (path: string, kind: "dir" | "file", required: boolean): string | null => {
    let st;
    try { st = lstatSync(path); } catch { return required ? `${path} missing` : null; }
    if (st.isSymbolicLink()) return `${path} is a symlink`;
    if (kind === "dir" ? !st.isDirectory() : !st.isFile()) return `${path} is not a ${kind === "dir" ? "directory" : "regular file"}`;
    if (uid !== undefined && st.uid !== uid) return `${path} is not owned by this user`;
    return null;
  };
  return check(home, "dir", true) ?? check(join(home, "hooks"), "dir", false) ?? check(join(home, "hooks", HOOK_NAME), "file", false);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function defaultHomes(home = homedir()): string[] {
  const homes = [join(home, ".claude")];
  for (const entry of readdirSync(home).sort()) {
    if (!/^\.claude-[A-Za-z0-9_-]+$/.test(entry)) continue;
    if (existsSync(join(home, entry, "hooks", HOOK_NAME))) homes.push(join(home, entry));
  }
  return homes;
}

/**
 * Several homes may share one hooks directory (~/.claude-c/hooks ->
 * ~/.claude/hooks on the live host). Such a home is "shared": it is never
 * written through, and it is current exactly when the home that owns the real
 * directory is. Only an exact alias of another managed home's real hooks
 * directory qualifies; any other symlink stays unsafe.
 */
function sharedOwner(home: string, homes: string[]): string | null {
  const hooks = join(home, "hooks");
  let st;
  try { st = lstatSync(hooks); } catch { return null; }
  if (!st.isSymbolicLink()) return null;
  if (ancestorReason(home)) return null;          // the aliasing home itself must sit on a real path
  try {
    const own = lstatSync(home);                 // the home itself must still be a real, owned directory
    if (own.isSymbolicLink() || !own.isDirectory() || (process.getuid && own.uid !== process.getuid())) return null;
  } catch { return null; }
  let target: string;
  try { target = realpathSync(hooks); } catch { return null; }
  for (const other of homes) {
    if (other === home) continue;
    const otherHooks = join(other, "hooks");
    try {
      if (!lstatSync(otherHooks).isSymbolicLink() && realpathSync(otherHooks) === target && !unsafeReason(other)) return other;
    } catch { /* not a candidate */ }
  }
  return null;
}

export function inspect(homes: string[], canonical = CANONICAL): { canonicalSha: string; homes: HomeState[] } {
  const canonicalSha = sha256(canonical);
  const owned = homes.map((home): HomeState => {
      const path = join(home, "hooks", HOOK_NAME);
      const owner = sharedOwner(home, homes);
      if (owner) return { home, path, state: "shared", sha: null, reason: `shares ${join(owner, "hooks")}` };
      const reason = unsafeReason(home);
      if (reason) return { home, path, state: "unsafe", sha: null, reason };
      if (!existsSync(path)) return { home, path, state: "missing", sha: null };
      const sha = sha256(path);
      // Same content with the wrong mode is drift: the hook must be executable.
      const same = sha === canonicalSha && (lstatSync(path).mode & 0o777) === HOOK_MODE;
      return { home, path, state: same ? "same" : "drift", sha };
    });
  return { canonicalSha, homes: owned };
}

/** A shared home passes when the home owning its hooks directory is current. */
export function failed(states: HomeState[]): HomeState[] {
  return states.filter((s) => {
    if (s.state === "same") return false;
    if (s.state !== "shared") return true;
    const owner = s.reason!.replace(/^shares /, "");
    return states.find((o) => join(o.home, "hooks") === owner)?.state !== "same";
  });
}

/** Write `data` to a new file that must not exist yet (no follow, no overwrite). */
function writeExclusive(path: string, data: Buffer, mode: number): void {
  const fd = openSync(path, "wx", mode);
  try { writeSync(fd, data); fchmodSync(fd, mode); fsyncSync(fd); } finally { closeSync(fd); }
}

function backupPath(path: string, stamp: string): string {
  for (let n = 0; ; n++) {
    const candidate = `${path}.bak-${stamp}${n ? `-${n}` : ""}`;
    try { lstatSync(candidate); } catch { return candidate; }    // nothing there, not even a dangling link
  }
}

export function install(homes: string[], canonical = CANONICAL, stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)): HomeState[] {
  const data = readFileSync(canonical);
  for (const state of inspect(homes, canonical).homes) {
    if (state.state === "same" || state.state === "unsafe" || state.state === "shared") continue;   // reported, never written
    const hooks = join(state.home, "hooks");
    if (!existsSync(hooks)) continue;                                   // never create a config home or hooks dir
    // Back up the old copy to a fresh, private file (exclusive create, 0600).
    // A mode-only repair (same content) needs no backup.
    if (state.state === "drift" && state.sha !== sha256(canonical)) {
      writeExclusive(backupPath(state.path, stamp), readFileSync(state.path), 0o600);
    }
    // Stage beside the target and rename over it: the hook is never half-written.
    const staged = `${state.path}.new-${process.pid}-${Date.now()}`;
    writeExclusive(staged, data, HOOK_MODE);
    try { renameSync(staged, state.path); } catch (error) { try { unlinkSync(staged); } catch {} throw error; }
  }
  return inspect(homes, canonical).homes;
}

export function main(args = process.argv.slice(2)): number {
  const homes: string[] = [];
  let mode: "check" | "install" = "check";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--check") mode = "check";
    else if (args[i] === "--install") mode = "install";
    else if (args[i] === "--home" && args[i + 1]) homes.push(resolve(args[++i]!));
    else { console.error("usage: sync-greeting-hook.ts [--check|--install] [--home DIR]..."); return 2; }
  }
  const targets = homes.length ? homes : defaultHomes();
  const states = mode === "install" ? install(targets) : inspect(targets).homes;
  const canonicalSha = inspect([], CANONICAL).canonicalSha;
  console.log(`canonical ${CANONICAL} sha256 ${canonicalSha}`);
  for (const s of states) console.log(`${s.state.padEnd(7)} ${s.path}${s.sha && s.state !== "same" ? ` sha256 ${s.sha}` : ""}${s.reason ? ` (${s.reason})` : ""}`);
  return failed(states).length ? 1 : 0;
}

if (import.meta.main) process.exitCode = main();
