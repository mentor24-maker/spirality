#!/bin/bash
# lane_failure.sh — the lane runner's failed-pass report (SP-268), sourced by
# scripts/loop_runner.sh and by its test (scripts/watchdogScripts.test.mjs).
#
#   report_lane_pass <repo> <stamp-file> <lane> <exit-code> <log>
#
# After every pass. A pass that exited non-zero runs
# `node <repo>/scripts/report_job_failure.mjs --job <lane> --status <code> --log <log>`
# under a short time limit: one ALARM on the project's bus naming the lane and
# its exit, at most once every 6 hours per lane. A pass that exited 0 clears
# that reminder (<stamp-file>, lib/watchdogPosts.js failureStampFile), so the
# next failure is said at once.
#
# It NEVER changes the runner's exit, the pass's code or the next pass: it
# always returns 0, and a report that did not land is one line saying so.
report_lane_pass() {
  local repo="$1" stamp="$2" lane="$3" code="$4" log="$5" status
  if [ "$code" = "0" ]; then
    rm -f "$stamp" 2>/dev/null
    return 0
  fi
  # A project's own copy of the runners (the setup wizard's, until its lanes
  # run from Spirality's folder) may not carry the reporter yet.
  if [ ! -f "$repo/scripts/report_job_failure.mjs" ]; then
    echo "[loop-runner] $(date "+%H:%M:%S") /$lane exited $code; no failed-pass report in this checkout (no scripts/report_job_failure.mjs), so the bus is not told"
    return 0
  fi
  RUN_WITH_TIME_LIMIT_POLL=1 RUN_WITH_TIME_LIMIT_GRACE=5 \
    "$repo/scripts/run_with_time_limit.sh" "${LANE_FAILURE_LIMIT_SECONDS:-90}" -- \
    node "$repo/scripts/report_job_failure.mjs" --job "$lane" --status "$code" --log "$log"
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "[loop-runner] $(date "+%H:%M:%S") the failed-pass report for /$lane did NOT reach the bus (exit $status; its line above says why). The runner carries on."
  fi
  return 0
}
