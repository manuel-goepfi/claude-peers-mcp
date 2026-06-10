// Lifecycle hardening regression tests (2026-06-10).
//
// Root cause these guard against: an MCP stdio server outliving its client.
// Before the fix, a hard-killed Claude session (or harness-side MCP reconnect)
// left server.ts running and heartbeating forever — the broker saw a live
// ghost on the seat, new sessions got #N-suffixed names, and rehydration never
// fired because it requires the old PID to be dead. Live evidence on
// 2026-06-10: 4x ux.2 registered on one tmux pane, one server reparented to
// systemd (ppid=1) still heartbeating.
//
// Exit paths under test:
//   (a) stdin EOF  -> unregister + exit (contractual stdio death signal)
//   (b) parent died -> watchdog notices reparenting -> unregister + exit
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer } from "node:net";

const BROKER_SCRIPT = new URL("../broker.ts", import.meta.url).pathname;
const SERVER_SCRIPT = new URL("../server.ts", import.meta.url).pathname;
const TEST_DB = "/tmp/claude-peers-test-lifecycle.db";
const TEST_TOKEN_FILE = "/tmp/claude-peers-test-lifecycle-bridge.token";

let BROKER_PORT = 0;
let brokerProc: ReturnType<typeof Bun.spawn> | null = null;

async function findFreeBrokerPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`broker /health never responded within ${timeoutMs}ms`);
}

function peerRows(): { id: string; pid: number }[] {
  const db = new Database(TEST_DB, { readonly: true });
  try {
    return db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  } finally {
    db.close();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(150);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

function serverEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  // CLAUDE_PEERS_DB is passed so that, if ensureBroker ever races and spawns
  // its own broker, it still targets the test DB rather than production.
  // CLAUDE_PEER_NAME pins the name so no tmux/ps detection ambiguity matters.
  return {
    ...process.env,
    CLAUDE_PEERS_PORT: String(BROKER_PORT),
    CLAUDE_PEERS_DB: TEST_DB,
    CLAUDE_PEERS_BRIDGE_TOKEN_FILE: TEST_TOKEN_FILE,
    CLAUDE_PEER_NAME: "lifecycle-test-peer",
    ...extra,
  };
}

beforeAll(async () => {
  Bun.spawnSync(["rm", "-f", TEST_DB, TEST_TOKEN_FILE]);
  BROKER_PORT = await findFreeBrokerPort();
  brokerProc = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(BROKER_PORT),
      CLAUDE_PEERS_DB: TEST_DB,
      CLAUDE_PEERS_BRIDGE_TOKEN_FILE: TEST_TOKEN_FILE,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForHealth(`http://127.0.0.1:${BROKER_PORT}`);
});

afterAll(() => {
  brokerProc?.kill();
  Bun.spawnSync(["rm", "-f", TEST_DB, TEST_TOKEN_FILE]);
});

describe("server.ts lifecycle", () => {
  test(
    "stdin EOF: server unregisters from broker and exits 0",
    async () => {
      const proc = Bun.spawn(["bun", SERVER_SCRIPT], {
        env: serverEnv(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      try {
        await waitFor(() => peerRows().length === 1, 10000, "server registration");

        proc.stdin.end();

        const exitCode = await Promise.race([
          proc.exited,
          Bun.sleep(8000).then(() => "timeout" as const),
        ]);
        expect(exitCode).toBe(0);
        await waitFor(() => peerRows().length === 0, 5000, "peer row unregistered");
      } finally {
        proc.kill();
      }
    },
    20000
  );

  test(
    "parent death: watchdog notices reparenting, unregisters, exits",
    async () => {
      // bash spawns the server then exits; the server inherits OUR stdin pipe
      // (held open by this test), so the stdin-EOF path cannot fire — only the
      // parent-death watchdog can. Heartbeat interval shrunk via env override.
      const wrapper = Bun.spawn(
        ["bash", "-c", `bun "${SERVER_SCRIPT}" & sleep 0.3`],
        {
          env: serverEnv({ CLAUDE_PEERS_HEARTBEAT_MS: "200" }),
          stdin: "pipe", // held open for the server's whole lifetime
          stdout: "ignore",
          stderr: "ignore",
        }
      );
      try {
        await waitFor(() => peerRows().length === 1, 10000, "server registration");
        const serverPid = peerRows()[0]!.pid;

        await wrapper.exited; // parent (bash) is now gone -> server reparented

        // Watchdog tick (200ms) should unregister and exit the server.
        await waitFor(() => peerRows().length === 0, 8000, "peer row unregistered after parent death");
        await waitFor(
          () => {
            try {
              process.kill(serverPid, 0);
              return false; // still alive
            } catch {
              return true; // ESRCH — exited
            }
          },
          8000,
          "server process exit after parent death"
        );
      } finally {
        wrapper.stdin.end();
        wrapper.kill();
      }
    },
    30000
  );
});
