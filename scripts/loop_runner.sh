#!/bin/bash
# Run one Spirality loop skill on a fixed interval, forever.
#
#   loop_runner.sh <skill-name> [interval-seconds]
#
# A seed-sized copy of StarCaster's scripts/loop_runner.sh: the lock, the
# pull-before-pass, the time limit and the honest END line are kept; the
# queue-paced sleeping, heartbeat and usage-limit guard are left out until
# Spirality has an incident that needs them.
#
# Each iteration is a FRESH headless Claude Code session started in the main
# checkout. Both loop skills pick the next ticket from ClickUp on every run,
# so there is no state to carry between runs, and a crashed run costs one
# interval rather than the whole night.
#
# --allowedTools is used instead of --dangerously-skip-permissions so the
# repo's PreToolUse hook (no edits on main) still applies. A headless run
# cannot answer a permission prompt, so anything not listed is refused and
# the run continues.
set -u

# launchd hands the job almost no environment. Set the PATH once, here.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

SKILL=${1:?usage: loop_runner.sh <skill-name> [interval-seconds]}
INTERVAL=${2:-1800}

# The repo is WHERE THIS SCRIPT LIVES, never a path typed from memory, and it
# must be the MAIN checkout: a worktree is deleted when its work ships.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$REPO/.git" ] && grep -q '^gitdir:.*worktrees' "$REPO/.git" 2>/dev/null; then
  echo "[loop-runner] Refusing to run from a worktree ($REPO) — worktrees are deleted when their work ships." >&2
  exit 1
fi

LOG="$HOME/loop-logs/spirality-$SKILL.log"
LOCK="$HOME/loop-logs/spirality-$SKILL.lock"
mkdir -p "$HOME/loop-logs"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || echo "$HOME/.local/bin/claude")}"

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

# The sync lock both lanes take around pull + npm ci. Wait up to 10 minutes
# for the other lane; a lock whose pid is gone is cleared, as above.
SYNC_LOCK="$HOME/loop-logs/spirality-sync.lock"
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

PASS_OUT="$(mktemp -t spirality-pass)"
trap 'rm -rf "$LOCK" "$PASS_OUT" 2>/dev/null; [ "$(cat "$SYNC_LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$SYNC_LOCK"' EXIT

cd "$REPO" || exit 1

while true; do
  # 1. A timid pull: only main, only a clean tree, only fast-forward. A refusal
  #    is logged but never blocks the pass. Both lanes share this checkout, so
  #    the pull and `npm ci` happen under one shared lock: two at once collide
  #    on .git/index.lock and rebuild node_modules under each other.
  if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "main" ] && [ -z "$(git status --porcelain)" ]; then
    if take_sync_lock; then
      git pull -q --ff-only origin main >> "$LOG" 2>&1 || echo "[loop-runner] $(date "+%H:%M:%S") pull of main refused (see above) — running on the checkout as it is" >> "$LOG"
      # Dependencies follow the lockfile, so a merged change to package.json takes effect on the next pass.
      npm ci --silent >> "$LOG" 2>&1 || echo "[loop-runner] $(date "+%H:%M:%S") npm ci failed — running with the node_modules already present" >> "$LOG"
      rm -rf "$SYNC_LOCK"
    else
      echo "[loop-runner] $(date "+%H:%M:%S") the other lane held the sync lock for 10 minutes — not pulling this pass" >> "$LOG"
    fi
  else
    echo "[loop-runner] $(date "+%H:%M:%S") main checkout is not on a clean main — not pulling. Every pass runs stale code until it is put back on main." >> "$LOG"
  fi

  echo "" >> "$LOG"
  echo "===== $(date "+%Y-%m-%d %H:%M:%S") START /$SKILL =====" >> "$LOG"
  # The pass's output goes to the log as it happens AND to its own file, so
  # the sign-in check below reads this pass only, not an older one.
  "$REPO/scripts/run_with_time_limit.sh" "${LOOP_PASS_LIMIT_SECONDS:-7200}" -- \
    "$CLAUDE_BIN" -p "/$SKILL" \
    --allowedTools Bash Edit Write Read Glob Grep Task TodoWrite WebFetch \
    2>&1 | tee "$PASS_OUT" >> "$LOG"
  CODE=${PIPESTATUS[0]}
  # `claude -p` exits 0 whenever it produced output, so the code is a fact
  # about the process, not a verdict on the pass. The pass's own report is.
  echo "===== $(date "+%Y-%m-%d %H:%M:%S") END /$SKILL (exit $CODE — not a verdict; the pass's report above is) =====" >> "$LOG"
  if [ "$CODE" -eq 124 ]; then
    echo "[loop-runner] the pass hit the ${LOOP_PASS_LIMIT_SECONDS:-7200}s time limit and was stopped; its ticket may still be in Building — the next pass or a person should hand it back." >> "$LOG"
  fi
  # Only Claude's own sign-in errors, and only in this pass's last lines: a
  # pass that merely mentions "not logged in" (gh, supabase) is not one.
  if tail -20 "$PASS_OUT" | grep -qiE "OAuth session expired|Failed to authenticate|Invalid API key|Please run /login"; then
    echo "[loop-runner] $(date "+%H:%M:%S") THIS PASS COULD NOT SIGN IN TO CLAUDE. Nothing will change until a person signs in on this machine (claude login) and restarts this job: launchctl kickstart -k gui/$(id -u)/com.spirality.$SKILL" >> "$LOG"
  fi

  echo "[loop-runner] $(date "+%H:%M:%S") sleeping ${INTERVAL}s before the next /$SKILL" >> "$LOG"
  sleep "$INTERVAL"
done
