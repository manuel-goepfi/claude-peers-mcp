import { spawn } from "node:child_process";

const serverScript = process.argv[2];
if (!serverScript) throw new Error("server script path required");

// Proxy bytes explicitly: inherited piped descriptors under nested Bun
// processes do not reliably carry the test harness's MCP frames.
const child = spawn("bun", [serverScript], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
const probeThreadId = process.env.MCP_PROBE_THREAD_ID;
const stdoutChunks: Buffer[] = [];
if (probeThreadId) {
  child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.pipe(process.stderr);
  for (const frame of [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "appserver-proof", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami", arguments: {}, _meta: { threadId: probeThreadId } } },
  ]) {
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  }
  child.stdin.end();
} else {
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
}

const exitCode = await new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 0)));
});
if (probeThreadId) process.stdout.write(Buffer.concat(stdoutChunks));
process.exit(exitCode);
