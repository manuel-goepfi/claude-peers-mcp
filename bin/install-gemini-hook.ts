#!/usr/bin/env bun
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const repo = resolve(process.argv[2] ?? process.cwd());
const settingsPath = `${repo}/.gemini/settings.json`;
const hookScript = resolve(import.meta.dir, "../hooks/gemini-drain-peer-inbox.sh");
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const command = `/usr/bin/env bash ${shellQuote(hookScript)}`;
const entry = {
  name: "claude-peers-gemini-inbox",
  type: "command",
  command,
  timeout: 10000,
  description: "Drain pending claude-peers messages before each Gemini agent turn.",
};

type SettingsFile = {
  hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<Record<string, unknown>>; [key: string]: unknown }>>;
  [key: string]: unknown;
};

function readExisting(): SettingsFile {
  if (!existsSync(settingsPath)) return {};
  return JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsFile;
}

const doc = readExisting();
doc.hooks ??= {};
doc.hooks.BeforeAgent ??= [];

let replaced = false;
for (const bucket of doc.hooks.BeforeAgent) {
  if (!Array.isArray(bucket.hooks)) continue;
  const nextHooks: Array<Record<string, unknown>> = [];
  for (const hook of bucket.hooks) {
    if (hook.name === entry.name || hook.command === command) {
      if (!replaced) {
        nextHooks.push(entry);
        replaced = true;
      }
      continue;
    }
    nextHooks.push(hook);
  }
  bucket.hooks = nextHooks;
}

if (!replaced) {
  let bucket = doc.hooks.BeforeAgent.find((item) => item.matcher === "*" && Array.isArray(item.hooks));
  if (!bucket) {
    bucket = { matcher: "*", hooks: [] };
    doc.hooks.BeforeAgent.push(bucket);
  }
  bucket.hooks ??= [];
  bucket.hooks.push(entry);
}

mkdirSync(dirname(settingsPath), { recursive: true });
if (existsSync(settingsPath)) {
  const backup = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  writeFileSync(backup, readFileSync(settingsPath));
  console.log(`backup: ${backup}`);
}
const tmp = `${settingsPath}.tmp`;
writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
renameSync(tmp, settingsPath);
console.log(`installed Gemini peer inbox hook: ${settingsPath}`);
