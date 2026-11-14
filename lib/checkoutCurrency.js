'use strict';

/**
 * Is this machine actually running the code on `main`, and if not, can it fix
 * itself?
 *
 * MOVED FROM STARCASTER (lib/checkoutCurrency.js, commit 0682572) for SP-268.
 * In StarCaster the checkout script made the pull itself. In Spirality the
 * relay and the lane runners already pull `main` (SP-150) and restart the
 * tracker when a pull changes its files, so the script never pulls: it reads
 * the checkout after the relay's pull and reports what it finds. Two things
 * were added for that: `classify` takes the blocking files the caller
 * worked out (`r.blocking`, from `untrackedBlockers`) when it has no pull
 * error to read them from, and a checkout that is behind with nothing
 * blocking it and no refused pull to read is `NOT_PULLED_YET` (the relay's
 * next pull takes it), not an alarm. `summaryLine` is the one line the
 * command prints first: `current`, `behind, pulled` or `behind, could not
 * pull: <why>`.
 *
 * WHY THIS EXISTS (2026-09-01, task 86bbrf2vf). The Mac Mini could not update
 * itself for hours and said so only to a log file nobody reads. Three
 * untracked files left behind by the weekly-report job became tracked paths in
 * a later commit, and from that moment every fast-forward failed:
 *
 *   error: The following untracked working tree files would be overwritten by
 *   merge: docs/reports/2026-08-30.data.json ...
 *
 * It was found by hand, only because a fix was being pushed to it and somebody
 * happened to watch the pull.
 *
 * THE TIMIDITY WAS NEVER THE PROBLEM. `scripts/run_bus_relay.sh` updates only
 * on main, only with a clean tree, only fast-forward — "a background job may
 * keep a checkout current; it may not rewrite someone's work to do it." That
 * rule is right and is preserved here exactly.
 *
 * Two things were wrong, and both are about what happens AFTER the refusal:
 *
 *   1. Every refusal was an `echo` and nothing else. Everything else in this
 *      system posts to the bus when it goes wrong — the failure alert, the
 *      heartbeat watchdog, the throughput check. A machine running last
 *      week's rules looked exactly like a machine running this week's.
 *
 *   2. THE REASON PRINTED WAS WRONG. The blocked-by-untracked-files case fell
 *      through to "main has diverged from origin and only a person should sort
 *      that out." `main` had not diverged; it was a clean fast-forward blocked
 *      by three generated files. Anyone who did read the log would go hunting
 *      for a divergence that does not exist — the wrong-actor defect of
 *      DOCTRINE 2.5, wearing a different hat.
 *
 * WHY A STALE CHECKOUT DOES NOT ANNOUNCE ITSELF. The loop runner executes
 * `npm run clickup -- ...` from this checkout, while the loop skills build in
 * worktrees cut from a fresh `origin/main`. So a stale machine does not break.
 * It runs yesterday's tooling against today's code, quietly. The relay also
 * reads `lib/nodeRoles.js` — who may run what — out of this same checkout,
 * which is the case the update step was written for in the first place.
 */

/**
 * The states a checkout can be in. `alarm` is the only field that decides
 * whether the bus hears about it.
 *
 * ALARM ONLY WHEN THE MACHINE IS ACTUALLY RUNNING STALE CODE AND CANNOT FIX
 * ITSELF. A dirty tree or a feature branch on a checkout that is level with
 * `main` is somebody working, not a fault — announcing it every six hours
 * would be exactly the wallpaper that makes the real alarm unreadable. The
 * harm being watched for is running old code, so `behind === 0` is never an
 * alarm however untidy the folder is.
 */
const STATES = Object.freeze({
  CURRENT: 'current',
  UPDATED: 'updated',
  NOT_ON_MAIN: 'not-on-main',
  DIRTY: 'dirty',
  UNREACHABLE: 'unreachable',
  DIVERGED: 'diverged',
  BLOCKED_UNTRACKED: 'blocked-untracked',
  BLOCKED_OTHER: 'blocked-other',
  NOT_PULLED_YET: 'not-pulled-yet',
});

/**
 * The untracked paths git names in the one error this ticket exists for.
 *
 * Parsed rather than guessed: the whole point is to say WHICH files, because
 * "cannot fast-forward" sends a reader looking at history while the answer is
 * three files sitting in a folder.
 */
function blockingUntrackedPaths(gitStderr) {
  const text = String(gitStderr || '');
  const marker = /untracked working tree files would be overwritten by (?:merge|checkout)/i;
  if (!marker.test(text)) return [];
  const out = [];
  let collecting = false;
  for (const raw of text.split('\n')) {
    if (marker.test(raw)) { collecting = true; continue; }
    if (!collecting) continue;
    // git indents the paths with a tab, then stops with a blank line or a
    // sentence ("Please move or remove them before you merge.").
    if (/^\s*$/.test(raw)) break;
    if (!/^[\t ]/.test(raw)) break;
    const p = raw.trim();
    if (p) out.push(p);
  }
  return out;
}

/**
 * Classify a checkout from readings the caller has already taken.
 *
 * Pure on purpose: the git calls are the caller's, so every branch here —
 * including the ones that only happen on a machine nobody is sitting at — is
 * reachable from a test.
 *
 * @param {object} r
 * @param {string} r.branch            current branch name, or '?' if unknown
 * @param {boolean} r.dirty            are there uncommitted changes
 * @param {boolean} r.fetched          did `git fetch` succeed
 * @param {number} r.behind            commits on origin/main not here
 * @param {number} r.ahead             commits here not on origin/main
 * @param {string} [r.mergeStderr]     stderr from an attempted fast-forward
 * @param {boolean} [r.merged]         did the fast-forward succeed
 * @param {string[]} [r.blocking]      untracked files that would block the
 *                                     update, when there is no stderr to read
 *                                     them from (see `untrackedBlockers`)
 * @param {boolean} [r.pullRefused]    did the caller's pull run and fail
 * @param {string[]} [r.untracked]     untracked files in the folder: Spirality's
 *                                     runners pull only into a folder with none
 *                                     (`git status --porcelain` empty), so
 *                                     any at all stop the pull
 * @param {number|null} [r.lastSuccessAt]  ms epoch of the last good update
 * @param {number} [r.now]
 */
function classify(r = {}) {
  const branch = String(r.branch ?? '?');
  const behind = Number.isFinite(Number(r.behind)) ? Math.max(0, Math.trunc(Number(r.behind))) : 0;
  const ahead = Number.isFinite(Number(r.ahead)) ? Math.max(0, Math.trunc(Number(r.ahead))) : 0;

  const base = { behind, ahead, branch, lastSuccessAt: r.lastSuccessAt ?? null, now: r.now ?? Date.now() };

  // Order matters, and it is the order the shell script already used, so the
  // refusals stay the same refusals — only what happens after them changes.
  if (r.fetched === false) {
    // Cannot see origin, so `behind` is unknown rather than zero. That is a
    // CANNOT TELL, and it must not read as healthy: a machine that cannot
    // reach GitHub also cannot be told it is out of date.
    return { ...base, state: STATES.UNREACHABLE, behind: null, alarm: false, cannotTell: true,
      reason: 'could not reach origin, so how far behind this checkout is cannot be known' };
  }

  if (behind === 0) {
    // Level with main. Anything else about the folder is somebody's business,
    // not an alarm.
    if (r.merged) return { ...base, state: STATES.UPDATED, alarm: false, cannotTell: false, reason: 'fast-forwarded to origin/main' };
    return { ...base, state: STATES.CURRENT, alarm: false, cannotTell: false, reason: 'already level with origin/main' };
  }

  // From here the machine IS behind, so every branch below is running stale
  // code and every one of them alarms.
  if (branch !== 'main') {
    return { ...base, state: STATES.NOT_ON_MAIN, alarm: true, cannotTell: false,
      reason: `the checkout is on "${branch}", not main, so it is not being updated` };
  }

  if (r.dirty) {
    return { ...base, state: STATES.DIRTY, alarm: true, cannotTell: false,
      reason: 'there are uncommitted changes, and a background job does not touch them' };
  }

  if (ahead > 0) {
    return { ...base, state: STATES.DIVERGED, alarm: true, cannotTell: false,
      reason: `main here has ${ahead} commit(s) origin does not, so this is a real divergence and only a person should sort it out` };
  }

  const fromStderr = blockingUntrackedPaths(r.mergeStderr);
  const blocking = fromStderr.length ? fromStderr
    : (Array.isArray(r.blocking) ? r.blocking.filter(Boolean).map(String) : []);
  if (blocking.length) {
    // THE CASE THAT ACTUALLY HAPPENED, and the one message that did not exist.
    return { ...base, state: STATES.BLOCKED_UNTRACKED, alarm: true, cannotTell: false, blocking,
      reason: `${blocking.length} untracked file(s) would be overwritten by the update: ${blocking.join(', ')}` };
  }

  // Spirality's runners pull only when `git status --porcelain` is empty, so
  // an untracked file that git itself would not mind still stops the pull.
  // Named, because it is the one thing to move.
  const untracked = Array.isArray(r.untracked) ? r.untracked.filter(Boolean).map(String) : [];
  if (untracked.length) {
    const shown = untracked.slice(0, 10).join(', ') + (untracked.length > 10 ? `, and ${untracked.length - 10} more` : '');
    return { ...base, state: STATES.BLOCKED_OTHER, alarm: true, cannotTell: false, blocking: untracked,
      reason: `the relay pulls only into a folder with no untracked files, and ${untracked.length} sit here: ${shown}` };
  }

  // Nothing blocks it, and nobody tried to pull and failed: the relay's next
  // pull brings it level. A reading, not an alarm (Spirality's addition).
  if (!r.pullRefused && !String(r.mergeStderr || '').trim()) {
    return { ...base, state: STATES.NOT_PULLED_YET, alarm: false, cannotTell: false,
      reason: 'nothing blocks a fast-forward, and the relay\'s next pull brings it level' };
  }

  return { ...base, state: STATES.BLOCKED_OTHER, alarm: true, cannotTell: false,
    reason: `the fast-forward failed: ${String(r.mergeStderr || 'git gave no reason').trim().split('\n')[0].slice(0, 200)}` };
}

/** "20h", "3d" — the age of the last successful update, for the report. */
function ageText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const h = ms / 3600000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60000))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * The line the log gets and, when it alarms, the bus.
 *
 * Always carries HOW FAR BEHIND and SINCE WHEN. "skipped" is not actionable;
 * a number and a timestamp are — that is the difference between a reader
 * knowing this matters and scrolling past it.
 */
function report(state, { node = 'this machine' } = {}) {
  const behind = state.behind === null ? 'unknown' : `${state.behind}`;
  const since = state.lastSuccessAt
    ? `last successful update ${new Date(state.lastSuccessAt).toISOString().replace('T', ' ').slice(0, 16)} (${ageText(state.now - state.lastSuccessAt)} ago)`
    : 'no successful update has ever been recorded here';

  if (!state.alarm && !state.cannotTell) {
    return `update: ${state.reason} (${state.branch}${state.behind ? `, ${state.behind} behind` : ''})`;
  }
  if (state.cannotTell) {
    return `update: CANNOT TELL — ${state.reason}. ${since}.`;
  }
  return [
    `${node} is running STALE code and cannot update itself.`,
    `Behind origin/main by ${behind} commit(s); ${since}.`,
    `Why: ${state.reason}`,
    state.state === STATES.BLOCKED_UNTRACKED
      ? 'Repair: `npm run checkout:current -- --fix` displaces those files to a timestamped folder; the relay\'s next pull then goes through. It never deletes.'
      : 'This one needs a person: a background job may keep a checkout current, it may not rewrite someone\'s work to do it.',
  ].join('\n');
}

/**
 * May this repair itself without a person?
 *
 * ONLY when the blocking path is already tracked on `origin/main`. Git is
 * about to provide the authoritative copy, so displacing the local one loses
 * nothing unrecoverable — and the displacement is logged and reversible, never
 * a delete. Any other blocking file is somebody's, and is reported instead.
 *
 * @param {string[]} blocking          paths git named
 * @param {Set<string>|string[]} trackedOnOrigin  paths origin/main tracks
 */
function autoRepairable(blocking, trackedOnOrigin) {
  const tracked = trackedOnOrigin instanceof Set ? trackedOnOrigin : new Set(trackedOnOrigin || []);
  const list = Array.isArray(blocking) ? blocking.filter(Boolean) : [];
  if (!list.length) return { ok: false, why: 'nothing is blocking', paths: [] };
  const foreign = list.filter((p) => !tracked.has(p));
  if (foreign.length) {
    return { ok: false, paths: [], why: `${foreign.length} of them are not tracked on origin/main (${foreign.join(', ')}) — git has no authoritative copy, so they are somebody's work and are left alone` };
  }
  return { ok: true, paths: list, why: 'every blocking path is tracked on origin/main, so git supplies the authoritative copy' };
}

/**
 * The untracked files that would stop a fast-forward to origin/main, worked
 * out without trying one: the files origin/main adds that HEAD does not
 * have, which sit in the folder untracked. Git refuses to overwrite exactly
 * those ("untracked working tree files would be overwritten by merge").
 * Ignored files are left out, because git overwrites them without asking.
 *
 * @param {string[]} addedOnOrigin   `git diff --name-only --no-renames --diff-filter=A HEAD origin/main`
 * @param {string[]} untrackedHere   `git ls-files --others --exclude-standard`
 */
function untrackedBlockers(addedOnOrigin, untrackedHere) {
  const here = new Set((Array.isArray(untrackedHere) ? untrackedHere : []).filter(Boolean));
  return (Array.isArray(addedOnOrigin) ? addedOnOrigin : []).filter((p) => p && here.has(p));
}

/**
 * The first line the command prints: `current`, `behind, pulled`, or
 * `behind, could not pull: <why>` (the ticket's three readings), plus
 * `behind, not pulled yet: <why>` and `cannot tell: <why>`.
 */
function summaryLine(state) {
  if (state.cannotTell) return `cannot tell: ${state.reason}`;
  if (state.state === STATES.UPDATED) return 'behind, pulled';
  if (state.state === STATES.CURRENT) return 'current';
  if (state.state === STATES.NOT_PULLED_YET) return `behind, not pulled yet: ${state.reason}`;
  return `behind, could not pull: ${state.reason}`;
}

module.exports = {
  STATES,
  untrackedBlockers,
  summaryLine,
  blockingUntrackedPaths,
  classify,
  report,
  ageText,
  autoRepairable,
};
