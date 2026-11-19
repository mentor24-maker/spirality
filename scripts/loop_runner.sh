#!/bin/bash
# Run one Spirality loop skill on a fixed interval, forever.
#
#   loop_runner.sh <skill-name> [interval-seconds]
#
# A seed-sized copy of StarCaster's scripts/loop_runner.sh: the lock, the
# pull-before-pass, the time limit and the honest END line are kept. A
# project's own pause switch and its lane environment (`lanePauseCommand`,
# `laneEnv` in its manifest, SP-395) are asked and handed to each pass too, and
# a project whose manifest turns on `usageLimitSleep` gets StarCaster's
# usage-limit guard (SP-396, below), and a project that names a
# `laneHeartbeatCommand` gets one beat after every turn of the loop (SP-397).
#
# Each iteration is a FRESH headless Claude Code session started in the main
# checkout (Spirality's own, or the project's that SPIRALITY_PROJECT names,
# with Spirality's skills and hooks handed to it: see SESSION_ARGS below).
# Every loop skill picks the next ticket from the tracker on each run,
# so there is no state to carry between runs, and a crashed run costs one
# interval rather than the whole night.
#
# --allowedTools is used instead of --dangerously-skip-permissions so the
# repo's PreToolUse hook (no edits on main) still applies. A headless run
# cannot answer a permission prompt, so anything not listed is refused and
# the run continues.
#
# A project's passes run on the Spirality release the tracker names for it
# (SP-276): this runner, in Spirality's main checkout, launches them, and
# everything a pass runs of Spirality's (the door, the plugin's skills and
# hooks, the pause, work, wake and model checks) comes from that release's
# own checkout, which scripts/lib/releaseCheckout.mjs keeps in Spirality's
# log folder. Spirality's own passes run from this folder, on main.
#
# Every project-specific name (the log folder, the short name each log and
# lock starts with, the launchd label) comes from the project config through
# scripts/project_config.mjs, the way the installer and run_relay.sh read
# them; nothing here names a project.
set -u

# launchd hands the job almost no environment. Set the PATH once, here.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

SKILL=${1:?usage: loop_runner.sh <skill-name> [interval-seconds]}
# The first sleep's length, handed in by the installer (the default in
# scripts/lib/loopSchedule.mjs). Before every sleep the runner asks the
# tracker for the wake time set on the Settings page (read_wake_time, below)
# and keeps this one only while that cannot be read.
INTERVAL=${2:-1800}

# The repo is WHERE THIS SCRIPT LIVES, never a path typed from memory, and it
# must be the MAIN checkout: a worktree is deleted when its work ships.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$REPO/.git" ] && grep -q '^gitdir:.*worktrees' "$REPO/.git" 2>/dev/null; then
  echo "[loop-runner] Refusing to run from a worktree ($REPO) — worktrees are deleted when their work ships." >&2
  exit 1
fi

# The project this runner works for (SP-271). Unset, it is Spirality itself,
# exactly as before. Set (the installer's --project writes it into the
# plist), SPIRALITY_PROJECT names another project's checkout: every pass then
# starts THERE, so its CLAUDE.md and `npm run verify` apply, and the pull
# below is of THAT checkout's main, never of Spirality's (which only
# Spirality's own lanes pull, so a project's lanes never pick up new
# Spirality code mid-pass). Spirality's own scripts (the door, the pause and
# work checks) still run from this folder, and read the project's manifest
# because the name is exported.
PROJECT="$REPO"
if [ -n "${SPIRALITY_PROJECT:-}" ]; then
  PROJECT="$(cd "$SPIRALITY_PROJECT" 2>/dev/null && pwd)" || { echo "[loop-runner] SPIRALITY_PROJECT names $SPIRALITY_PROJECT, which is not a folder on this machine. Stopping." >&2; exit 1; }
  if [ -f "$PROJECT/.git" ] && grep -q '^gitdir:.*worktrees' "$PROJECT/.git" 2>/dev/null; then
    echo "[loop-runner] Refusing to run for a worktree ($PROJECT) — worktrees are deleted when their work ships." >&2
    exit 1
  fi
  export SPIRALITY_PROJECT="$PROJECT"
fi
# Yes when this runner works for Spirality's own checkout.
OWN=""
[ "$(cd "$PROJECT" && pwd -P)" = "$(cd "$REPO" && pwd -P)" ] && OWN=yes

cd "$PROJECT" || exit 1

# The skills and hooks a project's pass works under (SP-272). Spirality's own
# pass finds them in its own .claude/ folder, exactly as before, so it gets
# no extra options. A project's pass is handed Spirality's plugin folder
# (plugin/: the skills, through a link to .claude/skills, and the hooks in
# plugin/hooks/hooks.json, which run from this folder) with Claude Code's
# standard --plugin-dir option, and asks for the skill by its plugin name,
# /<plugin>:<skill>: a project that still carries its own copy of a skill
# under the same name would otherwise win over Spirality's (checked
# 2026-11-14 on Claude Code 2.1.323). The project's own CLAUDE.md is read as
# always: the pass starts in its checkout. This folder's plugin is checked
# once, here, so a runner that could never hand a pass its skill stops at
# once; each pass is then handed the plugin of the release it runs
# (pass_args, below, SP-276).
PROMPT="/$SKILL"
SESSION_ARGS=()
if [ -z "$OWN" ]; then
  PLUGIN_DIR="$REPO/plugin"
  PLUGIN_NAME="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).name || ""))' "$PLUGIN_DIR/.claude-plugin/plugin.json" 2>/dev/null)"
  case "$PLUGIN_NAME" in
    ""|*[!a-z0-9-]*) echo "[loop-runner] Spirality's plugin folder ($PLUGIN_DIR) has no usable name in .claude-plugin/plugin.json, so a project's pass would find no skills or hooks. Stopping." >&2; exit 1 ;;
  esac
  if [ ! -f "$PLUGIN_DIR/skills/$SKILL/SKILL.md" ]; then
    echo "[loop-runner] Spirality's plugin folder has no /$SKILL skill ($PLUGIN_DIR/skills/$SKILL/SKILL.md). Stopping." >&2
    exit 1
  fi
fi

# The prompt and the plugin folder for one pass run from Spirality folder $1
# (SP-276: a release checkout, for a project). Spirality's own pass: the
# skill by its plain name, no extra options. Returns 1, with PASS_ARGS_WHY
# saying why in one line, when that folder's plugin cannot hand the pass a
# skill. Run in this shell, never in $( ), so PROMPT and SESSION_ARGS stick.
pass_args() {
  local code_dir="$1" name
  PROMPT="/$SKILL"
  SESSION_ARGS=()
  PASS_ARGS_WHY=""
  [ -n "$OWN" ] && return 0
  name="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).name || ""))' "$code_dir/plugin/.claude-plugin/plugin.json" 2>/dev/null)"
  case "$name" in
    ""|*[!a-z0-9-]*) PASS_ARGS_WHY="the plugin folder in $code_dir has no usable name in .claude-plugin/plugin.json"; return 1 ;;
  esac
  if [ ! -f "$code_dir/plugin/skills/$SKILL/SKILL.md" ]; then
    PASS_ARGS_WHY="the plugin folder in $code_dir has no /$SKILL skill"
    return 1
  fi
  PROMPT="/$name:$SKILL"
  SESSION_ARGS=(--plugin-dir "$code_dir/plugin")
}
# The Spirality folder this pass runs from: this one, until a project's
# release is read just before each pass (step 4 below). The pause and work
# checks always run from this folder, as the relay's tick and pause check do.
RUN_DIR="$REPO"

SLUG="$(node "$REPO/scripts/project_config.mjs" projectSlug)" || { echo "[loop-runner] could not read projectSlug from the project config" >&2; exit 1; }
LOG_DIR="$(node "$REPO/scripts/project_config.mjs" logDir)" || { echo "[loop-runner] could not read logDir from the project config" >&2; exit 1; }
PREFIX="$(node "$REPO/scripts/project_config.mjs" launchdPrefix)" || { echo "[loop-runner] could not read launchdPrefix from the project config" >&2; exit 1; }
# Empty when the project runs no tracker: the restart step then does nothing.
TRACKER_PORT="$(node "$REPO/scripts/project_config.mjs" trackerPort)" || { echo "[loop-runner] could not read trackerPort from the project config" >&2; exit 1; }
# The tracker is Spirality's own service: only Spirality's own lanes restart it.
[ -n "$OWN" ] || TRACKER_PORT=""
LOG="$LOG_DIR/$SLUG-$SKILL.log"
LOCK="$LOG_DIR/$SLUG-$SKILL.lock"
# A file here ends the sleep between passes early (SP-219); `node
# scripts/lib/wakeLane.mjs <lane>` writes it. Named like the lock, from the
# project config.
WAKE="$LOG_DIR/$SLUG-$SKILL.wake"
# How often the sleep looks for the wake file, in seconds.
WAKE_POLL="${LOOP_WAKE_POLL_SECONDS:-5}"
case "$WAKE_POLL" in ""|*[!0-9]*|0) WAKE_POLL=5 ;; esac
# The longest a lane goes without a real Claude pass while its queue is
# empty, in seconds (SP-292): the work check skips empty passes only while
# the last real one is younger than this. 0 turns the skipping off.
IDLE_PASS_EVERY="${LOOP_IDLE_PASS_EVERY_SECONDS:-21600}"
case "$IDLE_PASS_EVERY" in ""|*[!0-9]*) IDLE_PASS_EVERY=21600 ;; esac
# When the last real pass started (epoch seconds); 0 until the first, which always runs.
LAST_REAL_PASS=0
mkdir -p "$LOG_DIR"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || echo "$HOME/.local/bin/claude")}"

# The lanes' long-lived Claude sign-in (SP-385). A browser sign-in kept in the
# keychain ends on a fixed date and every lane stops with it, so each pass
# signs in with the token `claude setup-token` makes for unattended jobs
# (about a year), stored as CLAUDE_CODE_OAUTH_TOKEN in Doppler by
# scripts/claude_token_to_doppler.sh. It is read from the Doppler project and
# config of THIS folder's own manifest, never the project's a runner works
# for: every project's lanes run from here, so one token serves them all.
# The value lives in a shell variable that is never exported, printed or put
# on a command line (ps shows command lines, not environments); only the
# claude process, and what it starts, gets it. A token that cannot be read
# leaves the pass on this machine's own sign-in, as before, said in one line.
CLAUDE_TOKEN_KEY=CLAUDE_CODE_OAUTH_TOKEN
DOPPLER_BIN="${DOPPLER_BIN:-$(command -v doppler || true)}"
TOKEN_PROJECT="$(cd "$REPO" && SPIRALITY_PROJECT='' node "$REPO/scripts/project_config.mjs" dopplerProject 2>/dev/null)"
TOKEN_CONFIG="$(cd "$REPO" && SPIRALITY_PROJECT='' node "$REPO/scripts/project_config.mjs" dopplerConfig 2>/dev/null)"
# Sets CLAUDE_TOKEN (empty when there is none to use) and TOKEN_LINE, the one
# log line saying where this pass's sign-in comes from. Run in this shell,
# never in $( ), so CLAUDE_TOKEN sticks without passing through stdout.
read_claude_token() {
  CLAUDE_TOKEN=""
  local where="$TOKEN_PROJECT/$TOKEN_CONFIG" got code err
  local fallback="this pass uses this machine's own Claude sign-in"
  if [ -z "$TOKEN_PROJECT" ] || [ -z "$TOKEN_CONFIG" ]; then
    TOKEN_LINE="the project config in $REPO names no Doppler project and config to read $CLAUDE_TOKEN_KEY from; $fallback"
    return 0
  fi
  if [ -z "$DOPPLER_BIN" ] || [ ! -x "$DOPPLER_BIN" ]; then
    TOKEN_LINE="no doppler on this machine to read $CLAUDE_TOKEN_KEY with; $fallback"
    return 0
  fi
  err="$(mktemp "${TMPDIR:-/tmp}/$SLUG-token-err.XXXXXX")"
  got="$("$DOPPLER_BIN" secrets get "$CLAUDE_TOKEN_KEY" --plain --project "$TOKEN_PROJECT" --config "$TOKEN_CONFIG" 2>"$err")"
  code=$?
  if [ "$code" -ne 0 ]; then
    if grep -qi "could not find requested secret" "$err" 2>/dev/null; then
      TOKEN_LINE="no $CLAUDE_TOKEN_KEY in Doppler $where; $fallback"
    else
      TOKEN_LINE="Doppler $where could not be read for $CLAUDE_TOKEN_KEY (doppler exited $code); $fallback"
    fi
  elif [ -z "$got" ]; then
    TOKEN_LINE="$CLAUDE_TOKEN_KEY in Doppler $where is empty; $fallback"
  elif [[ "$got" =~ [[:space:]] ]]; then
    # A token is one word. Anything else is a paste gone wrong; never logged.
    TOKEN_LINE="$CLAUDE_TOKEN_KEY in Doppler $where is not a single word (a paste gone wrong?), so it is not used; $fallback"
  else
    CLAUDE_TOKEN="$got"
    TOKEN_LINE="this pass signs in to Claude with $CLAUDE_TOKEN_KEY from Doppler $where"
  fi
  rm -f "$err"
  got=""
}

# This loop's own tracker sign-in (docs/TRACKER_MVP.md, "Running it"): the
# NAME of its Doppler secret, e.g. loop-build -> TRACKER_TOKEN_LOOP_BUILD.
# The door reads the value inside its own `doppler run`, so the token never
# enters this session's environment or its log.
export TRACKER_TOKEN_NAME="TRACKER_TOKEN_$(printf '%s' "$SKILL" | tr 'a-z-' 'A-Z_')"

# One runner per skill. A stale lock (its pid gone) is announced and taken over,
# so a reboot never leaves the loop dead behind a lock nobody holds.
if ! mkdir "$LOCK" 2>/dev/null; then
  OLD_PID="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[loop-runner] $SKILL is already running (pid $OLD_PID, lock: $LOCK). Refusing to start a second."
    exit 1
  fi
  echo "[loop-runner] found a STALE lock (pid ${OLD_PID:-unrecorded}, no such process) — clearing it and taking over." | tee -a "$LOG"
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || { echo "[loop-runner] the lock could not be retaken. Stopping."; exit 1; }
fi
echo "$$" > "$LOCK/pid"
# The pass reads this to know it is the runner's pass, not a hand-run session:
# only a claim made under the build runner writes the claim marker that lets
# the next pass hand back a ticket a dead pass left in Building (SP-101).
export LOOP_RUNNER_PID="$$"

# The project's own lane settings (SP-395): `lanePauseCommand` and `laneEnv`
# in its manifest, read by scripts/lib/laneSettings.mjs. A copy of this runner
# without that script runs on without either.
LANE_SETTINGS="$REPO/scripts/lib/laneSettings.mjs"
[ -f "$LANE_SETTINGS" ] || LANE_SETTINGS=""

# The usage-limit guard (SP-396), moved from StarCaster's runner, on only for
# a project whose manifest says `"usageLimitSleep": true`. On, a pass that
# exits non-zero is read by scripts/loop_runner_delay.mjs; one a Claude usage
# limit closed sleeps the lane until the limit says it resets, and records the
# limit in the project's stand-down file (scripts/loop_policy.mjs), which
# every lane of the project asks before each pass. Read before every pass, so
# a change takes effect at the next one. A config that cannot be read leaves
# the guard off: a guard is never a reason a lane stops. Off, the runner does
# exactly what it did before, and its log says nothing new. Both guard scripts
# answer on stdout and never fail; an answer the runner cannot use counts the
# pass as blocked and the lane sleeps its usual wake time. Run in this shell,
# never in $( ), so USAGE_LIMIT_SLEEP sticks.
USAGE_LIMIT_SLEEP=""
read_usage_limit_sleep() {
  local said was="$USAGE_LIMIT_SLEEP"
  said="$(node "$REPO/scripts/project_config.mjs" usageLimitSleep 2>/dev/null)"
  if [ "$said" = "true" ]; then USAGE_LIMIT_SLEEP=yes; else USAGE_LIMIT_SLEEP=""; fi
  if [ "$USAGE_LIMIT_SLEEP" != "$was" ]; then
    if [ -n "$USAGE_LIMIT_SLEEP" ]; then
      echo "[loop-runner] $(date "+%H:%M:%S") usageLimitSleep is on: a pass a usage limit closes sleeps /$SKILL until the limit resets, and the project's other lanes are told" >> "$LOG"
    else
      echo "[loop-runner] $(date "+%H:%M:%S") usageLimitSleep is now off (or the config could not say): /$SKILL sleeps its usual wake time after every pass" >> "$LOG"
    fi
  fi
}
# What the guard made of the last pass: ran, stood-down, blocked or
# timed-out, the seconds to sleep for a limit, and its sentence. The heartbeat
# after each pass (SP-397) hands these on.
PASS_KIND=ran
GUARD_SECONDS=0
GUARD_WHY=""

# The project's own heartbeat (SP-397): the manifest's `laneHeartbeatCommand`,
# for a project whose watchdog reads beats its own command records (as
# StarCaster's runner gives them: `npm run heartbeat -- --beat --role <skill>`).
# Run once every turn of the loop, the pass's or the reason it did not run, in
# the project's checkout with no shell, given the project's laneEnv and
# `--role <skill>`, and for anything but a pass that ran, one of
# `--stood-down`, `--blocked` or `--timed-out` and a sentence saying why, the
# flags StarCaster's runner passes. Read afresh at every beat, so a change
# takes effect at the next one. Under a short time limit, its output in the
# log; a beat that fails, runs past the limit or cannot be read is one log
# line and is lost, and never changes a pass's exit, the runner's or the next
# pass. No command named: nothing is run and nothing is logged.
# Spirality's own heartbeat (scripts/heartbeat.mjs) reads the lane logs and is
# not this. $1 is the flag (empty for a pass that ran), $2 its sentence.
HEARTBEAT_LIMIT="${LOOP_HEARTBEAT_LIMIT_SECONDS:-60}"
case "$HEARTBEAT_LIMIT" in ""|*[!0-9]*|0) HEARTBEAT_LIMIT=60 ;; esac
lane_heartbeat() {
  local list code arg what cmd=() kind=()
  [ -n "$LANE_SETTINGS" ] || return 0
  list="$(mktemp "${TMPDIR:-/tmp}/$SLUG-heartbeat-command.XXXXXX")"
  node "$LANE_SETTINGS" heartbeat-command > "$list" 2>>"$LOG"
  code=$?
  if [ "$code" -ne 0 ]; then
    rm -f "$list"
    echo "[loop-runner] $(date "+%H:%M:%S") could not read the project's laneHeartbeatCommand from its config (exit $code; its errors are above) — no heartbeat for this turn of /$SKILL" >> "$LOG"
    return 0
  fi
  while IFS= read -r -d '' arg; do cmd+=("$arg"); done < "$list"
  rm -f "$list"
  [ "${#cmd[@]}" -eq 0 ] && return 0
  [ -n "${1:-}" ] && kind=("$1" "${2:-}")
  (cd "$PROJECT" && RUN_WITH_TIME_LIMIT_POLL=1 "$REPO/scripts/run_with_time_limit.sh" "$HEARTBEAT_LIMIT" -- \
    env ${LANE_ENV_PAIRS[@]+"${LANE_ENV_PAIRS[@]}"} "${cmd[@]}" --role "$SKILL" ${kind[@]+"${kind[@]}"}) >> "$LOG" 2>&1 < /dev/null
  code=$?
  [ "$code" -eq 0 ] && return 0
  case "$code" in
    124) what="ran past ${HEARTBEAT_LIMIT}s and was stopped" ;;
    126|127) what="could not be started (exit $code)" ;;
    *) what="exited $code" ;;
  esac
  echo "[loop-runner] $(date "+%H:%M:%S") the project's heartbeat command (${cmd[*]}) $what — this turn's beat${1:+ ($1)} is lost; /$SKILL carries on" >> "$LOG"
  return 0
}

# The sync lock every lane takes around pull + npm ci (the only lock the lanes
# share; each lane's own lock above is its alone). Wait up to 10 minutes
# for another lane; a lock whose pid is gone is cleared, as above.
SYNC_LOCK="$LOG_DIR/$SLUG-sync.lock"
take_sync_lock() {
  local waited=0 holder
  until mkdir "$SYNC_LOCK" 2>/dev/null; do
    holder="$(cat "$SYNC_LOCK/pid" 2>/dev/null || true)"
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$SYNC_LOCK"; continue; fi
    [ "$waited" -ge 600 ] && return 1
    sleep 5; waited=$((waited + 5))
  done
  echo "$$" > "$SYNC_LOCK/pid"
}

# The sleep between passes, in steps of WAKE_POLL seconds, so a wake file
# ends it early. It never cuts a pass short: it only runs between passes. A
# wake that arrived during the pass is still there, so the next pass starts at
# once, and any number of wakes sent during one pass start exactly one more
# (they are all the same file). The file is cleared as a pass starts, never
# here, so a wake that lands just as the timer runs out is not left over to
# start a second pass behind it.
# $1, when given, is how long to sleep in place of the wake time (the
# usage-limit guard's sleep, SP-396).
sleep_until_woken() {
  local slept=0 step total="${1:-$INTERVAL}"
  while [ "$slept" -lt "$total" ]; do
    if [ -e "$WAKE" ]; then
      echo "[loop-runner] $(date "+%H:%M:%S") woken early after ${slept}s of ${total}s (wake file $WAKE) — starting the next /$SKILL now" >> "$LOG"
      return 0
    fi
    step=$WAKE_POLL
    [ $((total - slept)) -lt "$step" ] && step=$((total - slept))
    sleep "$step"; slept=$((slept + step))
  done
}

# A pause, from either switch: its one line, the dated PAUSED line (SP-266:
# the runner is alive and holding off on purpose, and the heartbeat,
# lib/heartbeat.js, reads it as a beat, so a lane just unpaused is not called
# quiet on the last pass from before the pause; never START or END, so no
# reader counts it as a pass), the wake file cleared (a wake sent while paused
# is answered by this check, not kept: kept, it would end every sleep at once
# and ask again every few seconds), the project's stood-down beat (SP-397),
# and the normal sleep.
sleep_paused() {
  echo "[loop-runner] $(date "+%H:%M:%S") $1" >> "$LOG"
  echo "===== $(date "+%Y-%m-%d %H:%M:%S") PAUSED /$SKILL =====" >> "$LOG"
  lane_heartbeat --stood-down "$1"
  rm -f "$WAKE"
  echo "[loop-runner] $(date "+%H:%M:%S") sleeping ${INTERVAL}s before the next /$SKILL (a wake ends it early)" >> "$LOG"
  sleep_until_woken
}

# The project's lane environment (SP-395): the manifest's `laneEnv`, a few
# plain NAME=value settings (never a secret; lib/projectConfig.mjs refuses a
# name that reads like one, or one the runner, git, node or the shell owns).
# Read before every pass into LANE_ENV_PAIRS and handed, with `env`, to the
# pass and the project's pause command ONLY: never exported here, so a name
# like LOCK or LOG can never replace the runner's own (the exit trap removes
# $LOCK), and Spirality's own steps (the pull, npm ci, the Settings page's
# checks) never see a project's variables. A config that cannot be read
# returns 1 with LANE_ENV_WHY saying so: the lane is treated as paused (it
# fails safe), the same as a pause command that cannot be read. The names are
# logged when they first reach a pass or change, never their values. Run in
# this shell, never in $( ), so the array sticks.
LANE_ENV_PAIRS=()
LANE_ENV_LOGGED=""
load_lane_env() {
  LANE_ENV_WHY=""
  LANE_ENV_PAIRS=()
  local list code pair names=""
  [ -n "$LANE_SETTINGS" ] || return 0
  list="$(mktemp "${TMPDIR:-/tmp}/$SLUG-lane-env.XXXXXX")"
  node "$LANE_SETTINGS" env > "$list" 2>>"$LOG"
  code=$?
  if [ "$code" -ne 0 ]; then
    rm -f "$list"
    LANE_ENV_WHY="could not read the project's laneEnv from its config (exit $code; its errors are above), so /$SKILL is treated as PAUSED and not starting (it fails safe)"
    return 1
  fi
  while IFS= read -r -d '' pair; do
    LANE_ENV_PAIRS+=("$pair")
    names="$names ${pair%%=*}"
  done < "$list"
  rm -f "$list"
  if [ "$names" != "$LANE_ENV_LOGGED" ]; then
    if [ -n "$names" ]; then
      echo "[loop-runner] $(date "+%H:%M:%S") the project's laneEnv is given to every pass and its pause command:$names" >> "$LOG"
    else
      echo "[loop-runner] $(date "+%H:%M:%S") the project's laneEnv is now empty" >> "$LOG"
    fi
    LANE_ENV_LOGGED="$names"
  fi
  return 0
}

# The project's own pause switch (SP-395): the manifest's `lanePauseCommand`,
# the program then each argument, run with no shell in the project's checkout
# under a time limit. Exit 0 means run. Any other exit, a command that cannot
# start, one that runs past the limit, or a config that cannot be read means
# paused (it fails safe, as a project's own runner does): returns 1 with
# PROJECT_PAUSE_WHY saying which. No command set: returns 0 at once, saying
# nothing. Run in this shell, never in $( ), so PROJECT_PAUSE_WHY sticks.
PAUSE_COMMAND_LIMIT="${LOOP_PAUSE_COMMAND_LIMIT_SECONDS:-120}"
case "$PAUSE_COMMAND_LIMIT" in ""|*[!0-9]*|0) PAUSE_COMMAND_LIMIT=120 ;; esac
project_pause_check() {
  PROJECT_PAUSE_WHY=""
  local list code arg out first cmd=()
  [ -n "$LANE_SETTINGS" ] || return 0
  list="$(mktemp "${TMPDIR:-/tmp}/$SLUG-pause-command.XXXXXX")"
  node "$LANE_SETTINGS" pause-command > "$list" 2>>"$LOG"
  code=$?
  if [ "$code" -ne 0 ]; then
    rm -f "$list"
    PROJECT_PAUSE_WHY="could not read the project's lanePauseCommand from its config (exit $code; its errors are above), so /$SKILL is treated as PAUSED and not starting (it fails safe)"
    return 1
  fi
  while IFS= read -r -d '' arg; do cmd+=("$arg"); done < "$list"
  rm -f "$list"
  [ "${#cmd[@]}" -eq 0 ] && return 0
  # Polled every second, not the pass's 15, so a quick answer costs no wait.
  # The project's laneEnv goes to the command alone, through `env`.
  out="$(RUN_WITH_TIME_LIMIT_POLL=1 "$REPO/scripts/run_with_time_limit.sh" "$PAUSE_COMMAND_LIMIT" -- env ${LANE_ENV_PAIRS[@]+"${LANE_ENV_PAIRS[@]}"} "${cmd[@]}" 2>&1 < /dev/null)"
  code=$?
  [ "$code" -eq 0 ] && return 0
  first="$(printf '%s\n' "$out" | grep -m1 '[^[:space:]]')"
  case "$code" in
    124) PROJECT_PAUSE_WHY="the project's pause command (${cmd[*]}) ran past ${PAUSE_COMMAND_LIMIT}s and was stopped, so /$SKILL is treated as PAUSED and not starting (it fails safe)" ;;
    126|127) PROJECT_PAUSE_WHY="the project's pause command (${cmd[*]}) could not be started (exit $code${first:+: $first}), so /$SKILL is treated as PAUSED and not starting (it fails safe)" ;;
    *) PROJECT_PAUSE_WHY="the project's pause command (${cmd[*]}) exited $code, so /$SKILL is PAUSED and not starting${first:+ — it said: $first}" ;;
  esac
  return 1
}

# The wake time Dane set for this lane on the tracker's Settings page
# (SP-236), read before every sleep, so a change takes effect at the next
# sleep with no launchd reload. scripts/lib/wakeSetting.mjs prints the number,
# or one line saying why it could not; only a whole number of at least 60
# seconds is ever slept on. Anything else keeps the last good value (on the
# first pass, the one launchd passed in), and the log says so in one line:
# the lane never stops and never sleeps 0.
read_wake_time() {
  local said
  said="$(node "$RUN_DIR/scripts/lib/wakeSetting.mjs" "$SKILL" 2>/dev/null)"
  local code=$?
  case "$said" in
    ""|*[!0-9]*) ;;
    *) if [ "$code" -eq 0 ] && [ "$said" -ge 60 ]; then INTERVAL="$said"; return 0; fi ;;
  esac
  echo "[loop-runner] $(date "+%H:%M:%S") could not read /$SKILL's wake time from the tracker (${said:-no answer}) — keeping the last good value, ${INTERVAL}s" >> "$LOG"
}

# The model Dane chose for this lane on the tracker's Settings page (SP-239),
# read before every pass, so a change takes effect at the next pass with no
# launchd reload. scripts/lib/modelSetting.mjs prints `default` or one id from
# the Settings page's own list (scripts/lib/laneModels.mjs MODELS), or one
# line saying why it could not. A chosen model adds `--model <id>` to the
# claude line; `default`, or anything that could not be read or is not a
# plain model id, adds nothing, so the command is exactly what it was before
# the setting existed, and the log says why in one line. PASS_MODEL is what
# the START line names.
read_model() {
  PASS_MODEL=default
  MODEL_ARGS=()
  local said code
  said="$(node "$RUN_DIR/scripts/lib/modelSetting.mjs" "$SKILL" 2>/dev/null)"
  code=$?
  if [ "$code" -eq 0 ]; then
    case "$said" in
      default) return 0 ;;
      *[!a-z0-9.-]*) ;;
      claude-?*) PASS_MODEL="$said"; MODEL_ARGS=(--model "$said"); return 0 ;;
    esac
  fi
  echo "[loop-runner] $(date "+%H:%M:%S") could not read /$SKILL's model from the tracker (${said:-no answer}) — this pass runs on Claude's default" >> "$LOG"
}

# A template with X's, the one form macOS and GNU mktemp both accept.
PASS_OUT="$(mktemp "${TMPDIR:-/tmp}/$SLUG-pass.XXXXXX")"
trap 'rm -rf "$LOCK" "$PASS_OUT" 2>/dev/null; [ "$(cat "$SYNC_LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$SYNC_LOCK"' EXIT

# shellcheck source=lib/back_to_main.sh
source "$REPO/scripts/lib/back_to_main.sh"
# A pull that changes a file the tracker server loads restarts it, so it runs the new code (SP-150).
# shellcheck source=lib/tracker_restart.sh
source "$REPO/scripts/lib/tracker_restart.sh"
# A pass that exits non-zero is said on the bus (SP-268). A copy of this
# runner without the file runs on without it.
# shellcheck source=lib/lane_failure.sh
[ -f "$REPO/scripts/lib/lane_failure.sh" ] && source "$REPO/scripts/lib/lane_failure.sh"
# The reminder that this lane's failure was already posted, cleared by its
# next good pass: lib/watchdogPosts.js failureStampFile names the same file.
WATCHDOG_DIR="$LOG_DIR/$SLUG-watchdogs"
FAILURE_STAMP="$WATCHDOG_DIR/failed-$(printf '%s' "$SKILL" | tr -c 'A-Za-z0-9-' '-').stamp"
# Claude's warning that its sign-in ends soon is said on the bus a week ahead,
# at most once a day across this project's lanes (SP-388). A copy of this
# runner without the file runs on without it.
# shellcheck source=lib/signin_warning.sh
[ -f "$REPO/scripts/lib/signin_warning.sh" ] && source "$REPO/scripts/lib/signin_warning.sh"
SIGNIN_WARNING_STAMP="$WATCHDOG_DIR/claude-signin-warning.stamp"

while true; do
  # Where main was before this pass synced: noted BEFORE step 0, because that
  # step can fast-forward main itself, and a tracker change it brings in must
  # count too (SP-150).
  BEFORE="$(git rev-parse HEAD 2>/dev/null)"

  # 0. A checkout left on a branch that has merged and gone from origin (a new
  #    project's lanes run from its setup branch until it merges) goes
  #    back to main, under the sync lock, so the pull below can run. No
  #    dirty-tree check here: the helper decides, so untracked files alone do
  #    not keep it on the branch and a tracked change is named (SP-393).
  if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" != "main" ]; then
    if take_sync_lock; then
      MOVED="$(back_to_main_if_merged)"
      [ -n "$MOVED" ] && echo "[loop-runner] $(date "+%H:%M:%S") $MOVED" >> "$LOG"
      rm -rf "$SYNC_LOCK"
    fi
  fi

  # 1. A timid pull: only main, only a clean tree, only fast-forward. A refusal
  #    is logged but never blocks the pass. Every lane shares this checkout, so
  #    the pull and `npm ci` happen under one shared lock: two at once collide
  #    on .git/index.lock and rebuild node_modules under each other.
  if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "main" ] && [ -z "$(git status --porcelain)" ]; then
    if take_sync_lock; then
      git pull -q --ff-only origin main >> "$LOG" 2>&1 || echo "[loop-runner] $(date "+%H:%M:%S") pull of main refused (see above) — running on the checkout as it is" >> "$LOG"
      # Dependencies follow the lockfile, so a merged change to package.json takes effect on the next pass.
      npm ci --silent >> "$LOG" 2>&1 || echo "[loop-runner] $(date "+%H:%M:%S") npm ci failed — running with the node_modules already present" >> "$LOG"
      # After npm ci, so a merge that adds a dependency restarts onto it.
      RESTARTED="$(restart_tracker_if_changed "$BEFORE" "$(git rev-parse HEAD 2>/dev/null)" "$PREFIX" "$TRACKER_PORT")"
      [ -n "$RESTARTED" ] && echo "[loop-runner] $(date "+%H:%M:%S") $RESTARTED" >> "$LOG"
      rm -rf "$SYNC_LOCK"
    else
      echo "[loop-runner] $(date "+%H:%M:%S") another lane held the sync lock for 10 minutes — not pulling this pass" >> "$LOG"
    fi
  else
    echo "[loop-runner] $(date "+%H:%M:%S") main checkout is not on a clean main — not pulling. Every pass runs stale code until it is put back on main." >> "$LOG"
  fi

  # 2. Paused? First the project's own lane settings and switch (SP-395,
  #    load_lane_env and project_pause_check above; nothing at all when its
  #    manifest names neither), then the Settings
  #    page's (SP-237), the whole pipeline and this lane. Both are asked here,
  #    between passes, so a pause never stops a pass already running: it
  #    drains. Asked after the pull, so the check is the newest code. ANY
  #    non-zero exit counts as paused, a check that could not run included
  #    (it fails safe), and the line logged says which.
  if ! load_lane_env; then
    sleep_paused "$LANE_ENV_WHY"
    continue
  fi
  if ! project_pause_check; then
    sleep_paused "$PROJECT_PAUSE_WHY"
    continue
  fi
  PAUSE_LINE="$("$REPO/scripts/pause_check.sh" "$SKILL" 2>>"$LOG")"
  PAUSE_CODE=$?
  if [ "$PAUSE_CODE" -ne 0 ]; then
    [ -n "$PAUSE_LINE" ] || PAUSE_LINE="could not read the pipeline settings (the check exited $PAUSE_CODE and said nothing; its errors are above), so /$SKILL is treated as PAUSED and not starting (it fails safe)"
    sleep_paused "$PAUSE_LINE"
    continue
  fi
  # 2b. A usage limit another lane of this project recorded, or a quiet
  #     window (SP-396, only with usageLimitSleep on): `loop_policy.mjs check`
  #     answers `run 0`, or `stand-down|quiet <seconds> <sentence>`, the
  #     seconds capped at 15 minutes so a lifted stand-down is noticed. Held,
  #     the lane writes a dated SKIP line (the heartbeat and the Pipeline
  #     Status pod read it as the lane alive, never as a pass), clears the
  #     wake file (answered by this check, as a pause does) and sleeps; any
  #     other answer runs the pass, because the rule fails open.
  read_usage_limit_sleep
  if [ -n "$USAGE_LIMIT_SLEEP" ]; then
    POLICY_SAID="$(node "$REPO/scripts/loop_policy.mjs" check --lane "$SLUG/$SKILL" --dir "$LOG_DIR" --slug "$SLUG" 2>>"$LOG" < /dev/null)"
    read -r POLICY_ACTION POLICY_SECONDS POLICY_LINE <<< "$POLICY_SAID"
    # Its sentence ends "— not starting a pass…"; the SKIP line says that already.
    POLICY_LINE="${POLICY_LINE%% — not starting a pass*}"
    case "$POLICY_SECONDS" in ""|*[!0-9]*) POLICY_SECONDS=0 ;; esac
    if { [ "$POLICY_ACTION" = "stand-down" ] || [ "$POLICY_ACTION" = "quiet" ]; } && [ "$POLICY_SECONDS" -gt 0 ]; then
      echo "===== $(date "+%Y-%m-%d %H:%M:%S") SKIP /$SKILL (${POLICY_LINE:-$POLICY_ACTION}; Claude not started) =====" >> "$LOG"
      lane_heartbeat --stood-down "${POLICY_LINE:-$POLICY_ACTION}"
      rm -f "$WAKE"
      echo "[loop-runner] $(date "+%H:%M:%S") sleeping ${POLICY_SECONDS}s before asking again whether /$SKILL may start (a wake ends it early)" >> "$LOG"
      sleep_until_woken "$POLICY_SECONDS"
      continue
    fi
  fi

  # This pass reads the queue afresh (the work check below, then the pass), so
  # every wake sent before now is answered by it. A wake sent from here on is
  # kept for the next one.
  rm -f "$WAKE"

  # 3. Anything to do? (SP-292) A pass with nothing to do used to start a
  #    Claude session only to say "nothing to do", and every one counted
  #    against the weekly limit, so a short wake time cost quota on every
  #    empty tick. scripts/work_check.sh asks the door the same first
  #    questions the skill asks, with no AI, and exits 3 only on a clean read
  #    that found nothing; any other exit (work, could not tell, the check
  #    could not run) starts the pass as before, so a ticket is never left
  #    waiting on the check. It is not asked on the first pass after this
  #    runner starts, nor when the last real pass is IDLE_PASS_EVERY seconds
  #    old or more: those passes run anyway, so a broken Claude sign-in still
  #    shows on the Pipeline Status pod within hours, and a new project's
  #    first pass is still there for `npm run onboard:lanes` to read. The
  #    skipped pass leaves a dated SKIP line (never START or END, so no
  #    reader counts it as a pass), which the pod dates its sleeping lines by.
  if [ "$LAST_REAL_PASS" -gt 0 ] && [ $(( $(date +%s) - LAST_REAL_PASS )) -lt "$IDLE_PASS_EVERY" ]; then
    WORK_LINE="$("$REPO/scripts/work_check.sh" "$SKILL" 2>>"$LOG")"
    WORK_CODE=$?
    if [ "$WORK_CODE" -eq 3 ]; then
      echo "===== $(date "+%Y-%m-%d %H:%M:%S") SKIP /$SKILL (${WORK_LINE:-no work}; Claude not started) =====" >> "$LOG"
      # A lane that honestly found nothing to do is alive and done: a plain beat.
      lane_heartbeat
      read_wake_time
      echo "[loop-runner] $(date "+%H:%M:%S") sleeping ${INTERVAL}s before the next /$SKILL (a wake ends it early)" >> "$LOG"
      sleep_until_woken
      continue
    fi
    echo "[loop-runner] $(date "+%H:%M:%S") work check: ${WORK_LINE:-the check exited $WORK_CODE and said nothing} — starting /$SKILL" >> "$LOG"
  fi
  # 4. Which Spirality this pass runs (SP-276), asked only once the pause
  #    and work checks above have said a pass is due, so a paused or idle
  #    project lane never fetches, checks out or tells the bus anything.
  #    Spirality's own: this folder, on the main just pulled. A project's:
  #    the release the tracker names for it, read now, at the start of the
  #    pass, so a move or a roll-back takes effect at this pass and never
  #    stops one running. A
  #    release that cannot be made ready falls back to the one this project
  #    ran last (said once on its bus); with none to fall back on, or none
  #    named, the pass does not run. Never a silent run on main.
  if [ -z "$OWN" ]; then
    RELEASE_SAID="$(node "$REPO/scripts/lib/releaseCheckout.mjs" prepare --root "$REPO" --project "$SLUG" --pid "$$" 2>>"$LOG")"
    RELEASE_CODE=$?
    RUN_DIR="$(printf '%s\n' "$RELEASE_SAID" | head -1)"
    while IFS= read -r line; do
      [ -n "$line" ] && echo "[loop-runner] $(date "+%H:%M:%S") release: $line" >> "$LOG"
    done < <(printf '%s\n' "$RELEASE_SAID" | tail -n +2)
    WHY_NOT=""
    if [ -z "$RUN_DIR" ] || [ ! -d "$RUN_DIR" ]; then
      WHY_NOT="no Spirality release to run on (the release check exited $RELEASE_CODE)"
    elif ! pass_args "$RUN_DIR"; then
      WHY_NOT="$PASS_ARGS_WHY"
    fi
    if [ -n "$WHY_NOT" ]; then
      RUN_DIR="$REPO"
      echo "===== $(date "+%Y-%m-%d %H:%M:%S") SKIP /$SKILL ($WHY_NOT; Claude not started) =====" >> "$LOG"
      lane_heartbeat --blocked "$WHY_NOT"
      read_wake_time
      echo "[loop-runner] $(date "+%H:%M:%S") sleeping ${INTERVAL}s before the next /$SKILL (a wake ends it early)" >> "$LOG"
      sleep_until_woken
      continue
    fi
  else
    pass_args "$REPO"
  fi

  LAST_REAL_PASS="$(date +%s)"
  read_model
  read_claude_token
  echo "" >> "$LOG"
  # The START line names the model, so the Settings page (tracker/pipeline.mjs)
  # and the time-in-status report can tell which pass ran on what.
  echo "===== $(date "+%Y-%m-%d %H:%M:%S") START /$SKILL (model: $PASS_MODEL) =====" >> "$LOG"
  echo "[loop-runner] $(date "+%H:%M:%S") $TOKEN_LINE" >> "$LOG"
  # The pass's output goes to the log as it happens AND to its own file, so
  # the sign-in check below reads this pass only, not an older one.
  # The time limit writes what the pass was running into this file when it has
  # to stop it; the pass's own report never arrives in that case. Cleared
  # first, so a stop never reports the previous stop's snapshot.
  SNAPSHOT="$LOG_DIR/$SLUG-$SKILL.timeout-snapshot"
  rm -f "$SNAPSHOT"
  # The token is exported inside this subshell only, so the pass gets it in
  # its environment and nothing else the runner starts ever does.
  (
    if [ -n "$CLAUDE_TOKEN" ]; then export CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_TOKEN"; fi
    CLAUDE_TOKEN=""
    RUN_WITH_TIME_LIMIT_SNAPSHOT="$SNAPSHOT" \
    "$RUN_DIR/scripts/run_with_time_limit.sh" "${LOOP_PASS_LIMIT_SECONDS:-7200}" -- \
      env ${LANE_ENV_PAIRS[@]+"${LANE_ENV_PAIRS[@]}"} "$CLAUDE_BIN" -p "$PROMPT" ${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"} \
      ${SESSION_ARGS[@]+"${SESSION_ARGS[@]}"} \
      --allowedTools Bash Edit Write Read Glob Grep Task TodoWrite WebFetch
  ) 2>&1 | tee "$PASS_OUT" >> "$LOG"
  CODE=${PIPESTATUS[0]}
  # Which sign-in the pass ran on, for the line below; the value is dropped.
  USED_TOKEN=""
  [ -n "$CLAUDE_TOKEN" ] && USED_TOKEN=yes
  CLAUDE_TOKEN=""
  # `claude -p` exits 0 whenever it produced output, so the code is a fact
  # about the process, not a verdict on the pass. The pass's own report is.
  echo "===== $(date "+%Y-%m-%d %H:%M:%S") END /$SKILL (exit $CODE — not a verdict; the pass's report above is) =====" >> "$LOG"
  # A pass the time limit stopped has no report, so the door is asked to say
  # what it was doing, on the ticket the pass held (lib/passTimeout.js). It
  # never fails the runner: until the door has a `pass-timeout` command the
  # line below logs its "Unknown command" answer and carries on.
  if [ "$CODE" -eq 124 ]; then
    # Spirality's door, from the Spirality folder this pass ran (a project's
    # checkout may have none, or an older copy); it acts for the exported project.
    (cd "$RUN_DIR" && npm run --silent clickup -- pass-timeout --pass "$SKILL" \
      --limit "${LOOP_PASS_LIMIT_SECONDS:-7200}" --snapshot "$SNAPSHOT") \
      >> "$LOG" 2>&1 || true
    echo "[loop-runner] the pass hit the ${LOOP_PASS_LIMIT_SECONDS:-7200}s time limit and was stopped; its ticket may still be in Building — the next pass or a person should hand it back." >> "$LOG"
  fi
  # What the pass was, by the usage-limit guard (SP-396, with usageLimitSleep
  # on): only a pass that exited non-zero is read, so a pass that merely
  # writes about limits never backs the lane off, and it reads this pass's own
  # output, never an older pass's. Run in the project's checkout, where the
  # claim marker naming a stopped pass's ticket is. A limit is recorded for
  # the project's other lanes. Never allowed to change CODE or stop the runner.
  PASS_KIND=ran
  GUARD_SECONDS=0
  GUARD_WHY=""
  if [ -n "$USAGE_LIMIT_SLEEP" ] && [ "$CODE" -ne 0 ]; then
    GUARD_SAID="$(node "$REPO/scripts/loop_runner_delay.mjs" "$PASS_OUT" --exit "$CODE" --skill "$SKILL" --limit "${LOOP_PASS_LIMIT_SECONDS:-7200}" 2>>"$LOG" < /dev/null)"
    read -r PASS_KIND GUARD_SECONDS GUARD_WHY <<< "$GUARD_SAID"
    case "$PASS_KIND" in
      ran|stood-down|blocked|timed-out) ;;
      *) echo "[loop-runner] $(date "+%H:%M:%S") the usage-limit guard gave no answer the runner can use (${GUARD_SAID:-nothing}) — counting this pass as blocked and sleeping the usual wake time" >> "$LOG"
         PASS_KIND=blocked; GUARD_SECONDS=0; GUARD_WHY="" ;;
    esac
    case "$GUARD_SECONDS" in ""|*[!0-9]*) GUARD_SECONDS=0 ;; esac
    if [ "$PASS_KIND" = "stood-down" ] && [ "$GUARD_SECONDS" -gt 0 ]; then
      node "$REPO/scripts/loop_policy.mjs" stand-down --lane "$SLUG/$SKILL" --dir "$LOG_DIR" --slug "$SLUG" \
        --seconds "$GUARD_SECONDS" --reason "a usage limit closed a /$SKILL pass" >> "$LOG" 2>&1 < /dev/null || true
    fi
  fi
  # A pass that exited non-zero: one ALARM on the bus naming the lane and its
  # exit, at most once every 6 hours; a good pass clears that reminder
  # (SP-268). Under its own short time limit, and never allowed to change
  # CODE, the runner's exit or the next pass.
  if declare -F report_lane_pass >/dev/null; then
    report_lane_pass "$RUN_DIR" "$FAILURE_STAMP" "$SKILL" "$CODE" "$LOG" >> "$LOG" 2>&1 || true
  fi
  # The sign-in this pass used ends within a week: one ALARM a day (SP-388).
  # Never allowed to change CODE, the runner's exit or the next pass.
  if declare -F report_signin_warning >/dev/null; then
    report_signin_warning "$RUN_DIR" "$SIGNIN_WARNING_STAMP" "$PASS_OUT" >> "$LOG" 2>&1 || true
  fi
  # Only Claude's own sign-in errors, and only in this pass's last lines: a
  # pass that merely mentions "not logged in" (gh, supabase) is not one.
  if tail -20 "$PASS_OUT" | grep -qiE "OAuth session expired|Failed to authenticate|Invalid API key|Please run /login"; then
    # The fix depends on which sign-in failed (SP-385): a lost or ended
    # long-lived token is replaced, and the next pass reads the new one with no
    # restart; this machine's own sign-in is renewed in a browser.
    if [ -n "$USED_TOKEN" ]; then
      echo "[loop-runner] $(date "+%H:%M:%S") THIS PASS COULD NOT SIGN IN TO CLAUDE with $CLAUDE_TOKEN_KEY from Doppler $TOKEN_PROJECT/$TOKEN_CONFIG. Nothing will change until the account holder makes a new token on this machine (claude setup-token) and stores it (bash $REPO/scripts/claude_token_to_doppler.sh); the next pass reads it, or restart this job now: launchctl kickstart -k gui/$(id -u)/$PREFIX.$SKILL" >> "$LOG"
    else
      echo "[loop-runner] $(date "+%H:%M:%S") THIS PASS COULD NOT SIGN IN TO CLAUDE. Nothing will change until a person signs in on this machine. Best: make a long-lived token for unattended jobs (claude setup-token) and store it (bash $REPO/scripts/claude_token_to_doppler.sh), which the next pass reads; or sign in again (claude login) and restart this job: launchctl kickstart -k gui/$(id -u)/$PREFIX.$SKILL" >> "$LOG"
    fi
  fi

  # A project's pass is over: its release checkout is no longer in use by
  # this runner, and any checkout nothing needs any more is removed (SP-276).
  # It never changes the pass's code or stops the runner.
  if [ -z "$OWN" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] && echo "[loop-runner] $(date "+%H:%M:%S") release: $line" >> "$LOG"
    done < <(node "$REPO/scripts/lib/releaseCheckout.mjs" finish --root "$REPO" --pid "$$" 2>>"$LOG")
  fi

  # The project's beat for this pass (SP-397), with the kind the usage-limit
  # guard read. With the guard off it reads nothing, so a pass that exited
  # non-zero is still told apart here by its exit alone: 124 is the time
  # limit, anything else blocked. Only the beat sees that; the sleep below
  # goes on PASS_KIND as before.
  BEAT_KIND="$PASS_KIND"
  if [ "$CODE" -ne 0 ] && [ "$BEAT_KIND" = "ran" ] && [ -z "$USAGE_LIMIT_SLEEP" ]; then
    if [ "$CODE" -eq 124 ]; then BEAT_KIND=timed-out; else BEAT_KIND=blocked; fi
  fi
  case "$BEAT_KIND" in
    stood-down)
      if [ "$GUARD_SECONDS" -gt 0 ]; then
        lane_heartbeat --stood-down "a usage limit closed this pass; the runner is sleeping ${GUARD_SECONDS}s until it resets"
      else
        lane_heartbeat --stood-down "${GUARD_WHY:-the pass stood down (exit $CODE); see $LOG}"
      fi ;;
    blocked) lane_heartbeat --blocked "${GUARD_WHY:-the pass exited $CODE; see $LOG for its report}" ;;
    timed-out) lane_heartbeat --timed-out "${GUARD_WHY:-the pass ran the full ${LOOP_PASS_LIMIT_SECONDS:-7200}s time limit and was stopped; see $LOG}" ;;
    *) lane_heartbeat ;;
  esac

  read_wake_time
  # A usage limit outranks the wake time (SP-396): the lane sleeps until the
  # limit says it resets. A wake sent during the pass is cleared, since the
  # closed window cannot answer it; one sent during the sleep ends it, and the
  # stand-down check above then decides.
  if [ "$PASS_KIND" = "stood-down" ] && [ "$GUARD_SECONDS" -gt 0 ]; then
    rm -f "$WAKE"
    echo "[loop-runner] $(date "+%H:%M:%S") usage limit — sleeping ${GUARD_SECONDS}s before the next /$SKILL, until the limit resets (in place of the ${INTERVAL}s wake time; a wake ends it early)" >> "$LOG"
    sleep_until_woken "$GUARD_SECONDS"
    continue
  fi
  echo "[loop-runner] $(date "+%H:%M:%S") sleeping ${INTERVAL}s before the next /$SKILL (a wake ends it early)" >> "$LOG"
  sleep_until_woken
done
