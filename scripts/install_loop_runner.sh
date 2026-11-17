#!/bin/bash
#
# Install (or remove) the Spirality loop jobs on THIS machine: loop-build,
# loop-review and loop-intake (each a launchd agent that keeps the committed
# runner alive, with its own lock and log),
# the relay (a launchd agent started every minute, which runs a pass when its
# wake time from the Settings page is up: every ten minutes by default) and, when
# the project config names a trackerPort, the tracker (a kept-alive web
# server, docs/TRACKER_MVP.md) with its nightly database backup.
#
#   ./scripts/install_loop_runner.sh              # install them all here
#   ./scripts/install_loop_runner.sh --status     # installed? running? locks? last pass?
#   ./scripts/install_loop_runner.sh --uninstall  # remove them all from here
#   ./scripts/install_loop_runner.sh --print-plists  # print the lane plists; writes and loads nothing
#
# Any of these takes --project <checkout> (SP-271): the same lanes for ANOTHER
# project, under that project's own launchdPrefix, log folder and short name,
# whose program is Spirality's runner in THIS folder and whose working folder
# is the project's checkout (so each pass works there, under its CLAUDE.md
# and `npm run verify`). The plists carry SPIRALITY_PROJECT, which the
# runners and Spirality's door read (SP-270). The tracker and its backup are
# Spirality's own service and are never installed for a project.
#
#   ./scripts/install_loop_runner.sh --status --project ~/WebApps/starcaster
#
# Installing or uninstalling for a project whose lanes still run its own copy
# of the loop replaces or stops them: that is the switch-over, a step Dane
# approves, so both refuse, naming the jobs, unless --take-over is given too.
# --project=~/... works too: the installer expands the leading ~ itself.
#
# Copied from StarCaster's installer. launchd starts a job at load, restarts a
# kept-alive one if it dies, and survives a reboot; a screen session does none
# of that. Labels are <launchdPrefix>.<job>, read from the project config, so
# a project's jobs sit beside another project's on the same machine without
# touching them.
#
# Every path is derived from where this script lives or read from the project
# config, never typed in.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() { echo "usage: $0 [--install | --uninstall | --status | --print-plists] [--project <checkout>] [--take-over]" >&2; }
ACTION=install
PROJECT_ARG=""
TAKE_OVER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project)            [ $# -ge 2 ] || { usage; exit 2; }; PROJECT_ARG="$2"; shift 2 ;;
    --project=*)          PROJECT_ARG="${1#--project=}"; shift ;;
    --take-over)          TAKE_OVER=yes; shift ;;
    --uninstall|--remove) ACTION=uninstall; shift ;;
    --status)             ACTION=status; shift ;;
    --print-plists)       ACTION=print; shift ;;
    --install)            ACTION=install; shift ;;
    *) usage; exit 2 ;;
  esac
done
# The lanes that run a Claude skill in a kept-alive loop, and the relay,
# which is a plain node pass on a timer. Different plist shapes, one installer.
SKILLS=(loop-build loop-review loop-intake)
RELAY=relay
TRACKER=tracker
BACKUP=tracker-backup
# When the nightly backup runs, in the machine's own time zone.
BACKUP_HOUR=3
BACKUP_MINUTE=15

# The PATH launchd gives the jobs. The installer checks the tools against
# THIS, not its own shell's PATH, because launchd is what will run them.
LAUNCHD_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin"

# The project's values: the label prefix, the log folder and the short name
# every log and lock file starts with (CLAUDE.md engineering rule 2). Always
# asked from Spirality's folder: with --project, SPIRALITY_PROJECT (set below)
# names the project's manifest; without it, the value is Spirality's own,
# never whichever manifest sits above the folder the installer was started
# from (SP-312: started in StarCaster's checkout, it read com.starcaster and
# would have written StarCaster's job names over StarCaster's own jobs).
config_value() { (cd "$REPO" && PATH="$LAUNCHD_PATH" node "$REPO/scripts/project_config.mjs" "$1"); }
# Spirality's OWN value, read before SPIRALITY_PROJECT is set (SP-271 review:
# started in StarCaster's folder, the clash guard compared StarCaster with
# itself).
own_config_value() { (unset SPIRALITY_PROJECT; config_value "$1"); }

# Which project (SP-271). PROJECT_DIR is empty for Spirality's own lanes, and
# then nothing below differs from before: a SPIRALITY_PROJECT left in the
# caller's shell is not an input here, only --project is. WORK is the checkout
# the lanes work in.
unset SPIRALITY_PROJECT
PROJECT_DIR=""
# A leading ~ is expanded here, because bash does not expand it after
# --project= (the space form gets it from the shell).
case "$PROJECT_ARG" in
  "~")   PROJECT_ARG="$HOME" ;;
  "~/"*) PROJECT_ARG="$HOME/${PROJECT_ARG#"~/"}" ;;
esac
if [ -n "$PROJECT_ARG" ]; then
  if [ ! -d "$PROJECT_ARG" ]; then
    echo "Refusing: --project names $PROJECT_ARG, which is not a folder on this machine." >&2
    exit 1
  fi
  PROJECT_DIR="$(cd "$PROJECT_ARG" && pwd)"
  # Spirality's own folder named as the project is Spirality's own lanes.
  [ "$(cd "$PROJECT_DIR" && pwd -P)" = "$(cd "$REPO" && pwd -P)" ] && PROJECT_DIR=""
fi
WORK="${PROJECT_DIR:-$REPO}"
if [ -n "$PROJECT_DIR" ]; then
  # A project whose prefix or short name is Spirality's own would install
  # over Spirality's jobs, or share their locks and logs. These two are
  # Spirality's own, read from its folder before SPIRALITY_PROJECT is set.
  OWN_PREFIX="$(own_config_value launchdPrefix)"
  OWN_SLUG="$(own_config_value projectSlug)"
  export SPIRALITY_PROJECT="$PROJECT_DIR"
  if [ "$(config_value launchdPrefix)" = "$OWN_PREFIX" ] || [ "$(config_value projectSlug)" = "$OWN_SLUG" ]; then
    echo "Refusing: $PROJECT_DIR/spirality.project.json names Spirality's own launchdPrefix ($OWN_PREFIX) or projectSlug ($OWN_SLUG), so its jobs would replace Spirality's own or share their locks and logs." >&2
    exit 1
  fi
fi
PREFIX="$(config_value launchdPrefix)"
LOG_DIR="$(config_value logDir)"
SLUG="$(config_value projectSlug)"
# The tracker's settings. An empty port means this project runs no tracker
# service here, and every tracker step below is skipped.
TRACKER_PORT="$(config_value trackerPort)"
TRACKER_HOST="$(config_value trackerHost)"
TRACKER_DATA_DIR="$(config_value trackerDataDir)"
TRACKER_DB="$TRACKER_DATA_DIR/tracker.db"
TRACKER_BACKUP_DIR="$TRACKER_DATA_DIR/backups"
tracker_configured() { [ -z "$PROJECT_DIR" ] && [ -n "$TRACKER_PORT" ]; }

# How often each job wakes by default, in seconds. The numbers live in one
# place, scripts/lib/loopSchedule.mjs, which the tracker's Pipeline Status pod
# reads too (SP-168). The wake time set on the Settings page (SP-236) wins
# over them once a job has read it, with no plist rewrite: a lane reads it
# before every sleep, and the relay's tick (relay_tick) reads it after every
# pass.
interval_of() { PATH="$LAUNCHD_PATH" node "$REPO/scripts/lib/loopSchedule.mjs" interval "$1"; }
relay_tick() { PATH="$LAUNCHD_PATH" node "$REPO/scripts/lib/loopSchedule.mjs" tick; }
# loaded_line and reload_job: read launchd's list safely, and replace a job
# only once the old one is really gone.
# shellcheck source=lib/launchd_reload.sh
source "$REPO/scripts/lib/launchd_reload.sh"
# gh_signed_in_as and gh_state: is the GitHub command-line tool signed in?
# shellcheck source=lib/gh_auth.sh
source "$REPO/scripts/lib/gh_auth.sh"

label_of() { echo "$PREFIX.$1"; }
plist_of() { echo "$HOME/Library/LaunchAgents/$(label_of "$1").plist"; }
log_of() { echo "$LOG_DIR/$SLUG-$1.log"; }
lock_of() { echo "$LOG_DIR/$SLUG-$1.lock"; }
wake_of() { echo "$LOG_DIR/$SLUG-$1.wake"; }

# The program a lane's plist starts, and the folder it starts in (SP-271), so
# --status says whether a project's lanes run Spirality's runner or the
# project's own copy.
# The first <string> after <key>$1</key> in plist $2, read as text (the
# installer writes one element a line), so it reads the same on any machine.
plist_string() {
  awk -v k="<key>$1</key>" 'found && /<string>/ { sub(/.*<string>/, ""); sub(/<\/string>.*/, ""); print; exit } index($0, k) { found = 1 }' "$2" 2>/dev/null
}
program_of() { case "$1" in "$RELAY") echo "$REPO/scripts/run_relay.sh" ;; *) echo "$REPO/scripts/loop_runner.sh" ;; esac; }
runs_line() {
  local job="$1" plist prog dir
  plist="$(plist_of "$job")"
  [ -f "$plist" ] || return 0
  prog="$(plist_string ProgramArguments "$plist")"; prog="${prog:-(could not read)}"
  dir="$(plist_string WorkingDirectory "$plist")"; dir="${dir:-(could not read)}"
  if [ "$prog" = "$(program_of "$job")" ]; then
    echo "runs:     Spirality's $(basename "$prog"), in $dir"
  else
    if [ -n "$PROJECT_DIR" ]; then
      echo "runs:     $prog, in $dir — NOT Spirality's runner in $REPO (the project's own copy)"
    else
      echo "runs:     $prog, in $dir — not the runner beside this installer ($REPO)"
    fi
  fi
}

status_one() {
  local job="$1" label plist lock log line
  label="$(label_of "$job")"; plist="$(plist_of "$job")"
  lock="$(lock_of "$job")"; log="$(log_of "$job")"
  echo "── $job"
  if [ -f "$plist" ]; then echo "schedule: INSTALLED at $plist"; else echo "schedule: not installed on this machine"; fi
  runs_line "$job"
  line="$(loaded_line "$label")"
  if [ -n "$line" ]; then
    echo "loaded:   yes — $line"
    if [ "$job" = "$RELAY" ]; then
      echo "          (columns: PID, last exit code, label. '-' for PID means not running right now, which is normal between passes; launchd starts it every $(relay_tick)s and it runs a pass when its wake time is up, $(interval_of "$job")s unless the Settings page says otherwise.)"
    else
      echo "          (columns: PID, last exit code, label. A PID here means the runner is alive right now.)"
    fi
  else
    echo "loaded:   no"
  fi
  if [ -d "$lock" ]; then
    local pid; pid="$(cat "$lock/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "lock:     held by live pid $pid — a pass is working"
    else echo "lock:     STALE (pid ${pid:-unrecorded} is gone) — the next start clears it"; fi
  else
    echo "lock:     none"
  fi
  # A lane's wake file (SP-219): the runner ends its sleep on it within seconds,
  # so one still here means the runner is mid-pass, or not running at all.
  if [ "$job" != "$RELAY" ] && [ -e "$(wake_of "$job")" ]; then
    echo "wake:     waiting at $(wake_of "$job") (sent $(date -r "$(wake_of "$job")" '+%Y-%m-%d %H:%M')) — the next pass starts as soon as this one ends"
  fi
  if [ -f "$log" ]; then
    echo "log:      $log (last modified $(date -r "$log" '+%Y-%m-%d %H:%M'))"
    if [ "$job" = "$RELAY" ]; then
      echo "last pass: $(grep -E "START relay" "$log" | tail -1 | sed 's/=//g' | xargs || echo '(none yet)')"
      echo "last end:  $(grep -E "END relay" "$log" | tail -1 | sed 's/=//g' | xargs || echo '(none yet)')"
      # The newest line of the application checks the relay runs after its
      # own pass (SP-274), so Dane can see when they last ran and what said.
      # A log with none yet is normal: grep finds nothing, and under pipefail
      # that would end the whole --status here, so it is caught.
      local checks; checks="$(grep -E '^app-checks:' "$log" | tail -1 | sed 's/^app-checks: *//' || true)"
      echo "app-checks: ${checks:-(none yet)}"
    else
      echo "last pass: $(grep -E "START /$job" "$log" | tail -1 | sed 's/=//g' | xargs || echo '(none yet)')"
    fi
  else
    echo "log:      $log (nothing written yet)"
  fi
}

# The runners only pull when the checkout is a clean main. On anything else
# every pass runs stale code and says so in one quiet log line, so say it
# loudly here instead.
checkout_state() {
  local branch dirty
  branch="$(git -C "$WORK" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  dirty="$(git -C "$WORK" status --porcelain 2>/dev/null)"
  if [ "$branch" = "main" ] && [ -z "$dirty" ]; then
    echo "checkout: $WORK on a clean main — each pass pulls the latest merged work"
  else
    echo "checkout: $WORK on branch '$branch'$([ -n "$dirty" ] && echo ', with uncommitted changes')"
    echo "WARNING:  the runners only pull a clean main, so every pass runs THIS code and never"
    echo "          picks up merged work. Put it back: git -C $WORK checkout main && git -C $WORK pull"
  fi
  if [ -n "$PROJECT_DIR" ]; then
    echo "runner:   Spirality's, from $REPO (a project's lanes pull its own main, never Spirality's)"
  fi
}

# The address to knock on: the configured host, or this machine itself when
# the server listens on every address.
tracker_url() {
  local host="$TRACKER_HOST"
  if [ "$host" = "0.0.0.0" ]; then host=127.0.0.1; fi
  echo "http://$host:$TRACKER_PORT"
}

status_job_header() {
  local job="$1" label plist line
  label="$(label_of "$job")"; plist="$(plist_of "$job")"
  echo "── $job"
  if [ -f "$plist" ]; then echo "schedule: INSTALLED at $plist"; else echo "schedule: not installed on this machine"; fi
  line="$(loaded_line "$label")"
  if [ -n "$line" ]; then echo "loaded:   yes — $line"; else echo "loaded:   no"; fi
}

status_tracker() {
  local log code newest
  if [ -n "$PROJECT_DIR" ]; then
    echo "── $TRACKER"
    echo "tracker:  Spirality's own service, never installed for a project (run --status without --project to see it)"
    return
  fi
  if ! tracker_configured; then
    echo "── $TRACKER"
    echo "tracker:  not run by this project (no trackerPort in the project config)"
    return
  fi
  status_job_header "$TRACKER"
  echo "          (columns: PID, last exit code, label. A PID here means the server is up right now.)"
  # /me without a token answers 401: the tracker's own answer to a knock with
  # no key. Silence, or any other answer, means it is not the tracker there.
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$(tracker_url)/me" 2>/dev/null || true)"
  if [ "$code" = "401" ]; then
    echo "answers:  yes — $(tracker_url) (listening on $TRACKER_HOST:$TRACKER_PORT)"
  else
    echo "answers:  NO — nothing answered at $(tracker_url)${code:+ (got HTTP $code)}"
  fi
  if [ -f "$TRACKER_DB" ]; then echo "database: $TRACKER_DB ($(du -h "$TRACKER_DB" | cut -f1 | xargs))"
  else echo "database: $TRACKER_DB (not created yet; the server makes it on first start)"; fi
  log="$(log_of "$TRACKER")"
  if [ -f "$log" ]; then echo "log:      $log (last modified $(date -r "$log" '+%Y-%m-%d %H:%M'))"
  else echo "log:      $log (nothing written yet)"; fi

  status_job_header "$BACKUP"
  echo "          (runs nightly at $(printf '%02d:%02d' "$BACKUP_HOUR" "$BACKUP_MINUTE"); '-' for PID is normal between runs.)"
  newest="$(ls -1 "$TRACKER_BACKUP_DIR"/tracker-*.db 2>/dev/null | tail -1 || true)"
  if [ -n "$newest" ]; then
    echo "backups:  $(ls -1 "$TRACKER_BACKUP_DIR"/tracker-*.db | wc -l | xargs) in $TRACKER_BACKUP_DIR, newest $(basename "$newest")"
  else
    echo "backups:  none yet in $TRACKER_BACKUP_DIR"
  fi
  log="$(log_of "$BACKUP")"
  if [ -f "$log" ]; then echo "last run: $(grep -E 'backup (OK|FAILED)' "$log" | tail -1 || echo '(none yet)')"
  else echo "last run: (none yet)"; fi
  # The copy off the Mini (tracker/offMiniCopy.mjs, docs/OFF_MINI_BACKUP.md).
  if [ -f "$log" ]; then echo "off-Mini: $(grep -E 'off-Mini copy (OK|FAILED|skipped)' "$log" | tail -1 || echo '(none yet)')"
  else echo "off-Mini: (none yet)"; fi
}

# The Spirality release this project's lanes run on (SP-276), and the release
# checkouts on this machine: one line each, from scripts/lib/releaseCheckout.mjs.
# Spirality's own lanes run main. A read that fails is said, never fatal.
release_state() {
  (cd "$REPO" && PATH="$LAUNCHD_PATH" node "$REPO/scripts/lib/releaseCheckout.mjs" status --root "$REPO" --project "$SLUG") \
    || echo "release:  could not be read (scripts/lib/releaseCheckout.mjs status failed; its line above says why)"
}

status() {
  echo "project:  $SLUG (labels $PREFIX.*, logs in $LOG_DIR)"
  release_state
  checkout_state
  PATH="$LAUNCHD_PATH" node "$REPO/scripts/lib/claudeTrust.mjs" check "$WORK" || true
  gh_state
  for s in "${SKILLS[@]}"; do status_one "$s"; done
  status_one "$RELAY"
  status_tracker
}

# The tracker server (kept alive, like the lanes) and its nightly backup (on
# a calendar, like nothing else here). Appends to not_loaded on failure.
install_tracker() {
  local node label plist log
  node="$(PATH="$LAUNCHD_PATH" command -v node)"
  mkdir -p "$TRACKER_DATA_DIR" "$TRACKER_BACKUP_DIR"

  label="$(label_of "$TRACKER")"; plist="$(plist_of "$TRACKER")"; log="$(log_of "$TRACKER")"
  cat > "$plist" <<PLIST_BODY
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$node</string>
        <string>--disable-warning=ExperimentalWarning</string>
        <string>$REPO/tracker/server.mjs</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO</string>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
$(plist_env TRACKER_DB "$TRACKER_DB" TRACKER_PORT "$TRACKER_PORT" TRACKER_HOST "$TRACKER_HOST")
    <key>StandardOutPath</key>
    <string>$log</string>
    <key>StandardErrorPath</key>
    <string>$log</string>
</dict>
</plist>
PLIST_BODY
  if reload_job "$label" "$plist"; then
    echo "Installed $label — kept alive, listening on $TRACKER_HOST:$TRACKER_PORT, database $TRACKER_DB, log $log."
  else
    not_loaded+=("$label")
  fi

  label="$(label_of "$BACKUP")"; plist="$(plist_of "$BACKUP")"; log="$(log_of "$BACKUP")"
  cat > "$plist" <<PLIST_BODY
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$node</string>
        <string>--disable-warning=ExperimentalWarning</string>
        <string>$REPO/tracker/backup.mjs</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>$BACKUP_HOUR</integer>
        <key>Minute</key>
        <integer>$BACKUP_MINUTE</integer>
    </dict>
$(plist_env TRACKER_DB "$TRACKER_DB" TRACKER_BACKUP_DIR "$TRACKER_BACKUP_DIR")
    <key>StandardOutPath</key>
    <string>$log</string>
    <key>StandardErrorPath</key>
    <string>$log</string>
</dict>
</plist>
PLIST_BODY
  if reload_job "$label" "$plist"; then
    echo "Installed $label — nightly at $(printf '%02d:%02d' "$BACKUP_HOUR" "$BACKUP_MINUTE") into $TRACKER_BACKUP_DIR (newest 14 kept), log $log."
  else
    not_loaded+=("$label")
  fi
}

uninstall() {
  # The tracker jobs are removed whether or not the config still names them;
  # their database and backups are left where they are.
  # A project's own copy of its lanes is stopped only with --take-over, the
  # same as installing over it (SP-271 review); first, so a refusal touches
  # nothing.
  refuse_unless_take_over uninstall
  local jobs=("${SKILLS[@]}" "$RELAY")
  # A project's uninstall touches only its lanes: the tracker is Spirality's.
  [ -n "$PROJECT_DIR" ] || jobs+=("$TRACKER" "$BACKUP")
  for s in "${jobs[@]}"; do
    launchctl bootout "gui/$(id -u)/$(label_of "$s")" 2>/dev/null || true
    rm -f "$(plist_of "$s")"
    echo "Removed $(label_of "$s") from this machine."
  done
  echo "Locks are left for the runners' own stale-lock handling. Confirm with: $0 --status"
  if [ -z "$PROJECT_DIR" ] && [ -n "$TRACKER_DATA_DIR" ]; then echo "The tracker's database and backups are left in $TRACKER_DATA_DIR."; fi
}

# plist_env [NAME VALUE]...: the environment block, PATH and HOME plus any
# extra pairs given.
plist_env() {
  echo "    <key>EnvironmentVariables</key>"
  echo "    <dict>"
  printf '        <key>%s</key>\n        <string>%s</string>\n' PATH "$LAUNCHD_PATH" HOME "$HOME" "$@"
  echo "    </dict>"
}

# The lanes' environment: for a project, SPIRALITY_PROJECT names its checkout,
# which the runners and Spirality's door read; for Spirality's own, the block
# is what it always was.
lane_env() {
  if [ -n "$PROJECT_DIR" ]; then plist_env SPIRALITY_PROJECT "$PROJECT_DIR"; else plist_env; fi
}

# A kept-alive lane's plist: the runner script loops forever, launchd restarts it.
lane_plist() {
  local s="$1" label llog
  label="$(label_of "$s")"
  llog="$HOME/Library/Logs/$label.launchd.log"
  cat <<PLIST_BODY
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(program_of "$s")</string>
        <string>$s</string>
        <string>$(interval_of "$s")</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$WORK</string>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>300</integer>
$(lane_env)
    <key>StandardOutPath</key>
    <string>$llog</string>
    <key>StandardErrorPath</key>
    <string>$llog</string>
</dict>
</plist>
PLIST_BODY
}

# The relay's plist: started on a short fixed tick with --tick, and
# run_relay.sh runs a pass only when the wake time set on the Settings page is
# up (SP-236), so changing it needs no plist rewrite. Its own output IS its
# log, so the plist points stdout and stderr at the log the status reader
# looks for; a tick that runs no pass writes nothing there.
relay_plist() {
  local label rlog
  label="$(label_of "$RELAY")"; rlog="$(log_of "$RELAY")"
  cat <<PLIST_BODY
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(program_of "$RELAY")</string>
        <string>--tick</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$WORK</string>
    <key>StartInterval</key>
    <integer>$(relay_tick)</integer>
    <key>RunAtLoad</key>
    <true/>
$(lane_env)
    <key>StandardOutPath</key>
    <string>$rlog</string>
    <key>StandardErrorPath</key>
    <string>$rlog</string>
</dict>
</plist>
PLIST_BODY
}

# Every lane plist install would write, each after a line naming its file;
# nothing is written or loaded. What the tests read, and a look before an
# install.
print_plists() {
  for s in "${SKILLS[@]}"; do echo "=== $(plist_of "$s")"; lane_plist "$s"; done
  echo "=== $(plist_of "$RELAY")"; relay_plist
}

# A project's lanes still running its own copy of the loop are only replaced
# with --take-over: that is the switch-over, Dane's step (SP-271).
# $1 is the verb named in the refusal: install and uninstall both replace or
# remove them, so both refuse.
refuse_unless_take_over() {
  local verb="$1"
  [ -n "$PROJECT_DIR" ] && [ -z "$TAKE_OVER" ] || return 0
  local s plist prog others=()
  for s in "${SKILLS[@]}" "$RELAY"; do
    plist="$(plist_of "$s")"
    [ -f "$plist" ] || continue
    prog="$(plist_string ProgramArguments "$plist")"; prog="${prog:-(could not read)}"
    [ "$prog" = "$(program_of "$s")" ] || others+=("$(label_of "$s") (runs $prog)")
  done
  [ "${#others[@]}" -eq 0 ] && return 0
  if [ "$verb" = uninstall ]; then
    echo "Refusing to uninstall: these jobs run something other than Spirality's runner (the project's own copy of the loop), and uninstalling would stop and remove them:" >&2
  else
    echo "Refusing to install: these jobs run something other than Spirality's runner, and installing would replace them:" >&2
  fi
  printf '  %s\n' "${others[@]}" >&2
  echo "That is part of switching the project over to Spirality's lanes, a step Dane approves. With his word, run again with --take-over." >&2
  exit 1
}

install() {
  # First of all, so a refused switch-over touches nothing (SP-271).
  refuse_unless_take_over install
  # Before anything is written: a signed-out gh would install a relay that
  # fails the first merge Dane asks for (SP-181).
  gh_require_signed_in || exit 1
  if [ -f "$REPO/.git" ] && grep -q '^gitdir:.*worktrees' "$REPO/.git" 2>/dev/null; then
    echo "Refusing to install: $REPO is a worktree, and worktrees get deleted when their work ships. Run this from the main checkout." >&2
    exit 1
  fi
  if [ -n "$PROJECT_DIR" ]; then
    if [ -f "$PROJECT_DIR/.git" ] && grep -q '^gitdir:.*worktrees' "$PROJECT_DIR/.git" 2>/dev/null; then
      echo "Refusing to install: $PROJECT_DIR is a worktree, and worktrees get deleted when their work ships. Name the project's main checkout." >&2
      exit 1
    fi
    if ! git -C "$PROJECT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
      echo "Refusing to install: $PROJECT_DIR is not a git checkout, so the lanes would have no main to pull." >&2
      exit 1
    fi
  fi
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$LOG_DIR"
  for bin in npm node doppler claude git gh; do
    if ! (PATH="$LAUNCHD_PATH" command -v "$bin" >/dev/null); then
      echo "Cannot find $bin on launchd's PATH ($LAUNCHD_PATH) — the jobs would install and then fail on every pass." >&2
      exit 1
    fi
  done
  if tracker_configured && [ -z "$TRACKER_DATA_DIR" ]; then
    echo "Refusing to install: the project config names trackerPort but no trackerDataDir, so the tracker has nowhere to keep its database." >&2
    exit 1
  fi
  if [ "$(git -C "$WORK" rev-parse --abbrev-ref HEAD)" != "main" ]; then
    echo "WARNING: $WORK is not on main. The jobs will install, but they never pull" >&2
    echo "         anything but a clean main, so they will run this branch's code until" >&2
    echo "         the checkout is put back on main." >&2
  fi
  chmod +x "$REPO/scripts/loop_runner.sh" "$REPO/scripts/run_with_time_limit.sh" "$REPO/scripts/run_relay.sh"

  # Jobs that could not be loaded. Every job is still tried; the list decides
  # the exit code at the end.
  not_loaded=()

  # Trust this checkout in Claude's own settings before any lane starts, or
  # every headless pass ignores the project's .claude/settings.json allow list
  # until somebody opens Claude here by hand (SP-116). A failure is said and
  # fails the run at the end, but the lanes still install: they run, only
  # without that list.
  trust_failed=""
  PATH="$LAUNCHD_PATH" node "$REPO/scripts/lib/claudeTrust.mjs" ensure "$WORK" || trust_failed=yes

  for s in "${SKILLS[@]}"; do
    local_label="$(label_of "$s")"; local_plist="$(plist_of "$s")"
    lane_plist "$s" > "$local_plist"
    if reload_job "$local_label" "$local_plist"; then
      echo "Installed $local_label — kept alive from $WORK (every $(interval_of "$s")s)."
    else
      not_loaded+=("$local_label")
    fi
  done

  local_label="$(label_of "$RELAY")"; local_plist="$(plist_of "$RELAY")"; local_rlog="$(log_of "$RELAY")"
  relay_plist > "$local_plist"
  if reload_job "$local_label" "$local_plist"; then
    echo "Installed $local_label — started every $(relay_tick)s from $WORK, a pass each time its wake time is up ($(interval_of "$RELAY")s unless the Settings page says otherwise), log $local_rlog."
  else
    not_loaded+=("$local_label")
  fi

  if tracker_configured; then install_tracker
  elif [ -n "$PROJECT_DIR" ]; then echo "Skipped the tracker: it is Spirality's own service, never installed for a project."
  else echo "Skipped the tracker: this project's config names no trackerPort."; fi
  echo
  status

  # One job failing to load does not stop the others from being tried, but the
  # run as a whole fails and says which (CLAUDE.md engineering rule 6).
  if [ "${#not_loaded[@]}" -gt 0 ]; then
    echo >&2
    echo "FAILED: ${#not_loaded[@]} job(s) are NOT loaded on this machine: ${not_loaded[*]}" >&2
    echo "        Run this installer again; if it fails the same way, check $0 --status." >&2
    exit 1
  fi
  if [ -n "$trust_failed" ]; then
    echo >&2
    echo "FAILED: $WORK is not marked trusted in Claude's settings (the FAILED: trust line above says why)." >&2
    echo "        The lanes are installed and run, but ignore .claude/settings.json's allow list until it is." >&2
    exit 1
  fi
}

case "$ACTION" in
  uninstall) uninstall ;;
  status)    status ;;
  print)     print_plists ;;
  install)   install ;;
esac
