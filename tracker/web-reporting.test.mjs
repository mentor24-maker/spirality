/**
 * Tests for the Reporting page. One file per page (SP-352),
 * so two tickets changing two pages no longer edit one test file; what they
 * share is tracker/webTestKit.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { seedDemo, tickingClock } from './demoData.mjs';
import { reportsOf, REPORT_RANGES, GROWTH_PERIODS, timeSplitOf, isFailureNote, TIME_BUCKETS } from './pageData.mjs';
import loopStatuses from '../lib/loopStatuses.js';
import { prOpenedComment } from '../scripts/lib/loopTrail.mjs';
import { pageScript } from './pageScripts.mjs';
import { WEB, fixture } from './webTestKit.mjs';

// ── Reporting ────────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60_000;

/** A fresh store whose clock the test sets, one project and a loop to move tickets. */
function reportingStore() {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-reports-'));
  const clock = tickingClock();
  const store = openStore(join(dir, 'tracker.db'), { now: clock });
  const loop = store.createActor({ kind: 'machine', name: 'Loop' });
  store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL' });
  store.createProject({ slug: 'beta', name: 'Beta', prefix: 'BE' });
  const now = Date.parse('2026-10-27T15:00:00Z');
  /** File a ticket in `status` `filedDaysAgo` before `now`; each later [days, status] moves it then. */
  const filedAs = (status, project, filedDaysAgo, ...moves) => {
    clock.moveTo(now - filedDaysAgo * DAY);
    const { id } = store.fileTicket({ project, actor: loop.id, name: `filed ${filedDaysAgo} days ago`, status });
    for (const [days, to] of moves) {
      clock.moveTo(now - days * DAY);
      store.changeTicket(id, { actor: loop.id, status: to });
    }
    return id;
  };
  const ticket = (...args) => filedAs('queued', ...args);
  const done = () => { store.close(); rmSync(dir, { recursive: true, force: true }); };
  return { store, loop, ticket, filedAs, now, done, clock };
}

test('Reporting: a task finished 3 days ago counts in all three ranges, 20 days ago in two, 60 days ago only in all time', () => {
  const r = reportingStore();
  try {
    r.ticket('alpha', 70, [3, 'live']);
    r.ticket('alpha', 70, [20, 'live']);
    r.ticket('alpha', 70, [60, 'live']);
    assert.deepEqual(reportsOf(r.store, { now: r.now }).finished, { week: 1, month: 2, all: 3 });
    for (const [days, expected] of [[3, { week: 1, month: 1, all: 1 }], [20, { week: 0, month: 1, all: 1 }], [60, { week: 0, month: 0, all: 1 }]]) {
      const one = reportingStore();
      try {
        one.ticket('alpha', 70, [days, 'live']);
        assert.deepEqual(reportsOf(one.store, { now: one.now }).finished, expected, `${days} days ago`);
      } finally { one.done(); }
    }
  } finally { r.done(); }
});

test('Reporting: a task moved to Live and back out counts nowhere; moved to Live twice, once, at its latest move', () => {
  const r = reportingStore();
  try {
    r.ticket('alpha', 70, [40, 'live'], [35, 'rework']);
    r.ticket('alpha', 70, [40, 'live'], [35, 'rework'], [2, 'live']);
    assert.deepEqual(reportsOf(r.store, { now: r.now }).finished, { week: 1, month: 1, all: 1 });
  } finally { r.done(); }
});

test('Reporting: tasks started are those filed in each range; a task filed already Live counts as finished then', () => {
  const r = reportingStore();
  try {
    r.ticket('alpha', 2);
    r.ticket('alpha', 15);
    r.ticket('beta', 90);
    const born = r.store.fileTicket({ project: 'beta', actor: r.loop.id, name: 'filed already Live', status: 'live' });
    // The clock last stood 90 days back, so that is when it was filed, and finished.
    const back = reportsOf(r.store, { now: Date.parse(born.createdAt) + DAY });
    assert.deepEqual(back.finished, { week: 1, month: 1, all: 1 });
    assert.deepEqual(reportsOf(r.store, { now: r.now }).started, { week: 1, month: 2, all: 4 });
  } finally { r.done(); }
});

test('Reporting: one project or all of them; an unknown project is null; open counts every stage but Live, in STAGE_ORDER, with its colour', () => {
  const r = reportingStore();
  try {
    r.ticket('alpha', 5, [4, 'building']);
    r.ticket('alpha', 5);
    r.ticket('beta', 5);
    r.ticket('beta', 5, [1, 'live']);
    r.store.setStageColours({ Queued: '#2b9cf2' });
    const all = reportsOf(r.store, { now: r.now });
    assert.equal(all.project, null);
    assert.deepEqual(all.ranges, REPORT_RANGES.map(({ key, label }) => ({ key, label })));
    const stages = loopStatuses.STAGE_ORDER.filter((s) => s !== 'Live');
    assert.deepEqual(all.open.map((s) => s.status), stages);
    const count = (rep, s) => rep.open.find((o) => o.status === s).count;
    assert.equal(count(all, 'Queued'), 2);
    assert.equal(count(all, 'Building'), 1);
    assert.equal(all.open.find((o) => o.status === 'Queued').colour, '#2b9cf2');
    assert.equal(all.open.find((o) => o.status === 'Building').colour, null);
    const beta = reportsOf(r.store, { project: 'beta', now: r.now });
    assert.equal(beta.project, 'beta');
    assert.equal(beta.projectName, 'Beta');
    assert.equal(count(beta, 'Queued'), 1);
    assert.equal(count(beta, 'Building'), 0);
    assert.deepEqual(beta.finished, { week: 1, month: 1, all: 1 });
    assert.equal(reportsOf(r.store, { project: 'no-such-thing' }), null);
  } finally { r.done(); }
});

test('Reporting is in the header after Tasks and Topics, served at /reporting, and its figures need a sign-in; the demo holds finished tasks', async () => {
  const html = readFileSync(WEB('index.html'), 'utf8');
  assert.match(html, /<a href="\/tasks" data-nav="tasks">Tasks<\/a>\s*<a href="\/topics" data-nav="topics">Topics<\/a>\s*<a href="\/reporting" data-nav="reporting">Reporting<\/a>/);
  const f = await fixture();
  try {
    const page = await f.call('GET', '/reporting', { token: null });
    assert.equal(page.status, 200);
    assert.equal(page.text, html);
    assert.equal((await f.call('GET', '/reports', { token: null })).status, 401);
    assert.equal((await f.call('GET', '/reports?project=alpha', { token: null })).status, 401);
    const all = await f.call('GET', '/reports');
    assert.equal(all.status, 200);
    // The board's Live column is what "all time" finished counts.
    const live = (slug) => f.store.listTickets(slug, { status: 'live' }).length;
    assert.equal(all.body.finished.all, live('alpha') + live('beta'));
    assert.ok(all.body.finished.all >= 7, 'the demo files finished tasks over the last month');
    const alpha = await f.call('GET', '/reports?project=alpha');
    assert.equal(alpha.body.project, 'alpha');
    assert.equal(alpha.body.finished.all, live('alpha'));
    assert.equal((await f.call('GET', '/reports?project=no-such-thing')).status, 404);
  } finally { await f.cleanup(); }
});

test('Reporting: the first table is Task Productivity, Tasks started above Tasks finished, and its note names Started first (SP-230)', () => {
  const app = pageScript();
  const fn = app.slice(app.indexOf('async function drawReporting('));
  const page = fn.slice(fn.indexOf('<h1>Reporting</h1>'));
  const firstHeading = page.match(/<h2>([^<]*)<\/h2>/);
  assert.equal(firstHeading[1], 'Task Productivity');
  assert.doesNotMatch(app, /Tasks Finished and Started/);
  assert.match(page, /<p class="quiet">Started: filed in that time\. Finished: moved to Live in that time and still Live\.<\/p>/);
  assert.match(page, /<tbody>\$\{line\('Tasks started', r\.started\)\}\$\{line\('Tasks finished', r\.finished\)\}<\/tbody>/);
});

test('Reporting: a custom range counts tasks started and finished on its start and end dates, not the day before or after (SP-240)', () => {
  const r = reportingStore();
  try {
    const at = (iso) => Date.parse(iso);
    const fileAt = (iso, status = 'queued') => {
      r.clock.moveTo(at(iso));
      return r.store.fileTicket({ project: 'alpha', actor: r.loop.id, name: `filed ${iso}`, status }).id;
    };
    const finishAt = (iso) => {
      const id = fileAt('2026-10-01T12:00:00Z');
      r.clock.moveTo(at(iso));
      r.store.changeTicket(id, { actor: r.loop.id, status: 'live' });
    };
    // The range: the whole of Oct 10 to the whole of Oct 15.
    const custom = { from: at('2026-10-10T00:00:00Z'), to: at('2026-10-15T23:59:59.999Z') };
    fileAt('2026-10-10T00:00:00Z');
    fileAt('2026-10-15T23:00:00Z');
    fileAt('2026-10-09T23:00:00Z');
    fileAt('2026-10-16T01:00:00Z');
    finishAt('2026-10-10T01:00:00Z');
    finishAt('2026-10-15T23:00:00Z');
    finishAt('2026-10-09T23:00:00Z');
    finishAt('2026-10-16T01:00:00Z');
    const rep = reportsOf(r.store, { now: r.now, custom });
    assert.deepEqual(rep.custom, { from: '2026-10-10T00:00:00.000Z', to: '2026-10-15T23:59:59.999Z', started: 2, finished: 2 });
    // The fixed ranges are counted as before, and with no range there is no custom figure.
    const plain = reportsOf(r.store, { now: r.now });
    assert.equal('custom' in plain, false);
    assert.deepEqual(rep.started, plain.started);
    assert.deepEqual(rep.finished, plain.finished);
    // One project only: beta has none of them.
    assert.deepEqual(reportsOf(r.store, { project: 'beta', now: r.now, custom }).custom, { ...rep.custom, started: 0, finished: 0 });
  } finally { r.done(); }
});

test('Reporting: Task Productivity has Start Date and End Date pickers after the fixed ranges, 30 days ago to today, redrawn in place (SP-240)', () => {
  const app = pageScript();
  const fn = app.slice(app.indexOf('async function drawReporting('), app.indexOf('function pickerDay('));
  assert.match(fn, /<th class="count custom-range"><label for="report-from">Start Date<\/label><input type="date" id="report-from"/);
  assert.match(fn, /<th class="count custom-range"><label for="report-to">End Date<\/label><input type="date" id="report-to"/);
  assert.ok(fn.indexOf('report-from') < fn.indexOf('report-to'), 'Start Date comes before End Date');
  assert.match(fn, /<span class="quiet">from \$\{escapeHtml\(dayLabel\(fromPicker\.value\)\)\}<\/span>/);
  assert.match(fn, /'The start date is after the end date\.'/);
  // A picker change asks /reports again for the same project and redraws only the custom cells.
  assert.match(fn, /api\('GET', reportsPath\(r\.project \?\? '', picked\)\)/);
  assert.doesNotMatch(fn.slice(fn.indexOf('const repick')), /main\.innerHTML/);
  // The helpers, run here: the default range, and the local-day edges sent to the server.
  const helpers = app.slice(app.indexOf('function pickerDay('), app.indexOf('function reportsPath('));
  const reportsPathFn = app.slice(app.indexOf('function reportsPath('));
  const body = reportsPathFn.slice(0, reportsPathFn.indexOf('\n}\n') + 3);
  const { defaultReportRange, reportsPath } = new Function(`${helpers}\n${body}\nreturn { defaultReportRange, reportsPath };`)();
  assert.deepEqual(defaultReportRange(new Date(2026, 10, 13, 15, 0)), { from: '2026-10-14', to: '2026-11-13' });
  const path = new URL(`http://x${reportsPath('alpha', { from: '2026-10-14', to: '2026-11-13' })}`);
  assert.equal(path.searchParams.get('project'), 'alpha');
  assert.equal(path.searchParams.get('from'), new Date(2026, 9, 14, 0, 0, 0, 0).toISOString());
  assert.equal(path.searchParams.get('to'), new Date(2026, 10, 13, 23, 59, 59, 999).toISOString());
  assert.equal(reportsPath('', { from: '2026-11-14', to: '2026-11-13' }), '/reports', 'a start after the end is never asked for');
  assert.equal(reportsPath('', { from: '', to: '2026-11-13' }), '/reports');
});

test('Reporting growth: 4 started this week against 2 the week before is +100%, 2 against 4 is -50%, none before or too young says so (SP-241)', () => {
  const growthOf = (setup, project = null) => {
    const r = reportingStore();
    try {
      setup(r);
      return reportsOf(r.store, { project, now: r.now }).growth;
    } finally { r.done(); }
  };
  const many = (r, n, daysAgo) => { for (let i = 0; i < n; i += 1) r.ticket('alpha', daysAgo); };
  // An old ticket, so the project has the history to compare a whole week.
  const old = (r) => r.ticket('alpha', 400);
  const up = growthOf((r) => { old(r); many(r, 4, 3); many(r, 2, 10); });
  assert.deepEqual(up.week.started, { current: 4, previous: 2, change: 100, reason: null });
  const down = growthOf((r) => { old(r); many(r, 2, 3); many(r, 4, 10); });
  assert.deepEqual(down.week.started, { current: 2, previous: 4, change: -50, reason: null });
  const flat = growthOf((r) => { old(r); many(r, 3, 3); many(r, 3, 10); });
  assert.equal(flat.week.started.change, 0);
  const noneBefore = growthOf((r) => { old(r); many(r, 3, 3); });
  assert.deepEqual(noneBefore.week.started, { current: 3, previous: 0, change: null, reason: 'none-before' });
  // A project younger than 14 days: not enough history for Weekly, nor Monthly or Annual.
  const young = growthOf((r) => { many(r, 4, 3); many(r, 2, 10); });
  for (const key of ['week', 'month', 'year']) assert.equal(young[key].started.reason, 'too-young', key);
  assert.equal(young.week.started.change, null);
  // Finished: counted by the move to Live, the same as the fixed ranges.
  const done = growthOf((r) => { old(r); r.ticket('alpha', 50, [2, 'live']); r.ticket('alpha', 50, [3, 'live']); r.ticket('alpha', 50, [9, 'live']); });
  assert.deepEqual(done.week.finished, { current: 2, previous: 1, change: 100, reason: null });
  // Monthly and Annual compare 30 and 365 days.
  const longer = growthOf((r) => { r.ticket('alpha', 800); many(r, 1, 20); many(r, 2, 40); many(r, 3, 100); many(r, 1, 500); });
  assert.deepEqual(longer.month.started, { current: 1, previous: 2, change: -50, reason: null });
  assert.deepEqual(longer.year.started, { current: 6, previous: 1, change: 500, reason: null });
  // The answer names the timeframes for the picker, Weekly first.
  const r = reportingStore();
  try {
    assert.deepEqual(reportsOf(r.store, { now: r.now }).growthPeriods, GROWTH_PERIODS.map(({ key, label }) => ({ key, label })));
    assert.deepEqual(GROWTH_PERIODS.map((g) => g.label), ['Weekly', 'Monthly', 'Annual']);
  } finally { r.done(); }
});

test('Reporting: Growth Rate is the last Task Productivity column, a Weekly/Monthly/Annual picker redrawn without asking the server (SP-241)', () => {
  const app = pageScript();
  const fn = app.slice(app.indexOf('async function drawReporting('), app.indexOf('function pickerDay('));
  const head = fn.slice(fn.indexOf('const productivityHead'), fn.indexOf('const line ='));
  assert.match(head, /<label for="report-growth">Growth Rate<\/label><select id="report-growth">\$\{r\.growthPeriods\.map/);
  assert.ok(head.indexOf('report-to') < head.indexOf('report-growth'), 'Growth Rate comes after End Date');
  assert.match(head, /i === 0 \? ' selected' : ''/);
  const row = fn.slice(fn.indexOf('const line ='), fn.indexOf('// A flow row'));
  assert.ok(row.indexOf('data-custom=') < row.indexOf('data-growth='), 'the growth cell is the last in each row');
  // The picker redraws from the answer it already has: no api() call in it.
  const show = fn.slice(fn.indexOf('const showGrowth'), fn.indexOf("growthPicker.addEventListener('change', showGrowth)"));
  assert.match(show, /r\.growth\[growthPicker\.value\]/);
  assert.doesNotMatch(show, /api\(/);
  // The cell itself, run here.
  const src = app.slice(app.indexOf('function growthCell('));
  const growthCell = new Function(`${src.slice(0, src.indexOf('\n}\n') + 3)}\nreturn growthCell;`)();
  assert.equal(growthCell({ change: 100, reason: null }), '+100%');
  assert.equal(growthCell({ change: -50, reason: null }), '-50%');
  assert.equal(growthCell({ change: 0, reason: null }), '0%');
  assert.equal(growthCell({ change: null, reason: 'none-before' }), '<span class="quiet">none in the period before</span>');
  assert.equal(growthCell({ change: null, reason: 'too-young' }), '<span class="quiet">not enough history yet</span>');
  assert.equal(growthCell(undefined), '');
});

/** True when `ms` is within ten minutes of `days` days: the test clock ticks a minute per reading. */
const near = (ms, days) => ms != null && Math.abs(ms - days * DAY) < 10 * 60_000;

test('Reporting flow: time to finish, sent back and waiting, from known status changes; a task sent back twice counts once; one never Queued is left out', () => {
  const r = reportingStore();
  try {
    // Sent back twice; 9 days from Queued to Live; a day in Ready to launch.
    r.ticket('alpha', 10, [9, 'building'], [8, 'in review'], [7, 'rework'], [6, 'building'], [5, 'in review'],
      [4.5, 'rework'], [4, 'building'], [3, 'in review'], [2, 'ready to launch'], [1, 'live']);
    // 3.5 days from Queued to Live; a day in Needs your input, half a day in Ready to launch.
    r.ticket('beta', 5, [4, 'needs your input'], [3, 'building'], [2, 'ready to launch'], [1.5, 'live']);
    // Filed straight into review, never Queued: left out of time to finish; half a day waiting.
    r.filedAs('in review', 'alpha', 3, [2.5, 'ready to launch'], [2, 'live']);
    // Finished 20 days ago, 5 days from Queued; never waited.
    r.ticket('alpha', 25, [21, 'in review'], [20, 'live']);
    // Still open: counts nowhere in flow; the two in the operator's stages are waiting now.
    r.ticket('alpha', 3, [2, 'building']);
    r.ticket('alpha', 3, [1, 'needs your input']);
    r.ticket('beta', 3, [1, 'ready to launch']);
    const { flow, waitingNow } = reportsOf(r.store, { now: r.now });
    assert.equal(waitingNow, 2);

    const week = flow.week;
    assert.equal(week.finished, 3);
    assert.equal(week.timeToFinish.counted, 2);
    assert.equal(week.timeToFinish.leftOut, 1);
    assert.ok(near(week.timeToFinish.median, (9 + 3.5) / 2), String(week.timeToFinish.median / DAY));
    assert.ok(near(week.timeToFinish.longest, 9));
    assert.deepEqual(week.sentBack, { count: 1, share: 1 / 3 });
    assert.ok(near(week.waiting.total, 1 + 1.5 + 0.5), String(week.waiting.total / DAY));
    assert.ok(near(week.waiting.median, 1));

    const month = flow.month;
    assert.equal(month.finished, 4);
    assert.equal(month.timeToFinish.counted, 3);
    assert.ok(near(month.timeToFinish.median, 5));
    assert.ok(near(month.timeToFinish.longest, 9));
    assert.deepEqual(month.sentBack, { count: 1, share: 1 / 4 });
    assert.ok(near(month.waiting.total, 3));
    assert.ok(near(month.waiting.median, (0.5 + 1) / 2));
    assert.deepEqual(flow.all, month);

    const beta = reportsOf(r.store, { project: 'beta', now: r.now });
    assert.equal(beta.flow.all.finished, 1);
    assert.equal(beta.flow.all.sentBack.count, 0);
    assert.equal(beta.waitingNow, 1);
  } finally { r.done(); }
});

test('Reporting flow: a range with no finished tasks has no times and no share, never a zero', () => {
  const r = reportingStore();
  try {
    r.ticket('alpha', 70, [65, 'rework'], [60, 'live']);
    const { flow } = reportsOf(r.store, { now: r.now });
    assert.deepEqual(flow.week, {
      finished: 0,
      timeToFinish: { counted: 0, leftOut: 0, median: null, longest: null },
      sentBack: { count: 0, share: null },
      waiting: { total: null, median: null },
    });
    assert.deepEqual(flow.month, flow.week);
    assert.equal(flow.all.finished, 1);
    assert.deepEqual(flow.all.sentBack, { count: 1, share: 1 });
    assert.ok(near(flow.all.timeToFinish.median, 10));
  } finally { r.done(); }
});

test('Reporting human hours: the estimates of the tasks finished in each range added up, a task with none counted as not estimated, per day to one decimal', () => {
  const r = reportingStore();
  try {
    let pr = 10;
    const estimate = (id, hours) => r.store.postComment({
      ticket: id, author: r.loop.id, body: prOpenedComment(`https://github.com/o/r/pull/${pr++}`, 'Why that estimate: a test.', { humanHours: hours }),
    });
    estimate(r.ticket('alpha', 5, [2, 'live']), 6);
    estimate(r.ticket('alpha', 5, [3, 'live']), 2.5);
    // Finished this week with a pull request but no estimate on it, and one with no pull request at all.
    const bare = r.ticket('beta', 5, [4, 'live']);
    r.store.postComment({ ticket: bare, author: r.loop.id, body: 'PR opened: https://github.com/o/r/pull/3' });
    // Re-recorded on rework: only the newest PR opened line counts.
    const reworked = r.ticket('alpha', 30, [20, 'live']);
    estimate(reworked, 3);
    estimate(reworked, 10);
    estimate(r.ticket('alpha', 70, [60, 'live']), 4);
    // Still open: counts nowhere, estimate or not.
    estimate(r.ticket('alpha', 5, [1, 'building']), 50);

    const { humanHours } = reportsOf(r.store, { now: r.now });
    assert.deepEqual(humanHours.week, { finished: 3, estimated: 2, notEstimated: 1, hours: 8.5, days: 7, perDay: 1.2 });
    assert.deepEqual(humanHours.month, { finished: 4, estimated: 3, notEstimated: 1, hours: 18.5, days: 30, perDay: 0.6 });
    // All time runs from the first ticket filed, 70 days back.
    assert.deepEqual(humanHours.all, { finished: 5, estimated: 4, notEstimated: 1, hours: 22.5, days: 70, perDay: 0.3 });

    const beta = reportsOf(r.store, { project: 'beta', now: r.now }).humanHours;
    assert.deepEqual(beta.week, { finished: 1, estimated: 0, notEstimated: 1, hours: null, days: 7, perDay: null });
  } finally { r.done(); }
});

test('Reporting human hours: a range with no estimates has no total and no per-day figure, never 0 hours', () => {
  const r = reportingStore();
  try {
    r.ticket('alpha', 70, [60, 'live']);
    const { humanHours } = reportsOf(r.store, { now: r.now });
    assert.deepEqual(humanHours.week, { finished: 0, estimated: 0, notEstimated: 0, hours: null, days: 7, perDay: null });
    assert.deepEqual(humanHours.all, { finished: 1, estimated: 0, notEstimated: 1, hours: null, days: 70, perDay: null });
  } finally { r.done(); }
});

test('the demo spreads its finished tasks over the last month, so every range has some', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-demo-reports-'));
  const clock = tickingClock();
  const store = openStore(join(dir, 'tracker.db'), { now: clock });
  try {
    seedDemo(store, { operatorName: 'Dane', clock });
    const { finished, flow, waitingNow } = reportsOf(store, { now: clock.time() });
    assert.ok(finished.week > 0 && finished.month > finished.week && finished.all > finished.month, JSON.stringify(finished));
    // Every flow report shows a figure in every range. All time leaves two out,
    // never Queued: the oldest, filed into review, and one filed already Live.
    for (const key of ['week', 'month', 'all']) {
      const f = flow[key];
      assert.ok(f.timeToFinish.median > 0 && f.timeToFinish.longest >= f.timeToFinish.median, `${key} ${JSON.stringify(f)}`);
      assert.ok(f.sentBack.count > 0, `${key} sent back`);
      assert.ok(f.waiting.total > 0 && f.waiting.median > 0, `${key} waiting`);
    }
    assert.equal(flow.all.timeToFinish.leftOut, 2);
    assert.ok(waitingNow > 0);
    // Human hours show a total in every range, beside a task with none.
    const { humanHours } = reportsOf(store, { now: clock.time() });
    for (const key of ['week', 'month', 'all']) {
      const h = humanHours[key];
      assert.ok(h.hours > 0 && h.perDay > 0 && h.notEstimated > 0, `${key} ${JSON.stringify(h)}`);
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── Where the Time Goes (SP-220) ────────────────────────────────────────────

const HOUR = 60 * 60_000;
/** Each bucket's total ms in some stretches. */
const sumBuckets = (stretches) => Object.fromEntries(TIME_BUCKETS.map((b) => [b, stretches.filter((s) => s.bucket === b).reduce((n, s) => n + s.to - s.from, 0)]));

test('Time split: Queued, 1h Building, 2h In review, 3h Ready to launch, his "merge", 30 minutes, Live', () => {
  const t0 = Date.parse('2026-11-01T15:00:00Z');
  const at = (h) => t0 + h * HOUR;
  const steps = [[at(0), 'queued'], [at(5), 'building'], [at(6), 'in review'], [at(8), 'ready to launch'], [at(11.5), 'live']];
  const comments = [
    { at: at(8), byMachine: true, byOperator: false, failure: false }, // the card
    { at: at(11), byMachine: false, byOperator: true, failure: false }, // "merge"
  ];
  const stretches = timeSplitOf(steps, comments, { now: at(30) });
  assert.deepEqual(sumBuckets(stretches), { working: 1 * HOUR, lane: 5 * HOUR + 2 * HOUR + 0.5 * HOUR, operator: 3 * HOUR, broken: 0 });
  // Every second of its life before Live is in exactly one bucket, end to end.
  for (let i = 1; i < stretches.length; i += 1) assert.equal(stretches[i].from, stretches[i - 1].to);
  assert.equal(stretches[0].from, at(0));
  assert.equal(stretches[stretches.length - 1].to, at(11.5), 'Live time is not counted');
});

test('Time split (SP-285): after his "merge", a relay conflict note does not put the time back on him; a new review round does', () => {
  const t0 = Date.parse('2026-11-13T14:00:00Z');
  const at = (h) => t0 + h * HOUR;
  const pass = (h) => ({ at: at(h), byMachine: true, byOperator: false, failure: false, verdict: 'pass' });
  const note = (h) => ({ at: at(h), byMachine: true, byOperator: false, failure: false });
  const merge = (h) => ({ at: at(h), byMachine: false, byOperator: true, failure: false, mergeWord: true });
  // SP-237's day: PASS and card, 1h for him, "merge", relay note 1h later, 3h of catch-up, Live.
  const a = timeSplitOf([[at(0), 'ready to launch'], [at(5), 'live']], [pass(0), note(0), merge(1), note(2)], { now: at(6) });
  assert.deepEqual(sumBuckets(a), { working: 0, lane: 4 * HOUR, operator: HOUR, broken: 0 });
  // A new PASS after his merge (a rebuilt round) is his again until he answers it.
  const b = timeSplitOf([[at(0), 'ready to launch']], [pass(0), merge(1), note(2), pass(3)], { now: at(4) });
  assert.deepEqual(sumBuckets(b), { working: 0, lane: 2 * HOUR, operator: 2 * HOUR, broken: 0 });
  // A merge said before any PASS does not stand.
  const c = timeSplitOf([[at(0), 'ready to launch']], [merge(0), note(1)], { now: at(2) });
  assert.deepEqual(sumBuckets(c), { working: 0, lane: HOUR, operator: HOUR, broken: 0 });
});

test('Time split: a loop\'s failure note with no move for 4 hours is broken, until the next move or his next comment', () => {
  const t0 = Date.parse('2026-11-01T15:00:00Z');
  const at = (h) => t0 + h * HOUR;
  const failed = (h) => ({ at: at(h), byMachine: true, byOperator: false, failure: true });
  // Building for an hour, then loop-build FAILED: and nothing moves for 4 hours, then back to Queued.
  const a = timeSplitOf([[at(0), 'building'], [at(5), 'queued']], [failed(1)], { now: at(6) });
  assert.deepEqual(sumBuckets(a), { working: HOUR, lane: HOUR, operator: 0, broken: 4 * HOUR });
  // In Ready to launch: a failure note, then his reply 2 hours later ends it; his reply is the newest word, so a lane owes the move.
  const b = timeSplitOf([[at(0), 'ready to launch']], [failed(1), { at: at(3), byMachine: false, byOperator: true }], { now: at(4) });
  assert.deepEqual(sumBuckets(b), { working: 0, lane: HOUR, operator: HOUR, broken: 2 * HOUR });
  // A machine's ordinary note does not end it; an open ticket counts up to now.
  const c = timeSplitOf([[at(0), 'in review']], [failed(0), { at: at(1), byMachine: true, byOperator: false }], { now: at(2) });
  assert.deepEqual(sumBuckets(c), { working: 0, lane: 0, operator: 0, broken: 2 * HOUR });
  // A person who is not the operator saying something does not clear his stage's wait.
  const d = timeSplitOf([[at(0), 'needs your input']], [{ at: at(1), byMachine: false, byOperator: false }], { now: at(2) });
  assert.deepEqual(sumBuckets(d), { working: 0, lane: 0, operator: 2 * HOUR, broken: 0 });
});

test('Time split: what counts as a failure note is a line that starts with one', () => {
  for (const text of ['loop-build FAILED: verify exited 1', 'FAILED: step 3', 'relay GAVE UP: after 3 tries', 'Round 2\n**loop-review FAILED:** gh down']) {
    assert.ok(isFailureNote(text), text);
  }
  for (const text of ['The relay logged FAILED: twice', 'nothing failed', '', null, 'GAVE UP: no lane named']) {
    assert.ok(!isFailureNote(text), String(text));
  }
});

test('Reporting time split: every ticket\'s open time in exactly one bucket, a stretch over the range start cut at it, the most time first', () => {
  const r = reportingStore();
  try {
    const dane = r.store.createActor({ kind: 'human', name: 'Dane' });
    r.store.createProject({ slug: 'gamma', name: 'Gamma', prefix: 'GA', operator: dane.id });
    // Queued 10 days ago, Building from 9 to 1 day ago (crosses the 7-day start), Live 1 day ago.
    const long = r.ticket('gamma', 10, [9, 'building'], [1, 'live']);
    // Filed 2 days ago, Ready to launch since 1 day ago, open now: waiting on him.
    const open = r.ticket('gamma', 2, [1, 'ready to launch']);
    // Filed into review 3 days ago, a loop's failure note on it a minute later, still there: broken since.
    const failing = r.filedAs('in review', 'gamma', 3);
    r.store.postComment({ ticket: failing, author: r.loop.id, body: 'loop-review FAILED: gh could not be reached' });
    const { timeSplit } = reportsOf(r.store, { project: 'gamma', now: r.now });
    const week = timeSplit.week;
    const row = (id) => week.tickets.find((t) => t.id === id);
    assert.ok(near(row(long).working, 6), `working cut at the range start: ${row(long).working / DAY}`);
    assert.ok(near(row(long).lane, 0));
    assert.ok(near(timeSplit.all.tickets.find((t) => t.id === long).working, 8));
    assert.ok(near(timeSplit.all.tickets.find((t) => t.id === long).lane, 1), 'its day in Queued');
    assert.ok(near(row(open).operator, 1) && near(row(open).lane, 1));
    assert.ok(row(failing).broken > 0 && near(row(failing).broken + row(failing).lane, 3));
    for (const key of ['week', 'month', 'all']) {
      const t = timeSplit[key];
      for (const x of t.tickets) assert.equal(TIME_BUCKETS.reduce((n, b) => n + x[b], 0), x.total, `${key} ${x.id} adds up`);
      assert.equal(TIME_BUCKETS.reduce((n, b) => n + t.buckets[b].ms, 0), t.total, key);
      assert.ok(Math.abs(TIME_BUCKETS.reduce((n, b) => n + t.buckets[b].share, 0) - 1) < 1e-9, `${key} shares`);
      assert.deepEqual(t.tickets.map((x) => x.total), t.tickets.map((x) => x.total).sort((a, b) => b - a), 'most time first');
    }
    assert.equal(row(long).name, r.store.getTicket(long).name, 'its exact name');
  } finally { r.done(); }
});

test('Reporting time split: a range with nothing open has a zero total and no shares, and lists no tasks', () => {
  const r = reportingStore();
  try {
    r.ticket('alpha', 70, [65, 'live']);
    const { timeSplit } = reportsOf(r.store, { now: r.now });
    assert.equal(timeSplit.week.total, 0);
    assert.deepEqual(timeSplit.week.tickets, []);
    for (const b of TIME_BUCKETS) assert.deepEqual(timeSplit.week.buckets[b], { ms: 0, share: null });
    assert.ok(near(timeSplit.all.buckets.lane.ms, 5));
  } finally { r.done(); }
});

test('the Reporting page draws Where the Time Goes from the server: four buckets by range, its note, a range picker, task links', () => {
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawReporting'), app.indexOf('/**\n * The Settings page'));
  assert.match(draw, /<h2>Where the Time Goes<\/h2>\s*<p class="quiet">[^<]*Working: in Building\.[^<]*Waiting on You:[^<]*Broken:[^<]*Waiting for a Lane:[^<]*In review[^<]*waiting, not broken\.<\/p>/);
  for (const label of ['Working', 'Waiting for a Lane', 'Waiting on You', 'Broken']) assert.match(draw, new RegExp(`'${label}'\\]`), label);
  assert.match(draw, /r\.timeSplit\[g\.key\]/, 'figures per range, from the server');
  assert.match(draw, /<span class="quiet">none in this range<\/span>/, 'nothing open is said in words, never 0 hours');
  assert.match(draw, /<label for="time-split-range">Tasks with the Most Time In<\/label>/);
  assert.match(draw, /<a href="\/t\/\$\{encodeURIComponent\(x\.id\)\}">/, 'each task id links to its page');
  assert.match(draw, /escapeHtml\(x\.name\)/);
  assert.match(draw, /spanOf\(Number\(ms\)\)/, 'durations in the page\'s own wording');
  for (const heading of ['Task', 'Name', 'Total']) assert.match(draw, new RegExp(`<th(?: class="count")?>${heading}</th>`), heading);
});

test('the Reporting page draws only the server\'s figures: ranges and stages from its answer, colours as properties, the selected project first', () => {
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawReporting'), app.indexOf('/**\n * The Settings page'));
  assert.ok(draw.length > 0);
  assert.match(draw, /api\('GET', reportsPath\(slug, range\)\)/);
  assert.match(draw, /if \(slug\) query\.set\('project', slug\);/);
  assert.match(draw, /r\.ranges\.map/);
  assert.match(draw, /r\.open\.map/);
  assert.match(draw, /savedProject\(\)/, 'it opens on the selected project');
  assert.match(draw, /<option value="">All projects<\/option>/);
  assert.doesNotMatch(draw, /'Queued'|'Requested'|'Building'|'Live'/, 'the stages come from the server, never typed out');
  assert.match(draw, /el\.style\.setProperty\('--stage-border', look\.border\);/);
  assert.match(draw, /escapeHtml\(s\.status\)/);
  for (const title of ['Time to Finish', 'Sent Back', 'Waiting on You']) assert.match(draw, new RegExp(`flow\\('${title}',\\s*'[^']+'`), `${title} has its how-it-is-counted line`);
  assert.match(draw, /r\.flow\[g\.key\]/, 'flow figures per range, from the server');
  assert.match(draw, /<h2>Human Hours of Work Done<\/h2>\s*<p class="quiet">[^<]*estimate, not a measurement/, 'the human-hours report says where its number comes from');
  assert.match(draw, /r\.humanHours\[g\.key\]/, 'human-hours figures per range, from the server');
  assert.match(draw, /h\.estimated \? escapeHtml\(cell\(h\)\) : '<span class="quiet">no estimates yet in this range<\/span>'/, 'no estimates is said in words, never 0 hours');
  assert.match(draw, /of \$\{Number\(h\.finished\)\} estimated/);
  assert.match(draw, /about \$\{Number\(h\.perDay\)\} human hour/);
  assert.match(draw, /f\.finished \? .* : '<span class="quiet">none finished in this range<\/span>'/);
  assert.match(draw, /r\.waitingNow/);
  assert.match(app, /markNav\(reporting \? 'reporting' :/);
  assert.match(app, /if \(reporting\) \{\s*await drawReporting\(\);/);
});
