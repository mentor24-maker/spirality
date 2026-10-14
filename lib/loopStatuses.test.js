'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const loopStatuses = require('./loopStatuses.js');
const {
  REWORK, QUEUED, CLAIMABLE_BY_BUILD, STAGE_ORDER,
  isClaimableByBuild, claimTier, claimOrder, statusOf,
} = loopStatuses;

/** A ClickUp task, as the list endpoint shapes one. */
function task(id, status, { priority = 'normal', created = 1_000 } = {}) {
  return {
    id,
    status: { status },
    priority: priority ? { priority } : null,
    date_created: String(created),
    name: `${id} (${status})`,
  };
}

// Days, in the milliseconds ClickUp reports.
const DAY = 24 * 60 * 60 * 1000;
const AUG_25 = Date.parse('2026-08-25T00:00:00Z');
const TODAY = Date.parse('2026-08-31T00:00:00Z');

test('rework drains before queued, and that is the whole ticket', () => {
  assert.deepEqual([...CLAIMABLE_BY_BUILD], ['rework', 'queued']);
  assert.equal(claimTier(REWORK), 0);
  assert.equal(claimTier(QUEUED), 1);
});

test('a status loop-build may not claim has no tier at all', () => {
  // null, not a big number: a caller sorting on this must decide what to do
  // with a ticket that is not in the contest, rather than have it quietly
  // sort to the end and look claimable.
  for (const s of ['building', 'in review', 'ready to launch', 'needs your input', 'live', '', 'REWORKED']) {
    assert.equal(claimTier(s), null, `"${s}" must not be claimable`);
    assert.equal(isClaimableByBuild(s), false, `"${s}" must not be claimable`);
  }
});

test('status matching is case- and whitespace-insensitive, as ClickUp is', () => {
  assert.equal(isClaimableByBuild('Rework'), true);
  assert.equal(isClaimableByBuild('  QUEUED '), true);
  assert.equal(statusOf({ status: { status: 'Rework' } }), 'rework');
  assert.equal(statusOf('In Review'), 'in review');
});

/**
 * THE FIXTURE FROM THE TICKET, verbatim (acceptance criterion 2): one Rework
 * at normal priority created weeks ago, one Queued at urgent created today.
 * The Rework one is claimed.
 *
 * This is the assertion the whole ticket turns on. Under the old rule — one
 * status, sorted priority-then-age — the urgent fresh ticket wins every time,
 * which is exactly how #419 has been losing since 25 August.
 */
test('an old normal-priority Rework beats a fresh urgent Queued', () => {
  const stale = task('86bbjve6b', 'Rework', { priority: 'normal', created: AUG_25 });
  const fresh = task('86bbr1u9v', 'Queued', { priority: 'urgent', created: TODAY });

  const order = claimOrder([fresh, stale]);
  assert.equal(order[0].id, '86bbjve6b', 'the Rework ticket must be claimed first');
  assert.equal(order[1].id, '86bbr1u9v');

  // And the input order must not decide it.
  assert.equal(claimOrder([stale, fresh])[0].id, '86bbjve6b');
});

test('BREAK TEST — this fails alone if rework stops outranking queued', () => {
  // The guard the ticket asks for: "break it on purpose and watch it fail
  // alone". Simulating the old rule (priority, then age, across both statuses)
  // must produce a DIFFERENT answer from claimOrder, or the ordering rule is
  // not doing anything and the test above could not fail.
  const stale = task('old-rework', 'Rework', { priority: 'normal', created: AUG_25 });
  const fresh = task('new-urgent', 'Queued', { priority: 'urgent', created: TODAY });

  const oldRule = [fresh, stale].slice().sort((a, b) =>
    (loopStatuses.PRIORITY_RANK[a.priority.priority] ?? 9)
      - (loopStatuses.PRIORITY_RANK[b.priority.priority] ?? 9)
    || Number(a.date_created) - Number(b.date_created));

  assert.equal(oldRule[0].id, 'new-urgent', 'the old rule really did prefer the fresh urgent one');
  assert.notEqual(
    claimOrder([fresh, stale])[0].id,
    oldRule[0].id,
    'claimOrder must disagree with the old priority-first rule, or it is a no-op',
  );
});

test('within Rework it is oldest-first and priority is ignored', () => {
  // Deliberate: priority says what to START, and rework is not started. Sorting
  // rework by priority recreates the same starvation one tier down.
  const oldLow = task('old-low', 'Rework', { priority: 'low', created: TODAY - 30 * DAY });
  const newUrgent = task('new-urgent', 'Rework', { priority: 'urgent', created: TODAY });
  assert.deepEqual(claimOrder([newUrgent, oldLow]).map((t) => t.id), ['old-low', 'new-urgent']);
});

test('within Queued the old rule is untouched: priority, then oldest', () => {
  const oldNormal = task('old-normal', 'Queued', { priority: 'normal', created: TODAY - 30 * DAY });
  const newHigh = task('new-high', 'Queued', { priority: 'high', created: TODAY });
  const olderHigh = task('older-high', 'Queued', { priority: 'high', created: TODAY - DAY });
  assert.deepEqual(
    claimOrder([oldNormal, newHigh, olderHigh]).map((t) => t.id),
    ['older-high', 'new-high', 'old-normal'],
  );
});

test('a ticket in any other status is filtered out entirely, not just sorted last', () => {
  const rows = [
    task('a', 'Building'),
    task('b', 'In review'),
    task('c', 'Live'),
    task('d', 'Queued'),
    task('e', 'Rework'),
  ];
  assert.deepEqual(claimOrder(rows).map((t) => t.id), ['e', 'd']);
});

test('garbage in the list does not throw and does not become a claim', () => {
  assert.deepEqual(claimOrder(null), []);
  assert.deepEqual(claimOrder([null, undefined, 42, 'queued', {}]).map((t) => t.id), []);
});

test('claimOrder does not mutate the caller\'s array', () => {
  const rows = [task('q', 'Queued'), task('r', 'Rework')];
  const before = rows.map((t) => t.id);
  claimOrder(rows);
  assert.deepEqual(rows.map((t) => t.id), before);
});

test('a missing priority sorts last, never first', () => {
  const none = { id: 'none', status: { status: 'Queued' }, date_created: '1' };
  const low = task('low', 'Queued', { priority: 'low', created: 9_999 });
  assert.deepEqual(claimOrder([none, low]).map((t) => t.id), ['low', 'none']);
});

test('the stage line-up carries every status, Rework included', () => {
  // The weekly report renders exactly this list, so a status missing here does
  // not show as zero — its tickets vanish from the picture entirely.
  assert.deepEqual([...STAGE_ORDER], [
    'Rework', 'Queued', 'Building', 'In review', 'Needs your input', 'Ready to launch', 'Live',
  ]);
  for (const s of CLAIMABLE_BY_BUILD) {
    assert.ok(STAGE_ORDER.includes(loopStatuses.DISPLAY[s]), `${s} must be renderable`);
  }
});

// ---------------------------------------------------------------------------
// The taxonomy (2026-09-02, task 86bbtujed — audit Phase 2). Until today
// wipCap, pipelinePause and pulse each kept a private, partial copy of these
// sets; Rework (8/31) had to be threaded through each by hand, and wipCap and
// pulse had drifted into DISAGREEING about what "done" means. The sets live
// here now; consumers hold views.
// ---------------------------------------------------------------------------

const tfs = require('node:fs');
const tpath = require('node:path');
const wipCapMod = require('./wipCap.js');
const pauseMod = require('./pipelinePause.js');
const pulseMod = require('./pulse.js');
// lib/loopThroughput.js is not in this package yet: it requires StarCaster's
// machine registry and heartbeat table (nodeRoles, nodeHeartbeat), which are
// product facts, not substrate — see the slice-2 note on task 86bcgmnpy. The
// reads below that need it skip, out loud, until it has a home here.
const THROUGHPUT_FILE = tpath.join(__dirname, 'loopThroughput.js');
const throughputMod = tfs.existsSync(THROUGHPUT_FILE) ? require(THROUGHPUT_FILE) : null;
function skipWithoutThroughput(t) {
  if (throughputMod) return false;
  t.skip('lib/loopThroughput.js is not in this package yet (it carries StarCaster\'s machine registry) — task 86bcgmnpy, slice 2 note');
  return true;
}

test('the taxonomy is internally coherent', () => {
  const s = require('./loopStatuses.js');
  assert.deepEqual([...s.TERMINAL_STATUSES], [s.LIVE],
    'decision D1 (Dane, 2026-09-02): live is the ONLY terminal status');
  for (const alias of s.TERMINAL_ALIASES) {
    assert.ok(!(alias in s.DISPLAY),
      `"${alias}" is an alias for a status this list does not have — it must never become a real one silently`);
  }
  for (const held of s.OPERATOR_HELD_STATUSES) {
    assert.ok(s.IN_FLIGHT_STATUSES.includes(held),
      'operator-held work is still in-flight work — a full inbox is a full pipeline');
  }

  // IN_PROGRESS is in-flight minus operator-held, and it is a PARTITION: the
  // two halves add back up to the whole, with nothing in both and nothing in
  // neither (2026-09-04, task 86bbuzzbk). Asserted as a relationship rather
  // than as a literal list, so re-listing either side by hand breaks it.
  assert.deepEqual(
    [...s.IN_PROGRESS_STATUSES].sort(),
    s.IN_FLIGHT_STATUSES.filter((x) => !s.OPERATOR_HELD_STATUSES.includes(x)).sort(),
  );
  assert.deepEqual(
    [...s.IN_PROGRESS_STATUSES, ...s.OPERATOR_HELD_STATUSES].sort(),
    [...s.IN_FLIGHT_STATUSES].sort(),
    'the two halves must reconstitute in-flight exactly — no status may fall between them',
  );
  for (const held of s.OPERATOR_HELD_STATUSES) {
    assert.ok(!s.IN_PROGRESS_STATUSES.includes(held),
      `"${held}" is parked on Dane — it must not count against the BUILD cap`);
  }
});

test('every consumer holds a VIEW of the taxonomy, not a copy', (t) => {
  if (skipWithoutThroughput(t)) return;
  // Same object, not merely equal arrays: an equal copy is a copy that can
  // drift the day someone edits one of them.
  const s = require('./loopStatuses.js');
  assert.equal(wipCapMod.IN_FLIGHT_STATUSES, s.IN_FLIGHT_STATUSES);
  assert.equal(wipCapMod.TERMINAL_STATUSES, s.TERMINAL_STATUSES);
  assert.equal(throughputMod.TERMINAL_STATUSES, s.TERMINAL_STATUSES);
  // pipelinePause's pair is the NARROW view — is a PASS running — which is
  // exactly IN_FLIGHT minus OPERATOR_HELD, derived here so the relationship
  // itself is what breaks if someone edits one side.
  // That narrow view has a name of its own since task 86bbuzzbk, because
  // wipCap's build cap now measures against the same set. Asserted through the
  // NAME so the two consumers cannot drift apart silently.
  assert.deepEqual(Object.keys(pauseMod.IN_FLIGHT_STATUSES).sort(), [...s.IN_PROGRESS_STATUSES].sort());
  assert.equal(wipCapMod.IN_PROGRESS_STATUSES, s.IN_PROGRESS_STATUSES);
  assert.equal(wipCapMod.OPERATOR_HELD_STATUSES, s.OPERATOR_HELD_STATUSES);
});

test('no consumer file defines a status name in executable text any more', (t) => {
  // The enforcement of "defined here and only here". Multi-word names cannot
  // appear by accident; a quoted one in executable text is a new private list
  // being born. `building`/`live` alone are too common in prose to scan for —
  // but no private list of these sets has ever omitted the multi-word names.
  const files = [
    ['lib/wipCap.js', __dirname + '/wipCap.js'],
    ['lib/pipelinePause.js', __dirname + '/pipelinePause.js'],
    ['lib/pulse.js', __dirname + '/pulse.js'],
    ['lib/loopThroughput.js', THROUGHPUT_FILE],
  ];
  for (const [label, file] of files) {
    if (file === THROUGHPUT_FILE && !throughputMod) {
      t.diagnostic(`${label} is not in this package yet — its row is not checked (task 86bcgmnpy, slice 2 note)`);
      continue;
    }
    const src = tfs.readFileSync(file, 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    for (const name of ['in review', 'ready to launch', 'needs your input']) {
      assert.ok(!code.includes(`'${name}'`) && !code.includes(`"${name}"`),
        `${label} quotes "${name}" in executable text — that is a private status list being born; import loopStatuses instead`);
    }
  }
});

test('an alias status is reported loudly, never silently counted either way', () => {
  const s = require('./loopStatuses.js');
  // wipCap: a PR whose ticket wears "complete" lands in `unrecognised`, which
  // QUOTES the status — not in `live` (the pre-D1 silent reading), and never
  // in flight.
  const g = wipCapMod.classifyPrs({
    prs: [{ number: 9, state: 'OPEN', body: 'ClickUp: https://app.clickup.com/t/x1' }],
    ticketStatusById: { x1: 'Complete' },
  });
  assert.deepEqual(g.live, [], 'not silently "done"');
  assert.deepEqual(g.inFlight, [], 'not silently in flight either');
  assert.deepEqual(g.unrecognised, [{ number: 9, status: 'Complete' }], 'said out loud, by name');
  // pulse: the NAME is not terminal…
  assert.equal(pulseMod.isTerminalStatus('complete', ''), false);
  // …but ClickUp's own status.type saying closed still is — that check is a
  // different sense of "done" and D1 deliberately left it alone.
  assert.equal(pulseMod.isTerminalStatus('complete', 'closed'), true);
  assert.equal(pulseMod.isTerminalStatus(s.LIVE, ''), true);
});
