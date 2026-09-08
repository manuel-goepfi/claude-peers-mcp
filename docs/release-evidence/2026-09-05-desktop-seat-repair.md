# Desktop and discovery identity repair

Base: `c642be7cab76cf0140832526ae25203b3901a2cc`, with inherited dirty changes.
This record describes local verification, not a release or live repair receipt.

## Fix scope

- Accept exact hook-owned Desktop thread proof only for the independently
  discovered app-server host PID, codex-hook receiver, and entirely null terminal
  metadata. Preserve connection/thread isolation and existing pane proof checks.
- Make background discovery observe the canonical PID/pane thread binding.
  Publish its public identity without acquiring its token. Refuse ambiguity.
- Reject discovery-only registration atomically when a thread binding exists.
  Preserve missing-thread isolation for other registration callers.
- Update runtime and operational documentation.

An observed human-label mismatch came from a competing threadless row receiving
a collision suffix, not from evidence that the operator renamed the lane.
The fix prevents recreation/publication of that competing identity; it does not
delete historical rows or migrate their mailboxes.

## Validation

- Typecheck passed.
- Targeted batch: 192 passed, zero failed, 525 assertions across eight files:
  appserver-seat-proof, codex-autodrain-idle, pane-thread-reconcile,
  appserver-seat-integration, relay-bind-recovery, nudge-budget-recovery,
  wake-submission-boundary, mcp-reconnect-receipt.
- Desktop integration used an isolated real broker and stdio MCP adapter;
  verified identity, message drain without duplicate delivery, and rejection of
  a different thread on the same connection.
- Full `bun run verify`: 1321 passed, 16 failed, 10 errors. Most reported
  failures were timeouts. The chained install smoke did not run.
- Recheck of five affected test files with additional default timeout headroom:
  58 passed, two failed, one error. Remaining failures: launcher detached owner
  watchdog cleanup (explicit ten-second test timeout), and config installer's
  concurrent external edit test (expected refusal, observed success).
- `git diff --check` passed after documentation updates.

## Review and rollout boundary

Targeted manual review because inherited edits overlap the fix files. File-level
simplification and automated branch-wide publication were skipped to preserve
that work. No commit, push, broker restart, nudger restart, shared account MCP
reload, or historical row deletion was performed for this repair.

Live adapter verification remains incomplete: the existing adapter's latest
whoami returned identity-by-thread 404. An isolated test is not a live receipt.
The discovered MCP reload API queues refresh for all loaded tasks on its daemon,
not just the two requested tasks; do not silently widen that scope.

Before rollout, resolve or explicitly disposition the two remaining test
failures and review the overlapping source changes that a restart would load.
Use a scoped supported adapter reconnect and prove whoami plus a real receipt.
Do not use direct database writes or extract peer tokens to manufacture proof.
