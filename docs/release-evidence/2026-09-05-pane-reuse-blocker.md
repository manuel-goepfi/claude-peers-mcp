# Pane reuse blocks wider refresh

Base commit: c642be7cab76cf0140832526ae25203b3901a2cc plus existing working-tree edits.

The combined rename, move, close, reuse regression in
`tests/pane-thread-reconcile.test.ts` fails on the real isolated broker with
synthetic pane metadata and owned holder processes. This is not a real TUI
or live-fleet delivery experiment.

Rename and move preserve expected routing. After the destination holder closes,
a new registration with a DIFFERENT thread ID at the same pane claims the old
thread's pending message. Expected: no cross-thread claim, old mail retained
for its original thread. Observed: replacement claim contains the old message.

The registration seat-merge compatibility check checks client type, but not
thread identity. Matching pane location is treated as sufficient identity to
inherit the survivor ID and mail. Legacy dead-seat rehydration also needs review
before any fix is considered complete. Merely filtering one branch is insufficient.

Result: 12 lifecycle tests passed, one new combined regression failed.
No broker source fix or live data mutation was performed in this check.

Wider adapter refresh is held. The desktop task's peer tool independently refused
list_peers because this task lacks a verified pane binding; it was not bypassed.
No recurring automation tool is available, so a bounded service-health sample
does not establish a background monitor or a delivery soak.

## Fix verification

The operator authorized a source fix after the reproduction above. Registration
now requires an exact case-insensitive incoming thread match for a stored known
thread. Missing incoming identity is not a wildcard. The guard covers direct
seat merge, pane/window legacy recovery, same-pane duplicate cleanup, and
same-PID refresh/deletion. Legacy rows without a stored thread may still be
enriched; this change cannot retrospectively prove ownership for unknown rows.

Thread compatibility is applied before the candidate SQL LIMIT, so repeated
pane reuse does not hide an older genuine resume. No schema change or direct
live-store modification is required. Different known threads retain separate
identities and inboxes even when their human labels and locations match.

Red evidence: original combined scenario failed; expanded legacy/missing-ID
matrix had seven failures. A subsequent ten-occupant recovery test exposed the
candidate-limit issue before it was fixed.

Green evidence: 172 lifecycle, seat-merge, app-server and delivery tests passed
after the broker fix, with 879 assertions. Final focused tests additionally
cover original-thread receipt and missing/different identity on a shared PID.
Source changes remain local and uncommitted. The live broker was not restarted;
the source fix does not itself establish live-fleet isolation or receipt.
