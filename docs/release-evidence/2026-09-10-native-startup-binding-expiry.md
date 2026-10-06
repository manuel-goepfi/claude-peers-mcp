# Native startup binding expiry repair

Follow-up: the two pre-existing verification failures below were subsequently
resolved; full verification is green. See
`2026-09-10-launcher-and-label-verification.md`. The results below retain the
original repair's validation history.

Manzo authorized implementation following the infra.6 diagnosis. Base commit:
`a3adf5242983e0e263a015e80175df1306e047bb`. Inherited `bench/peer-fleet.ts`
diagnostic edits are excluded and preserved. No schema or protocol change.

## Cause and correction

The relay initially registers a native pane in manual-drain mode. Without a
first hook receipt, its last-seen timestamp can exceed the 90-second adapter
timeout even while the native process remains alive. Discovery observes the
binding without refreshing it, and a successful relay bind stops retrying.
Expiry removes routing continuity before the later thread-only hook registers.

The broker now exempts an aged manual-drain Codex binding only when the existing
native-owner proof still verifies the exact thread, pane, TTY, ancestry and
process birth. It does not promote receiver mode or claim hook delivery.
Unbound, paneless, stopped-process and reused-PID controls remain rejected.

Review measured repeated process-stat scans at 37.8–82.8 ms on this host. Native
proofs now share one process-stat snapshot within each HTTP request or cleanup
pass; no positive proof is cached across requests. Command-line reads remain
limited to relevant TTY processes. Independent read-only review found no further
correctness findings in the final implementation.

## Verification

- Strengthened the existing real-pane lifecycle test: bind, age 120 seconds
  before the first hook, discover, preserve thread and pending mail, then adopt
  the same identity from the later hook. Confirmed RED on missing discovery
  before the fix and GREEN afterward.
- Added headless, threadless, reused-PID and stopped-process routing controls,
  plus request-snapshot freshness/reuse coverage.
- Bun 1.3.11 typecheck passed. Focused native/reconnect/relay/snapshot run:
  14 tests, 138 assertions, no failures.
- Full verification after the runtime changes: 1,362 passed, three failed,
  4,657 assertions across 94 files. One failure was the existing cleanup source
  sentinel expecting the old call syntax. Updated it to require the new snapshot
  wrapper while retaining the separate-try/catch checks. Final targeted rerun:
  47 tests, 135 assertions, no failures. Runtime code was unchanged after the full
  run; no claim that the entire verify command passed.
- The other two failures reproduce on a temporary clean checkout of the base:
  the installed Codex adds `--worktree` to CLI help, and an inherited-pane fixture
  expects label suffix `.1` but obtains `.9`. They are outside this repair.
  Temporary checkout removed after verification.
- Clean-install smoke passed for Claude, Codex and Gemini, including
  register/discover/send/ack. Diff whitespace check passed.

No full native release-host or legacy capacity admission is claimed. The
remaining pre-existing verification failures are explicitly retained.

## Activation custody

A restricted online SQLite snapshot at
`/home/manzo/.claude-peers.db.pre-startup-expiry-20260910` passed integrity_check
before activation (71 peer rows, 11,842 messages at snapshot time). It is rollback
evidence, not permission to overwrite mail accepted afterward.

Activation and native receipt results are recorded in the ManzoOps handoff:
`/home/manzo/ManzoOps/docs/infrastructure/development/workflows/CLAUDE-PEERS-HANDOFF-INFRA6-2026-09-10.md`.
Source rollback is a revert of this repair commit followed by one broker restart,
preserving the latest SQLite database. Native conversations and account servers
must remain running.
