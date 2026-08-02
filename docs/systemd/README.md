# systemd user services

## Core broker service

Use the installer rather than copying the tracked template. It resolves Bun,
the clone, state paths, current port, and the current user's home into a 0600 unit plus a
configured-parent `ReadWritePaths` drop-in, verifies the rendered unit when
`systemd-analyze` is available, and reloads the user manager.

Legacy default state files live directly under `$HOME`, so their common writable
parent is the whole home directory. Set the database, bridge token, backup, and
log beneath one dedicated 0700 state directory before first install when a
narrow home sandbox is required. Move existing state only through the offline
procedure in the operations guide.

```sh
bun bin/install-broker-service.ts install
bun bin/install-broker-service.ts --check
systemctl --user enable --now claude-peers-broker.service
```

The unit is the only broker owner in managed mode. It sets
`CLAUDE_PEERS_OWNER_MODE=systemd`; direct CLI shutdown therefore verifies the
current systemd `MainPID` as well as the loopback socket, process start
identity, executable/script, database owner metadata, and nonce.

```sh
systemctl --user status claude-peers-broker.service
systemctl --user disable --now claude-peers-broker.service
bun bin/install-broker-service.ts --uninstall
```

Uninstall removes only managed files and restores a retained operator-owned
predecessor when one existed. See [the operations guide](../operations.md) for
upgrade, migration, and offline recovery.

## Optional codex auto-drain poller

The tracked user unit runs `bin/codex-autodrain-poller.ts` from the default
`$HOME/claude-peers-mcp` clone. If the clone or Bun lives elsewhere, edit the
two `ExecStart` paths deliberately before installation.

## What the poller does

Optionally nudges idle Codex/Gemini/Claude lanes (via `tmux send-keys`) to read
pending peer mail. **Auto-nudge is OFF by default** — see `NUDGE_CLIENTS` below.

## Auto-nudge default: OFF

The unit pins `Environment=NUDGE_CLIENTS=` (empty = nudge nobody). Rationale:
typing a nudge into an idle session forces a turn. Claude lanes already
piggyback-drain pending mail on their next turn for free; idle Codex/Gemini wakes
burn quota to drain low-value chatter. Mail still flows on each lane's next
natural turn. To re-enable a client, set the comma-separated list
(`codex` / `gemini` / `claude` honored):

```
Environment=NUDGE_CLIENTS=codex,gemini
```

The poller logs its state at startup (`nudge=DISABLED` or `nudge=codex,...`), so
the active posture is always observable in `~/.claude-peers-codex-autodrain.log`.

## Install or update

```sh
cp docs/systemd/claude-peers-codex-autodrain.service \
   ~/.config/systemd/user/claude-peers-codex-autodrain.service
chmod 600 ~/.config/systemd/user/claude-peers-codex-autodrain.service
systemd-analyze --user verify ~/.config/systemd/user/claude-peers-codex-autodrain.service
systemctl --user daemon-reload
# enable the primary systemd owner; the cron watchdog delegates to it:
# systemctl --user enable --now claude-peers-codex-autodrain.service
```

## Primary systemd owner with tmux fallback

`bin/ensure-codex-autodrain` is safe to leave in cron and in `.tmux.conf`. It
uses this unit whenever the user manager can resolve it:

- **active** — exits without launching a second poller;
- **inactive** — restarts the unit and exits;
- **unresolvable** — uses its tmux fallback, including the fallback opt-in
  configuration.

If a resolvable unit fails to restart, the watchdog exits non-zero and never
falls back to tmux. This keeps a managed-service failure observable instead of
creating competing supervisors. The unit's `NUDGE_CLIENTS` is authoritative
while systemd is available; the fallback reads its own explicit opt-in.
