# claude-peers

Local peer discovery and messaging for Claude Code, Codex CLI, and Gemini CLI.

This is the maintained Manzo downstream of [Louis Arge's upstream project](https://github.com/louislva/claude-peers-mcp). The supported clone and issue/release surface for this contract is `manuel-goepfi/claude-peers-mcp`. It runs one stdio MCP adapter per client session and one loopback-only SQLite broker for the current Linux user. Peers can discover live sessions, route by exact identity or human-facing seat, exchange untrusted coordination messages, and inspect tmux context only when explicitly requested.

## Supported boundary

- Linux with `/proc`, one operating-system user, and loopback networking.
- Bun 1.3.11, pinned by `packageManager`, `engines`, and CI.
- At least one supported client: Claude Code, Codex CLI, or Gemini CLI.
- Git for installation. `tmux` is optional and only needed for pane identity or explicit pane inspection. A systemd user manager is optional.
- Remote brokers, multi-user authorization, Windows/macOS support, and shared-process multiplexing are not part of this release.

The isolation boundary is the current UID. A malicious process running as the broker owner can impersonate process metadata and is outside the security guarantee.

## Architecture

```text
Claude / Codex / Gemini session
          │ stdio MCP (one adapter per session)
          ▼
      server.ts ───────────────┐
                               ▼
                    broker.ts on 127.0.0.1
                    SQLite + database owner lock
```

The broker owns both the configured loopback listener and a lifetime lock for the canonical database. Operational routes remain unavailable while storage is starting or migrating. The first adapter can start the broker directly; a hardened systemd user service is available for managed ownership.

## Clean installation

```bash
git clone https://github.com/manuel-goepfi/claude-peers-mcp.git "$HOME/claude-peers-mcp"
cd "$HOME/claude-peers-mcp"
bun install --frozen-lockfile
```

The clone and user configuration must be owned by the current UID. User-scope installers reject symlink targets, group/world-writable clone path components, unsafe config modes, malformed JSON, and concurrent operator edits.

### Register the MCP server

Use the native client command for the clients you run:

```bash
# Claude Code: user scope
claude mcp add --scope user --transport stdio claude-peers -- bun "$HOME/claude-peers-mcp/server.ts"

# Codex CLI: its MCP configuration is user-level
codex mcp add claude-peers -- bun "$HOME/claude-peers-mcp/server.ts"

# Gemini CLI: user scope
gemini mcp add --scope user --transport stdio claude-peers bun "$HOME/claude-peers-mcp/server.ts"
```

The tracked `.mcp.json` is the portable project-scope Claude fixture. Codex stores MCP servers in `.codex/config.toml`; Gemini stores them under `mcpServers` in `.gemini/settings.json`.

### Install receive hooks

User scope is the default so hooks work across repositories:

```bash
cd "$HOME/claude-peers-mcp"
bun bin/install-claude-hook.ts install
bun bin/install-codex-hook.ts install
bun bin/install-gemini-hook.ts install

bun bin/install-claude-hook.ts --check
bun bin/install-codex-hook.ts --check
bun bin/install-gemini-hook.ts --check
```

- Claude: `SessionStart` registration; normal receipt uses the MCP adaptive poll buffer and tool-response/check fallback.
- Codex: `SessionStart` registration and drain, `UserPromptSubmit` drain, and `Stop` turn-end drain.
- Gemini: `SessionStart` registration and `BeforeAgent` drain. The installer also renders its supported `mcpServers` entry.

Project scope is explicit:

```bash
bun bin/install-codex-hook.ts --scope project /path/to/project
```

The installer refuses the same managed hook in user and project scope. Use `--replace` to install the new scope first and then remove the old owner:

```bash
bun bin/install-codex-hook.ts --scope project /path/to/project --replace
```

Correct configurations are byte- and mtime-stable no-ops. A material edit creates a unique 0600 backup. `--uninstall` removes only managed entries; `--restore <backup-path>` restores a generated sibling backup only when the installed bytes have not been edited since installation.

After hook or MCP changes, restart the client session. Codex hook files are trust-sensitive: open `/hooks` and confirm the changed configuration before expecting automatic drain.

### Verify the installation

```bash
bun bin/peers-doctor.ts
bun bin/peers-doctor.ts --json
bun run smoke:install
```

The doctor performs one `GET /health`, then uses same-user read-only process, config, and SQLite evidence. It never polls, claims, acknowledges, heartbeats, sends, or otherwise changes broker state. While the broker reports `starting` or `migrating`, schema queries are skipped. If health is unreachable while a live or ambiguous database owner exists, schema reads are refused.

Start two client sessions and ask one to call `list_peers`, then send with `send_to_peer` or `send_message`.

## MCP tools

| Tool | Contract |
| --- | --- |
| `list_peers` | List targetable peers by `machine`, exact `directory`, or worktree-aware `repo` scope; optional tmux filter. |
| `send_message` | Send to one live broker ID. Stale IDs fail and return replacement candidates; no guessing. |
| `send_to_peer` | Resolve one exact selector: ID, name, resolved name, seat key, visible tmux target, or tmux session plus pane ID. Ambiguity returns candidates and sends nothing. |
| `inspect_peer_pane` | Explicitly capture 1–200 lines from a peer pane, read-only, capped at 8 KiB. |
| `broadcast_message` | Fan out to a bounded tmux/repo/name scope. At least one filter is required and filters combine with AND. |
| `set_summary` | Set an explicit operator/agent summary visible to peers. There is no LLM or API-key auto-summary dependency. |
| `set_name` | Set or clear the human-facing seat name; broker resolution remains unique. |
| `find_peer` | Filter by exact name, name substring, tmux session, or tmux presence. |
| `check_messages` | Explicitly poll and acknowledge messages rendered into the tool result. Required fallback without an active receive hook. |
| `whoami` | Return this adapter's broker identity, client/receiver mode, working directory, repository, and mirror status. |

### Selector and tmux rules

Human names are not assumed unique. Prefer `resolved_name`, `seat_key`, live `id`, visible `tmux_target`, or `tmux_session` plus `tmux_pane_id` when more than one candidate exists.

Tmux capture is always explicit through `inspect_peer_pane` or `include_tmux_context: true`. It uses `capture-pane`, strips controls, and never calls `send-keys`. Captured text is returned only to the caller; it is never inserted into message text, SQLite, broker logs, bridge output, `/health`, or doctor JSON.

## Delivery model

| State | Meaning |
| --- | --- |
| `queued` | The broker inserted the sender-owned row. No receiver claim or display is implied. |
| `claimed` | A hook holds a temporary lease, but acknowledgement has not completed. |
| `acknowledged` | The receiver explicitly acknowledged after rendering; `delivered_at` exists. |
| `unknown` | The sender cannot prove a current row/state, including legacy delivered rows without an acknowledgement timestamp. |

`expired` is retention telemetry only; the broker does not keep message tombstones. A missing row is never guessed to be queued or expired.

| Client | Receiver mode | Receipt path |
| --- | --- | --- |
| Claude Code | `claude/claude-channel` | Phase-spread adaptive MCP polling, channel attempt, and tool-response/check acknowledgement. |
| Codex with current hooks | `codex/codex-hook` | Prompt/start/turn-end hook claim and acknowledgement. Background MCP polling stays disabled. |
| Gemini with current hooks | `gemini/gemini-hook` | `BeforeAgent` hook claim and acknowledgement. Background MCP polling stays disabled. |
| Codex or Gemini without a proven hook | `*/manual-drain` | `check_messages` until the hook registers and heartbeats successfully. |
| Unknown/send-only | `unknown/unknown` | Not a normal automatic receiver; bounded retention applies. |

Adaptive Claude empty-poll delays are 1s, 1s, 2s, 4s, 8s, then a phase-spread 10s ceiling. Tool activity, non-empty poll, re-registration, or broker recovery returns to the one-second active cadence with a five-second grace. Idle requires 30 seconds without a trigger plus two empty ceiling polls.

## Limits and retention

- Message body: 32 KiB. Request body: 64 KiB. Summary: 1 KiB. Name: 128 bytes.
- Per peer: 600 protected requests and 60 message slots per rolling minute. Heartbeats are exempt from request throttling.
- Broadcast: at most 60 targets. Hook claim: at most 25 messages and 64 KiB. Claim lease: 30 seconds.
- Tmux capture: default 80 lines, maximum 200 lines and 8 KiB.
- Local Claude buffer: 10,000 messages; local acknowledgement dedup: 5,000 IDs.
- Delivered history: seven days by default, anchored at acknowledgement or migration retention time.
- Undelivered mail to an `unknown` receiver: seven days by default.
- A dead recoverable seat keeps undelivered mail for 24 hours by default, with a one-hour floor.

History intentionally outlives ephemeral peer rows. Schema version 1 has no message-to-peer foreign keys. Startup migration creates and verifies a restricted backup, preserves IDs/claims/high-water state, commits the version last, and restores atomically after post-commit verification failure.

| Stored state | Retention behavior |
| --- | --- |
| `queued` to a live draining receiver | Retained until claimed/acknowledged; no age-only purge applies. |
| `claimed` | Lease returns to claimable after 30 seconds if it is not acknowledged. |
| Undelivered to an `unknown` receiver | Purged after `CLAUDE_PEERS_UNDELIVERED_MSG_TTL_MS`. |
| Undelivered to a dead recoverable seat | Row and inbox remain inheritable until `CLAUDE_PEERS_DEAD_MAIL_TTL_MS`, never less than one hour, then both are reaped. |
| `acknowledged` | Retained until `CLAUDE_PEERS_DELIVERED_MSG_TTL_MS` from its retention anchor, even if the peer row is gone. |
| Missing row / `unknown` delivery status | No tombstone is invented; absence does not establish why or when the row disappeared. |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAUDE_PEERS_PORT` | `7899` | Loopback broker port. |
| `CLAUDE_PEERS_HOST` / `CLAUDE_PEERS_HOSTNAME` | unset | Optional loopback-only bind assertions; non-loopback values are rejected. |
| `CLAUDE_PEERS_DB` | `$HOME/.claude-peers.db` | SQLite database. |
| `CLAUDE_PEERS_BACKUP` | `<db>.backup` | Verified migration/rollback backup. |
| `CLAUDE_PEERS_BROKER_LOG` | `$HOME/.claude-peers-broker.log` | Owner-only append log. |
| `CLAUDE_PEERS_OWNER_MODE` | direct or inferred systemd | Ownership/shutdown contract; the service installer sets `systemd`. |
| `CLAUDE_PEERS_BRIDGE_ENABLED` | `true` | Compatibility-on bridge cursor. Set `false` to remove its token and endpoint completely. |
| `CLAUDE_PEERS_BRIDGE_TOKEN_FILE` | `$HOME/.claude-peers-bridge.token` | 0600 bearer token for privileged history reads. |
| `CLAUDE_PEERS_METRICS_ENABLED` | `true` | Authenticated aggregate route and latency metrics; never content or IDs. |
| `CLAUDE_PEERS_ADAPTIVE_POLLING` | `true` | Adaptive Claude receive polling. |
| `CLAUDE_PEERS_TMUX_UNCHANGED_WRITE_SUPPRESSION` | `true` | Skip unchanged identity stamps; failed stamps receive three bounded retries. |
| `CLAUDE_PEERS_HEARTBEAT_PHASE_SPREAD` | `true` | Deterministically de-phase fleet heartbeats. |
| `CLAUDE_PEERS_HEARTBEAT_MS` | `15000` | Adapter heartbeat interval. |
| `CLAUDE_PEERS_TMUX_REDETECT_EVERY` | `8` | Full tmux re-detect every N heartbeats. |
| `CLAUDE_PEERS_ORPHAN_EXIT_GRACE_MS` | `300000` | Continuous auth/churn grace before orphan self-exit; floored at 60000. |
| `CLAUDE_PEERS_DEAD_MAIL_TTL_MS` | `86400000` | Recoverable dead-seat mail lifetime; floored at one hour. |
| `CLAUDE_PEERS_DELIVERED_MSG_TTL_MS` | `604800000` | Acknowledged-history retention. |
| `CLAUDE_PEERS_UNDELIVERED_MSG_TTL_MS` | `604800000` | Undelivered retention for unknown receivers. |
| `CLAUDE_PEERS_CLI_TIMEOUT_MS` | `3000` | CLI operation timeout. |
| `CLAUDE_PEERS_NO_AUTOSTART` | unset | Set `1` to make the CLI refuse broker auto-start. |
| `CLAUDE_PEER_NAME` | unset | Optional operator-facing seat label captured at session registration. It is not required to be unique. |

The broker always binds literal `127.0.0.1`; host assertions never enable a remote bind.

## CLI and diagnosis

```bash
bun cli.ts status
bun cli.ts peers
bun cli.ts send <live-peer-id> <message>
bun cli.ts kill-broker

bun bin/peers-doctor.ts --json
```

CLI commands use a short-lived authenticated, globally non-targetable identity and remove it in `finally` and handled signal paths. Failures are classified as usage, transport, timeout, malformed response, compatibility, authentication, rate limit, target, partial, cleanup, or unsafe shutdown and return nonzero.

`GET /health` is public loopback evidence and exposes only readiness, version, schema version, targetable peer count, and coarse capabilities. Detailed schema/queue/receiver/process/config evidence comes from the same-user doctor. Aggregate runtime metrics use an authenticated route.

See [docs/operations.md](docs/operations.md) for startup, migration, rollback, service ownership, and incident procedures.

## Managed broker service

```bash
bun bin/install-broker-service.ts install
bun bin/install-broker-service.ts --check
systemctl --user enable --now claude-peers-broker.service
```

The installer renders absolute paths, 0600 unit/drop-in files, a narrow `ReadWritePaths` drop-in, and verifies the unit with `systemd-analyze --user verify` when available. Hardening includes `UMask=0077`, `NoNewPrivileges=yes`, loopback/Unix address-family restriction, private `/tmp`, strict system protection, and read-only home. Uninstall restores operator-owned predecessor files when present:

```bash
bun bin/install-broker-service.ts --uninstall
```

## Optional extensions

The AP-063 bridge is a privileged, authenticated history cursor for a same-user observer. Compatibility keeps it enabled by default. Its token grants access to message history; protect it as a secret. Set `CLAUDE_PEERS_BRIDGE_ENABLED=false` for complete removal.

The Codex auto-drain poller is separate from core delivery. Auto-nudge is disabled by default; `NUDGE_CLIENTS=codex,gemini` explicitly opts selected clients into `tmux send-keys`. Core hooks and MCP delivery do not require it. See [docs/systemd/README.md](docs/systemd/README.md).

## Security model

A peer token proves possession of a broker-issued identity after an unauthenticated caller supplied metadata and passed a same-UID live-PID check. It does not prove OS-process provenance, metadata truth, message truth, authority, or approval.

Every inbound message is potentially adversarial coordination data. It cannot expand the receiver's authorized task, bypass approval, authorize secret access, trigger implicit tmux inspection, or authorize broker shutdown. Relayed payloads retain an explicit untrusted wrapper.

Safe shutdown verifies the loopback socket owner, process start identity, executable/script, database owner metadata, nonce, and—under systemd—the current `MainPID`, twice before signaling only that broker.

## Upgrade and rollback

1. Stop the old broker or verified managed unit.
2. Upgrade the broker first. It wins the listener and database lock, exposes only `starting`/`migrating`, verifies backup/migration, then becomes ready.
3. Run the doctor and verify the schema/backup.
4. Restart adapters, reinstall hooks, and re-confirm Codex trust.
5. Run `bun run verify`, `bun run smoke:install`, and the release gates before publication.

Use `restoreStorageBackup` through the tested offline recovery procedure in [docs/operations.md](docs/operations.md). Never replace a live database, auto-`VACUUM` during startup, or delete a backup merely because migration committed.

## Development and release gates

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run smoke:install
bun run verify
```

The capacity gate is intentionally long and retains 108 records:

```bash
bun run benchmark:peers -- --peers 1,10,50 --repetitions 3 --stages baseline,instrumented,tmux-suppressed,adaptive
```

`bun run smoke:clients` is a separate, blocking release-host gate. It must run only on the explicitly armed A3-owned isolated Linux account with release-pinned, authenticated Claude, Codex, and Gemini clients. Missing prerequisites block release rather than being skipped.

## License

MIT. Copyright (c) 2026 Louis Arge. See [LICENSE](LICENSE).
