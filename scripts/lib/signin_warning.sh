#!/bin/bash
# signin_warning.sh — the lane runner's alarm that Claude's sign-in is about to
# end, sourced by scripts/loop_runner.sh and by its test
# (scripts/watchdogScripts.test.mjs).
#
#   report_signin_warning <repo> <stamp-file> <pass-output>
#
# After every pass. Claude prints, on every pass made with a sign-in that has
# an end date, a line like
#
#   Warning: this sign-in ends between 2026-11-22 and 2026-11-25 (in 5 days at the earliest). ...
#
# and nothing else in the loop said so: it sat in each lane's log until every
# loop would stop with it. When this pass's output carries that line and the
# earliest date on it is seven days away or less, this posts one ALARM to the
# project's bus (`npm run clickup -- bus-post`, from <repo>, under a short time
# limit) naming that date. <stamp-file> holds the day of the last alarm that
# landed, so every lane of the project says it at most once a day; a post that
# did not land leaves no stamp, so the next pass tries again.
#
# SIGNIN_WARNING_TODAY (YYYY-MM-DD) stands in for today's date, for the test.
#
# It NEVER changes the runner's exit, the pass's code or the next pass: it
# always returns 0, and a post that did not land is one line saying so.
report_signin_warning() {
  local repo="$1" stamp="$2" out="$3" today earliest days when body status
  [ -f "$out" ] || return 0
  # ISO dates sort as text, so the first one sorted is the earliest.
  earliest="$(grep -oE 'this sign-in ends between [0-9]{4}-[0-9]{2}-[0-9]{2} and [0-9]{4}-[0-9]{2}-[0-9]{2}' "$out" 2>/dev/null \
    | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | sort | head -1)"
  [ -n "$earliest" ] || return 0
  today="${SIGNIN_WARNING_TODAY:-$(date +%Y-%m-%d)}"
  # Whole days between two calendar dates; node is there wherever a lane runs.
  days="$(node -e 'const [a, b] = process.argv.slice(1).map((d) => Date.parse(`${d}T00:00:00Z`)); if (Number.isNaN(a) || Number.isNaN(b)) process.exit(1); console.log(Math.round((a - b) / 864e5));' "$earliest" "$today" 2>/dev/null)" || return 0
  [[ "$days" =~ ^-?[0-9]+$ ]] || return 0
  [ "$days" -le 7 ] || return 0
  if [ "$(cat "$stamp" 2>/dev/null)" = "$today" ]; then return 0; fi
  if [ "$days" -gt 1 ]; then when="as early as $earliest (in $days days)"
  elif [ "$days" -eq 1 ]; then when="as early as $earliest (tomorrow)"
  elif [ "$days" -eq 0 ]; then when="as early as $earliest (today)"
  else when="as early as $earliest (${days#-} day(s) ago), so it may have ended already"
  fi
  body="$(mktemp "${TMPDIR:-/tmp}/signin-warning.XXXXXX")" || return 0
  printf '%s\n' "ALARM: the Claude sign-in the lanes on $(hostname -s 2>/dev/null || echo this machine) use ends $when, and every loop there stops with it. Make a long-lived one on that machine: claude setup-token, then bash scripts/claude_token_to_doppler.sh." > "$body"
  (cd "$repo" && RUN_WITH_TIME_LIMIT_POLL=1 RUN_WITH_TIME_LIMIT_GRACE=5 \
    "$repo/scripts/run_with_time_limit.sh" "${SIGNIN_WARNING_LIMIT_SECONDS:-90}" -- \
    npm run --silent clickup -- bus-post --body-file "$body")
  status=$?
  rm -f "$body"
  if [ "$status" -ne 0 ]; then
    echo "[loop-runner] $(date "+%H:%M:%S") the alarm that Claude's sign-in ends $when did NOT reach the bus (exit $status; its line above says why). The runner carries on."
    return 0
  fi
  mkdir -p "$(dirname "$stamp")" 2>/dev/null
  printf '%s\n' "$today" > "$stamp" 2>/dev/null
  return 0
}
