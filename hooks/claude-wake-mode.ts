#!/usr/bin/env bun

export function autoWakeEnabled(summary: string): boolean {
  return /(?:^|\s)auto(?:\s|[.,;:]|—|$)/iu.test(summary);
}

if (import.meta.main) {
  process.stdout.write(autoWakeEnabled(process.argv[2] ?? "") ? "auto\n" : "ask\n");
}
