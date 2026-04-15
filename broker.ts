#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
// L6: top-level node:fs import (was inline require() in verifyPidUid hot path).
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  AckMessagesRequest,
  Peer,
  Message,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
// S1 + M4: bind to 127.0.0.1 literal so the post-bind assertion below can
// compare against a fixed string. The HOST_OVERRIDE env vars are NOT honoured
// for the actual bind — they only exist to fail-loud if someone sets them
// expecting a non-loopback bind. Allowed loopback aliases are documented for
// the operator but ignored at the bind layer (always 127.0.0.1).
const HOSTNAME = "127.0.0.1";
const LOOPBACK_ALIASES = new Set(["127.0.0.1", "localhost", "::1"]);
const HOST_OVERRIDE = process.env.CLAUDE_PEERS_HOST ?? process.env.CLAUDE_PEERS_HOSTNAME;
if (HOST_OVERRIDE && !LOOPBACK_ALIASES.has(HOST_OVERRIDE)) {
  console.error(`[claude-peers broker] FATAL: refusing non-loopback bind (${HOST_OVERRIDE}). Phase-1 spec requires 127.0.0.1.`);
  process.exit(2);
}
if (PORT < 1 || PORT > 65535 || Number.isNaN(PORT)) {
  console.error(`[claude-peers broker] FATAL: invalid port ${PORT}`);
  process.exit(2);
}

// --- S5: limits ---
const MAX_MSG_BYTES = 32 * 1024;       // 32 KB per message body
const MAX_SUMMARY_BYTES = 1024;        // 1 KB per summary
const MAX_REQ_BYTES = 64 * 1024;       // 64 KB per HTTP request body
const RATE_WINDOW_MS = 60_000;         // 1-minute rolling window
const RATE_MAX_MSGS = 60;              // max messages sent per peer per window
const RATE_MAX_REQS = 600;             // max broker requests per peer per window (10/s avg)

// --- S7: ghost reaping ---
const PEER_GHOST_AFTER_MS = 90_000;    // peer with no heartbeat in 90s = ghost
const MY_UID = process.getuid?.() ?? -1;

// M3: warn loudly if we can't enforce S3 (non-Linux dev environment).
if (MY_UID < 0) {
  console.error("[claude-peers broker] WARN: process.getuid() unavailable — S3 PID/UID validation is DISABLED on this platform. Production deployments MUST be Linux.");
}

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

// --- Idempotent schema migrations (F1+F2) ---
const migrationColumns = [
  { name: "name", type: "TEXT" },
  { name: "tmux_session", type: "TEXT" },
  { name: "tmux_window_index", type: "TEXT" },
  { name: "tmux_window_name", type: "TEXT" },
  // S2: per-peer auth token issued at /register
  { name: "token", type: "TEXT" },
];
for (const col of migrationColumns) {
  try {
    db.run(`ALTER TABLE peers ADD COLUMN ${col.name} ${col.type}`);
  } catch (e) {
    // ONLY swallow "duplicate column name" errors (the idempotent re-run case).
    // Disk full, permission denied, corruption, etc. should crash loudly so the
    // broker doesn't silently start with a half-migrated schema.
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("duplicate column name")) {
      throw e;
    }
  }
}

// Clean up stale peers (PIDs that no longer exist) on startup, and free
// their rate-limit buckets (M2 — was leaking on long-running brokers).
function cleanStalePeers() {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  for (const peer of peers) {
    try {
      process.kill(peer.pid, 0);
    } catch {
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
      // M2: drop the bucket so it doesn't outlive the peer indefinitely.
      // Forward-declared at module scope; safe to reference here because the
      // sweep runs after broker initialization.
      try { (globalThis as { __cpBuckets?: Map<string, unknown> }).__cpBuckets?.delete(peer.id); } catch {}
    }
  }
}

cleanStalePeers();

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, name, tmux_session, tmux_window_index, tmux_window_name, summary, registered_at, last_seen, token)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectPeerByToken = db.prepare(`
  SELECT id, pid, token FROM peers WHERE id = ? AND token = ?
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

const selectAllPeers = db.prepare(`
  SELECT * FROM peers
`);

const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ?
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const markDeliveredScoped = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ? AND to_id = ?
`);

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// S2: cryptographically-random per-peer token. 24 random bytes encoded as
// base64url — exactly 192 bits of entropy in 32 URL-safe characters. The
// previous base36 encoding wasted 4 bytes via slice() and used a non-uniform
// 256-of-1296-symbol distribution per pair (M1).
function generateToken(): string {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString("base64url");
}

// S3: verify the claimed PID is alive and owned by this broker's UID.
// Reads /proc/<pid>/status — Linux-only, which matches the deployment target.
// Returns null on success, error string on rejection.
function verifyPidUid(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 1) return `invalid pid ${pid}`;
  try {
    process.kill(pid, 0);
  } catch {
    return `pid ${pid} not alive`;
  }
  if (MY_UID < 0) return null; // M3: non-Linux fallback (warned at startup).
  // L5: PID-reuse race window between kill(0) above and readFileSync below
  // is a known limitation. On a single-user Linux box the impact is bounded
  // to the same UID space, so worst-case the new PID also passes the UID
  // check — no security regression, just a wasted slot.
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/^Uid:\s+(\d+)/m);
    if (!m || !m[1]) return `cannot read uid for pid ${pid}`;
    const uid = parseInt(m[1], 10);
    if (uid !== MY_UID) {
      // H4 + L4: log security-relevant rejection on the broker side so
      // operators see PID-spoofing attempts that the client otherwise
      // sees only as a 403.
      console.error(`[broker] S3 reject: pid ${pid} owned by uid ${uid}, broker uid ${MY_UID}`);
      return `pid ${pid} owned by uid ${uid}, broker uid ${MY_UID}`;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // ENOENT here means the PID died between kill(0) and the read — benign
    // race, treat as "not alive". EPERM is genuinely security-relevant.
    if (msg.includes("ENOENT")) return `pid ${pid} died during verify`;
    console.error(`[broker] S3 /proc read failed for pid ${pid}: ${msg}`);
    return `proc read failed: ${msg}`;
  }
  return null;
}

// S2/S6: resolve `X-Peer-Token` header to an authenticated peer row. The
// caller's claimed peer ID comes from the URL path (?id=...) or body.id, but
// we ALWAYS overwrite from this lookup — body-supplied IDs are untrusted.
function authPeer(req: Request, claimedId: string | undefined, path: string): { ok: true; id: string } | { ok: false; status: number; error: string } {
  const token = req.headers.get("x-peer-token");
  if (!token) {
    // L4: log auth failures so brute-force / misconfig is visible to operators.
    console.error(`[broker] auth fail on ${path}: missing x-peer-token`);
    return { ok: false, status: 401, error: "missing x-peer-token" };
  }
  if (!claimedId) {
    console.error(`[broker] auth fail on ${path}: missing peer id`);
    return { ok: false, status: 401, error: "missing peer id" };
  }
  const row = selectPeerByToken.get(claimedId, token) as { id: string; pid: number; token: string } | null;
  if (!row) {
    console.error(`[broker] auth fail on ${path}: invalid token for ${claimedId}`);
    return { ok: false, status: 401, error: "invalid token for peer" };
  }
  return { ok: true, id: row.id };
}

// --- S5: token-bucket rate limit (in-memory, per peer) ---
type Bucket = { reqs: number[]; msgs: number[] };
const buckets = new Map<string, Bucket>();
// M2: expose to cleanStalePeers via a global tag (it runs at startup before
// this declaration is visible via lexical scope on first invocation).
(globalThis as { __cpBuckets?: Map<string, Bucket> }).__cpBuckets = buckets;
function rateCheck(peerId: string, isMessage: boolean): string | null {
  const now = Date.now();
  let b = buckets.get(peerId);
  if (!b) {
    b = { reqs: [], msgs: [] };
    buckets.set(peerId, b);
  }
  // Drop entries older than the window
  const cutoff = now - RATE_WINDOW_MS;
  while (b.reqs.length && (b.reqs[0] ?? Infinity) < cutoff) b.reqs.shift();
  while (b.msgs.length && (b.msgs[0] ?? Infinity) < cutoff) b.msgs.shift();
  if (b.reqs.length >= RATE_MAX_REQS) return `rate limit: ${RATE_MAX_REQS} req/min`;
  if (isMessage && b.msgs.length >= RATE_MAX_MSGS) return `rate limit: ${RATE_MAX_MSGS} msg/min`;
  b.reqs.push(now);
  if (isMessage) b.msgs.push(now);
  return null;
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

// L2: only string ids count. Numbers/null/objects → empty string → caller
// rejects with a precise "missing peer id" rather than a confusing
// type-coercion error inside the prepared statement.
function reqStrict(s: unknown): string {
  return typeof s === "string" ? s : "";
}

// --- Request handlers ---

// L3: tagged-union return so the discriminator is unambiguous and future
// fields on RegisterResponse can never collide with the error path.
type RegisterResult =
  | { ok: true; value: RegisterResponse }
  | { ok: false; status: number; error: string };

function handleRegister(body: RegisterRequest): RegisterResult {
  // S3: PID/UID validation before issuing any token.
  const pidErr = verifyPidUid(body.pid);
  if (pidErr) return { ok: false, status: 403, error: `S3 PID/UID rejected: ${pidErr}` };

  // S5: bound the summary at registration too.
  if (body.summary && utf8Bytes(body.summary) > MAX_SUMMARY_BYTES) {
    return { ok: false, status: 413, error: `summary exceeds ${MAX_SUMMARY_BYTES} bytes` };
  }

  const id = generateId();
  const token = generateToken();
  const now = new Date().toISOString();

  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing) {
    deletePeer.run(existing.id);
    buckets.delete(existing.id);
  }

  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, body.name ?? null, body.tmux_session ?? null, body.tmux_window_index ?? null, body.tmux_window_name ?? null, body.summary, now, now, token);
  return { ok: true, value: { id, token } };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        // No git root, fall back to directory
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // S7: drop dead PIDs AND ghosts (no heartbeat in PEER_GHOST_AFTER_MS).
  const now = Date.now();
  return peers.filter((p) => {
    try {
      process.kill(p.pid, 0);
    } catch {
      deletePeer.run(p.id);
      buckets.delete(p.id);
      return false;
    }
    const age = now - new Date(p.last_seen).getTime();
    if (age > PEER_GHOST_AFTER_MS) {
      deletePeer.run(p.id);
      buckets.delete(p.id);
      return false;
    }
    return true;
  });
}

function handleSendMessage(authedFromId: string, body: SendMessageRequest): { ok: boolean; error?: string } {
  // S6: from_id is ALWAYS the authenticated peer — body.from_id is ignored.
  // S5: payload size cap.
  if (typeof body.text !== "string") return { ok: false, error: "text must be string" };
  if (utf8Bytes(body.text) > MAX_MSG_BYTES) return { ok: false, error: `text exceeds ${MAX_MSG_BYTES} bytes` };
  const target = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id) as { id: string } | null;
  if (!target) return { ok: false, error: `Peer ${body.to_id} not found` };
  insertMessage.run(authedFromId, body.to_id, body.text, new Date().toISOString());
  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];
  // Read-only: caller must explicitly ack via /ack-messages
  return { messages };
}

function handleAckMessages(body: AckMessagesRequest): { ok: boolean; acked: number } {
  const acked = db.transaction(() => {
    let count = 0;
    for (const id of body.ids) {
      const result = markDeliveredScoped.run(id, body.id);
      count += result.changes;
    }
    return count;
  })();
  return { ok: true, acked };
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
}

// --- HTTP Server ---

const server = Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
      }
      return new Response("claude-peers broker", { status: 200 });
    }

    // S5: bound the request body before parsing JSON. Bun's req.json()
    // would otherwise happily allocate hundreds of MB if a peer goes rogue.
    const lenHdr = req.headers.get("content-length");
    if (lenHdr && parseInt(lenHdr, 10) > MAX_REQ_BYTES) {
      return Response.json({ error: `request exceeds ${MAX_REQ_BYTES} bytes` }, { status: 413 });
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch (e) {
      return Response.json({ error: `invalid json: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 });
    }

    try {
      // /register is the only unauthenticated route — it issues the token.
      if (path === "/register") {
        const result = handleRegister(body as unknown as RegisterRequest);
        if (!result.ok) {
          return Response.json({ error: result.error }, { status: result.status });
        }
        // S5: count the registration request against the new peer's bucket.
        rateCheck(result.value.id, false);
        return Response.json(result.value);
      }

      // S2/S6: authenticate every other route. The peer ID comes from the
      // token lookup; the body's `id`/`from_id` is overwritten.
      // H2: do NOT include `exclude_id` in the chain — it is "id to exclude
      // from results", not an identity claim. Conflating them weakens the
      // model (a leaked token + the target's id in exclude_id would auth
      // as the target).
      const claimedId = reqStrict(body.id) || reqStrict(body.from_id);
      const auth = authPeer(req, claimedId, path);
      if (!auth.ok) return Response.json({ error: auth.error, reregister: true }, { status: auth.status });

      // S5 + M5: rate limit. /heartbeat is exempt — already bounded by the
      // client-side HEARTBEAT_INTERVAL_MS, and 429-ing it would cascade into
      // ghost-reaping a perfectly healthy peer.
      if (path !== "/heartbeat") {
        const limited = rateCheck(auth.id, path === "/send-message");
        if (limited) {
          return new Response(JSON.stringify({ error: limited }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": String(Math.ceil(RATE_WINDOW_MS / 1000)) },
          });
        }
      }

      switch (path) {
        case "/heartbeat":
          handleHeartbeat({ id: auth.id });
          return Response.json({ ok: true });
        case "/set-summary": {
          const summary = String(body.summary ?? "");
          if (utf8Bytes(summary) > MAX_SUMMARY_BYTES) {
            return Response.json({ error: `summary exceeds ${MAX_SUMMARY_BYTES} bytes` }, { status: 413 });
          }
          handleSetSummary({ id: auth.id, summary });
          return Response.json({ ok: true });
        }
        case "/list-peers":
          // Pass body through as-is; server.ts sets exclude_id explicitly when
          // it wants self-exclusion, but tests and ad-hoc callers may want to
          // see themselves in the listing.
          return Response.json(handleListPeers(body as unknown as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(auth.id, body as unknown as SendMessageRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages({ id: auth.id }));
        case "/ack-messages":
          return Response.json(handleAckMessages({ id: auth.id, ids: (body.ids as number[]) ?? [] }));
        case "/unregister":
          handleUnregister({ id: auth.id });
          buckets.delete(auth.id);
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      // H4: log full error + stack server-side, return a generic message
      // to the client. The previous behavior surfaced raw e.message which
      // could leak filesystem paths (e.g. /proc errors), DB schema details,
      // or prepared-statement diagnostics.
      console.error(`[broker] unhandled error on ${path}:`, e);
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  },
});

// S1: final post-bind assertion. If anything (Bun version drift, future
// refactor) ever made the listener bind off-loopback, exit immediately.
if (server.hostname !== "127.0.0.1") {
  console.error(`[claude-peers broker] FATAL: post-bind hostname is ${server.hostname}, expected 127.0.0.1`);
  process.exit(2);
}

console.error(`[claude-peers broker] listening on ${server.hostname}:${PORT} (db: ${DB_PATH}, uid: ${MY_UID})`);
