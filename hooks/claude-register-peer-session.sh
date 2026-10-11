#!/bin/bash
set -euo pipefail
# Opt-out for helper Claude processes that must not act as a peer seat: a
# launcher's short-lived child inherits the operator pane (TMUX_PANE) but is not
# that pane's seat, and registering it leaves a ghost row under the seat's name.
case "${CLAUDE_PEERS_SESSION_HOOKS_ENABLED:-true}" in false|0|no|off) exit 0 ;; esac
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$ROOT/hooks/register-peer-session.ts"
if [[ ! -f "$SCRIPT" ]]; then
  printf 'claude-peers Claude register hook missing: %s\n' "$SCRIPT" >&2
  exit 1
fi
CLAUDE_PEERS_CLIENT_TYPE=claude exec bun "$SCRIPT"
