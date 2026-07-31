import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { assertSafeCloneForUserInstall, installJsonConfig, readSafeJsonConfig, restoreJsonConfig } from "./config-installer.ts";
import { classifyClientHooks, installClientHooks, uninstallClientHooks, type HookClient } from "./hook-config.ts";

export interface HookInstallerOptions {
  args: string[];
  client: HookClient;
  configRelativePath: string;
  label: string;
  sourceRepo: string;
  userConfigDirEnv?: string;
}

export async function runHookInstaller(options: HookInstallerOptions): Promise<number> {
  const { args, client, configRelativePath, label, sourceRepo } = options;
  try {
    const scopeIndex = args.indexOf("--scope");
    const restoreIndex = args.indexOf("--restore");
    const explicitScope = scopeIndex >= 0 ? args[scopeIndex + 1] : undefined;
    const restorePath = restoreIndex >= 0 ? args[restoreIndex + 1] : undefined;
    if (scopeIndex >= 0 && !explicitScope) throw new Error("--scope requires user or project");
    if (explicitScope && explicitScope !== "user" && explicitScope !== "project") throw new Error("--scope must be user or project");
    if (restoreIndex >= 0 && !restorePath) throw new Error("--restore requires a backup path");
    if (args.includes("--drop-user-scope")) {
      throw new Error(
        "--drop-user-scope is no longer supported; install the desired scope, then explicitly run --uninstall for the scope you no longer want",
      );
    }
    const positional = args.find((arg, index) =>
      !arg.startsWith("--") &&
      (scopeIndex < 0 || index !== scopeIndex + 1) &&
      (restoreIndex < 0 || index !== restoreIndex + 1) &&
      !["install", "check", "uninstall"].includes(arg),
    );
    const scope = explicitScope ?? (positional ? "project" : "user");
    const home = realpathSync(process.env.HOME ?? "");
    const projectRoot = resolve(positional ?? process.cwd());
    const configuredUserDir = options.userConfigDirEnv ? process.env[options.userConfigDirEnv] : undefined;
    const userConfigPath = configuredUserDir
      ? resolve(configuredUserDir, basename(configRelativePath))
      : resolve(home, configRelativePath);
    if (scope === "user") assertSafeCloneForUserInstall(sourceRepo);
    const configPath = scope === "user" ? userConfigPath : resolve(projectRoot, configRelativePath);
    const check = args.includes("--check") || args.includes("check");
    const uninstall = args.includes("--uninstall") || args.includes("uninstall");
    if (restorePath) {
      if (check || uninstall || args.includes("--replace")) throw new Error("--restore cannot be combined with check, uninstall, or replace");
      restoreJsonConfig(configPath, resolve(restorePath), (document) => installClientHooks(document, client, sourceRepo), {
        pauseBeforeWriteMs: Number(process.env.CLAUDE_PEERS_INSTALL_TEST_PAUSE_MS ?? "0"),
      });
      console.log(`restored ${label} peer hook configuration: ${configPath}`);
      return 0;
    }

    if (!uninstall) {
      const alternatePath = scope === "user"
        ? resolve(process.cwd(), configRelativePath)
        : userConfigPath;
      if (alternatePath !== configPath) {
        const alternate = readSafeJsonConfig(alternatePath);
        const classification = alternate ? classifyClientHooks(alternate, client, sourceRepo) : null;
        if (classification && classification.exact + classification.stale > 0) {
          if (check) {
            console.error(`${label} hook installer error: duplicate hook scope is active; explicitly uninstall the scope you no longer want`);
            return 1;
          }
          console.error(
            `${label} hook installer warning: duplicate hook scope is active; no hooks will be removed from ${alternatePath}. ` +
            "Explicitly run --uninstall for the scope you no longer want.",
          );
        }
      }
    }

    const result = installJsonConfig(
      configPath,
      (document) => uninstall
        ? uninstallClientHooks(document, client, sourceRepo)
        : installClientHooks(document, client, sourceRepo),
      { check, pauseBeforeWriteMs: Number(process.env.CLAUDE_PEERS_INSTALL_TEST_PAUSE_MS ?? "0") },
    );
    if (check) {
      if (result.needsChange) {
        console.error(`${label} peer hooks are not current: ${configPath}`);
        return 1;
      }
      console.log(`${label} peer hooks are current: ${configPath}`);
      return 0;
    }
    if (result.backupPath) console.log(`backup: ${result.backupPath}`);
    console.log(`${uninstall ? "uninstalled" : result.changed ? "installed" : "already current"} ${label} peer hooks: ${configPath}`);
    return 0;
  } catch (error) {
    console.error(`${options.label} hook installer error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
