'use strict';

/**
 * The throughput check's decisions, driven with no network, no token and no
 * clock of its own — which is the whole reason lib/loopThroughput.js holds no
 * IO.
 *
 * Every test here is written against a way this feature could fail QUIETLY.
 * That is not a stylistic preference: this is a monitor, and a monitor that
 * fails quietly is worse than not having one, because it converts "nobody is
 * watching" into "something is watching" and then stops anybody looking. The
 * headline case is the one the ticket names — **a stall detector that cannot
 * report a stall** — and it is the first test below.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const lt = require('./loopThroughput.js');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/**
 * Noon UTC, so every fixture instant sits comfortably inside its own UTC day
 * and no assertion here can be moved across a boundary by the clock. Every
 * call passes `calendar: lt.UTC_DAYS` for the same reason — the default is the
 * machine's LOCAL day, which is right for a person reading the report and a
 * flake in a test.
 */
const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const UTC = lt.UTC_DAYS;

/** A ClickUp task, in the shape the API actually returns: millis as STRINGS. */
function task({ id = 't', status = 'queued', created = NOW - 30 * DAY, closed = null, updated = null } = {}) {
  return {
    id,
    status: { status },
    date_created: created === null ? null : String(created),
    date_closed: closed === null ? null : String(closed),
    date_updated: updated === null ? String(created) : String(updated),
  };
}

// --- THE HEADLINE: a stall must be reported as a stall -----------------------

/**
 * The 2026-08-31 fixture the ticket specifies: a week with tickets closing,
 * then 24 hours with none while 52 sit queued.
 *
 * BREAK TEST, run on 2026-08-31 before this was believed. Forcing `verdict()`
 * to always take the IDLE branch (`if (!queue || queue.openWork === 0)` →
 * `if (true)`) fails this test and three others — the empty-Queued-column
 * case, the loopsFiring case, and the report rendering — 4 failed, 15 passed.
 * Restoring the guard returns all 19 to green.
 *
 * Four rather than one because STALLED is asserted from four angles on
 * purpose, and that is the point worth keeping: a detector which cannot report
 * the thing it detects is the exact defect class this ticket was filed about,
 * so it is not left resting on a single assertion.
 */
test('2026-08-31: a week of closures, then 24h of nothing with 52 queued — STALLED', () => {
  const tasks = [];
  // Five days of real delivery, all inside the 7-day report window and all
  // ending before the 24h stall window opens: nine a day, days 6 through 2.
  for (let day = 6; day >= 2; day--) {
    for (let n = 0; n < 9; n++) {
      tasks.push(task({
        id: `live-${day}-${n}`, status: 'live',
        created: NOW - (day + 3) * DAY, closed: NOW - day * DAY + HOUR,
      }));
    }
  }
  // Then the morning that produced this ticket: 52 queued, nothing closing.
  for (let n = 0; n < 52; n++) {
    tasks.push(task({ id: `q-${n}`, status: 'queued', created: NOW - 6 * DAY, updated: NOW - 2 * HOUR }));
  }

  const queue = lt.queueShape(tasks);
  assert.equal(queue.queued, 52);
  assert.equal(queue.openWork, 52);

  const closed = lt.closedPerDay({ tasks, now: NOW, days: 7, calendar: UTC });
  assert.equal(closed.reduce((s, d) => s + d.count, 0), 45, 'the week did deliver');
  assert.equal(closed[closed.length - 1].count, 0, 'and today delivered nothing');

  const closedLast24h = lt.closedSince({ tasks, now: NOW });
  assert.equal(closedLast24h, 0);

  const v = lt.verdict({ closedLast24h, queue, queueTouched: true });
  assert.equal(v.state, 'STALLED');
  assert.equal(v.stalled, true);
  assert.notEqual(v.exitCode, 0, 'a stall must not exit 0 — scripts branch on this');
  assert.match(v.why, /52 ticket\(s\) sat open/);
});

// --- the distinction that keeps it honest -----------------------------------

test('nothing closed and nothing to close is IDLE, not a stall — and says why', () => {
  const tasks = [task({ id: 'a', status: 'live', closed: NOW - 5 * DAY })];
  const v = lt.verdict({ closedLast24h: 0, queue: lt.queueShape(tasks), queueTouched: true });
  assert.equal(v.state, 'IDLE');
  assert.equal(v.stalled, false);
  assert.equal(v.exitCode, 0);
  assert.match(v.why, /nothing a loop could close/);
});

test('a queue only waiting on Dane is IDLE, not a stall: no false ALARM while he is away', () => {
  // SP-268, review round 1. Every open ticket in one of Dane's two statuses
  // (or Requested, which only intake reads), nothing closed in 24 hours. No
  // loop can move any of it, so it is not the loops shipping nothing, and an
  // ALARM texted every six hours saying so would be false.
  const tasks = [
    task({ id: 'n1', status: 'needs your input' }),
    task({ id: 'n2', status: 'Needs your input' }),
    task({ id: 'r1', status: 'ready to launch' }),
    task({ id: 'q1', status: 'requested' }),
    task({ id: 'l1', status: 'live', closed: NOW - 5 * DAY }),
  ];
  const queue = lt.queueShape(tasks);
  assert.equal(queue.openWork, 0, 'none of it is work a loop moves');
  assert.equal(queue.waitingOnDane, 3, 'but the waiting is counted');
  assert.equal(queue.requested, 1);
  assert.equal(queue.allOpen, 4);
  const v = lt.verdict({ closedLast24h: 0, queue, queueTouched: true });
  assert.equal(v.state, 'IDLE');
  assert.equal(v.stalled, false);
  assert.equal(v.exitCode, 0);
  assert.match(v.why, /3 waiting on Dane/, 'and said, apart from the loops\' work');

  // One ticket a loop CAN move beside them is a stall again, and says both.
  const stalled = lt.verdict({
    closedLast24h: 0, queue: lt.queueShape([...tasks, task({ id: 'b', status: 'building' })]), queueTouched: true,
  });
  assert.equal(stalled.state, 'STALLED');
  assert.match(stalled.why, /1 ticket\(s\) sat open/);
  assert.match(stalled.why, /3 waiting on Dane/);
});

test('an empty Queued column is NOT an empty queue — work parked in review still counts', () => {
  // The merge side has stopped: nothing to claim, two tickets sitting in
  // review, nothing shipping. Gating the verdict on the Queued column alone
  // would call this healthy, which is the whole failure mode.
  const tasks = [
    task({ id: 'r1', status: 'in review' }),
    task({ id: 'r2', status: 'in review' }),
  ];
  const queue = lt.queueShape(tasks);
  assert.equal(queue.queued, 0);
  assert.equal(queue.inFlight, 2);
  const v = lt.verdict({ closedLast24h: 0, queue, queueTouched: true });
  assert.equal(v.state, 'STALLED');
});

test('a ticket closing inside the window is MOVING, whatever the depth', () => {
  const tasks = [
    task({ id: 'a', status: 'live', closed: NOW - 2 * HOUR }),
    ...Array.from({ length: 40 }, (_, i) => task({ id: `q${i}` })),
  ];
  const v = lt.verdict({
    closedLast24h: lt.closedSince({ tasks, now: NOW }), queue: lt.queueShape(tasks),
  });
  assert.equal(v.state, 'MOVING');
  assert.equal(v.exitCode, 0);
});

test('an unreadable queue is UNKNOWN and never healthy', () => {
  const v = lt.verdict({ unreadable: 'ClickUp returned HTTP 429' });
  assert.equal(v.state, 'UNKNOWN');
  assert.equal(v.stalled, false, 'it must not post a stall it cannot substantiate');
  assert.equal(v.exitCode, 2, 'and it must not exit 0 either');
  assert.match(v.why, /429/);
});

test('queueTouched changes where the reader is sent, never whether it is a stall', () => {
  const queue = lt.queueShape([task({ id: 'q' })]);
  const touched = lt.verdict({ closedLast24h: 0, queue, queueTouched: true });
  const dead = lt.verdict({ closedLast24h: 0, queue, queueTouched: false });
  const unsure = lt.verdict({ closedLast24h: 0, queue, queueTouched: null });
  for (const v of [touched, dead, unsure]) assert.equal(v.state, 'STALLED');
  assert.match(touched.why, /does\s+NOT show that a loop pass ran/);
  assert.match(dead.why, /install_loop_runner\.sh --status/, 'no heartbeat script yet: the lane status instead');
  assert.doesNotMatch(dead.why, /npm run heartbeat/, 'never a command the project does not have');
  const withHeartbeat = lt.verdict({ closedLast24h: 0, queue, queueTouched: false, hasHeartbeat: true });
  assert.match(withHeartbeat.why, /npm run heartbeat/, 'named once the project has it');
  assert.match(unsure.why, /could not be determined/);
});

/**
 * FINDING 3 (2026-09-01, task 86bbr2jpq). The signal behind this used to be
 * called `loopsFiring` and the STALLED text said "The loops ARE firing, so the
 * blockage is in the pipeline rather than the schedule." The only evidence is
 * `date_updated`, which ClickUp bumps on ANY edit — a comment, a priority
 * change — so that sentence asserted something the data cannot support, in the
 * direction that costs a reader the most: the loop lanes run inside long-lived
 * agent sessions, so "nobody opened one" is a leading cause of a stall, and
 * that is the case the old wording sent them away from.
 *
 * BREAK TEST, run before this was believed. Putting the old sentence back —
 * `'The loops ARE firing, so the blockage is in the pipeline rather than the
 * schedule.'` — fails this test on both assertions (2 failed of 2 here), and
 * the assertion above it as well. Restoring the honest text returns them.
 */
test('a stall never claims the loops are firing on evidence of a bare edit', () => {
  const queue = lt.queueShape([task({ id: 'q' })]);
  const touched = lt.verdict({ closedLast24h: 0, queue, queueTouched: true });
  assert.doesNotMatch(touched.why, /loops ARE firing/,
    'the timestamp proves an edit happened, never that a loop pass ran');
  assert.match(touched.why, /ANY edit/,
    'and it says what the timestamp actually proves, rather than going silent');
});

/**
 * The other half of finding 3, and the gain that came with it: naming the
 * signal after the evidence made `false` sayable. The old question ("did a
 * loop pass run?") could never be answered no, because a pass that finds the
 * WIP cap full writes nothing. "Was anything in the queue edited?" can.
 *
 * BREAK TEST. Collapsing the caller's `queueTouched` back to
 * `touched ? true : null` fails the second assertion here (1 failed of 2).
 */
test('the caller can say "nothing touched the queue at all", which it never could before', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const code = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'loop_throughput.mjs'), 'utf8');
  assert.doesNotMatch(code, /const loopsFiring/, 'the misleading name is gone from the caller too');
  assert.match(code, /queueTouched = withTimestamps\.length/,
    'and false is reachable: a queue with timestamps and none recent is a real finding');
});

// --- reading the tickets ----------------------------------------------------

test('an open ticket carries no closure date, in either shape ClickUp uses', () => {
  assert.equal(lt.closedAt(task({ closed: null })), null);
  // "0" is the other shape. Parsed as an instant it is 1 Jan 1970, which would
  // fall silently off the far end of every window rather than erroring.
  assert.equal(lt.closedAt({ date_closed: '0' }), null);
  assert.equal(lt.closedAt({}), null);
  assert.equal(lt.closedAt(null), null);
});

test('closures land on the day they happened, and days with none read as 0', () => {
  const tasks = [
    task({ id: 'a', status: 'live', closed: Date.parse('2026-08-29T09:00:00.000Z') }),
    task({ id: 'b', status: 'live', closed: Date.parse('2026-08-29T22:00:00.000Z') }),
    task({ id: 'c', status: 'live', closed: Date.parse('2026-08-31T01:00:00.000Z') }),
    // Older than the window: must not be credited to its edge.
    task({ id: 'd', status: 'live', closed: Date.parse('2026-08-01T01:00:00.000Z') }),
  ];
  const rows = lt.closedPerDay({ tasks, now: NOW, days: 7, calendar: UTC });
  const byDate = Object.fromEntries(rows.map((r) => [r.date, r.count]));
  assert.equal(rows.length, 7);
  assert.equal(byDate['2026-08-29'], 2);
  assert.equal(byDate['2026-08-30'], 0);
  assert.equal(byDate['2026-08-31'], 1);
  assert.equal(rows.reduce((s, r) => s + r.count, 0), 3, 'the August 1st closure is outside the window');
});

test('queueShape counts every status and keeps closed work out of the open count', () => {
  const shape = lt.queueShape([
    task({ id: '1', status: 'queued' }),
    task({ id: '2', status: 'queued' }),
    task({ id: '3', status: 'building' }),
    task({ id: '4', status: 'in review' }),
    task({ id: '5', status: 'needs your input' }),
    task({ id: '6', status: 'live' }),
  ]);
  assert.equal(shape.queued, 2);
  assert.equal(shape.inFlight, 2, 'building and in review: what a machine is moving');
  assert.equal(shape.waitingOnDane, 1, 'needs your input is his, counted apart');
  assert.equal(shape.openWork, 4);
  assert.equal(shape.allOpen, 5);
  assert.equal(shape.closed, 1);
  assert.equal(shape.total, 6);
});

// --- the backlog curve ------------------------------------------------------

test('the backlog curve is reconstructed from creation and closure, not guessed', () => {
  const tasks = [
    // Filed before the window, still open: on every day.
    task({ id: 'old', status: 'queued', created: NOW - 20 * DAY }),
    // Filed on the 29th, closed on the 30th: on the 29th only.
    task({
      id: 'brief', status: 'live',
      created: Date.parse('2026-08-29T08:00:00.000Z'),
      closed: Date.parse('2026-08-30T08:00:00.000Z'),
    }),
    // Filed today: on today only.
    task({ id: 'new', status: 'queued', created: Date.parse('2026-08-31T08:00:00.000Z') }),
  ];
  const curve = lt.depthPerDay({ tasks, now: NOW, days: 4, calendar: UTC });
  const byDate = Object.fromEntries(curve.map((r) => [r.date, r.open]));
  assert.equal(byDate['2026-08-28'], 1);
  assert.equal(byDate['2026-08-29'], 2);
  assert.equal(byDate['2026-08-30'], 1);
  assert.equal(byDate['2026-08-31'], 2);
});

test('a plateau is a run of days at or above today, not a single reading', () => {
  const flat = lt.depthPlateau([
    { date: 'a', open: 3 }, { date: 'b', open: 51 }, { date: 'c', open: 52 }, { date: 'd', open: 51 },
  ]);
  assert.equal(flat.depth, 51);
  assert.equal(flat.days, 3, 'b, c and d are all at or above 51');
  assert.equal(flat.since, 'b');

  const yesterdayWasBetter = lt.depthPlateau([{ date: 'a', open: 1 }, { date: 'b', open: 9 }]);
  assert.equal(yesterdayWasBetter.days, 1);

  assert.deepEqual(lt.depthPlateau([]), { days: 0, since: null, depth: null });
});

// --- the rework bucket ------------------------------------------------------

test('the rework bucket comes from wipCap.classifyPrs, with ages looked up beside it', () => {
  const prs = [
    { number: 449, state: 'OPEN', body: 'https://app.clickup.com/t/aaa', createdAt: '2026-08-25T10:00:00Z' },
    { number: 480, state: 'OPEN', body: 'https://app.clickup.com/t/bbb', createdAt: '2026-08-30T10:00:00Z' },
    // In flight, not rework — its ticket is still being built.
    { number: 481, state: 'OPEN', body: 'https://app.clickup.com/t/ccc', createdAt: '2026-08-30T10:00:00Z' },
  ];
  const { rows, oldest, groups } = lt.reworkPrs({
    prs,
    ticketStatusById: { aaa: 'Queued', bbb: 'Queued', ccc: 'Building' },
    now: NOW,
  });
  assert.deepEqual(groups.queued, [449, 480], 'the bucket is classifyPrs own');
  assert.deepEqual(rows.map((r) => r.number), [449, 480], 'oldest first');
  assert.equal(oldest.number, 449);
  assert.ok(oldest.ageMs > 6 * DAY && oldest.ageMs < 7 * DAY);
});

test('a rework PR whose age cannot be read is still listed, sorted last', () => {
  // Dropping it would shrink the very number this report exists to show.
  const { rows, oldest } = lt.reworkPrs({
    prs: [
      { number: 1, state: 'OPEN', body: 'https://app.clickup.com/t/aaa' },
      { number: 2, state: 'OPEN', body: 'https://app.clickup.com/t/bbb', createdAt: '2026-08-30T10:00:00Z' },
    ],
    ticketStatusById: { aaa: 'Queued', bbb: 'Queued' },
    now: NOW,
  });
  assert.deepEqual(rows.map((r) => r.number), [2, 1]);
  assert.equal(rows[1].ageMs, null);
  assert.equal(oldest.number, 2, 'oldest is the oldest KNOWN age, never the unreadable one');
});

test('a ticket in Rework counts as claimable depth, never as work in flight', () => {
  // Task 86bbr1u9v. `queued` here means "what a build loop can claim", and
  // loop-build claims Rework AND Queued. Counting a send-back as in-flight
  // would make the stall detector report a healthy pipeline while the rework
  // pile rotted — the precise failure the Rework status was created to end.
  const tasks = [
    task({ id: 'r1', status: 'rework' }),
    task({ id: 'r2', status: 'Rework' }),
    task({ id: 'q1', status: 'queued' }),
    task({ id: 'b1', status: 'building' }),
  ];
  const queue = lt.queueShape(tasks);
  assert.equal(queue.queued, 3, 'two rework tickets plus one queued are all claimable');
  assert.equal(queue.inFlight, 1, 'only the one being built is in flight');
  assert.equal(queue.byStatus.rework, 2, 'and the census still names the status');

  // The verdict must follow: three claimable tickets and nothing closing is a
  // stall, not the "nothing to close" all-clear.
  const v = lt.verdict({ closedLast24h: 0, queue, queueTouched: true });
  assert.equal(v.state, 'STALLED');
});

test('the rework bucket reads the real Rework status, not just tickets left in Queued', () => {
  // BREAK TEST: change `[...groups.rework, ...groups.queued]` back to
  // `groups.queued` and this reports an empty bucket on the day the status
  // shipped. Watched fail.
  const prs = [
    { number: 1, state: 'OPEN', body: 'https://app.clickup.com/t/sentback', createdAt: new Date(NOW - 6 * DAY).toISOString() },
    { number: 2, state: 'OPEN', body: 'https://app.clickup.com/t/notmigrated', createdAt: new Date(NOW - 2 * DAY).toISOString() },
    { number: 3, state: 'OPEN', body: 'https://app.clickup.com/t/building', createdAt: new Date(NOW - HOUR).toISOString() },
  ];
  const { rows, oldest } = lt.reworkPrs({
    prs,
    // Both sides of the migration at once: one ticket already moved to Rework,
    // one still sitting in Queued with its PR open. Both are half-built work
    // nothing is finishing, and reading only one of them is a silent zero on
    // one side of the migration or the other.
    ticketStatusById: { sentback: 'Rework', notmigrated: 'Queued', building: 'Building' },
    now: NOW,
  });
  assert.deepEqual(rows.map((r) => r.number), [1, 2], 'the in-flight PR is not rework');
  assert.equal(oldest.number, 1, 'oldest first');
});

test('no rework PRs is an empty bucket, not a crash', () => {
  const r = lt.reworkPrs({ prs: [], ticketStatusById: {}, now: NOW });
  assert.deepEqual(r.rows, []);
  assert.equal(r.oldest, null);
});

// --- the calendar ------------------------------------------------------------

test('a day key and that day end come from the same calendar and cannot disagree', () => {
  // The first draft bucketed closures by calendar day and measured the backlog
  // at "this time of day, N days ago" — a rolling boundary wearing a calendar
  // label. They disagreed by up to a day at every row.
  for (const cal of [lt.UTC_DAYS, lt.LOCAL_DAYS]) {
    const key = cal.key(NOW);
    assert.equal(cal.key(cal.end(key) - 1), key, 'the last instant of a day is still that day');
    assert.notEqual(cal.key(cal.end(key)), key, 'and the first instant of the next one is not');
  }
});

test('the day window is exactly N days, oldest first, ending today', () => {
  const w = lt.dayWindow({ now: NOW, days: 7, calendar: UTC });
  assert.equal(w.length, 7);
  assert.equal(w[6], '2026-08-31');
  assert.equal(w[0], '2026-08-25');
  assert.deepEqual([...w].sort(), w, 'oldest first');
});

// --- what a person and the bus actually read --------------------------------

test('the report names the verdict, the depth and the oldest rework PR', () => {
  const tasks = [task({ id: 'q', status: 'queued' })];
  const queue = lt.queueShape(tasks);
  const closed = lt.closedPerDay({ tasks, now: NOW, days: 7, calendar: UTC });
  const curve = lt.depthPerDay({ tasks, now: NOW, days: 7, calendar: UTC });
  const rework = lt.reworkPrs({
    prs: [{ number: 449, state: 'OPEN', body: 'https://app.clickup.com/t/aaa', createdAt: '2026-08-25T10:00:00Z' }],
    ticketStatusById: { aaa: 'Queued' },
    now: NOW,
  });
  const v = lt.verdict({ closedLast24h: 0, queue, queueTouched: true });
  const out = lt.renderReport({
    verdict: v, closed, curve, plateau: lt.depthPlateau(curve), rework, queue, now: NOW,
  });
  assert.match(out, /STALLED/);
  assert.match(out, /#449/);
  assert.match(out, /1 queued/);
  assert.match(out, /2026-08-31/);
});

test('the bus post explains itself to somebody who was not already suspicious', () => {
  const tasks = [task({ id: 'q', status: 'queued' })];
  const queue = lt.queueShape(tasks);
  const closed = lt.closedPerDay({ tasks, now: NOW, days: 7, calendar: UTC });
  const curve = lt.depthPerDay({ tasks, now: NOW, days: 7, calendar: UTC });
  const text = lt.renderStallPost({
    verdict: lt.verdict({ closedLast24h: 0, queue, queueTouched: true }),
    closed,
    plateau: lt.depthPlateau(curve),
    rework: { rows: [], oldest: null },
    queue,
    now: NOW,
    node: 'mac-mini',
  });
  assert.match(text, /not getting shorter/);
  assert.match(text, /npm run throughput/, 'it names the command that says more');
  assert.doesNotMatch(text, /CC-starcaster/, 'no StarCaster sign-off: bus-post heads every post with the machine it came from');
  assert.match(text, /shipped nothing/, 'and says what makes this different from a failure alarm');
});

// --- suppression -------------------------------------------------------------

test('suppression allows the first post and blocks a second inside the window', () => {
  const everyMs = 6 * HOUR;
  assert.equal(lt.dueAgain({ lastAt: '', now: NOW, everyMs }), true, 'never posted');
  assert.equal(lt.dueAgain({ lastAt: new Date(NOW - HOUR).toISOString(), now: NOW, everyMs }), false);
  assert.equal(lt.dueAgain({ lastAt: new Date(NOW - 7 * HOUR).toISOString(), now: NOW, everyMs }), true);
  // An unreadable stamp posts rather than staying silent: a corrupt file must
  // not be able to switch the alarm off.
  assert.equal(lt.dueAgain({ lastAt: 'not a date', now: NOW, everyMs }), true);
});

// --- the two numbers that must agree ----------------------------------------

/**
 * MEASURED ON LIVE DATA, 2026-08-31. The first real run printed "57 open" as
 * the last point of the backlog curve directly above "56 open in total" — two
 * readings of the same question, in one report, disagreeing by one. The cause
 * was ticket 86bb4uyvp, sitting in `live` with `date_closed` empty.
 *
 * BREAK TEST. Delete the `if (undatedClosure(t)) continue;` line from
 * depthPerDay and this test fails alone (the curve's last day reads 2, not 1).
 */
test("a finished ticket with no closure date does not haunt the curve forever", () => {
  const tasks = [
    task({ id: 'q', status: 'queued', created: NOW - 10 * DAY }),
    // Terminal status, no timestamp — exactly 86bb4uyvp's shape.
    task({ id: 'ghost', status: 'live', created: NOW - 10 * DAY, closed: null }),
  ];
  const queue = lt.queueShape(tasks);
  const curve = lt.depthPerDay({ tasks, now: NOW, days: 3, calendar: UTC });

  assert.equal(queue.openWork, 1, 'the status is the authoritative fact about now');
  assert.equal(curve[curve.length - 1].open, queue.allOpen,
    "the curve's last point IS today's depth — they must never disagree");
  assert.equal(lt.undatedClosures(tasks), 1, 'and the guess is counted, not hidden');
});

test('the report says out loud that the curve had to guess', () => {
  const tasks = [task({ id: 'ghost', status: 'live', created: NOW - 10 * DAY, closed: null })];
  const curve = lt.depthPerDay({ tasks, now: NOW, days: 7, calendar: UTC });
  const out = lt.renderReport({
    verdict: lt.verdict({ closedLast24h: 0, queue: lt.queueShape(tasks) }),
    closed: lt.closedPerDay({ tasks, now: NOW, days: 7, calendar: UTC }),
    curve,
    plateau: lt.depthPlateau(curve),
    rework: { rows: [], oldest: null },
    queue: lt.queueShape(tasks),
    now: NOW,
    undated: lt.undatedClosures(tasks),
  });
  assert.match(out, /no closure date/);
});

test('an age reads as an age, not as "open ... ago"', () => {
  // ageText already ends in "ago"; the first draft rendered "open 8d 0h ago".
  const rework = lt.reworkPrs({
    prs: [{ number: 419, state: 'OPEN', body: 'https://app.clickup.com/t/aaa', createdAt: '2026-08-23T12:00:00Z' }],
    ticketStatusById: { aaa: 'Queued' },
    now: NOW,
  });
  const queue = lt.queueShape([task({ id: 'q' })]);
  const curve = lt.depthPerDay({ tasks: [task({ id: 'q' })], now: NOW, days: 7, calendar: UTC });
  const out = lt.renderReport({
    verdict: lt.verdict({ closedLast24h: 1, queue }),
    closed: lt.closedPerDay({ tasks: [], now: NOW, days: 7, calendar: UTC }),
    curve, plateau: lt.depthPlateau(curve), rework, queue, now: NOW,
  });
  assert.match(out, /opened 8d 0h ago/);
  assert.doesNotMatch(out, /open 8d 0h ago/);
});

// ---------------------------------------------------------------------------
// The 24-hour blind spot, and why it is NOT closed with a recency alarm
// (2026-09-02, task 86bbtmbwe).
//
// The premise held: `verdict` returns MOVING on `closedLast24h > 0`, so a
// stall shorter than the window is invisible. The proposed fix — call it a
// stall when nothing has closed for N hours — did not survive measurement.
// 189 closures over the fortnight to 2026-09-02 gave a p90 gap of 3.4h and a
// p95 of 10.2h, and the overnight gap this ticket was opened about was 7.2h:
// shorter than eleven other gaps in the same fortnight. A threshold low enough
// to catch it fires on most nights.
// ---------------------------------------------------------------------------

test('MOVING answers the question the tool actually asks', () => {
  // "35 tickets reached Live" is true and is not an answer to "is the queue
  // getting shorter?". On 2026-09-02 it read as an all-clear while open work
  // had gone 40 -> 56 in a week.
  const v = lt.verdict({
    closedLast24h: 33,
    queue: { openWork: 56, queued: 52, inFlight: 4 },
    trend: { first: 40, last: 56, delta: 16, days: 7 },
  });
  assert.strictEqual(v.state, 'MOVING', 'a growing backlog is not a fault — the verdict does not change');
  assert.match(v.why, /33 ticket\(s\) reached Live/);
  assert.match(v.why, /40 → 56 over 7 days \(up 16\)/);
});

test('MOVING says so when the backlog fell, too', () => {
  const v = lt.verdict({
    closedLast24h: 12, queue: { openWork: 20, queued: 18, inFlight: 2 },
    trend: { first: 34, last: 20, delta: -14, days: 7 },
  });
  assert.match(v.why, /34 → 20 over 7 days \(down 14\)/);
});

test('a long quiet spell is MENTIONED and never becomes a verdict', () => {
  // The night of 2026-09-01, replayed: 35 closed in the window, last one 7.2
  // hours ago, 48 queued. A recency alarm would call this STALLED. It must not
  // — by the measured distribution that night was around the 93rd percentile
  // and unremarkable.
  const v = lt.verdict({
    closedLast24h: 35,
    queue: { openWork: 55, queued: 48, inFlight: 7 },
    lastClose: { at: 0, ms: 7.2 * HOUR },
    trend: { first: 40, last: 55, delta: 15, days: 7 },
  });
  assert.strictEqual(v.state, 'MOVING', 'a 7.2h gap is an ordinary night here, not a stall');
  assert.strictEqual(v.exitCode, 0, 'and it must not post to the bus');
  assert.match(v.why, /Nothing has closed for 7\.2 hours/, 'but the reader is told');
});

test('a short quiet spell is not worth mentioning', () => {
  const v = lt.verdict({
    closedLast24h: 5, queue: { openWork: 10, queued: 8, inFlight: 2 },
    lastClose: { at: 0, ms: 20 * 60 * 1000 },
  });
  assert.ok(!/Nothing has closed/.test(v.why),
    'three quarters of real gaps are under an hour; saying so every run is noise');
});

test('the 24h window is still what decides MOVING — the blind spot is documented, not papered over', () => {
  // Deliberate. Nothing here turns a quiet spell into a stall, and a future
  // reader who wants to must read the measurement first.
  const v = lt.verdict({
    closedLast24h: 1,
    queue: { openWork: 55, queued: 48, inFlight: 7 },
    lastClose: { at: 0, ms: 23 * HOUR },
  });
  assert.strictEqual(v.state, 'MOVING');
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'loopThroughput.js'), 'utf8');
  assert.match(src, /p90\s+3\.38h/, 'the measured distribution is recorded next to the decision');
  assert.match(src, /would have fired on roughly eleven of the last fourteen nights/,
    'and the reason a recency threshold was rejected');
});

test('"nothing has ever closed" is not "closed a very long time ago"', () => {
  const NOW = Date.parse('2026-09-02T15:00:00.000Z');
  assert.strictEqual(lt.sinceLastClose({ tasks: [], now: NOW }), null);
  assert.strictEqual(lt.sinceLastClose({ tasks: [{ id: 'a' }], now: NOW }), null);
  const r = lt.sinceLastClose({ tasks: [
    { id: 'a', date_closed: String(NOW - 3 * HOUR) },
    { id: 'b', date_closed: String(NOW - 1 * HOUR) },
    { id: 'c', date_closed: '' },
  ], now: NOW });
  assert.strictEqual(r.ms, 1 * HOUR, 'the most recent closure wins');
});

test('a closure dated in the future is ignored rather than producing a negative age', () => {
  const NOW = Date.parse('2026-09-02T15:00:00.000Z');
  const r = lt.sinceLastClose({ tasks: [
    { id: 'a', date_closed: String(NOW + DAY) },
    { id: 'b', date_closed: String(NOW - 2 * HOUR) },
  ], now: NOW });
  assert.strictEqual(r.ms, 2 * HOUR);
});

test('the trend cannot go quiet on a rising backlog, which is what plateau does', () => {
  // The bug that prompted it: depthPlateau anchors on TODAY, so 55 -> 55 -> 56
  // reports a run of one day and the caller prints nothing — silence on the
  // worse of the two cases.
  const rising = [{ date: 'd1', open: 55 }, { date: 'd2', open: 55 }, { date: 'd3', open: 56 }];
  assert.strictEqual(lt.depthPlateau(rising).days, 1, 'plateau still says almost nothing here');
  const t = lt.depthTrend(rising);
  assert.deepStrictEqual([t.first, t.last, t.delta, t.days], [55, 56, 1, 3]);
});

test('the trend needs two points to mean anything', () => {
  assert.strictEqual(lt.depthTrend([]), null);
  assert.strictEqual(lt.depthTrend([{ date: 'd1', open: 5 }]), null);
  assert.strictEqual(lt.depthTrend(null), null);
});

test('a duration is said in the unit the reader thinks in', () => {
  assert.strictEqual(lt.hoursText(7.2 * HOUR), '7.2 hours');
  assert.strictEqual(lt.hoursText(20 * 60 * 1000), '20 minutes');
  assert.strictEqual(lt.hoursText(-1), 'an unknown time');
  assert.strictEqual(lt.hoursText('x'), 'an unknown time');
});

test('IDLE and STALLED are untouched by any of this', () => {
  const idle = lt.verdict({ closedLast24h: 0, queue: { openWork: 0, queued: 0, inFlight: 0 }, lastClose: { at: 0, ms: 40 * HOUR } });
  assert.strictEqual(idle.state, 'IDLE');
  assert.strictEqual(idle.exitCode, 0);
  const stalled = lt.verdict({ closedLast24h: 0, queue: { openWork: 12, queued: 10, inFlight: 2 }, queueTouched: true });
  assert.strictEqual(stalled.state, 'STALLED');
  assert.strictEqual(stalled.exitCode, 1);
  const unknown = lt.verdict({ unreadable: 'ClickUp said 429' });
  assert.strictEqual(unknown.state, 'UNKNOWN');
  assert.strictEqual(unknown.exitCode, 2);
});

test('the caller reports the last closure and the trend, or none of this is visible', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const code = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'loop_throughput.mjs'), 'utf8');
  assert.match(code, /throughput\.sinceLastClose\(\{ tasks, now: NOW \}\)/);
  assert.match(code, /throughput\.depthTrend\(curve\)/);
  assert.match(code, /closedLast24h, queue, queueTouched, trend, lastClose, undatedRecent,/,
    'both must reach the verdict, or the fix is inert in the thing that runs');
});

// --- the six quiet failures of 2026-09-01 (task 86bbr2jpq) -------------------

/**
 * FINDING 1: an UNKNOWN verdict reached nobody.
 *
 * `verdict` has always had four states and the caller has always exited 2 on
 * UNKNOWN — but `run_bus_relay.sh` discards that exit code with `|| true`, so
 * the one state whose entire purpose is "a monitor must not fail quietly" was
 * the state that failed quietly. A rotated ClickUp token left the stall
 * detector permanently dead while every other job on the board looked fine.
 *
 * BREAK TEST. Making `renderUnknownPost` return `v.why` alone fails the second
 * and third assertions here (1 failed of 22 in the file); deleting the
 * `announceUnknown(v)` call from either exit path in loop_throughput.mjs fails
 * the caller test below it.
 */
test('an unknown reading is a bus message, with the reason in it', () => {
  const v = lt.verdict({ unreadable: 'ClickUp returned HTTP 429' });
  const text = lt.renderUnknownPost({ verdict: v, now: NOW, node: 'mac-mini' });
  assert.match(text, /429/, 'the reason is the whole point — a bare "unknown" is not actionable');
  assert.match(text, /NOT a stall and NOT an all-clear/,
    'it must not be mistakable for either of the two states it sits between');
  assert.match(text, /npm run throughput/, 'it names the command that says more');
  assert.doesNotMatch(text, /CC-starcaster/, 'no StarCaster sign-off: bus-post heads every post with the machine it came from');
});

test('the caller actually posts the unknown, on BOTH paths that can produce one', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const code = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'loop_throughput.mjs'), 'utf8');
  assert.match(code, /function announceUnknown\(v, evidence = null\)/);
  // Once for the unreadable queue, once for the undated-closure verdict. The
  // second one now carries the stall evidence with it, so this matches the
  // call rather than the exact argument list.
  const calls = code.match(/^\s*announceUnknown\(v[,)]/gm) || [];
  assert.equal(calls.length, 2,
    'an unreadable queue AND an untrustworthy zero both have to reach the bus');
  assert.match(code, /unknownStampFile/, 'and it is suppressed on the same 6h discipline');
});

/**
 * FINDING 2: the read throttle made a rate limit self-reinforcing.
 *
 * The hourly read stamp was written only AFTER a successful read, so a ClickUp
 * 429 skipped it — and the relay wakes every ten minutes, so the check went
 * back six times an hour instead of once, hammering the very limit that broke
 * it and keeping itself broken. #1 and #2 together are one silent failure.
 *
 * BREAK TEST. Moving the `if (CHECK) writeStamp(readStampFile, ...)` line back
 * below the `if (!queueRead.tasks)` early exit fails this test (1 failed).
 */
test('the hourly read clock restarts on the ATTEMPT, not on a success', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const code = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'loop_throughput.mjs'), 'utf8');
  const stampAt = code.indexOf('if (CHECK) writeStamp(readStampFile');
  const readAt = code.indexOf('const queueRead = await readQueue();');
  const bailAt = code.indexOf('if (!queueRead.tasks) {');
  assert.ok(stampAt > 0 && readAt > 0 && bailAt > 0, 'all three lines still exist');
  assert.ok(stampAt < readAt,
    'the stamp is taken before the read, so a failed read costs the same hour a good one does');
  assert.ok(stampAt < bailAt, 'and the unreadable-queue exit cannot skip past it');
});

/**
 * FINDING 5: the bus post dropped the oldest-rework number without saying so.
 *
 * When `gh` cannot be read, the rework bucket is empty — and an omitted bullet
 * reads as "there are no rework PRs", which is the opposite of what is known.
 * It is the alert's most actionable line: the one that names a branch somebody
 * could go and finish. The terminal report already handled this correctly;
 * only the post did not (docs/DOCTRINE.md 3.11).
 *
 * BREAK TEST. Deleting the `if (reworkUnreadable)` branch from
 * `renderStallPost` fails the first two assertions here (1 failed).
 */
test('a stall post says out loud when the rework bucket could not be read', () => {
  const tasks = [task({ id: 'q', status: 'queued' })];
  const queue = lt.queueShape(tasks);
  const closed = lt.closedPerDay({ tasks, now: NOW, days: 7, calendar: UTC });
  const curve = lt.depthPerDay({ tasks, now: NOW, days: 7, calendar: UTC });
  const common = {
    verdict: lt.verdict({ closedLast24h: 0, queue, queueTouched: true }),
    closed, plateau: lt.depthPlateau(curve), queue, now: NOW, node: 'mac-mini',
  };

  const blind = lt.renderStallPost({
    ...common,
    rework: { rows: [], oldest: null },
    reworkUnreadable: 'the `gh` command is not installed on this machine',
  });
  assert.match(blind, /could NOT be read/, 'the missing number must say it is missing');
  assert.match(blind, /gh` command is not installed/, 'and name why, so it can be fixed');
  assert.doesNotMatch(blind, /was opened/, 'and it must not invent an age it does not have');

  // The readable case is untouched: no caveat, and the number is still there.
  const seeing = lt.renderStallPost({
    ...common,
    rework: { rows: [{ number: 449, ageMs: 3 * DAY }], oldest: { number: 449, ageMs: 3 * DAY } },
  });
  assert.match(seeing, /#449/);
  assert.doesNotMatch(seeing, /could NOT be read/);
});

/**
 * FINDING 4: an undated closure could cause a FALSE stall.
 *
 * `closedSince` counts `date_closed` and nothing else, so a ticket that ships
 * without one is invisible to the stall test — and a day on which everything
 * shipped that way reports STALLED with total confidence. 86bb4uyvp is a real
 * one, documented in lib/loopThroughput.js itself.
 *
 * THE NARROWING IS THE DESIGN, and the second test below is the one that
 * matters more. "Any undated closure means we cannot tell" would have switched
 * the stall alarm off forever, because that ticket sits in `live` with no
 * closure date and is never going to grow one. That trades a rare false alarm
 * for a permanent silent failure — the worse of the two, by the standard this
 * whole file is written to.
 *
 * BREAK TEST. Deleting the `if (Number(undatedRecent) > 0)` block from
 * `verdict` fails the first test (1 failed); widening
 * `recentUndatedClosures` to ignore `date_updated` fails the second (1 failed).
 */
test('an undated closure inside the window cannot by itself produce a STALLED verdict', () => {
  const tasks = [
    task({ id: 'q', status: 'queued', created: NOW - 5 * DAY, updated: NOW - 2 * HOUR }),
    // Shipped today, and ClickUp recorded no closure date for it.
    task({ id: 'shipped', status: 'live', created: NOW - 5 * DAY, closed: null, updated: NOW - HOUR }),
  ];
  const queue = lt.queueShape(tasks);
  const closedLast24h = lt.closedSince({ tasks, now: NOW });
  assert.equal(closedLast24h, 0, 'the undated closure is genuinely invisible to the count');

  const v = lt.verdict({
    closedLast24h, queue, queueTouched: true,
    undatedRecent: lt.recentUndatedClosures({ tasks, now: NOW }),
  });
  assert.equal(v.state, 'UNKNOWN', 'a zero it cannot stand behind is not a stall');
  assert.equal(v.stalled, false, 'and it must not post a stall it cannot substantiate');
  assert.equal(v.exitCode, 2, 'nor exit 0 — this is not health either');
  assert.match(v.why, /no closure date/, 'and it names the cause, so it can be fixed by hand');
});

test('an OLD undated closure does not switch the alarm off — 86bb4uyvp is permanent', () => {
  const tasks = [
    task({ id: 'q', status: 'queued', created: NOW - 9 * DAY, updated: NOW - 2 * HOUR }),
    // The real one: in `live`, no closure date, and last edited a fortnight ago.
    task({ id: '86bb4uyvp', status: 'live', created: NOW - 30 * DAY, closed: null, updated: NOW - 14 * DAY }),
  ];
  assert.equal(lt.undatedClosures(tasks), 1, 'it is still counted and still printed');
  assert.equal(lt.recentUndatedClosures({ tasks, now: NOW }), 0,
    'but it certainly did not close in the last 24h, so it cannot excuse a zero');

  const v = lt.verdict({
    closedLast24h: 0, queue: lt.queueShape(tasks), queueTouched: true,
    undatedRecent: lt.recentUndatedClosures({ tasks, now: NOW }),
  });
  assert.equal(v.state, 'STALLED', 'the stall detector still detects stalls');
});

test('a ticket with no readable date_updated is counted, because nothing rules it out', () => {
  const tasks = [{ id: 'x', status: { status: 'live' }, date_created: String(NOW - DAY), date_closed: null, date_updated: null }];
  assert.equal(lt.recentUndatedClosures({ tasks, now: NOW }), 1,
    'for a stall detector the safe direction is admitting the doubt');
});

/**
 * FINDING 4, second half: the caveat has to reach the message Dane reads.
 * `renderReport` carried it; `renderStallPost` did not.
 *
 * BREAK TEST. Deleting the `if (Number(undated) > 0)` block from
 * `renderStallPost` fails the first assertion (1 failed).
 */
test('a stall post carries the undated-closure caveat when there is one', () => {
  const tasks = [task({ id: 'q', status: 'queued' })];
  const queue = lt.queueShape(tasks);
  const closed = lt.closedPerDay({ tasks, now: NOW, days: 7, calendar: UTC });
  const curve = lt.depthPerDay({ tasks, now: NOW, days: 7, calendar: UTC });
  const common = {
    verdict: lt.verdict({ closedLast24h: 0, queue, queueTouched: true }),
    closed, plateau: lt.depthPlateau(curve), rework: { rows: [], oldest: null },
    queue, now: NOW, node: 'mac-mini',
  };
  const withCaveat = lt.renderStallPost({ ...common, undated: 2 });
  assert.match(withCaveat, /2 finished ticket\(s\) carry no closure date/);
  assert.match(withCaveat, /reads a little low/, 'and says which way the error points');
  // None to guess about means no caveat: a report that always hedges teaches
  // the reader to skip the hedge.
  assert.doesNotMatch(lt.renderStallPost({ ...common, undated: 0 }), /no closure date/);
});

test('the caller feeds the report and the post everything it just computed', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const code = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'loop_throughput.mjs'), 'utf8');
  assert.match(code, /const undated = throughput\.undatedClosures\(tasks\)/);
  assert.match(code, /const undatedRecent = throughput\.recentUndatedClosures\(\{ tasks, now: NOW \}\)/);
  assert.match(code, /reworkUnreadable: prRead\.why/,
    'the stall post must be told when gh could not be read, or the caveat is inert');
});

// --- review round 1 of 86bbr2jpq (2026-09-02) -------------------------------

/**
 * A LOOP QUEUE FIXTURE WITH ONE UNDATED CLOSURE IN IT — the state that produces
 * the second UNKNOWN. `closedSince` sees zero, and the ticket that shipped is
 * invisible to it because ClickUp recorded no closure date.
 */
function undatedScene() {
  const tasks = [
    task({ id: 'q1', status: 'queued', created: NOW - 9 * DAY, updated: NOW - 2 * HOUR }),
    task({ id: 'q2', status: 'queued', created: NOW - 9 * DAY, updated: NOW - 3 * HOUR }),
    task({ id: '86bb4uyvp', status: 'live', created: NOW - 9 * DAY, closed: null, updated: NOW - HOUR }),
  ];
  const queue = lt.queueShape(tasks);
  const curve = lt.depthPerDay({ tasks, now: NOW, days: 7, calendar: UTC });
  return {
    tasks,
    queue,
    closed: lt.closedPerDay({ tasks, now: NOW, days: 7, calendar: UTC }),
    plateau: lt.depthPlateau(curve),
    verdict: lt.verdict({
      closedLast24h: lt.closedSince({ tasks, now: NOW }),
      queue,
      queueTouched: true,
      undatedRecent: lt.recentUndatedClosures({ tasks, now: NOW }),
    }),
  };
}

/**
 * ROUND 1, FINDING 1: one post described one of the two UNKNOWNs.
 *
 * `renderUnknownPost` was shared by both, and its fixed text only fitted the
 * unreadable-queue one. On the undated-closure path the reading had SUCCEEDED
 * — ClickUp answered, every number existed, and the repair was one ticket in
 * `Live` missing a closure date — while the message headlined "could not take
 * a reading", claimed "nothing in the system is watching", and sent the reader
 * off to check whether ClickUp was reachable at all. Only `v.why` was true.
 *
 * BREAK TEST, MEASURED. Deleting the `if (v && v.kind === 'undated-closure')`
 * dispatch from `renderUnknownPost` fails this test and the evidence test
 * below it (2 failed of 53); removing `kind` from the undated return in
 * `verdict` fails the same two, because the dispatch is what reads it.
 */
test('the undated-closure unknown gets its own post, and does not claim the check is blind', () => {
  const scene = undatedScene();
  assert.equal(scene.verdict.kind, 'undated-closure', 'the verdict says which unknown it is');

  const text = lt.renderUnknownPost({
    verdict: scene.verdict, now: NOW, node: 'mac-mini',
    evidence: {
      closed: scene.closed, plateau: scene.plateau, queue: scene.queue,
      rework: { rows: [], oldest: null }, undated: 1, undatedIds: ['86bb4uyvp'],
    },
  });

  assert.doesNotMatch(text, /could not take a reading/i,
    'the reading succeeded on this path — saying otherwise is the defect');
  assert.doesNotMatch(text, /nothing in the system is watching/i,
    'the stall detector is watching perfectly well; one number cannot be trusted');
  assert.doesNotMatch(text, /can ClickUp be read at all/,
    'and the reader must not be sent to diagnose an outage that did not happen');
  assert.match(text, /cannot be read as a zero/, 'it says what is actually wrong');
  assert.match(text, /86bb4uyvp/, 'and names the ticket whose closure date is missing');
  assert.doesNotMatch(text, /CC-starcaster/);
});

test('the unreadable-queue post is untouched by that branch', () => {
  const v = lt.verdict({ unreadable: 'ClickUp returned HTTP 429' });
  assert.equal(v.kind, 'unreadable');
  const text = lt.renderUnknownPost({ verdict: v, now: NOW, node: 'mac-mini' });
  assert.match(text, /could not take a reading/i, 'that wording is correct HERE and stays');
  assert.match(text, /429/);
  assert.doesNotMatch(text, /cannot be read as a zero/);
});

/**
 * ROUND 1, FINDING 2: the actionable numbers disappeared on that path.
 *
 * `verdict` returns UNKNOWN before it can ever reach STALLED, so a GENUINE
 * stall that coincides with one recently-edited undated closure comes out of
 * the unknown branch — and that post carried no queue breakdown, no plateau
 * and no oldest rework PR. The stall is still the likelier reading, so the
 * evidence has to travel with it.
 *
 * BREAK TEST, MEASURED. Emptying the `evidenceBullets` spread in
 * `renderUndatedPost` fails this test (1 failed of 53); dropping the
 * `evidence` object from the `announceUnknown(v, {...})` call in
 * loop_throughput.mjs fails the caller test below it (1 failed of 53).
 */
test('the undated-closure post carries the stall evidence anyway', () => {
  const scene = undatedScene();
  const text = lt.renderUnknownPost({
    verdict: scene.verdict, now: NOW, node: 'mac-mini',
    evidence: {
      closed: scene.closed, plateau: scene.plateau, queue: scene.queue,
      rework: { rows: [{ number: 449, ageMs: 3 * DAY }], oldest: { number: 449, ageMs: 3 * DAY } },
      undated: 1, undatedIds: ['86bb4uyvp'],
    },
  });
  assert.match(text, /2 queued, 0 in flight/, 'the queue breakdown a stall post would have had');
  assert.match(text, /#449/, 'and the oldest rework PR, which is the most actionable number');
  assert.match(text, /carry no closure date/, 'and the caveat, in the words of THIS verdict');
  assert.match(text, /re-arms the 24h window/,
    'it says out loud that editing that ticket can defer this indefinitely');
});

test('the caller hands the evidence to the undated post', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const code = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'loop_throughput.mjs'), 'utf8');
  assert.match(code, /const undatedRecentIds = throughput/,
    'the ids are read, or the post cannot name the ticket');
  assert.match(
    code,
    /announceUnknown\(v, \{\s*\n\s*closed, plateau, rework, queue, undated,/,
    'and the numbers reach it, or finding 2 is fixed only in the library',
  );
});

/**
 * ROUND 1, FINDING 3: the caveat had a hole of exactly the shape it closed.
 *
 * The bullet said "could NOT be read" only when `gh` itself failed. But
 * `reworkPrs` returns `oldest = rows.find(r => r.ageMs !== null) || null` — so
 * if `gh` reads perfectly and no rework PR's `createdAt` parses, `rows` is
 * non-empty, `oldest` is null, `why` is null, and the bullet vanished with
 * nothing said at all. `reworkPrs` sorts such a PR LAST precisely so it is not
 * dropped; the post was dropping it anyway.
 *
 * BREAK TEST, MEASURED. Deleting the `else if (Array.isArray(rework.rows) &&
 * ...)` branch from `evidenceBullets` fails this test (1 failed of 53).
 */
test('a rework PR with no readable open date is named, not silently dropped', () => {
  const tasks = [task({ id: 'q', status: 'queued' })];
  const queue = lt.queueShape(tasks);
  const closed = lt.closedPerDay({ tasks, now: NOW, days: 7, calendar: UTC });
  const curve = lt.depthPerDay({ tasks, now: NOW, days: 7, calendar: UTC });
  const common = {
    verdict: lt.verdict({ closedLast24h: 0, queue, queueTouched: true }),
    closed, plateau: lt.depthPlateau(curve), queue, now: NOW, node: 'mac-mini',
  };

  // gh read fine — no `why` — but neither PR carries a parseable createdAt.
  const text = lt.renderStallPost({
    ...common,
    rework: { rows: [{ number: 449, ageMs: null }, { number: 452, ageMs: null }], oldest: null },
  });
  assert.match(text, /2 rework PR\(s\) open/, 'the count is known even when the ages are not');
  assert.match(text, /none with a readable open date/, 'and the gap says it is a gap');
  assert.match(text, /#449.*#452|#452.*#449/, 'and names them, so they can be looked at');
  assert.doesNotMatch(text, /was opened/, 'it must not invent an age it does not have');

  // Truly empty is still silent: a report that always hedges teaches the
  // reader to skip the hedge.
  const none = lt.renderStallPost({ ...common, rework: { rows: [], oldest: null } });
  assert.doesNotMatch(none, /rework PR\(s\) open/);
  assert.doesNotMatch(none, /could NOT be read/);
});

/**
 * ROUND 1, FINDING 4: the file the first fix NAMED still described the old
 * behaviour. `run_bus_relay.sh` said "Posts to the bus only on a STALLED
 * verdict ... Silent otherwise" directly above the call that now posts on
 * UNKNOWN too. CLAUDE.md was updated; the comment at the call site was not.
 *
 * BREAK TEST, MEASURED. Putting "only on a STALLED verdict" back into that
 * comment fails this test (1 failed of 53).
 */
test('the relay call site describes what the check now does', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const sh = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'relay_queue_watchdogs.sh'), 'utf8');
  const at = sh.indexOf('scripts/loop_throughput.mjs" --check');
  assert.ok(at > 0, 'the call is still there');
  const preamble = sh.slice(Math.max(0, at - 900), at);
  assert.match(preamble, /UNKNOWN/,
    'the comment above the call has to mention the other state it posts on');
  assert.doesNotMatch(preamble, /only on a STALLED verdict/,
    'and must not still say it posts only on a stall');
});

/**
 * ROUND 2, FINDING 1: the two UNKNOWNs shared one suppression stamp, so either
 * one could silence the other for six hours.
 *
 * There was a single `unknown-loop-queue.stamp` and `announceUnknown` checked
 * it before EITHER message. So: the ClickUp token rotates at 9am, "the stall
 * detector could not take a reading" posts and stamps; the token is fixed by
 * 10am, an undated closure turns up, and that second message is swallowed.
 * Worse in reverse — 86bb4uyvp is a real ticket that will never grow a closure
 * date, so the undated post is the one likely to fire first, and it could then
 * suppress "nothing is watching whether the queue is getting shorter", which
 * is the most serious sentence in the file.
 *
 * It is the same argument the code already makes twelve lines above for
 * keeping the stall stamp separate from the unknown stamp — two findings with
 * two different repairs must not share one window. "ClickUp is unreachable"
 * and "one ticket needs a date filled in" are two different repairs.
 *
 * BREAK TEST, MEASURED. Reverting `unknownStampFileFor(kind)` to a single
 * constant path fails this test (1 failed of 56); dropping either kind from
 * `UNKNOWN_KINDS` fails it too (1 failed of 56).
 */
// The name used to say "a good READING clears both", which is the same
// overclaim round 3 sent this ticket back for: a reading clears the
// `unreadable` window on its own, but only a reading that is also complete and
// not stalled clears the other. Which happens WHERE is behaviour, and is
// covered by loopThroughputUnknownStamps.test.js, not from the source here.
test('each kind of unknown has its own 6h window, and a clean pass clears every kind', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const code = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'loop_throughput.mjs'), 'utf8');

  assert.match(code, /unknown-\$\{kind\}-loop-queue\.stamp/,
    'the stamp path varies by kind, or one unknown can swallow the other');
  assert.match(code, /unknownStampFileFor\(v\.kind/,
    'and the post consults the stamp for the kind it is actually announcing');

  // Both kinds `verdict` can return have to be in the list that gets cleared,
  // or a stale stamp outlives the condition that wrote it.
  const kinds = code.match(/const UNKNOWN_KINDS = \[([^\]]*)\]/);
  assert.ok(kinds, 'the kinds are enumerated in one place');
  for (const kind of ['unreadable', 'undated-closure']) {
    assert.match(kinds[1], new RegExp(`'${kind}'`),
      `${kind} is a kind verdict() returns, so it needs its own window`);
  }
  assert.match(code, /for \(const kind of UNKNOWN_KINDS\) clearUnknownStamp\(kind\)/,
    'and a readable, non-unknown pass clears every kind — it is evidence against all of them');
  assert.match(code, /function clearUnknownStamp\(kind\)[\s\S]{0,160}rmSync\(unknownStampFileFor\(kind\)/,
    'and clearing a kind actually removes that kind\'s stamp file');

  // The kinds asserted above are the ones the library actually produces.
  assert.strictEqual(lt.verdict({ unreadable: 'ClickUp said 429' }).kind, 'unreadable');
  assert.strictEqual(undatedScene().verdict.kind, 'undated-closure');
});

/**
 * ROUND 2, FINDING 2: the UNKNOWN path treated "cannot tell" as a recovery.
 *
 * The undated-closure branch called `clearStamp()` — wiping the STALL
 * suppression — before exiting. The unreadable-queue branch never did, because
 * it exits earlier. So one verdict state meant two different things about the
 * stall alarm depending on which cause produced it.
 *
 * Clearing is the wrong half to agree on: a real stall posts and stamps, an
 * edit to an undated `Live` ticket flips the next pass to UNKNOWN and wipes
 * the stamp, that ticket is then dated or moved, the verdict returns to
 * STALLED, and the identical alert posts again inside its own six-hour window.
 * Only a reading that is BOTH complete and not stalled is evidence a stall
 * ended. No alarm is lost either way — the stamp expires on its own.
 *
 * BREAK TEST, MEASURED. Putting `clearStamp();` back at the top of the
 * `if (v.state === 'UNKNOWN')` branch fails this test (1 failed of 56).
 */
test('an unknown reading is not treated as a stall recovery, on either path', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const code = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'loop_throughput.mjs'), 'utf8');

  // Prose mentions these names; only real calls count.
  const executable = code.split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  const branchAt = executable.indexOf("if (v.state === 'UNKNOWN') {");
  const clearsUnknownAt = executable.indexOf('clearUnknownStamps();');
  assert.ok(branchAt > 0 && clearsUnknownAt > branchAt, 'both landmarks still exist, in order');

  const unknownBranch = executable.slice(branchAt, clearsUnknownAt);
  assert.doesNotMatch(unknownBranch, /(^|[^a-zA-Z])clearStamp\(\)/,
    'a verdict of "could not tell" must not clear the stall suppression — that is not a recovery');

  // And the recovery that IS one still clears it, or a stall can only ever be
  // announced once per process lifetime.
  const recovery = executable.slice(executable.indexOf('if (!v.stalled) {'));
  assert.match(recovery, /clearStamp\(\)/,
    'a complete, not-stalled reading is the real recovery and still clears the stamp');
});

/**
 * ROUND 2, FINDING 3: round 1's finding 4 again, one file over.
 *
 * `run_bus_relay.sh`'s comment got a test after round 1. CLAUDE.md's command
 * block did not, and it still read "post to the bus if it has STALLED" — while
 * the prose ten lines below it and the script's own usage header both said
 * STALLED or UNKNOWN. The repo's main instruction file contradicted the script
 * it documents, in the one line somebody skimming for the command reads.
 *
 * BREAK TEST, MEASURED. Putting "post to the bus if it has STALLED" back into
 * that block fails this test (1 failed of 56).
 */
// In Spirality the command block lives in docs/WATCHDOGS.md, not CLAUDE.md.
test('the WATCHDOGS.md command block describes what the check now does', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const md = fs.readFileSync(path.join(__dirname, '..', 'docs', 'WATCHDOGS.md'), 'utf8');
  const line = md.split('\n').find((l) => l.startsWith('npm run throughput -- --check '));
  assert.ok(line, 'the cheat-sheet line is still there');
  assert.match(line, /UNKNOWN/,
    'the line somebody skims for the command has to name both states it posts on');
  assert.doesNotMatch(line, /if it has STALLED/,
    'and must not still say it posts only on a stall');
});

// --- Mountain time (SP-268, review round 1) ---------------------------------

test('days are Mountain calendar days by default: an evening close lands on its own evening', () => {
  // 2026-11-14 at 6 pm MST is 01:00 UTC on the 15th. A UTC day would put it
  // on tomorrow's row; Dane's day is the 14th.
  const evening = Date.parse('2026-11-15T01:00:00Z');
  assert.equal(lt.MOUNTAIN_DAYS.key(evening), '2026-11-14');
  assert.equal(lt.UTC_DAYS.key(evening), '2026-11-15', 'the UTC calendar would split it off');
  // The day ends at Mountain midnight: 07:00 UTC in winter, 06:00 in summer.
  assert.equal(lt.MOUNTAIN_DAYS.end('2026-11-14'), Date.parse('2026-11-15T07:00:00Z'));
  assert.equal(lt.MOUNTAIN_DAYS.end('2026-07-04'), Date.parse('2026-07-05T06:00:00Z'));
  // Across the autumn clock change (1 November 2026): the 1st is 25 hours long.
  assert.equal(lt.MOUNTAIN_DAYS.end('2026-11-01') - lt.MOUNTAIN_DAYS.end('2026-10-31'), 25 * HOUR);
  const rows = lt.closedPerDay({
    tasks: [task({ id: 'a', status: 'live', closed: evening })], now: evening + HOUR, days: 2,
  });
  assert.deepEqual(rows.map((r) => r.date), ['2026-11-13', '2026-11-14']);
  assert.equal(rows[1].count, 1);
});

test('the report and every bus post give their time in Mountain time, never UTC', () => {
  const now = Date.parse('2026-11-14T18:30:00Z');
  const tasks = [task({ id: 'q', status: 'queued', created: now - 3 * DAY })];
  const queue = lt.queueShape(tasks);
  const closed = lt.closedPerDay({ tasks, now, days: 3 });
  const curve = lt.depthPerDay({ tasks, now, days: 3 });
  const plateau = lt.depthPlateau(curve);
  const rework = { rows: [], oldest: null, groups: null };
  const v = lt.verdict({ closedLast24h: 0, queue, queueTouched: true });
  const texts = [
    lt.renderReport({ verdict: v, closed, curve, plateau, rework, queue, now }),
    lt.renderStallPost({ verdict: v, closed, plateau, rework, queue, now }),
    lt.renderUnknownPost({ verdict: lt.verdict({ unreadable: 'x' }), now }),
    lt.renderUnknownPost({ verdict: { ...v, kind: 'undated-closure' }, now }),
  ];
  for (const t of texts) {
    assert.match(t, /11\/14\/2026, 11:30 AM MT/);
    assert.doesNotMatch(t, /2026-11-14T18:30/);
    assert.doesNotMatch(t, /npm run heartbeat/, 'no heartbeat script in this project yet');
  }
});
