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

## Historical outstanding verification (September 8)

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

Fleet-wide recovery remains incomplete until the standalone connection is
restored and verified. A closed retired
pane is excluded from the live fleet, not counted as a messaging failure.

## New-lane follow-up

The orchestrator confirmed the two audit prompts had not been submitted and
pressed Enter in both panes. After their first turns began, exact thread reads
succeeded. Replaying those existing threads through their verified pane relays
restored one correctly thread-bound `codex-hook` registration per pane. Both
original orchestrator probes subsequently received correlated MCP replies.
No native process or account server was restarted. This supersedes the earlier
unverified report that their adapters required a session restart.

The accounting lane subsequently sent its correlated probe reply; the
orchestrator acknowledged it at 15:47:13 UTC. Both new audit-lane replies were
also acknowledged. The remaining confirmed failure is the standalone review-d
client. The operator was asked about reopening only that saved conversation;
no answer authorizing an exception to the no-restart instruction has arrived.


## September 9 implementation and completion

Supersedes the earlier outstanding recovery statements above.

### Code and isolated proof

Commit `dbf8464` adds only the exact `/identity-by-thread` HTTP 403
`target rejected: pid ... not alive` response to the existing bounded proof
retry. The three-second default deadline is unchanged. Every returned proof
still undergoes the existing exact-thread and pane checks. Other permission
or ownership refusals are not newly retryable.

The send tool now tells callers to resolve a current unique visible name or
pane selector for new messages, and retain the original sender ID for
correlated replies. Existing stale-ID and ambiguity failures are preserved.
No schema or API shape changes were needed.

The three new recovery tests failed before the fix and passed afterward.
Typecheck passed. Focused tests: 44 passed, 212 assertions, zero failures:

- `bun test tests/appserver-seat-proof.test.ts`
- `bun test tests/seat-routing-stability.test.ts`
- `bun test tests/live-mailbox-groups.test.ts tests/mcp-reconnect-receipt.test.ts tests/name-dedup.test.ts tests/tmux-identity-write.test.ts tests/appserver-seat-proof.test.ts`

The routing fixture restarts a disposable recipient process in the same real
isolated tmux pane while preserving the sender process and credentials. A
replacement conversation gets a distinct ID; the old ID fails explicitly,
name routing reaches the replacement, an idempotent retry creates no duplicate,
and before/after messages plus the correlated reply remain acknowledged in
the isolated database. Same-conversation rehydration can legitimately preserve
an ID and is not falsely required to allocate a new one. The separate grouped
mailbox suite keeps the original MCP adapter connected across broker restart.
These are focused checks, not a claim that the entire repository suite ran.

### Authorized recovery and rollout

Only the standalone review-d client was gracefully closed with `/quit` and
resumed using its exact saved conversation, original account, binary, model,
reasoning setting and permission flags. It stopped at a changed-hook review;
the maintained registration and inbox-drain hooks were individually inspected
and trusted. No unrelated hook was newly trusted.

The saved transcript's pre-close byte prefix has the same SHA-256 after resume.
The review worktree remains at `6964d3d24229a5bc93119859a45d4af8f17d05ff`, with
only its two original untracked review documents. Both hashes are unchanged:

- `REVIEW-3646.md`: `d2b417e38d2381445f544e157b17da18e6f87542a1bdc975946f0ba0276fb879`
- `REVIEW-QUEUE-AMEND.md`: `e3ecbe70b89aa0c906995fb26535b8f6781159b5e5b9cc9d3c553df60b6db873`

The three existing shared Codex account servers each accepted
`config/mcpServer/reload`, loading the committed adapter changes without
restarting their conversations or account servers. Broker and nudger status
both reported healthy afterward. No direct live database repair or deletion
was performed.

### Live acknowledgment evidence

Fresh native MCP replies were received and `get_reply_status` confirmed
`replied, delivery=acknowledged` for all three requests:

- `restart-fix-orch1-20260909`: Claude orchestrator native MCP ACK.
- `restart-fix-orch2-20260909`: Codex orchestrator ACK and successful whoami,
  expected operator/resolved name, mirror OK and no drift.
- `seat5-resume-verified-20260909`: recovered standalone client successful
  whoami, inbox check, and correlated reply; expected pane name and no drift.

These exchanges also verify this repair lane's sending and receipt after the
account reload. Its own old resolved-name suffix was cleared through the
existing `set_name` API after verifying no current collision; subsequent
whoami reports operator and resolved names equal, mirror OK and no drift.

The planned recovery is complete. This does not promise zero future failures
or universal in-place reconnect support: the already-closed standalone MCP
connection required the single operator-authorized saved-conversation reopen.
