#!/bin/bash
# A dry run of the setup wizard's lanes step for a throwaway project (SP-273).
#
#   scripts/dry_onboard_lanes.sh
#
# Makes a new project with no loop code in it: a git folder with its own
# origin, whose main holds one file and whose spirality-setup branch adds only
# a settings file (spirality.project.json), the way the copy step now leaves
# a new project. A stand-in `gh`, first on PATH for this run only, answers for
# its setup pull request. Then it runs `npm run onboard:lanes -- --dry-run`
# twice:
#
#   1. with the checkout on main: it says it would move to the branch and run
#      Spirality's installer, naming that installer's path in Spirality's
#      folder (the project has none of its own);
#   2. with the checkout on the branch: it asks Spirality's installer, for
#      real, `--status --project <checkout>` (read-only), and says it would
#      install the lanes with it.
#
# Nothing is installed, no ticket is filed, the tracker and GitHub are never
# reached, and the throwaway folder is deleted afterwards.
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/dry-onboard-lanes.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
PROJECT="$WORK/dryproject"
BRANCH=spirality-setup
PR=https://github.com/example/dryproject/pull/1

g() { git -C "$PROJECT" -c user.name=dry -c user.email=dry@example.invalid "$@"; }
git init -q --bare "$WORK/origin.git" && git init -q -b main "$PROJECT" \
  && g remote add origin "$WORK/origin.git" \
  && echo "# dryproject" > "$PROJECT/README.md" && g add README.md && g commit -q -m "a project" && g push -q origin main \
  || { echo "dry run: could not make the throwaway project" >&2; exit 1; }
g checkout -q -b "$BRANCH"
node -e '
const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const keep = ["manifestVersion", "workspaceId", "spaceId", "loopQueueListId", "operatorUserId", "machineUserId", "dopplerConfig",
  "logDir", "mergePhrases", "governancePaths", "autoMergeLanes", "operatorName", "legacyMachinePrefixes", "projectScripts", "tracker", "trackerUrl", "trackerApiUrl"];
const out = Object.fromEntries(keep.filter((k) => k in c).map((k) => [k, c[k]]));
Object.assign(out, { githubRepo: "example/dryproject", dopplerProject: "dryproject", launchdPrefix: "com.dryproject.dryrun",
  projectSlug: "dryproject", trackerPrefix: "DRY", busProject: "dryproject-bus" });
process.stdout.write(JSON.stringify(out, null, 2) + "\n");' "$REPO/spirality.project.json" > "$PROJECT/spirality.project.json" \
  && g add spirality.project.json && g commit -q -m "settings file" && g push -q origin "$BRANCH" \
  && TICKET_URL="$(node -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(`${c.trackerUrl}/t/DRY-1`)' "$PROJECT/spirality.project.json")" \
  && g checkout -q main \
  || { echo "dry run: could not write the throwaway project's settings file" >&2; exit 1; }

# The stand-in gh: the setup pull request, open, from the branch, already linked to a ticket.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<'GH'
#!/bin/bash
if [ "$1 $2" = "pr view" ]; then
  echo '{"title":"Add dryproject'"'"'s Spirality settings file and verify check","body":"The setup.\n\nTicket: '"$DRY_TICKET_URL"'","headRefName":"spirality-setup","state":"OPEN"}'
  exit 0
fi
echo "stand-in gh: only pr view is answered (got: $*)" >&2; exit 1
GH
chmod +x "$WORK/bin/gh"

echo "project:   $PROJECT (its files on main: $(ls "$PROJECT" | tr "\n" " "))"
echo "Spirality: $REPO"
CODE=0
for round in "on main" "on $BRANCH"; do
  [ "$round" = "on $BRANCH" ] && g checkout -q "$BRANCH"
  echo "--- the lanes step's dry run, with the checkout $round"
  (cd "$REPO" && PATH="$WORK/bin:$PATH" DRY_TICKET_URL="$TICKET_URL" \
    node scripts/onboard/lanes.mjs --checkout "$PROJECT" --branch "$BRANCH" --pr "$PR" --dry-run) || CODE=1
done
echo "---"
exit "$CODE"
