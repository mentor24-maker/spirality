'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { STATUSES, parseWindow, countStages, failedHistoryLine } = require('./stageCounts.js');

const at = (iso) => String(Date.parse(iso));
const ticket = (id, status, filed) => ({ id, status: { status }, date_created: at(filed) });

test('parseWindow: whole UTC days, --since from midnight to --until at the last millisecond', () => {
  assert.deepEqual(parseWindow('2026-11-03', '2026-11-09'), {
    cutoff: Date.parse('2026-11-03T00:00:00.000Z'),
    ceiling: Date.parse('2026-11-09T23:59:59.999Z'),
  });
  assert.deepEqual(parseWindow('2026-11-03', null), { cutoff: Date.parse('2026-11-03T00:00:00.000Z'), ceiling: Infinity });
  assert.deepEqual(parseWindow(null, null), { cutoff: null, ceiling: Infinity });
});

test('parseWindow: a bad date, a ceiling with no floor, or a backwards window is an error to print', () => {
  assert.match(parseWindow('11/03/2026', null).error, /--since "11\/03\/2026" is not a YYYY-MM-DD date/);
  assert.match(parseWindow('2026-02-30', null).error, /--since "2026-02-30" is not a YYYY-MM-DD date/);
  assert.match(parseWindow('2026-11-03', 'soon').error, /--until "soon" is not a YYYY-MM-DD date/);
  assert.match(parseWindow(null, '2026-11-09').error, /--until needs --since/);
  assert.match(parseWindow('2026-11-09', '2026-11-03').error, /is before --since/);
});

test('countStages without a window: every status now, all eight keys, and closedInWindow null', () => {
  const out = countStages([ticket('SP-1', 'Queued', '2026-11-01'), ticket('SP-2', 'in review', '2026-11-01'), ticket('SP-3', 'live', '2026-11-01')], { list: 'spirality' });
  assert.deepEqual(Object.keys(out), ['list', 'total', 'byStatus', 'since', 'until', 'closedInWindow']);
  assert.deepEqual(Object.keys(out.byStatus), STATUSES);
  assert.equal(out.byStatus.queued, 1);
  assert.equal(out.byStatus['in review'], 1);
  assert.equal(out.byStatus.live, 1);
  assert.equal(out.byStatus.building, 0);
  assert.equal(out.total, 3);
  assert.equal(out.closedInWindow, null);
  assert.equal(out.since, null);
});

test('countStages in a window: shipped counts the LAST move into Live, only when Live now, like the Reporting page', () => {
  const window = parseWindow('2026-11-03', '2026-11-09');
  const tickets = [
    ticket('SP-1', 'live', '2026-10-20'), // shipped inside
    ticket('SP-2', 'live', '2026-10-20'), // shipped before, again inside: counts at its latest
    ticket('SP-3', 'live', '2026-10-20'), // shipped inside, then again after: latest is outside
    ticket('SP-4', 'queued', '2026-11-04'), // went Live inside and came back out: not shipped
    ticket('SP-5', 'live', '2026-11-10'), // filed and shipped after the window
  ];
  const histories = new Map([
    ['SP-1', [{ at: at('2026-10-20T12:00:00Z'), to: 'queued' }, { at: at('2026-11-05T12:00:00Z'), to: 'live' }]],
    ['SP-2', [{ at: at('2026-10-20T12:00:00Z'), to: 'queued' }, { at: at('2026-10-25T12:00:00Z'), to: 'live' }, { at: at('2026-10-26T12:00:00Z'), to: 'rework' }, { at: at('2026-11-09T23:59:59Z'), to: 'live' }]],
    ['SP-3', [{ at: at('2026-10-20T12:00:00Z'), to: 'queued' }, { at: at('2026-11-04T12:00:00Z'), to: 'live' }, { at: at('2026-11-04T13:00:00Z'), to: 'rework' }, { at: at('2026-11-10T00:00:00Z'), to: 'live' }]],
    ['SP-4', [{ at: at('2026-11-04T12:00:00Z'), to: 'requested' }, { at: at('2026-11-05T12:00:00Z'), to: 'live' }, { at: at('2026-11-06T12:00:00Z'), to: 'queued' }]],
    ['SP-5', [{ at: at('2026-11-10T12:00:00Z'), to: 'live' }]],
  ]);
  const out = countStages(tickets, { list: 'spirality', since: '2026-11-03', until: '2026-11-09', window, histories });
  assert.equal(out.closedInWindow, 2, 'SP-1 and SP-2');
  assert.equal(out.startedInWindow, 1, 'SP-4 only');
  assert.equal(out.enteredInWindow.live, 4, 'SP-1, SP-2, SP-3, SP-4 each moved into Live inside');
  assert.equal(out.enteredInWindow.rework, 1, 'SP-3; SP-2 went to Rework before the window');
  assert.equal(out.enteredInWindow.requested, 1, 'SP-4 was filed in Requested inside');
  assert.equal(out.enteredInWindow.queued, 1, 'SP-4 came back to Queued inside');
  assert.equal(out.enteredInWindow.building, 0);
  assert.deepEqual(Object.keys(out.enteredInWindow), STATUSES);
  assert.equal(out.total, 5);
});

test('countStages: a ticket that entered one status twice inside the window counts once', () => {
  const window = parseWindow('2026-11-03', '2026-11-09');
  const histories = new Map([['SP-1', [
    { at: at('2026-11-03T00:00:00Z'), to: 'rework' }, { at: at('2026-11-04T00:00:00Z'), to: 'in review' }, { at: at('2026-11-05T00:00:00Z'), to: 'rework' },
  ]]]);
  const out = countStages([ticket('SP-1', 'rework', '2026-10-01')], { since: '2026-11-03', until: '2026-11-09', window, histories });
  assert.equal(out.enteredInWindow.rework, 1);
  assert.equal(out.enteredInWindow['in review'], 1);
});

test('countStages: a ticket with no history given is a caller\'s bug, never a quiet zero', () => {
  const window = parseWindow('2026-11-03', null);
  assert.throws(() => countStages([ticket('SP-1', 'queued', '2026-11-04')], { window }), /no status history was given for SP-1/);
});

test('failedHistoryLine names each ticket and why; null when nothing failed', () => {
  assert.equal(failedHistoryLine([]), null);
  assert.equal(
    failedHistoryLine([{ id: 'SP-2', problem: 'HTTP 502: no history' }, { id: 'SP-9', problem: 'HTTP 0' }]),
    'stage-counts FAILED: 2 ticket history read(s) did not come back, so nothing was printed: SP-2 (HTTP 502: no history); SP-9 (HTTP 0)',
  );
});

/**
 * StarCaster's reader, copied verbatim from `gatherStages` and `renderStages`
 * in its `scripts/weekly_report.mjs` and `scripts/builder/weeklyReport.js`,
 * and its seven-stage line-up from `scripts/builder/loopStatuses.js`
 * (2026-11-10; it draws no `Requested`). If either side changes, this test is where the two meet.
 */
function starcasterGatherStages(stdout) {
  const json = JSON.parse(stdout.slice(stdout.indexOf('{')));
  return { ok: true, value: json.byStatus || {}, total: json.total, closedInWindow: json.closedInWindow };
}
const STARCASTER_STAGE_ORDER = ['Rework', 'Queued', 'Building', 'In review', 'Needs your input', 'Ready to launch', 'Live'];
function starcasterStageCell(counts, stage) {
  return Number(counts[stage.toLowerCase()] ?? counts[stage] ?? 0);
}

test('the output reads with the same code StarCaster\'s weekly report uses today, door lines before it and all', () => {
  const window = parseWindow('2026-11-03', '2026-11-09');
  const tickets = [ticket('SP-1', 'In review', '2026-11-04'), ticket('SP-2', 'live', '2026-11-04'), ticket('SP-3', 'needs your input', '2026-11-04')];
  const histories = new Map([
    ['SP-1', [{ at: at('2026-11-04T00:00:00Z'), to: 'queued' }, { at: at('2026-11-05T00:00:00Z'), to: 'in review' }]],
    ['SP-2', [{ at: at('2026-11-04T00:00:00Z'), to: 'queued' }, { at: at('2026-11-06T00:00:00Z'), to: 'live' }]],
    ['SP-3', [{ at: at('2026-11-04T00:00:00Z'), to: 'needs your input' }]],
  ]);
  const printed = `> spirality@0.0.0 clickup\n${JSON.stringify(countStages(tickets, { list: '901418546619', since: '2026-11-03', until: '2026-11-09', window, histories }), null, 2)}\n`;
  const read = starcasterGatherStages(printed);
  assert.equal(read.total, 3);
  assert.equal(read.closedInWindow, 1);
  assert.deepEqual(STARCASTER_STAGE_ORDER.map((s) => starcasterStageCell(read.value, s)), [0, 0, 0, 1, 1, 0, 1]);
  for (const s of STARCASTER_STAGE_ORDER) assert.ok(STATUSES.includes(s.toLowerCase()), `the door counts the report's "${s}" stage`);
});
