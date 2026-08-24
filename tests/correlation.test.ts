import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startTestBroker, type TestBroker } from "./helpers/test-broker.ts";
import type { ReplyStatusResponse, SendMessageResponse } from "../shared/types.ts";

const SERVER_SCRIPT = new URL("../server.ts", import.meta.url).pathname;
const REPO_ROOT = new URL("..", import.meta.url).pathname;

interface RegisteredPeer {
  id: string;
  token: string;
  pid: number;
  child: ReturnType<typeof Bun.spawn>;
}

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  let firstFailure: unknown = null;
  while (cleanup.length > 0) {
    try {
      await cleanup.pop()!();
    } catch (error) {
      firstFailure ??= error;
    }
  }
  if (firstFailure) throw firstFailure;
});

async function post<T>(broker: TestBroker, path: string, body: unknown, token?: string): Promise<T> {
  const response = await fetch(`${broker.url}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Peer-Token": token } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await response.json() as T;
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function registerPeer(broker: TestBroker, name: string): Promise<RegisteredPeer> {
  const child = Bun.spawn(["sleep", "60"]);
  cleanup.push(() => child.kill());
  const registered = await post<{ id: string; token: string }>(broker, "/register", {
    pid: child.pid,
    cwd: `/correlation/${name}`,
    git_root: null,
    tty: null,
    name,
    tmux_session: null,
    tmux_window_index: null,
    tmux_window_name: null,
    client_type: "unknown",
    receiver_mode: "manual-drain",
    summary: "",
  });
  return { ...registered, pid: child.pid, child };
}

async function fixture(prefix: string): Promise<{
  broker: TestBroker;
  alice: RegisteredPeer;
  bob: RegisteredPeer;
  carol: RegisteredPeer;
}> {
  const broker = await startTestBroker({ prefix });
  cleanup.push(() => broker.stop());
  return {
    broker,
    alice: await registerPeer(broker, `${prefix}-alice`),
    bob: await registerPeer(broker, `${prefix}-bob`),
    carol: await registerPeer(broker, `${prefix}-carol`),
  };
}

function send(
  broker: TestBroker,
  from: RegisteredPeer,
  to: RegisteredPeer,
  text: string,
  requestId?: string,
  replyToId?: string,
): Promise<SendMessageResponse> {
  return post<SendMessageResponse>(broker, "/send-message", {
    from_id: from.id,
    to_id: to.id,
    text,
    ...(requestId === undefined ? {} : { request_id: requestId }),
    ...(replyToId === undefined ? {} : { reply_to_id: replyToId }),
  }, from.token);
}

function replyStatus(
  broker: TestBroker,
  peer: RegisteredPeer,
  requestId: string,
): Promise<ReplyStatusResponse> {
  return post<ReplyStatusResponse>(broker, "/reply-status", {
    id: peer.id,
    request_id: requestId,
    pid: peer.pid,
    caller_pid: process.pid,
  }, peer.token);
}

describe("correlated 1:1 broker contract", () => {
  test("generates request IDs and exposes them on the inbound row", async () => {
    const { broker, alice, bob } = await fixture("generated-id");
    const result = await send(broker, alice, bob, "hello");
    expect(result).toMatchObject({ ok: true, state: "queued" });
    expect(result.request_id).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    const db = new Database(broker.dbPath, { readonly: true });
    try {
      expect(db.query("SELECT request_id,reply_to_id FROM messages WHERE id=?").get(result.id!)).toEqual({
        request_id: result.request_id,
        reply_to_id: null,
      });
    } finally {
      db.close();
    }
  });

  test("identical concurrent retries create one row and one unread episode", async () => {
    const { broker, alice, bob } = await fixture("idempotent");
    const [left, right] = await Promise.all([
      send(broker, alice, bob, "same body", "stable-request"),
      send(broker, alice, bob, "same body", "stable-request"),
    ]);
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    expect(left.id).toBe(right.id);
    expect([left.deduplicated, right.deduplicated]).toContain(true);
    const db = new Database(broker.dbPath, { readonly: true });
    try {
      expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE from_id=? AND request_id=?").get(alice.id, "stable-request"))
        .toEqual({ count: 1 });
      expect(db.query("SELECT unread_episode FROM peers WHERE id=?").get(bob.id)).toEqual({ unread_episode: 1 });
    } finally {
      db.close();
    }
  });

  test("idempotent retries report the stored claimed and acknowledged states", async () => {
    const { broker, alice, bob } = await fixture("retry-state");
    const first = await send(broker, alice, bob, "stateful retry", "retry-state-request");
    const claimed = await post<{ ok: boolean; drain_id: string; messages: Array<{ id: number }> }>(broker, "/claim-by-pid", {
      pid: bob.pid,
      caller_pid: process.pid,
      drain_id: "retry-state-drain",
    });
    expect(claimed.messages).toEqual([expect.objectContaining({ id: first.id })]);
    expect(await send(broker, alice, bob, "stateful retry", "retry-state-request"))
      .toMatchObject({ ok: true, id: first.id, deduplicated: true, state: "claimed" });
    expect(await post(broker, "/ack-by-pid", {
      pid: bob.pid,
      caller_pid: process.pid,
      drain_id: claimed.drain_id,
      ids: [first.id],
    })).toMatchObject({ ok: true, acked: 1 });
    expect(await send(broker, alice, bob, "stateful retry", "retry-state-request"))
      .toMatchObject({ ok: true, id: first.id, deduplicated: true, state: "acknowledged" });
  });

  test("changed retry payloads fail closed without mutation", async () => {
    const { broker, alice, bob, carol } = await fixture("conflict");
    const first = await send(broker, alice, bob, "original", "conflict-id");
    expect(first.ok).toBe(true);
    for (const attempt of [
      () => send(broker, alice, bob, "changed", "conflict-id"),
      () => send(broker, alice, carol, "original", "conflict-id"),
    ]) {
      expect(await attempt()).toMatchObject({ ok: false, code: "REQUEST_ID_CONFLICT" });
    }
    const db = new Database(broker.dbPath, { readonly: true });
    try {
      expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE from_id=? AND request_id=?").get(alice.id, "conflict-id"))
        .toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  test("an identical explicit-id retry returns the stored row after its recipient becomes stale", async () => {
    const { broker, alice, bob } = await fixture("stale-retry");
    const first = await send(broker, alice, bob, "durable retry", "stale-request");
    expect(first.ok).toBe(true);
    bob.child.kill("SIGTERM");
    await bob.child.exited;

    const retry = await send(broker, alice, bob, "durable retry", "stale-request");
    expect(retry).toMatchObject({
      ok: true,
      id: first.id,
      request_id: "stale-request",
      deduplicated: true,
      state: "queued",
    });
    expect(await send(broker, alice, bob, "changed", "stale-request"))
      .toMatchObject({ ok: false, code: "REQUEST_ID_CONFLICT" });
  });

  test("valid first reply links in the exact direction and a second reply is rejected", async () => {
    const { broker, alice, bob } = await fixture("reply");
    expect((await send(broker, alice, bob, "question", "question-1")).ok).toBe(true);
    const firstReply = await send(broker, bob, alice, "answer", "answer-1", "question-1");
    expect(firstReply).toMatchObject({ ok: true, request_id: "answer-1" });
    expect(await send(broker, bob, alice, "another", "answer-2", "question-1"))
      .toMatchObject({ ok: false, code: "REPLY_ALREADY_EXISTS" });
  });

  test("forged and wrong-direction reply links share the no-oracle error", async () => {
    const { broker, alice, bob, carol } = await fixture("forged");
    expect((await send(broker, alice, bob, "question", "private-request")).ok).toBe(true);
    expect(await send(broker, carol, alice, "forged", "carol-reply", "private-request"))
      .toMatchObject({ ok: false, code: "REQUEST_NOT_FOUND", error: "request not found" });
    expect(await send(broker, bob, carol, "wrong target", "bob-wrong", "private-request"))
      .toMatchObject({ ok: false, code: "REQUEST_NOT_FOUND", error: "request not found" });
    expect(await replyStatus(broker, carol, "private-request"))
      .toMatchObject({ ok: false, code: "REQUEST_NOT_FOUND", error: "request not found" });
    expect(await replyStatus(broker, carol, "does-not-exist"))
      .toMatchObject({ ok: false, code: "REQUEST_NOT_FOUND", error: "request not found" });
  });

  test("reply status rejects a mismatched exact session without claiming the body", async () => {
    const { broker, alice, bob } = await fixture("status-identity");
    await send(broker, alice, bob, "question", "identity-request");
    await send(broker, bob, alice, "answer", "identity-answer", "identity-request");
    const rejected = await fetch(`${broker.url}/reply-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Peer-Token": alice.token },
      body: JSON.stringify({
        id: alice.id,
        request_id: "identity-request",
        pid: bob.pid,
        caller_pid: process.pid,
      }),
    });
    expect(rejected.status).toBe(403);
    const db = new Database(broker.dbPath, { readonly: true });
    try {
      expect(db.query("SELECT claimed_by,claimed_at FROM messages WHERE reply_to_id=?").get("identity-request"))
        .toEqual({ claimed_by: null, claimed_at: null });
    } finally {
      db.close();
    }
    expect(await replyStatus(broker, alice, "identity-request"))
      .toMatchObject({ ok: true, delivery: "claimed_here", message: { text: "answer" } });
  });

  test("an already leased reply reports claimed_elsewhere without exposing its body", async () => {
    const { broker, alice, bob } = await fixture("claimed-elsewhere");
    await send(broker, alice, bob, "question", "elsewhere-request");
    await send(broker, bob, alice, "answer", "elsewhere-answer", "elsewhere-request");
    const claimed = await post<{ ok: boolean; drain_id: string; messages: Array<{ id: number }> }>(broker, "/claim-by-pid", {
      pid: alice.pid,
      caller_pid: process.pid,
      drain_id: "ordinary-elsewhere-drain",
    });
    expect(claimed.messages).toHaveLength(1);
    expect(await replyStatus(broker, alice, "elsewhere-request")).toEqual({
      ok: true,
      status: "replied",
      delivery: "claimed_elsewhere",
      request_id: "elsewhere-request",
    });
  });

  test("status transitions pending to one exclusive reply claim and acknowledged", async () => {
    const { broker, alice, bob } = await fixture("status");
    expect((await send(broker, alice, bob, "question", "status-request")).ok).toBe(true);
    expect(await replyStatus(broker, alice, "status-request"))
      .toMatchObject({ ok: true, status: "pending", delivery: "none" });
    expect((await send(broker, bob, alice, "answer", "status-answer", "status-request")).ok).toBe(true);

    const [status, inbox] = await Promise.all([
      replyStatus(broker, alice, "status-request"),
      post<{ ok: boolean; drain_id: string; messages: Array<{ id: number; text: string }> }>(broker, "/claim-by-pid", {
        pid: alice.pid,
        caller_pid: process.pid,
        drain_id: "ordinary-inbox-racer",
      }),
    ]);
    const statusWon = status.delivery === "claimed_here" ? 1 : 0;
    expect(status).toMatchObject({ ok: true, status: "replied" });
    expect(statusWon + inbox.messages.length).toBe(1);
    const winningDrain = statusWon === 1 ? status.drain_id! : inbox.drain_id;
    const winningId = statusWon === 1 ? status.message!.id : inbox.messages[0]!.id;
    expect(await post(broker, "/ack-by-pid", {
      pid: alice.pid,
      caller_pid: process.pid,
      drain_id: winningDrain,
      ids: [winningId],
    })).toMatchObject({ ok: true, acked: 1 });
    expect(await replyStatus(broker, alice, "status-request"))
      .toMatchObject({ ok: true, status: "replied", delivery: "acknowledged" });
  });

  test("an unacknowledged status claim becomes claimable after lease expiry", async () => {
    const { broker, alice, bob } = await fixture("lease");
    await send(broker, alice, bob, "question", "lease-request");
    await send(broker, bob, alice, "answer", "lease-answer", "lease-request");
    const first = await replyStatus(broker, alice, "lease-request");
    expect(first).toMatchObject({ ok: true, delivery: "claimed_here" });
    const db = new Database(broker.dbPath);
    try {
      db.run("UPDATE messages SET claimed_at=? WHERE id=?", [new Date(Date.now() - 60_000).toISOString(), first.message!.id]);
    } finally {
      db.close();
    }
    const retried = await replyStatus(broker, alice, "lease-request");
    expect(retried).toMatchObject({ ok: true, delivery: "claimed_here" });
    expect(retried.message?.id).toBe(first.message?.id);
    expect(retried.drain_id).not.toBe(first.drain_id);
  });

  test("invalid correlation IDs never insert rows", async () => {
    const { broker, alice, bob } = await fixture("invalid");
    for (const requestId of ["", "bad/id", "x".repeat(129)]) {
      expect(await send(broker, alice, bob, "invalid", requestId))
        .toMatchObject({ ok: false, code: "INVALID_REQUEST_ID" });
    }
    const db = new Database(broker.dbPath, { readonly: true });
    try {
      expect(db.query("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  test("send_to_peer uses the same idempotent correlation path", async () => {
    const { broker, alice, bob } = await fixture("selector");
    const body = {
      from_id: alice.id,
      selector: { id: bob.id },
      text: "selector send",
      request_id: "selector-request",
    };
    const first = await post<SendMessageResponse>(broker, "/send-to-peer", body, alice.token);
    const retry = await post<SendMessageResponse>(broker, "/send-to-peer", body, alice.token);
    expect(first.id).toBe(retry.id);
    expect(retry).toMatchObject({ ok: true, request_id: "selector-request", deduplicated: true });
  });

  test("a non-ID selector retry returns the original row after the recipient becomes stale", async () => {
    const { broker, alice, bob } = await fixture("selector-stale");
    const body = {
      from_id: alice.id,
      selector: { name: "selector-stale-bob" },
      text: "selector retry",
      request_id: "selector-stale-request",
    };
    const first = await post<SendMessageResponse>(broker, "/send-to-peer", body, alice.token);
    bob.child.kill("SIGTERM");
    await bob.child.exited;
    const retry = await post<SendMessageResponse>(broker, "/send-to-peer", body, alice.token);
    expect(retry).toMatchObject({
      ok: true,
      id: first.id,
      request_id: "selector-stale-request",
      deduplicated: true,
    });
  });

  test("a missing selector fails closed without throwing or inserting mail", async () => {
    const { broker, alice } = await fixture("selector-missing");
    expect(await post<SendMessageResponse>(broker, "/send-to-peer", {
      from_id: alice.id,
      selector: null,
      text: "nowhere",
      request_id: "missing-selector-request",
    }, alice.token)).toMatchObject({ ok: false, code: "INVALID_SELECTOR" });
    const db = new Database(broker.dbPath, { readonly: true });
    try {
      expect(db.query("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});

test("MCP send and get_reply_status render and acknowledge the correlated reply", async () => {
  const broker = await startTestBroker({ prefix: "mcp-correlation" });
  cleanup.push(() => broker.stop());
  const env = Object.fromEntries(Object.entries({
    ...process.env,
    CLAUDE_PEERS_PORT: String(broker.port),
    CLAUDE_PEERS_DB: broker.dbPath,
    CLAUDE_PEERS_BRIDGE_TOKEN_FILE: broker.tokenPath,
    CLAUDE_PEERS_CLIENT_TYPE: "unknown",
    CLAUDE_PEER_NAME: "mcp-correlation-requester",
    CLAUDE_PEERS_TMUX_IDENTITY_MIRROR: "0",
    TMUX: undefined,
    TMUX_PANE: undefined,
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({ command: "bun", args: [SERVER_SCRIPT], cwd: REPO_ROOT, env, stderr: "pipe" });
  const client = new Client({ name: "correlation-test", version: "1" });
  cleanup.push(() => client.close());
  await client.connect(transport);

  const deadline = Date.now() + 8_000;
  let requester: { id: string; pid: number } | null = null;
  while (!requester && Date.now() < deadline) {
    const db = new Database(broker.dbPath, { readonly: true });
    try {
      requester = db.query("SELECT id,pid FROM peers WHERE name=?").get("mcp-correlation-requester") as typeof requester;
    } finally {
      db.close();
    }
    if (!requester) await Bun.sleep(50);
  }
  expect(requester).not.toBeNull();
  const responder = await registerPeer(broker, "mcp-correlation-responder");
  const sent = await client.callTool({
    name: "send_message",
    arguments: { to_id: responder.id, message: "MCP question", request_id: "mcp-request" },
  });
  expect(sent.content).toEqual([expect.objectContaining({ text: expect.stringContaining("request_id=mcp-request") })]);
  expect((await send(broker, responder, { ...requester!, token: "", child: responder.child }, "MCP answer", "mcp-answer", "mcp-request")).ok).toBe(true);

  const status = await client.callTool({ name: "get_reply_status", arguments: { request_id: "mcp-request" } });
  const statusContent = status.content as Array<{ type: string; text: string }>;
  expect(statusContent).toEqual([expect.objectContaining({
    text: expect.stringContaining("MCP answer"),
  })]);
  const rendered = statusContent[0]!.text;
  expect(rendered).toContain('request_id="mcp-answer"');
  expect(rendered).toContain('reply_to_id="mcp-request"');
  expect(rendered).toContain("delivery=claimed_here");

  const db = new Database(broker.dbPath, { readonly: true });
  try {
    expect(db.query("SELECT delivered,delivered_at FROM messages WHERE reply_to_id=?").get("mcp-request"))
      .toEqual({ delivered: 1, delivered_at: expect.any(String) });
  } finally {
    db.close();
  }
  const repeated = await client.callTool({ name: "get_reply_status", arguments: { request_id: "mcp-request" } });
  const repeatedContent = repeated.content as Array<{ type: string; text: string }>;
  expect(repeatedContent).toEqual([expect.objectContaining({ text: expect.stringContaining("delivery=acknowledged") })]);
  expect(repeatedContent[0]!.text).not.toContain("MCP answer");
}, { timeout: 15_000 });

test("get_reply_status returns the claimed body when ACK fails and retries after lease expiry", async () => {
  const broker = await startTestBroker({ prefix: "reply-ack-failure" });
  cleanup.push(() => broker.stop());
  let ackAttempts = 0;
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const source = new URL(request.url);
      if (request.method === "POST" && source.pathname === "/ack-by-pid") {
        ackAttempts++;
        return Response.json({ ok: true, acked: 0 });
      }
      return fetch(new Request(new URL(source.pathname + source.search, broker.url).href, request));
    },
  });
  cleanup.push(() => proxy.stop(true));
  const env = Object.fromEntries(Object.entries({
    ...process.env,
    CLAUDE_PEERS_PORT: String(proxy.port),
    CLAUDE_PEERS_DB: broker.dbPath,
    CLAUDE_PEERS_BRIDGE_TOKEN_FILE: broker.tokenPath,
    CLAUDE_PEERS_CLIENT_TYPE: "unknown",
    CLAUDE_PEER_NAME: "reply-ack-failure-requester",
    CLAUDE_PEERS_TMUX_IDENTITY_MIRROR: "0",
    TMUX: undefined,
    TMUX_PANE: undefined,
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({ command: "bun", args: [SERVER_SCRIPT], cwd: REPO_ROOT, env, stderr: "pipe" });
  const client = new Client({ name: "reply-ack-failure-test", version: "1" });
  cleanup.push(() => client.close());
  await client.connect(transport);

  const deadline = Date.now() + 8_000;
  let requester: { id: string; pid: number } | null = null;
  while (!requester && Date.now() < deadline) {
    const db = new Database(broker.dbPath, { readonly: true });
    try {
      requester = db.query("SELECT id,pid FROM peers WHERE name=?").get("reply-ack-failure-requester") as typeof requester;
    } finally {
      db.close();
    }
    if (!requester) await Bun.sleep(50);
  }
  expect(requester).not.toBeNull();
  const responder = await registerPeer(broker, "reply-ack-failure-responder");
  await client.callTool({
    name: "send_message",
    arguments: { to_id: responder.id, message: "question", request_id: "ack-failure-request" },
  });
  await send(
    broker,
    responder,
    { ...requester!, token: "", child: responder.child },
    "answer survives failed ACK",
    "ack-failure-answer",
    "ack-failure-request",
  );

  const first = await client.callTool({ name: "get_reply_status", arguments: { request_id: "ack-failure-request" } });
  const firstText = (first.content as Array<{ text: string }>)[0]!.text;
  expect(firstText).toContain("answer survives failed ACK");
  expect(firstText).toContain("acknowledgement failed");
  expect(ackAttempts).toBe(1);
  const db = new Database(broker.dbPath);
  try {
    const row = db.query("SELECT id,delivered,claimed_at FROM messages WHERE reply_to_id=?").get("ack-failure-request") as {
      id: number;
      delivered: number;
      claimed_at: string | null;
    };
    expect(row.delivered).toBe(0);
    expect(row.claimed_at).not.toBeNull();
    db.run("UPDATE messages SET claimed_at=? WHERE id=?", [new Date(Date.now() - 60_000).toISOString(), row.id]);
  } finally {
    db.close();
  }

  const retried = await client.callTool({ name: "get_reply_status", arguments: { request_id: "ack-failure-request" } });
  expect((retried.content as Array<{ text: string }>)[0]!.text).toContain("answer survives failed ACK");
  expect(ackAttempts).toBe(2);
}, { timeout: 15_000 });
