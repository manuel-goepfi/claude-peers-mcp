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
 *   sync-greeting-hook.ts --install          back up each copy, install the repo
 *                                             file, then verify (exit 1 if any differs)
 *   --home DIR (repeatable)                  limit to these config homes
 *
 * Default homes: ~/.claude plus every ~/.claude-* that already has the hook.
 * A home without the hook is reported as missing and never created by --check.
 */
import { chmodSync, copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const HOOK_NAME = "claude-peers-session-greeting.sh";
const CANONICAL = resolve(import.meta.dir, "..", "hooks", HOOK_NAME);

export type HomeState = { home: string; path: string; state: "same" | "drift" | "missing"; sha: string | null };

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

export function inspect(homes: string[], canonical = CANONICAL): { canonicalSha: string; homes: HomeState[] } {
  const canonicalSha = sha256(canonical);
  return {
    canonicalSha,
    homes: homes.map((home) => {
      const path = join(home, "hooks", HOOK_NAME);
      if (!existsSync(path)) return { home, path, state: "missing" as const, sha: null };
      const sha = sha256(path);
      return { home, path, state: sha === canonicalSha ? "same" as const : "drift" as const, sha };
    }),
  };
}

export function install(homes: string[], canonical = CANONICAL, stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)): HomeState[] {
  for (const home of homes) {
    const path = join(home, "hooks", HOOK_NAME);
    if (!existsSync(join(home, "hooks"))) continue;           // never create a config home
    if (existsSync(path)) {
      if (sha256(path) === sha256(canonical)) continue;
      copyFileSync(path, `${path}.bak-${stamp}`);
    }
    copyFileSync(canonical, path);
    chmodSync(path, 0o755);
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
  for (const s of states) console.log(`${s.state.padEnd(7)} ${s.path}${s.sha && s.state !== "same" ? ` sha256 ${s.sha}` : ""}`);
  return states.some((s) => s.state !== "same") ? 1 : 0;
}

if (import.meta.main) process.exitCode = main();
