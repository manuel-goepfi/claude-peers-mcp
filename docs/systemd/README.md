# systemd user services

## Core broker service

Use the installer rather than copying the tracked template. It resolves Bun,
the clone, state paths, and the current user's home into a 0600 unit plus a
narrow `ReadWritePaths` drop-in, verifies the rendered unit when
`systemd-analyze` is available, and reloads the user manager.

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
# enable only if you want systemd (not cron) to own the poller:
# systemctl --user enable --now claude-peers-codex-autodrain.service
```

## Two launchers — pick one

The poller can be supervised by **either**, never both:

- **cron watchdog** (`bin/ensure-codex-autodrain`) — an optional external
  launcher. Its in-code default keeps auto-nudge disabled.
- **this systemd unit** — `disabled`/`inactive` by default. If you enable it,
  disable the cron line first to avoid a double-launch.

Both keep auto-nudge OFF: the systemd unit via its pinned `NUDGE_CLIENTS=`, the
cron/in-code path via the poller's default.
