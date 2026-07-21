#!/usr/bin/env bash
# Stop hook with asyncRewake: keep an idle Claude session reachable for peer
# mail. A new Stop refreshes the existing watch instead of losing the re-arm
# behind the per-session lock.

set -u

positive_int() {
  local value="$1" fallback="$2"
  if [[ "$value" =~ ^[1-9][0-9]*$ ]]; then printf '%s\n' "$value"; else printf '%s\n' "$fallback"; fi
}

ACTIVE_SECONDS=$(positive_int "${CLAUDE_PEERS_STANDBY_ACTIVE_SECONDS:-3600}" 3600)
POLL_INTERVAL=$(positive_int "${CLAUDE_PEERS_STANDBY_POLL_INTERVAL_SECONDS:-10}" 10)
IDLE_INTERVAL=$(positive_int "${CLAUDE_PEERS_STANDBY_IDLE_INTERVAL_SECONDS:-60}" 60)
LOCK_WAIT=$(positive_int "${CLAUDE_PEERS_STANDBY_LOCK_WAIT_SECONDS:-2}" 2)
BROKER_PORT="${CLAUDE_PEERS_PORT:-7899}"
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

HOOK_INPUT=""
if [[ ! -t 0 ]]; then HOOK_INPUT=$(cat 2>/dev/null || true); fi
SESSION_ID=""
if [[ -n "$HOOK_INPUT" ]] && command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(printf '%s' "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
fi

CLAUDE_PID="${CLAUDE_PEERS_STANDBY_CLAUDE_PID:-$PPID}"
if [[ -z "${CLAUDE_PEERS_STANDBY_CLAUDE_PID:-}" ]]; then
  walk="$PPID"
  for _ in 1 2 3 4 5; do
    comm=$(ps -p "$walk" -o comm= 2>/dev/null)
    if [[ "$comm" == "claude" ]]; then CLAUDE_PID="$walk"; break; fi
    walk=$(ps -p "$walk" -o ppid= 2>/dev/null | tr -d ' ')
    [[ -z "$walk" || "$walk" == "1" ]] && break
  done
fi
[[ "$CLAUDE_PID" =~ ^[0-9]+$ ]] || exit 0

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

MCP_PID="${CLAUDE_PEERS_STANDBY_MCP_PID:-$(find_mcp_pid)}"
[[ "$MCP_PID" =~ ^[0-9]+$ ]] || exit 0

LOCK_KEY="${SESSION_ID:-$CLAUDE_PID}"
if [[ ! "$LOCK_KEY" =~ ^[A-Za-z0-9._-]{1,128}$ ]]; then LOCK_KEY="$CLAUDE_PID"; fi

# Keep coordination files below an owner-only runtime directory. Unlike the old
# public /tmp lock, the persistent lock inode is never removed, avoiding an
# unlink/recreate split-lock race while another Stop invocation is waiting.
RUNTIME_BASE="${CLAUDE_PEERS_STANDBY_RUNTIME_DIR:-${XDG_RUNTIME_DIR:-$HOME/.cache}}"
STATE_DIR="$RUNTIME_BASE/claude-peers/standby"
umask 077
[[ ! -L "$STATE_DIR" ]] || exit 0
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0
chmod 700 "$STATE_DIR" 2>/dev/null || exit 0
OWNER=$(stat -c '%u' "$STATE_DIR" 2>/dev/null || true)
[[ "$OWNER" == "$(id -u)" ]] || exit 0

LOCK_FILE="$STATE_DIR/$LOCK_KEY.lock"
STATE_FILE="$STATE_DIR/$LOCK_KEY.state"
NOW=$(date +%s)
DEADLINE=$((NOW + ACTIVE_SECONDS))
STATE_TMP="$STATE_DIR/.$LOCK_KEY.state.$$"
printf '%s %s\n' "$DEADLINE" "$MCP_PID" > "$STATE_TMP" 2>/dev/null || exit 0
chmod 600 "$STATE_TMP" 2>/dev/null || exit 0
mv -f "$STATE_TMP" "$STATE_FILE" 2>/dev/null || exit 0

command -v flock >/dev/null 2>&1 || exit 0
exec 200>>"$LOCK_FILE" || exit 0
chmod 600 "$LOCK_FILE" 2>/dev/null || exit 0
# If a prior watcher is approaching its deadline, wait briefly so this process
# can take over. Otherwise the lease write above refreshes that watcher and this
# contender exits without creating a duplicate poller.
flock -w "$LOCK_WAIT" 200 || exit 0

LOG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/logs"
mkdir -p "$LOG_DIR" 2>/dev/null

wake_mode() {
  local summary=""
  if command -v sqlite3 >/dev/null 2>&1; then
    summary=$(sqlite3 -readonly "${CLAUDE_PEERS_DB:-$HOME/.claude-peers.db}" \
      "SELECT summary FROM peers WHERE pid=$MCP_PID" 2>/dev/null || true)
    if [[ "$(bun "$SCRIPT_DIR/claude-wake-mode.ts" "$summary" 2>/dev/null)" == "auto" ]]; then
      printf 'auto\n'
      return
    fi
  fi
  printf 'ask\n'
}

sleep_idle_interruptibly() {
  local remaining="$IDLE_INTERVAL" slice now deadline
  while (( remaining > 0 )); do
    slice="$POLL_INTERVAL"
    (( slice > remaining )) && slice="$remaining"
    sleep "$slice"
    remaining=$((remaining - slice))
    now=$(date +%s)
    read -r deadline _ < "$STATE_FILE" 2>/dev/null || deadline=0
    if [[ "$deadline" =~ ^[0-9]+$ ]] && (( now < deadline )); then return; fi
  done
}

while kill -0 "$CLAUDE_PID" 2>/dev/null; do
  read -r _ CURRENT_MCP_PID < "$STATE_FILE" 2>/dev/null || CURRENT_MCP_PID=""
  if [[ "$CURRENT_MCP_PID" =~ ^[0-9]+$ ]]; then MCP_PID="$CURRENT_MCP_PID"; fi
  RAW=$(curl -s -m 3 -w $'\n%{http_code}' -X POST "http://127.0.0.1:${BROKER_PORT}/claim-by-pid" \
    -H 'Content-Type: application/json' \
    -d "{\"pid\":${MCP_PID},\"caller_pid\":${CLAUDE_PID},\"client_type\":\"claude\",\"receiver_mode\":\"claude-channel\"}" 2>/dev/null)
  STATUS=$(printf '%s\n' "$RAW" | tail -n1)
  RESP=$(printf '%s' "$RAW" | sed '$d')

  if [[ -z "$STATUS" || "$STATUS" != "200" ]]; then
    printf '%s status=%s body=%s\n' "$(date -Iseconds)" "${STATUS:-curl_failed}" "${RESP:0:200}" \
      >> "$LOG_DIR/standby-watcher.log" 2>/dev/null
  else
    COUNT=$(printf '%s' "$RESP" | jq -r '.messages | length // 0' 2>/dev/null)
    if [[ "$COUNT" =~ ^[1-9][0-9]*$ ]]; then
      BLOCKS=$(printf '%s' "$RESP" | bun "$SCRIPT_DIR/claude-render-peer-messages.ts" 2>/dev/null)
      if [[ -z "$BLOCKS" ]]; then
        printf '%s render_failed claimed=%s\n' "$(date -Iseconds)" "$COUNT" >> "$LOG_DIR/standby-watcher.log" 2>/dev/null
      else
        WAKE_MODE=$(wake_mode)
        if [[ "$WAKE_MODE" == "auto" ]]; then
          printf 'Peer mail arrived while idle. %s message(s) drained:\n\n%s\n\nAutonomous mode is enabled by the peer summary. Follow the user\x27s standing scope and normal safety rules.\n' "$COUNT" "$BLOCKS" >&2
        else
          printf 'Peer mail arrived while idle. %s message(s) drained:\n\n%s\n\nSurface this peer update to the user before taking any new action that expands the current task.\n' "$COUNT" "$BLOCKS" >&2
        fi
        DRAIN_ID=$(printf '%s' "$RESP" | jq -r '.drain_id // empty' 2>/dev/null)
        IDS=$(printf '%s' "$RESP" | jq -c '[.messages[].id]' 2>/dev/null)
        if [[ -n "$DRAIN_ID" && "$IDS" != "[]" ]]; then
          ACK_BODY=$(jq -nc --argjson pid "$MCP_PID" --argjson caller "$CLAUDE_PID" --arg drain "$DRAIN_ID" --argjson ids "$IDS" \
            '{pid:$pid, caller_pid:$caller, drain_id:$drain, ids:$ids, via:"claude-standby-hook", client_type:"claude", receiver_mode:"claude-channel"}')
          ACK_RAW=$(curl -s -m 3 -w $'\n%{http_code}' -X POST "http://127.0.0.1:${BROKER_PORT}/ack-by-pid" \
            -H 'Content-Type: application/json' -d "$ACK_BODY" 2>/dev/null)
          ACK_STATUS=$(printf '%s\n' "$ACK_RAW" | tail -n1)
          ACK_COUNT=$(printf '%s' "$ACK_RAW" | sed '$d' | jq -r '.acked // 0' 2>/dev/null)
          if [[ "$ACK_STATUS" != "200" || "$ACK_COUNT" != "$COUNT" ]]; then
            printf '%s status=%s requested=%s acked=%s\n' "$(date -Iseconds)" "${ACK_STATUS:-curl_failed}" "$COUNT" "${ACK_COUNT:-0}" >> "$LOG_DIR/standby-watcher.log" 2>/dev/null
          fi
        fi
        exit 2
      fi
    fi
  fi

  NOW=$(date +%s)
  read -r DEADLINE _ < "$STATE_FILE" 2>/dev/null || DEADLINE=0
  if [[ "$DEADLINE" =~ ^[0-9]+$ ]] && (( NOW < DEADLINE )); then
    sleep "$POLL_INTERVAL"
  else
    # Remain reachable for the life of the Claude process, but reduce idle
    # broker traffic after the fast window. A later Stop refreshes the lease.
    sleep_idle_interruptibly
  fi
done

exit 0
