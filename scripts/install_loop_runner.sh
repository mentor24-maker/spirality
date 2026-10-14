#!/bin/bash
#
# Install (or remove) the Spirality loop jobs on THIS machine: loop-build and
# loop-review (each a launchd agent that keeps the committed runner alive) and
# the relay (a launchd agent that runs one pass every ten minutes).
#
#   ./scripts/install_loop_runner.sh              # install all three here
#   ./scripts/install_loop_runner.sh --status     # installed? running? locks? last pass?
#   ./scripts/install_loop_runner.sh --uninstall  # remove all three from here
#
# Copied from StarCaster's installer. launchd starts a job at load, restarts a
# kept-alive one if it dies, and survives a reboot; a screen session does none
# of that. Labels are <launchdPrefix>.<job>, read from the project config, so
# a product's jobs sit beside another product's on the same machine without
# touching them.
#
# Every path is derived from where this script lives or read from the project
# config, never typed in.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The two lanes that run a Claude skill in a kept-alive loop, and the relay,
# which is a plain node pass on a timer. Different plist shapes, one installer.
SKILLS=(loop-build loop-review)
RELAY=relay

# The PATH launchd gives the jobs. The installer checks the tools against
# THIS, not its own shell's PATH, because launchd is what will run them.
LAUNCHD_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin"

# The product's values: the label prefix, the log folder and the short name
# every log and lock file starts with (CLAUDE.md engineering rule 2).
config_value() { PATH="$LAUNCHD_PATH" node "$REPO/scripts/project_config.mjs" "$1"; }
PREFIX="$(config_value launchdPrefix)"
LOG_DIR="$(config_value logDir)"
SLUG="$(config_value productSlug)"

interval_of() {
  case "$1" in
    loop-build)  echo 1800 ;;
    loop-review) echo 1800 ;;
    relay)       echo 600 ;;
    *)           echo 3600 ;;
  esac
}
label_of() { echo "$PREFIX.$1"; }
plist_of() { echo "$HOME/Library/LaunchAgents/$(label_of "$1").plist"; }
log_of() { echo "$LOG_DIR/$SLUG-$1.log"; }
lock_of() { echo "$LOG_DIR/$SLUG-$1.lock"; }

loaded_line() {
  # Read launchctl's list into a variable first. Piping it straight into
  # `grep -q` under pipefail reported a live lane as "loaded: no": grep quits
  # at the first match, launchctl dies of SIGPIPE, and the pipeline "fails".
  local listing
  listing="$(launchctl list 2>/dev/null || true)"
  awk -v l="$1" '$3 == l' <<<"$listing"
}

status_one() {
  local job="$1" label plist lock log line
  label="$(label_of "$job")"; plist="$(plist_of "$job")"
  lock="$(lock_of "$job")"; log="$(log_of "$job")"
  echo "── $job"
  if [ -f "$plist" ]; then echo "schedule: INSTALLED at $plist"; else echo "schedule: not installed on this machine"; fi
  line="$(loaded_line "$label")"
  if [ -n "$line" ]; then
    echo "loaded:   yes — $line"
    if [ "$job" = "$RELAY" ]; then
      echo "          (columns: PID, last exit code, label. '-' for PID means not running right now, which is normal between passes; it wakes every $(( $(interval_of "$job") / 60 )) minutes.)"
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
  if [ -f "$log" ]; then
    echo "log:      $log (last modified $(date -r "$log" '+%Y-%m-%d %H:%M'))"
    if [ "$job" = "$RELAY" ]; then
      echo "last pass: $(grep -E "START relay" "$log" | tail -1 | sed 's/=//g' | xargs || echo '(none yet)')"
      echo "last end:  $(grep -E "END relay" "$log" | tail -1 | sed 's/=//g' | xargs || echo '(none yet)')"
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
  branch="$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  dirty="$(git -C "$REPO" status --porcelain 2>/dev/null)"
  if [ "$branch" = "main" ] && [ -z "$dirty" ]; then
    echo "checkout: $REPO on a clean main — each pass pulls the latest merged work"
  else
    echo "checkout: $REPO on branch '$branch'$([ -n "$dirty" ] && echo ', with uncommitted changes')"
    echo "WARNING:  the runners only pull a clean main, so every pass runs THIS code and never"
    echo "          picks up merged work. Put it back: git -C $REPO checkout main && git -C $REPO pull"
  fi
}

status() {
  echo "product:  $SLUG (labels $PREFIX.*, logs in $LOG_DIR)"
  checkout_state
  for s in "${SKILLS[@]}"; do status_one "$s"; done
  status_one "$RELAY"
}

uninstall() {
  for s in "${SKILLS[@]}" "$RELAY"; do
    launchctl bootout "gui/$(id -u)/$(label_of "$s")" 2>/dev/null || true
    rm -f "$(plist_of "$s")"
    echo "Removed $(label_of "$s") from this machine."
  done
  echo "Locks are left for the runners' own stale-lock handling. Confirm with: $0 --status"
}

plist_env() {
  cat <<ENV_BODY
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$LAUNCHD_PATH</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
ENV_BODY
}

install() {
  if [ -f "$REPO/.git" ] && grep -q '^gitdir:.*worktrees' "$REPO/.git" 2>/dev/null; then
    echo "Refusing to install: $REPO is a worktree, and worktrees get deleted when their work ships. Run this from the main checkout." >&2
    exit 1
  fi
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$LOG_DIR"
  for bin in npm node doppler claude git gh; do
    if ! (PATH="$LAUNCHD_PATH" command -v "$bin" >/dev/null); then
      echo "Cannot find $bin on launchd's PATH ($LAUNCHD_PATH) — the jobs would install and then fail on every pass." >&2
      exit 1
    fi
  done
  if [ "$(git -C "$REPO" rev-parse --abbrev-ref HEAD)" != "main" ]; then
    echo "WARNING: $REPO is not on main. The jobs will install, but they never pull" >&2
    echo "         anything but a clean main, so they will run this branch's code until" >&2
    echo "         the checkout is put back on main." >&2
  fi
  chmod +x "$REPO/scripts/loop_runner.sh" "$REPO/scripts/run_with_time_limit.sh" "$REPO/scripts/run_relay.sh"

  # The two kept-alive lanes: the runner script loops forever, launchd restarts it.
  for s in "${SKILLS[@]}"; do
    local_label="$(label_of "$s")"; local_plist="$(plist_of "$s")"
    local_llog="$HOME/Library/Logs/$local_label.launchd.log"
    cat > "$local_plist" <<PLIST_BODY
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$local_label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$REPO/scripts/loop_runner.sh</string>
        <string>$s</string>
        <string>$(interval_of "$s")</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO</string>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>300</integer>
$(plist_env)
    <key>StandardOutPath</key>
    <string>$local_llog</string>
    <key>StandardErrorPath</key>
    <string>$local_llog</string>
</dict>
</plist>
PLIST_BODY
    launchctl bootout "gui/$(id -u)/$local_label" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$local_plist"
    echo "Installed $local_label — kept alive from $REPO (every $(interval_of "$s")s)."
  done

  # The relay: one pass per wake, on a timer. Its own output IS its log, so the
  # plist points stdout and stderr at the log the status reader looks for.
  local_label="$(label_of "$RELAY")"; local_plist="$(plist_of "$RELAY")"; local_rlog="$(log_of "$RELAY")"
  cat > "$local_plist" <<PLIST_BODY
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$local_label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$REPO/scripts/run_relay.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO</string>
    <key>StartInterval</key>
    <integer>$(interval_of "$RELAY")</integer>
    <key>RunAtLoad</key>
    <true/>
$(plist_env)
    <key>StandardOutPath</key>
    <string>$local_rlog</string>
    <key>StandardErrorPath</key>
    <string>$local_rlog</string>
</dict>
</plist>
PLIST_BODY
  launchctl bootout "gui/$(id -u)/$local_label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$local_plist"
  echo "Installed $local_label — one pass every $(( $(interval_of "$RELAY") / 60 )) minutes from $REPO, log $local_rlog."
  echo
  status
}

case "${1:-}" in
  --uninstall|--remove) uninstall ;;
  --status)             status ;;
  ""|--install)         install ;;
  *) echo "usage: $0 [--install | --uninstall | --status]" >&2; exit 2 ;;
esac
