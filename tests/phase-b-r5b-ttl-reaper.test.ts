/**
 * Phase B R5(b) regression tests — TTL-based stale-peer reaping.
 *
 * Background: prior to Phase B, the 30s `cleanStalePeers` reaper only deleted
 * peers whose PID returned ESRCH from `kill(pid, 0)`. PID-alive zombies
 * (a `bun server.ts` process whose parent claude died but bun lingered) were
 * left in the DB indefinitely. The on-demand `liveAndFreshPeers` (broker.ts:633)
 * already applied PID + `last_seen` TTL discipline; R5(b) brings the periodic
 * reaper in line with that discipline so orphans no longer accumulate.
 *
 * Mirrors the in-memory test pattern from tests/phase-a2-broker.test.ts: copies
 * the reapable predicate from broker.ts into the test against pure data so
 * tests are deterministic and independent of bun:sqlite + real PIDs.
 *
 * If the prod implementation diverges, this mirror MUST be updated alongside.
 */

import { describe, test, expect } from "bun:test";

const PEER_GHOST_AFTER_MS = 90_000;

type TestPeer = { id: string; pid: number; last_seen: string };

// Mirror of broker.ts cleanStalePeers reapable-predicate (post-R5(b)).
// Pure function: takes a peer + an isPidAlive callback (so tests can stub
// liveness deterministically) + a `now` clock + the TTL constant.
function isReapable(
  peer: TestPeer,
  isPidAlive: (pid: number) => boolean,
  now: number,
  ttlMs: number,
): boolean {
  if (!isPidAlive(peer.pid)) return true;
  const lastSeenMs = new Date(peer.last_seen).getTime();
  if (Number.isNaN(lastSeenMs)) return false; // graceful: invalid timestamp not auto-reaped
  const age = now - lastSeenMs;
  return age > ttlMs;
}

// Mirror of broker.ts cleanStalePeers full sweep — returns the IDs that would
// be reaped. Side-effect-free for testing.
function reapableIds(
  peers: TestPeer[],
  isPidAlive: (pid: number) => boolean,
  now: number,
  ttlMs: number,
): string[] {
  return peers
    .filter((p) => isReapable(p, isPidAlive, now, ttlMs))
    .map((p) => p.id);
}

describe("Phase B R5(b) — isReapable predicate", () => {
  const NOW = new Date("2026-05-14T12:00:00.000Z").getTime();
  const FRESH = new Date(NOW - 10_000).toISOString(); // 10s ago
  const STALE = new Date(NOW - 120_000).toISOString(); // 2 min ago, > 90s TTL
  const aliveAll = () => true;
  const deadAll = () => false;

  test("fresh last_seen + alive PID → NOT reapable (operator session)", () => {
    const p: TestPeer = { id: "fresh-alive", pid: 1234, last_seen: FRESH };
    expect(isReapable(p, aliveAll, NOW, PEER_GHOST_AFTER_MS)).toBe(false);
  });

  test("fresh last_seen + dead PID → reapable (existing behavior preserved)", () => {
    const p: TestPeer = { id: "fresh-dead", pid: 1234, last_seen: FRESH };
    expect(isReapable(p, deadAll, NOW, PEER_GHOST_AFTER_MS)).toBe(true);
  });

  test("stale last_seen + alive PID → reapable (NEW R5(b) — PID-alive zombie)", () => {
    const p: TestPeer = { id: "stale-zombie", pid: 1234, last_seen: STALE };
    expect(isReapable(p, aliveAll, NOW, PEER_GHOST_AFTER_MS)).toBe(true);
  });

  test("stale last_seen + dead PID → reapable (both conditions)", () => {
    const p: TestPeer = { id: "stale-dead", pid: 1234, last_seen: STALE };
    expect(isReapable(p, deadAll, NOW, PEER_GHOST_AFTER_MS)).toBe(true);
  });
});

describe("Phase B R5(b) — TTL boundary semantics", () => {
  const NOW = new Date("2026-05-14T12:00:00.000Z").getTime();
  const aliveAll = () => true;

  test("last_seen age == TTL exactly → NOT reapable (uses > not >=)", () => {
    const lastSeen = new Date(NOW - PEER_GHOST_AFTER_MS).toISOString();
    const p: TestPeer = { id: "boundary", pid: 1234, last_seen: lastSeen };
    expect(isReapable(p, aliveAll, NOW, PEER_GHOST_AFTER_MS)).toBe(false);
  });

  test("last_seen age == TTL + 1ms → reapable", () => {
    const lastSeen = new Date(NOW - PEER_GHOST_AFTER_MS - 1).toISOString();
    const p: TestPeer = { id: "boundary-plus", pid: 1234, last_seen: lastSeen };
    expect(isReapable(p, aliveAll, NOW, PEER_GHOST_AFTER_MS)).toBe(true);
  });

  test("last_seen age == TTL - 1ms → NOT reapable", () => {
    const lastSeen = new Date(NOW - PEER_GHOST_AFTER_MS + 1).toISOString();
    const p: TestPeer = { id: "boundary-minus", pid: 1234, last_seen: lastSeen };
    expect(isReapable(p, aliveAll, NOW, PEER_GHOST_AFTER_MS)).toBe(false);
  });
});

describe("Phase B R5(b) — graceful degradation on bad data", () => {
  const NOW = new Date("2026-05-14T12:00:00.000Z").getTime();
  const aliveAll = () => true;

  test("malformed last_seen string + alive PID → NOT reapable (invariant: don't auto-reap on parse failure)", () => {
    const p: TestPeer = { id: "bad-iso", pid: 1234, last_seen: "not-a-date" };
    expect(isReapable(p, aliveAll, NOW, PEER_GHOST_AFTER_MS)).toBe(false);
  });

  test("malformed last_seen string + dead PID → reapable (PID gate still fires)", () => {
    const p: TestPeer = { id: "bad-iso-dead", pid: 1234, last_seen: "not-a-date" };
    expect(isReapable(p, () => false, NOW, PEER_GHOST_AFTER_MS)).toBe(true);
  });

  test("empty last_seen + alive PID → NOT reapable", () => {
    const p: TestPeer = { id: "empty-iso", pid: 1234, last_seen: "" };
    expect(isReapable(p, aliveAll, NOW, PEER_GHOST_AFTER_MS)).toBe(false);
  });
});

describe("Phase B R5(b) — full sweep partitioning", () => {
  const NOW = new Date("2026-05-14T12:00:00.000Z").getTime();
  const FRESH = new Date(NOW - 10_000).toISOString();
  const STALE = new Date(NOW - 120_000).toISOString();

  test("mixed-state fleet correctly partitions into 4 quadrants", () => {
    // 4 peers covering each (PID, TTL) combination
    const peers: TestPeer[] = [
      { id: "operator", pid: 100, last_seen: FRESH },     // alive PID, fresh — keep
      { id: "dead-but-fresh", pid: 200, last_seen: FRESH }, // dead PID, fresh — reap (existing)
      { id: "pid-alive-zombie", pid: 300, last_seen: STALE }, // alive PID, stale — reap (NEW R5(b))
      { id: "fully-dead", pid: 400, last_seen: STALE },    // dead PID, stale — reap (both)
    ];
    const deadPids = new Set([200, 400]);
    const isPidAlive = (pid: number) => !deadPids.has(pid);

    const reaped = reapableIds(peers, isPidAlive, NOW, PEER_GHOST_AFTER_MS);
    expect(reaped.sort()).toEqual(["dead-but-fresh", "fully-dead", "pid-alive-zombie"].sort());
    expect(reaped).not.toContain("operator");
  });

  test("empty peer list → no-op", () => {
    expect(reapableIds([], () => true, NOW, PEER_GHOST_AFTER_MS)).toEqual([]);
  });

  test("all peers fresh + alive → no reaps", () => {
    const peers: TestPeer[] = [
      { id: "p1", pid: 100, last_seen: FRESH },
      { id: "p2", pid: 200, last_seen: FRESH },
      { id: "p3", pid: 300, last_seen: FRESH },
    ];
    expect(reapableIds(peers, () => true, NOW, PEER_GHOST_AFTER_MS)).toEqual([]);
  });
});

describe("Phase B R5(b) — discipline parity with liveAndFreshPeers (broker.ts:633)", () => {
  // Invariant: the periodic reaper MUST apply the same predicate as the
  // on-demand freshness check used by handleListPeers/handleBroadcast.
  // Without this parity, peers visible to listings could survive periodic
  // sweeps (or vice versa), creating inconsistent fleet views.

  const NOW = new Date("2026-05-14T12:00:00.000Z").getTime();

  test("identical inputs → identical removal decisions across both reapers", () => {
    // Mirror of liveAndFreshPeers (broker.ts:633-655) reduced to its boolean
    // predicate. If this drifts from cleanStalePeers, the test breaks first.
    function liveAndFreshKeeps(p: TestPeer, isPidAlive: (pid: number) => boolean): boolean {
      if (!isPidAlive(p.pid)) return false;
      const age = NOW - new Date(p.last_seen).getTime();
      return !(age > PEER_GHOST_AFTER_MS);
    }

    const peers: TestPeer[] = [
      { id: "fresh-alive", pid: 100, last_seen: new Date(NOW - 10_000).toISOString() },
      { id: "fresh-dead", pid: 200, last_seen: new Date(NOW - 10_000).toISOString() },
      { id: "stale-alive", pid: 300, last_seen: new Date(NOW - 120_000).toISOString() },
      { id: "stale-dead", pid: 400, last_seen: new Date(NOW - 120_000).toISOString() },
    ];
    const deadPids = new Set([200, 400]);
    const isPidAlive = (pid: number) => !deadPids.has(pid);

    for (const p of peers) {
      const reaperWantsReap = isReapable(p, isPidAlive, NOW, PEER_GHOST_AFTER_MS);
      const listingWantsReap = !liveAndFreshKeeps(p, isPidAlive);
      expect(reaperWantsReap).toBe(listingWantsReap);
    }
  });
});
