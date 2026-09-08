import { expect, test } from "bun:test";
import { brokerFetch } from "../server.ts";

test("a hung heartbeat request expires and the next request can recover", async () => {
  const originalFetch = globalThis.fetch;
  const cleanup = new AbortController();
  let first = true;
  globalThis.fetch = ((_: unknown, init: RequestInit) => {
    if (!first) return Promise.resolve(Response.json({ ok: true }));
    first = false;
    return new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
  }) as typeof fetch;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = brokerFetch("/heartbeat", {}, false, cleanup.signal)
      .then(() => "unexpected success", (error) => error.name);
    const result = await Promise.race([
      pending,
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve("still hung"), 3500); }),
    ]);
    expect(result).toBe("TimeoutError");
    expect(await brokerFetch<{ ok: boolean }>("/heartbeat", {})).toEqual({ ok: true });
  } finally {
    cleanup.abort();
    clearTimeout(timer);
    globalThis.fetch = originalFetch;
  }
}, 5000);
