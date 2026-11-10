'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mergeWindowLease = require('./mergeWindowLease');

/**
 * THE DEMONSTRATION (task 86bbuv9jt, acceptance criterion 1): "with three PRs
 * green and ready and main moving between them, all three merge without any
 * branch re-running CI more than once. Demonstrate it, do not argue it."
 *
 * Three real pull requests cannot be merged into production main to prove a
 * point, so the demonstration is run against a model of GitHub instead — but
 * the POLICY under test is not modelled. Every window decision below is made
 * by the real `mergeWindowLease` functions the relay calls, and the two arms of
 * the comparison share one simulator and differ by a single flag. What is
 * modelled is only GitHub's side: branch protection, CI, and auto-merge.
 *
 * WHAT THE MODEL ASSERTS ABOUT GITHUB, and where each came from:
 *
 *   `strict: true` — a pull request may merge only while it contains the tip
 *   of main, so every merge puts every other open branch BEHIND and discards
 *   its checks. Measured 2026-09-05:
 *     gh api repos/mentor24-maker/starcaster/branches/main/protection
 *     -> "required_status_checks": { "strict": true, "contexts": ["verify"] }
 *
 *   CI takes 2.3 minutes (p95 of the last 60 `verify` runs, 2026-09-05). The
 *   ticket said 5-6; it is out of date, and CI turns out to be the SMALL term.
 *
 *   The relay wakes every 10 minutes (com.starcaster.bus-relay.plist
 *   StartInterval 600). This is the term that actually dominates: on the night
 *   in the ticket the branch fell behind at 23:40 and nothing noticed until
 *   23:46.
 *
 *   An armed pull request merges the instant its checks are green AND it is up
 *   to date — that is what arming means, and it is why arming needs the window
 *   just as merging does.
 */

const CI_MINUTES = 2.3;
const RELAY_INTERVAL = 10;
const REPO = 'mentor24-maker/starcaster';
const START = Date.parse('2026-09-05T12:00:00.000Z');
const iso = (minute) => new Date(START + minute * 60000).toISOString();

/**
 * One simulator, two policies. `serialise: false` is the code as it stood
 * before this change — every ready pull request caught up and armed on every
 * pass, which is what let them reset each other.
 *
 * `externalMergeEvery` models the sustained pressure the ticket describes:
 * unrelated pull requests landing on main from outside this set, which is what
 * PR #590 was on the night in question.
 */
/**
 * `start` is not a detail — it decides which half of the policy the run
 * exercises, and getting it wrong makes the demonstration blind.
 *
 *   'behind'  — every branch needs catching up first (the queue after a merge)
 *   'green'   — every branch is current and verified, the ticket's own "How to
 *               test": hold three green pull requests and merge them in sequence
 *   'running' — every branch is current with CI in flight, which is the ONLY
 *               state where ARMING is the main move being gated. A first pass
 *               of this file started every branch 'behind', so dropping 'arm'
 *               from WINDOW_ACTIONS changed nothing here and the demonstration
 *               could not see it.
 */
function simulate({ prs, serialise, externalMergeEvery = 0, minutes = 240, start = 'behind' }) {
  const state = prs.map((n) => ({
    n,
    upToDate: start !== 'behind',
    ciStartedAt: start === 'running' ? 0 : null,
    ciGreen: start === 'green',
    ciRuns: start === 'running' ? 1 : 0,
    armed: false,
    merged: false,
    mergedAt: null,
  }));
  // The lease exactly as the file layer hands it to the pure module.
  let read = { ok: true, lease: { windows: {} }, file: '/sim/merge-window-lease.json' };
  const save = (lease) => { read = { ...read, lease }; };

  const mainMoved = () => {
    // strict: true. Everything still open is now behind, and whatever CI had
    // said about it no longer describes the branch.
    for (const p of state) {
      if (p.merged) continue;
      p.upToDate = false;
      p.ciGreen = false;
      p.ciStartedAt = null;
    }
  };

  const release = (pr, now) => {
    const rel = mergeWindowLease.releaseWindow({ read, repo: REPO, pr });
    if (rel.changed) save(rel.lease);
  };

  const claim = (pr, action, now) => {
    if (!serialise) return true;
    if (!mergeWindowLease.needsMergeWindow(action)) return true;
    const d = mergeWindowLease.windowDecision({ read, repo: REPO, pr, now });
    if (d.action === 'blocked') return false;
    if (d.action === 'take') {
      save(mergeWindowLease.takeWindow({ read, repo: REPO, pr, now }));
    }
    return true;
  };

  for (let minute = 0; minute <= minutes; minute += 0.1) {
    const t = Math.round(minute * 10) / 10;
    const now = iso(t);

    // CI finishing.
    for (const p of state) {
      if (!p.merged && p.ciStartedAt !== null && !p.ciGreen && t >= p.ciStartedAt + CI_MINUTES) p.ciGreen = true;
    }

    // An armed pull request lands on its own the moment it is green and current.
    for (const p of state) {
      if (p.merged || !p.armed || !p.ciGreen || !p.upToDate) continue;
      p.merged = true;
      p.mergedAt = t;
      p.armed = false;
      if (serialise) release(p.n, now);
      mainMoved();
      break; // one merge per instant; the rest see main move and re-decide
    }

    // Unrelated work landing on main from outside this set.
    if (externalMergeEvery && t > 0 && Math.abs((t % externalMergeEvery)) < 0.05) mainMoved();

    // The relay pass.
    if (Math.abs(t % RELAY_INTERVAL) >= 0.05) continue;

    // The once-per-pass sweep: let go of anything that has already landed.
    for (const { repo, holder } of mergeWindowLease.heldRepos(read)) {
      const held = state.find((p) => p.n === holder.pr);
      const settled = mergeWindowLease.releaseSettled({
        read, repo, state: held && held.merged ? 'MERGED' : 'OPEN', now,
      });
      if (settled.changed) save(settled.lease);
    }

    for (const p of state) {
      if (p.merged) continue;

      if (!p.upToDate) {
        if (!claim(p.n, 'update-branch', now)) continue;
        // The catch-up push. This is the CI run the ticket is counting.
        p.upToDate = true;
        p.ciStartedAt = t;
        p.ciGreen = false;
        p.ciRuns += 1;
        if (claim(p.n, 'arm', now)) p.armed = true;
        continue;
      }
      if (!p.ciGreen) {
        if (claim(p.n, 'arm', now)) p.armed = true;
        continue;
      }
      // Up to date and green: merge it here and now.
      if (!claim(p.n, 'merge', now)) continue;
      p.merged = true;
      p.mergedAt = t;
      p.armed = false;
      if (serialise) release(p.n, now);
      mainMoved();
    }
  }

  return {
    merged: state.filter((p) => p.merged).length,
    ciRuns: state.map((p) => p.ciRuns),
    totalCiRuns: state.reduce((a, p) => a + p.ciRuns, 0),
    worstCiRuns: Math.max(...state.map((p) => p.ciRuns)),
    lastMergeAt: Math.max(...state.map((p) => p.mergedAt ?? -1)),
  };
}

test('THE TICKET\'S OWN HOW-TO-TEST: three green, ready pull requests merged in sequence', () => {
  // Run as written: "hold three green PRs and merge them in sequence, watching
  // whether each survivor re-runs CI".
  const prs = [601, 602, 603];

  // How it behaves TODAY. The first merge puts the other two behind and
  // discards their checks; the second merge does it again to the third.
  const today = simulate({ prs, serialise: false, start: 'green' });
  assert.equal(today.merged, 3, 'they do all get there — this is waste, not a deadlock');
  assert.deepEqual(today.ciRuns, [0, 1, 2],
    'each survivor re-runs CI once per merge ahead of it — exactly what the ticket watched happen');

  // With the window. This is acceptance criterion 1, verbatim.
  const withWindow = simulate({ prs, serialise: true, start: 'green' });
  assert.equal(withWindow.merged, 3, 'all three merge');
  assert.equal(withWindow.worstCiRuns, 1,
    `no branch re-runs CI more than once (runs per branch: ${withWindow.ciRuns.join(', ')})`);
  assert.ok(withWindow.totalCiRuns < today.totalCiRuns,
    `and it costs strictly fewer CI runs (${withWindow.totalCiRuns} against ${today.totalCiRuns})`);
});

test('WHICH GATE IS ACTUALLY DOING THE WORK — measured, and said out loud', () => {
  // Break-tested, not assumed. Dropping 'update-branch' from WINDOW_ACTIONS
  // fails four of the five tests in this file. Dropping 'merge' or 'arm' fails
  // NONE of them, and that is worth writing down rather than leaving for
  // somebody to rediscover and act on.
  //
  // The reason is not obvious: after ANY merge, every open branch is behind,
  // and only the window-holder is ever caught up — so only the holder can be
  // current-and-green, so only the holder can merge or be usefully armed. The
  // catch-up gate is doing the whole arithmetic on its own.
  //
  // The other two stay gated, and the reason is an INVARIANT rather than a
  // measurement. Both hold only while nothing else moves main, and something
  // else does: `npm run ship` merges without asking this window at all (see the
  // gap measured below). The moment a second actor is in play, an armed or
  // green branch outside the window can land mid-flight and waste the holder's
  // run — which is the wasted run this whole change exists to prevent.
  //
  // So: this file's numbers are NOT evidence for those two gates. The evidence
  // is the invariant, and the guard is the unit test that walks the list
  // (mergeWindowLease.test.js, "only the actions that MOVE MAIN need the
  // window"). A claim nothing measures has to say that it is not measured.
  const { WINDOW_ACTIONS } = require('./mergeWindowLease');
  for (const a of ['update-branch', 'catch-up-locally', 'merge', 'arm']) {
    assert.ok(WINDOW_ACTIONS.includes(a), `${a} moves main, so it takes the window`);
  }
});

test('UNDER SUSTAINED PRESSURE: eight ready pull requests and nothing else touching main', () => {
  // The ticket's real worry — "under sustained pressure it does not resolve on
  // its own". This is where today's behaviour stops looking like slowness and
  // starts looking like its actual shape: the Nth branch pays N CI runs,
  // because each of the N-1 merges ahead of it discards its checks.
  const prs = [601, 602, 603, 604, 605, 606, 607, 608];
  const today = simulate({ prs, serialise: false, minutes: 900 });
  const withWindow = simulate({ prs, serialise: true, minutes: 900 });

  assert.deepEqual(today.ciRuns, [1, 2, 3, 4, 5, 6, 7, 8],
    'today every merge costs every branch behind it another CI run — the waste grows with the queue');
  assert.equal(today.totalCiRuns, 36);

  assert.equal(withWindow.merged, 8, 'the queue drains');
  assert.deepEqual(withWindow.ciRuns, [1, 1, 1, 1, 1, 1, 1, 1],
    'with the window every branch is verified exactly once, however long the queue is');
  assert.equal(withWindow.totalCiRuns, 8);
});

test('THE REMAINING GAP, measured rather than assumed: a merge that does NOT ask the window still resets the holder', () => {
  // A lease only serialises the merges that ask it, and `npm run ship` — the
  // fast-track lane's merge — does not. So a fast-track landing on main while
  // the relay's holder is mid-flight puts that branch BEHIND exactly as before.
  //
  // This test exists so that boundary is a measured, named property instead of
  // a surprise later. It is NOT a failure of the window: the waste still falls
  // by roughly three quarters. Closing it means making `ship` wait on the
  // window too, which would stall the operator's own fast-track behind a
  // machine lane — his call, not a build pass's, so it is filed separately
  // rather than decided here.
  const prs = [601, 602, 603, 604, 605, 606, 607, 608];
  const today = simulate({ prs, serialise: false, externalMergeEvery: 7, minutes: 900 });
  const withWindow = simulate({ prs, serialise: true, externalMergeEvery: 7, minutes: 900 });

  assert.equal(withWindow.merged, 8, 'the queue still drains');
  assert.ok(withWindow.worstCiRuns > 1,
    'the gap is real: an unserialised merge from outside can still reset the holder');
  assert.ok(withWindow.worstCiRuns <= 3,
    `but it is bounded, not the old runaway (worst branch: ${withWindow.worstCiRuns} runs)`);
  assert.ok(withWindow.totalCiRuns * 3 < today.totalCiRuns,
    `and the waste still falls by roughly three quarters (${withWindow.totalCiRuns} runs against ${today.totalCiRuns})`);
});

test('the demonstration measures the POLICY, not the simulator: remove the window and it fails', () => {
  // The break-test, run in code rather than by hand. If `needsMergeWindow` ever
  // stops gating a main move — a renamed action, a dropped entry — the
  // simulation's serialised arm becomes the unserialised one, and this is what
  // notices. Without this, both arms could quietly become the same program.
  const prs = [601, 602, 603];
  const gated = simulate({ prs, serialise: true });
  const ungated = simulate({ prs, serialise: false });
  assert.notDeepEqual(gated.ciRuns, ungated.ciRuns,
    'the two arms must actually differ, or the demonstration is measuring nothing');
});
