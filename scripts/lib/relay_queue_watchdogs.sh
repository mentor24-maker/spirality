#!/bin/bash
# relay_queue_watchdogs.sh — the relay's throughput and checkout-currency
# watchdogs (SP-268), sourced by scripts/run_relay.sh and by its test
# (scripts/watchdogScripts.test.mjs).
#
#   run_relay_queue_watchdogs <repo> <limit-seconds> <sha-before-pull> <pull-output-file> [--dry-run] [--no-bus]
#
# Runs, each under its own time limit, one after the other:
#   node <repo>/scripts/loop_throughput.mjs --check
#       is the queue getting shorter? Posts to the bus on STALLED (an ALARM)
#       or UNKNOWN (a reading that could not be taken), at most once every 6
#       hours each; reads the tracker at most once an hour.
#   node <repo>/scripts/checkout_currency.mjs --check --before <sha> [--pull-output <file>]
#       did this pass's pull bring the checkout level with main? An ALARM,
#       naming the files that blocked it, when the machine is left on old
#       code; at most once every 6 hours. It only reports: it never pulls and
#       never repairs (--fix is for a person, by hand).
# A dry run passes --dry-run to both: each reads and prints what it would
# post, and writes nothing.
#
# A project with no bus (--no-bus, SP-386) has nowhere for an alarm to go, so
# a due post could only fail (throughput exit 3, checkout-currency exit 1) and
# read as a FAILED line. There the throughput check runs as a dry run (its
# hourly read limit and its verdict in the log are kept, nothing is posted)
# and the checkout-currency check without --check (it reports the checkout
# here and posts nothing). Any other failure still reads FAILED.
#
# It NEVER fails the relay: whatever the watchdogs do, this returns 0. A
# failure is one line naming the watchdog and its exit code, so the relay
# pass carries on to its END line with its own verdict unchanged.
run_relay_queue_watchdogs() {
  local repo="$1" limit="$2" before="$3" pull_output="$4" dry="" nobus="" flag status
  shift 4
  for flag in "$@"; do
    case "$flag" in
      --dry-run) dry=yes ;;
      --no-bus) nobus=yes ;;
    esac
  done
  local extra=()
  if [ -n "$dry" ] || [ -n "$nobus" ]; then extra+=(--dry-run); fi

  if [ -f "$repo/scripts/loop_throughput.mjs" ]; then
    # Posts on a STALLED verdict (an ALARM) and on an UNKNOWN one (a reading
    # that could not be taken is itself worth saying), never on MOVING or IDLE.
    "$repo/scripts/run_with_time_limit.sh" "$limit" -- node "$repo/scripts/loop_throughput.mjs" --check ${extra[@]+"${extra[@]}"}
    status=$?
    # 0 moving or idle, 1 STALLED, 2 UNKNOWN: verdicts, said in the lines
    # above (and on the bus). Anything else is the check itself failing:
    # 3 a post that did not land, 4 a project config it could not read.
    case "$status" in
      0|1|2) ;;
      *) echo "[relay] the throughput check FAILED (exit $status; its lines above say why). The relay pass carries on and its verdict is unchanged." ;;
    esac
  else
    echo "throughput: not in this checkout (no scripts/loop_throughput.mjs), so the queue is not watched"
  fi

  if [ -f "$repo/scripts/checkout_currency.mjs" ]; then
    local args=(--check) currency_extra=()
    # No bus: a report only, never a post that cannot land.
    if [ -n "$nobus" ]; then args=(); elif [ -n "$dry" ]; then currency_extra+=(--dry-run); fi
    [ -n "$before" ] && args+=(--before "$before")
    [ -n "$pull_output" ] && [ -s "$pull_output" ] && args+=(--pull-output "$pull_output")
    "$repo/scripts/run_with_time_limit.sh" "$limit" -- node "$repo/scripts/checkout_currency.mjs" ${args[@]+"${args[@]}"} ${currency_extra[@]+"${currency_extra[@]}"}
    status=$?
    if [ "$status" -ne 0 ]; then
      echo "[relay] the checkout-currency check FAILED (exit $status; its lines above say why). The relay pass carries on and its verdict is unchanged."
    fi
  else
    echo "checkout:current: not in this checkout (no scripts/checkout_currency.mjs), so whether this machine runs main's code is not watched"
  fi
  return 0
}
