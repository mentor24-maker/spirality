#!/bin/bash
#
# What the relay schedule actually runs: bring the main checkout up to date,
# then one `relay` pass of the door (`npm run clickup`, which talks to the
# tracker the project config names), then one pass of the project's
# application checks (`npm run app-checks`, SP-274).
#
#   ./scripts/run_relay.sh            # one pass, output to stdout
#   ./scripts/run_relay.sh --dry-run  # one pass that prints and writes nothing
#   ./scripts/run_relay.sh --tick     # what launchd runs every minute: a pass
#                                     # only when the relay's wake time is up
#
# The relay's wake time is set on the tracker's Settings page (SP-236), so
# launchd starts this every RELAY_TICK seconds (scripts/lib/loopSchedule.mjs)
# with --tick, and a tick runs a pass only when that wake time has passed
# since the last real start, or a wake was sent (scripts/lib/wakeLane.mjs).
# Every other tick ends at once, before the lock, the pull and Doppler, and
# writes nothing to the log. A run without --tick (by hand) always runs.
#
# Same shape as StarCaster's scripts/run_bus_relay.sh with the StarCaster-only
# watchdogs left out. The pull is deliberately timid — only main, only a clean
# tree, only fast-forward — and never blocks the pass: a refusal is logged and
# the relay runs on the code that is here. It takes the same sync lock the loop
# runners take around their own pull, so two lanes never pull into one
# checkout at once.
#
# Every project-specific value (the log folder, the project's short name)
# comes from the project config through scripts/project_config.mjs; nothing
# here names a project.

set -u

# launchd hands the job almost no environment. Set the PATH once, here.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

# The repo is WHERE THIS SCRIPT LIVES, and it must be the MAIN checkout: a
# worktree is deleted when its work ships, and a schedule pointing at one
# works perfectly until the day it silently does not.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$REPO/.git" ] && grep -q '^gitdir:.*worktrees' "$REPO/.git" 2>/dev/null; then
  echo "[relay] Refusing to run from a worktree ($REPO) — worktrees are deleted when their work ships." >&2
  exit 1
fi
cd "$REPO" || exit 1

SLUG="$(node "$REPO/scripts/project_config.mjs" projectSlug)" || { echo "[relay] could not read projectSlug from the project config" >&2; exit 1; }
LOG_DIR="$(node "$REPO/scripts/project_config.mjs" logDir)" || { echo "[relay] could not read logDir from the project config" >&2; exit 1; }
PREFIX="$(node "$REPO/scripts/project_config.mjs" launchdPrefix)" || { echo "[relay] could not read launchdPrefix from the project config" >&2; exit 1; }
# Empty when the project runs no tracker: the restart step then does nothing.
TRACKER_PORT="$(node "$REPO/scripts/project_config.mjs" trackerPort)" || { echo "[relay] could not read trackerPort from the project config" >&2; exit 1; }
mkdir -p "$LOG_DIR"
LOCK="$LOG_DIR/$SLUG-relay.lock"
SYNC_LOCK="$LOG_DIR/$SLUG-sync.lock"
# After the relay part, one application-checks pass (SP-274).
# shellcheck source=lib/relay_app_checks.sh
source "$REPO/scripts/lib/relay_app_checks.sh"
# A pass is time-limited so a stuck one cannot hold the relay for good; two
# passes never overlap, whatever the wake time, because the second finds the
# lock held.
PASS_LIMIT="${RELAY_PASS_LIMIT_SECONDS:-480}"
# The application checks' share of it (SP-274), set aside only when the
# manifest lists a check: a project that lists none keeps the whole limit for
# the relay part, as before SP-274.
CHECKS_SHARE="${RELAY_APP_CHECKS_LIMIT_SECONDS:-180}"
if ! relay_limits_usable "$PASS_LIMIT" "$CHECKS_SHARE"; then
  echo "[relay] the time limits are not usable (pass ${PASS_LIMIT}s, application checks ${CHECKS_SHARE}s): both whole seconds, the checks' share at least 1 and less than the pass's." >&2
  exit 2
fi

# The tick (SP-236). Three small files beside the lock, named like it:
#   <slug>-relay.last-start  when the last real pass started (seconds since 1970)
#   <slug>-relay.interval    the wake time the last ticked pass read from the
#                            tracker; the default from loopSchedule.mjs until then
#   <slug>-relay.wake        a wake sent by wakeLane.mjs: run this tick
# A tick counts as due within half a tick of the wake time, so a pass due at
# 600s is not pushed to 660s by a second's jitter in launchd's start. A
# missing or unreadable start time, or one in the future, is due.
LAST_START_FILE="$LOG_DIR/$SLUG-relay.last-start"
INTERVAL_FILE="$LOG_DIR/$SLUG-relay.interval"
WAKE_FILE="$LOG_DIR/$SLUG-relay.wake"
TICKED=""
if [ "${1:-}" = "--tick" ]; then
  shift
  TICKED=yes
  if [ ! -e "$WAKE_FILE" ]; then
    LAST="$(cat "$LAST_START_FILE" 2>/dev/null || true)"
    EVERY="$(cat "$INTERVAL_FILE" 2>/dev/null || true)"
    case "$EVERY" in ""|*[!0-9]*) EVERY="$(node "$REPO/scripts/lib/loopSchedule.mjs" interval relay 2>/dev/null)" ;; esac
    TICK="$(node "$REPO/scripts/lib/loopSchedule.mjs" tick 2>/dev/null)"
    NOW="$(date +%s)"
    # Any of these not a number (a schedule that could not be read) is due:
    # a pass that runs too often is seen, a relay that never runs is not.
    case "$LAST$EVERY$TICK" in
      *[!0-9]*) ;;
      *) if [ -n "$LAST" ] && [ -n "$EVERY" ] && [ -n "$TICK" ] && [ "$NOW" -ge "$LAST" ] && [ $((NOW - LAST)) -lt $((EVERY - TICK / 2)) ]; then exit 0; fi ;;
    esac
  fi
fi
DRY_RUN=""
for a in "$@"; do [ "$a" = "--dry-run" ] && DRY_RUN=yes; done

# Paused? (SP-237) The Settings page's switches, the whole pipeline and the
# relay, asked before the START line and the lock, so a paused relay touches nothing
# and the Pipeline Status pod never reads a pass that did not run. ANY
# non-zero exit counts as paused, a check that could not run included (it
# fails safe); a paused pass is not a failed one, so it exits 0 and writes no
# END line.
# The check signs in as the relay, as the pass below does.
export TRACKER_TOKEN_NAME=TRACKER_TOKEN_RELAY
PAUSE_LINE="$("$REPO/scripts/pause_check.sh" relay)"
PAUSE_CODE=$?
if [ "$PAUSE_CODE" -ne 0 ]; then
  [ -n "$PAUSE_LINE" ] || PAUSE_LINE="could not read the pipeline settings (the check exited $PAUSE_CODE and said nothing; its errors are above), so the relay pass is treated as PAUSED and not starting (it fails safe)"
  echo "[relay] $(date '+%Y-%m-%d %H:%M:%S') $PAUSE_LINE"
  exit 0
fi

echo ""
echo "===== $(date '+%Y-%m-%d %H:%M:%S') START relay — $REPO ====="

# One relay at a time. launchd never overlaps the same job, but a pass run by
# hand during a scheduled one would; a stale lock (its pid gone) is announced
# and taken over so a crash never leaves the relay dead behind it.
if ! mkdir "$LOCK" 2>/dev/null; then
  OLD_PID="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[relay] a relay pass is already running (pid $OLD_PID, lock: $LOCK). Not starting a second."
    exit 0
  fi
  echo "[relay] found a STALE lock (pid ${OLD_PID:-unrecorded}, no such process) — clearing it and taking over."
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || { echo "[relay] the lock could not be retaken. Stopping." >&2; exit 1; }
fi
echo "$$" > "$LOCK/pid"
# A real start: the next tick counts from here, and any wake sent before now
# is answered by this pass. A dry run writes nothing, these included.
if [ -z "$DRY_RUN" ]; then
  date +%s > "$LAST_START_FILE"
  rm -f "$WAKE_FILE"
fi
trap 'rm -rf "$LOCK" 2>/dev/null; [ "$(cat "$SYNC_LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$SYNC_LOCK"' EXIT

# The timid pull, under the loops' sync lock. Wait up to two minutes for the
# other lane; a lock whose pid is gone is cleared.
take_sync_lock() {
  local waited=0 holder
  until mkdir "$SYNC_LOCK" 2>/dev/null; do
    holder="$(cat "$SYNC_LOCK/pid" 2>/dev/null || true)"
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$SYNC_LOCK"; continue; fi
    [ "$waited" -ge 120 ] && return 1
    sleep 5; waited=$((waited + 5))
  done
  echo "$$" > "$SYNC_LOCK/pid"
}
# A checkout left on a branch that has merged and gone from origin (a new
# project's lanes run from its setup branch until it merges) goes back to main
# first, under the same lock, so the pull below can run.
# shellcheck source=lib/back_to_main.sh
source "$REPO/scripts/lib/back_to_main.sh"
# A pull that changes a file the tracker server loads restarts it, so it runs the new code (SP-150).
# shellcheck source=lib/tracker_restart.sh
source "$REPO/scripts/lib/tracker_restart.sh"
# Where main was before this pass synced: noted before the back-to-main step,
# which can fast-forward main itself (SP-150).
BEFORE="$(git rev-parse HEAD 2>/dev/null)"
if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" != "main" ] && [ -z "$(git status --porcelain)" ]; then
  if take_sync_lock; then
    MOVED="$(back_to_main_if_merged)"
    [ -n "$MOVED" ] && echo "[relay] $MOVED"
    rm -rf "$SYNC_LOCK"
  fi
fi
if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "main" ] && [ -z "$(git status --porcelain)" ]; then
  if take_sync_lock; then
    git pull -q --ff-only origin main 2>&1 || echo "[relay] pull of main refused (see above) — running on the checkout as it is"
    # The loop lanes run npm ci on every pull; the relay only when the pull
    # changed the package files, so a restart below lands on the new
    # dependencies, not the old node_modules (SP-150).
    if [ -n "$BEFORE" ] && ! git diff --quiet "$BEFORE" HEAD -- package.json package-lock.json 2>/dev/null; then
      npm ci --silent 2>&1 || echo "[relay] npm ci failed — the tracker restart below runs with the node_modules already present"
    fi
    RESTARTED="$(restart_tracker_if_changed "$BEFORE" "$(git rev-parse HEAD 2>/dev/null)" "$PREFIX" "$TRACKER_PORT")"
    [ -n "$RESTARTED" ] && echo "[relay] $RESTARTED"
    rm -rf "$SYNC_LOCK"
  else
    echo "[relay] another lane held the sync lock for two minutes — not pulling this pass"
  fi
else
  echo "[relay] main checkout is not on a clean main — not pulling. Every pass runs stale code until it is put back on main."
fi

# The pass itself. Through npm, so Doppler supplies the token the same way
# every other write to the tracker gets it. A dry run is passed straight through.
# On the tracker, the relay signs in as itself: TRACKER_TOKEN_NAME names its
# own Doppler secret (never the value), which the door reads.
export TRACKER_TOKEN_NAME=TRACKER_TOKEN_RELAY
# How many checks the manifest lists, read after the pull so it is this
# pass's manifest: "none", a number, or "unknown" when it cannot be read here.
# Unknown sets the share aside too, so the check step still gets its time and
# says what it found.
CHECKS_LISTED="$(relay_app_checks_listed "$REPO")"
if [ "$CHECKS_LISTED" = "none" ]; then RELAY_LIMIT="$PASS_LIMIT"; else RELAY_LIMIT=$((PASS_LIMIT - CHECKS_SHARE)); fi
PASS_START=$(date +%s)
"$REPO/scripts/run_with_time_limit.sh" "$RELAY_LIMIT" -- \
  npm run --silent clickup -- relay "$@"
status=$?

# The wake time for the next tick to go by, read from the tracker after a
# ticked pass (a run by hand leaves it as it is, so the Settings page never
# reads a value from a relay launchd is not yet ticking). A read that fails
# keeps the last good one and says so in one line.
if [ -n "$TICKED" ] && [ -z "$DRY_RUN" ]; then
  SAID="$(node "$REPO/scripts/lib/wakeSetting.mjs" relay 2>/dev/null)"
  SAID_CODE=$?
  case "$SAID" in
    ""|*[!0-9]*) SAID_OK="" ;;
    *) SAID_OK="$([ "$SAID_CODE" -eq 0 ] && [ "$SAID" -ge 60 ] && echo yes)" ;;
  esac
  if [ -n "$SAID_OK" ]; then
    echo "$SAID" > "$INTERVAL_FILE"
  else
    echo "[relay] could not read the relay's wake time from the tracker (${SAID:-no answer}) — keeping the last good value, $(cat "$INTERVAL_FILE" 2>/dev/null || node "$REPO/scripts/lib/loopSchedule.mjs" interval relay)s"
  fi
fi

# Then the project's application checks (SP-274), signed in as the relay too,
# with what is left of the pass's time. It runs whatever the relay part did,
# and nothing it does can undo that part: the merges and hand-backs are done.
CHECK_ARGS=()
for arg in "$@"; do [ "$arg" = "--dry-run" ] && CHECK_ARGS+=(--dry-run); done
CHECKS_LIMIT=0
if [ "$CHECKS_LISTED" = "none" ]; then
  # Nothing to run, so nothing is started: the relay part may have used the
  # whole limit, and "none listed" is a clean pass, not a skipped one.
  echo "app-checks: none listed"
  checks_status=0
else
  CHECKS_LIMIT="$(relay_app_checks_budget "$PASS_LIMIT" "$CHECKS_SHARE" $(( $(date +%s) - PASS_START )))"
  run_relay_app_checks "$CHECKS_LIMIT" ${CHECK_ARGS[@]+"${CHECK_ARGS[@]}"}
  checks_status=$?
fi

# The exit code is the pass's own verdict, and the END line says it in words,
# the relay part's first, then the checks':
#   0   both finished and every write read back
#   1   at least one step failed and said which (read the UNCHECKED and
#       FAILED lines above); the relay part's own work stands
#   124 the relay part hit its time limit and was stopped
echo "===== $(date '+%Y-%m-%d %H:%M:%S') END relay — $(relay_end_words "$status" "$checks_status" "$RELAY_LIMIT" "$CHECKS_LIMIT") ====="
exit "$(relay_pass_exit "$status" "$checks_status")"
