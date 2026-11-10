# Sourced, not run: the GitHub sign-in helpers install_loop_runner.sh uses,
# kept in their own file so scripts/lib/ghAuth.test.mjs can drive them against
# a fake gh.
#
# The relay merges pull requests with the GitHub command-line tool (gh), so a
# signed-out gh used to be found only when a merge Dane asked for failed
# (SP-181). Asked the way launchd will run it: the caller's LAUNCHD_PATH (or
# this shell's PATH when there is none), this user's HOME.

gh_signed_in_as() {
  local out
  out="$(PATH="${LAUNCHD_PATH:-$PATH}" gh auth status --hostname github.com 2>&1)" || return 1
  # "Logged in to github.com account NAME (...)" on gh 2.40 and later,
  # "Logged in to github.com as NAME (...)" before that.
  printf '%s\n' "$out" | sed -nE 's/.*Logged in to github\.com (account|as) ([^ ]+).*/\2/p' | head -1
}

gh_state() {
  local who
  if ! (PATH="${LAUNCHD_PATH:-$PATH}" command -v gh >/dev/null); then
    echo "gh:       NOT FOUND on launchd's PATH — the relay cannot merge pull requests"
  elif who="$(gh_signed_in_as)"; then
    echo "gh:       signed in as ${who:-(an account gh did not name)}"
  else
    echo "gh:       NOT signed in — the relay cannot merge pull requests until Dane runs: gh auth login"
  fi
}


# The installer's first step. A missing gh passes here: the installer's own
# tool check names it with the others. A signed-out one is refused in plain
# words, before anything is written.
gh_require_signed_in() {
  if ! (PATH="${LAUNCHD_PATH:-$PATH}" command -v gh >/dev/null); then return 0; fi
  if gh_signed_in_as >/dev/null; then return 0; fi
  echo "Refusing to install: the GitHub command-line tool (gh) is not signed in, and the relay" >&2
  echo "merges pull requests with it, so the first merge Dane asks for would fail." >&2
  echo "Signing in is a browser login, so it is Dane's: run  gh auth login  in Terminal," >&2
  echo "then run this installer again. Nothing was installed." >&2
  return 1
}
