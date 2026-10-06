# Bounded nudger supervision

Manzo authorized investigation and repair of the September 10 nudger heartbeat
stalls. Work started from `0a51b63` in an isolated worktree. Inherited changes to
`bench/peer-fleet.ts` are excluded. No database schema or message semantics change.

## Repair

Process and tmux calls now have bounded execution. Snapshot and wake work share
an eight-second command budget; lane rotation prevents a slow lane from always
occupying the first position. Reconciliation seat collection and individual
identity mirrors have separate three-second budgets, with an event-loop yield
between seats. An expired inspection cannot authorize a wake. Persisted attempt
accounting still counts uncertain submissions, and mail remains queued until its
native receive path acknowledges it.

The watchdog supervises before optional label installation. Probes, restart,
installer execution and allocation locks are bounded. A failed manager probe or
unconfirmed fallback-process exit cannot authorize a duplicate supervisor.
Heartbeat path aliases agree. Timeout operations, cycle stage and elapsed time,
and watchdog heartbeat age are observable without pane text or message bodies.
Vanished panes are distinguished from unavailable label identity.

Private tmux isolation exposed an existing first-bind ordering defect: the broker
registered an unnormalized label before the mirror canonicalized the pane. The
broker now canonicalizes the verified pane before registration and defers with
503 if that is unavailable. The original name assertions remain intact.

## Evidence and limits

The stalled process-snapshot regression failed before the repair with external
timeout status 124, and returned safely in approximately 1.6 seconds afterward.
The cumulative TTY regression exercises four stalled lookups, finishes within
four seconds, and proves a following healthy reconciliation cycle runs normally.
Other regressions cover exhausted budgets, lane fairness without spending an
attempt, held allocation locks, stalled installers and manager probes, and failed
or incomplete fallback termination. Focused supervision and command tests passed
52 tests with 179 assertions. Binding and naming tests passed 21 tests with 106
assertions. Independent reviews identified and closed cumulative collection and
duplicate-supervisor gaps.

Two existing tests wrote the live heartbeat; both now use private paths. Any
heartbeat observations during earlier test runs are excluded from live proof.
Full verification also exposed process-heavy fixture timeouts. Greeting cases
passed unchanged with measured durations of 5.67 to 9.57 seconds, beyond their
former five-second deadline. Detached launcher cleanup actually removed all five
fixture processes in 10.59 and 17.61 seconds, beyond its former ten-second test
deadline. The two-adapter reconnect receipt test passed unchanged in 9.87 seconds
in isolation but exceeded fifteen seconds under full-suite load. Only these
fixtures' overall deadlines were adjusted; protocol deadlines and receipt and
process-disappearance assertions remain intact.

Additional mirror fixtures now use private tmux sockets with canonical matching
session prefixes. The configuration race test now edits at its actual
read-to-validation boundary instead of assuming a child reaches that point after
a fixed sleep. It still proves rejection, operator-byte preservation and absence
of temporary or backup artifacts. Final verification and activation results are
recorded below when completed.

These tests prove bounded failure behavior. They do not identify the exact
historical command that caused the three earlier watchdog restarts.

Final `bun run verify` passed on Bun 1.3.11: typecheck, 1,387 tests across 95
files with 4,742 assertions and zero failures, followed by clean-install
register/discover/send/ack smoke for Claude, Codex and Gemini. Tests took 289.81
seconds in a four-CPU, 3 GiB scope. The final launcher worktree fixture also uses
a fifteen-second lifecycle deadline after the prior full run exceeded its
five-second default; its assertions are unchanged. Runtime code is the reviewed
`5f609d6` repair; the follow-up contains this test deadline and evidence only.

## Activation and rollback

Expected path: unchanged loopback broker and native hook/drain transport, with
bounded nudger wake commands and installed watchdog supervision. Preserve a
verified current SQLite backup and installed watchdog before replacing source.
Keep the current broker lifetime owner in place during file installation, then
restart broker and nudger to load the verified changes. Copy the canonical
watchdog to its installed path and verify identical hashes.

Rollback: revert this local repair commit, restore the saved watchdog, rerun the
prior label-hook installer, and restart broker and nudger. Preserve the latest
database; never overwrite new messages with the pre-activation backup.
