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

test("the periodic sweep proves runtime groups from an async pane snapshot", () => {
  const sweep = broker.split("async function sweepStalePeers()")[1]?.split("// Once-per-failure latches")[0];
  expect(sweep).toBeDefined();
  expect(sweep).not.toContain("spawnSync");
  // The reap stage primes pane rows asynchronously, then proves inside an
  // async-only snapshot, so a cache miss returns "unproven" instead of
  // running tmux on the event loop.
  expect(sweep).toMatch(/await withRuntimePaneSnapshot\(async \(\) => \{\s*await primeLivePaneProofs\(\{\}, "\/sweep"\);\s*liveAndFreshPeers\(selectAllPeers\.all\(\) as Peer\[\]\);\s*\}, true\);/);
  expect(broker).toMatch(/setInterval\(cleanStalePeers, 30_000\)/);
  expect(broker).toMatch(/if \(sweepInFlight\) return;/);
});

test("Codex keeper birth time uses the startup clock tick, not getconf per call", () => {
  const keeper = broker.split("function nativeCodexKeeper(")[1]?.split("\nfunction ")[0];
  expect(keeper).toBeDefined();
  expect(keeper).not.toContain("spawnSync");
  expect(keeper).not.toContain("CLK_TCK");
  expect(keeper).toContain("clockTicksPerSecond()");
  expect(broker).not.toMatch(/spawnSync\(\["getconf"/);
});

test("an async pane snapshot never falls back to a synchronous tmux read", async () => {
  const { runtimePaneRow, withRuntimePaneSnapshot } = await import("../shared/runtime-pane-snapshot.ts");
  let reads = 0;
  const read = () => { reads++; return "1\t2\t%1\t$1\tsession"; };
  expect(withRuntimePaneSnapshot(() => runtimePaneRow("/nonexistent/sock", "%1", read), true)).toBeNull();
  expect(reads).toBe(0);
  // The synchronous mode still reads once per request snapshot.
  expect(withRuntimePaneSnapshot(() => runtimePaneRow("/nonexistent/sock", "%1", read))).toContain("%1");
  expect(reads).toBe(1);
});
