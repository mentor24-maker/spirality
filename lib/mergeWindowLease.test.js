'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  LEASE_TTL_MS, WINDOW_ACTIONS, needsMergeWindow, repoKey, asLease, holderFor, heldRepos,
  windowDecision, takeWindow, releaseWindow, releaseSettled,
} = require('./mergeWindowLease');
const { readLeaseFile, writeLeaseFile, saveLeaseIfReadable } = require('./mergeWindowLeaseFile');

const REPO = 'mentor24-maker/starcaster';
const T0 = '2026-09-05T12:00:00.000Z';
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60000).toISOString();
const ok = (lease) => ({ ok: true, lease, file: '/tmp/x.json' });

// ── which actions need the window ────────────────────────────────────────────

test('only the actions that MOVE MAIN need the window', () => {
  for (const a of ['merge', 'update-branch', 'catch-up-locally', 'arm']) {
    assert.equal(needsMergeWindow(a), true, `${a} moves main and must take the window`);
  }
  // A refusal must still be able to explain itself while another branch holds
  // the window, or the operator gets silence where a reason belongs.
  for (const a of ['wait', 'conflict', 'refuse', '', null, undefined, 'disarm']) {
    assert.equal(needsMergeWindow(a), false, `${JSON.stringify(a)} changes nothing on main`);
  }
});

test('every action in WINDOW_ACTIONS is one githubGate or autoMergeDecision can actually produce', () => {
  // A typo here would silently stop gating a real main move: needsMergeWindow
  // would answer false for the action that exists and true for one that does
  // not, and nothing else in the system would notice.
  const real = new Set(['merge', 'update-branch', 'catch-up-locally', 'arm']);
  for (const a of WINDOW_ACTIONS) assert.ok(real.has(a), `${a} is not an action anything produces`);
});

// ── normalising what came off disk ───────────────────────────────────────────

test('junk normalises to a free window rather than a holder nothing can clear', () => {
  for (const junk of [null, undefined, 42, 'nope', {}, { windows: null }, { windows: 'x' }]) {
    assert.deepEqual(asLease(junk), { windows: {} });
  }
});

test('a holder with no PR number, or no timestamp, is dropped — it could never expire', () => {
  // Kept, it would wedge that repo's queue permanently: nothing could match it
  // to a pull request and nothing could time it out.
  assert.deepEqual(asLease({ windows: { [REPO]: { takenAt: T0 } } }).windows, {});
  assert.deepEqual(asLease({ windows: { [REPO]: { pr: 7 } } }).windows, {});
  assert.deepEqual(asLease({ windows: { [REPO]: { pr: 0, takenAt: T0 } } }).windows, {});
  assert.deepEqual(asLease({ windows: { [REPO]: { pr: 7, takenAt: 'not a date' } } }).windows, {});
});

test('the repo key is case-insensitive, so one repo cannot hold two windows', () => {
  const lease = { windows: { 'Mentor24-Maker/StarCaster': { pr: 7, takenAt: T0 } } };
  assert.equal(holderFor(lease, REPO).pr, 7);
  assert.equal(repoKey('  MENTOR24-MAKER/STARCASTER '), REPO);
});

// ── the decision ─────────────────────────────────────────────────────────────

test('a free window is taken', () => {
  const d = windowDecision({ read: ok({ windows: {} }), repo: REPO, pr: 601, now: T0 });
  assert.equal(d.action, 'take');
  assert.equal(d.cannotTell, false);
});

test('the holder itself may proceed', () => {
  const lease = takeWindow({ read: ok(null), repo: REPO, pr: 601, now: T0 });
  const d = windowDecision({ read: ok(lease), repo: REPO, pr: 601, now: at(3) });
  assert.equal(d.action, 'proceed');
});

test('a second pull request is BLOCKED, and the reason says why in the operator\'s terms', () => {
  const lease = takeWindow({ read: ok(null), repo: REPO, pr: 601, now: T0 });
  const d = windowDecision({ read: ok(lease), repo: REPO, pr: 602, now: at(3) });
  assert.equal(d.action, 'blocked');
  assert.equal(d.cannotTell, false, 'a reading WAS taken — this is "not yet", not "could not tell"');
  assert.match(d.reason, /PR #601/);
  assert.match(d.reason, /restart its checks/);
});

test('AN UNREADABLE WINDOW COUNTS AS HELD — the fail-safe, and it is a cannot-tell', () => {
  // The ticket names the two failure directions and they are not symmetric:
  // merging something whose merged state was never verified is the one to
  // avoid; a slower queue is the one to accept.
  const d = windowDecision({ read: { ok: false, why: 'the file is torn' }, repo: REPO, pr: 601, now: T0 });
  assert.equal(d.action, 'blocked');
  assert.equal(d.cannotTell, true);
  assert.match(d.reason, /CANNOT TELL/);
  assert.match(d.reason, /the file is torn/);
});

test('a missing repo or PR number is blocked, never waved through', () => {
  assert.equal(windowDecision({ read: ok({}), repo: REPO, pr: null, now: T0 }).action, 'blocked');
  assert.equal(windowDecision({ read: ok({}), repo: '', pr: 601, now: T0 }).action, 'blocked');
});

test('a hold past the bound is taken over, and the takeover is reported as a finding', () => {
  const lease = takeWindow({ read: ok(null), repo: REPO, pr: 601, now: T0 });
  const justUnder = windowDecision({ read: ok(lease), repo: REPO, pr: 602, now: at(44) });
  assert.equal(justUnder.action, 'blocked', '44 minutes is still inside the 45-minute bound');

  const past = windowDecision({ read: ok(lease), repo: REPO, pr: 602, now: at(46) });
  assert.equal(past.action, 'take');
  assert.equal(past.expired.pr, 601, 'the caller needs the stuck PR to report it');
  assert.match(past.reason, /needs an agent session/);
});

test('the bound is 45 minutes — long enough that a HEALTHY hold is never taken away', () => {
  // Derived: two relay cycles (10 min each) plus CI p95 (2.3 min) is the
  // longest a hold should legitimately last. Too SHORT re-creates the bug it
  // fixes, by letting a second branch in while the first one's CI is running.
  const worstHealthyMinutes = 2 * 10 + 2.3;
  assert.ok(LEASE_TTL_MS / 60000 > worstHealthyMinutes,
    'the bound must exceed the longest healthy hold, or it re-creates the livelock');
  assert.equal(LEASE_TTL_MS, 45 * 60 * 1000);
});

// ── one window per repository ────────────────────────────────────────────────

test('a hold on ANOTHER repository does not block this one', () => {
  // pulse and starcaster have different mains; a merge on one cannot put a
  // branch on the other behind. A single global window would be safe and wrong
  // in the expensive direction.
  const lease = takeWindow({ read: ok(null), repo: 'mentor24-maker/pulse', pr: 12, now: T0 });
  const d = windowDecision({ read: ok(lease), repo: REPO, pr: 601, now: at(1) });
  assert.equal(d.action, 'take');
});

test('taking one repository\'s window leaves every other repository\'s holder alone', () => {
  const first = takeWindow({ read: ok(null), repo: 'mentor24-maker/pulse', pr: 12, now: T0 });
  const second = takeWindow({ read: ok(first), repo: REPO, pr: 601, now: at(1) });
  assert.equal(holderFor(second, 'mentor24-maker/pulse').pr, 12, 'the whole file is written — a careless take would free a window this pass never looked at');
  assert.equal(holderFor(second, REPO).pr, 601);
});

// ── releasing ────────────────────────────────────────────────────────────────

test('a pull request may only release ITS OWN hold', () => {
  const lease = takeWindow({ read: ok(null), repo: REPO, pr: 601, now: T0 });
  const wrong = releaseWindow({ read: ok(lease), repo: REPO, pr: 602 });
  assert.equal(wrong.changed, false, 'releasing somebody else\'s hold is how two branches end up in the window at once');
  assert.match(wrong.reason, /PR #601 holds/);

  const mine = releaseWindow({ read: ok(lease), repo: REPO, pr: 601 });
  assert.equal(mine.changed, true);
  assert.equal(holderFor(mine.lease, REPO), null);
});

test('an unreadable window is NEVER written over on release', () => {
  const r = releaseWindow({ read: { ok: false, why: 'torn' }, repo: REPO, pr: 601 });
  assert.equal(r.changed, false);
  assert.equal(r.lease, null);
});

test('releaseSettled frees a MERGED or CLOSED holder — the primary release', () => {
  const lease = takeWindow({ read: ok(null), repo: REPO, pr: 601, now: T0 });
  for (const state of ['MERGED', 'CLOSED', 'merged']) {
    const r = releaseSettled({ read: ok(lease), repo: REPO, state, now: at(5) });
    assert.equal(r.changed, true, `${state} is out of the window`);
  }
  const open = releaseSettled({ read: ok(lease), repo: REPO, state: 'OPEN', now: at(5) });
  assert.equal(open.changed, false);
});

test('releaseSettled keeps the hold when the state could NOT be read', () => {
  // "I could not check" is not "it is gone" (DOCTRINE 3.11).
  const lease = takeWindow({ read: ok(null), repo: REPO, pr: 601, now: T0 });
  const r = releaseSettled({ read: ok(lease), repo: REPO, state: '', now: at(5) });
  assert.equal(r.changed, false);
  assert.match(r.reason, /CANNOT TELL/);
});

test('releaseSettled still frees a hold past the bound even when the state is unreadable', () => {
  // Otherwise an unreachable GitHub would stop the queue permanently.
  const lease = takeWindow({ read: ok(null), repo: REPO, pr: 601, now: T0 });
  const r = releaseSettled({ read: ok(lease), repo: REPO, state: '', now: at(50) });
  assert.equal(r.changed, true);
  assert.match(r.reason, /needs an agent session/);
});

test('heldRepos lists every hold for the pass to check on, and nothing when unreadable', () => {
  const one = takeWindow({ read: ok(null), repo: REPO, pr: 601, now: T0 });
  const two = takeWindow({ read: ok(one), repo: 'mentor24-maker/pulse', pr: 12, now: T0 });
  assert.equal(heldRepos(ok(two)).length, 2);
  assert.deepEqual(heldRepos({ ok: false, why: 'torn' }), []);
});

// ── the file half ────────────────────────────────────────────────────────────

test('a missing file is a FREE window; an unparseable one is not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-window-'));
  const file = path.join(dir, 'merge-window-lease.json');

  const fresh = readLeaseFile(file);
  assert.equal(fresh.ok, true, 'a first run is not a fault');
  assert.deepEqual(fresh.lease.windows, {});

  fs.writeFileSync(file, '{ not json');
  const torn = readLeaseFile(file);
  assert.equal(torn.ok, false, 'an unreadable window must stop merges, not be waved through');
  assert.match(torn.why, /could not be read/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('AN UNREADABLE WINDOW IS NEVER WRITTEN OVER — autoMergeLedgerFile\'s incident, same shape', () => {
  // 2026-08-30: a corrupt ledger was replaced with an empty one by the very
  // pass that tripped its fail-safe, so the stop it recorded lasted one pass.
  // Here the same bug would hand the window to a second branch.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-window-'));
  const file = path.join(dir, 'merge-window-lease.json');
  fs.writeFileSync(file, '{ torn');

  const read = readLeaseFile(file);
  const saved = saveLeaseIfReadable(read, { windows: {} });
  assert.equal(saved.ok, false);
  assert.equal(saved.skipped, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ torn', 'the torn file is left exactly as it was');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a write round-trips, and normalises on the way out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-window-'));
  const file = path.join(dir, 'merge-window-lease.json');
  const lease = takeWindow({ read: ok(null), repo: REPO, pr: 601, task: '86bbuv9jt', branch: 'b', headSha: 'deadbeef', now: T0 });
  assert.equal(writeLeaseFile(lease, file).ok, true);
  const back = readLeaseFile(file);
  assert.equal(back.ok, true);
  assert.deepEqual(holderFor(back.lease, REPO), {
    pr: 601, task: '86bbuv9jt', branch: 'b', headSha: 'deadbeef', takenAt: T0,
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── the relay must actually use this, and must not use it in a dry run ───────

const RELAY_SRC = fs.readFileSync(path.join(__dirname, '..', 'clickup_direct.mjs'), 'utf8');

test('the relay CALLS the window — a gate nothing calls is not a gate', () => {
  // autoMergeLane shipped a decision function with no caller once already.
  assert.match(RELAY_SRC, /mergeWindowLease\.windowDecision\(/, 'the decision must be asked for');
  assert.match(RELAY_SRC, /mergeWindowLease\.takeWindow\(/, 'and the window actually taken');
  assert.match(RELAY_SRC, /mergeWindowLease\.releaseWindow\(/, 'and given back');
  assert.match(RELAY_SRC, /mergeWindowLease\.releaseSettled\(/, 'and swept, or the bound is the only release');
  assert.match(RELAY_SRC, /claimMergeWindow\('merge'\)/, 'the merge itself must claim it');
  assert.match(RELAY_SRC, /claimMergeWindow\('update-branch'\)/, 'and so must the catch-up');
  assert.match(RELAY_SRC, /claimMergeWindow\('arm'\)/, 'and so must arming');
  // Two routes push a catch-up: the BEHIND path and the GitHub/git
  // disagreement path. Gating one and not the other is a bypass.
  const local = RELAY_SRC.match(/claimMergeWindow\('catch-up-locally'\)/g) || [];
  assert.equal(local.length, 2, 'both local catch-up paths push, so both take the window');
});

test('A DRY RUN NEITHER TAKES NOR RELEASES THE WINDOW — found by running one', () => {
  // `npm run clickup -- bus-relay --dry-run` printed "MERGE WINDOW taken by
  // PR #613" and wrote .git/merge-window-lease.json, on a run whose whole
  // promise is that it changes nothing. That is not a cosmetic write: a window
  // taken by a dry run stops every REAL merge on this machine until the
  // 45-minute bound expires, and freeing one belongs to a pass mid-flight.
  const takeAt = RELAY_SRC.indexOf('mergeWindowLease.takeWindow(');
  const guardAt = RELAY_SRC.lastIndexOf('if (dryRun) {', takeAt);
  assert.ok(guardAt !== -1 && takeAt - guardAt < 800,
    'the dry-run guard must sit immediately before the window is taken');

  const releaseBody = RELAY_SRC.slice(
    RELAY_SRC.indexOf('releaseMergeWindow = (why) => {'),
    RELAY_SRC.indexOf('mergeWindowLease.releaseWindow('),
  );
  assert.match(releaseBody, /if \(dryRun\)/, 'and releasing must be guarded too — the more dangerous half');
});
