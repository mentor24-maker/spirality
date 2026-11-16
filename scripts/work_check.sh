#!/bin/bash
#
# Does this lane have anything to act on? Asked by scripts/loop_runner.sh
# before it starts a Claude session (SP-292).
#
#   scripts/work_check.sh <lane>
#
# Prints one line saying why and exits 3 when there is no work (the runner
# skips the Claude session), 0 when there is or when it could not tell. The
# runner starts the pass on ANY exit but 3, so a check that cannot run at all
# (no node, a broken checkout) never holds a ticket up. The questions are
# asked through the door, with the lane's own TRACKER_TOKEN_NAME
# (scripts/lib/workCheck.mjs). It is its own file so a test can put a
# stand-in in its place beside a copy of the runner.
set -u
LANE=${1:?usage: work_check.sh <lane>}
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1
exec node "$REPO/scripts/lib/workCheck.mjs" "$LANE"
