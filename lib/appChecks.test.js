'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decide, dueChecks, resultOf, redact, firstLine, REMIND_AFTER_MS, DUE_SLACK_MS, LINE_LIMIT,
} = require('./appChecks.js');
const { mountainTime } = require('./trackerBus.js');

const T0 = Date.parse('2026-11-12T20:00:00Z');
const MIN = 60 * 1000;
const check = (over = {}) => ({ name: 'site-import-watch', command: 'true', everyMinutes: 10, alarm: true, timeoutSeconds: 60, ...over });
const failing = (line = 'import stalled 3 hours') => ({ well: false, line });
const WELL = { well: true, line: '' };

// ── The post rules, one row each ────────────────────────────────────────────

test('appChecks: well before, failing now, alarm check → one ALARM: post', () => {
  const d = decide(check(), undefined, failing(), T0);
  assert.equal(d.post, 'ALARM: site-import-watch: import stalled 3 hours');
  assert.equal(d.kind, 'failing');
  assert.deepEqual(d.next, { well: false, line: 'import stalled 3 hours', since: T0, remindedAt: T0, ranAt: T0 });
  // An explicit well state before, the same.
  assert.equal(decide(check(), { well: true, ranAt: T0 - 10 * MIN }, failing(), T0).post, 'ALARM: site-import-watch: import stalled 3 hours');
});

test('appChecks: well before, failing now, plain check (alarm: false) → a plain post, no ALARM:', () => {
  const d = decide(check({ alarm: false }), { well: true }, failing('2 broken links'), T0);
  assert.equal(d.post, 'site-import-watch: 2 broken links');
  assert.doesNotMatch(d.post, /ALARM/);
});

test('appChecks: failing before, still failing within a day → nothing posted, the start time kept', () => {
  const prev = { well: false, line: 'old line', since: T0, remindedAt: T0, ranAt: T0 };
  const d = decide(check(), prev, failing('new line'), T0 + REMIND_AFTER_MS - MIN);
  assert.equal(d.post, null);
  assert.equal(d.kind, 'still-failing');
  assert.equal(d.next.since, T0);
  assert.equal(d.next.remindedAt, T0);
  assert.equal(d.next.line, 'new line');
});

test('appChecks: failing before, still failing a day on → one reminder naming the start in Mountain time, then quiet again', () => {
  const prev = { well: false, line: 'x', since: T0, remindedAt: T0, ranAt: T0 };
  const at = T0 + REMIND_AFTER_MS;
  const d = decide(check(), prev, failing(), at);
  assert.equal(d.kind, 'reminder');
  assert.equal(d.post, `ALARM: site-import-watch: still failing since ${mountainTime(T0)}: import stalled 3 hours`);
  assert.match(d.post, / MT: /);
  assert.equal(d.next.since, T0);
  assert.equal(d.next.remindedAt, at);
  // The next pass, ten minutes on, says nothing.
  assert.equal(decide(check(), d.next, failing(), at + 10 * MIN).post, null);
  // A plain check's reminder is plain.
  assert.equal(decide(check({ alarm: false }), prev, failing(), at).post, `site-import-watch: still failing since ${mountainTime(T0)}: import stalled 3 hours`);
});

test('appChecks: failing before, well now → "well again", never an alarm', () => {
  const prev = { well: false, line: 'x', since: T0, remindedAt: T0, ranAt: T0 };
  const d = decide(check({ alarm: true }), prev, WELL, T0 + 20 * MIN);
  assert.equal(d.post, 'site-import-watch: well again');
  assert.equal(d.kind, 'well-again');
  assert.equal(d.next.well, true);
  assert.equal(d.next.since, null);
});

test('appChecks: well before, well now → nothing; a check never run that is well → nothing', () => {
  assert.equal(decide(check(), { well: true, ranAt: T0 - 10 * MIN }, WELL, T0).post, null);
  const first = decide(check(), undefined, WELL, T0);
  assert.equal(first.post, null);
  assert.equal(first.next.ranAt, T0);
});

// ── What a run comes to ─────────────────────────────────────────────────────

test('appChecks: exit 0 is well; non-zero keeps only the first line it printed', () => {
  assert.deepEqual(resultOf({ code: 0, stdout: 'all fine\nmore' }), { well: true, line: '' });
  assert.deepEqual(resultOf({ code: 1, stdout: '\n  3 imports stalled  \nsecond line\nthird' }), { well: false, line: '3 imports stalled' });
  assert.deepEqual(resultOf({ code: 2, stdout: '', stderr: 'from stderr\nmore' }), { well: false, line: 'from stderr' });
});

test('appChecks: a non-zero exit printing nothing is "exited <code> with no message"', () => {
  assert.deepEqual(resultOf({ code: 3, stdout: '', stderr: '  \n' }), { well: false, line: 'exited 3 with no message' });
});

test('appChecks: a check past its time limit is "did not finish in <n> seconds"', () => {
  assert.deepEqual(resultOf({ timedOut: true, code: null, stdout: 'partial' }, { timeoutSeconds: 60 }), { well: false, line: 'did not finish in 60 seconds' });
});

test('appChecks: a command that could not start says so', () => {
  assert.equal(resultOf({ error: 'spawn /bin/sh ENOENT' }).line, 'could not be run (spawn /bin/sh ENOENT)');
});

test('appChecks: a long line is cut to the limit', () => {
  const line = firstLine('x'.repeat(LINE_LIMIT + 50));
  assert.equal(line.length, LINE_LIMIT);
});

test('appChecks: a secret-looking variable\'s value never reaches the line', () => {
  const env = { OPENAI_API_KEY: 'sk-abcdefghijklmnop', TRACKER_TOKEN: 'tok-1234567890', HOME: '/Users/someone', SHORT_KEY: 'abc' };
  const r = resultOf({ code: 1, stdout: 'key sk-abcdefghijklmnop refused for tok-1234567890 in /Users/someone abc' }, { env });
  assert.equal(r.line, 'key [hidden] refused for [hidden] in /Users/someone abc');
  assert.equal(redact('nothing here', env), 'nothing here');
});

// ── Which checks are due ───────────────────────────────────────────────────

test('appChecks: a check never run is due; one run within its interval is not; the relay\'s tick does not skip one', () => {
  const checks = [check({ name: 'a', everyMinutes: 10 }), check({ name: 'b', everyMinutes: 60 }), check({ name: 'c', everyMinutes: 10 })];
  const state = {
    a: { ranAt: T0 - 10 * MIN + 2000 }, // the relay ticked a little early: still due
    b: { ranAt: T0 - 30 * MIN },
  };
  assert.deepEqual(dueChecks(checks, state, T0).map((c) => c.name), ['a', 'c']);
  assert.deepEqual(dueChecks(checks, { a: { ranAt: T0 - 10 * MIN + DUE_SLACK_MS + 1 } }, T0).map((c) => c.name), ['b', 'c']);
  assert.deepEqual(dueChecks(checks, null, T0).map((c) => c.name), ['a', 'b', 'c']);
  assert.deepEqual(dueChecks([], {}, T0), []);
});

test('appChecks: the module names no project, machine or list', () => {
  const src = require('node:fs').readFileSync(require.resolve('./appChecks.js'), 'utf8');
  assert.doesNotMatch(src, /mac-mini|starcaster-bus|spirality-bus|\b9014\d{8}\b/i);
});
