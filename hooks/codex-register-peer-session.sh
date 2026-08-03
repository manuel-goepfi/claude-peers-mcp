#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${CLAUDE_PEERS_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
SCRIPT="$ROOT/hooks/codex-register-peer-session.ts"
LOG_DIR="${CODEX_HOME:-${HOME:-/tmp}/.codex}/logs"
LOG="$LOG_DIR/register-peer-session.log"
LOG_AVAILABLE=0

if mkdir -p "$LOG_DIR" 2>/dev/null && { exec 3>>"$LOG"; } 2>/dev/null; then
  LOG_AVAILABLE=1
else
  exec 3>/dev/null
fi

warning() {
  if (( LOG_AVAILABLE )); then
    printf '%s\n' '{"systemMessage":"claude-peers registration failed; automatic peer messaging is unavailable for this session. See register-peer-session.log."}'
  else
    printf '%s\n' '{"systemMessage":"claude-peers registration failed; automatic peer messaging is unavailable for this session. Diagnostics logging is also unavailable."}'
  fi
}

if [[ ! -f "$SCRIPT" ]]; then
  printf '%s [SessionStart] missing-script %s\n' "$(date -Iseconds 2>/dev/null || printf unknown)" "$SCRIPT" >&3
  warning
  exit 0
fi

BUN="$(command -v bun 2>/dev/null || true)"
if [[ -z "$BUN" ]]; then
  printf '%s [SessionStart] missing-bun\n' "$(date -Iseconds 2>/dev/null || printf unknown)" >&3
  warning
  exit 0
fi

export CLAUDE_PEERS_REGISTER_LOG_AVAILABLE="$LOG_AVAILABLE"
exec "$BUN" "$SCRIPT" 2>&3
