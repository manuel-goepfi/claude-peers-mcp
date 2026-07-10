import { describe, expect, test } from "bun:test";
import { RuntimeMetrics } from "../shared/runtime-metrics.ts";
import { startTestBroker } from "./helpers/test-broker.ts";

describe("runtime aggregate metrics", () => {
  test("counts every route in totals and one-second buckets", () => {
    const metrics = new RuntimeMetrics(true, 1_000);
    metrics.recordRoute("get", "/health", 1_100);
    metrics.recordRoute("post", "/heartbeat", 1_200);
    metrics.recordRoute("post", "/heartbeat", 2_100);
    expect(metrics.snapshot().route_totals).toEqual({ "GET /health": 1, "POST /heartbeat": 2 });
    expect(metrics.snapshot().route_buckets).toEqual([
      { epoch_second: 1, total: 2, routes: { "GET /health": 1, "POST /heartbeat": 1 } },
      { epoch_second: 2, total: 1, routes: { "POST /heartbeat": 1 } },
    ]);
  });

  test("exposes aggregate queue latency without message ids or content", () => {
    const metrics = new RuntimeMetrics(true, 0);
    const sent = new Date(1_000).toISOString();
    for (const [id, now] of [[1, 1_010], [2, 1_020], [3, 1_100], [4, 1_200]] as const) metrics.recordQueueToBuffer(id, sent, now);
    metrics.recordQueueToBuffer(1, sent, 9_999);
    for (const now of [1_030, 1_050, 1_150]) metrics.recordQueueToAck(sent, now);
    const snapshot = metrics.snapshot();
    expect(snapshot.queue_to_buffer).toEqual({ count: 4, p50_ms: 20, p95_ms: 200, max_ms: 200 });
    expect(snapshot.queue_to_ack).toEqual({ count: 3, p50_ms: 50, p95_ms: 150, max_ms: 150 });
    expect(JSON.stringify(snapshot)).not.toContain("message");
  });

  test("disabled metrics are a near-no-op with an explicit disabled snapshot", () => {
    const metrics = new RuntimeMetrics(false, 0);
    metrics.recordRoute("POST", "/poll-messages", 1_000);
    metrics.recordQueueToBuffer(1, new Date(0).toISOString(), 1_000);
    metrics.recordQueueToAck(new Date(0).toISOString(), 1_000);
    expect(metrics.snapshot()).toMatchObject({ enabled: false, route_totals: {}, route_buckets: [], queue_to_buffer: { count: 0 }, queue_to_ack: { count: 0 } });
  });

  test("broker exposes metrics only through an authenticated aggregate route", async () => {
    const broker = await startTestBroker({ prefix: "runtime-metrics" });
    try {
      await fetch(`${broker.url}/health`);
      const registration = await fetch(`${broker.url}/register-cli`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid: process.pid }),
      }).then((response) => response.json()) as { id: string; token: string };
      const unauthenticated = await fetch(`${broker.url}/metrics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: registration.id }),
      });
      expect(unauthenticated.status).toBe(401);
      const authenticated = await fetch(`${broker.url}/metrics`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Peer-Token": registration.token },
        body: JSON.stringify({ id: registration.id }),
      });
      expect(authenticated.status).toBe(200);
      const snapshot = await authenticated.json() as { enabled: boolean; route_totals: Record<string, number> };
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.route_totals["GET /health"]).toBeGreaterThanOrEqual(2);
      expect(snapshot.route_totals["POST /metrics"]).toBe(2);
      expect(JSON.stringify(snapshot)).not.toContain(registration.id);
      expect(JSON.stringify(snapshot)).not.toContain(registration.token);
    } finally {
      await broker.stop();
    }
  });
});
