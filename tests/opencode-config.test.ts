import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../bin/install-opencode-mcp.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function run(args: string[], document: Record<string, unknown> | null = null) {
  const root = mkdtempSync(join(process.env.HOME!, ".claude-peers-opencode-test-"));
  roots.push(root);
  const home = join(root, "home");
  const sourceRepo = join(root, "clone");
  const configBase = join(root, "config");
  const configDir = join(configBase, "opencode");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(sourceRepo, { recursive: true, mode: 0o700 });
  if (document) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(configDir, "opencode.jsonc"), `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  }
  const code = await main(args, { ...process.env, HOME: home, XDG_CONFIG_HOME: configBase }, sourceRepo);
  return { root, sourceRepo, configDir, path: join(configDir, "opencode.jsonc"), code };
}

describe("OpenCode MCP installer", () => {
  test("installs a local stdio MCP entry while preserving unrelated configuration", async () => {
    const r = await run([], { theme: "system", mcp: { other: { type: "remote", url: "https://example.invalid" } } });
    expect(r.code).toBe(0);
    const config = JSON.parse(readFileSync(r.path, "utf8")) as any;
    expect(config.theme).toBe("system");
    expect(config.mcp.other.url).toBe("https://example.invalid");
    expect(config.mcp["claude-peers"]).toMatchObject({
      type: "local",
      command: ["bun", join(r.sourceRepo, "server.ts")],
      enabled: true,
      environment: { CLAUDE_PEERS_CLIENT_TYPE: "opencode" },
    });
    expect(lstatSync(r.path).mode & 0o777).toBe(0o600);
    expect(readdirSync(r.configDir).some((name) => name.includes(".bak-"))).toBe(true);
  });

  test("check is a no-op only after the managed entry is current", async () => {
    const missing = await run(["--check"], { theme: "system" });
    expect(missing.code).toBe(1);

    const installed = await run([], { theme: "system" });
    expect(await main(
      ["--check"],
      { ...process.env, HOME: join(installed.root, "home"), XDG_CONFIG_HOME: join(installed.root, "config") },
      installed.sourceRepo,
    )).toBe(0);
  });

  test("uninstall removes only this clone's exact managed entry", async () => {
    const installed = await run([], { theme: "system" });
    expect(await main(
      ["--uninstall"],
      { ...process.env, HOME: join(installed.root, "home"), XDG_CONFIG_HOME: join(installed.root, "config") },
      installed.sourceRepo,
    )).toBe(0);
    const config = JSON.parse(readFileSync(installed.path, "utf8")) as Record<string, unknown>;
    expect(config).toEqual({ theme: "system" });
  });

  test("rejects group-writable configuration instead of silently trusting it", async () => {
    const root = mkdtempSync(join(process.env.HOME!, ".claude-peers-opencode-unsafe-"));
    roots.push(root);
    const home = join(root, "home");
    const configBase = join(root, "config");
    const sourceRepo = join(root, "clone");
    const configDir = join(configBase, "opencode");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(sourceRepo, { recursive: true, mode: 0o700 });
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const path = join(configDir, "opencode.jsonc");
    writeFileSync(path, "{}\n", { mode: 0o660 });
    chmodSync(path, 0o660);
    const code = await main([], { ...process.env, HOME: home, XDG_CONFIG_HOME: configBase }, sourceRepo);
    expect(code).toBe(1);
    expect(readFileSync(path, "utf8")).toBe("{}\n");
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});
