#!/usr/bin/env bun
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const repo = resolve(process.argv[2] ?? process.cwd());
const hooksPath = `${repo}/.codex/hooks.json`;
const hookScript = resolve(import.meta.dir, "../hooks/codex-drain-peer-inbox.sh");
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const command = `/usr/bin/env bash ${shellQuote(hookScript)}`;
const name = "claude-peers-codex-inbox";
const entry = {
  name,
  type: "command",
  command,
  timeout: 10,
  statusMessage: "Checking peer inbox",
};

type HookFile = {
  hooks?: Record<string, Array<{ hooks?: Array<Record<string, unknown>>; [key: string]: unknown }>>;
};

function isPeerInboxHook(hook: Record<string, unknown>): boolean {
  return hook.name === name || hook.command === command ||
    (typeof hook.command === "string" && hook.command.includes("codex-drain-peer-inbox.sh"));
}

function readExisting(): HookFile {
  if (!existsSync(hooksPath)) return { hooks: {} };
  return JSON.parse(readFileSync(hooksPath, "utf8")) as HookFile;
}

const doc = readExisting();
doc.hooks ??= {};
doc.hooks.UserPromptSubmit ??= [];
let bucket = doc.hooks.UserPromptSubmit.find((item) => Array.isArray(item.hooks) && item.hooks.some(isPeerInboxHook));
if (!bucket) {
  bucket = { hooks: [] };
  doc.hooks.UserPromptSubmit.push(bucket);
}
let replaced = false;
for (const item of doc.hooks.UserPromptSubmit) {
  if (!Array.isArray(item.hooks)) continue;
  item.hooks = item.hooks.flatMap((hook) => {
    if (!isPeerInboxHook(hook)) return [hook];
    if (item === bucket && !replaced) {
      replaced = true;
      return [entry];
    }
    return [];
  });
}
if (!replaced) {
  bucket.hooks ??= [];
  bucket.hooks.push(entry);
}

mkdirSync(dirname(hooksPath), { recursive: true });
if (existsSync(hooksPath)) {
  const backup = `${hooksPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  writeFileSync(backup, readFileSync(hooksPath));
  console.log(`backup: ${backup}`);
}
const tmp = `${hooksPath}.tmp`;
writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
renameSync(tmp, hooksPath);
console.log(`installed Codex peer inbox hook: ${hooksPath}`);
