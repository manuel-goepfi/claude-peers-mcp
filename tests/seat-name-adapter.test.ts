/**
 * End to end: a real server.ts adapter in a scratch tmux pane, against a scratch
 * broker, renamed with the set_name tool.
 *
 * "group": the native Claude companion path (live mailbox group). Before the
 *   explicit-name pin, the broker heartbeat rewrote the name from the pane's
 *   auto label within one beat, so whoami went back to the launch-order label.
 * "plain": an adapter registered on its own pid. A rename made elsewhere
 *   (rename-lane pins the broker and stamps the pane) must survive the adapter's
 *   401 re-registration instead of being re-pinned to the adapter's older name.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createConnection, type Socket } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { startTestBroker } from "./helpers/test-broker.ts";

class SocketStdio implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  private socket?: Socket;
  constructor(private path: string) {}
  async start() {
    const socket = this.socket = createConnection(this.path); let pending = "";
    socket.on("data", (data) => {
      pending += data.toString(); let end: number;
      while ((end = pending.indexOf("\n")) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); if (line) this.onmessage?.(JSON.parse(line)); }
    });
    socket.on("error", (e) => this.onerror?.(e)); socket.on("close", () => this.onclose?.());
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  }
  async send(message: JSONRPCMessage) { await new Promise<void>((resolve, reject) => this.socket!.write(JSON.stringify(message) + "\n", (e) => e ? reject(e) : resolve())); }
  async close() { this.socket?.end(); }
}

async function until(predicate: () => boolean, ms = 10_000, observed: () => unknown = () => "") {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (predicate()) return; await Bun.sleep(25); }
  throw new Error(`fixture observation timeout ${JSON.stringify(observed())}`);
}

// The pane's process: a python stand-in whose comm becomes "claude" when the
// ready file exists, which hosts server.ts on a unix-socket stdio bridge.
const DRIVER = `import ctypes,subprocess,sys,socket,os,time,signal,json
ctypes.CDLL(None).prctl(15,b'legacy-fixture',0,0,0)
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.bind(sys.argv[1]);s.listen(1)
open(sys.argv[2],'w').write(json.dumps({'native':os.getpid()}))
if os.path.exists(sys.argv[3]):ctypes.CDLL(None).prctl(15,b'claude',0,0,0)
c,_=s.accept()
log=open(sys.argv[4],'w')
p=subprocess.Popen(sys.argv[5:],stdin=c,stdout=c,stderr=log,env=dict(os.environ))
open(sys.argv[2],'w').write(json.dumps({'native':os.getpid(),'adapter':p.pid}))
def stop(*_):
 p.terminate();p.wait();sys.exit(0)
signal.signal(signal.SIGTERM,stop)
while p.poll() is None:time.sleep(.05)
`;

const text = (result: unknown) => JSON.stringify(result);

test.skipIf(!Bun.which("tmux") || !Bun.which("python3")).each(["group", "plain"] as const)("set_name sticks through heartbeats, re-registration and restart (%s)", async (variant) => {
  const root = mkdtempSync(join(tmpdir(), `seat-name-adapter-${variant}-`));
  const tmuxSocket = join(root, "tmux"), wire = join(root, "stdio"), pids = join(root, "pids"), ready = join(root, "native-ready");
  const script = join(root, "driver.py");
  writeFileSync(script, DRIVER);
  if (variant === "group") writeFileSync(ready, "");
  let broker = await startTestBroker({ prefix: `seat-name-adapter-${variant}`, cleanupOnStop: false });
  const db = new Database(broker.dbPath);
  let target = broker.url;
  // A fixed URL for the adapter so the broker can restart underneath it.
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) =>
    fetch(new Request(target + new URL(request.url).pathname, request)).catch(() => new Response("broker restarting", { status: 503 })) });
  const env = { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: join(root, "claude"), CLAUDE_PEERS_PORT: String(proxy.port), CLAUDE_PEERS_DB: broker.dbPath,
    CLAUDE_PEERS_BRIDGE_TOKEN_FILE: broker.tokenPath, CLAUDE_PEERS_CLIENT_TYPE: "claude", CLAUDE_PEERS_TMUX_IDENTITY_MIRROR: "1",
    CLAUDE_PEERS_TMUX_SOCKET: tmuxSocket, CLAUDE_PEERS_HEARTBEAT_MS: "500", CLAUDE_PEERS_HEARTBEAT_PHASE_SPREAD: "0", TMUX: undefined, TMUX_PANE: undefined };
  const tmux = (...args: string[]) => Bun.spawnSync(["tmux", "-S", tmuxSocket, ...args], { env, stdout: "pipe", stderr: "ignore", timeout: 3000 });
  const paneOption = (pane: string, option: string) => new TextDecoder().decode(tmux("show-options", "-p", "-t", pane, "-v", option).stdout).trim();
  const call = async (path: string, body: object, token = "") => {
    const r = await fetch(broker.url + path, { method: "POST", headers: { "Content-Type": "application/json", "X-Peer-Token": token }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  const client = new Client({ name: "seat-name-adapter", version: "1" });
  try {
    expect(tmux("-f", "/dev/null", "new-session", "-d", "-s", "Orch", "-c", root, "python3", script, wire, pids, ready, join(root, "adapter.log"),
      process.execPath, new URL("../server.ts", import.meta.url).pathname).exitCode).toBe(0);
    await until(() => existsSync(pids));
    const nativePid = JSON.parse(readFileSync(pids, "utf8")).native;
    const pane = new TextDecoder().decode(tmux("display-message", "-p", "-t", "Orch", "#{pane_id}").stdout).trim();
    let seatId: string;
    if (variant === "group") {
      // The SessionStart hook's native row; the adapter binds to it at startup.
      const native = await call("/register", { pid: nativePid, cwd: root, git_root: null, tty: null, name: "Orch.1", tmux_session: "Orch",
        tmux_window_index: "0", tmux_window_name: "fixture", tmux_pane_id: pane, thread_id: "conversation-1", client_type: "claude",
        receiver_mode: "claude-channel", summary: "" });
      expect(native.status).toBe(200);
      seatId = native.body.id;
      await client.connect(new SocketStdio(wire));
      // A native companion registers (binds) on its first tool call.
      await client.callTool({ name: "whoami", arguments: {} });
      await until(() => ((db.query("SELECT seat_key FROM peers WHERE id=?").get(seatId) as any)?.seat_key ?? "").startsWith("live:"),
        10_000, () => ({ rows: db.query("SELECT id,pid,name,seat_key,non_targetable FROM peers").all(), log: readFileSync(join(root, "adapter.log"), "utf8").slice(-2500) }));
    } else {
      await client.connect(new SocketStdio(wire));
      await until(() => existsSync(pids) && JSON.parse(readFileSync(pids, "utf8")).adapter !== undefined);
      const adapterPid = JSON.parse(readFileSync(pids, "utf8")).adapter;
      await until(() => Boolean(db.query("SELECT id FROM peers WHERE pid=? AND non_targetable=0").get(adapterPid)));
      seatId = (db.query("SELECT id FROM peers WHERE pid=? AND non_targetable=0").get(adapterPid) as any).id;
    }
    const stored = () => db.query("SELECT name,resolved_name FROM peers WHERE id=?").get(seatId) as { name: string; resolved_name: string };
    await until(() => stored().name === "Orch.1", 10_000, () => ({ row: stored(), log: readFileSync(join(root, "adapter.log"), "utf8").slice(-1500) }));

    const renamed = await client.callTool({ name: "set_name", arguments: { name: "Orch.9" } });
    expect(renamed.isError).not.toBe(true);
    expect(text(renamed)).toContain('Name updated: \\"Orch.9\\"');
    // Several heartbeats later the explicit name still holds, in the broker and in whoami.
    await Bun.sleep(2500);
    expect(stored()).toEqual({ name: "Orch.9", resolved_name: "Orch.9" });
    expect(paneOption(pane, "@peer_seat_name")).toBe("Orch.9");
    expect(text(await client.callTool({ name: "whoami", arguments: {} }))).toContain("Operator name: Orch.9");

    // Planted collision: another live seat already answers to Orch.7.
    const holder = await call("/register", { pid: process.pid, cwd: "/holder", git_root: null, tty: null, name: "Orch.7", tmux_session: null,
      tmux_window_index: null, tmux_window_name: null, tmux_pane_id: null, client_type: "unknown", receiver_mode: "manual-drain", summary: "" });
    const refused = await client.callTool({ name: "set_name", arguments: { name: "Orch.7" } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain(`is held by live peer ${holder.body.id}`);
    expect(stored().name).toBe("Orch.9");

    if (variant === "plain") {
      // rename-lane elsewhere: broker pin plus pane stamp, then force a 401.
      const token = (db.query("SELECT token FROM peers WHERE id=?").get(seatId) as any).token;
      expect((await call("/set-name", { id: seatId, name: "Orch.11", explicit: true }, token)).status).toBe(200);
      tmux("set-option", "-p", "-t", pane, "@peer_seat_name", "Orch.11");
      db.run("UPDATE peers SET token='rotated-by-test' WHERE id=?", [seatId]);
      // Seat merge may hand the same token back; the adapter log is the signal.
      await until(() => readFileSync(join(root, "adapter.log"), "utf8").includes("Re-registered as peer"),
        10_000, () => ({ rows: db.query("SELECT id,pid,name,token,non_targetable FROM peers").all(), log: readFileSync(join(root, "adapter.log"), "utf8").slice(-1500) }));
      await Bun.sleep(1500);
      const now = db.query("SELECT name FROM peers WHERE pid=? AND non_targetable=0").get(JSON.parse(readFileSync(pids, "utf8")).adapter) as any;
      expect(now.name).toBe("Orch.11");
    }

    // Broker restart: the in-memory pin is gone, the pane carries the name.
    await broker.stop();
    broker = await startTestBroker({ root: broker.root, dbPath: broker.dbPath, tokenPath: broker.tokenPath, cleanupOnStop: false });
    target = broker.url;
    await Bun.sleep(2500);
    const expected = variant === "plain" ? "Orch.11" : "Orch.9";
    const after = db.query("SELECT name FROM peers WHERE tmux_pane_id=? AND non_targetable=0 ORDER BY last_seen DESC").get(pane) as any;
    expect(after.name).toBe(expected);
  } finally {
    await client.close().catch(() => {});
    tmux("kill-server");
    proxy.stop(true);
    db.close();
    await broker.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
