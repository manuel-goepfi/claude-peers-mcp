import { expect, test } from "bun:test";
import { bindPaneThread } from "../bin/codex-appserver-relay.ts";

const options = { paneId: "%1", socketPath: "/unused", upstreamSocketPath: "/unused",
  readyPath: "/unused", brokerPort: 1 };

test("binding recovers after an outage longer than the initial retry window", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const bound = await bindPaneThread(options, "test-thread", () => true, {
    request: (async () => ++attempts <= 22
      ? Response.json({}, { status: 503 })
      : Response.json({ id: "test-peer", folded: 0 })),
    delay: async (ms) => { delays.push(ms); },
  });
  expect(bound).toBe(true);
  expect(attempts).toBe(23);
  expect(Math.max(...delays)).toBeLessThanOrEqual(15000);
});

test("binding retries stop when the client closes or switches task", async () => {
  let current = true;
  let attempts = 0;
  const bound = await bindPaneThread(options, "test-thread", () => current, {
    request: async () => { attempts++; return Response.json({}, { status: 503 }); },
    delay: async () => { current = false; },
  });
  expect(bound).toBe(false);
  expect(attempts).toBe(1);
});

test("an authoritative ownership rejection is never retried", async () => {
  let attempts = 0;
  await bindPaneThread(options, "test-thread", () => true, {
    request: async () => { attempts++; return Response.json({ error: "live thread owner conflict" }, { status: 409 }); },
    delay: async () => { throw new Error("must not retry"); },
  });
  expect(attempts).toBe(1);
});
