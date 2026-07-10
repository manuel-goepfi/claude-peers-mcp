#!/usr/bin/env bun
import { resolve } from "node:path";
import { buildDoctorReport, renderDoctorHuman } from "../shared/doctor.ts";

export async function main(args = process.argv.slice(2)): Promise<number> {
  const port = Number.parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
  const home = process.env.HOME ?? "";
  const dbPath = process.env.CLAUDE_PEERS_DB ?? resolve(home, ".claude-peers.db");
  const repoRoot = resolve(import.meta.dir, "..");
  const report = await buildDoctorReport({ port, dbPath, home, projectRoot: process.cwd(), repoRoot });
  process.stdout.write(args.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : renderDoctorHuman(report));
  return report.summary.errors === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
