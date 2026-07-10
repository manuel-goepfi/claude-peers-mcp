import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { processStartIdentity } from "../shared/broker-lifecycle.ts";
import { startTestBroker, type TestBroker } from "./helpers/test-broker.ts";

const cliScript = new URL("../cli.ts", import.meta.url).pathname;
let broker: TestBroker;

async function runCli(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", cliScript, ...args], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(broker.port),
      CLAUDE_PEERS_DB: broker.dbPath,
      CLAUDE_PEERS_BRIDGE_TOKEN_FILE: broker.tokenPath,
      CLAUDE_PEERS_NO_AUTOSTART: "1",
      ...env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function post<T>(path: string, body: Record<string, unknown>, token?: string): Promise<T> {
  const response = await fetch(`${broker.url}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Peer-Token": token } : {}),
    },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<T>;
}

beforeAll(async () => {
  broker = await startTestBroker({ prefix: "cli" });
});

afterAll(async () => {
  await broker.stop();
});

describe("authenticated CLI", () => {
  test("status uses a transient identity, emits no credential, and cleans up", async () => {
    const result = await runCli(["--json", "status"]);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as { ok: boolean; command: string; peers: unknown[] };
    expect(output.ok).toBe(true);
    expect(output.command).toBe("status");
    expect(Array.isArray(output.peers)).toBe(true);
    expect(result.stdout).not.toMatch(/token|bearer/i);
    expect(result.stderr).toBe("");

    const db = new Database(broker.dbPath, { readonly: true });
    const row = db.query("SELECT COUNT(*) AS count FROM peers WHERE non_targetable = 1").get() as { count: number };
    db.close();
    expect(row.count).toBe(0);
  });

  test("send reports queued and the target receives the message", async () => {
    const sleeper = Bun.spawn(["sleep", "60"]);
    try {
      const peer = await post<{ id: string; token: string }>("/register", {
        pid: sleeper.pid,
        cwd: "/cli-send-target",
        git_root: null,
        tty: null,
        name: "cli-send-target",
        tmux_session: null,
        tmux_window_index: null,
        tmux_window_name: null,
        summary: "",
      });
      const result = await runCli(["--json", "send", peer.id, "hello", "from", "cli"]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, command: "send", target: peer.id, state: "queued" });
      const inbox = await post<{ messages: Array<{ text: string }> }>("/poll-messages", { id: peer.id }, peer.token);
      expect(inbox.messages.some((message) => message.text === "hello from cli")).toBe(true);
    } finally {
      sleeper.kill();
    }
  });

  test("target refusal exits with the target error class", async () => {
    const result = await runCli(["--json", "send", "missing-peer", "hello"]);
    expect(result.code).toBe(9);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: "target" });
  });
});

describe("CLI failure classification and credential containment", () => {
  async function withFakeBroker(
    fetcher: (request: Request) => Response | Promise<Response>,
    run: (port: number) => Promise<void>,
  ): Promise<void> {
    const fake = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: fetcher });
    try {
      await run(fake.port!);
    } finally {
      fake.stop(true);
    }
  }

  test("representative old brokers fail closed on register-cli 401 and 404", async () => {
    for (const status of [401, 404]) {
      await withFakeBroker((request) => {
        if (new URL(request.url).pathname === "/health") return Response.json({ status: "ok", peers: 0 });
        return Response.json({ error: "old broker" }, { status });
      }, async (port) => {
        const result = await runCli(["--json", "status"], { CLAUDE_PEERS_PORT: String(port) });
        expect(result.code).toBe(6);
        expect(JSON.parse(result.stderr)).toMatchObject({ error: "compatibility" });
      });
    }
  });

  test("malformed registration is distinct", async () => {
    await withFakeBroker((request) => {
      if (new URL(request.url).pathname === "/health") return Response.json({ status: "ok", peers: 0 });
      return new Response("not json", { status: 200 });
    }, async (port) => {
      const result = await runCli(["--json", "status"], { CLAUDE_PEERS_PORT: String(port) });
      expect(result.code).toBe(5);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: "malformed" });
    });
  });

  test("auth rejection never leaks the transient token", async () => {
    const canary = "CLI_SECRET_CANARY_7f10c0";
    await withFakeBroker((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/health") return Response.json({ status: "ok", peers: 0 });
      if (path === "/register-cli") {
        return Response.json({ id: "cli-test", token: canary, client_type: "unknown", receiver_mode: "unknown", non_targetable: true });
      }
      if (path === "/unregister") return Response.json({ ok: true });
      return Response.json({ error: canary }, { status: 401 });
    }, async (port) => {
      const result = await runCli(["--json", "peers"], { CLAUDE_PEERS_PORT: String(port) });
      expect(result.code).toBe(7);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: "auth" });
      expect(`${result.stdout}${result.stderr}`).not.toContain(canary);
    });
  });

  test("registration timeout is distinct", async () => {
    await withFakeBroker((request) => {
      if (new URL(request.url).pathname === "/health") return Response.json({ status: "ok", peers: 0 });
      return new Promise<Response>(() => {});
    }, async (port) => {
      const result = await runCli(["--json", "status"], {
        CLAUDE_PEERS_PORT: String(port),
        CLAUDE_PEERS_CLI_TIMEOUT_MS: "100",
      });
      expect(result.code).toBe(4);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: "timeout" });
    });
  });

  test("successful command with failed unregister exits as cleanup failure", async () => {
    await withFakeBroker((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/health") return Response.json({ status: "ok", peers: 0 });
      if (path === "/register-cli") {
        return Response.json({ id: "cli-cleanup", token: "cleanup-canary", client_type: "unknown", receiver_mode: "unknown", non_targetable: true });
      }
      if (path === "/list-peers") return Response.json([]);
      if (path === "/unregister") return Response.json({ error: "failed" }, { status: 500 });
      return Response.json({ error: "not found" }, { status: 404 });
    }, async (port) => {
      const result = await runCli(["--json", "peers"], { CLAUDE_PEERS_PORT: String(port) });
      expect(result.code).toBe(11);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: "cleanup" });
      expect(`${result.stdout}${result.stderr}`).not.toContain("cleanup-canary");
    });
  });

  test("SIGINT unregisters the transient identity before exiting", async () => {
    let registered = false;
    let unregistered = false;
    const fake = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/health") return Response.json({ status: "ok", peers: 0 });
        if (path === "/register-cli") {
          registered = true;
          return Response.json({ id: "signal-cli", token: "signal-canary", client_type: "unknown", receiver_mode: "unknown", non_targetable: true });
        }
        if (path === "/unregister") {
          unregistered = true;
          return Response.json({ ok: true });
        }
        if (path === "/list-peers") return new Promise<Response>(() => {});
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    const proc = Bun.spawn(["bun", cliScript, "peers"], {
      env: {
        ...process.env,
        CLAUDE_PEERS_PORT: String(fake.port!),
        CLAUDE_PEERS_NO_AUTOSTART: "1",
        CLAUDE_PEERS_CLI_TIMEOUT_MS: "3000",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const deadline = Date.now() + 2000;
      while (!registered && Date.now() < deadline) await Bun.sleep(20);
      expect(registered).toBe(true);
      proc.kill("SIGINT");
      expect(await proc.exited).toBe(130);
      expect(unregistered).toBe(true);
    } finally {
      proc.kill("SIGKILL");
      fake.stop(true);
    }
  });
});

describe("verified broker shutdown", () => {
  test("kill-broker stops a directly owned broker and removes its lifetime lock", async () => {
    const victim = await startTestBroker({ prefix: "cli-kill", cleanupOnStop: false });
    try {
      const result = await runCli(["--json", "kill-broker"], {
        CLAUDE_PEERS_PORT: String(victim.port),
        CLAUDE_PEERS_DB: victim.dbPath,
        CLAUDE_PEERS_BRIDGE_TOKEN_FILE: victim.tokenPath,
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, command: "kill-broker", state: "stopped" });
      expect(await victim.proc.exited).toBe(0);
      expect(existsSync(`${victim.dbPath}.owner`)).toBe(false);
      const db = new Database(victim.dbPath, { readonly: true });
      const transient = db.query("SELECT COUNT(*) AS count FROM peers WHERE non_targetable = 1").get() as { count: number };
      db.close();
      expect(transient.count).toBe(0);
    } finally {
      await victim.stop();
    }
  });

  test("kill-broker refuses an unrelated listener even when it spoofs lifecycle JSON", async () => {
    const canary = "SPOOFED_LIFECYCLE_TOKEN";
    const fake = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/health") return Response.json({ status: "ok", peers: 0 });
        if (path === "/register-cli") {
          return Response.json({ id: "spoof-cli", token: canary, client_type: "unknown", receiver_mode: "unknown", non_targetable: true });
        }
        if (path === "/lifecycle-identity") {
          return Response.json({
            pid: process.pid,
            process_start: processStartIdentity(process.pid),
            instance_nonce: "spoof-nonce",
            database_path: "/tmp/spoof.db",
            lock_path: "/tmp/spoof.db.owner",
            owner_mode: "direct",
            executable_path: realpathSync("/proc/self/exe"),
            broker_script_path: cliScript,
            ready: true,
            capabilities: { procSocketIdentity: true, nonceProtectedOwnership: true, verifiedShutdown: true, storageSchema: 1 },
          });
        }
        if (path === "/unregister") return Response.json({ ok: true });
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    try {
      const result = await runCli(["--json", "kill-broker"], { CLAUDE_PEERS_PORT: String(fake.port!) });
      expect(result.code).toBe(12);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: "unsafe" });
      expect(`${result.stdout}${result.stderr}`).not.toContain(canary);
      expect(await fetch(`http://127.0.0.1:${fake.port}/health`).then((response) => response.status)).toBe(200);
    } finally {
      fake.stop(true);
    }
  });
});
