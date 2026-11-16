'use strict';

// SP-238: loop-build stops claiming new tickets at the cap set on the
// Settings page. lib/wipCheck.js decides; `npm run clickup -- wip-check`
// reads the facts and prints its line.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { capInForce, wipCheckVerdict, unknownVerdict, CAP_SETTING } = require('./wipCheck.js');
const wipCap = require('./wipCap.js');

const NOW = Date.parse('2026-11-13T19:00:00Z');
const ticket = (id, status, minutesAgo = 5) => ({ id, status: { status }, date_updated: String(NOW - minutesAgo * 60000) });
const pr = (number, id) => ({ number, state: 'OPEN', body: `Summary\n\nTicket: http://mac-mini.local:4180/t/${id}\n` });
const page = (value) => ({ ok: true, controls: [{ key: 'paused', value: 'off' }, { key: CAP_SETTING, value }] });

test('the cap is the setting the Settings page keeps', () => {
  // pipelineControls.mjs is ESM; reading its source keeps this test synchronous.
  const src = fs.readFileSync(path.join(__dirname, '..', 'tracker', 'pipelineControls.mjs'), 'utf8');
  assert.match(src, new RegExp(`key: '${CAP_SETTING}'`));
});

test('cap 1 with one open pull request: full, naming that ticket, exit 3', () => {
  const v = wipCheckVerdict({ tickets: [ticket('SP-50', 'In review')], prs: [pr(300, 'SP-50')], cap: 1, nowMs: NOW });
  assert.equal(v.line, 'full: 1 of 1 in flight (SP-50)');
  assert.equal(v.code, 3);
});

test('cap 5 with one open pull request: room, exit 0', () => {
  const v = wipCheckVerdict({ tickets: [ticket('SP-50', 'Building')], prs: [pr(300, 'SP-50')], cap: 5, nowMs: NOW });
  assert.equal(v.line, 'room: 1 of 5 in flight');
  assert.equal(v.code, 0);
});

test('a build with no pull request yet counts, once; a build with one is not counted twice', () => {
  const tickets = [ticket('SP-1', 'Building'), ticket('SP-2', 'Building'), ticket('SP-3', 'In review')];
  const v = wipCheckVerdict({ tickets, prs: [pr(10, 'SP-1'), pr(11, 'SP-3')], cap: 3, nowMs: NOW });
  assert.deepEqual([...v.ids].sort(), ['SP-1', 'SP-2', 'SP-3']);
  assert.equal(v.line, 'full: 3 of 3 in flight (SP-1, SP-3, SP-2)');
});

test('rework, queued, live and Dane\'s statuses do not count, as lib/wipCap.js reads them', () => {
  const tickets = [
    ticket('SP-1', 'Rework'), ticket('SP-2', 'Queued'), ticket('SP-3', 'Live'),
    ticket('SP-4', 'Ready to launch'), ticket('SP-5', 'Needs your input'),
  ];
  const v = wipCheckVerdict({ tickets, prs: tickets.map((t, i) => pr(20 + i, t.id)), cap: 1, nowMs: NOW });
  assert.equal(v.line, 'room: 0 of 1 in flight');
  assert.match(v.detail, /Open pull requests: 5, of which 0 count/);
  assert.match(v.detail, /1 in rework, 1 queued, 1 already live/);
});

test('a pull request whose build pass died is not counted, as wipCap discounts it', () => {
  const v = wipCheckVerdict({ tickets: [ticket('SP-9', 'Building', 600)], prs: [pr(40, 'SP-9')], cap: 1, nowMs: NOW });
  assert.equal(v.line, 'room: 0 of 1 in flight');
  assert.match(v.detail, /1 whose build pass died/);
});

test('a pull request with no ticket found does not count, and says so', () => {
  const v = wipCheckVerdict({ tickets: [], prs: [{ number: 7, state: 'OPEN', body: 'hand-made' }], cap: 1, nowMs: NOW });
  assert.equal(v.code, 0);
  assert.match(v.detail, /1 with no ticket found/);
});

test('the detail never carries wipCap\'s own verdict, which could contradict the line', () => {
  const v = wipCheckVerdict({ tickets: [ticket('SP-2', 'Building')], prs: [], cap: 1, nowMs: NOW });
  assert.equal(v.code, 3);
  assert.doesNotMatch(v.detail, /room to claim/);
});

test('could not tell: exit 1, and the line says the pass goes on without the cap', () => {
  const v = unknownVerdict('gh: could not resolve host');
  assert.equal(v.code, 1);
  assert.match(v.line, /could not tell/);
  assert.match(v.line, /gh: could not resolve host/);
  assert.match(v.line, /NOT applied: the pass goes on/);
});

test('on a lane the page wins; in a hand run CLAUDE_LOOP_WIP_CAP overrides it', () => {
  assert.deepEqual(capInForce({ settings: page('3'), env: {} }), { cap: 3, source: 'the Settings page' });
  const lane = capInForce({ settings: page('3'), env: { LOOP_RUNNER_PID: '123', [wipCap.CAP_ENV]: '9' } });
  assert.equal(lane.cap, 3, 'the lane runs on the page\'s value');
  const hand = capInForce({ settings: page('3'), env: { [wipCap.CAP_ENV]: '9' } });
  assert.equal(hand.cap, 9);
  assert.match(hand.source, /hand run \(the Settings page says 3\)/);
  for (const bad of ['abc', '-1', '2.5', '']) {
    assert.equal(capInForce({ settings: page('3'), env: { [wipCap.CAP_ENV]: bad } }).cap, 3, `"${bad}" is ignored`);
  }
});

test('a project with no Settings page runs on the override or wipCap\'s default', () => {
  assert.equal(capInForce({ settings: { unsupported: true }, env: {} }).cap, wipCap.DEFAULT_WIP_CAP);
  assert.equal(capInForce({ settings: { unsupported: true }, env: { [wipCap.CAP_ENV]: '2' } }).cap, 2);
});

test('settings that cannot be read, or carry no usable cap, are "could not tell", never a default', () => {
  const failed = capInForce({ settings: { ok: false, why: 'HTTP 502' }, env: {} });
  assert.equal(failed.cap, null);
  assert.match(failed.why, /HTTP 502/);
  assert.equal(capInForce({ settings: { ok: true, controls: [] }, env: {} }).cap, null);
  assert.match(capInForce({ settings: page('lots'), env: {} }).why, /"lots"/);
});

test('the door\'s wip-check reads only, and lists open pull requests only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'clickup.mjs'), 'utf8');
  const start = src.indexOf("} else if (cmd === 'wip-check') {");
  assert.ok(start > -1, 'the wip-check command must exist');
  const end = src.indexOf('} else if (cmd ===', start + 10);
  const block = src.slice(start, end);
  for (const write of ['tracker.setStatus', 'tracker.postComment', 'tracker.update', "call('POST'", "call('PUT'", 'writeMarker']) {
    assert.ok(!block.includes(write), `wip-check must not ${write}`);
  }
  assert.match(block, /'--state', 'open'/);
  assert.match(block, /includeClosed: true/, 'a pull request whose ticket is Live must be known as that');
  assert.match(block, /wipCheckVerdict\(/);
});

test('loop-build runs it before it claims, and stops on full', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', '.claude', 'skills', 'loop-build', 'SKILL.md'), 'utf8');
  const check = skill.indexOf('npm run clickup -- wip-check');
  assert.ok(check > -1, 'the skill must run wip-check');
  const firstClaim = skill.indexOf('npm run clickup -- claim --task');
  assert.ok(check < firstClaim, 'and before its first claim');
  assert.match(skill, /WIP CAP REACHED/);
});
