# Nudger snapshot and tmux batching follow-up

Manzo requested fixing the remaining snapshot and label-install timeout warnings
after the conditional-wake repair `c5b4219`. This follow-up preserves the existing
native receipt, ownership, per-episode attempt and allocator-lock contracts.

## Measurements

On the live Linux host, full `ps` snapshots took 1,275 to 2,572 ms for roughly
2,800 to 3,100 processes. A plain executable spawn took 5 ms. Reducing ps output
to process names did not remove the scan cost. A direct procfs prototype took
567 ms; the production bounded-child implementation subsequently measured 930
and 1,303 ms. Combined process-and-pane snapshots took 1,677 and 1,484 ms.
Only aggregate counts and durations were printed, not process arguments.

Read-only tmux calls took 1.03 to 2.59 seconds on the loaded host. There were 66
panes and no missing operator labels during the label audit. Nevertheless, the
installer used four client calls before an all-pane backfill that made roughly
133 additional calls. Six consecutive ten-second installer timeouts were logged.
The new filter was exercised against 72 live panes with a runner that refuses
writes: one read-only command, 98 ms, no repair candidates and no failures.

## Changes

Linux snapshots use a disposable Bun child with a three-second timeout. It reads
stat, command line and stat again, excluding unreadable/malformed records and
records whose process birth or parent changed. The parent validates the JSON
result and rejects failed or timed-out scans. Other platforms retain bounded ps.
The helper output is an internal pipe, not a diagnostic log.

Pane backfill takes one rich fleet snapshot. Only uniquely owned canonical
labels are skipped; repair candidates use fresh reads under the existing lock.
The three hook updates share one tmux client. The five identity fields also use
one production tmux command; a failed batch marks every field uncertain because
a prefix may have applied. Injected per-field test writers retain their contract.

Process, poller tmux and labeler/identity command limits are three seconds to
accommodate measured healthy latency. The eight-second wake-cycle command budget
is retained. Identity reconciliation allows eight seconds per mirror and yields
between seats; its initial collection remains bounded to three seconds. The
watchdog stale threshold remains 70 seconds. These limits bound work; a fresh
heartbeat alone does not prove successful inspection or delivery.

## Verification

Focused snapshot, FIFO-stall, ancestry/reuse, non-Linux fallback and wake checks
passed 193 tests with 356 assertions; typecheck passed. The FIFO regression stalls
the actual scanner on a filesystem read and requires its child to terminate.
Label batching and locking checks passed 37 tests with 145 assertions. Identity
batch and private tmux checks passed 60 tests. A 100-pane healthy fixture requires
exactly one backfill command; batch tests assert every argument and field value.
Independent review found no blocking snapshot or allocation correctness issue.

Full `bun run verify` passed on Bun 1.3.11: 1,395 tests across 96 files, 4,779
assertions and zero failures, plus typecheck and clean-install send/ACK smoke for
Claude, Codex and Gemini. Tests took 395.23 seconds in a four-CPU, 3 GiB scope.
Live activation results are recorded in the ManzoOps nudger investigation.
Activation
must preserve inherited `bench/peer-fleet.ts`, verify a current backup, and check
the actual installer outcome and fresh native receipt. Compatible source rollback
preserves the latest database rather than restoring older mail.
