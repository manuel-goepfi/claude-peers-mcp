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

Install the rendered user unit and its narrow state-path drop-in:

```bash
bun bin/install-broker-service.ts install
bun bin/install-broker-service.ts --check
systemctl --user enable --now claude-peers-broker.service
systemctl --user status claude-peers-broker.service
```

The managed unit sets `CLAUDE_PEERS_OWNER_MODE=systemd`. In this mode, safe shutdown also verifies systemd's current `MainPID`. To remove the managed files and restore any operator-owned predecessors:

```bash
systemctl --user disable --now claude-peers-broker.service
bun bin/install-broker-service.ts --uninstall
```

Do not run the direct broker beside the managed unit. Install or update the unit, stop the old owner, and let exactly one supervisor win the listener and database lock.

## Configuration and client trust

Install each client at either user or project scope, not both. The doctor reports duplicate scope, stale entries, unsafe files, and the need for restart/trust confirmation.

```bash
bun bin/install-claude-hook.ts --check
bun bin/install-codex-hook.ts --check
bun bin/install-gemini-hook.ts --check
```

Use `--replace` for an intentional scope transfer. Correct installers are byte- and mtime-stable no-ops. A material change gets a unique 0600 sibling backup. `--restore <backup-path>` is guarded against restoring an unrelated backup or overwriting a subsequently edited install.

After MCP or hook changes:

1. Restart the affected client session.
2. In Codex, open `/hooks` and confirm the changed hook configuration.
3. Run the doctor again.
4. Call `whoami`, then use a second session to prove discovery and acknowledgement.

Missing or unproven Codex/Gemini hooks intentionally produce `manual-drain`; use `check_messages` until registration and hook heartbeats prove the automatic path.

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
| Hook or MCP entry stale | `--check`, doctor user/project classification | Re-run the relevant installer; use `--replace` only for an intentional scope move. |
| Duplicate user/project scope | Doctor `duplicate_scope` | Choose one owner. Install there with `--replace` so the other managed scope is removed. |
| Repeated auth/churn failures | Adapter stderr, broker readiness, process correlation | Restore broker reachability; the adapter receives a continuous grace period before self-exit. Restart only after the owner is stable. |
| Messages remain `claimed` | Receiver health, claim age, hook execution | Let the 30-second lease expire, repair the receiver, then reclaim. Do not mark delivery manually. |
| CLI refuses shutdown | CLI classification plus socket/process/owner/systemd evidence | Treat as a safety success. Correct the mismatched ownership evidence before retrying. |

## Logs, metrics, bridge, and nudge

The broker append log is created owner-only. Keep logs local and avoid copying them into shared tickets without review. `/health` stays content-free; authenticated aggregate metrics contain route counts/latency summaries, not message content or peer IDs.

The AP-063 bridge is a privileged same-UID history cursor. Its 0600 bearer token grants message-history access. Set `CLAUDE_PEERS_BRIDGE_ENABLED=false` to remove token publication and the route completely, then restart the broker.

The auto-drain poller is an optional extension, not a delivery prerequisite. Auto-nudge is off by default. Enabling `NUDGE_CLIENTS` authorizes that poller to type a prompt into selected tmux clients and consume a turn; scope that choice explicitly and run only one poller supervisor.
