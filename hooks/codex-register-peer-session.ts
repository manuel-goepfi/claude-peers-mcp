#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const logAvailable = process.env.CLAUDE_PEERS_REGISTER_LOG_AVAILABLE === "1";
const warning = logAvailable
  ? "claude-peers registration failed; automatic peer messaging is unavailable for this session. See register-peer-session.log."
  : "claude-peers registration failed; automatic peer messaging is unavailable for this session. Diagnostics logging is also unavailable.";

async function readRawHookInput(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((resolve) => {
        timeout = setTimeout(() => resolve(""), 1_500);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const rawHookInput = await readRawHookInput();

function registrationKey(): string | null {
  const paneId = process.env.TMUX_PANE ?? process.env.CLAUDE_PEER_TMUX_PANE_ID;
  if (!paneId) return null;
  try {
    const parsed = JSON.parse(rawHookInput) as { session_id?: unknown };
    if (typeof parsed?.session_id !== "string" || !parsed.session_id.trim()) return null;
    return createHash("sha256").update(`${paneId}\0${parsed.session_id.trim()}`).digest("hex");
  } catch {
    return null;
  }
}

interface RegistrationLease {
  duplicate: boolean;
  complete(success: boolean): void;
}

const RECEIPT_TTL_MS = 5_000;
const LOCK_WAIT_MS = 6_000;
const STALE_LOCK_MS = 15_000;

function freshReceipt(path: string): boolean {
  try {
    const recordedAt = Number(readFileSync(path, "utf8"));
    return Number.isFinite(recordedAt) && Date.now() - recordedAt >= 0 && Date.now() - recordedAt <= RECEIPT_TTL_MS;
  } catch {
    return false;
  }
}

function staleDeadLock(path: string): boolean {
  try {
    if (Date.now() - statSync(path).mtimeMs <= STALE_LOCK_MS) return false;
    const ownerPid = Number(readFileSync(path, "utf8"));
    if (!Number.isInteger(ownerPid) || ownerPid <= 1) return true;
    try {
      process.kill(ownerPid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
}

async function acquireRegistrationLease(): Promise<RegistrationLease> {
  const key = registrationKey();
  if (!key) return { duplicate: false, complete() {} };
  const codexHome = process.env.CODEX_HOME ?? `${process.env.HOME ?? "/tmp"}/.codex`;
  const runtimeRoot = process.env.XDG_RUNTIME_DIR ?? join(codexHome, "run");
  const lockRoot = join(runtimeRoot, "claude-peers-register");
  try {
    mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
    const state = lstatSync(lockRoot);
    const uid = process.getuid?.() ?? -1;
    if (state.isSymbolicLink() || !state.isDirectory() || (uid >= 0 && state.uid !== uid) || (state.mode & 0o022) !== 0) {
      throw new Error(`unsafe single-flight directory: ${lockRoot}`);
    }
  } catch (error) {
    console.error(`[claude-peers codex-register] single-flight unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return { duplicate: false, complete() {} };
  }

  const lockPath = join(lockRoot, `${key}.lock`);
  const receiptPath = join(lockRoot, `${key}.receipt`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    if (freshReceipt(receiptPath)) {
      return { duplicate: true, complete() {} };
    }
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      return {
        duplicate: false,
        complete(success: boolean) {
          try {
            if (success) {
              try {
                writeFileSync(receiptPath, String(Date.now()), { mode: 0o600 });
              } catch (error) {
                console.error(`[claude-peers codex-register] single-flight receipt failed: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          } finally {
            try {
              closeSync(fd);
            } catch (error) {
              console.error(`[claude-peers codex-register] single-flight descriptor cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            try {
              unlinkSync(lockPath);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                console.error(`[claude-peers codex-register] single-flight lock cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        console.error(`[claude-peers codex-register] single-flight lock failed: ${error instanceof Error ? error.message : String(error)}`);
        return { duplicate: false, complete() {} };
      }
      if (staleDeadLock(lockPath)) {
        try {
          unlinkSync(lockPath);
          continue;
        } catch {
          // Another contender repaired it first; retry normally.
        }
      }
      if (Date.now() >= deadline) {
        console.error("[claude-peers codex-register] duplicate registration still owned after bounded wait; skipping contender");
        process.exitCode = 1;
        return { duplicate: true, complete() {} };
      }
      await Bun.sleep(25);
    }
  }
}

const lease = await acquireRegistrationLease();
if (lease.duplicate) {
  console.error("[claude-peers codex-register] duplicate SessionStart registration suppressed");
} else {
  try {
    const registration = await import("./register-peer-session.ts");
    await registration.runRegistration(rawHookInput);
  } catch (error) {
    console.error(`[claude-peers codex-register] unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    lease.complete((process.exitCode ?? 0) === 0);
  }
}

if ((process.exitCode ?? 0) !== 0) {
  process.exitCode = 0;
  console.log(JSON.stringify({ systemMessage: warning }));
}
