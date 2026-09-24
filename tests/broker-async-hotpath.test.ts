import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const broker = readFileSync(new URL("../broker.ts", import.meta.url), "utf8");
const panes = readFileSync(new URL("../shared/runtime-pane-snapshot.ts", import.meta.url), "utf8");
const native = readFileSync(new URL("../shared/native-claude-proof.ts", import.meta.url), "utf8");

test("broker heartbeat and PID claims have no synchronous child process", () => {
  const heartbeat = broker.split('case "/heartbeat":')[1]?.split('case "/metrics":')[0];
  const claim = broker.split('if (path === "/claim-by-pid" ||')[1]?.split("// S2/S6: authenticate")[0];
  expect(heartbeat).toBeDefined();
  expect(claim).toBeDefined();
  expect(heartbeat).not.toContain("spawnSync");
  expect(claim).not.toContain("spawnSync");
  expect(panes.split("async function readPanesAsync")[1]).toContain("Bun.spawn(");
  expect(panes.split("async function readPanesAsync")[1]).not.toContain("spawnSync");
  expect(native).not.toContain("spawnSync");
});
