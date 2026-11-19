# Sourced, not run: the step both runners (loop_runner.sh, run_relay.sh) take
# before their timid pull, kept in its own file so
# scripts/lib/backToMain.test.mjs can drive it against real scratch
# repositories.
#
# A new project's lanes are installed from its setup branch (SP-111), so its
# own relay can merge that branch on Dane's word. The merge deletes the branch
# at origin, and the runners only ever pull a clean main: left alone, the
# checkout would stay on the merged branch and every pass after it would run
# stale code. So when the checkout is on a branch that no longer exists on
# origin and no tracked file has changed, put it back on main.
#
# Untracked files alone do not block the move (SP-393): PressPlay's checkout
# sat on its merged setup branch for 13 days over nothing but an untracked
# .claude/worktrees/ folder. An untracked file that main tracks still blocks
# it, because git checkout refuses to overwrite it and is never forced.
#
# Anything less certain changes nothing: a changed tracked file is somebody's
# work, a branch still on origin is still in use, and an origin that cannot be
# asked is "could not tell", never "gone". Every time it declines on a branch
# that is gone from origin, it says why in one line.

# back_to_main_if_merged: prints one line when it moved the checkout, or when
# it could not and why; prints nothing when there was nothing to do. Returns 0
# when the checkout is on main at the end, 1 otherwise. Never exits.
back_to_main_if_merged() {
  local branch code changed
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || return 1
  [ "$branch" = "main" ] && return 0
  # A detached HEAD is not a branch that can have been deleted.
  [ "$branch" = "HEAD" ] && return 1
  # Tracked changes only; the first one is named if the branch turns out gone.
  changed="$(git status --porcelain --untracked-files=no 2>/dev/null | head -n 1 | cut -c4-)"
  git ls-remote --exit-code --heads origin "refs/heads/$branch" >/dev/null 2>&1
  code=$?
  # --exit-code: 0 the branch is there, 2 the branch is not, anything else is
  # git failing to ask (no network, no origin, no sign-in).
  case "$code" in
    0) return 1 ;;
    2) ;;
    *) echo "could not tell whether $branch still exists on origin (git ls-remote exit $code) — staying on it"; return 1 ;;
  esac
  if [ -n "$changed" ]; then
    echo "$branch no longer exists on origin, but the tree has changes ($changed) — staying on it"
    return 1
  fi
  if git checkout -q main 2>/dev/null; then
    # The local main may be from before the setup branch (no runner scripts
    # yet). Bring it up to origin's now, so a failed pull after this step
    # still leaves the scripts launchd runs next; a failure here changes
    # nothing and the runner's own pull follows.
    git fetch -q origin main 2>/dev/null && git merge -q --ff-only origin/main 2>/dev/null
    echo "$branch no longer exists on origin and the tree is clean — back to main"
    return 0
  fi
  echo "$branch no longer exists on origin, but checking out main FAILED — staying on $branch"
  return 1
}
