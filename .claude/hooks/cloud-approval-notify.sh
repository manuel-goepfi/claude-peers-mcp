#!/usr/bin/env bash
# cloud-approval-notify.sh — approval cards for Claude Code cloud sessions, answerable from T3.
#
#   cloud-approval-notify.sh ask    PermissionRequest hook: post state "open",
#                                   then wait for the operator's answer
#   cloud-approval-notify.sh done   PostToolUse hook: post state "done" for an
#                                   id this VM posted as "open" earlier
#
# A cloud session (CLAUDE_CODE_REMOTE=true) with a cloud-peers lane token
# (C5_PEER_TOKEN) and c5-peer on PATH tells the tailnet gateway (POST /ask on
# $C5_PEER_URL) that it waits for an approval, so the operator's T3 sidebar can
# show a card. The send runs fully detached (setsid, else nohup;
# stdin/stdout/stderr closed). Always exits 0.
#
# Answers (2026-10-15, step 2): after the post, ask mode polls GET
# /decision?id=<id> every ${C5_CLOUD_ASK_POLL:-3} s for up to
# ${C5_CLOUD_ASK_WAIT:-300} s (0 turns waiting off). The permission prompt stays
# open on claude.ai meanwhile and whichever answers first applies. Only a
# gateway answer of "allow" or "deny" prints a PermissionRequest decision on
# stdout; anything else (no answer in time, 4xx, the done marker gone because
# the tool already ran) prints nothing, so the prompt is left to the person.
#
# id = first 16 hex of sha256(session_id "\n" tool_name "\n" tool_input as
# JSON with sorted keys and compact separators). PostToolUse carries the same
# fields, so "done" recomputes the same id. A marker directory
# ${TMPDIR:-/tmp}/c5-cloud-asks/<id> records each posted ask; "done" posts
# only when that marker exists and removes it, so ordinary tool calls never
# reach the gateway. A per-id lock ($ASK_DIR/<id>.lock) serializes the two
# posts: the ask hook takes it before returning and its detached child holds
# it through the post; the done child waits up to 40 s for it, so the gateway
# never sees done before open.
#
# command: Bash -> the command; Edit/Write/Read/MultiEdit/NotebookEdit -> tool
# and path; WebFetch -> tool and url; otherwise the compact tool_input JSON.
# Whitespace is collapsed, obvious secrets become [redacted], capped at 500.
# The exact C5_PEER_TOKEN value becomes [redacted] in command, tool and
# session. A token outside the allowlist ^[A-Za-z0-9._~+/=-]{8,}$ (checked
# in the C locale) makes every mode exit 0 at once, like an empty one.
#
# The token travels only in the Authorization header, read by curl from a
# process-substitution pipe (never argv, never a file). Proxy handling copies
# c5-peer: C5_PEER_PROXY native mode uses -x, else SOCKS5 on
# ${C5_PEER_SOCKS:-localhost:1055}; every proxy variable is cleared for curl.
# Failures are silent apart from one line (mode, id, status; never the
# command or token) in ${TMPDIR:-/tmp}/c5-cloud-asks.log.
#
# Test-only: C5_CLOUD_ASK_DIRECT=1 drops the proxy arguments, honoured only
# when C5_CLOUD_ASK_TEST=1 is also set (.claude/hooks/test/test-cloud-approval-notify.sh).
set -u -o pipefail

MODE="${1:-}"
ASK_DIR="${TMPDIR:-/tmp}/c5-cloud-asks"
LOG="${TMPDIR:-/tmp}/c5-cloud-asks.log"
# Gates first, for every mode including the internal __send: nothing runs
# c5-peer or reaches the transport outside a cloud session with a lane token.
[[ "${CLAUDE_CODE_REMOTE:-}" == true ]] || exit 0
[[ -n "${C5_PEER_TOKEN:-}" ]] || exit 0
# Allowlist: gateway tokens are url-safe base64 joined by '.' (mint() in
# cloud-peers-gateway.py), whose alphabet includes '_' and '-'. So only
# ^[A-Za-z0-9._~+/=-]{8,}$ passes; anything else (Unicode spaces, homoglyphs,
# control chars, quotes) fails closed. Checked in a subshell under LC_ALL=C,
# with the classes spelled out instead of ranges, so no locale can widen them.
( LC_ALL=C
  re='^[ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~+/=-]{8,}$'
  [[ "$C5_PEER_TOKEN" =~ $re ]] ) || exit 0
# take_lock FD SECONDS: exclusive flock on the open file behind FD (python3, so
# no util-linux flock is needed). The lock lives on the open file description,
# so a child that inherits FD keeps holding it after this process exits.
take_lock() {
  python3 -I -c 'import fcntl, sys, time
fd, end = int(sys.argv[1]), time.time() + float(sys.argv[2])
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); sys.exit(0)
    except OSError:
        if time.time() >= end: sys.exit(1)
        time.sleep(0.05)' "$1" "$2" 2>/dev/null
}

# gw_curl ARGS...: curl to the gateway with the Bearer header and the proxy
# set-up above; prints the response body, a newline, then the HTTP code.
gw_curl() {
  local -a proxy
  if [[ -n "${C5_PEER_PROXY:-}" ]]; then proxy=(-x "$C5_PEER_PROXY"); else proxy=(--socks5-hostname "${C5_PEER_SOCKS:-localhost:1055}"); fi
  if [[ "${C5_CLOUD_ASK_DIRECT:-}" == 1 ]]; then
    # The direct (no-proxy) path exists for the test harness only.
    if [[ "${C5_CLOUD_ASK_TEST:-}" == 1 ]]; then proxy=(); else note direct-refused-using-proxy; fi
  fi
  env -u no_proxy -u NO_PROXY -u http_proxy -u HTTP_PROXY \
    -u https_proxy -u HTTPS_PROXY -u all_proxy -u ALL_PROXY \
    curl -sS -w '\n%{http_code}' --max-time 20 ${proxy[@]+"${proxy[@]}"} \
    -H @<(printf 'Authorization: Bearer %s\n' "${C5_PEER_TOKEN:-}") "$@" 2>/dev/null
}
note() { printf '%s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${C5_CLOUD_ASK_STATE:-?}" "${C5_CLOUD_ASK_ID:-?}" "$1" >"$LOG" 2>/dev/null; }

if [[ "$MODE" == __send ]]; then
  # Detached child: C5_CLOUD_ASK_BODY, C5_CLOUD_ASK_ID, C5_CLOUD_ASK_PEER from the parent.
  fail() { note "$1"; exit 0; }
  LOCK="$ASK_DIR/${C5_CLOUD_ASK_ID:-x}.lock"
  if [[ "${C5_CLOUD_ASK_STATE:-}" == done ]]; then
    # The gateway applies lines in arrival order: wait for the ask's post (it
    # holds this lock, taken before the ask hook returned) so open lands first.
    { exec 9>>"$LOCK"; } 2>/dev/null && { take_lock 9 40 || note lock-timeout-posting-anyway; }
    # Lock files are never deleted here or in the ask path: a quickly repeated
    # identical command reuses this id, and its newer ask child may already hold
    # (or be about to take) this same file. Deleting it would let a later done
    # lock a fresh inode and overtake that ask. The ask path's 30-min age sweep
    # removes old lock files; every taker touches the file first, so a lock in
    # use is never older than 30 min.
    touch "$LOCK" 2>/dev/null
  fi
  # fd 9 closed for c5-peer: a tailscaled it starts must not inherit the lock.
  "${C5_CLOUD_ASK_PEER:-c5-peer}" ensure >/dev/null 2>&1 9>&- || fail ensure-failed
  URL="${C5_PEER_URL:-http://100.109.108.90:7898}"
  code="$(printf '%s' "${C5_CLOUD_ASK_BODY:-}" | gw_curl -o /dev/null -X POST "$URL/ask" \
    -H 'Content-Type: application/json' --data-binary @-)"
  code="${code##*$'\n'}"
  [[ "$code" == 200 ]] || fail "http-${code:-000}"
  exit 0
fi

case "$MODE" in ask) STATE=open ;; done) STATE=done ;; *) exit 0 ;; esac
PEER="$(command -v c5-peer 2>/dev/null)" || exit 0
command -v python3 >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0
# PostToolUse fires for every tool: without a recent open ask in this VM there is
# nothing to close. Markers older than 30 min (asks that were denied, so no done
# came) do not count; T3 already hides those cards.
if [[ "$STATE" == done && -z "$(find "$ASK_DIR" -mindepth 1 -maxdepth 1 -type d -mmin -30 -print -quit 2>/dev/null)" ]]; then
  exit 0
fi

IFS= read -r -d '' PY <<'PY'
import hashlib, json, os, re, sys
state = sys.argv[1]
try:
    data = json.loads(sys.stdin.read())
except Exception:
    sys.exit(1)
if not isinstance(data, dict):
    sys.exit(1)
tool = data.get("tool_name")
if not isinstance(tool, str) or not tool:
    sys.exit(1)
ti = data.get("tool_input")
if ti is None:
    ti = {}
sid = data.get("session_id")
sid = sid if isinstance(sid, str) else ""
canon = json.dumps(ti, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
aid = hashlib.sha256((sid + "\n" + tool + "\n" + canon).encode("utf-8")).hexdigest()[:16]

def text(v):
    return v if isinstance(v, str) else ("" if v is None else json.dumps(v, ensure_ascii=False))

d = ti if isinstance(ti, dict) else {}
if tool == "Bash":
    cmd = text(d.get("command"))
elif tool in ("Edit", "Write", "Read", "MultiEdit", "NotebookEdit"):
    cmd = tool + " " + text(d.get("file_path") or d.get("notebook_path"))
elif tool == "WebFetch":
    cmd = "WebFetch " + text(d.get("url"))
else:
    cmd = json.dumps(ti, separators=(",", ":"), ensure_ascii=False)
cmd = re.sub(r"[\x00-\x1f\x7f\s]+", " ", cmd).strip()
R = "[redacted]"
# The lane token's exact value never reaches a card (it travels only in the
# Authorization header). Replaced before the patterns, so no pattern can split it.
TOK = os.environ.get("C5_PEER_TOKEN", "")
def untoken(v):
    return v.replace(TOK, R) if len(TOK) >= 8 else v
cmd = untoken(cmd)
tool = untoken(tool)
sid_card = untoken(sid)
SUBS = [
    (r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}", r"\1 " + R),
    (r"(?i)(://)[^/\s:@]+:[^/\s@]+@", r"\1" + R + "@"),
    (r"""(?i)\b((?:x-[a-z0-9-]*(?:key|token|secret|auth)[a-z0-9-]*|authorization|proxy-authorization)\s*:\s*)(?:(?:bearer|basic|token|digest)\s+)?[^\s'"]+""", r"\1" + R),
    (r"""(?<!\S)(-u|--user)(=|\s+)?([^\s:'"]+):([^\s'"]+)""", r"\1\2\3:" + R),
    (r"""(?i)(?<!\S)(--?(?:password|passwd|pass|token|secret|api-?key|access-?token)(?:=|\s+))("[^"]*"|'[^']*'|[^\s"']+)""", r"\1" + R),
    (r"""(?<!\S)-p([^\s'"-][^\s'"]{3,}|'[^']*'|"[^"]*")""", "-p" + R),
    (r"\bsk-[A-Za-z0-9_-]{8,}", R),
    (r"\bgh[pousr]_[A-Za-z0-9]{10,}", R),
    (r"\bgithub_pat_[A-Za-z0-9_]{10,}", R),
    (r"\bxox[bap]-[A-Za-z0-9-]{8,}", R),
    (r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b", R),
    (r'(?i)("[^"]*(?:key|token|secret|password|passwd)[^"]*"\s*:\s*)"[^"]*"', r'\1"' + R + '"'),
    (r"""(?i)\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|[^\s"']+)""", r"\1" + R),
]
for pat, rep in SUBS:
    cmd = re.sub(pat, rep, cmd)
full = len(cmd) <= 500
cmd = cmd[:500]
if state == "done":
    cmd = ""
session = re.sub(r"[^A-Za-z0-9_-]", "", sid_card)
if len(TOK) >= 8:  # filtering can join a split token back together
    session = session.replace(TOK, "redacted")
session = session[:128]
body = json.dumps({"id": aid, "state": state, "tool": tool[:64], "command": cmd, "session": session},
                  ensure_ascii=False, separators=(",", ":"))
print(aid if full else aid + " cut")
print(body)
PY

OUT="$(python3 -I -c "$PY" "$STATE" 2>/dev/null)" || exit 0
ID="${OUT%%$'\n'*}"
BODY="${OUT#*$'\n'}"
CUT=""
[[ "$ID" == *" cut" ]] && { ID="${ID% cut}"; CUT=1; }
[[ "$ID" =~ ^[0-9a-f]{16}$ && -n "$BODY" && "$BODY" != "$OUT" ]] || exit 0

if [[ "$STATE" == open ]]; then
  # Sweep markers and lock files older than 30 min (denied asks get no done).
  find "$ASK_DIR" -mindepth 1 -maxdepth 1 -mmin +30 -exec rm -rf {} + 2>/dev/null
  mkdir -p "$ASK_DIR/$ID" 2>/dev/null && touch "$ASK_DIR/$ID" "$ASK_DIR/$ID.lock" 2>/dev/null || exit 0
  # Per-id lock held by the detached ask child (inherited fd 9) for its whole
  # post; the done child waits on it. Waits at most 0.5 s here.
  { exec 9>>"$ASK_DIR/$ID.lock"; } 2>/dev/null && take_lock 9 0.5
else
  rmdir "$ASK_DIR/$ID" 2>/dev/null || exit 0
fi

export C5_CLOUD_ASK_BODY="$BODY" C5_CLOUD_ASK_ID="$ID" C5_CLOUD_ASK_PEER="$PEER" C5_CLOUD_ASK_STATE="$STATE"
SELF="${BASH_SOURCE[0]}"
if command -v setsid >/dev/null 2>&1; then
  setsid bash "$SELF" __send </dev/null >/dev/null 2>&1 &
else
  nohup bash "$SELF" __send </dev/null >/dev/null 2>&1 &
fi

# --- Step 2: wait for the operator's answer from T3 (ask mode only) ---------
[[ "$STATE" == open ]] || exit 0
WAIT="${C5_CLOUD_ASK_WAIT:-300}"; [[ "$WAIT" =~ ^[0-9]{1,3}$ ]] || WAIT=300
POLL="${C5_CLOUD_ASK_POLL:-3}"; [[ "$POLL" =~ ^([1-9]|10)$ ]] || POLL=3
(( WAIT > 0 )) || exit 0
# A card cut at 500 characters hides the tail of the request: never answer it from T3.
[[ -z "$CUT" ]] || exit 0
# Let the detached child finish its post first: it holds the per-id lock for
# the whole post, so taking that lock on a fresh descriptor means open has
# landed (or failed). This hook's own copy of fd 9 is closed first.
exec 9>&-
{ exec 8>>"$ASK_DIR/$ID.lock"; } 2>/dev/null && take_lock 8 40
exec 8>&-
URL="${C5_PEER_URL:-http://100.109.108.90:7898}"
end=$((SECONDS + WAIT))
while (( SECONDS < end )); do
  # The marker goes when done is posted: the tool ran, so it was answered elsewhere.
  [[ -d "$ASK_DIR/$ID" ]] || exit 0
  resp="$(gw_curl "$URL/decision?id=$ID")"
  code="${resp##*$'\n'}"
  case "$code" in
    200)
      dec="$(printf '%s' "${resp%$'\n'*}" | python3 -I -c 'import json, sys
try:
    d = json.loads(sys.stdin.read()).get("decision")
except Exception:
    d = None
print(d if d in ("allow", "deny") else "")' 2>/dev/null)"
      if [[ "$dec" == allow ]]; then
        printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
      elif [[ "$dec" == deny ]]; then
        printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"The operator denied this from T3."}}}'
        exit 0
      fi ;;
    000|429|5??) ;;          # gateway unreachable or busy: keep waiting
    *) note "wait-http-$code"; exit 0 ;;   # 401/404/...: nothing to wait for
  esac
  sleep "$POLL"
done
exit 0
