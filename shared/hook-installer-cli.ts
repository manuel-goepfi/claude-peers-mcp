import { appendFileSync, realpathSync } from "node:fs";
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

/**
 * Record every peer-hook removal, because a silent one is nearly unfindable.
 *
 * When ~/.claude-b lost its three peer hooks the only evidence was a settings
 * file that had quietly shrunk by 719 bytes; attributing it took a full day of
 * diffing pre-write backups. The removal path printed NOTHING — the success line
 * below reports the install target, never the file the hooks were taken out of.
 * One append-only line turns that into a lookup.
 *
 * Deliberately best-effort: an unwritable audit log must never block or fail an
 * install. Failing closed here would trade a findability problem for an outage.
 */
function auditHookRemoval(path: string, label: string, count: number, reason: string, args: string[]): void {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    removed_from: path,
    client: label,
    hooks_removed: count,
    reason,
    pid: process.pid,
    cwd: process.cwd(),
    claude_config_dir: process.env.CLAUDE_CONFIG_DIR ?? null,
    argv: args,
  });
  console.error(`${label} peer hooks REMOVED from ${path} (${count} hook(s), ${reason})`);
  try {
    appendFileSync(resolve(process.env.HOME ?? "/tmp", ".claude-peers-hook-audit.log"), `${line}\n`);
  } catch {
    // Audit is advisory; never let it break the install.
  }
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
    const replace = args.includes("--replace");
    if (restorePath) {
      if (check || uninstall || replace) throw new Error("--restore cannot be combined with check, uninstall, or replace");
      restoreJsonConfig(configPath, resolve(restorePath), (document) => installClientHooks(document, client, sourceRepo), {
        pauseBeforeWriteMs: Number(process.env.CLAUDE_PEERS_INSTALL_TEST_PAUSE_MS ?? "0"),
      });
      console.log(`restored ${label} peer hook configuration: ${configPath}`);
      return 0;
    }

    let alternatePathToRemove: string | null = null;
    let alternateHookCount = 0;
    if (!uninstall) {
      const alternatePath = scope === "user"
        ? resolve(process.cwd(), configRelativePath)
        : userConfigPath;
      if (alternatePath !== configPath) {
        const alternate = readSafeJsonConfig(alternatePath);
        const classification = alternate ? classifyClientHooks(alternate, client, sourceRepo) : null;
        if (classification && classification.exact + classification.stale > 0) {
          if (check) {
            console.error(`${label} hook installer error: duplicate hook scope is active; use install --replace to transfer ownership`);
            return 1;
          }
          if (!replace) throw new Error(`duplicate ${label} hook scope exists; pass --replace to transfer ownership`);
          // Removing the USER scope is a downgrade, not a de-duplication: user-scope
          // hooks serve every session of that account, project-scope hooks serve one
          // repo. Trading the first for the second silently leaves every OTHER repo's
          // lanes with no drain path at all.
          //
          // It is also cross-ACCOUNT, which `--replace` does not imply and cannot
          // express: userConfigPath is resolved from CLAUDE_CONFIG_DIR at install
          // time (see above), so the account whose hooks get deleted is whichever
          // one the invoking shell happened to point at — not one the operator named.
          // Measured 2026-07-31: ~/.claude-b lost all three peer hooks (SessionStart,
          // Stop, UserPromptSubmit) while ~/.claude kept its identical set. Every
          // account-B lane then received zero mail for a full day: the poller nudged
          // them, but the nudge text for a claude lane asserts the drain hook already
          // delivered, so those lanes were told mail had arrived AND told not to
          // fetch it. Silent, and it survived two reinstalls before being found.
          if (scope === "project" && alternatePath === userConfigPath && !args.includes("--drop-user-scope")) {
            throw new Error(
              `refusing to remove user-scope ${label} peer hooks at ${alternatePath} during a project-scope install — ` +
              `that would disable peer delivery for every OTHER project of this account ` +
              `(config dir resolved from ${options.userConfigDirEnv ?? "HOME"}). ` +
              `Install to --scope user instead, or pass --drop-user-scope if the downgrade is intended.`,
            );
          }
          alternatePathToRemove = alternatePath;
          alternateHookCount = classification.exact + classification.stale;
        }
      }
    }

    if (uninstall && !check) {
      // try/catch is load-bearing, not defensive habit: readSafeJsonConfig REJECTS a
      // config whose mode or owner it dislikes, and the uninstall path below tolerates
      // several such files. Letting the audit read throw would make observability
      // change behaviour — it broke 3 previously-green installer tests exactly that
      // way. An unauditable removal is worth strictly more than a blocked one.
      try {
        const existing = readSafeJsonConfig(configPath);
        const found = existing ? classifyClientHooks(existing, client, sourceRepo) : null;
        if (found && found.exact + found.stale > 0) {
          auditHookRemoval(configPath, label, found.exact + found.stale, "explicit-uninstall", args);
        }
      } catch {
        // Unreadable/unsafe config — the uninstall itself still decides what to do.
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

    if (alternatePathToRemove) {
      try {
        auditHookRemoval(alternatePathToRemove, label, alternateHookCount, "scope-transfer", args);
        installJsonConfig(alternatePathToRemove, (document) => uninstallClientHooks(document, client, sourceRepo));
      } catch (transferError) {
        try {
          if (result.backupPath) {
            restoreJsonConfig(configPath, result.backupPath, (document) => installClientHooks(document, client, sourceRepo));
          } else if (result.changed) {
            installJsonConfig(configPath, (document) => uninstallClientHooks(document, client, sourceRepo));
          }
        } catch (rollbackError) {
          throw new Error(`scope transfer failed and target rollback also failed: ${String(transferError)}; ${String(rollbackError)}`);
        }
        throw transferError;
      }
    }
    if (result.backupPath) console.log(`backup: ${result.backupPath}`);
    console.log(`${uninstall ? "uninstalled" : result.changed ? "installed" : "already current"} ${label} peer hooks: ${configPath}`);
    return 0;
  } catch (error) {
    console.error(`${options.label} hook installer error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
