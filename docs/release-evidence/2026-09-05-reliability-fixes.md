# Peer reliability investigation, 2026-09-05

Base: `c642be7cab76cf0140832526ae25203b3901a2cc`, plus inherited working-tree changes.
This is local source/test evidence, not deployment or live client receipt proof.

## Confirmed and fixed

1. MCP broker requests lacked a default deadline. A stalled request could hold
   the heartbeat loop indefinitely. Each attempt now has a three-second abort
   deadline combined with caller cancellation. The regression invokes the real
   request function with a hung fetch, then verifies a subsequent request succeeds.
2. The Codex relay permanently cached successful thread bindings. A new client
   lifecycle response for a previously seen thread never reached the broker.
   The permanent cache is removed; in-flight and response-ID dedup remain.
   The Node Unix-WebSocket fixture now reconnects and resumes the same thread,
   requiring another bind while still suppressing duplicate response frames.
3. The systemd watchdog returned healthy on `is-active` alone. It now checks
   heartbeat freshness, respects a 70-second startup grace, and requests a managed
   restart for an older active unit with stale/missing heartbeat. Unknown startup
   age returns a diagnostic failure instead of guessing or starting another poller.
4. Wake submission did not recheck its latest pane capture. Failed capture,
   newly busy state, and newly typed operator input now prevent a fresh paste.
   Positive idle submission remains covered. This reduces the race window;
   tmux capture and keyboard input are not an atomic operation.

5. Relay binding stopped retrying after its initial attempt window. Transient
   failures now back off to at most one attempt per 15 seconds while the same
   client and task remain current. Disconnect/task changes cancel retries;
   authoritative ownership rejections remain terminal. In-flight dedup is scoped
   to a connection so an old disconnected client cannot suppress its successor.

All five defects were observed in failing regressions before their fixes.

## Verification results

- Final relay recovery and Node transport tests: 12 passed.
- Final deadline, wake boundary, watchdog, and greeting tests: 34 passed.
- Type checking and shell syntax checks passed; diff whitespace check passed.
- Broader run before the final retry changes: 1,309 passed, two failures and
  one associated error. The concurrent-installer race test and greeting timeout
  both passed on isolated reruns. This is not a clean full-suite verdict.
- Existing binding/lifecycle targeted batch: 53 passed. Mailbox, wake budget,
  watchdog and correlation batch: 114 passed before the final watchdog additions.

## Existing behavior checked

- Cross-pane thread migration and queued/claimed/acknowledged mail preservation.
- Process lifecycle cleanup, stale authentication churn guards, and exact thread proof.
- Wake cooldown/budget persistence, submission confirmation, and no-mail suppression.
- Previously prepared Hammerspoon menu refresh/action contract: passing local Lua test.

## Not established by these tests

- Successful message processing by every live Claude/Codex lane.
- Recovery after every kind of upstream app-server connection failure. Replaying
  in-flight model requests is deliberately not introduced.
- Deployment: existing MCP adapters/relays retain loaded code; the watchdog has
  a separate installed copy. No live service or lane was restarted for this work.
- Mac-side Hammerspoon pull/reload and its displayed live status.

Rollout must preserve active work. Validate a controlled client reconnect and
actual receipt before calling the fleet repaired. Do not bypass identity proof
or restore broker rows directly to make a lane appear healthy.

## Authorized rollout update

The earlier no-rollout status is superseded for the nudger/watchdog only:

- Installed watchdog backed up to `watchdog-before-rollout-20260905.sh`, replaced
  with the maintained source, and verified byte-identical with `cmp`.
- Managed nudger restarted successfully; post-restart state active, heartbeat
  age 14 seconds at the verification sample. Live broker health returned `ok`.
- `tests/mcp-reconnect-receipt.test.ts`: one passing controlled reconnect with
  seven assertions. A real stdio MCP adapter connected, disconnected, reconnected,
  received a unique test message, and acknowledged it in an isolated broker.
  A second read did not return that message. No model response is claimed.
- No working lane, shared account backend, or live broker was restarted.
  Existing MCP adapters and relay processes still need their normal reconnect
  to load the source fixes. This is not a completed fleet-wide refresh.
