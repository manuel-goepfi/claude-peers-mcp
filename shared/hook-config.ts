import { resolve } from "node:path";

export type HookClient = "claude" | "codex" | "gemini";

type Hook = Record<string, unknown>;
type Bucket = { matcher?: string; hooks?: Hook[]; [key: string]: unknown };
type HookDocument = { hooks?: Record<string, Bucket[]>; mcpServers?: Record<string, unknown>; [key: string]: unknown };

export interface CanonicalHook {
  event: string;
  matcher?: string;
  entry: Hook;
  scriptMarker: string;
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const bashCommand = (path: string): string => `/usr/bin/env bash ${shellQuote(path)}`;

export function canonicalHooks(client: HookClient, repoRoot: string): CanonicalHook[] {
  const hooksRoot = resolve(repoRoot, "hooks");
  if (client === "codex") {
    const drain = bashCommand(resolve(hooksRoot, "codex-drain-peer-inbox.sh"));
    const register = bashCommand(resolve(hooksRoot, "codex-register-peer-session.sh"));
    return [
      {
        event: "SessionStart", matcher: "startup|resume", scriptMarker: "codex-register-peer-session.sh",
        entry: { name: "claude-peers-codex-register", type: "command", command: register, timeout: 10, statusMessage: "Registering peer session" },
      },
      {
        event: "SessionStart", matcher: "startup|resume", scriptMarker: "CLAUDE_PEERS_HOOK_EVENT_NAME=SessionStart",
        entry: { name: "claude-peers-codex-session-drain", type: "command", command: `CLAUDE_PEERS_HOOK_EVENT_NAME=SessionStart ${drain}`, timeout: 15, statusMessage: "Draining peer inbox at session start" },
      },
      {
        event: "UserPromptSubmit", scriptMarker: "codex-drain-peer-inbox",
        entry: { name: "claude-peers-codex-inbox", type: "command", command: drain, timeout: 10, statusMessage: "Checking peer inbox" },
      },
      {
        event: "Stop", scriptMarker: "CLAUDE_PEERS_HOOK_EVENT_NAME=Stop",
        entry: { name: "claude-peers-codex-stop-drain", type: "command", command: `CLAUDE_PEERS_HOOK_EVENT_NAME=Stop ${drain}`, timeout: 10, statusMessage: "Checking peer inbox before stop" },
      },
    ];
  }
  if (client === "gemini") {
    const drain = bashCommand(resolve(hooksRoot, "gemini-drain-peer-inbox.sh"));
    const register = bashCommand(resolve(hooksRoot, "gemini-register-peer-session.sh"));
    return [
      {
        event: "SessionStart", matcher: "startup|resume", scriptMarker: "gemini-register-peer-session.sh",
        entry: { name: "claude-peers-gemini-register", type: "command", command: register, timeout: 10000, description: "Register this Gemini session with claude-peers at session start." },
      },
      {
        event: "BeforeAgent", matcher: "*", scriptMarker: "gemini-drain-peer-inbox.sh",
        entry: { name: "claude-peers-gemini-inbox", type: "command", command: drain, timeout: 10000, description: "Drain pending claude-peers messages before each Gemini agent turn." },
      },
    ];
  }
  const register = bashCommand(resolve(hooksRoot, "claude-register-peer-session.sh"));
  return [{
    event: "SessionStart", matcher: "startup|resume", scriptMarker: "claude-register-peer-session.sh",
    entry: { type: "command", command: register, timeout: 10, statusMessage: "Registering peer session" },
  }];
}

function isManagedHook(client: HookClient, hook: Hook): boolean {
  const name = typeof hook.name === "string" ? hook.name : "";
  const command = typeof hook.command === "string" ? hook.command : "";
  if (name.startsWith(`claude-peers-${client}`)) return true;
  if (client === "claude") return command.includes("claude-register-peer-session.sh");
  return command.includes(`${client}-register-peer-session.sh`) || command.includes(`${client}-drain-peer-inbox`);
}

function matchesSpec(client: HookClient, spec: CanonicalHook, hook: Hook): boolean {
  return isManagedHook(client, hook) && (
    hook.name === spec.entry.name ||
    (typeof hook.command === "string" && hook.command.includes(spec.scriptMarker))
  );
}

function upsert(document: HookDocument, client: HookClient, spec: CanonicalHook): void {
  document.hooks ??= {};
  document.hooks[spec.event] ??= [];
  const buckets = document.hooks[spec.event]!;
  const matches = (hook: Hook) => matchesSpec(client, spec, hook);
  let target = buckets.find((bucket) =>
    (bucket.matcher ?? undefined) === spec.matcher && Array.isArray(bucket.hooks) && bucket.hooks.some(matches)
  );
  if (!target) target = buckets.find((bucket) => (bucket.matcher ?? undefined) === spec.matcher && Array.isArray(bucket.hooks));
  if (!target) {
    target = { ...(spec.matcher ? { matcher: spec.matcher } : {}), hooks: [] };
    buckets.push(target);
  }
  if (spec.matcher) target.matcher = spec.matcher;
  let inserted = false;
  for (const bucket of buckets) {
    if (!Array.isArray(bucket.hooks)) continue;
    bucket.hooks = bucket.hooks.flatMap((hook) => {
      if (!matches(hook)) return [hook];
      if (bucket === target && !inserted) {
        inserted = true;
        return [spec.entry];
      }
      return [];
    });
  }
  if (!inserted) {
    target.hooks ??= [];
    target.hooks.push(spec.entry);
  }
}

function compact(document: HookDocument): void {
  if (!document.hooks) return;
  for (const [event, buckets] of Object.entries(document.hooks)) {
    document.hooks[event] = buckets.filter((bucket) => !Array.isArray(bucket.hooks) || bucket.hooks.length > 0);
    if (document.hooks[event]!.length === 0) delete document.hooks[event];
  }
  if (Object.keys(document.hooks).length === 0) delete document.hooks;
}

export function installClientHooks(
  document: Record<string, unknown>,
  client: HookClient,
  repoRoot: string,
): Record<string, unknown> {
  const doc = document as HookDocument;
  for (const spec of canonicalHooks(client, repoRoot)) upsert(doc, client, spec);
  compact(doc);
  if (client === "gemini") {
    doc.mcpServers ??= {};
    doc.mcpServers["claude-peers"] = { command: process.execPath, args: [resolve(repoRoot, "server.ts")] };
  }
  return doc;
}

export function uninstallClientHooks(
  document: Record<string, unknown>,
  client: HookClient,
  repoRoot: string,
): Record<string, unknown> {
  const doc = document as HookDocument;
  if (doc.hooks) {
    for (const buckets of Object.values(doc.hooks)) {
      for (const bucket of buckets) {
        if (Array.isArray(bucket.hooks)) bucket.hooks = bucket.hooks.filter((hook) => !isManagedHook(client, hook));
      }
    }
  }
  if (client === "gemini" && doc.mcpServers) {
    const expected = { command: process.execPath, args: [resolve(repoRoot, "server.ts")] };
    if (JSON.stringify(doc.mcpServers["claude-peers"]) === JSON.stringify(expected)) delete doc.mcpServers["claude-peers"];
    if (Object.keys(doc.mcpServers).length === 0) delete doc.mcpServers;
  }
  compact(doc);
  return doc;
}

export interface HookClassification {
  expected: number;
  exact: number;
  stale: number;
  missing: number;
}

export function classifyClientHooks(document: Record<string, unknown>, client: HookClient, repoRoot: string): HookClassification {
  const doc = document as HookDocument;
  let exact = 0;
  let stale = 0;
  const specs = canonicalHooks(client, repoRoot);
  for (const spec of specs) {
    const buckets = doc.hooks?.[spec.event] ?? [];
    const exactMatches = buckets.flatMap((bucket) =>
      (bucket.matcher ?? undefined) === spec.matcher
        ? (bucket.hooks ?? []).filter((hook) => JSON.stringify(hook) === JSON.stringify(spec.entry))
        : [],
    );
    if (exactMatches.length === 1) exact++;
    else if (buckets.some((bucket) => (bucket.hooks ?? []).some((hook) => matchesSpec(client, spec, hook)))) stale++;
  }
  return { expected: specs.length, exact, stale, missing: specs.length - exact - stale };
}
