#!/bin/bash
# Run a command with a hard time limit. Exit 124 if it was stopped.
#
#   run_with_time_limit.sh <seconds> -- <command...>
#
# A pass that freezes would otherwise hold its lane forever (StarCaster,
# 2026-09-12: one sat idle for eleven hours and nothing was built overnight).
# macOS ships no `timeout`, so this is the portable version.
set -u
LIMIT=${1:?usage: run_with_time_limit.sh <seconds> -- <command...>}
shift
[ "$1" = "--" ] && shift
[ $# -gt 0 ] || { echo "run_with_time_limit: no command given" >&2; exit 2; }
if ! [[ "$LIMIT" =~ ^[0-9]+$ ]] || [ "$LIMIT" -lt 1 ]; then
  echo "run_with_time_limit: limit must be a whole number of seconds, got '$LIMIT'" >&2; exit 2
fi
POLL=${RUN_WITH_TIME_LIMIT_POLL:-15}
GRACE=${RUN_WITH_TIME_LIMIT_GRACE:-30}
"$@" &
PID=$!
START=$(date +%s)
# Stop the WHOLE tree, not just direct children: a hung `next build` started
# through Claude's Bash tool is a grandchild or deeper. The tree is listed
# before anything is killed, because a killed parent's children are re-parented
# and could no longer be found by walking down from it.
tree() { local p; for p in $(pgrep -P "$1" 2>/dev/null); do tree "$p"; done; echo "$1"; }
stop() { local pids; pids="$(tree "$PID")"; kill "-$1" $pids 2>/dev/null; }
while kill -0 "$PID" 2>/dev/null; do
  if [ $(( $(date +%s) - START )) -ge "$LIMIT" ]; then
    echo "[run_with_time_limit] $(date "+%Y-%m-%d %H:%M:%S") stopped after ${LIMIT}s — still running at the limit, which a working pass never reaches: $*"
    stop TERM
    WAITED=0
    while kill -0 "$PID" 2>/dev/null && [ "$WAITED" -lt "$GRACE" ]; do sleep 1; WAITED=$((WAITED + 1)); done
    if kill -0 "$PID" 2>/dev/null; then echo "[run_with_time_limit] it ignored the stop request for ${GRACE}s — forcing it."; stop KILL; fi
    wait "$PID" 2>/dev/null
    exit 124
  fi
  sleep "$POLL"
done
wait "$PID"
