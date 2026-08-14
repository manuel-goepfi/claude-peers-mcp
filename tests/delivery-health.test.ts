import { describe, expect, test } from "bun:test";
import {
  recipientDeliveryHealth,
  adapterLivenessForSender,
  ADAPTER_CONTACT_FRESH_MS,
  UNDRAINED_WARN_MS,
  type RecipientDrainFacts,
} from "../shared/delivery-state.ts";
import { deliveryWarningLine } from "../server.ts";

const base: RecipientDrainFacts = {
  pending: 1,
  oldestPendingMs: 1_000,
  lastDrainAt: "2026-07-27T07:00:00.000Z",
  hasPane: true,
  hookDriven: true,
};

describe("recipientDeliveryHealth", () => {
  test("a seat draining normally warns about nothing", () => {
    const health = recipientDeliveryHealth(base);
    expect(health.state).toBe("healthy");
    expect(health.warning).toBeNull();
  });

  test("fresh mail on a nudgeable seat is not yet worth a warning", () => {
    const health = recipientDeliveryHealth({ ...base, oldestPendingMs: UNDRAINED_WARN_MS - 1 });
    expect(health.state).toBe("healthy");
  });

  test("mail older than the threshold is reported as undrained, not queued", () => {
    const health = recipientDeliveryHealth({
      ...base,
      pending: 23,
      oldestPendingMs: 8 * 3600_000,
    });
    expect(health.state).toBe("undrained");
    expect(health.warning).toContain("8h");
    expect(health.warning).toContain("23 message(s)");
    // The point of the whole feature: the sender must not read this as delivered.
    expect(health.warning).toContain("undelivered");
  });

  test("a seat with no pane and no hook is called out as having no drain path", () => {
    // The overnight failure: finished handoffs piled on a no-tmux codex lane in
    // manual-drain, and every sender saw plain success.
    const health = recipientDeliveryHealth({
      pending: 23,
      oldestPendingMs: 60_000,
      lastDrainAt: null,
      hasPane: false,
      hookDriven: false,
    });
    expect(health.state).toBe("no_drain_path");
    expect(health.nudgeable).toBe(false);
    expect(health.warning).toContain("no automatic drain path");
    expect(health.warning).toContain("check_messages");
  });

  test("no drain path outranks the age check, because age is not the problem", () => {
    const health = recipientDeliveryHealth({
      pending: 1,
      oldestPendingMs: 5 * 3600_000,
      lastDrainAt: null,
      hasPane: false,
      hookDriven: false,
    });
    expect(health.state).toBe("no_drain_path");
  });

  test("a pane with no hook is still nudgeable — the poller sends keys to it", () => {
    const health = recipientDeliveryHealth({ ...base, hookDriven: false, hasPane: true });
    expect(health.nudgeable).toBe(true);
    expect(health.state).toBe("healthy");
  });

  test("says so plainly when the recipient has never drained", () => {
    const health = recipientDeliveryHealth({
      ...base,
      lastDrainAt: null,
      oldestPendingMs: 2 * 3600_000,
    });
    expect(health.warning).toContain("has never drained");
  });

  test("an empty queue is healthy even for a seat that never drained", () => {
    const health = recipientDeliveryHealth({
      pending: 0,
      oldestPendingMs: null,
      lastDrainAt: null,
      hasPane: true,
      hookDriven: true,
    });
    expect(health.state).toBe("healthy");
    expect(health.warning).toBeNull();
  });

  test("reports minutes below an hour and h+m above it", () => {
    const m = recipientDeliveryHealth({ ...base, oldestPendingMs: 45 * 60_000 });
    expect(m.warning).toContain("45m");
    const hm = recipientDeliveryHealth({ ...base, oldestPendingMs: 90 * 60_000 });
    expect(hm.warning).toContain("1h30m");
    const h = recipientDeliveryHealth({ ...base, oldestPendingMs: 2 * 3600_000 });
    expect(h.warning).toContain("2h");
  });

  test("honours a caller-supplied threshold", () => {
    const health = recipientDeliveryHealth({ ...base, oldestPendingMs: 5_000, undrainedWarnMs: 1_000 });
    expect(health.state).toBe("undrained");
  });

  test("carries the raw facts so callers can render their own view", () => {
    const health = recipientDeliveryHealth({ ...base, pending: 4, oldestPendingMs: 123 });
    expect(health.pending).toBe(4);
    expect(health.oldest_pending_ms).toBe(123);
    expect(health.last_drain_at).toBe(base.lastDrainAt);
  });
});

describe("mcp_transport surfacing", () => {
  test("absent facts leave the field off and warnings unchanged", () => {
    const health = recipientDeliveryHealth(base);
    expect("mcp_transport" in health).toBe(false);
    expect(health.warning).toBeNull();
  });

  test("an alive adapter is reported without any warning", () => {
    const health = recipientDeliveryHealth({ ...base, mcpTransport: "alive" });
    expect(health.mcp_transport).toBe("alive");
    expect(health.state).toBe("healthy");
    expect(health.warning).toBeNull();
  });

  test("a dead adapter warns the sender even on an otherwise healthy seat", () => {
    const health = recipientDeliveryHealth({ ...base, mcpTransport: "dead" });
    expect(health.mcp_transport).toBe("dead");
    // Drain state is unchanged — receipt still works via hooks.
    expect(health.state).toBe("healthy");
    expect(health.warning).toContain("MCP adapter is not running");
    expect(health.warning).toContain("hook mail still delivers");
  });

  test("a dead adapter appends to an existing drain warning instead of replacing it", () => {
    const health = recipientDeliveryHealth({
      ...base,
      mcpTransport: "dead",
      oldestPendingMs: UNDRAINED_WARN_MS + 1,
      pending: 3,
    });
    expect(health.state).toBe("undrained");
    expect(health.warning).toContain("Treat this as undelivered");
    expect(health.warning).toContain("MCP adapter is not running");
  });
});

describe("adapterLivenessForSender", () => {
  const now = Date.parse("2026-08-14T04:50:00.000Z");
  const freshSeen = new Date(now - 5_000).toISOString();
  const olderHook = new Date(now - 60_000).toISOString();

  test("leaves alive and unknown untouched", () => {
    expect(adapterLivenessForSender("alive", freshSeen, olderHook, now)).toBe("alive");
    expect(adapterLivenessForSender("unknown", freshSeen, olderHook, now)).toBe("unknown");
  });

  test("keeps PID-dead when there is no hook stamp (registration-only Transport-closed)", () => {
    expect(adapterLivenessForSender("dead", freshSeen, null, now)).toBe("dead");
    expect(adapterLivenessForSender("dead", freshSeen, undefined, now)).toBe("dead");
  });

  test("keeps PID-dead when last_seen is not newer than last_hook (hook-only drain)", () => {
    expect(adapterLivenessForSender("dead", olderHook, olderHook, now)).toBe("dead");
    expect(adapterLivenessForSender("dead", olderHook, freshSeen, now)).toBe("dead");
  });

  test("keeps PID-dead when MCP contact is older than the freshness window", () => {
    const staleSeen = new Date(now - ADAPTER_CONTACT_FRESH_MS - 1).toISOString();
    expect(adapterLivenessForSender("dead", staleSeen, olderHook, now)).toBe("dead");
  });

  test("promotes PID-dead to alive when a fresh last_seen is strictly after last_hook", () => {
    expect(adapterLivenessForSender("dead", freshSeen, olderHook, now)).toBe("alive");
  });
});

describe("deliveryWarningLine", () => {
  test("renders nothing when the recipient is healthy", () => {
    expect(deliveryWarningLine(recipientDeliveryHealth(base))).toBe("");
    expect(deliveryWarningLine(undefined)).toBe("");
  });

  test("renders the warning on its own marked line", () => {
    const health = recipientDeliveryHealth({ ...base, oldestPendingMs: 3 * 3600_000, pending: 7 });
    const line = deliveryWarningLine(health);
    expect(line.startsWith("\n\n⚠ ")).toBe(true);
    expect(line).toContain("7 message(s)");
  });
});
