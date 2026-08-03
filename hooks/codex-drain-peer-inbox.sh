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

OUT=$(mktemp 2>/dev/null) || exit 0
if bun "$SCRIPT" >"$OUT" 2>>"$LOG"; then
  cat "$OUT"
else
  rc=$?   # captured FIRST: the command substitution below would clobber $?
  printf '%s [%s] drain-failed rc=%s\n' "$(date -Iseconds)" "$EVENT" "$rc" >> "$LOG" 2>/dev/null
fi
rm -f "$OUT" 2>/dev/null
exit 0
