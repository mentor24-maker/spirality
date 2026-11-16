#!/bin/bash
# relay_pr_files.sh — the relay's changed-files step (SP-349), sourced by
# scripts/run_relay.sh and by its test (scripts/lib/relayPrFiles.test.mjs).
#
#   run_relay_pr_files <repo> <limit-seconds> [--dry-run]
#
# Runs `npm run clickup -- pr-files-refresh` from <repo> under its own time
# limit: each open pull request whose branch moved since its files were read
# is read again, and one that merged or closed is forgotten, so the tracker's
# record of which files each open pull request changes stays current. A dry
# run passes --dry-run too: it reads and prints only.
#
# It NEVER fails the relay: whatever the refresh does, this returns 0. A
# failure is one line naming the step and its exit code, so the relay pass
# carries on to its END line with its own verdict unchanged, and the next
# pass tries again.
run_relay_pr_files() {
  local repo="$1" limit="$2" dry="${3:-}" status
  local args=(pr-files-refresh)
  [ "$dry" = "--dry-run" ] && args+=(--dry-run)
  (cd "$repo" && "$repo/scripts/run_with_time_limit.sh" "$limit" -- npm run --silent clickup -- "${args[@]}")
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "[relay] pr-files-refresh FAILED (exit $status; its lines above say why). The relay pass carries on and its verdict is unchanged; the next pass tries again."
  fi
  return 0
}
