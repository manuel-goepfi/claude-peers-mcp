#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

function findBinary(name: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function version(binary: string): Promise<string> {
  const proc = Bun.spawn([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error("version preflight failed");
  return stdout.trim().split("\n")[0] ?? "unknown";
}

async function main(): Promise<number> {
  const isolatedHome = process.env.CLAUDE_PEERS_RELEASE_HOME;
  if (process.env.CLAUDE_PEERS_RELEASE_SMOKE !== "1" || !isolatedHome || process.env.HOME !== isolatedHome) {
    console.error(JSON.stringify({ status: "blocked", reason: "isolated release host/account is not explicitly armed" }));
    return 2;
  }
  const binaries = Object.fromEntries(["claude", "codex", "gemini"].map((name) => [name, findBinary(name)])) as Record<string, string | null>;
  if (Object.values(binaries).some((binary) => !binary)) {
    console.error(JSON.stringify({ status: "blocked", reason: "one or more release-pinned client binaries are missing" }));
    return 2;
  }
  const versions = Object.fromEntries(await Promise.all(Object.entries(binaries).map(async ([name, binary]) => [name, await version(binary!)])));
  console.error(JSON.stringify({ status: "blocked", reason: "authenticated three-client journey requires A3 release-host orchestration", versions }));
  return 2;
}

if (import.meta.main) process.exitCode = await main();
