#!/bin/bash
# Store the lanes' long-lived Claude sign-in in Doppler (SP-385).
#
#   bash scripts/claude_token_to_doppler.sh
#
# Run it on the machine the lanes run on, by the person whose Claude account
# the loops run on, right after `claude setup-token` (a browser login that
# prints a token made for unattended jobs, good for about a year). It asks
# for the token without showing it, writes it to Doppler as
# CLAUDE_CODE_OAUTH_TOKEN in the Doppler project and config this folder's
# manifest names (dopplerProject, dopplerConfig), and reads it back to check
# it arrived whole. It never prints the token, and nothing it runs carries
# the token on a command line (`ps` shows those): the value goes to doppler
# on standard input. Every lane's next pass reads it (scripts/loop_runner.sh,
# read_claude_token), so nothing needs restarting.
#
# Agent sessions are refused Doppler writes, so this is the operator's step.
# Exits 0 when the key is set and reads back the same; 1 when anything
# failed, saying what; 2 when no token was given.
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

KEY=CLAUDE_CODE_OAUTH_TOKEN
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOPPLER_BIN="${DOPPLER_BIN:-$(command -v doppler || true)}"

fail() { echo "NOT stored: $*" >&2; exit 1; }

[ -n "$DOPPLER_BIN" ] && [ -x "$DOPPLER_BIN" ] || fail "there is no doppler on this machine (brew install dopplerhq/cli/doppler, then doppler login)."
# This folder's own manifest, never a project's that SPIRALITY_PROJECT names:
# the lanes read the token from here.
PROJECT="$(cd "$REPO" && SPIRALITY_PROJECT='' node "$REPO/scripts/project_config.mjs" dopplerProject)" || fail "could not read dopplerProject from $REPO's project config."
CONFIG="$(cd "$REPO" && SPIRALITY_PROJECT='' node "$REPO/scripts/project_config.mjs" dopplerConfig)" || fail "could not read dopplerConfig from $REPO's project config."
[ -n "$PROJECT" ] && [ -n "$CONFIG" ] || fail "$REPO's project config names no Doppler project and config."

echo "This stores the lanes' Claude sign-in as $KEY in Doppler $PROJECT/$CONFIG."
echo "Make the token first with: claude setup-token"
printf 'Paste the token (it will not show), then press Return: '
TOKEN=""
IFS= read -rs TOKEN
echo ""
# A paste can carry a stray carriage return or spaces at either end.
TOKEN="${TOKEN//$'\r'/}"
TOKEN="${TOKEN#"${TOKEN%%[![:space:]]*}"}"
TOKEN="${TOKEN%"${TOKEN##*[![:space:]]}"}"
if [ -z "$TOKEN" ]; then
  echo "NOT stored: no token was pasted. Run claude setup-token, then run this again." >&2
  exit 2
fi
if [[ "$TOKEN" =~ [[:space:]] ]]; then
  TOKEN=""
  fail "what was pasted has spaces or line breaks inside it, so it is not one token. Copy just the token claude setup-token printed and run this again."
fi

# The value goes in on standard input; doppler's own output (a table that
# includes the value) is thrown away, never shown.
if ! printf '%s' "$TOKEN" | "$DOPPLER_BIN" secrets set "$KEY" --project "$PROJECT" --config "$CONFIG" --silent >/dev/null 2>&1; then
  TOKEN=""
  fail "Doppler refused the write to $PROJECT/$CONFIG (is this machine signed in to Doppler, with write access? doppler login). Nothing changed."
fi

BACK="$("$DOPPLER_BIN" secrets get "$KEY" --plain --project "$PROJECT" --config "$CONFIG" 2>/dev/null)"
CODE=$?
SAME=""
[ "$CODE" -eq 0 ] && [ "$BACK" = "$TOKEN" ] && SAME=yes
TOKEN=""
BACK=""
if [ "$CODE" -ne 0 ]; then
  fail "the write was sent, but $KEY could not be read back from Doppler $PROJECT/$CONFIG (doppler exited $CODE), so it is not known to be there. Run this again."
fi
[ -n "$SAME" ] || fail "$KEY in Doppler $PROJECT/$CONFIG reads back different from what was pasted. Run this again."

echo "Stored: $KEY is set in Doppler $PROJECT/$CONFIG and reads back the same (the value is not shown)."
echo "Every lane's next pass signs in with it; its log says \"signs in to Claude with $KEY from Doppler $PROJECT/$CONFIG\"."
