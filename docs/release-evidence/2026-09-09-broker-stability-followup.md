# Broker stability follow-up, September 9

## Recovered task and scope

The saved peers conversation completed the morning restart-recovery plan at
`e985280`; its evidence remains in `2026-09-08-existing-session-recovery.md`.
The later stability investigation stopped while diagnosing a failed isolated
50-adapter polling benchmark. Its inherited change to `bench/peer-fleet.ts`
adds startup diagnostics and remains separate from this follow-up.

This follow-up checks current responsiveness, existing message evidence and a
bounded workload using today's explicit MCP receive path. It does not promise
zero future timeouts, native delivery to every session, or release admission.
No live service, account server, native client or broker database was restarted
or modified by this investigation.

## Live observations

Inspected the local broker at loopback port 7899 and its canonical SQLite store
read-only on September 9, 18:05 through 18:25 SAST.

- Broker ready; service active since 08:27:13 SAST, zero automatic restarts.
- Initial MCP `whoami` failed on its bounded thread-identity request timeout.
  Subsequent calls repeatedly succeeded with matching operator/resolved name,
  mirror OK and no drift. `check_messages` succeeded. No reconnect was applied.
- Direct thread-identity proof also succeeded. During the workload, 12 paired
  health/identity probes had no failures. Maximum observed latency was 2,824.6 ms
  for health and 1,007.8 ms for identity. This explains why brief identity
  deadlines can be exhausted under contention, but does not identify a unique
  cause for the earlier MCP timeout.
- At 18:24:57 SAST, the preceding 15 minutes contained 45 acknowledged messages
  and 16 acknowledged correlated replies whose original requests were also
  acknowledged. Correlation used matching request ID and reversed sender/receiver
  IDs. These are existing native traffic receipts, not new diagnostic messages.
- 31 messages were pending at that observation. An earlier recipient audit
  showed most pending messages addressed stopped processes, with some paneless
  Codex recipients still backed by an account-server process. Preserving these
  rows is not evidence that every recipient is currently receiving mail.
- Doctor reported degraded process/adapter correlation despite a ready broker
  and database. Its counts are not an end-to-end failure count.

## Benchmark diagnosis and replacement measurement

The old `bench/peer-fleet.ts` fails even with one fixture adapter: its fake tmux
does not implement the `display-message` snapshot required by the current
open-pane label allocator. The adapter correctly refuses an independent name.
The failed harness also exceeded an external 35-second process-group deadline
during teardown. Neither observation proves the live broker was down.

Its historical background-polling gates also do not represent the current
receive path. The documentation now explicitly marks that campaign unavailable
as current capacity proof. Runtime identity checks were not weakened to make
the fixture work.

`bench/delivery-fleet.ts` instead starts a private broker and 2 to 50 maintained
stdio MCP adapters using unknown fixture identities. Each round sends a ring
of requests and correlated replies. It verifies rendered content and exact
persisted message/acknowledgement counts. Tool responses can themselves drain
mail, so verification includes all rendered tool results, not only explicit
`check_messages` results. The script retains aggregate evidence only.

The initial five-second whole-tool budget was too short for `send_message`,
which deliberately waits two seconds and can make several separately bounded
broker requests. A 15-second whole-tool deadline accommodates that sequence;
the runtime broker request deadlines remain unchanged. Startup remains bounded
at five seconds per adapter, with five concurrent starts.

Final completed run, 18:37:49 through 18:38:41 SAST:

- 50 adapters, three rounds, 300 messages acknowledged, 150 correlated replies.
- Six isolated health probes: maximum 163.75 ms.
- 150 complete exchanges: p50 8,645.77 ms, p95 8,962.23 ms, max 9,019.91 ms.
- Enforced four CPU units, 4 GiB memory, 100-second process-group lifetime;
  cleanup completed normally. The host was concurrently contended.
- Retained aggregate record: `delivery-fleet-50-20260909.json`.

This proves bounded synthetic MCP delivery under the measured conditions. It
does not exercise native hook ownership, real user think time, every client,
or the old 108-record polling performance gates.

## Validation and remaining limits

Typecheck and diff whitespace validation passed. The focused regression run
passed 27 tests across six files, 303 assertions, zero failures, under a
separate two-CPU, 3 GiB, 150-second systemd service:

```bash
bun test tests/delivery-fleet.test.ts tests/readme-contract.test.ts tests/appserver-seat-proof.test.ts tests/seat-routing-stability.test.ts tests/mcp-reconnect-receipt.test.ts tests/live-mailbox-groups.test.ts
```

Final review strengthened fixture markers with an explicit terminator so index
1 cannot accidentally match index 10. The final 50-adapter run above used the
strengthened markers. The new delivery regression was rerun afterward.
This is focused validation, not a full repository or release-host test run.
The original runtime recovery regressions cover broker restart, recipient
restart, identity handover and saved-adapter delivery independently of the
new workload script.

Persistent failures in a particular native conversation still require its exact
current process/thread/pane evidence. Do not delete pending mail, bypass an
identity refusal or restart every account in response to an aggregate doctor
warning. The legacy polling campaign remains unavailable and is not claimed
complete by this follow-up.
