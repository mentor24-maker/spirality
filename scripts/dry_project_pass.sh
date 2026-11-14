#!/bin/bash
# A dry lane pass for a throwaway project with no .claude/ folder (SP-272).
#
#   scripts/dry_project_pass.sh [skill]      # default: loop-build
#
# Starts one real Claude Code session the way scripts/loop_runner.sh starts a
# project's pass: in the project's checkout (here, a new empty git folder on
# main, with no .claude/ folder and no manifest), handed Spirality's plugin
# folder with --plugin-dir, asking for /<plugin>:<skill>. It shows that the
# session finds the skill and that the no-edits-on-main hook refuses an edit,
# both from Spirality's folder alone.
#
# Dry: the session may use only Write (on main, so the hook refuses it). It
# has no Bash, so it cannot reach the tracker, git or anything else, and it
# is told not to follow the skill's steps. The throwaway folder is deleted
# afterwards. It makes one short Claude call.
set -u

SKILL="${1:-loop-build}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$REPO/plugin"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || echo "$HOME/.local/bin/claude")}"
PLUGIN_NAME="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).name || ""))' "$PLUGIN_DIR/.claude-plugin/plugin.json" 2>/dev/null)"
[ -n "$PLUGIN_NAME" ] || { echo "dry pass: no plugin name in $PLUGIN_DIR/.claude-plugin/plugin.json" >&2; exit 1; }

PROJECT="$(mktemp -d "${TMPDIR:-/tmp}/dry-project.XXXXXX")"
trap 'rm -rf "$PROJECT"' EXIT
git -C "$PROJECT" init -q -b main && git -C "$PROJECT" -c user.name=dry -c user.email=dry@example.invalid commit -q --allow-empty -m "empty project" \
  || { echo "dry pass: could not make the throwaway project" >&2; exit 1; }

echo "project:  $PROJECT (on main; .claude/ folder: $([ -e "$PROJECT/.claude" ] && echo present || echo none))"
echo "skills:   $PLUGIN_DIR (--plugin-dir), asking for /$PLUGIN_NAME:$SKILL"
echo "---"
cd "$PROJECT" || exit 1
SPIRALITY_PROJECT="$PROJECT" "$CLAUDE_BIN" -p "/$PLUGIN_NAME:$SKILL" \
  --plugin-dir "$PLUGIN_DIR" \
  --allowedTools Write --disallowedTools Bash \
  --append-system-prompt "THIS IS A DRY RUN of Spirality's lane set-up, not a real pass. Do NOT follow the skill's steps. Do exactly two things: (1) print the line 'SKILL FOUND: ' followed by the skill's first '#' heading and then its first workflow step, quoted word for word; (2) use the Write tool once to create probe.txt in the current folder containing 'hi', and print 'EDIT ON MAIN: ' followed by exactly what the tool answered. Then stop." \
  < /dev/null
CODE=$?
echo "---"
if [ -e "$PROJECT/probe.txt" ]; then
  echo "dry pass: probe.txt WAS written on main — the no-edits-on-main hook did not run" >&2
  exit 1
fi
echo "probe.txt was not written: no edits on main"
exit "$CODE"
