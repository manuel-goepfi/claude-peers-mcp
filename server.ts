#!/usr/bin/env bun
/**
 * claude-peers MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to the shared broker daemon for peer discovery and messaging.
 * Declares claude/channel capability to push inbound messages immediately.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:claude-peers
 *
 * With .mcp.json:
 *   { "claude-peers": { "command": "bun", "args": ["./server.ts"] } }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { openSync, statSync, existsSync } from "node:fs";
import type {
  PeerId,
  Peer,
  RegisterResponse,
  PollMessagesResponse,
  Message,
} from "./shared/types.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
} from "./shared/summarize.ts";
import { parseTmuxPanes, parsePsTree, type TmuxPaneInfo } from "./shared/tmux.ts";

// --- Configuration ---

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;
const BROKER_LOG = `${process.env.HOME}/.claude-peers-broker.log`;
const BROKER_LOG_MAX_BYTES = 10 * 1024 * 1024; // 10MB

// --- Broker communication ---

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function rotateBrokerLogIfLarge(): void {
  try {
    if (existsSync(BROKER_LOG)) {
      // Use fresh statSync — Bun.file().size is cached at file-handle creation
      // and does not refresh after .exists() resolves.
      const size = statSync(BROKER_LOG).size;
      if (size > BROKER_LOG_MAX_BYTES) {
        // Move current log to .old, overwriting any previous .old
        Bun.spawnSync(["mv", "-f", BROKER_LOG, `${BROKER_LOG}.old`]);
      }
    }
  } catch (e) {
    // Best-effort rotation — never block broker startup, but surface the error
    log(`Log rotation failed (non-blocking): ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  rotateBrokerLogIfLarge();
  log(`Starting broker daemon (log: ${BROKER_LOG})...`);
  // Open the log file in APPEND mode and pass the raw fd to spawn stdio.
  // CRITICAL: Bun.file() as spawn stdio writes from byte 0 (overwrite-in-place),
  // NOT append — that corrupts the log on every restart and prevents file growth,
  // so the rotation guard above never fires. fs.openSync(path, 'a') is the only
  // way to get true append semantics for a child process stderr sink.
  const logFd = openSync(BROKER_LOG, "a");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", logFd],
  });

  // Unref so this process can exit without waiting for the broker
  proc.unref();

  // Wait for it to come up
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

// --- Utility ---

function log(msg: string) {
  // MCP stdio servers must only use stderr for logging (stdout is the MCP protocol)
  console.error(`[claude-peers] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      return text.trim();
    }
  } catch {
    // not a git repo
  }
  return null;
}

function getTty(): string | null {
  try {
    // Try to get the parent's tty from the process tree
    const ppid = process.ppid;
    if (ppid) {
      const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
      const tty = new TextDecoder().decode(proc.stdout).trim();
      if (tty && tty !== "?" && tty !== "??") {
        return tty;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// --- F2: Process-ancestry tmux detection ---
// Pure parsing helpers live in shared/tmux.ts so tests can import them without
// triggering this file's top-level main() side effects.

async function detectTmuxPane(): Promise<TmuxPaneInfo | null> {
  try {
    // 1. Get all tmux panes with their pane_pid.
    // Tab delimiter so session and window names with spaces parse correctly.
    const listProc = Bun.spawn(
      ["tmux", "list-panes", "-a", "-F", "#{pane_pid}\t#{session_name}\t#{window_index}\t#{window_name}"],
      { stdout: "pipe", stderr: "ignore" }
    );
    const listText = await new Response(listProc.stdout).text();
    const listCode = await listProc.exited;
    if (listCode !== 0) return null;

    const paneMap = parseTmuxPanes(listText);
    if (paneMap.size === 0) return null;

    // 2. Snapshot the entire process tree in a single `ps` call instead of one
    //    spawnSync per ancestor step — 20 sync subprocess spawns add ~100ms+ to
    //    broker startup and slow down macOS where ps is heavyweight.
    const psProc = Bun.spawnSync(["ps", "-eo", "pid,ppid"]);
    if (psProc.exitCode !== 0) return null;
    const ppidMap = parsePsTree(new TextDecoder().decode(psProc.stdout));

    // 3. Walk upward from process.ppid (the MCP server itself is never a tmux
    //    pane; its parent or further ancestor will be).
    let currentPid = process.ppid;
    for (let i = 0; i < 20; i++) {
      if (paneMap.has(currentPid)) {
        return paneMap.get(currentPid)!;
      }
      const parentPid = ppidMap.get(currentPid);
      if (parentPid === undefined || parentPid <= 1) break;
      currentPid = parentPid;
    }
  } catch (e) {
    // Most commonly: tmux not installed. But also surfaces parsing/walk bugs.
    log(`detectTmuxPane: ${e instanceof Error ? e.message : String(e)}`);
  }
  return null;
}

// --- State ---

let myId: PeerId | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;

// Local buffer for messages fetched by the poll loop, awaiting delivery
// via piggyback (drainPendingMessages) or check_messages.
const localMessageBuffer: Message[] = [];
const localBufferIds = new Set<number>(); // O(1) dedup for poll loop

// Messages confirmed delivered to Claude via tool response (piggyback or check_messages).
// Only these two paths count — channel push is unreliable and never confirms delivery.
// Note: IDs are SQLite AUTOINCREMENT from the broker's messages table. These are
// monotonically increasing and never recycled within the same DB. If the broker DB
// is deleted while peers are running, IDs could collide with this set — the prune
// timer (keeping last 500) mitigates this edge case.
const confirmedDeliveredIds = new Set<number>();

// --- Piggyback delivery ---
// Drains pending messages from the local buffer and returns formatted text
// to append to any tool response. This ensures messages arrive even when
// channel push fails — Claude gets them on the next tool call of any kind.

async function drainPendingMessages(): Promise<string | null> {
  if (!myId) return null;
  const buffered = localMessageBuffer.splice(0, localMessageBuffer.length);
  localBufferIds.clear();
  const unseen = buffered.filter((m) => !confirmedDeliveredIds.has(m.id));
  if (unseen.length === 0) return null;

  const ids = unseen.map((m) => m.id);
  let ackOk = false;
  try {
    await brokerFetch("/ack-messages", { id: myId, ids });
    ackOk = true;
  } catch (e) {
    // Either old broker without /ack-messages endpoint OR transient network failure.
    // Either way: surface in log so silent ack drops are observable.
    log(`drainPendingMessages: ack failed — ${e instanceof Error ? e.message : String(e)}`);
  }

  // Only add to local dedup if the broker confirmed the ack. Otherwise leave the
  // IDs unconfirmed so the next poll cycle can retry — the messages still appear
  // in the tool response below, so Claude sees them exactly once per session.
  if (ackOk) {
    for (const id of ids) confirmedDeliveredIds.add(id);
  }

  const lines = unseen.map((m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`);
  return `\n\n---\n${unseen.length} pending peer message(s):\n\n${lines.join("\n\n---\n\n")}`;
}

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-peers", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claude-peers network. Other Claude Code instances on this machine can see you and send you messages.

IMPORTANT: When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder — answer right away, even if you're in the middle of something.

Read the from_id, from_summary, and from_cwd attributes to understand who sent the message. Reply by calling send_message with their from_id.

Available tools:
- list_peers: Discover other Claude Code instances (scope: machine/directory/repo)
- send_message: Send a message to another instance by ID
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers)
- check_messages: Manually check for new messages
- whoami: Get your own peer ID, CWD, and git root

When you start, proactively call set_summary to describe what you're working on. This helps other instances understand your context.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances running on this machine. Returns their ID, working directory, git repo, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of peer discovery. "machine" = all instances on this computer. "directory" = same working directory. "repo" = same git repository (including worktrees or subdirectories).',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by peer ID. The message will be pushed into their session immediately via channel notification.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The peer ID of the target Claude Code instance (from list_peers)",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. This is visible to other Claude Code instances when they list peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "find_peer",
    description:
      "Find Claude Code instances by human-readable name (set via CLAUDE_PEER_NAME env var) and/or tmux session. If both name and tmux are provided, both must match (AND semantics). Returns matching peer IDs across all peers on this machine.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string" as const,
          description: "Exact match on the peer's CLAUDE_PEER_NAME",
        },
        tmux: {
          type: "string" as const,
          description: "Exact match on the peer's tmux session name",
        },
      },
    },
  },
  {
    name: "check_messages",
    description:
      "Manually check for new messages from other Claude Code instances. Messages are normally pushed automatically via channel notifications, but you can use this as a fallback.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "whoami",
    description:
      "Returns this Claude Code instance's own peer ID, working directory, and git root. Useful for telling other peers how to message you.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_peers": {
      const scope = (args as { scope: string }).scope as "machine" | "directory" | "repo";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
          exclude_id: myId,
        });

        const pending = await drainPendingMessages();

        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No other Claude Code instances found (scope: ${scope}).${pending ?? ""}`,
              },
            ],
          };
        }

        const lines = peers.map((p) => {
          const parts = [
            `ID: ${p.id}`,
            `PID: ${p.pid}`,
            `CWD: ${p.cwd}`,
          ];
          if (p.name) parts.push(`Name: ${p.name}`);
          if (p.git_root) parts.push(`Repo: ${p.git_root}`);
          if (p.tty) parts.push(`TTY: ${p.tty}`);
          if (p.tmux_session) parts.push(`Tmux: ${p.tmux_session}:${p.tmux_window_index}:${p.tmux_window_name}`);
          if (p.summary) parts.push(`Summary: ${p.summary}`);
          parts.push(`Last seen: ${p.last_seen}`);
          return parts.join("\n  ");
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}${pending ?? ""}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "send_message": {
      const { to_id, message } = args as { to_id: string; message: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          from_id: myId,
          to_id,
          text: message,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }],
            isError: true,
          };
        }
        const pending = await drainPendingMessages();
        return {
          content: [{ type: "text" as const, text: `Message sent to peer ${to_id}${pending ?? ""}` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        const pending = await drainPendingMessages();
        return {
          content: [{ type: "text" as const, text: `Summary updated: "${summary}"${pending ?? ""}` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "find_peer": {
      const { name: findName, tmux: findTmux } = args as { name?: string; tmux?: string };
      if (!findName && !findTmux) {
        return {
          content: [{ type: "text" as const, text: "Provide at least one of: name, tmux" }],
          isError: true,
        };
      }
      try {
        const allPeers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine" as const,
          cwd: myCwd,
          git_root: myGitRoot,
        });
        const matches = allPeers.filter((p) => {
          if (findName && p.name !== findName) return false;
          if (findTmux && p.tmux_session !== findTmux) return false;
          return true;
        });
        const pending = await drainPendingMessages();
        if (matches.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No peers found matching${findName ? ` name="${findName}"` : ""}${findTmux ? ` tmux="${findTmux}"` : ""}${pending ?? ""}` }],
          };
        }
        const lines = matches.map((p) => `${p.id}${p.name ? ` (${p.name})` : ""}${p.tmux_session ? ` [tmux ${p.tmux_session}:${p.tmux_window_name}]` : ""}`);
        return {
          content: [{ type: "text" as const, text: `Found ${matches.length} peer(s):\n${lines.join("\n")}${pending ?? ""}` }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error finding peers: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "check_messages": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        // Drain local buffer (messages polled by the poll loop)
        const buffered = localMessageBuffer.splice(0, localMessageBuffer.length);
        localBufferIds.clear();

        // Also check broker directly for anything poll loop hasn't grabbed
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });

        // Merge and deduplicate by message ID
        const seen = new Set<number>();
        const allMessages: Message[] = [];
        for (const m of [...buffered, ...result.messages]) {
          if (!seen.has(m.id) && !confirmedDeliveredIds.has(m.id)) {
            seen.add(m.id);
            allMessages.push(m);
          }
        }

        if (allMessages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }

        // Explicitly ack all messages we're returning, then add to local dedup
        // ONLY if the ack succeeded — otherwise leave them unconfirmed so the
        // next poll cycle can retry.
        const ids = allMessages.map((m) => m.id);
        let ackOk = false;
        try {
          await brokerFetch("/ack-messages", { id: myId, ids });
          ackOk = true;
        } catch (e) {
          log(`check_messages: ack failed — ${e instanceof Error ? e.message : String(e)}`);
        }

        if (ackOk) {
          for (const id of ids) confirmedDeliveredIds.add(id);
        }

        const lines = allMessages.map(
          (m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `${allMessages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking messages: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "whoami": {
      return {
        content: [
          {
            type: "text" as const,
            text: `Peer ID: ${myId ?? "(not registered)"}\nCWD: ${myCwd}\nGit root: ${myGitRoot ?? "(none)"}`,
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Polling loop for inbound messages ---

async function pollAndPushMessages() {
  if (!myId) return;

  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });

    // Collect new messages that need buffering + channel push
    const newMessages: Message[] = [];
    for (const msg of result.messages) {
      if (confirmedDeliveredIds.has(msg.id)) continue;
      if (localBufferIds.has(msg.id)) continue;

      localMessageBuffer.push(msg);
      localBufferIds.add(msg.id);
      newMessages.push(msg);
    }

    if (newMessages.length === 0) return;

    // Fetch peer list once for sender metadata (not per-message)
    let peerCache: Peer[] | null = null;
    try {
      peerCache = await brokerFetch<Peer[]>("/list-peers", {
        scope: "machine",
        cwd: myCwd,
        git_root: myGitRoot,
      });
    } catch {
      // Non-critical — channel push proceeds without sender context
    }

    // Best-effort channel push — fire and forget, never ack, never confirm.
    // mcp.notification() is fire-and-forget over stdio and never throws even
    // when the channel listener isn't active or the platform drops the notification.
    for (const msg of newMessages) {
      try {
        const sender = peerCache?.find((p) => p.id === msg.from_id);
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: msg.text,
            meta: {
              from_id: msg.from_id,
              from_summary: sender?.summary ?? "",
              from_cwd: sender?.cwd ?? "",
              sent_at: msg.sent_at,
              message_id: String(msg.id),
            },
          },
        });
        log(`Channel push attempted for message ${msg.id} from ${msg.from_id}`);
      } catch (e) {
        log(`Channel push failed for ${msg.from_id}: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Delivery confirmed ONLY when drainPendingMessages() or check_messages
      // includes this message in a tool response that Claude actually reads.
    }
  } catch (e) {
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Startup ---

async function main() {
  // 1. Ensure broker is running
  await ensureBroker();

  // 2. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();
  const peerName = process.env.CLAUDE_PEER_NAME ?? null;
  const tmuxInfo = await detectTmuxPane();

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`TTY: ${tty ?? "(unknown)"}`);
  if (peerName) log(`Peer name: ${peerName}`);
  if (tmuxInfo) log(`Tmux: ${tmuxInfo.session}:${tmuxInfo.window_index}:${tmuxInfo.window_name}`);

  // 3. Generate initial summary via gpt-5.4-nano (non-blocking, best-effort)
  let initialSummary = "";
  const summaryPromise = (async () => {
    try {
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getRecentFiles(myCwd);
      const summary = await generateSummary({
        cwd: myCwd,
        git_root: myGitRoot,
        git_branch: branch,
        recent_files: recentFiles,
      });
      if (summary) {
        initialSummary = summary;
        log(`Auto-summary: ${summary}`);
      }
    } catch (e) {
      log(`Auto-summary failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  // Wait briefly for summary, but don't block startup
  await Promise.race([summaryPromise, new Promise((r) => setTimeout(r, 3000))]);

  // Prepend tmux tag to summary if detected
  if (tmuxInfo && initialSummary) {
    initialSummary = `[tmux ${tmuxInfo.session}:${tmuxInfo.window_name}] ${initialSummary}`;
  }

  // 4. Register with broker
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    name: peerName,
    tmux_session: tmuxInfo?.session ?? null,
    tmux_window_index: tmuxInfo?.window_index ?? null,
    tmux_window_name: tmuxInfo?.window_name ?? null,
    summary: initialSummary,
  });
  myId = reg.id;
  log(`Registered as peer ${myId}`);

  // If summary generation is still running, update it when done
  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myId) {
        // Prepend tmux tag to late summary
        if (tmuxInfo) {
          initialSummary = `[tmux ${tmuxInfo.session}:${tmuxInfo.window_name}] ${initialSummary}`;
        }
        try {
          await brokerFetch("/set-summary", { id: myId, summary: initialSummary });
          log(`Late auto-summary applied: ${initialSummary}`);
        } catch {
          // Non-critical
        }
      }
    });
  }

  // 5. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 6. Start serialized polling for inbound messages
  let pollActive = true;

  async function schedulePoll() {
    if (!pollActive) return;
    await pollAndPushMessages();
    if (pollActive) setTimeout(schedulePoll, POLL_INTERVAL_MS);
  }

  setTimeout(schedulePoll, POLL_INTERVAL_MS);

  // 7. Start heartbeat
  const heartbeatTimer = setInterval(async () => {
    if (myId) {
      try {
        await brokerFetch("/heartbeat", { id: myId });
      } catch {
        // Non-critical
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 8. Prune confirmedDeliveredIds and localMessageBuffer periodically.
  //
  // Caps reference: upstream PR #25 used DEDUP_CAP=1000 / BUFFER_CAP=200.
  // Fork raises to DEDUP_CAP=5000 / BUFFER_CAP=10000 to make overflow practically
  // unreachable. At 1 message/sec sustained without ANY tool call, that is ~3
  // hours of pure inbound before the buffer overflows.
  //
  // Overflow handling change from upstream: we DO NOT ack pruned messages to
  // the broker. Upstream's behavior was silent data loss (broker thinks delivered,
  // Claude never saw them). Our behavior: drop from local buffer + add to local
  // dedup (preventing infinite re-poll loop), but leave broker state untouched
  // so a fresh session restart will re-deliver. Surfaces as a loud ERROR log so
  // operators can act if it ever fires.
  const DEDUP_CAP = 5000;
  const DEDUP_DRAIN_TO = 2500;
  const BUFFER_CAP = 10000;
  const BUFFER_DRAIN_TO = 5000;
  const pruneTimer = setInterval(() => {
    if (confirmedDeliveredIds.size > DEDUP_CAP) {
      const arr = [...confirmedDeliveredIds];
      const toRemove = arr.slice(0, arr.length - DEDUP_DRAIN_TO);
      for (const id of toRemove) confirmedDeliveredIds.delete(id);
    }
    if (localMessageBuffer.length > BUFFER_CAP) {
      const removed = localMessageBuffer.splice(0, localMessageBuffer.length - BUFFER_DRAIN_TO);
      // Add to local dedup so the next poll cycle does not infinitely re-buffer
      // the same messages. We deliberately do NOT ack the broker — the messages
      // remain server-side as undelivered, so a fresh session can re-deliver.
      for (const m of removed) confirmedDeliveredIds.add(m.id);
      localBufferIds.clear();
      for (const m of localMessageBuffer) localBufferIds.add(m.id);
      log(`ERROR: localMessageBuffer overflow — dropped ${removed.length} messages from local buffer (cap=${BUFFER_CAP}). Messages remain UNACKED at broker; restart this peer to re-deliver. This indicates the peer was idle for hours while receiving heavy traffic.`);
    }
  }, 60_000);

  // 9. Clean up on exit
  const cleanup = async () => {
    pollActive = false;
    clearInterval(heartbeatTimer);
    clearInterval(pruneTimer);
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
        log("Unregistered from broker");
      } catch {
        // Best effort
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
