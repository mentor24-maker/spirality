#!/bin/bash
#
# May this lane start a pass? Asked by scripts/loop_runner.sh before every
# pass and by scripts/run_relay.sh before its lock (SP-237).
#
#   scripts/pause_check.sh <lane>
#
# Prints one line, the verdict in words, and exits 0 (run) or non-zero (do
# not start a pass). The answer is the Settings page's two switches for this
# project, the whole pipeline and this lane, read through the door
# (`npm run clickup -- pause-check`, lib/pipelinePause.js
# settingsPauseVerdict), which signs in as the lane's own TRACKER_TOKEN_NAME.
#
# The runners treat ANY non-zero exit as paused: a check that could not run
# at all (no npm, no Doppler, a broken checkout) must stop a pass the same way
# a paused switch does, never let it through. It is its own file so a test can
# put a stand-in in its place beside a copy of a runner.
set -u
LANE=${1:?usage: pause_check.sh <lane>}
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1
exec npm run --silent clickup -- pause-check --lane "$LANE"
