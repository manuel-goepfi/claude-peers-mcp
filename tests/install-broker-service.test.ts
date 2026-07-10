import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installBrokerService, uninstallBrokerService } from "../bin/install-broker-service.ts";
import {
  brokerServiceConfig,
  installedBrokerServiceIsCurrent,
  renderBrokerService,
  renderBrokerServiceDropIn,
} from "../shared/broker-service.ts";

const roots: string[] = [];
const previousSkip = process.env.CLAUDE_PEERS_INSTALL_SKIP_SYSTEMD;

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "claude peers service "));
  roots.push(home);
  process.env.CLAUDE_PEERS_INSTALL_SKIP_SYSTEMD = "1";
  return brokerServiceConfig({
    ...process.env,
    HOME: home,
    CLAUDE_PEERS_DB: join(home, "state dir", "peers.db"),
    CLAUDE_PEERS_BRIDGE_TOKEN_FILE: join(home, "token dir", "bridge.token"),
    CLAUDE_PEERS_BACKUP: join(home, "backup dir", "peers.backup"),
    CLAUDE_PEERS_BROKER_LOG: join(home, "log dir", "broker.log"),
  });
}

afterEach(() => {
  if (previousSkip === undefined) delete process.env.CLAUDE_PEERS_INSTALL_SKIP_SYSTEMD;
  else process.env.CLAUDE_PEERS_INSTALL_SKIP_SYSTEMD = previousSkip;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("broker user-service installer", () => {
  test("renders hardened service and path-scoped owner-only drop-in", () => {
    const config = fixture();
    const result = installBrokerService(config);
    expect(result.changed).toBe(true);
    expect(installedBrokerServiceIsCurrent(config)).toBe(true);
    expect(lstatSync(config.unitPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(config.dropInPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(config.logPath).mode & 0o777).toBe(0o600);

    const unit = readFileSync(config.unitPath, "utf8");
    for (const directive of [
      "UMask=0077",
      "NoNewPrivileges=yes",
      "RestrictAddressFamilies=AF_UNIX AF_INET",
      "ProtectSystem=strict",
      "ProtectHome=read-only",
    ]) {
      expect(unit).toContain(directive);
    }
    expect(unit).toContain(`CLAUDE_PEERS_DB=${config.databasePath}`);
    expect(unit).toContain(`CLAUDE_PEERS_PORT=${config.port}`);
    expect(unit).toContain("StandardOutput=append:");
    expect(unit).toContain("\\x20");

    const dropIn = readFileSync(config.dropInPath, "utf8");
    for (const path of [config.databasePath, config.bridgeTokenPath, config.backupPath, config.logPath]) {
      expect(dropIn).toContain(`"${dirname(path)}"`);
    }
  });

  test("second install is byte and mtime stable", async () => {
    const config = fixture();
    installBrokerService(config);
    const unitBefore = statSync(config.unitPath).mtimeMs;
    const dropInBefore = statSync(config.dropInPath).mtimeMs;
    const unitBytes = readFileSync(config.unitPath);
    const dropInBytes = readFileSync(config.dropInPath);
    await Bun.sleep(20);

    const second = installBrokerService(config);
    expect(second.changed).toBe(false);
    expect(readFileSync(config.unitPath)).toEqual(unitBytes);
    expect(readFileSync(config.dropInPath)).toEqual(dropInBytes);
    expect(statSync(config.unitPath).mtimeMs).toBe(unitBefore);
    expect(statSync(config.dropInPath).mtimeMs).toBe(dropInBefore);
  });

  test("uninstall removes owned files and restores pre-existing operator files", () => {
    const config = fixture();
    mkdirSync(dirname(config.unitPath), { recursive: true });
    mkdirSync(dirname(config.dropInPath), { recursive: true });
    writeFileSync(config.unitPath, "operator unit\n", { mode: 0o600 });
    writeFileSync(config.dropInPath, "operator drop-in\n", { mode: 0o600 });

    installBrokerService(config);
    expect(readFileSync(config.unitPath, "utf8")).toBe(renderBrokerService(config));
    expect(readFileSync(config.dropInPath, "utf8")).toBe(renderBrokerServiceDropIn(config));
    expect(uninstallBrokerService(config).changed).toBe(true);
    expect(readFileSync(config.unitPath, "utf8")).toBe("operator unit\n");
    expect(readFileSync(config.dropInPath, "utf8")).toBe("operator drop-in\n");
  });

  test("uninstall removes a fresh managed install", () => {
    const config = fixture();
    installBrokerService(config);
    uninstallBrokerService(config);
    expect(existsSync(config.unitPath)).toBe(false);
    expect(existsSync(config.dropInPath)).toBe(false);
  });

  test("renders a custom broker port into the managed environment", () => {
    const config = { ...fixture(), port: 7999 };
    expect(renderBrokerService(config)).toContain('Environment="CLAUDE_PEERS_PORT=7999"');
  });

  test("uninstall refuses to overwrite post-install operator edits", () => {
    const config = fixture();
    mkdirSync(dirname(config.unitPath), { recursive: true });
    writeFileSync(config.unitPath, "operator predecessor\n", { mode: 0o600 });
    installBrokerService(config);
    writeFileSync(config.unitPath, `${renderBrokerService(config)}# later operator edit\n`, { mode: 0o600 });
    expect(() => uninstallBrokerService(config)).toThrow(/operator edits/);
    expect(readFileSync(config.unitPath, "utf8")).toContain("later operator edit");
    expect(readFileSync(config.dropInPath, "utf8")).toBe(renderBrokerServiceDropIn(config));
  });

  test("refuses a symlinked service target", () => {
    const config = fixture();
    mkdirSync(dirname(config.unitPath), { recursive: true });
    const target = join(dirname(config.unitPath), "operator-target.service");
    writeFileSync(target, renderBrokerService(config), { mode: 0o600 });
    symlinkSync(target, config.unitPath);
    expect(() => installBrokerService(config)).toThrow(/unsafe existing service file|unsafe service file/);
    expect(readFileSync(target, "utf8")).toBe(renderBrokerService(config));
  });
});
