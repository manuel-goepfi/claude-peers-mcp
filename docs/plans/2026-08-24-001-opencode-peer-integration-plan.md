# OpenCode peer integration

## Objective

Make OpenCode a first-class `claude-peers` client on the maintained single-user Linux/tmux deployment. An OpenCode TUI must register as `opencode/manual-drain`, expose the normal MCP tools, receive queued mail through the wake-only poller, and never be nudged while busy or while its composer contains operator text.

## External contract

OpenCode 1.18.21 supports local stdio MCP servers under the global `mcp` configuration object. Each entry supplies `type: "local"`, a command array, optional environment, and an enable flag. MCP tools are available to the model after startup. OpenCode plugins expose session and tool lifecycle events, but the peer broker does not need a plugin because manual-drain clients already use the bounded, queue-aware poller.

Sources:

- https://opencode.ai/docs/mcp-servers/
- https://opencode.ai/docs/plugins/
- https://opencode.ai/docs/cli/

## Implementation tasks

1. Add `opencode` to `ClientType`, client normalization, process-chain detection, manual-drain receiver selection, broker validation, session-liveness classification, server registration PID/CWD/TTY recovery, and doctor adapter accounting.
2. Add an OpenCode poller profile. The profile must match only the vendor-owned empty composer placeholder, require pane quiescence because no complete busy vocabulary is proven, reject typed input, and recognize held/submitted wake text during submit confirmation.
3. Add `opencode` to the poller opt-in allowlist, managed systemd unit, watchdog validation, documentation, and contract tests.
4. Document the global OpenCode MCP entry and install it locally with an owner-only backup and atomic replacement. Do not overwrite unrelated provider, model, agent, command, username, or plugin configuration.
5. Restart only the poller and the disposable OpenCode acceptance seat after verification. The broker needs a restart only when the running process must load the expanded client allowlist.

## Acceptance criteria

### AC1 — registration

Given OpenCode starts a local `claude-peers` stdio MCP adapter, when the adapter walks its process ancestry, then it registers the visible TUI PID, workspace CWD, tmux pane, operator label, `client_type=opencode`, and `receiver_mode=manual-drain`.

### AC2 — safe idle classification

Given captured OpenCode pane text, when the composer is the exact empty vendor placeholder and the pane is quiescent, then it is nudgeable. When the composer contains typed text, the pane is changing, or a busy/confirmation state is visible, then it is not nudgeable.

### AC3 — queue-gated wake

Given an idle registered OpenCode pane with one unread message, when the poller ticks, then it pastes one wake, submits Enter, and records success only after transcript/composer evidence. Given zero unread messages, no key is sent.

### AC4 — bidirectional E2E

Given a disposable Claude peer and disposable OpenCode peer, when Claude sends an exact token, then OpenCode drains and returns an exact ACK without operator input. The reverse OpenCode-to-Claude token must also be acknowledged. Both inboxes end at zero and only the disposable panes are closed.

## Verification of the verifier

- Planted error: classify a captured OpenCode composer containing bright typed text as empty; the regression test must fail.
- Golden reference: retain ANSI and plain empty/typed/busy fixtures from OpenCode 1.18.21 and compare future profile behavior against them.
- Dual path: pure parser/allowlist tests plus scratch-broker and live tmux E2E prove the same delivery contract.

## Non-goals

- No OpenCode plugin, provider, model, permission-policy, or agent behavior changes.
- No production service, deployment, remote database, or Clause5 application changes.

## Captured follow-ups from the independent audit

- Client-manifest consolidation: replace the repeated client allowlists and capability switches with one typed `shared/client-manifest.ts`. This is a separate refactor because it changes every supported client rather than only adding OpenCode.
- Zero-turn tmux labels: evaluate assigning a deterministic ordinal before the first MCP registration so a newly opened but unregistered TUI can be targeted without ambiguity. Preserve the current sticky operator-label and multi-pane donation rules.
- Modal-aware nudge suspension: distinguish a persistent permission/modal state from ordinary busy activity, back off without consuming the five-attempt submission budget, and surface that state in diagnostics.
- Tmux label test race: `tests/codex-pane-bind.test.ts` starts its fixture before setting `@operator_label=bind.test`, so the globally installed birth-label hook can register `bind` first. The full parallel suite can fail while the test passes alone. A separate test-only repair should gate the fixture on a ready file, set the label, then release registration.

The audit's narrow-pane submission concern is already handled in-scope: `regionContainsSubmissionProbe` compacts visual wrapping before comparison. OpenCode gets dedicated held/submitted/unknown regression fixtures against its boxed composer. The existing Grok omission in the doctor live-client recognizer is corrected alongside OpenCode because that exact inventory switch is modified for the new client.

## Acceptance evidence

- Official contract: OpenCode 1.18.21 loaded the managed local stdio entry from `~/.config/opencode/opencode.jsonc`; `opencode mcp list` reported `claude-peers connected`.
- Registration: disposable pane `%1980` registered as `opencode/manual-drain`, with the visible TUI and MCP adapter retained together in `seat_pids` (`1858201`, `1860419`). The sender health response no longer emitted the false dead-adapter warning.
- Queue-gated wake: one queued message caused exactly one poller entry, `nudged opencode-e2e/1lj2ig7m pane=%1980 (1 unread, attempt 1)`. The pane transcript showed the wake as a submitted turn, followed by `claude-peers_check_messages`.
- Bidirectional E2E: token `LIVE-OPENCODE-E2E-20260824-B` was acknowledged by exact reply `LIVE-OPENCODE-E2E-ACK-20260824-B`. Broker rows `26640` and `26641` both reached `delivered=1`; both peers recorded a drain timestamp. No operator keystroke was used for the wake or reply.
- Negative control: the first disposable run selected an unauthenticated OpenRouter preview and produced `No cookie auth credentials found`. The poller still demonstrably pressed Enter, but the agent could not drain. The successful run used the credential-free `opencode/mimo-v2.5-free` model. Both disposable tmux sessions and their exact broker test rows were removed afterward.
- Verification: the final full suite passed 1,262/1,262 across 78 files with 3,956 expectations. Focused parser, submit-confirmation, client-detection, delivery-health, and seat-merge suites passed 305/305 with 686 expectations; the final parser plus broker rerun passed 155/155 with 322 expectations; `tsc --noEmit` and `git diff --check` passed. Infra.4 independently returned `FINAL: GO` on the implementation and on the two live-discovered follow-up fixes.
