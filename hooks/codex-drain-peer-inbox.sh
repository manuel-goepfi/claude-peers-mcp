#!/usr/bin/env bash
# Codex drain wrapper -> canonical claude-peers Codex drain (.ts).
#
# FAIL-OPEN by contract, matching ~/.codex/hooks/drain-peer-inbox.sh and the
# Claude-side drain hook: peer delivery must never block or visibly disrupt a
# turn. This wrapper previously did a bare `exec bun "$SCRIPT"`, which
# propagated the .ts's exitCode=1 straight to Codex.
#
# That mattered because exitCode=1 is ALSO how the .ts reports the benign
# "peer not resolvable yet" case. Two consequences, both measured 2026-08-03:
#
#   1. Codex rendered it as a red `hook exited with code 1` on SessionStart and
#      Stop — an alarming error for an expected condition.
#   2. This wrapper wrote NO log, so the Stop path failed silently. The sibling
#      UserPromptSubmit wrapper (which does log) had recorded 553 failures in
#      ~/.codex/logs/drain-peer-inbox.log, 541 of them immediately preceded by
#      "no codex ancestor found" — invisible from the Stop side for weeks.
#
# Logging to the SAME file as the sibling on purpose: one place to read the
# whole drain story regardless of which event fired. Lines are event-tagged so
# the Stop path is distinguishable from UserPromptSubmit/SessionStart.
#
# stdout is forwarded ONLY on success, so a partial or invalid payload can
# never reach Codex — a hook that emits malformed JSON is worse than one that
# emits nothing.
set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${CLAUDE_PEERS_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
SCRIPT="$ROOT/hooks/codex-drain-peer-inbox.ts"
EVENT="${CLAUDE_PEERS_HOOK_EVENT_NAME:-UserPromptSubmit}"
# HOME must be defaulted, not assumed: this wrapper runs under `set -u`, and
# Codex (and the hook-wrapper tests) can invoke it with a minimal environment
# that carries PATH and nothing else. A bare $HOME there is an unbound-variable
# fatal — the wrapper would die before reaching the .ts, and write to stderr
# while doing it, which is the one thing a fail-open hook must never do.
LOG_DIR="${CODEX_HOME:-${HOME:-/tmp}/.codex}/logs"
LOG="$LOG_DIR/drain-peer-inbox.log"
mkdir -p "$LOG_DIR" 2>/dev/null || true

if [[ ! -f "$SCRIPT" ]]; then
  printf '%s [%s] missing-script %s\n' "$(date -Iseconds)" "$EVENT" "$SCRIPT" >> "$LOG" 2>/dev/null
  exit 0
fi

# PostToolUse throttle (measured 2026-10-06: Codex hooks were ~14% of all
# process launches on the host, bursting a bun drain to 400%+ CPU, because
# every tool call of every Codex thread started bash + bun). A thread drains on
# PostToolUse at most once per CLAUDE_PEERS_CODEX_POSTTOOL_MIN_INTERVAL_SECONDS
# (default 15), keyed by the payload's session_id (the thread id). SessionStart,
# UserPromptSubmit and Stop are never throttled, so mail still lands at every
# turn boundary; PostToolUse is only the extra mid-turn chance. The check uses
# bash builtins only. No session_id, or an unreadable stamp: no throttle.
PAYLOAD=""
if [[ "$EVENT" == PostToolUse ]]; then
  IFS= read -r -d '' -t 2 PAYLOAD || true
  MIN="${CLAUDE_PEERS_CODEX_POSTTOOL_MIN_INTERVAL_SECONDS:-15}"
  if [[ "$MIN" =~ ^[0-9]+$ && "$MIN" -gt 0 \
        && "$PAYLOAD" =~ \"session_id\"[[:space:]]*:[[:space:]]*\"([A-Za-z0-9._:-]{1,128})\" ]]; then
    STAMP_DIR="${CLAUDE_PEERS_DRAIN_THROTTLE_DIR:-${XDG_RUNTIME_DIR:-/tmp}/claude-peers-codex-drain}"
    STAMP="$STAMP_DIR/${BASH_REMATCH[1]}"
    printf -v NOW '%(%s)T' -1
    LAST=0
    [[ -r "$STAMP" ]] && { read -r LAST < "$STAMP" || LAST=0; }
    [[ "$LAST" =~ ^[0-9]+$ ]] || LAST=0
    if (( NOW - LAST < MIN )); then
      exit 0
    fi
    # shellcheck disable=SC2174  # only the leaf needs 0700
    [[ -d "$STAMP_DIR" ]] || mkdir -p -m 700 "$STAMP_DIR" 2>/dev/null
    printf '%s\n' "$NOW" > "$STAMP" 2>/dev/null
  fi
fi

OUT=$(mktemp 2>/dev/null) || exit 0
if [[ "$EVENT" == PostToolUse ]]; then
  # stdin was consumed above; hand the same payload to the .ts.
  if [[ -n "$PAYLOAD" ]]; then exec 0<<<"$PAYLOAD"; else exec 0</dev/null; fi
fi
if bun "$SCRIPT" >"$OUT" 2>>"$LOG"; then
  cat "$OUT"
else
  rc=$?   # captured FIRST: the command substitution below would clobber $?
  printf '%s [%s] drain-failed rc=%s\n' "$(date -Iseconds)" "$EVENT" "$rc" >> "$LOG" 2>/dev/null
fi
rm -f "$OUT" 2>/dev/null
exit 0
