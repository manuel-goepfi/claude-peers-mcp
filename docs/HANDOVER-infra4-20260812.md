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
