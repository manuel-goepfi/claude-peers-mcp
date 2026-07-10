import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PEERS_VERSION } from "../shared/version.ts";

describe("version compatibility contract", () => {
  test("runtime and package metadata share one version", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    expect(packageJson.version).toBeDefined();
    expect(PEERS_VERSION).toBe(packageJson.version as string);
  });

  test("broker and MCP server import the shared version", () => {
    const broker = readFileSync(new URL("../broker.ts", import.meta.url), "utf8");
    const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    expect(broker).toContain('import { PEERS_VERSION } from "./shared/version.ts"');
    expect(server).toContain('import { PEERS_VERSION } from "./shared/version.ts"');
    expect(broker).not.toContain('const BROKER_VERSION = "0.1.0"');
    expect(server).not.toContain('version: "0.1.0"');
  });
});
