#!/usr/bin/env bash
# UserPromptSubmit hook: surface pending claude-peers mail before Claude handles
# the user's prompt. Every failure is a soft failure so peer delivery can never
# block normal Claude usage.

set -u
trap 'exit 0' ERR

cat >/dev/null
command -v jq >/dev/null 2>&1 || exit 0

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
SERVER_PATH="$ROOT/server.ts"

child_server_pid() {
  ps -ewwo pid=,ppid=,args= 2>/dev/null | awk -v parent="$1" -v server="$SERVER_PATH" \
    '$2 == parent && index($0, server) > 0 { print $1; exit }'
}

# The server may run behind a stdio-guard wrapper (claude → mcp-stdio-guard.sh
# → bun server.ts). pgrep -f matches the WRAPPER too (its argv contains the
# server path), but the broker row carries the bun process's own pid — so any
# match must be descended to the actual `bun` process before use.
resolve_bun_pid() {
  local cand="$1" depth child
  for depth in 1 2 3; do
    [[ -z "$cand" ]] && return 1
    if [[ "$(ps -p "$cand" -o comm= 2>/dev/null)" == "bun" ]]; then
      echo "$cand"; return 0
    fi
    child=$(pgrep -P "$cand" -f 'claude-peers-mcp/server\.ts' 2>/dev/null | head -1)
    cand="$child"
  done
  return 1
}

find_mcp_pid() {
  local try walk comm
  try=$(child_server_pid "$PPID")
  if [[ -n "$try" ]] && try=$(resolve_bun_pid "$try"); then printf '%s\n' "$try"; return 0; fi
  walk="$PPID"
  for _ in 1 2 3 4 5; do
    comm=$(ps -p "$walk" -o comm= 2>/dev/null)
    if [[ "$comm" == "claude" ]]; then
      try=$(child_server_pid "$walk")
      if [[ -n "$try" ]] && try=$(resolve_bun_pid "$try"); then printf '%s\n' "$try"; return 0; fi
    fi
    walk=$(ps -p "$walk" -o ppid= 2>/dev/null | tr -d ' ')
    [[ -z "$walk" || "$walk" == "1" || "$walk" == "0" ]] && return 1
  done
  return 1
}

find_claude_pid() {
  local walk="$PPID" comm
  for _ in 1 2 3 4 5; do
    comm=$(ps -p "$walk" -o comm= 2>/dev/null)
    if [[ "$comm" == "claude" ]]; then printf '%s\n' "$walk"; return 0; fi
    walk=$(ps -p "$walk" -o ppid= 2>/dev/null | tr -d ' ')
    [[ -z "$walk" || "$walk" == "1" || "$walk" == "0" ]] && break
  done
  printf '%s\n' "$$"
}

MCP_PID="${CLAUDE_PEERS_DRAIN_MCP_PID:-$(find_mcp_pid)}"
[[ "$MCP_PID" =~ ^[0-9]+$ ]] || exit 0
CLAUDE_PID="${CLAUDE_PEERS_DRAIN_CLAUDE_PID:-$(find_claude_pid)}"
[[ "$CLAUDE_PID" =~ ^[0-9]+$ ]] || exit 0

BROKER_PORT="${CLAUDE_PEERS_PORT:-7899}"
RAW=$(curl -s -m 2 -w $'\n%{http_code}' -X POST "http://127.0.0.1:${BROKER_PORT}/claim-by-pid" \
  -H 'Content-Type: application/json' \
  -d "{\"pid\":${MCP_PID},\"caller_pid\":${CLAUDE_PID},\"client_type\":\"claude\",\"receiver_mode\":\"claude-channel\"}" 2>/dev/null)
STATUS=$(printf '%s\n' "$RAW" | tail -n1)
RESP=$(printf '%s' "$RAW" | sed '$d')

if [[ -n "$STATUS" && "$STATUS" != "200" ]]; then
  LOG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/logs"
  mkdir -p "$LOG_DIR" 2>/dev/null
  printf '%s status=%s body=%s\n' "$(date -Iseconds)" "$STATUS" "${RESP:0:200}" \
    >> "$LOG_DIR/drain-peer-inbox.log" 2>/dev/null
  exit 0
fi

[[ -n "$RESP" ]] || exit 0
COUNT=$(printf '%s' "$RESP" | jq -r '.messages | length // 0' 2>/dev/null)
[[ "$COUNT" =~ ^[1-9][0-9]*$ ]] || exit 0

BLOCKS=$(printf '%s' "$RESP" | bun "$SCRIPT_DIR/claude-render-peer-messages.ts" 2>/dev/null)
[[ -n "$BLOCKS" ]] || exit 0

CONTEXT="${COUNT} pending peer message(s) drained before this prompt:
${BLOCKS}"
OUTPUT=$(jq -n --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $ctx
  }
}' 2>/dev/null) || exit 0
[[ -n "$OUTPUT" ]] || exit 0

# Write the rendered context before acknowledging. If rendering or emission
# fails, the claim expires and the broker can redeliver instead of losing mail.
printf '%s\n' "$OUTPUT" || exit 0
DRAIN_ID=$(printf '%s' "$RESP" | jq -r '.drain_id // empty' 2>/dev/null)
IDS=$(printf '%s' "$RESP" | jq -c '[.messages[].id]' 2>/dev/null)
[[ -n "$DRAIN_ID" && "$IDS" != "[]" ]] || exit 0
ACK_BODY=$(jq -nc --argjson pid "$MCP_PID" --argjson caller "$CLAUDE_PID" --arg drain "$DRAIN_ID" --argjson ids "$IDS" \
  '{pid:$pid, caller_pid:$caller, drain_id:$drain, ids:$ids, via:"claude-prompt-hook", client_type:"claude", receiver_mode:"claude-channel"}') || exit 0
ACK_RAW=$(curl -s -m 2 -w $'\n%{http_code}' -X POST "http://127.0.0.1:${BROKER_PORT}/ack-by-pid" \
  -H 'Content-Type: application/json' -d "$ACK_BODY" 2>/dev/null)
ACK_STATUS=$(printf '%s\n' "$ACK_RAW" | tail -n1)
ACK_COUNT=$(printf '%s' "$ACK_RAW" | sed '$d' | jq -r '.acked // 0' 2>/dev/null)
if [[ "$ACK_STATUS" != "200" || "$ACK_COUNT" != "$COUNT" ]]; then
  LOG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/logs"
  mkdir -p "$LOG_DIR" 2>/dev/null
  printf '%s status=%s requested=%s acked=%s\n' "$(date -Iseconds)" "${ACK_STATUS:-curl_failed}" "$COUNT" "${ACK_COUNT:-0}" >> "$LOG_DIR/drain-peer-inbox.log" 2>/dev/null
fi
