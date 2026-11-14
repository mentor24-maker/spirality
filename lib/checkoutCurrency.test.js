'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const cc = require('./checkoutCurrency');

/**
 * Task 86bbrf2vf. The Mac Mini could not update itself for hours and said so
 * only to a log file nobody reads — and the reason it printed was wrong.
 *
 * The tests that matter most here are the two that were wrong in the live
 * incident: that a blocked update is NAMED correctly (not called a
 * divergence), and that being behind is what alarms — not untidiness.
 */

// The exact stderr git produced on the Mini, 2026-09-01.
const REAL_STDERR = [
  'error: The following untracked working tree files would be overwritten by merge:',
  '\tdocs/reports/2026-08-30.data.json',
  '\tdocs/reports/2026-08-30.html',
  '\tdocs/reports/index.html',
  'Please move or remove them before you merge.',
  'Aborting',
  'Updating f89fda9d..7c844b59',
].join('\n');

const behind = (over) => cc.classify({
  branch: 'main', dirty: false, fetched: true, behind: 7, ahead: 0,
  lastSuccessAt: Date.parse('2026-08-31T14:22:00Z'),
  now: Date.parse('2026-09-01T10:10:00Z'),
  ...over,
});

// ── the case that actually happened ──────────────────────────────────────

test('blocked by untracked files is named as that, and NOT as a divergence', () => {
  const s = behind({ mergeStderr: REAL_STDERR });
  assert.equal(s.state, cc.STATES.BLOCKED_UNTRACKED);
  assert.equal(s.alarm, true);
  assert.deepEqual(s.blocking, [
    'docs/reports/2026-08-30.data.json',
    'docs/reports/2026-08-30.html',
    'docs/reports/index.html',
  ]);
  // The specific defect: the live script called this a divergence and sent
  // the reader hunting through history for something that did not exist.
  assert.doesNotMatch(s.reason, /diverged/i);
  assert.match(s.reason, /untracked file\(s\) would be overwritten/);
});

test('the report names the files, the distance and the age — not just "skipped"', () => {
  const text = cc.report(behind({ mergeStderr: REAL_STDERR }), { node: 'mac-mini' });
  assert.match(text, /STALE/);
  assert.match(text, /Behind origin\/main by 7 commit/);
  assert.match(text, /2026-08-31 14:22/, 'when it last worked');
  assert.match(text, /20h ago/, 'and how long that has been');
  assert.match(text, /docs\/reports\/index\.html/, 'and WHICH files');
  assert.match(text, /--fix/, 'and the repair that exists');
});

test('git stderr that is not this error yields no file list', () => {
  assert.deepEqual(cc.blockingUntrackedPaths('fatal: refusing to merge unrelated histories'), []);
  assert.deepEqual(cc.blockingUntrackedPaths(''), []);
  assert.deepEqual(cc.blockingUntrackedPaths(undefined), []);
});

// ── what must NOT alarm ──────────────────────────────────────────────────

test('a level checkout never alarms, however untidy the folder is', () => {
  // The noise guard. Somebody working on the Mini leaves a dirty tree or a
  // branch checked out; announcing that every six hours is the wallpaper that
  // makes the real alarm unreadable. The harm is running OLD code.
  for (const over of [{ dirty: true }, { branch: 'some-thread' }, { branch: '?', dirty: true }]) {
    const s = cc.classify({ branch: 'main', dirty: false, fetched: true, behind: 0, ahead: 0, ...over });
    assert.equal(s.alarm, false, `behind 0 must never alarm (${JSON.stringify(over)})`);
  }
});

test('being behind is what alarms — each cause named separately', () => {
  assert.equal(behind({ branch: 'some-thread' }).state, cc.STATES.NOT_ON_MAIN);
  assert.equal(behind({ dirty: true }).state, cc.STATES.DIRTY);
  assert.equal(behind({ ahead: 3 }).state, cc.STATES.DIVERGED);
  assert.equal(behind({ mergeStderr: 'error: something else entirely' }).state, cc.STATES.BLOCKED_OTHER);
  for (const s of [behind({ branch: 'x' }), behind({ dirty: true }), behind({ ahead: 3 })]) {
    assert.equal(s.alarm, true);
  }
});

test('a real divergence IS still called a divergence, and says by how much', () => {
  const s = behind({ ahead: 3 });
  assert.match(s.reason, /3 commit\(s\) origin does not/);
  assert.match(s.reason, /only a person should sort it out/);
});

// ── cannot tell is not healthy ───────────────────────────────────────────

test('an unreachable origin is CANNOT TELL, never a pass', () => {
  const s = cc.classify({ branch: 'main', dirty: false, fetched: false, behind: 0, ahead: 0 });
  assert.equal(s.state, cc.STATES.UNREACHABLE);
  assert.equal(s.cannotTell, true);
  assert.equal(s.behind, null, 'behind is unknown, not zero — a machine that cannot see origin cannot be told it is current');
  assert.equal(s.alarm, false, 'it is not a stale-code alarm; it is an unanswered question');
  assert.match(cc.report(s), /CANNOT TELL/);
});

// ── the repair, and its limit ────────────────────────────────────────────

test('auto-repair fires only when git has the authoritative copy', () => {
  const blocking = ['docs/reports/index.html', 'docs/reports/2026-08-30.html'];
  const ok = cc.autoRepairable(blocking, new Set(blocking));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.paths, blocking);
});

test('DELIBERATE: a blocking file origin does NOT track is left alone', () => {
  // The safety property. Displacing a file git cannot restore is destroying
  // somebody's work to make a background job convenient.
  const r = cc.autoRepairable(
    ['docs/reports/index.html', 'notes/my-scratch.md'],
    new Set(['docs/reports/index.html']),
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.paths, [], 'nothing is displaced when any one of them is somebody\'s');
  assert.match(r.why, /notes\/my-scratch\.md/, 'and it must say which');
});

test('auto-repair does nothing when nothing is blocking', () => {
  assert.equal(cc.autoRepairable([], new Set(['a'])).ok, false);
});

// ── the bug the live-fire test found, 2026-09-01 ─────────────────────────
// The first implementation read `dirty` from `git status --porcelain`, which
// counts UNTRACKED files. That made the blocked-by-untracked case
// unreachable: the three weekly-report files made the tree read as dirty, so
// the update was skipped with "uncommitted changes present" and the
// fast-forward that would have NAMED them was never attempted. It is also why
// the machine could not repair itself — the recoverable case was being
// treated as somebody's work in progress.
//
// The unit tests above all passed, because they feed `dirty` and
// `mergeStderr` in as independent readings. Only running it against a real
// reproduced checkout showed the two are not independent in the wild.

test('untracked files alone must not be read as "uncommitted changes"', () => {
  // dirty:false is what the caller must supply when the ONLY changes are
  // untracked, and this is the state that then reaches the right branch.
  const s = cc.classify({
    branch: 'main', dirty: false, fetched: true, behind: 4, ahead: 0,
    mergeStderr: REAL_STDERR,
  });
  assert.equal(s.state, cc.STATES.BLOCKED_UNTRACKED,
    'if this reports DIRTY, the caller is counting untracked files and the repair can never fire');
  assert.equal(s.blocking.length, 3);
});

test('the reading the script takes must exclude untracked files', () => {
  // Pinned at source: this is a property of the git invocation, invisible to
  // any test that injects readings (the exact gap that let the bug through).
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../scripts/checkout_currency.mjs'), 'utf8');
  assert.match(src, /'status', '--porcelain', '--untracked-files=no'/,
    'dirty must mean TRACKED changes, or blocked-by-untracked is unreachable');
  assert.doesNotMatch(src, /'status', '--porcelain'\]/,
    'a bare --porcelain reading counts untracked files and reintroduces the bug');
});
