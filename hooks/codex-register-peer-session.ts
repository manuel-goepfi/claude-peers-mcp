#!/usr/bin/env bun

const logAvailable = process.env.CLAUDE_PEERS_REGISTER_LOG_AVAILABLE === "1";
const warning = logAvailable
  ? "claude-peers registration failed; automatic peer messaging is unavailable for this session. See register-peer-session.log."
  : "claude-peers registration failed; automatic peer messaging is unavailable for this session. Diagnostics logging is also unavailable.";

try {
  const registration = await import("./register-peer-session.ts");
  await registration.runRegistration();
} catch (error) {
  console.error(`[claude-peers codex-register] unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

if ((process.exitCode ?? 0) !== 0) {
  process.exitCode = 0;
  console.log(JSON.stringify({ systemMessage: warning }));
}
