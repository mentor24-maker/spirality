#!/bin/bash
# relay_watchdogs.sh — the relay's ticket watchdogs (SP-267), sourced by
# scripts/run_relay.sh and by its test (scripts/lib/relayWatchdogs.test.mjs).
#
#   run_relay_watchdogs <repo> <limit-seconds> [--dry-run] [--no-bus]
#   relay_bus_state <repo>          prints yes, no or unknown (SP-386)
#
# Runs, each under its own time limit, one after the other:
#   node <repo>/scripts/stale_ready.mjs --check    a ticket stuck in Ready to launch
#   node <repo>/scripts/stale_answer.mjs --check   an answer in Needs your input nothing acted on
#   node <repo>/scripts/reconcile.mjs --check      an open ticket whose pull request GitHub merged or closed (SP-354)
# Each reads the tickets through the door and says what it finds on the bus,
# once per ticket per reason every 6 hours. A dry run passes --dry-run too:
# each reads and prints what it would post, and writes nothing.
#
# A project with no bus (no busProject in its project config, the setup's
# "no" to having one) gives these three nowhere to post, so each would only
# say so and exit 2, which read as three FAILED lines on every pass (SP-386).
# With --no-bus none of them runs and nothing is printed here: the relay says
# once per pass that the bus watchdogs were skipped (relay_no_bus_line).
#
# It NEVER fails the relay: whatever the watchdogs do, this returns 0. A
# failure is one line naming the watchdog and its exit code, so the relay
# pass carries on to its END line with its own verdict unchanged.
run_relay_watchdogs() {
  local repo="$1" limit="$2" dry="" nobus="" flag name file status
  shift 2
  for flag in "$@"; do
    case "$flag" in
      --dry-run) dry=yes ;;
      --no-bus) nobus=yes ;;
    esac
  done
  [ -n "$nobus" ] && return 0
  local args=(--check)
  [ -n "$dry" ] && args+=(--dry-run)
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

# Has this project a bus? Asked once per relay pass, of the same config reader
# the watchdogs use (run from the project's checkout, SPIRALITY_PROJECT set as
# for them). "no" only for a config that reads and names no busProject; a
# config that cannot be read, or a reader that does not know the key, is
# "unknown", and the watchdogs then run exactly as before, so a wrong answer
# here can never silence a project that has a bus.
relay_bus_state() {
  local repo="$1" bus
  bus="$(node "$repo/scripts/project_config.mjs" busProject 2>/dev/null)" || { echo unknown; return 0; }
  if [ -n "$bus" ]; then echo yes; else echo no; fi
  return 0
}

# The one line a pass on a project with no bus says in place of the
# watchdogs' failures (SP-386).
relay_no_bus_line() {
  echo "[relay] bus watchdogs skipped: ${1:-this project} has no bus (no busProject in its project config), so the heartbeat, stale-ready, stale-answer, reconcile, throughput and checkout-currency checks post nothing. This is expected, not a failure; the heartbeat, throughput and checkout-currency readings still print here."
}
