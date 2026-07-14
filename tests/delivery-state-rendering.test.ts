import { describe, expect, test } from "bun:test";
import { messageStatusLine } from "../server.ts";

describe("MCP delivery-state rendering", () => {
  test("renders canonical claimed, acknowledged, and unknown states", () => {
    expect(messageStatusLine({ state: "claimed", delivered: false, delivered_at: null }, undefined)).toContain("Claimed by the receiver");
    expect(messageStatusLine({ state: "acknowledged", delivered: true, delivered_at: "2026-07-10T12:00:00.000Z" }, undefined)).toContain("Acknowledged at 2026-07-10T12:00:00.000Z");
    expect(messageStatusLine({ state: "unknown", delivered: true, delivered_at: null }, undefined)).toContain("Delivery state is unknown");
  });

  test("keeps the old-broker delivered fallback when state is absent", () => {
    expect(messageStatusLine({ delivered: true, delivered_at: "2026-07-10T12:00:00.000Z" }, undefined)).toContain("Acknowledged at 2026-07-10T12:00:00.000Z");
  });
});
