#!/usr/bin/env bun
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { runHookInstaller } from "../shared/hook-installer-cli.ts";

const sourceRepo = realpathSync(resolve(import.meta.dir, ".."));
export const main = (args = process.argv.slice(2)): Promise<number> => runHookInstaller({
  args, client: "gemini", configRelativePath: ".gemini/settings.json", label: "Gemini", sourceRepo,
});
if (import.meta.main) process.exitCode = await main();
