import { expect, test } from "bun:test";
import { runDeliveryFleet } from "../bench/delivery-fleet.ts";

test("delivery fleet verifies rendered requests, correlated replies and persisted acknowledgements", async () => {
  const result = await runDeliveryFleet(2, 1);
  expect(result).toMatchObject({ peers: 2, rounds: 1, total: 4, acknowledged: 4, replies: 2,
    native_hooks_verified: false });
  expect(result.health_ms.count).toBe(2);
  expect(result.exchange_ms.count).toBe(2);
}, 20000);

test("delivery fleet rejects unbounded or empty workloads before launching processes", async () => {
  for (const count of [0, 1, 51, NaN, 2.5]) await expect(runDeliveryFleet(count)).rejects.toThrow("peers must be 2..50");
  for (const rounds of [0, 11, NaN, 1.5]) await expect(runDeliveryFleet(2, rounds)).rejects.toThrow("rounds must be 1..10");
});
