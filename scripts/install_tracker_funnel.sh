#!/bin/bash
#
# Put the tracker on the internet over https, through Tailscale Funnel
# (SP-152): its API, so an outside site's server (StarCaster's, on Vercel) can
# call it, and its page behind sign-in (SP-162), so the team can open it.
#
#   ./scripts/install_tracker_funnel.sh            # put the route on (or check it is on)
#   ./scripts/install_tracker_funnel.sh --status   # is it on? does it answer from outside?
#   ./scripts/install_tracker_funnel.sh --off      # take the route off
#
# Everything comes from the project config (spirality.project.json):
#   trackerPublicUrl  the public address, e.g. https://mac-mini.tail7fc5c6.ts.net:8443;
#                     its port is the Funnel port (443, 8443 or 10000)
#   trackerPort       the tracker on this machine, reached as http://127.0.0.1:<port>
#   tailscaleLabel    the launchd job that keeps tailscaled running (checked, never changed)
#   tailscaleSocket   tailscaled's socket (it runs without root, so every call names it)
#
# WHAT IT NEVER TOUCHES. Only the one https port in trackerPublicUrl is
# written. Every other Funnel and serve route (StarCaster's on 443) is read
# before and after, and a change to any of them is reported as a failure.
# The tailnet access rules are not part of this script at all, and Funnel
# traffic does not pass through them.
#
# THE ROUTE SURVIVES A REBOOT. `funnel --bg` is saved in tailscaled's own
# state, so it comes back whenever tailscaled does; nothing here is a launchd
# job of its own.
#
# IT REFUSES TO PUBLISH OLD CODE. Before the route goes on, the running
# tracker must answer a request marked as coming through Funnel with the
# Strict-Transport-Security header, which only a tracker that knows about
# the public address sends (with the Secure cookie). A tracker still on
# older code would be published without either.
#
# Exit: 0 on (or off, for --off) and checked; 1 a step failed or a check did
# not pass; 2 bad usage or an unusable config; 3 refused (old tracker code, or
# the port already carries someone else's route).

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() { echo "usage: $0 [--status | --off]" >&2; exit 2; }
[ $# -le 1 ] || usage
MODE="${1:-}"
case "$MODE" in ""|--install|--status|--off) ;; *) usage ;; esac

cfg() { node "$REPO/scripts/project_config.mjs" "$1"; }
PUBLIC_URL="$(cfg trackerPublicUrl)" || exit 2
TRACKER_PORT="$(cfg trackerPort)" || exit 2
TS_LABEL="$(cfg tailscaleLabel)" || exit 2
SOCKET="$(cfg tailscaleSocket)" || exit 2
for pair in "trackerPublicUrl=$PUBLIC_URL" "trackerPort=$TRACKER_PORT" "tailscaleLabel=$TS_LABEL" "tailscaleSocket=$SOCKET"; do
  if [ -z "${pair#*=}" ]; then
    echo "The project config does not set \"${pair%%=*}\", which this script needs." >&2
    exit 2
  fi
done

# The public name and the Funnel port, from the address (no port written is 443).
read -r PUBLIC_NAME FUNNEL_PORT < <(node -e '
  const u = new URL(process.argv[1]);
  console.log(u.hostname, u.port || "443");
' "$PUBLIC_URL")
ROUTE_KEY="$PUBLIC_NAME:$FUNNEL_PORT"
TARGET="http://127.0.0.1:$TRACKER_PORT"
LOCAL_ME="$TARGET/me"
PUBLIC_ME="$PUBLIC_URL/me"

find_ts() {
  local c
  for c in /opt/homebrew/opt/tailscale/bin/tailscale /opt/homebrew/bin/tailscale /usr/local/bin/tailscale; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}
# TAILSCALE_BIN and LAUNCHCTL_BIN stand in for the real ones in the tests only.
TS="${TAILSCALE_BIN:-}"
[ -n "$TS" ] || TS="$(find_ts)" || { echo "tailscale is not installed here (brew install tailscale)." >&2; exit 1; }
LAUNCHCTL="${LAUNCHCTL_BIN:-launchctl}"
ts() { "$TS" --socket "$SOCKET" "$@"; }

# The serve config as JSON ({} when there is none), or a failure.
serve_json() {
  local out
  out="$(ts serve status --json 2>&1)" || { echo "could not read Tailscale's routes: $out" >&2; return 1; }
  [ -n "$out" ] || out='{}'
  printf '%s' "$out"
}

# What the config says about our port: "ours", "none", or "other: <why>".
route_state() {
  node -e '
    const cfg = JSON.parse(process.argv[1] || "{}");
    const [key, port, target] = process.argv.slice(2);
    const web = cfg.Web?.[key];
    const tcp = cfg.TCP?.[port];
    if (!web && !tcp) { console.log("none"); process.exit(0); }
    const handlers = Object.entries(web?.Handlers ?? {});
    const ours = handlers.length === 1 && handlers[0][0] === "/" && String(handlers[0][1].Proxy ?? "").replace(/\/+$/, "") === target;
    if (!ours) { console.log(`other: port ${port} carries ${JSON.stringify(web?.Handlers ?? tcp)}`); process.exit(0); }
    console.log(cfg.AllowFunnel?.[key] ? "ours" : "other: the route is there but Funnel is not on for it");
  ' "$1" "$ROUTE_KEY" "$FUNNEL_PORT" "$TARGET"
}

# Every route except ours, as one line of JSON, to compare before and after.
others_of() {
  node -e '
    const cfg = JSON.parse(process.argv[1] || "{}");
    const [key, port] = process.argv.slice(2);
    const strip = (o, k) => { const c = { ...(o ?? {}) }; delete c[k]; return c; };
    const sorted = (v) => v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
    console.log(JSON.stringify(sorted({ ...cfg, TCP: strip(cfg.TCP, port), Web: strip(cfg.Web, key), AllowFunnel: strip(cfg.AllowFunnel, key) })));
  ' "$1" "$ROUTE_KEY" "$FUNNEL_PORT"
}

# The HTTP status of a GET, or 000 when nothing answered.
status_of() { curl -s -o /dev/null -m 15 -w '%{http_code}' "$@" || true; }

tailscaled_line() {
  local row
  # The label column must be the label exactly: a longer label that starts
  # the same (com.x.tailscaled.other) is a different job.
  row="$("$LAUNCHCTL" list 2>/dev/null | awk -F '\t' -v label="$TS_LABEL" '$3 == label' || true)"
  if [ -n "$row" ]; then echo "tailscaled: loaded under $TS_LABEL — $row"; return 0; fi
  echo "tailscaled: NOT loaded under $TS_LABEL — Funnel cannot carry anything until it is"
  return 1
}

show_status() {
  local ok=0 json state code
  echo "public:     $PUBLIC_URL -> $TARGET (Funnel port $FUNNEL_PORT)"
  tailscaled_line || ok=1
  if ! json="$(serve_json)"; then return 1; fi
  state="$(route_state "$json")"
  case "$state" in
    ours) echo "funnel:     on — $PUBLIC_URL proxies to $TARGET" ;;
    none) echo "funnel:     OFF — nothing is published on port $FUNNEL_PORT; put it on with $0"; ok=1 ;;
    *)    echo "funnel:     NOT OURS — $state"; ok=1 ;;
  esac
  code="$(status_of "$LOCAL_ME")"
  echo "tracker:    $LOCAL_ME answers $code (401 = up, not signed in)"
  [ "$code" = 401 ] || ok=1
  if [ "$state" = ours ]; then
    code="$(status_of "$PUBLIC_ME")"
    echo "outside:    $PUBLIC_ME answers $code (401 = reached, not signed in)"
    [ "$code" = 401 ] || ok=1
  fi
  return $ok
}

# 0 when the running tracker answers as code that knows the public address does.
tracker_is_ready() {
  local headers
  headers="$(curl -s -m 10 -o /dev/null -D - -H 'X-Forwarded-Proto: https' "$LOCAL_ME" 2>/dev/null || true)"
  [ -n "$headers" ] || { echo "The tracker does not answer at $LOCAL_ME; start it first (scripts/install_loop_runner.sh --status)." >&2; return 1; }
  printf '%s' "$headers" | grep -qi '^strict-transport-security:' && return 0
  echo "The tracker at $LOCAL_ME is running code from before SP-152: it would be published with no Secure cookie and no Strict-Transport-Security." >&2
  echo "Restart it onto main first (launchctl kickstart -k gui/$(id -u)/$(cfg launchdPrefix).tracker), then run this again." >&2
  return 3
}

# On a port Funnel has not served before, Tailscale fetches its certificate
# on the first call, which can take a minute: the route is written, but the
# outside address does not answer yet. Try it for a while before the status
# says it does not answer, and say why the wait.
OUTSIDE_TRIES="${FUNNEL_OUTSIDE_TRIES:-12}"
OUTSIDE_PAUSE="${FUNNEL_OUTSIDE_PAUSE:-5}"
wait_for_outside() {
  local i code
  for ((i = 1; i <= OUTSIDE_TRIES; i++)); do
    code="$(status_of "$PUBLIC_ME")"
    [ "$code" = 401 ] && return 0
    [ "$i" = 1 ] && echo "Waiting for $PUBLIC_ME to answer (a new Funnel port's certificate can take a minute)..."
    [ "$i" -lt "$OUTSIDE_TRIES" ] && sleep "$OUTSIDE_PAUSE"
  done
  echo "The route is on, but $PUBLIC_ME has not answered 401 yet. Run $0 --status again in a minute." >&2
}

put_on() {
  local before after state rc
  tailscaled_line >/dev/null || { tailscaled_line >&2; exit 1; }
  rc=0; tracker_is_ready || rc=$?
  [ "$rc" = 0 ] || exit "$rc"
  before="$(serve_json)" || exit 1
  state="$(route_state "$before")"
  if [ "${state%%:*}" = other ]; then
    echo "Refusing: $state. This script only writes a port nobody else uses." >&2
    exit 3
  fi
  if [ "$state" = none ]; then
    echo "Putting $PUBLIC_URL on, leading to $TARGET..."
    ts funnel --bg --yes --https="$FUNNEL_PORT" "$TARGET" >/dev/null || { echo "FAILED: tailscale funnel did not take the route." >&2; exit 1; }
  else
    echo "The route was already on."
  fi
  after="$(serve_json)" || exit 1
  if [ "$(route_state "$after")" != ours ]; then
    echo "FAILED: read back, port $FUNNEL_PORT is $(route_state "$after"), not the tracker." >&2
    exit 1
  fi
  if [ "$(others_of "$before")" != "$(others_of "$after")" ]; then
    echo "FAILED: another route changed while this one went on. Before: $(others_of "$before")" >&2
    echo "        After:  $(others_of "$after")" >&2
    exit 1
  fi
  echo "Read back: port $FUNNEL_PORT leads to the tracker, and every other route is as it was."
  wait_for_outside
  echo
  show_status
}

take_off() {
  local before after state
  before="$(serve_json)" || exit 1
  state="$(route_state "$before")"
  if [ "$state" = none ]; then echo "The route is already off: nothing is published on port $FUNNEL_PORT."; return 0; fi
  if [ "$state" != ours ]; then echo "Refusing: $state. This script only takes off its own route." >&2; exit 3; fi
  ts funnel --yes --https="$FUNNEL_PORT" off >/dev/null || { echo "FAILED: tailscale did not take the route off." >&2; exit 1; }
  after="$(serve_json)" || exit 1
  if [ "$(route_state "$after")" != none ]; then echo "FAILED: read back, port $FUNNEL_PORT still carries $(route_state "$after")." >&2; exit 1; fi
  if [ "$(others_of "$before")" != "$(others_of "$after")" ]; then echo "FAILED: another route changed while this one came off." >&2; exit 1; fi
  echo "Taken off and read back: nothing is published on port $FUNNEL_PORT; every other route is as it was."
}

case "$MODE" in
  --status)       show_status ;;
  --off)          take_off ;;
  ""|--install)   put_on ;;
esac
