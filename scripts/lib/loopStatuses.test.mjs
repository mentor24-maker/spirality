import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimOrder, isClaimableByBuild, isOperatorStatus, claimTier, compareWithinStatus, STAGE_ORDER, DISPLAY,
  REQUESTED, MACHINE_STATUSES, TERMINAL_STATUSES,
} from './loopStatuses.mjs';
import cjs from '../../lib/loopStatuses.js';

const t = (id, status, priority, created) => ({
  id, status: { status }, priority: priority ? { priority } : null, date_created: String(created),
});

test('claim order: every Rework before any Queued, rework oldest first ignoring priority', () => {
  const tasks = [
    t('q-high-old', 'Queued', 'high', 100),
    t('r-low-new', 'rework', 'low', 500),
    t('r-urgent-old', 'Rework', 'urgent', 400),
    t('q-normal-older', 'queued', 'normal', 50),
    t('building', 'Building', 'urgent', 1),
    t('r-none-oldest', 'Rework', null, 300),
  ];
  assert.deepEqual(claimOrder(tasks).map((x) => x.id), [
    'r-none-oldest', 'r-urgent-old', 'r-low-new', 'q-high-old', 'q-normal-older',
  ]);
});

test('queued tier: priority first, then oldest', () => {
  const tasks = [t('a', 'Queued', 'normal', 10), t('b', 'Queued', 'high', 20), t('c', 'Queued', null, 5)];
  assert.deepEqual(claimOrder(tasks).map((x) => x.id), ['b', 'a', 'c']);
});

const placed = (id, status, priority, created, place) => ({ ...t(id, status, priority, created), place });

test('queued tier: same priority, placed 2, 1 and none: place 1, place 2, then the unplaced one (SP-249)', () => {
  const tasks = [
    placed('none-oldest', 'Queued', 'normal', 1, null),
    placed('two', 'Queued', 'normal', 30, 2),
    placed('one', 'Queued', 'normal', 40, 1),
  ];
  assert.deepEqual(claimOrder(tasks).map((x) => x.id), ['one', 'two', 'none-oldest']);
  assert.deepEqual(cjs.claimOrder(tasks).map((x) => x.id), ['one', 'two', 'none-oldest'], 'both modules agree');
});

test('priority beats place: a High ticket with no place comes before a Normal ticket placed 1', () => {
  const tasks = [placed('normal-1', 'Queued', 'normal', 1, 1), placed('high-none', 'Queued', 'high', 99, null)];
  assert.deepEqual(claimOrder(tasks).map((x) => x.id), ['high-none', 'normal-1']);
  assert.deepEqual(cjs.claimOrder(tasks).map((x) => x.id), ['high-none', 'normal-1']);
  assert.deepEqual(tasks.slice().sort(compareWithinStatus).map((x) => x.id), ['high-none', 'normal-1']);
});

test('rework order ignores place: oldest first, whatever the places', () => {
  const tasks = [
    placed('r-new-1', 'Rework', 'normal', 50, 1),
    placed('r-old-none', 'Rework', 'normal', 10, null),
    placed('r-mid-2', 'Rework', 'urgent', 30, 2),
  ];
  assert.deepEqual(claimOrder(tasks).map((x) => x.id), ['r-old-none', 'r-mid-2', 'r-new-1']);
  assert.deepEqual(cjs.claimOrder(tasks).map((x) => x.id), ['r-old-none', 'r-mid-2', 'r-new-1']);
});

test('with no places set (every ticket before SP-249, every ClickUp task) the order is exactly as before', () => {
  const tasks = [
    t('q-high-old', 'Queued', 'high', 100), t('r-low-new', 'rework', 'low', 500), t('r-urgent-old', 'Rework', 'urgent', 400),
    t('q-normal-older', 'queued', 'normal', 50), t('q-normal-newer', 'queued', 'normal', 60), t('r-none-oldest', 'Rework', null, 300),
  ];
  const expected = ['r-none-oldest', 'r-urgent-old', 'r-low-new', 'q-high-old', 'q-normal-older', 'q-normal-newer'];
  assert.deepEqual(claimOrder(tasks).map((x) => x.id), expected);
  assert.deepEqual(claimOrder(tasks.map((x) => ({ ...x, place: null }))).map((x) => x.id), expected);
  assert.deepEqual(cjs.claimOrder(tasks).map((x) => x.id), expected);
});

test('within one status: priority, then place, then oldest; a nonsense place counts as none', () => {
  const tasks = [
    placed('n-old', 'Ready to launch', 'normal', 1, null),
    placed('n-3', 'Ready to launch', 'normal', 9, 3),
    placed('n-1', 'Ready to launch', 'normal', 8, 1),
    placed('n-bad', 'Ready to launch', 'normal', 2, 0),
    placed('u', 'Ready to launch', 'urgent', 7, null),
  ];
  assert.deepEqual(tasks.slice().sort(compareWithinStatus).map((x) => x.id), ['u', 'n-1', 'n-3', 'n-old', 'n-bad']);
});

test('only Rework and Queued are claimable; case does not matter', () => {
  assert.equal(isClaimableByBuild('REWORK'), true);
  assert.equal(isClaimableByBuild(' queued '), true);
  for (const s of ['Building', 'In review', 'Needs your input', 'Ready to launch', 'Live', '']) {
    assert.equal(isClaimableByBuild(s), false, s);
  }
  assert.equal(claimTier('Rework'), 0);
  assert.equal(claimTier('Queued'), 1);
  assert.equal(claimTier('Live'), null);
});

test('the two operator statuses are the only ones that hand work to Dane', () => {
  assert.equal(isOperatorStatus('Needs your input'), true);
  assert.equal(isOperatorStatus('ready to launch'), true);
  assert.equal(isOperatorStatus('In review'), false);
});

test('the board lists all eight statuses and DISPLAY spells each one', () => {
  assert.equal(STAGE_ORDER.length, 8);
  for (const name of STAGE_ORDER) assert.equal(DISPLAY[name.toLowerCase()], name);
});

test('both status modules spell the eight statuses the same, in the same order', () => {
  assert.deepEqual([...STAGE_ORDER], [...cjs.STAGE_ORDER]);
  assert.deepEqual({ ...DISPLAY }, { ...cjs.DISPLAY });
});

test('Requested is first, a machine status, and not claimable, not Dane\'s, not terminal', () => {
  assert.equal(STAGE_ORDER[0], 'Requested');
  assert.equal(DISPLAY[REQUESTED], 'Requested');
  assert.equal(isClaimableByBuild('Requested'), false);
  assert.equal(claimTier('requested'), null);
  assert.deepEqual(claimOrder([t('r', 'Requested', 'urgent', 1)]), []);
  assert.equal(isOperatorStatus('Requested'), false);
  assert.ok(MACHINE_STATUSES.includes(REQUESTED), 'a spec pass owns it');
  assert.ok(!TERMINAL_STATUSES.includes(REQUESTED));
});

test('claimOrder never mutates its input', () => {
  const tasks = [t('b', 'Queued', 'low', 2), t('a', 'Queued', 'high', 1)];
  const before = tasks.map((x) => x.id);
  claimOrder(tasks);
  assert.deepEqual(tasks.map((x) => x.id), before);
  assert.deepEqual([t('x', 'Queued', 'low', 1), t('y', 'Queued', 'high', 2)].sort(compareWithinStatus).map((x) => x.id), ['y', 'x']);
});
