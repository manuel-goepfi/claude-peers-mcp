#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$ROOT/hooks/register-peer-session.ts"
if [[ ! -f "$SCRIPT" ]]; then
  printf 'claude-peers Claude register hook missing: %s\n' "$SCRIPT" >&2
  exit 1
fi
CLAUDE_PEERS_CLIENT_TYPE=claude exec bun "$SCRIPT"
