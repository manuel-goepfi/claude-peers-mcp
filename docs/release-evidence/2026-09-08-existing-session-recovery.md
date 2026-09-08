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
