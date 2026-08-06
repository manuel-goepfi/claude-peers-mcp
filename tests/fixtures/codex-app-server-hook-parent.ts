import { spawn } from "node:child_process";

const hookScript = process.argv[2];
if (!hookScript) throw new Error("hook script path required");

const sessionId = process.env.HOOK_PROBE_SESSION_ID;
if (!sessionId) throw new Error("HOOK_PROBE_SESSION_ID required");

const child = spawn("bun", [hookScript], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.end(JSON.stringify({
  session_id: sessionId,
  hook_event_name: "SessionStart",
  source: "resume",
  transcript_path: `/not-yet-created/rollout-${sessionId}.jsonl`,
  cwd: process.cwd(),
}));

const exitCode = await new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 0)));
});
process.exit(exitCode);
