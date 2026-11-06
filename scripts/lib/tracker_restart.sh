# Sourced, not run: the step both runners (loop_runner.sh, run_relay.sh) take
# right after their timid pull, kept in its own file so
# scripts/lib/trackerRestart.test.mjs can drive it against real scratch
# repositories and a stand-in launchctl.
#
# A pull only replaces files on disk. The tracker server keeps running the
# code it started with until it is restarted, so on 2026-11-06 the Mini's
# tracker had been up since Nov 4 and was missing about 16 merges (SP-150).
# So when a pull moved HEAD and the change touches tracker/, restart the
# tracker's launchd job and check it answers again.
#
# Nothing project-specific lives here: the caller passes the launchd label
# prefix and the port, both read from the project config. An empty port means
# the project runs no tracker, and the step does nothing.

# restart_tracker_if_changed OLD NEW PREFIX PORT
#   OLD, NEW  HEAD before and after the pull.
#   PREFIX    the project's launchdPrefix; the job is <PREFIX>.tracker.
#   PORT      the project's trackerPort; empty = no tracker, nothing to do.
# Prints one line when it restarted (or failed to), nothing when there was
# nothing to do. Returns 0 when nothing needed doing or the restart came back,
# 1 when the restart failed, the server did not answer, or it could not tell.
# Never exits. TRACKER_RESTART_WAIT (seconds, default 20) bounds the wait.
restart_tracker_if_changed() {
  local old="$1" new="$2" prefix="$3" port="$4"
  local range code waited=0 limit="${TRACKER_RESTART_WAIT:-20}" answer
  [ -z "$port" ] && return 0
  [ -z "$old" ] || [ -z "$new" ] || [ "$old" = "$new" ] && return 0
  range="$(git rev-parse --short "$old" 2>/dev/null)..$(git rev-parse --short "$new" 2>/dev/null)"
  git diff --quiet "$old" "$new" -- tracker/ 2>/dev/null
  code=$?
  # --quiet: 0 no change under tracker/, 1 a change, anything else is git
  # failing to compare.
  case "$code" in
    0) return 0 ;;
    1) ;;
    *) echo "TRACKER NOT RESTARTED: could not tell whether $range touches tracker/ (git diff exit $code) — the server may be running old code; restart it with launchctl kickstart -k gui/$(id -u)/$prefix.tracker"; return 1 ;;
  esac
  if [ -z "$prefix" ]; then
    echo "TRACKER NOT RESTARTED for $range: the project config names no launchdPrefix — the server is running old code"
    return 1
  fi
  if ! launchctl kickstart -k "gui/$(id -u)/$prefix.tracker" >/dev/null 2>&1; then
    echo "TRACKER RESTART FAILED for $range: launchctl kickstart -k gui/$(id -u)/$prefix.tracker did not succeed — the server may be down or running old code"
    return 1
  fi
  # Any HTTP answer at all (/me with no token answers 401) means the server is
  # up; curl prints 000 when nothing answered.
  while :; do
    answer="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$port/me" 2>/dev/null || true)"
    if [ -n "$answer" ] && [ "$answer" != "000" ]; then
      echo "tracker restarted for $range"
      return 0
    fi
    [ "$waited" -ge "$limit" ] && break
    sleep 1; waited=$((waited + 1))
  done
  echo "TRACKER RESTART DID NOT COME BACK for $range: nothing answered on port $port within ${limit}s of launchctl kickstart -k gui/$(id -u)/$prefix.tracker — check the tracker log"
  return 1
}
