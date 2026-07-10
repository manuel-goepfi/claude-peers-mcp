import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { startTestBroker, type TestBroker } from "./helpers/test-broker.ts";

const running = new Set<TestBroker>();

afterEach(async () => {
  await Promise.all([...running].map((broker) => broker.stop()));
  running.clear();
});

describe("shared test broker fixture", () => {
  test("starts on an assigned port with isolated state and cleans up", async () => {
    const broker = await startTestBroker({ prefix: "fixture" });
    running.add(broker);

    expect(broker.port).toBeGreaterThan(0);
    expect(await fetch(`${broker.url}/health`).then((response) => response.ok)).toBe(true);
    expect(existsSync(broker.dbPath)).toBe(true);
    expect(existsSync(broker.tokenPath)).toBe(true);

    const root = broker.root;
    await broker.stop();
    running.delete(broker);
    expect(existsSync(root)).toBe(false);
  });

  test("two fixtures never share ports or files", async () => {
    const [left, right] = await Promise.all([
      startTestBroker({ prefix: "parallel-left" }),
      startTestBroker({ prefix: "parallel-right" }),
    ]);
    running.add(left);
    running.add(right);

    expect(left.port).not.toBe(right.port);
    expect(left.root).not.toBe(right.root);
    expect(left.dbPath).not.toBe(right.dbPath);
    expect(left.tokenPath).not.toBe(right.tokenPath);
  });

  test("production mode still rejects port zero", async () => {
    const proc = Bun.spawn(["bun", new URL("../broker.ts", import.meta.url).pathname], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        CLAUDE_PEERS_PORT: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("invalid port 0");
  });
});
