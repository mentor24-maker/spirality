#!/bin/bash
# relay_watchdogs.sh — the relay's ticket watchdogs (SP-267), sourced by
# scripts/run_relay.sh and by its test (scripts/lib/relayWatchdogs.test.mjs).
#
#   run_relay_watchdogs <repo> <limit-seconds> [--dry-run]
#
# Runs, each under its own time limit, one after the other:
#   node <repo>/scripts/stale_ready.mjs --check    a ticket stuck in Ready to launch
#   node <repo>/scripts/stale_answer.mjs --check   an answer in Needs your input nothing acted on
#   node <repo>/scripts/reconcile.mjs --check      an open ticket whose pull request GitHub merged or closed (SP-354)
# Each reads the tickets through the door and says what it finds on the bus,
# once per ticket per reason every 6 hours. A dry run passes --dry-run too:
# each reads and prints what it would post, and writes nothing.
#
# It NEVER fails the relay: whatever the watchdogs do, this returns 0. A
# failure is one line naming the watchdog and its exit code, so the relay
# pass carries on to its END line with its own verdict unchanged.
run_relay_watchdogs() {
  local repo="$1" limit="$2" dry="${3:-}" name file status
  local args=(--check)
  [ "$dry" = "--dry-run" ] && args+=(--dry-run)
  for name in stale-ready stale-answer reconcile; do
    file="$repo/scripts/${name//-/_}.mjs"
    # A project's own copy of the runners (the setup wizard's, until its
    # lanes run from Spirality's folder) may not carry the watchdog yet: one
    # line, no failure.
    if [ ! -f "$file" ]; then
      echo "$name: not in this checkout (no scripts/${name//-/_}.mjs), so nothing is watched"
      continue
    fi
    "$repo/scripts/run_with_time_limit.sh" "$limit" -- node "$file" "${args[@]}"
    status=$?
    if [ "$status" -ne 0 ]; then
      echo "[relay] the $name check FAILED (exit $status; its lines above say why). The relay pass carries on and its verdict is unchanged."
    fi
  done
  return 0
}
