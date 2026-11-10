'use strict';

/**
 * mergeWindowLease — only one pull request may be in the catch-up window at a
 * time, so a queue under pressure can actually drain.
 *
 * WHY THIS EXISTS (2026-09-03, task 86bbuv9jt). Dane commented `merge` on
 * 86bbt6hgx at 23:25. It landed at 23:49, and the twenty-four minutes were
 * spent entirely on CI that had already passed: PR #590 merged to main at
 * 23:40, which put the branch BEHIND, which forced a catch-up push at 23:46,
 * which reset `verify` to zero. The branch was caught up twice in fifteen
 * minutes and every actor reported success at every step.
 *
 * THE ARITHMETIC, and it is the whole reason a lease is the fix. Branch
 * protection on this repo is `strict: true` with `enforce_admins: true`
 * (measured 2026-09-05):
 *
 *   "required_status_checks": { "strict": true, "contexts": ["verify"] }
 *
 * so a branch may only merge while it contains the tip of main. Every merge
 * therefore invalidates every other open branch. Call the window W — the time
 * from "this machine catches a branch up" to "GitHub lands it" — and call the
 * gap between merges G. If G < W, each branch is reset before it finishes and
 * NO branch converges. It is not slowness; it is a livelock that gets worse
 * as the queue grows, because a fuller queue means a smaller G.
 *
 * W is dominated by this machine's own pass cadence, not by CI. Measured
 * 2026-09-05 over the last 60 `verify` runs: p50 2.1 min, p95 2.3 min, max
 * 2.4 min — the ticket's "5-6 minutes" is out of date and CI is the SMALL
 * term. The relay wakes every 600s (`com.starcaster.bus-relay.plist`), so a
 * branch that falls behind waits up to a full cycle before anything even
 * notices. On the night in question the branch went BEHIND at 23:40 and was
 * not caught up until 23:46. W is roughly 10 + 2.4 ~= 12 minutes; G that night
 * was 5-9. That is the livelock, in the measured numbers.
 *
 * WHAT A LEASE CHANGES. Main only moves when the leaseholder lands. Every
 * other branch is left alone — not caught up, not armed, not merged — so
 * nothing resets its CI. The holder is caught up once, runs `verify` once, and
 * merges; then the next one takes the window. Three ready pull requests cost
 * three CI runs, and the bound holds however fast merges arrive, because
 * merges no longer arrive concurrently at all.
 *
 * WHY NOT THE OTHER TWO CANDIDATES the ticket named.
 *
 *   GitHub's own merge queue is the textbook answer and is BLOCKED by task
 *   86bbv35cq: under a queue `gh pr merge` enqueues and returns success while
 *   the PR stays OPEN, and both callers here read that as "merged" — one
 *   fails loudly on every run, the other stamps a fabricated merge time and
 *   moves the ticket to Live. That ticket says in its own words that the
 *   queue must not be switched on until it is done.
 *
 *   Skipping the catch-up on a branch that is green and clean by
 *   `git merge-tree` cannot work, because `strict: true` means GITHUB refuses
 *   the merge, not us. The only way to make it work is to drop `strict`, and
 *   that trades away the exact property the ticket's Non-goals protect: CI
 *   having run on the merged result.
 *
 * EVERYTHING HERE IS PURE. No disk, no network, no clock of its own — `now`
 * is always passed in. The IO lives in `mergeWindowLeaseFile.js` and the
 * wiring in `scripts/clickup_direct.mjs`, for the reason autoMergeLane gives:
 * a decision that can only be exercised against a live GitHub is a decision
 * nobody will break-test.
 *
 * IT LOOSENS NOTHING. This module can only ever say "not yet". Every
 * precondition `githubGate` already enforces — a review pass, green checks, no
 * conflict, CI having run on the merged result — is untouched and still
 * decides on its own whether a merge may happen at all. The lease decides
 * only WHEN, never WHETHER.
 */

/**
 * Measured inputs, kept as named constants so the derivation below can be read
 * rather than trusted. Re-measure with:
 *
 *   gh run list --repo mentor24-maker/starcaster --workflow ci.yml --limit 60 \
 *     --json conclusion,createdAt,updatedAt
 */
const MEASURED = Object.freeze({
  /** `verify` p95 wall-clock, minutes, 60 runs, 2026-09-05. */
  ciP95Minutes: 2.3,
  /** The relay's launchd StartInterval, minutes. */
  relayIntervalMinutes: 10,
});

/**
 * How long a hold may last before the window is taken away from it.
 *
 * DERIVED, not picked (the discipline `lib/nodeHeartbeat.js` uses). A HEALTHY
 * hold spans at most: the pass that takes the window and pushes the catch-up,
 * then CI, then the next pass to notice — and if arming failed, one more pass
 * before the merge falls through to the ordinary path. That is
 * 2 x 10 + 2.3 ~= 22.3 minutes. Doubling it for headroom gives 45.
 *
 * The direction of the error matters and is not symmetric. Too SHORT re-creates
 * the bug: a second branch is let into the window while the first one's CI is
 * legitimately running, and the two reset each other exactly as before. Too
 * LONG only makes a genuinely stuck pull request hold its repo's queue for
 * longer — and it is a backstop in the first place, because `releaseSettled`
 * is the primary release and fires on the next pass after the holder lands.
 * So the bias is deliberately toward the long side.
 */
const LEASE_TTL_MS = 45 * 60 * 1000;

/**
 * The `githubGate` actions that MOVE MAIN, and therefore need the window.
 *
 *   'merge'            — lands on main now
 *   'update-branch'    — pushes a catch-up, which restarts CI and ends in a merge
 *   'catch-up-locally' — the same push by another route
 *   'arm'              — GitHub lands it the moment its checks go green
 *
 * The rest ('wait', 'conflict', 'refuse') change nothing on main and are never
 * gated — a refusal must still be able to explain itself while another branch
 * holds the window, or the operator gets silence instead of a reason.
 *
 * ARMING IS NOT A GATE ACTION; it is decided separately by `autoMergeDecision`.
 * It is in this list anyway because an armed pull request merges on its own,
 * with nobody here awake for it — two armed branches reset each other exactly
 * as two merged ones would. The caller asks with `needsMergeWindow('arm')`.
 */
const WINDOW_ACTIONS = Object.freeze(['merge', 'update-branch', 'catch-up-locally', 'arm']);

/** Does this action move main, and therefore need the window? */
function needsMergeWindow(action) {
  return WINDOW_ACTIONS.includes(String(action || '').trim());
}

/**
 * ONE WINDOW PER REPOSITORY, not one window overall.
 *
 * The Loop Queue carries work for starcaster, normie, pulse and vault, and a
 * merge on one of them cannot put a branch on another behind — they have
 * different mains. A single global window would be SAFE but wrong in the
 * expensive direction: an unrelated repository's stuck pull request would stop
 * this one's queue for the full 45 minutes, which is the stall this module
 * exists to remove, rebuilt by its own fix.
 *
 * Keyed on "owner/name" exactly as `runMergeStep` builds it, lowercased so a
 * differently-cased remote cannot open a second window on the same repository.
 */
function repoKey(repo) {
  return String(repo || '').trim().toLowerCase();
}

function toPrNumber(value) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toEpoch(value) {
  if (!value) return null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

/**
 * Normalise whatever came off disk into a lease, tolerantly.
 *
 * A holder missing its pull-request number or its timestamp is NOT a holder: it
 * could never be matched against a pull request and could never expire, so it
 * would wedge that repository's queue permanently. Dropping it is the safe
 * reading — the worst case is one extra branch entering the window, which is
 * the behaviour that exists today.
 */
function asLease(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const wins = src.windows && typeof src.windows === 'object' ? src.windows : {};
  const out = {};
  for (const [key, h] of Object.entries(wins)) {
    const repo = repoKey(key);
    if (!repo || !h || typeof h !== 'object') continue;
    const pr = toPrNumber(h.pr);
    const takenAt = toEpoch(h.takenAt);
    if (pr === null || takenAt === null) continue;
    out[repo] = {
      pr,
      task: h.task ? String(h.task) : null,
      branch: h.branch ? String(h.branch) : null,
      headSha: h.headSha ? String(h.headSha) : null,
      takenAt: new Date(takenAt).toISOString(),
    };
  }
  return { windows: out };
}

/** Who holds this repository's window, if anyone. */
function holderFor(lease, repo) {
  const key = repoKey(repo);
  if (!key) return null;
  return asLease(lease).windows[key] || null;
}

/** Minutes, one decimal, for a sentence a person reads. */
function minutesSince(fromIso, now) {
  const then = toEpoch(fromIso);
  const at = toEpoch(now);
  if (then === null || at === null) return null;
  return Math.round(((at - then) / 60000) * 10) / 10;
}

/**
 * May this pull request move its repository's main right now?
 *
 *   'proceed' — it already holds the window; carry on
 *   'take'    — the window is free (or the holder timed out); take it
 *   'blocked' — another pull request holds it; do nothing to main this pass
 *
 * THE FAIL-SAFE IS IN HERE, not in the caller (DOCTRINE 3.11). `read` is what
 * `mergeWindowLeaseFile.readLeaseFile` returned; a read that FAILED means the
 * file on disk may name a holder this pass cannot see, so it counts as HELD.
 * The ticket names the two failure directions and they are not symmetric:
 * merging something whose merged state was never verified is the one to avoid,
 * a slower queue is the one to accept. An unreadable lease therefore stops the
 * merge, loudly, and the next pass asks again.
 */
function windowDecision({ read, repo, pr, now, ttlMs = LEASE_TTL_MS } = {}) {
  const mine = toPrNumber(pr);
  const key = repoKey(repo);
  if (mine === null) {
    return { action: 'blocked', cannotTell: true, reason: 'no pull request number was given, so the merge window could not be asked for at all' };
  }
  if (!key) {
    return { action: 'blocked', cannotTell: true, reason: `no repository was named for PR #${mine}, and a merge window that does not know which main it is protecting is not one` };
  }

  if (!read || read.ok !== true) {
    const why = (read && read.why) || 'it could not be read';
    return {
      action: 'blocked',
      cannotTell: true,
      reason: `CANNOT TELL whether another pull request is in ${key}'s merge window — ${why}. Treated as held, because letting a second branch in is what resets everybody's checks; the next pass asks again`,
    };
  }

  const holder = holderFor(read.lease, key);
  if (!holder) return { action: 'take', cannotTell: false, reason: `${key}'s merge window is free` };

  if (holder.pr === mine) {
    return {
      action: 'proceed',
      cannotTell: false,
      holder,
      reason: `PR #${mine} already holds ${key}'s merge window (taken ${minutesSince(holder.takenAt, now)} min ago)`,
    };
  }

  const heldFor = minutesSince(holder.takenAt, now);
  const expired = heldFor !== null && heldFor * 60000 >= ttlMs;
  if (expired) {
    return {
      action: 'take',
      cannotTell: false,
      expired: holder,
      reason: `PR #${holder.pr} held ${key}'s merge window for ${heldFor} min without landing, past the ${Math.round(ttlMs / 60000)} min bound — taking it over. If that pull request is stuck, it needs an agent session`,
    };
  }

  return {
    action: 'blocked',
    cannotTell: false,
    holder,
    reason: `PR #${holder.pr} is in ${key}'s merge window (${heldFor} min ago) and has not landed yet. Moving main now would put that branch behind and restart its checks, which is the livelock this queue is built to avoid — this pull request goes next pass`,
  };
}

/**
 * Take this repository's window for this pull request.
 *
 * Overwrites whatever held it, which is correct: the ONLY caller is a
 * `windowDecision` that already answered 'take', and that answer is where the
 * safety lives. Every OTHER repository's holder is carried through untouched —
 * writing the whole file means a careless take would otherwise free a window
 * this pass never looked at.
 */
function takeWindow({ read, repo, pr, task, branch, headSha, now } = {}) {
  const base = asLease(read && read.ok === true ? read.lease : null);
  const key = repoKey(repo);
  const n = toPrNumber(pr);
  if (!key || n === null) return base;
  return {
    windows: {
      ...base.windows,
      [key]: {
        pr: n,
        task: task ? String(task) : null,
        branch: branch ? String(branch) : null,
        headSha: headSha ? String(headSha) : null,
        takenAt: new Date(toEpoch(now) ?? 0).toISOString(),
      },
    },
  };
}

function without(lease, key) {
  const next = { windows: { ...asLease(lease).windows } };
  delete next.windows[key];
  return next;
}

/**
 * Give the window back.
 *
 * A pull request may only release ITS OWN hold. Releasing somebody else's is
 * how two branches end up in the window at once wearing a fix's clothes — and
 * it would happen every time a second ticket's refusal path ran while the first
 * one was legitimately mid-flight.
 */
function releaseWindow({ read, repo, pr } = {}) {
  if (!read || read.ok !== true) {
    return { changed: false, lease: null, reason: 'the merge window was not read cleanly this pass, so it was not written over' };
  }
  const key = repoKey(repo);
  const lease = asLease(read.lease);
  const mine = toPrNumber(pr);
  const holder = key ? lease.windows[key] : null;
  if (!holder) return { changed: false, lease, reason: `${key || 'that repository'}'s merge window was already free` };
  if (mine === null || holder.pr !== mine) {
    return {
      changed: false,
      lease,
      reason: `PR #${holder.pr} holds ${key}'s merge window, not PR #${mine ?? '(none)'} — leaving it alone`,
    };
  }
  return { changed: true, lease: without(lease, key), reason: `PR #${mine} released ${key}'s merge window` };
}

/**
 * The PRIMARY release, and the reason the 45-minute bound is only a backstop.
 *
 * Once per pass the relay reads each holder's state from GitHub and calls this.
 * A pull request that is MERGED or CLOSED is out of the window whatever the
 * clock says, so the next branch may start immediately rather than waiting out
 * a timeout — which is what keeps serialised merges about as fast as the
 * unserialised ones were meant to be.
 *
 * A state that could not be READ leaves the hold in place. Same fail-safe as
 * everywhere else here: "I could not check" is not "it is gone".
 */
function releaseSettled({ read, repo, state, now, ttlMs = LEASE_TTL_MS } = {}) {
  if (!read || read.ok !== true) {
    return { changed: false, lease: null, reason: 'the merge window was not read cleanly this pass, so it was not written over' };
  }
  const key = repoKey(repo);
  const lease = asLease(read.lease);
  const holder = key ? lease.windows[key] : null;
  if (!holder) return { changed: false, lease, reason: `${key || 'that repository'}'s merge window is free` };

  const s = String(state || '').trim().toUpperCase();
  if (s === 'MERGED' || s === 'CLOSED') {
    return { changed: true, lease: without(lease, key), reason: `PR #${holder.pr} is ${s} — ${key}'s merge window is free again` };
  }

  const heldFor = minutesSince(holder.takenAt, now);
  if (heldFor !== null && heldFor * 60000 >= ttlMs) {
    return {
      changed: true,
      lease: without(lease, key),
      reason: `PR #${holder.pr} has held ${key}'s merge window ${heldFor} min without landing, past the ${Math.round(ttlMs / 60000)} min bound — releasing it so the queue can move. That pull request is stuck and needs an agent session`,
    };
  }

  if (!s) {
    return { changed: false, lease, reason: `CANNOT TELL whether PR #${holder.pr} has landed — its state could not be read, so ${key}'s merge window stays held` };
  }
  return { changed: false, lease, reason: `PR #${holder.pr} is still ${s} and holds ${key}'s merge window` };
}

/** Every repository with a hold right now, for the pass to check on. */
function heldRepos(read) {
  if (!read || read.ok !== true) return [];
  const lease = asLease(read.lease);
  return Object.entries(lease.windows).map(([repo, holder]) => ({ repo, holder }));
}

module.exports = {
  MEASURED,
  LEASE_TTL_MS,
  WINDOW_ACTIONS,
  needsMergeWindow,
  repoKey,
  asLease,
  holderFor,
  heldRepos,
  windowDecision,
  takeWindow,
  releaseWindow,
  releaseSettled,
};
