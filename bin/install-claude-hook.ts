#!/usr/bin/env bun
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { runHookInstaller } from "../shared/hook-installer-cli.ts";

const sourceRepo = realpathSync(resolve(import.meta.dir, ".."));
const requiredCommands = ["awk", "bash", "curl", "flock", "jq", "ps", "sed", "tail"];

export function missingClaudeHookDependencies(which: (command: string) => string | null = Bun.which): string[] {
  return requiredCommands.filter((command) => !which(command));
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  if (!args.includes("--uninstall") && !args.includes("uninstall") && !args.includes("--restore")) {
    const missing = missingClaudeHookDependencies();
    if (missing.length > 0) {
      console.error(`Claude hook installer error: missing required commands: ${missing.join(", ")}`);
      return 1;
    }
  }
  return runHookInstaller({
    args,
    client: "claude",
    configRelativePath: ".claude/settings.json",
    label: "Claude",
    sourceRepo,
    userConfigDirEnv: "CLAUDE_CONFIG_DIR",
  });
}
if (import.meta.main) process.exitCode = await main();
