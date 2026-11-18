#!/bin/bash
# relay_heartbeat.sh — the relay's heartbeat step (SP-266), sourced by
# scripts/run_relay.sh and by its test (scripts/lib/relayHeartbeat.test.mjs).
#
#   run_relay_heartbeat <repo> <limit-seconds> [--dry-run] [--no-bus]
#
# Runs `node <repo>/scripts/heartbeat.mjs --check` (is each of the project's
# lanes still running? a quiet one is said on the bus, at most once every 6
# hours per lane) under a time limit. A dry run asks only and posts nothing.
# So does a project with no bus (--no-bus, SP-386): with nowhere to post,
# --check would only exit 2 and read as a failure on every pass, so the
# heartbeat lists the lanes in the log, the same as a dry run.
#
# It NEVER fails the relay: whatever the heartbeat does, this returns 0, and a
# failure is one line naming the heartbeat and its exit code, so the relay
# pass carries on to its END line with its own verdict unchanged.
run_relay_heartbeat() {
  local repo="$1" limit="$2" dry="" args=(--check) status flag
  shift 2
  for flag in "$@"; do
    case "$flag" in --dry-run|--no-bus) dry=yes ;; esac
  done
  [ -n "$dry" ] && args=()
  # A project's own copy of the runners (the setup wizard's, until its lanes
  # run from Spirality's folder) may not carry the heartbeat yet: one line, no
  # failure.
  if [ ! -f "$repo/scripts/heartbeat.mjs" ]; then
    echo "heartbeat: not in this checkout (no scripts/heartbeat.mjs), so no lane is watched"
    return 0
  fi
  "$repo/scripts/run_with_time_limit.sh" "$limit" -- node "$repo/scripts/heartbeat.mjs" "${args[@]+"${args[@]}"}"
  status=$?
  # Without --check, exit 3 only means a lane is quiet: the lines above say so.
  if [ "$status" -ne 0 ] && { [ -z "$dry" ] || [ "$status" -ne 3 ]; }; then
    echo "[relay] the heartbeat check FAILED (exit $status; its lines above say why). The relay pass carries on and its verdict is unchanged."
  fi
  return 0
}
