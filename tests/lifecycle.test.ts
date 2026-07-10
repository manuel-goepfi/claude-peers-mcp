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
import { readFileSync } from "node:fs";
import { startTestBroker, type TestBroker } from "./helpers/test-broker.ts";

const SERVER_SCRIPT = new URL("../server.ts", import.meta.url).pathname;
let TEST_DB = "";
let TEST_TOKEN_FILE = "";

let BROKER_PORT = 0;
let broker: TestBroker | null = null;

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

function isLiveNonZombieProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    const state = commandEnd >= 0 ? stat.slice(commandEnd + 2).split(" ")[0] : undefined;
    return state !== "Z";
  } catch {
    return false;
  }
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
  broker = await startTestBroker({ prefix: "lifecycle" });
  BROKER_PORT = broker.port;
  TEST_DB = broker.dbPath;
  TEST_TOKEN_FILE = broker.tokenPath;
});

afterAll(async () => {
  await broker?.stop();
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
        ["bash", "-c", `bun "${SERVER_SCRIPT}" <&0 & sleep 0.3`],
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
          () => !isLiveNonZombieProcess(serverPid),
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

  test(
    "bg-spare ancestor: server defers registration and ignores inherited env identity",
    async () => {
      // The extra positional args make bash's own ps row read
      // "bash -c ... bash --bg-spare /tmp/..." — the same marker a real
      // pre-warm daemon chain carries. CLAUDE_PEER_NAME is set on purpose:
      // a spare inherits a stale name from the daemon's launch shell, and
      // registering with it is exactly the ghost-duplicate bug.
      const wrapper = Bun.spawn(
        ["bash", "-c", `bun "${SERVER_SCRIPT}" <&0 & wait`, "bash", "--bg-spare", "/tmp/cc-daemon-test/spare/x"],
        {
          env: serverEnv({ CLAUDE_PEER_NAME: "ux.2", TMUX_PANE: "%34" }),
          stdin: "pipe",
          stdout: "ignore",
          stderr: "ignore",
        }
      );
      try {
        // Give the server ample time to start and (wrongly) register.
        await Bun.sleep(3000);
        expect(peerRows().length).toBe(0);
      } finally {
        wrapper.stdin.end();
        wrapper.kill();
      }
    },
    15000
  );

  test(
    "bg-spare: first MCP tool call triggers deferred registration (ensureRegistered)",
    async () => {
      const wrapper = Bun.spawn(
        ["bash", "-c", `bun "${SERVER_SCRIPT}" <&0 & wait`, "bash", "--bg-spare", "/tmp/cc-daemon-test/spare/y"],
        {
          env: serverEnv({ CLAUDE_PEER_NAME: "stale-spare-name" }),
          stdin: "pipe",
          stdout: "ignore",
          stderr: "ignore",
        }
      );
      try {
        // Confirm deferral, then drive the MCP handshake + one tool call over
        // stdio. The CallTool handler must register before serving the tool.
        await Bun.sleep(2500);
        expect(peerRows().length).toBe(0);

        const frames = [
          { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lifecycle-test", version: "0" } } },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami", arguments: {} } },
        ];
        for (const frame of frames) {
          wrapper.stdin.write(`${JSON.stringify(frame)}\n`);
        }
        wrapper.stdin.flush();

        await waitFor(() => peerRows().length === 1, 10000, "deferred registration on first tool call");
      } finally {
        wrapper.stdin.end();
        wrapper.kill();
      }
    },
    20000
  );

  test(
    "bg-spare: promotion watcher registers when the spare marker leaves the ancestor chain",
    async () => {
      // `exec sleep` replaces the bash image in place: same pid, argv loses
      // the --bg-spare marker — the exec-style promotion the watcher exists
      // for. Watcher cadence shrunk via the heartbeat env override.
      const wrapper = Bun.spawn(
        ["bash", "-c", `bun "${SERVER_SCRIPT}" <&0 & exec sleep 60`, "bash", "--bg-spare", "/tmp/cc-daemon-test/spare/z"],
        {
          env: serverEnv({ CLAUDE_PEERS_HEARTBEAT_MS: "200" }),
          stdin: "pipe",
          stdout: "ignore",
          stderr: "ignore",
        }
      );
      try {
        await waitFor(() => peerRows().length === 1, 10000, "promotion-watcher registration");
      } finally {
        wrapper.stdin.end();
        wrapper.kill();
        // The server reparents when sleep dies; its own watchdog reaps it.
      }
    },
    20000
  );

  test(
    "hard-exit timer: server still exits when the broker wedges during unregister",
    async () => {
      // Mini-broker that registers/heartbeats normally but never answers
      // /unregister — the unref'd 3s hard-exit timer is the only orphan
      // defense on this path.
      let registered = false;
      const wedge = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          const path = new URL(req.url).pathname;
          if (path === "/health") return Response.json({ status: "ok", peers: 0 });
          if (path === "/register") {
            registered = true;
            return Response.json({ id: "wedge-peer", token: "wedge-token", name: "wedge", resolved_name: "wedge", client_type: "unknown", receiver_mode: "unknown" });
          }
          if (path === "/unregister") return new Promise<Response>(() => {}); // hang forever
          return Response.json({ ok: true, messages: [] });
        },
      });
      const wedgePort = wedge.port!;
      const proc = Bun.spawn(["bun", SERVER_SCRIPT], {
        env: serverEnv({ CLAUDE_PEERS_PORT: String(wedgePort) }),
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        await waitFor(() => registered, 10000, "registration against wedge broker");
        proc.stdin.end();
        const exitCode = await Promise.race([
          proc.exited,
          Bun.sleep(6000).then(() => "timeout" as const),
        ]);
        // Hard exit fires at ~3s; anything that exits beats an orphan.
        expect(exitCode).not.toBe("timeout");
      } finally {
        proc.kill();
        wedge.stop(true);
      }
    },
    20000
  );
});
