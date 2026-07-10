import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface BrokerServiceConfig {
  home: string;
  port: number;
  bunPath: string;
  brokerScript: string;
  databasePath: string;
  bridgeTokenPath: string;
  backupPath: string;
  logPath: string;
  unitPath: string;
  dropInPath: string;
}

function absolute(value: string, base: string): string {
  return resolve(base, value);
}

export function brokerServiceConfig(env: Record<string, string | undefined> = process.env): BrokerServiceConfig {
  const home = realpathSync(env.HOME ?? "");
  const port = Number(env.CLAUDE_PEERS_PORT ?? "7899");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CLAUDE_PEERS_PORT must be an integer from 1 to 65535");
  const brokerScript = realpathSync(new URL("../broker.ts", import.meta.url).pathname);
  const databasePath = absolute(env.CLAUDE_PEERS_DB ?? `${home}/.claude-peers.db`, home);
  const bridgeTokenPath = absolute(env.CLAUDE_PEERS_BRIDGE_TOKEN_FILE ?? `${home}/.claude-peers-bridge.token`, home);
  const backupPath = absolute(env.CLAUDE_PEERS_BACKUP ?? `${databasePath}.backup`, home);
  const logPath = absolute(env.CLAUDE_PEERS_BROKER_LOG ?? `${home}/.claude-peers-broker.log`, home);
  return {
    home,
    port,
    bunPath: realpathSync(process.execPath),
    brokerScript,
    databasePath,
    bridgeTokenPath,
    backupPath,
    logPath,
    unitPath: `${home}/.config/systemd/user/claude-peers-broker.service`,
    dropInPath: `${home}/.config/systemd/user/claude-peers-broker.service.d/10-claude-peers-paths.conf`,
  };
}

function quote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("systemd value contains a control character");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function environment(name: string, value: string): string {
  return `Environment=${quote(`${name}=${value}`)}`;
}

function unitWord(value: string): string {
  let rendered = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    rendered += /[A-Za-z0-9/_.-]/.test(char) ? char : `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return rendered;
}

export function renderBrokerService(config: BrokerServiceConfig): string {
  return `# Managed by claude-peers. Use bin/install-broker-service.ts; do not edit in place.
[Unit]
Description=claude-peers broker
After=default.target

[Service]
Type=simple
ExecStart=${quote(config.bunPath)} ${quote(config.brokerScript)}
Restart=on-failure
RestartSec=2s
UMask=0077
NoNewPrivileges=yes
RestrictAddressFamilies=AF_UNIX AF_INET
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
${environment("HOME", config.home)}
${environment("CLAUDE_PEERS_PORT", String(config.port))}
${environment("CLAUDE_PEERS_DB", config.databasePath)}
${environment("CLAUDE_PEERS_BRIDGE_TOKEN_FILE", config.bridgeTokenPath)}
${environment("CLAUDE_PEERS_BACKUP", config.backupPath)}
${environment("CLAUDE_PEERS_BROKER_LOG", config.logPath)}
${environment("CLAUDE_PEERS_OWNER_MODE", "systemd")}
StandardOutput=append:${unitWord(config.logPath)}
StandardError=append:${unitWord(config.logPath)}

[Install]
WantedBy=default.target
`;
}

export function renderBrokerServiceDropIn(config: BrokerServiceConfig): string {
  const parents = [...new Set([
    dirname(config.databasePath),
    dirname(config.bridgeTokenPath),
    dirname(config.backupPath),
    dirname(config.logPath),
  ])].sort();
  return `# Managed by claude-peers. Grants writes only to configured state parents.
[Service]
ReadWritePaths=${parents.map(quote).join(" ")}
`;
}

function secureExactFile(path: string, expected: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const stat = lstatSync(path);
    const uid = process.getuid?.() ?? -1;
    return stat.isFile() && !stat.isSymbolicLink() && (uid < 0 || stat.uid === uid) &&
      (stat.mode & 0o077) === 0 && readFileSync(path, "utf8") === expected;
  } catch {
    return false;
  }
}

function safeStateParent(path: string): boolean {
  try {
    const stat = lstatSync(dirname(path));
    const uid = process.getuid?.() ?? -1;
    return stat.isDirectory() && !stat.isSymbolicLink() && (uid < 0 || stat.uid === uid) && (stat.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

export function installedBrokerServiceIsCurrent(config: BrokerServiceConfig): boolean {
  return [config.databasePath, config.bridgeTokenPath, config.backupPath, config.logPath].every(safeStateParent) &&
    secureExactFile(config.unitPath, renderBrokerService(config)) &&
    secureExactFile(config.dropInPath, renderBrokerServiceDropIn(config));
}
