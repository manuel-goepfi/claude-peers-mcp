#!/usr/bin/env bun
import { existsSync, mkdirSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";

export type ReleaseClient = "claude" | "codex" | "gemini";
const clients: ReleaseClient[] = ["claude", "codex", "gemini"];
const sourceRoot = resolve(import.meta.dir, "..");

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  phase: string;
  client?: ReleaseClient;
}

export interface ReleaseSmokeDependencies {
  env?: Record<string, string | undefined>;
  platform?: string;
  sourceRoot?: string;
  findBinary?: (name: ReleaseClient, path: string | undefined) => string | null;
  pathExists?: (path: string) => boolean;
  ensureDirectory?: (path: string) => void;
  runCommand?: (command: string[], options: CommandOptions) => Promise<CommandResult>;
  now?: () => string;
  nonce?: () => string;
}

export type ReleaseSmokeResult =
  | { status: "blocked"; reason: string }
  | {
      status: "passed";
      started_at: string;
      finished_at: string;
      clients: Record<ReleaseClient, { version: string; auth: "passed"; journey: "passed" }>;
      journey: "three-client-cycle-send-ack";
      transcripts: "not-retained";
    };

export class ReleaseSmokeFailure extends Error {
  constructor(
    readonly phase: string,
    readonly client?: ReleaseClient,
    readonly code?: number,
  ) {
    super(`release smoke failed during ${phase}${client ? ` for ${client}` : ""}`);
  }
}

function defaultFindBinary(name: ReleaseClient, pathValue: string | undefined): string | null {
  for (const directory of (pathValue ?? "").split(delimiter)) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function defaultRunCommand(command: string[], options: CommandOptions): Promise<CommandResult> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), options.timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout: stdout.slice(-131_072), stderr: stderr.slice(-131_072) };
  } finally {
    clearTimeout(timer);
  }
}

function headlessCommand(client: ReleaseClient, binary: string, workspace: string, prompt: string): string[] {
  if (client === "claude") {
    return [binary, "--print", "--no-session-persistence", "--dangerously-skip-permissions", prompt];
  }
  if (client === "codex") {
    return [
      binary,
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
      "-C",
      workspace,
      prompt,
    ];
  }
  return [binary, "--prompt", prompt, "--output-format", "text", "--yolo", "--skip-trust", "--allowed-mcp-server-names", "claude-peers"];
}

function mcpAddCommand(client: ReleaseClient, binary: string, serverPath: string): string[] {
  if (client === "claude") return [binary, "mcp", "add", "--scope", "user", "--transport", "stdio", "claude-peers", "--", process.execPath, serverPath];
  if (client === "codex") return [binary, "mcp", "add", "claude-peers", "--", process.execPath, serverPath];
  return [binary, "mcp", "add", "--scope", "user", "--transport", "stdio", "--trust", "claude-peers", process.execPath, serverPath];
}

function mcpRemoveCommand(client: ReleaseClient, binary: string): string[] {
  if (client === "claude") return [binary, "mcp", "remove", "--scope", "user", "claude-peers"];
  if (client === "codex") return [binary, "mcp", "remove", "claude-peers"];
  return [binary, "mcp", "remove", "--scope", "user", "claude-peers"];
}

function installerPath(root: string, client: ReleaseClient): string {
  return join(root, `bin/install-${client}-hook.ts`);
}

function clientEnvironment(
  env: Record<string, string | undefined>,
  home: string,
  client: ReleaseClient,
  peerName: string,
  phase: string,
): Record<string, string | undefined> {
  return {
    ...env,
    HOME: home,
    CLAUDE_PEER_NAME: peerName,
    CLAUDE_PEERS_RELEASE_PHASE: phase,
    NO_COLOR: "1",
  };
}

function markerFromOutput(result: CommandResult, marker: string, phase: string, client: ReleaseClient): void {
  if (result.code !== 0 || !result.stdout.includes(marker)) throw new ReleaseSmokeFailure(phase, client, result.code);
}

function parsedVersion(output: string): string | null {
  return output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
}

export async function runReleaseSmoke(dependencies: ReleaseSmokeDependencies = {}): Promise<ReleaseSmokeResult> {
  const env = dependencies.env ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const root = resolve(dependencies.sourceRoot ?? sourceRoot);
  const pathExists = dependencies.pathExists ?? existsSync;
  const ensureDirectory = dependencies.ensureDirectory ?? ((path: string) => mkdirSync(path, { recursive: true, mode: 0o700 }));
  const findBinary = dependencies.findBinary ?? defaultFindBinary;
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const makeNonce = dependencies.nonce ?? (() => crypto.randomUUID().replace(/-/g, "").slice(0, 12));
  const isolatedHome = env.CLAUDE_PEERS_RELEASE_HOME;

  if (platform !== "linux") return { status: "blocked", reason: "release smoke supports Linux only" };
  if (env.CLAUDE_PEERS_RELEASE_SMOKE !== "1" || !isolatedHome || env.HOME !== isolatedHome) {
    return { status: "blocked", reason: "isolated release host/account is not explicitly armed" };
  }
  const home = resolve(isolatedHome);
  if (!isAbsolute(isolatedHome) || (root !== home && !root.startsWith(`${home}${sep}`))) {
    return { status: "blocked", reason: "release clone must live inside the isolated release HOME" };
  }
  if (!pathExists(join(root, "server.ts"))) return { status: "blocked", reason: "release clone is missing server.ts" };

  const binaries = Object.fromEntries(clients.map((client) => [client, findBinary(client, env.PATH)])) as Record<ReleaseClient, string | null>;
  if (clients.some((client) => !binaries[client])) return { status: "blocked", reason: "one or more release-pinned client binaries are missing" };
  const expectedVersions = {
    claude: env.CLAUDE_PEERS_RELEASE_CLAUDE_VERSION,
    codex: env.CLAUDE_PEERS_RELEASE_CODEX_VERSION,
    gemini: env.CLAUDE_PEERS_RELEASE_GEMINI_VERSION,
  } satisfies Record<ReleaseClient, string | undefined>;
  if (clients.some((client) => !expectedVersions[client])) return { status: "blocked", reason: "one or more release client version pins are missing" };

  const timeoutMs = Number(env.CLAUDE_PEERS_RELEASE_TIMEOUT_MS ?? "180000");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000) return { status: "blocked", reason: "release timeout must be at least 10000ms" };
  const workspace = join(home, "claude-peers-release-workspace");
  ensureDirectory(workspace);
  const startedAt = now();
  const nonce = makeNonce();
  const versions = {} as Record<ReleaseClient, string>;
  let onboardingStarted = false;

  const execute = async (command: string[], phase: string, client?: ReleaseClient, peerName = `release-${client ?? "operator"}-${nonce}`): Promise<CommandResult> => {
    try {
      return await runCommand(command, {
        cwd: workspace,
        env: clientEnvironment(env, home, client ?? "claude", peerName, phase),
        timeoutMs,
        phase,
        ...(client ? { client } : {}),
      });
    } catch {
      throw new ReleaseSmokeFailure(phase, client);
    }
  };

  try {
    for (const client of clients) {
      const result = await execute([binaries[client]!, "--version"], "version", client);
      if (result.code !== 0) throw new ReleaseSmokeFailure("version", client, result.code);
      const actualVersion = parsedVersion(result.stdout);
      if (!actualVersion || actualVersion !== expectedVersions[client]) throw new ReleaseSmokeFailure("version-pin", client, result.code);
      versions[client] = actualVersion;
    }

    onboardingStarted = true;
    for (const client of clients) {
      await execute(mcpRemoveCommand(client, binaries[client]!), "mcp-preclean", client).catch(() => ({ code: 1, stdout: "", stderr: "" }));
      const added = await execute(mcpAddCommand(client, binaries[client]!, join(root, "server.ts")), "mcp-install", client);
      if (added.code !== 0) throw new ReleaseSmokeFailure("mcp-install", client, added.code);
      const installed = await execute([process.execPath, installerPath(root, client), "install"], "hook-install", client);
      if (installed.code !== 0) throw new ReleaseSmokeFailure("hook-install", client, installed.code);
      const checked = await execute([process.execPath, installerPath(root, client), "--check"], "hook-check", client);
      if (checked.code !== 0) throw new ReleaseSmokeFailure("hook-check", client, checked.code);
    }

    const authResults = await Promise.all(clients.map(async (client) => {
      const marker = `CLAUDE_PEERS_AUTH_OK:${client}:${nonce}`;
      const prompt = `Authentication preflight only. Do not use tools. Reply with exactly ${marker} and nothing else.`;
      const result = await execute(headlessCommand(client, binaries[client]!, workspace, prompt), "auth", client);
      return { client, marker, result };
    }));
    for (const { client, marker, result } of authResults) markerFromOutput(result, marker, "auth", client);

    const peerNames = Object.fromEntries(clients.map((client) => [client, `release-${client}-${nonce}`])) as Record<ReleaseClient, string>;
    const journeyResults = await Promise.all(clients.map(async (client, index) => {
      const target = clients[(index + 1) % clients.length]!;
      const sender = clients[(index + clients.length - 1) % clients.length]!;
      const marker = `CLAUDE_PEERS_JOURNEY_OK:${client}:${nonce}`;
      const outbound = `release-smoke:${client}:${nonce}`;
      const inbound = `release-smoke:${sender}:${nonce}`;
      const prompt = [
        "This is an explicitly armed isolated release smoke.",
        "Use only the claude-peers MCP tools for this task.",
        `Your registered peer name is ${peerNames[client]}.`,
        `Retry find_peer or list_peers until ${peerNames[target]} is visible, then send exactly ${outbound} to it with send_to_peer.`,
        `Retry check_messages until you receive exactly ${inbound} from ${peerNames[sender]}; reading it must acknowledge it.`,
        `Only after both the send and receive/ack succeed, reply with exactly ${marker} and nothing else.`,
        "Do not invent success. Fail if the peer journey cannot complete within the current turn.",
      ].join(" ");
      const result = await execute(headlessCommand(client, binaries[client]!, workspace, prompt), "journey", client, peerNames[client]);
      return { client, marker, result };
    }));
    for (const { client, marker, result } of journeyResults) markerFromOutput(result, marker, "journey", client);

    return {
      status: "passed",
      started_at: startedAt,
      finished_at: now(),
      clients: Object.fromEntries(clients.map((client) => [client, { version: versions[client], auth: "passed", journey: "passed" }])) as Record<ReleaseClient, { version: string; auth: "passed"; journey: "passed" }>,
      journey: "three-client-cycle-send-ack",
      transcripts: "not-retained",
    };
  } finally {
    if (onboardingStarted) {
      for (const client of [...clients].reverse()) {
        await execute([process.execPath, installerPath(root, client), "--uninstall"], "hook-uninstall", client).catch(() => undefined);
        await execute(mcpRemoveCommand(client, binaries[client]!), "mcp-uninstall", client).catch(() => undefined);
      }
    }
  }
}

export async function main(): Promise<number> {
  try {
    const result = await runReleaseSmoke();
    if (result.status === "blocked") {
      console.error(JSON.stringify(result));
      return 2;
    }
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    if (error instanceof ReleaseSmokeFailure) {
      console.error(JSON.stringify({ status: "failed", phase: error.phase, client: error.client ?? null, code: error.code ?? null, transcripts: "not-retained" }));
    } else {
      console.error(JSON.stringify({ status: "failed", phase: "internal", transcripts: "not-retained" }));
    }
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
