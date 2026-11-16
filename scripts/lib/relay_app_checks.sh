# The relay's application-checks step (SP-274, move 3 in docs/INTEGRATION.md).
# Sourced by scripts/run_relay.sh; names no project, file or folder of its own.
#
# After the relay's own pass, every relay pass (every 10 minutes) runs one
# `npm run app-checks` pass (scripts/app_checks.mjs, SP-264): each check's own
# `everyMinutes` decides whether it actually runs, and only what changed is
# posted to the project's bus. It runs AFTER the relay part, under its own time
# limit, so a check that hangs or crashes can never stop a merge.
#
# The time: the pass has one limit (480 seconds). When the manifest lists no
# check, the relay part keeps all of it and nothing is started. Otherwise the
# relay part gets that limit minus the check step's share; the check step gets
# whatever of the
# limit is left once the relay part ends, never more than its share, less a
# margin for the stop-and-wait at the end, so the two together never outlast
# the pass's limit.

# Seconds the time limit takes, at most, after the limit to stop the step: it
# looks once a second and gives a stopped step five seconds to exit.
RELAY_APP_CHECKS_POLL=1
RELAY_APP_CHECKS_GRACE=5
RELAY_APP_CHECKS_MARGIN=$((RELAY_APP_CHECKS_POLL + RELAY_APP_CHECKS_GRACE + 4))

# relay_app_checks_listed <checkout folder>
# Prints how many application checks the checkout's manifest lists: "none",
# a number, or "unknown" when the manifest or its reader cannot be loaded
# here (the check step then runs and says why). Read with the same reader
# every module uses, lib/projectConfig.mjs, beside this file.
relay_app_checks_listed() {
  local n reader
  reader="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/lib/projectConfig.mjs"
  n="$(cd "$1" && RELAY_CONFIG_READER="$reader" node --input-type=module -e "
    const { loadProjectConfig } = await import(process.env.RELAY_CONFIG_READER);
    console.log((loadProjectConfig().applicationChecks || []).length);
  " 2>/dev/null)" || n=""
  if ! [[ "$n" =~ ^[0-9]+$ ]]; then echo unknown
  elif [ "$n" -eq 0 ]; then echo none
  else echo "$n"; fi
}

# relay_limits_usable <pass limit> <checks share>
# True when both are whole seconds and the share is at least 1 and less than
# the pass limit. A share of 0 is refused here, up front, rather than leaving
# every pass with no time for its checks.
relay_limits_usable() {
  [[ "$1" =~ ^[0-9]+$ && "$2" =~ ^[0-9]+$ ]] && [ "$2" -ge 1 ] && [ "$2" -lt "$1" ]
}

# relay_app_checks_budget <pass limit> <checks share> <seconds the pass has run>
# Prints the seconds the check step may take: what is left of the pass limit,
# less the margin, never more than its share. 0 or less means no time is left.
relay_app_checks_budget() {
  local pass="$1" share="$2" used="$3" left
  left=$((pass - used - RELAY_APP_CHECKS_MARGIN))
  [ "$left" -gt "$share" ] && left="$share"
  echo "$left"
}

# run_relay_app_checks <limit in seconds> [app-checks arguments...]
# Runs one app-checks pass from the current folder under the limit and returns
# its exit code: 0 every needed post landed (or none listed), 1 a step failed
# and said so, 2 the manifest or an argument is not usable, 124 stopped at the
# limit, 125 not run because no time was left. Every line it adds itself
# starts with `app-checks:`, so `--status` finds the newest one.
run_relay_app_checks() {
  local limit="$1"; shift
  if ! [[ "$limit" =~ ^[0-9]+$ ]] || [ "$limit" -lt 1 ]; then
    echo "app-checks: NOT RUN: the relay part used the pass's time, so no time was left for the checks this pass (they run on the next one)."
    return 125
  fi
  # A project carrying a wizard copy of the loop has no app-checks command:
  # its checks are not run from here until its lanes run from Spirality's
  # folder (docs/INTEGRATION.md, move 2). Said, and not a failed step.
  # A package.json that is missing or cannot be read is a broken checkout,
  # never "none listed": it is said, and the step fails.
  local probe
  probe="$(node -e "
    let pkg;
    try { pkg = JSON.parse(require('fs').readFileSync('package.json', 'utf8')); }
    catch (err) { console.log(err.message.split('\\n')[0]); process.exit(2); }
    process.exit(pkg.scripts && pkg.scripts['app-checks'] ? 0 : 1);
  " 2>&1)"
  case "$?" in
    0) ;;
    1) echo "app-checks: none listed (this checkout has no app-checks command)"; return 0 ;;
    *) echo "app-checks: FAILED: this checkout's package.json could not be read ($probe), so the checks did not run."; return 2 ;;
  esac
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  RUN_WITH_TIME_LIMIT_POLL="$RELAY_APP_CHECKS_POLL" RUN_WITH_TIME_LIMIT_GRACE="$RELAY_APP_CHECKS_GRACE" \
    "$here/run_with_time_limit.sh" "$limit" -- npm run --silent app-checks -- "$@"
  local status=$?
  case "$status" in
    0|1) ;;
    124) echo "app-checks: STOPPED: the check pass hit its ${limit}s time limit; checks not finished run again on the next pass." ;;
    *)   echo "app-checks: FAILED: the check pass could not run (exit $status); see the lines above." ;;
  esac
  return "$status"
}

# relay_pass_exit <relay exit> <app-checks exit>
# The pass's one exit code: the relay part's when it failed; else 1 when the
# check step failed, was stopped or could not run; else 0.
relay_pass_exit() {
  if [ "$1" -ne 0 ]; then echo "$1"; elif [ "$2" -ne 0 ]; then echo 1; else echo 0; fi
}

# relay_end_words <relay exit> <app-checks exit> <relay limit> <checks limit>
# The words of the relay log's END line. The first "(exit N)" in them is the
# pass's own exit (tracker/pipeline.mjs and lib/onboardLanes.mjs read it), and
# "pass complete (exit 0)" appears only when both parts finished cleanly.
relay_end_words() {
  local relay="$1" checks="$2" rlimit="$3" climit="$4" exit head part
  exit="$(relay_pass_exit "$relay" "$checks")"
  case "$checks" in
    0)   part="app-checks finished" ;;
    1)   part="app-checks failed and said so above" ;;
    124) part="app-checks hit its ${climit}s time limit and was stopped" ;;
    125) part="app-checks not run: no time was left" ;;
    *)   part="app-checks could not run (it exited $checks)" ;;
  esac
  case "$relay" in
    0)
      if [ "$checks" -eq 0 ]; then head="pass complete (exit 0)"
      else head="A STEP FAILED AND SAID SO ABOVE (exit $exit): the relay part finished, its merges and hand-backs stand"; fi ;;
    1)   head="A STEP FAILED AND SAID SO ABOVE (exit 1)" ;;
    124) head="hit the ${rlimit}s time limit and was stopped (exit 124); its tickets are untouched or marked, never half-moved silently" ;;
    *)   head="the pass could not run (exit $relay)" ;;
  esac
  echo "$head; $part"
}
