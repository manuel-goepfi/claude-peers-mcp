import { AsyncLocalStorage } from "node:async_hooks";

const deadlines = new AsyncLocalStorage<number>();

export function withCommandBudget<T>(milliseconds: number, work: () => T): T {
  return deadlines.run(Math.min(Date.now() + milliseconds, deadlines.getStore() ?? Infinity), work);
}

export function commandBudgetRemaining(): number {
  return Math.max(0, (deadlines.getStore() ?? Infinity) - Date.now());
}

/** Never log arguments or output: they may contain pane text or credentials. */
export function boundedCommand(command: string[], options: {
  operation: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}): { ok: boolean; out: string } {
  const remaining = commandBudgetRemaining();
  if (remaining <= 0) return { ok: false, out: "" };
  const timeout = Math.max(1, Math.min(options.timeoutMs ?? 1500, remaining));
  const start = Date.now();
  try {
    const result = Bun.spawnSync(command, {
      stdout: "pipe", stderr: "ignore", timeout, killSignal: "SIGKILL",
      ...(options.env ? { env: options.env } : {}),
    });
    if (result.exitCode === 0) return { ok: true, out: result.stdout.toString() };
    if (Date.now() - start >= timeout) {
      console.error(`[peers-command] ${new Date().toISOString()} command_timeout operation=${options.operation} elapsed_ms=${Date.now() - start}`);
    }
  } catch {
    console.error(`[peers-command] ${new Date().toISOString()} command_failed operation=${options.operation} elapsed_ms=${Date.now() - start}`);
  }
  return { ok: false, out: "" };
}
