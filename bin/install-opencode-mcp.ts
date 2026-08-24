#!/usr/bin/env bun
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertSafeCloneForUserInstall, installJsonConfig, restoreJsonConfig } from "../shared/config-installer.ts";
import { installOpenCodeMcp, uninstallOpenCodeMcp } from "../shared/opencode-config.ts";

const sourceRepo = realpathSync(resolve(import.meta.dir, ".."));

export async function main(
  args = process.argv.slice(2),
  environment: Record<string, string | undefined> = process.env,
  repoRoot = sourceRepo,
): Promise<number> {
  try {
    const restoreIndex = args.indexOf("--restore");
    const restorePath = restoreIndex >= 0 ? args[restoreIndex + 1] : undefined;
    if (restoreIndex >= 0 && !restorePath) throw new Error("--restore requires a backup path");
    const check = args.includes("--check") || args.includes("check");
    const uninstall = args.includes("--uninstall") || args.includes("uninstall");
    if (restorePath && (check || uninstall)) throw new Error("--restore cannot be combined with check or uninstall");

    const home = realpathSync(environment.HOME ?? "");
    const configBase = resolve(environment.XDG_CONFIG_HOME ?? join(home, ".config"));
    const configPath = join(configBase, "opencode", "opencode.jsonc");
    assertSafeCloneForUserInstall(repoRoot);

    if (restorePath) {
      restoreJsonConfig(configPath, resolve(restorePath), (document) => installOpenCodeMcp(document, repoRoot));
      console.log(`restored OpenCode peer MCP configuration: ${configPath}`);
      return 0;
    }

    const result = installJsonConfig(
      configPath,
      (document) => uninstall
        ? uninstallOpenCodeMcp(document, repoRoot)
        : installOpenCodeMcp(document, repoRoot),
      { check },
    );
    if (check) {
      if (result.needsChange) {
        console.error(`OpenCode peer MCP is not current: ${configPath}`);
        return 1;
      }
      console.log(`OpenCode peer MCP is current: ${configPath}`);
      return 0;
    }
    if (result.backupPath) console.log(`backup: ${result.backupPath}`);
    console.log(`${uninstall ? "uninstalled" : result.changed ? "installed" : "already current"} OpenCode peer MCP: ${configPath}`);
    return 0;
  } catch (error) {
    console.error(`OpenCode MCP installer error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
