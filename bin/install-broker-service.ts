#!/usr/bin/env bun
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  brokerServiceConfig,
  installedBrokerServiceIsCurrent,
  renderBrokerService,
  renderBrokerServiceDropIn,
  type BrokerServiceConfig,
} from "../shared/broker-service.ts";
import { openOwnerOnlyAppendLog } from "../shared/broker-client.ts";
import { fsyncDirectory } from "../shared/fs-durability.ts";

const backupSuffix = ".pre-claude-peers";

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  const uid = process.getuid?.() ?? -1;
  if (stat.isSymbolicLink() || !stat.isDirectory() || (uid >= 0 && stat.uid !== uid) || (stat.mode & 0o022) !== 0) {
    throw new Error(`unsafe service directory: ${path}`);
  }
}

function atomicWrite(path: string, content: string): boolean {
  ensureDirectory(dirname(path));
  if (existsSync(path)) {
    const stat = lstatSync(path);
    const uid = process.getuid?.() ?? -1;
    if (stat.isSymbolicLink() || !stat.isFile() || (uid >= 0 && stat.uid !== uid)) {
      throw new Error(`unsafe service file: ${path}`);
    }
    if (readFileSync(path, "utf8") === content) {
      chmodSync(path, 0o600);
      return false;
    }
  }
  const tmp = join(dirname(path), `.${path.split("/").pop()}.tmp-${process.pid}-${crypto.randomUUID()}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  fsyncDirectory(dirname(path));
  return true;
}

function backupOperatorFile(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  const uid = process.getuid?.() ?? -1;
  if (stat.isSymbolicLink() || !stat.isFile() || (uid >= 0 && stat.uid !== uid)) {
    throw new Error(`unsafe existing service file: ${path}`);
  }
  const content = readFileSync(path, "utf8");
  if (content.startsWith("# Managed by claude-peers")) return;
  const backup = `${path}${backupSuffix}`;
  if (existsSync(backup)) return;
  copyFileSync(path, backup);
  chmodSync(backup, 0o600);
  fsyncDirectory(dirname(path));
}

function executableExists(name: string): boolean {
  const probe = Bun.spawnSync(["sh", "-c", `command -v ${name}`], { stdout: "ignore", stderr: "ignore" });
  return probe.exitCode === 0;
}

function runChecked(command: string[], label: string): void {
  const result = Bun.spawnSync(command, { stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) {
    const detail = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
}

function verifyRendered(config: BrokerServiceConfig, unit: string, dropIn: string): void {
  if (process.env.CLAUDE_PEERS_INSTALL_SKIP_SYSTEMD === "1" || !executableExists("systemd-analyze")) return;
  const verifyDir = join(dirname(config.unitPath), `.claude-peers-verify-${process.pid}-${crypto.randomUUID()}`);
  const verifyUnit = join(verifyDir, "claude-peers-broker.service");
  const verifyDropIn = join(verifyDir, "claude-peers-broker.service.d", "10-claude-peers-paths.conf");
  try {
    atomicWrite(verifyUnit, unit);
    atomicWrite(verifyDropIn, dropIn);
    runChecked(["systemd-analyze", "--user", "verify", verifyUnit], "systemd unit verification");
  } finally {
    rmSync(verifyDir, { recursive: true, force: true });
  }
}

function reloadSystemd(): void {
  if (process.env.CLAUDE_PEERS_INSTALL_SKIP_SYSTEMD === "1") return;
  if (!executableExists("systemctl")) throw new Error("systemctl is unavailable; cannot reload the user manager");
  runChecked(["systemctl", "--user", "daemon-reload"], "systemd user daemon-reload");
}

export function installBrokerService(config = brokerServiceConfig()): { changed: boolean } {
  for (const statePath of [config.databasePath, config.bridgeTokenPath, config.backupPath, config.logPath]) {
    ensureDirectory(dirname(statePath));
  }
  closeSync(openOwnerOnlyAppendLog(config.logPath));
  const unit = renderBrokerService(config);
  const dropIn = renderBrokerServiceDropIn(config);
  verifyRendered(config, unit, dropIn);
  backupOperatorFile(config.unitPath);
  backupOperatorFile(config.dropInPath);
  const unitChanged = atomicWrite(config.unitPath, unit);
  const dropInChanged = atomicWrite(config.dropInPath, dropIn);
  const changed = unitChanged || dropInChanged;
  if (changed) reloadSystemd();
  return { changed };
}

function assertRestoreSafe(path: string, expectedManagedContent: string): void {
  const backup = `${path}${backupSuffix}`;
  if (existsSync(path)) {
    const stat = lstatSync(path);
    const uid = process.getuid?.() ?? -1;
    if (stat.isSymbolicLink() || !stat.isFile() || (uid >= 0 && stat.uid !== uid)) {
      throw new Error(`unsafe managed service file: ${path}`);
    }
    if (readFileSync(path, "utf8") !== expectedManagedContent) {
      throw new Error(`managed service file changed after installation; refusing to overwrite operator edits: ${path}`);
    }
  }
  if (existsSync(backup)) {
    const backupStat = lstatSync(backup);
    const uid = process.getuid?.() ?? -1;
    if (backupStat.isSymbolicLink() || !backupStat.isFile() || (uid >= 0 && backupStat.uid !== uid)) {
      throw new Error(`unsafe service backup: ${backup}`);
    }
  }
}

function restoreOrRemove(path: string): boolean {
  const backup = `${path}${backupSuffix}`;
  if (existsSync(backup)) {
    renameSync(backup, path);
    chmodSync(path, 0o600);
    fsyncDirectory(dirname(path));
    return true;
  }
  if (!existsSync(path)) return false;
  rmSync(path);
  fsyncDirectory(dirname(path));
  return true;
}

export function uninstallBrokerService(config = brokerServiceConfig()): { changed: boolean } {
  assertRestoreSafe(config.dropInPath, renderBrokerServiceDropIn(config));
  assertRestoreSafe(config.unitPath, renderBrokerService(config));
  const dropInChanged = restoreOrRemove(config.dropInPath);
  const unitChanged = restoreOrRemove(config.unitPath);
  const changed = dropInChanged || unitChanged;
  if (changed) reloadSystemd();
  return { changed };
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const command = args[0] ?? "install";
  try {
    const config = brokerServiceConfig();
    if (command === "--check" || command === "check") {
      if (!installedBrokerServiceIsCurrent(config)) {
        console.error("broker service is missing, stale, unsafe, or configured for different paths");
        return 1;
      }
      console.log("broker service is current");
      return 0;
    }
    if (command === "--uninstall" || command === "uninstall") {
      const result = uninstallBrokerService(config);
      console.log(result.changed ? "broker service uninstalled or restored" : "broker service already absent");
      return 0;
    }
    if (command !== "install") {
      console.error("usage: install-broker-service.ts [install|--check|--uninstall]");
      return 2;
    }
    const result = installBrokerService(config);
    console.log(result.changed ? "broker service installed" : "broker service already current");
    return 0;
  } catch (error) {
    console.error(`broker service error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
