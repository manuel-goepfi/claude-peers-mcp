# Existing-session messaging recovery

## Verified changes

- Replaced the broker's broad synchronous `ps` command-line scan with process
  metadata reads filtered to the controlling terminal. Preserve Node/Bun Codex
  shims by reading their script argument after filtering.
- Bound pane binding and Git subprocess calls. A 250 ms runtime proof timeout
  proved too short under host contention: repeated checks of the same live
  Claude process alternated between success and refusal.
- Runtime mailbox proof now uses one bounded tmux snapshot per socket within
  each request. Subsequent requests fetch fresh evidence. A failed lookup
  remains a refusal, not permission to reuse old evidence.
- The operator service-control script has a managed-unit force-kill fallback
  when normal restart fails. Its regression tests passed in ManzoOps.

## Validation

- Typecheck passed.
- Runtime snapshot and live mailbox compatibility: four tests, 95 assertions,
  zero failures. Includes existing adapter send, drain, correlated reply and
  broker restart compatibility.
- Codex pane binding passed with 39 assertions after restoring shim detection.
- Five app-server integration cases passed after correcting the stale-prefix
  naming expectation. Earlier runs had pane-fixture startup timeouts under host
  contention; these are not represented as a passing full test suite.
- Isolated install smoke passed register/discover/send/ack for Claude, Codex
  and Gemini.
- The repair session received correlated MCP replies from the Claude
  orchestrator and two affected Codex clients. A third affected Codex client
  visibly completed MCP sends. No native conversation restart was performed
  for this recovery; supported account MCP reloads were used.
- Post-rollout service checks reported broker ready and nudger healthy.
  Thirty-one live registered C5 Codex rows had recent broker activity during
  the audit. Heartbeats are not proof of two-way delivery for every lane.

## Outstanding verification

The orchestrator was asked to collect replies from all open C5 Codex lanes.
That fleet report is pending. One account MCP reload returned a timeout, so
acceptance of that particular reload is unknown despite subsequent successful
messaging. No direct database repair or message deletion was performed.

## Follow-up audit at 15:42 UTC

- Broker and nudger health checks passed. All 27 targeted recovery probes were
  delivered; 20 had correlated replies at the 15:32 UTC read-only audit.
- The orchestrator acknowledged the fleet contact request and independently
  received replies from additional lanes, including the local-auth and engine
  batch-two lanes. Explicit follow-ups obtained correlated replies from the
  fix-3208 and ASME-QW250 lanes as well. Accounting was actively working;
  its probe delivery alone is not a two-way verification.
- The QW451 story lane had separate pane and thread mailboxes. Replaying the
  independently verified existing thread through its genuine relay folded one
  duplicate. Its original probe was subsequently delivered and received a
  correlated PASS reply without restarting its conversation.
- The standalone review-d Codex client still fails both inbox and send with
  `Transport closed`. It has no account-control listener, so the shared account
  reload did not cover it. Its native `/mcp` inventory confirms the failed
  connection. No process restart or speculative configuration change was made.
- Two newly launched shared-account audit lanes were initially unbound. Their
  panes showed unsubmitted initial task text and the account server returned
  `no rollout found` for their visible initial thread IDs. Recovery therefore
  stopped before binding; the orchestrator was asked to verify task submission.
  These observations do not establish an adapter defect or justify a restart.
- The nudger's idle detector now recognizes multi-minute Claude turn timers
  and queued-message indicators. Focused idle/wake tests passed: 144 tests,
  230 assertions. After the nudger-only restart, the busy orchestrator was
  correctly ineligible for a wake.

Fleet-wide recovery remains incomplete until the standalone connection and
the outstanding accounting/new-lane exchanges are verified. A closed retired
pane is excluded from the live fleet, not counted as a messaging failure.
