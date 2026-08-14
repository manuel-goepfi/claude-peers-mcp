# HANDOVER → infra.4: repair claude-peers end-to-end, once and for all

Operator-authorized (Manzo, 2026-08-12 evening). You are infra.4, a fresh codexd lane — you are BOTH the repair engineer AND the primary testbed: your own lane's peers receive is broken by the exact bug you're fixing.

## Your handicaps (work around, then fix)
- Your claude-peers MCP tools are DEAD (Transport closed) — by design on the shared app-server host. SEND via shell: `cd ~/claude-peers-mcp && bun cli.ts send <peer-id> "msg"`. Codex has NO mid-session MCP reconnect (upstream openai/codex #16899, #22571 — read both).
- Your peers RECEIVE is split-brained (see diagnosis) — until you fix it, coordinate via this file's directory and cli.ts sends.

## Read first (in order)
1. `~/ManzoOps/.claude/memory/native_claude_messaging_cutover_aug_11_2026.md` — two days of verified truths + hard lessons. TRUST ITS RULES.
2. `~/.claude/docs/claude-peers-cheatsheet.md` — routing table + codex vs codexd truth table.
3. `~/claude-peers-mcp/docs/peer-id-rotation.md` — identity design history.
4. Upstream repos via gh: `louislva/claude-peers-mcp` (dormant since Apr; uses claude/channel push) and fork `jamditis/claude-peers-mcp` — skim for anything solving shared-host identity (nobody has, as of tonight).
5. Ask Pieces (your pieces MCP works): search_memory hints ["claude-peers","codex hook","broker"] for May–Aug history.

## State of the system (all verified live tonight; branch codex/claude-peers-reliability, tip 2ca19a6)
WORKING: Claude↔Claude native messaging (peers not involved); Claude lanes heal dead MCP via /mcp reconnect; broker healthy under systemd; pane-local `codex` lanes fully working (registration, thread-join drains, tools); sender-side honesty (recipient.mcp_transport + warnings); doctor (dead-adapter-peers counter, CLAUDE_CONFIG_DIR-aware); thread-keyed registration MINTS correctly (register log: "resolved via thread key" for threads td7f79da0, t5d30b1e6 on host pid).

BROKEN (your mission):
1. **SPLIT-BRAIN (root cause of codexd receive failure)**: a codexd lane gets TWO rows — (a) a pane row (e.g. infra.4/mlk8uv95, pane %2489, thread_id NULL, minted by the poller's seat reconciler / TUI-visible path) which is where SENDS land and what NudgeR sees, and (b) a thread-keyed row (codex-t<id8>, host pid, thread set) which is what proven-hook DRAINS claim via /claim-by-thread. Mail sits on (a); drains empty (b); loop never closes; NudgeR knocks forever.
2. **Indefinite nudging**: attempt counter observed going 1→2→1 without operator-visible cause (every new message "restores nudge budget" — tonight's test sends kept resetting it; ALSO verify whether unconfirmed submissions fail to count attempts). Undelivered test mail was deleted tonight to silence it — verify knocking actually stopped, then fix the budget semantics.

## The designed fix for #1 (operator-endorsed direction — verify then build)
Codex prints its THREAD ID in the pane status line. NudgeR already captures panes (idle detection). Teach the poller's seat reconciler to extract the thread id from the status line and STAMP the pane row's thread_id (broker route or direct authed update — prefer a broker endpoint, e.g. extend the existing stamp/reconcile path). Then pane row == thread row target: claims-by-thread hit the row holding the mail, sends and drains converge, NudgeR's nudge becomes drainable. Alternative designs (broker-side fold at registration) FAIL on cwd ambiguity — many lanes share ~/Clause5; the status line is the only external pane↔thread join. Guard the regex against status-line format drift (fail quiet, never stamp a wrong thread).

## Non-negotiable rules (paid for in blood today)
- **DEPLOY AT LANE-CYCLE BOUNDARIES.** Today's fixes killed 24 live adapters in transition (identity rotation → 401 churn → orphan self-exit; clients never respawn MCP). Broker restarts and identity-affecting changes require an operator-agreed moment, or new-code-for-new-sessions-only.
- Test on a SCRATCH broker first (CLAUDE_PEERS_PORT/DB env — see tonight's pattern in the session summary), then `bun run typecheck && bun test` (1073 tests; known load-flaky: kimi quiescence, watchdog reap, name-fallback tmux — pass in isolation).
- bun:sqlite MIS-BINDS repeated ?N placeholders with positional args — rank in JS (bit us tonight in broker.ts existingRows).
- Commit per logical change, conventional commits, push to `manzo codex/claude-peers-reliability`. NEVER `git add -A`.
- Never type into other lanes' panes; peers messages to Claude lanes work normally.

## End-to-end DOD (all must pass, live)
1. codexd lane (YOU): peers message → NudgeR knock → hook attaches mail in the SAME turn → reply via cli.ts lands back. (Your row: mlk8uv95; your thread visible in your status line.)
2. Pane-local codex lane: same loop (already works — regression check).
3. Claude lane: native SendMessage + /mcp-healed peers tools.
4. NudgeR: zero knocks when zero unread; bounded attempts on undrainable lanes; wrapper text stays honest (it now handles toolless lanes).
5. `bun bin/peers-doctor.ts` healthy; dead-adapter-peers reflects reality.
6. Memory updated (read-modify-write the cutover file), cheatsheet updated if the truth table changes, all pushed.
7. Report deliver: cli.ts send to Claude lanes infra.3 (dr5nm7d6 — may be gone; check `bun cli.ts peers`) or any live infra lane, plus append your report to this file.

## Key file map
broker.ts (register ~1280-1560, recipientHealthFor ~1803) · hooks/register-peer-session.ts (metadata/app-server ~460-520, runRegistration ~564) · hooks/codex-drain-peer-inbox.ts (main ~594, thread-only mode) · bin/codex-autodrain-poller.ts (nudgeText ~89, seat reconcile) · shared/{seat,client,delivery-state,doctor}.ts · logs: ~/.claude-peers-broker.log, ~/.claude-peers-codex-autodrain.log, ~/.codex/logs/{register-peer-session,drain-peer-inbox}.log

## Execution report — 2026-08-12

**Core verdict: GO.** The split-brain repair, bounded unread-episode budget, exact thread-status reconciliation, and true-mail-only nudge gate are committed on `codex/claude-peers-reliability` through `ce0e8b2ff15041665906afca8206d646f854ee66`.

### What shipped

- The broker exposes an authenticated `/reconcile-pane-thread` route. It requires exact live PID/UID/pane proof, refuses live conflicting owners, folds dead duplicate rows transactionally, and preserves message/claim/ack state.
- The poller extracts a Codex thread UUID only from a managed status-line shape. It accepts the live untitled duplicate-UUID shape (including its 80-column truncation), rejects conflicting/prefixed UUIDs, and fails quiet on drift.
- `peers.unread_episode` is broker-authored by a SQLite zero-to-nonzero trigger. The poller budgets at most five transport attempts for one continuous unread episode; partial drains, rising counts, duplicate folds, rehydration, failed submits, and same-millisecond ordering do not mint a fresh budget.
- Nudge candidate selection is now an exact inner join to `messages.to_id = peers.id AND messages.delivered = 0`. Empty lanes and delivered history cannot enter the loop. A second `unread <= 0` guard remains immediately before transport.
- Send receipts describe observable delivery state without claiming that a tmux keystroke delivered or acknowledged mail.

Logical commits after the handover base:

```text
ac7f957 fix: reconcile Codex pane and thread identity
dcd5a3c fix: bound nudge retries per unread episode
2e9c7a0 test: stabilize tmux quiescence fixture
b96d661 test: isolate appserver pane fixture
8be78b9 fix: harden reconciled peer delivery
0c54699 fix: parse narrow Codex thread status
8033db3 test: isolate inherited pane proof fixture
ce0e8b2 fix: require pending mail before nudging
```

### Official hook and account audit

The audit used the official [Claude Code hooks reference](https://code.claude.com/docs/en/hooks), [Claude directory/config reference](https://code.claude.com/docs/en/claude-directory), and [Codex hooks reference](https://learn.chatgpt.com/docs/hooks). Both products load matching hook entries; matching entries across applicable configuration scopes may all run.

| Profile | Current state |
|---|---|
| Claude A (`~/.claude`) | Current managed `SessionStart` register/greeting, `UserPromptSubmit` inbox drain, `PostToolBatch` mid-turn drain, and `Stop` standby hooks |
| Claude B (`~/.claude-b`) | Reinstalled from this checkout with the same managed receive hooks, including `PostToolBatch` |
| Codex A (`~/.codex`) | Current managed `SessionStart startup|resume` register+drain, `UserPromptSubmit` drain, `PostToolUse` mid-turn drain, and `Stop` drain; account-slot verifier retained |
| Codex B (`~/.codex-b`) | Current managed register/drain hooks; no A-slot verifier, as designed |

Both Codex profiles now render `thread-id` immediately after `thread-title` in the status line. The existing user-level safe drain wrapper, managed drain hook, and Clause5 project hook were retained: official layering means they can all execute, but claim/ack leases prevent duplicate message rendering. Scope consolidation is a separate operator choice, not part of this repair.

`~/.mcp.json` is an intentional zero-byte, mode-0444 lockdown stub. `claude mcp list` may print a JSON parse diagnostic for it while still reporting `claude-peers: Connected`; it was not rewritten.

The dotfiles launcher is exactly:

```bash
codexd() { codex --remote unix:// --cd "$PWD" "$@"; }
```

`codexd resume --help` reaches `codex resume`, preserves cwd filtering, and documents the shared-host trade-off. A fresh hosted thread spawns its MCP adapter; a resumed thread whose adapter already died cannot reconnect mid-session, but the disk-loaded prompt hooks continue to receive by exact thread identity.

### Review and verification

- Claude B, Opus 5, compound-engineering review session `5326e522-10c0-44d4-8941-358a65d37566`: terminal `completed`, PASS, no P0/P1/P2 findings.
- Independent correctness, security, and testing passes: clean. Review-found unread-episode fold, same-millisecond, and rehydration cases were reproduced before repair and now have regression coverage.
- Exact-head `bun run verify`: typecheck PASS; **1,105/1,105 tests**, **3,484 assertions**, 72 files; clean-install smoke PASS for Claude, Codex, and Gemini using `register-discover-send-ack`.
- Scratch broker: pane-thread reconciliation and autodrain suites passed; doctor ready with zero errors.

### Live acceptance

- Broker and poller were rolled once at the lane-cycle boundary. Live schema now includes `peers.unread_episode` and `trg_messages_start_unread_episode`; health advertises pane/thread reconciliation.
- Hosted `infra.4` row `mlk8uv95` was reconciled to its exact hook thread. It is one pane row in `codex-hook` mode with zero unread.
- Fresh pane-local Codex `%2673` auto-stamped its live 80-column status UUID. Message `16965` caused one wake at `2026-08-12T17:30:07.242Z`, hook-acked at `17:30:07.408Z`, and produced reply `16966` (`TRUE-MAIL-ACK`), which this lane hook-acked at `17:31:17.741Z`.
- A two-tick quiet window left both test lanes at zero unread and produced no second wake. Empty and delivered-only lanes are also covered through the shipped `tick()` integration test.
- Two failed regression probes (`16961`, `16962`) were matched by id, target, state, and text prefix, then deleted. No unrelated mailbox was changed.
- Doctor is ready with zero errors. Its degraded warning reflects real dead adapters, not broker failure.

### Remaining topology facts

- Old Codex TUIs started before `thread-id` was added will not render it until restart. Their genuinely undelivered mail remains nudgeable, but the hard five-attempt episode cap stops repeated knocks.
- Claude B's peer-specific acceptance retry ended in provider HTTP 529 with zero model tokens; this did not change its connected MCP/config proof or the earlier completed Opus review.
- Cursor's 3.5-day `traffic.1.1` agent cannot add an MCP child mid-session. The separate wrapper/config repair was read-only verified: it derives `session.window.pane` through process ancestry and will apply on the next Cursor launch; that work is outside this branch. Its stale broker row correctly refused a send.
- Closure report `16967` was instead sent to live Cursor `traffic.1.3` on `%2732`; NudgeR produced one wake and the row acknowledged it at `2026-08-12T17:37:59.170Z`. No stale Claude row was deleted.

## Final acceptance addendum — 2026-08-12

The remaining account, layout, authority, and restart boundaries are closed on `codex/claude-peers-reliability` through `b5fd484885e37deab6920c0a3f0ee9c8e517f4b0`.

Additional logical commits:

```text
f5a8ebf fix: harden peer wake identity and authority
d09079a fix: keep pane labels stable across layout changes
b5fd484 fix: persist nudge budgets across restarts
```

### Identity and lifecycle

- Codex A (`~/.codex`) and B (`~/.codex-b`) now render `thread-id` first in the status line, before model/context fields. New and resumed TUIs load it; already-running TUIs still require restart.
- A fresh hosted `codexd` test at width 58 registered, reconciled its exact thread, received message `16978`, hook-acked it, and replied with `CODEX-F5A8-ACK`. A width-65 test rendered the full thread id.
- Pane numbering is no longer identity. The broker preserves a pane-scoped `@operator_label`; fallback ordinals allocate after the highest live ordinal instead of recycling a closed gap. In the live close/reopen test, `.2` remained `.2` after its pane index changed and the replacement became `.3`.
- Every requested throwaway session was closed. The Claude B test PIDs exited and its broker row had zero unread mail.

### Authority and wake semantics

- The compact wake says what is observable: unread count, one `check_messages` attempt, no authority grant, privileged-action boundary, and the one-shot `Transport closed`/unverifiable fallback.
- Orchestrators may coordinate ordinary in-scope work by default. They cannot delegate operator authority: a privileged action is valid only when the receiving lane already has direct operator authorization for that exact action in its own session.
- Candidate selection remains an exact join to undelivered mail. Zero unread means zero wake. Copy-mode, busy input, missing ownership, dead processes, and unready Codex identity all fail closed before transport.

### Claude B, Cursor, and durable NudgeR proof

- The installed systemd poller now includes `claude` alongside `codex,gemini,cursor,agy,kimi`. Fresh Claude B message `16983` caused one hands-off wake at `18:31:47.838Z`, hook drain/ack at `18:31:49.642Z`, and `CLAUDE-B-HANDSOFF-ACK` without an operator prompt.
- Claude B independently reviewed the final persistence diff. Its initial eight findings were re-tested; the final re-review was CLEAN with no P0/P1/P2 blocker.
- Fresh Cursor lane `traffic.5` (`cdo210k7`, pane `%2794`) showed one transient first-call disconnect during MCP startup. In the same session, native `check_messages`, `whoami`, `send_message`, and `set_summary` then succeeded; a ping and ACK completed bidirectionally and the inbox drained to zero. This was a startup race, not pane-width or lane-name failure.
- Nudge attempts now live in `~/.claude-peers-nudge-budget.json` (mode `0600`). Reservations and cooldown are fsynced before tmux submission; the parent directory is fsynced after atomic rename. Corrupt/unwritable state fails closed and appears as `nudge_budget=degraded` in the heartbeat.
- A first installation explicitly creates an empty ledger. After rollout, a second systemd restart reloaded the existing ledger byte-for-byte: SHA-256 `63318be1370c127705b5031532a0b68d22e2772d33d3f5b2c15deb4f00ff0c54` was unchanged and no second bootstrap log appeared. Attempts made by the pre-ledger daemon cannot be reconstructed; durability applies from this rollout forward.
- Deterministic regression coverage proves that five attempts remain exhausted across process restart and temporary client exclusion, write-ahead state is visible on disk before the transport callback, copy-mode consumes no attempt, drain/refill advances the broker episode, and drained/deleted seats are garbage-collected without losing a queued mailbox during rehydration.

### Final gates

- `bun run verify`: TypeScript PASS; **1,113/1,113 tests**, **3,524 assertions**, 72 files; clean-install smoke PASS for Claude, Codex, and Gemini using `register-discover-send-ack`.
- Installed unit equals the tracked unit; one poller process is active; heartbeat is `nudge_budget=ready`.
- `bun bin/peers-doctor.ts`: broker/database ready, receiver errors `0`, summary `degraded` with one warning because historical rows retain dead adapters. This is topology debt, not a receive-path failure.
- Local HEAD and remote branch both resolve to `b5fd484885e37deab6920c0a3f0ee9c8e517f4b0` before this documentation-only addendum.
