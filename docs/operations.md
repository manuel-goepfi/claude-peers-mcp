# Operations guide

This guide covers the maintained Linux, one-UID deployment of `claude-peers`. Run commands from the clone unless a command says otherwise. Keep the broker, database, token, backup, and log owned by the same operating-system user.

## Observe before changing anything

Start with the public readiness surface and then the read-only doctor:

```bash
curl --fail-with-body http://127.0.0.1:7899/health
bun bin/peers-doctor.ts
bun bin/peers-doctor.ts --json
```

`GET /health` exposes only coarse readiness, version, schema version, targetable peer count, and capabilities. The doctor makes one health request and then correlates same-UID process, configuration, and read-only SQLite evidence. It never registers, polls, claims, acknowledges, sends, heartbeats, or mutates configuration.

Treat the readiness state literally:

- `ready`: operational routes may be used.
- `starting` or `migrating`: wait; the doctor deliberately skips schema queries.
- `unreachable` with a live or ambiguous database owner: do not open or replace the database. Establish broker ownership first.
- `unsupported`: stop the older binary and upgrade the broker before adapters.

Use the JSON report for automation. Gate on its exit status and `status`; do not parse human prose. The report contains counts and classifications, not message content, tokens, captured panes, arbitrary filesystem paths, or broker-log text.

The `processes.adapters` object is a stable, complete diagnostic map with `claude`, `codex`, `gemini`, `cursor`, `agy`, `kimi`, `grok`, `opencode`, and `unknown` keys. Cursor, agy, Kimi, Grok, and OpenCode are process-classification entries. OpenCode has a managed local-MCP installer; authenticated release-host smoke remains Claude, Codex, and Gemini until a separately armed OpenCode account is added to that gate.

## Stable recipient selection and same-thread recovery

When multiple live registrations remain for one seat, routing prefers an explicit
thread binding, then the newest registration timestamp, then a deterministic ID
tie-break. Heartbeats affect liveness only; they cannot swap the active recipient.
A stale-ID response is still a refusal, not an automatic redirect. Refresh the
recipient using the returned candidate; never alternate blindly between IDs.
Thread identifiers remain excluded from ordinary peer discovery responses.

Folding an exact-thread paneless or same-pane adapter into a proven Codex pane
allows its existing authenticated recovery path to re-register without closing
stdio. Moving the thread away from a different concrete pane still supersedes
that pane's old registration. Neither rule proves end-to-end delivery: verify an
outgoing send with recipient acknowledgment and an incoming reply after recovery.

Open tmux panes use `session.number` as their routable operator name. Allocation
is monotonic across the currently open panes and ignores layout indexes, so a
move or split does not rename a survivor. A session rename updates the prefix.
Closing a pane releases its number; no closed-pane reservation is retained.

Native Claude mailbox grouping is limited to one independently proven runtime,
account, conversation, and pane. The native peer remains the only targetable
member; companion IDs remain as non-targetable history aliases so pending mail
and correlated replies are preserved. A process replacement or mismatched proof
revokes the group instead of transferring it by name or timestamp.

## Ownership modes

Only one process may own both the configured loopback listener and canonical database. The database owner file is a lifetime lock, not a stale-file convention.

### Direct ownership

An adapter or authenticated CLI operation may start the broker directly. This is the simplest development mode. `bun cli.ts kill-broker` performs verified shutdown and refuses to signal when socket, process, database-owner, executable, nonce, or ownership evidence does not agree.

```bash
bun cli.ts status
bun cli.ts kill-broker
```

Do not use broad process-name kills. A failed safe shutdown is an ownership incident to diagnose, not permission to signal an unverified PID.

### Managed systemd ownership

Install the rendered user unit and its configured-parent state-path drop-in:

```bash
bun bin/install-broker-service.ts install
bun bin/install-broker-service.ts --check
systemctl --user enable --now claude-peers-broker.service
systemctl --user status claude-peers-broker.service
```

The managed unit sets `CLAUDE_PEERS_OWNER_MODE=systemd`. In this mode, safe shutdown also verifies systemd's current `MainPID`. To remove the managed files and restore any operator-owned predecessors:

The compatibility defaults place the database, token, backup, and log directly under `$HOME`; systemd must therefore grant their shared parent, the home directory, write access despite `ProtectHome=read-only`. For a genuinely narrow sandbox, set all four paths under one dedicated 0700 state directory before the first managed install. Relocating an existing database is an offline migration and must follow the ownership and WAL checks below.

```bash
systemctl --user disable --now claude-peers-broker.service
bun bin/install-broker-service.ts --uninstall
```

Do not run the direct broker beside the managed unit. Install or update the unit, stop the old owner, and let exactly one supervisor win the listener and database lock.

## Configuration and client trust

Install each client at either user or project scope, not both. The doctor reports duplicate scope, stale entries, unsafe files, and the need for restart/trust confirmation. An install against a duplicate scope warns but never removes the other scope; explicitly run `--uninstall` against the scope you no longer want.

```bash
bun bin/install-claude-hook.ts --check
bun bin/install-codex-hook.ts --check
bun bin/install-gemini-hook.ts --check
bun bin/install-opencode-mcp.ts --check
```

Correct installers are byte- and mtime-stable no-ops. A material change gets a unique 0600 sibling backup. `--restore <backup-path>` is guarded against restoring an unrelated backup or overwriting a subsequently edited install.

Alternate Claude profiles are explicit: prefix both install and check with `CLAUDE_CONFIG_DIR=/path/to/profile`. Claude standby delivery uses a 10-second cadence for the first hour after Stop, then 60 seconds while the Claude process remains alive; later Stop events atomically refresh the fast deadline and current adapter PID. The `CLAUDE_PEERS_STANDBY_*` controls are documented in the README configuration table. Watcher state is owner-only under `CLAUDE_PEERS_STANDBY_RUNTIME_DIR`, `$XDG_RUNTIME_DIR`, or `$HOME/.cache` in that order.

OpenCode's managed installer writes the official top-level `mcp` local-server shape to `~/.config/opencode/opencode.jsonc`, preserves unrelated entries, and pins `CLAUDE_PEERS_CLIENT_TYPE=opencode` for deterministic process classification:

```bash
bun bin/install-opencode-mcp.ts install
bun bin/install-opencode-mcp.ts --check
```

OpenCode has no interactive external receive hook in this contract. It registers one stdio adapter per session in `manual-drain` mode, and the tmux poller wakes only a quiescent pane whose boxed composer contains the exact grey vendor placeholder. The wake submits one `check_messages` turn; typed text, permission prompts, loading states, busy panes, and unconfirmed Enter submissions fail closed.

After MCP or hook changes:

1. Restart the affected client session.
2. In Codex, open `/hooks` and confirm the changed hook configuration.
3. Run the doctor again.
4. Call `whoami`, then use a second session to prove discovery and acknowledgement.

Missing or unproven Codex/Gemini hooks intentionally produce `manual-drain`; use `check_messages` until registration and hook heartbeats prove the automatic path. For Codex, automatic registration and drain require a root-session hook whose `session_id` matches the rollout transcript filename. Internal or child hooks that cannot prove that join do not claim mail; the queued batch remains available to `check_messages` or the next proven root hook.

### Shared Codex Desktop relay

Background Codex discovery observes an existing exact PID/pane thread binding
and republishes that identity instead of registering a competing threadless
peer. Ambiguous bindings are left unchanged. The broker also rejects discovery
registration when a thread binding appeared after the discovery snapshot.
This prevents new duplicates; it does not delete historical duplicate rows.

Desktop-only MCP tools can bind to an exact hook-owned thread without a pane
when its host PID matches the adapter's independently discovered app-server
ancestor and all terminal/seat fields are null. This grants no tmux wake target.
Existing MCP adapter processes must reload before using changed adapter code;
a broker restart alone does not reload them. Confirm the reload scope before
refreshing a shared Desktop account's loaded tasks.

Use `bin/codex-shared-seat` only from a tmux pane when the Desktop app-server
thread must remain the lane's peer identity. A successful launch produces:

- one `node --experimental-strip-types bin/codex-appserver-relay.ts` child on
  the pane TTY;
- a private `claude-peers-codex-relay.*` runtime directory;
- a 0600 `app-server.sock` and 0600 readiness file;
- `$CODEX_HOME/logs/codex-shared-relay-<pane>.log`.

An optional operator-owned `~/bin/codexr` provides `--desktop` indexed
resume selection for bare `resume` and `resume --all`. Override its executable
with `CLAUDE_PEERS_CODEX_RESUME_PICKER` (or set `native` to skip it). The
picker runs before relay creation and returns an exact UUID to this launcher;
exact-ID resumes do not recurse. Account socket validation still happens
first. A custom socket override bypasses this picker to preserve its endpoint.

Node >=22.6 is intentional for this one process. Do not replace it with Bun
without a release-pinned proof that Bun's WebSocket client supports the
Codex `ws+unix` upstream. The wrapper stops the relay and removes the runtime
artifacts when the TUI exits.

The observer excludes ephemeral task starts. If MCP inventory is connected
but `whoami` cannot find the pane's task after a user turn, check that the relay
has not rebound to a temporary structured-output helper. Restart only the
affected TUI through the updated wrapper, resuming its saved task; the shared
account server need not be restarted.

Registration hooks without a proved inherited pane use the hook's exact task
ID. They must not adopt a sole visible terminal from another task/account. A
`sole visible TTY` registration log indicates the older unsafe fallback; the
updated hook no longer uses it. Hook subprocesses load this repair on their
next invocation, without restarting the shared server.

The shared launcher labels the current task with its A/B/C account when using
that home's default socket. Labels apply on resume and on name-update events,
including changes from the Desktop UI. Rename RPC responses belong to the
relay and are consumed there; normal title notifications reach all clients.
Existing relay processes keep their loaded code: the new behavior applies to
future launches/resumes through the updated wrapper. No account backend restart
is needed. A custom/unknown home or mismatched socket override receives no
automatic label. This does not change the peer name or tmux operator label.

For a failed launch, inspect the pane-specific relay log, verify the upstream
app-server socket, run the relay transport and pane-bind tests, then resume the
same thread through the wrapper. A `409` live-pane conflict is fail-closed and
must not be bypassed. Outside tmux the wrapper only co-attaches; it cannot
publish an exact peer seat, so use a normal pane-local Codex session when peer
tools are required.

The non-tmux path connects to the same explicit upstream socket that was
validated at startup. It must not substitute the implicit `unix://` default,
which could select a different server when a socket override is configured.

## Native messaging and broker wake-ups

For new Claude-to-Claude conversations, prefer native `ListAgents`/`SendMessage`
when the exact recipient is discoverable. Use Claude Peers across clients, or
when native routing is unavailable before sending. Reply on the incoming
transport. Never duplicate a queued/uncertain send across transports or bypass
a refusal. Resolve current recipients rather than treating pane labels as IDs.

Claude owns wake-up for native messages. The broker nudger only considers
currently unread broker mail and retains its idle/input/ownership checks; do
not disable Claude recipients, because cross-client mail still needs that path.
Keep the short hook-backed wake notice. The compact `check_messages` variant
remains necessary for manual-drain receivers and as an urgent fallback when a
hook has not produced a recent event. Native safety wrappers are not broker
nudges and must not be stripped.

Peer discovery reports active presence separately from hook events. For
hook-backed peers, `hook_event=recent` means a hook ran within two minutes;
`hook_event=not_recent` means no hook event ran in that window. Hooks are
event-driven, so an old event timestamp alone does not prove success or failure.
`hook_event=not_observed` means hook delivery is not yet proven. A recorded
`last_error` is direct failure evidence. Use `check_messages` as an urgent
fallback when queued mail must not wait for the next event boundary.

## Upgrade order

Upgrade the broker before its adapters because the broker owns schema compatibility:

1. Record `bun bin/peers-doctor.ts --json` and stop the verified direct broker or managed unit.
2. Update the clone and run `bun install --frozen-lockfile`.
3. Update the systemd unit if used: `bun bin/install-broker-service.ts install`.
4. Start only the broker. During migration it returns `starting` or `migrating` and rejects operational routes.
5. Wait for `ready`, then run the doctor and inspect the retained backup and manifest if a migration occurred.
6. Reinstall/check hooks and restart client adapters.
7. Re-confirm Codex hook trust.
8. Run `bun run verify`, the capacity evidence gate, and the separately armed real-client smoke gate before release.

Never start older and newer brokers against the same database. A newer-than-supported schema is a hard compatibility stop.

## Backup, migration, and offline restore

A legacy migration first creates `<backup>` plus `<backup>.manifest.json`, restricts their permissions, verifies SQLite integrity and row digests, and only then changes the live schema. The schema version is committed last. The verified backup is retained after success; do not delete it as part of startup.

Restore is deliberately an offline operator action:

1. Stop the verified broker owner. If systemd owns it, use `systemctl --user stop claude-peers-broker.service`.
2. Confirm `/health` is unreachable and the owner process is no longer live.
3. Check that the live database has no `-wal` or `-shm` sidecar. Their presence means the shutdown/checkpoint is incomplete; do not delete them to force progress.
4. Set explicit absolute database and backup paths, then invoke the tested restore primitive:

```bash
export CLAUDE_PEERS_DB="$HOME/.claude-peers.db"
export CLAUDE_PEERS_BACKUP="$HOME/.claude-peers.db.backup"
bun -e 'import { restoreStorageBackup } from "./shared/storage.ts"; console.log(restoreStorageBackup({ databasePath: process.env.CLAUDE_PEERS_DB!, backupPath: process.env.CLAUDE_PEERS_BACKUP! }))'
```

The restore verifies the manifest, checksum, integrity, and snapshot; copies through a restricted temporary file; atomically displaces any live database to a timestamped `.pre-restore-*` path; and fsyncs the containing directory. Keep the displaced database until the recovered broker passes health, doctor, and delivery checks.

5. Start the broker alone, wait for `ready`, and run the doctor.
6. Restart adapters only after schema and queue evidence are acceptable.

Never replace a live database, restore without both backup and manifest, run startup-time `VACUUM`, or remove WAL/SHM files by hand.

### Optional offline compaction

Compaction is not required for normal operation and the `sqlite3` CLI is not a core dependency. If disk reclamation is necessary, stop the broker first and make an independent restricted backup before running `VACUUM`:

```bash
systemctl --user stop claude-peers-broker.service  # omit in direct mode
export CLAUDE_PEERS_DB="$HOME/.claude-peers.db"
export PRE_VACUUM_BACKUP="$HOME/.claude-peers.db.pre-vacuum"
test ! -e "$CLAUDE_PEERS_DB-wal" && test ! -e "$CLAUDE_PEERS_DB-shm"
umask 077
sqlite3 "$CLAUDE_PEERS_DB" ".backup '$PRE_VACUUM_BACKUP'"
test "$(sqlite3 "$PRE_VACUUM_BACKUP" 'PRAGMA integrity_check;')" = ok
sqlite3 "$CLAUDE_PEERS_DB" 'VACUUM; PRAGMA integrity_check;'
```

Require the final command to print `ok`, retain the pre-compaction backup, start the broker, and rerun health plus doctor. In direct mode, prove the owner is stopped rather than assuming the absence of a systemd unit means the database is offline.

## Incident matrix

| Symptom | Evidence to collect | Safe response |
| --- | --- | --- |
| `/health` unreachable, no owner | Doctor process/config report; owner file state; owner-only broker log | Start exactly one direct or managed broker, then rerun doctor. |
| `/health` unreachable, live/ambiguous owner | Socket ownership, owner metadata, systemd `MainPID` when managed | Do not read/replace SQLite. Resolve ownership or use verified shutdown. |
| `starting`/`migrating` persists | Broker log, backup and manifest presence, service restart count | Stop restart loops; preserve all database artifacts; investigate the first migration error. |
| Unsupported/newer schema | Doctor schema classification and running binary version | Stop the older broker; deploy a compatible broker. Do not downgrade the live database in place. |
| Hook current but no automatic receipt | Doctor receiver mode/health, client restart, Codex `/hooks` trust | Restart, confirm trust, reinstall/check one scope, and use `check_messages` meanwhile. |
| Hook or MCP entry stale | `--check`, doctor user/project classification | Re-run the relevant installer. |
| Shared Codex seat has `pane missing` | Relay log, upstream socket, tmux pane, `/identity-by-thread`, pane-bind tests | Reopen through `bin/codex-shared-seat` in tmux. Do not infer identity by cwd or pane text. |
| Duplicate user/project scope | Doctor `duplicate_scope` | Choose one owner. Install there, then explicitly run `--uninstall` for the other scope. |
| Repeated auth/churn failures | Adapter stderr, broker readiness, process correlation | Restore broker reachability; the adapter receives a continuous grace period before self-exit. Restart only after the owner is stable. |
| Messages remain `claimed` | Receiver health, claim age, hook execution | Let the 30-second lease expire, repair the receiver, then reclaim. Do not mark delivery manually. |
| CLI refuses shutdown | CLI classification plus socket/process/owner/systemd evidence | Treat as a safety success. Correct the mismatched ownership evidence before retrying. |

## Logs, metrics, bridge, and nudge

The broker append log is created owner-only. Keep logs local and avoid copying them into shared tickets without review. `/health` stays content-free; authenticated aggregate metrics contain route counts/latency summaries, not message content or peer IDs.

The AP-063 bridge is a privileged same-UID history cursor. Its 0600 bearer token grants message-history access. Set `CLAUDE_PEERS_BRIDGE_ENABLED=false` to remove token publication and the route completely, then restart the broker.

The auto-drain poller is an optional extension, not a delivery prerequisite. Auto-nudge is off by default. Enabling `NUDGE_CLIENTS` authorizes that poller to type a prompt into selected tmux clients and consume a turn; scope that choice explicitly. When the systemd poller unit is resolvable, `ensure-codex-autodrain` delegates to it and never launches a second tmux poller; tmux is a fallback only when the managed unit cannot be resolved.

Generic Read/Execute/Follow/Implement TASK.md task titles are replaced by the first descriptive TASK.md heading in the task cwd, retaining the account prefix. Lane headings omit account metadata and date suffixes. Missing or oversized files preserve the original title. Descriptive task names are preserved; task file content is never executed. New relay processes load this behavior.
