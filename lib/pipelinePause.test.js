'use strict';

// settingsPauseVerdict (SP-237): the verdict a lane's runner acts on before
// every pass, from the Settings page's two switches.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { settingsPauseVerdict } = require('./pipelinePause.js');

const controls = (on = []) => ['paused', 'paused.loop-intake', 'paused.loop-build', 'paused.loop-review', 'paused.relay', 'wip-cap']
  .map((key) => ({ key, value: key === 'wip-cap' ? '5' : on.includes(key) ? 'on' : 'off' }));
const change = (setting, to, at, actorName = 'Dane') => ({ setting, from: to === 'on' ? 'off' : 'on', to, actorName, at });

test('nothing paused: run, and say so', () => {
  const v = settingsPauseVerdict({ ok: true, controls: controls(), changes: [] }, 'loop-build');
  assert.equal(v.code, 0);
  assert.equal(v.paused, false);
  assert.match(v.line, /^running — neither the whole pipeline nor loop-build is paused$/);
});

test('this lane paused: do not start, naming who paused it and when, in Mountain time', () => {
  const changes = [change('paused.loop-build', 'on', '2026-11-13T14:30:00Z'), change('paused.loop-build', 'off', '2026-11-13T10:00:00Z'), change('paused.loop-build', 'on', '2026-11-13T09:00:00Z', 'Someone Older')];
  const v = settingsPauseVerdict({ ok: true, controls: controls(['paused.loop-build']), changes }, 'loop-build');
  assert.equal(v.code, 3);
  assert.equal(v.paused, true);
  assert.equal(v.certain, true);
  assert.equal(v.scope, 'lane');
  assert.equal(v.by, 'Dane');
  assert.match(v.line, /^paused by Dane at Nov 13, 2026, 7:30 AM MST — not starting \/loop-build \(loop-build is paused on the Settings page; a pass already running finishes\)$/);
});

test('another lane paused: this one runs', () => {
  const v = settingsPauseVerdict({ ok: true, controls: controls(['paused.loop-build']), changes: [] }, 'loop-review');
  assert.equal(v.code, 0);
});

test('the whole pipeline paused: every lane and the relay stand down, and the line says it is the whole pipeline', () => {
  const read = { ok: true, controls: controls(['paused']), changes: [change('paused', 'on', '2026-07-01T18:00:00Z')] };
  for (const lane of ['loop-intake', 'loop-build', 'loop-review']) {
    const v = settingsPauseVerdict(read, lane);
    assert.equal(v.code, 3, lane);
    assert.equal(v.scope, 'pipeline');
    assert.match(v.line, new RegExp(`^paused by Dane at Jul 1, 2026, 12:00 PM MDT — not starting /${lane} \\(the whole pipeline is paused`));
  }
  assert.match(settingsPauseVerdict(read, 'relay').line, /— not starting the relay pass \(the whole pipeline is paused/);
});

test('settings that cannot be read count as paused, and the line says why without claiming anyone paused it', () => {
  const v = settingsPauseVerdict({ ok: false, why: 'HTTP 502: the tracker is down' }, 'loop-build');
  assert.equal(v.code, 3);
  assert.equal(v.paused, true);
  assert.equal(v.certain, false);
  assert.match(v.line, /^could not read the pipeline settings, so \/loop-build is treated as PAUSED and not starting \(it fails safe: a tracker outage pauses every lane until the tracker answers again\)\. Reason: HTTP 502: the tracker is down$/);
  assert.doesNotMatch(v.line, /paused by/);
  assert.equal(settingsPauseVerdict(undefined, 'relay').code, 3, 'no answer at all is not a read');
});

test('an answer missing either switch counts as unreadable, not as running', () => {
  const noLane = settingsPauseVerdict({ ok: true, controls: controls().filter((c) => c.key !== 'paused.loop-build'), changes: [] }, 'loop-build');
  assert.equal(noLane.code, 3);
  assert.match(noLane.line, /has no "paused\.loop-build" setting/);
  const noWhole = settingsPauseVerdict({ ok: true, controls: [], changes: [] }, 'relay');
  assert.equal(noWhole.code, 3);
  assert.match(noWhole.line, /has no "paused" setting/);
});

test('a pause the change log no longer shows still pauses, and says the log does not name it', () => {
  const v = settingsPauseVerdict({ ok: true, controls: controls(['paused.relay']), changes: [] }, 'relay');
  assert.equal(v.code, 3);
  assert.match(v.line, /^paused by someone the change log no longer names at a time the change log no longer shows — not starting the relay pass/);
});

test('a project with no pipeline controls (its tickets on ClickUp) runs, said plainly', () => {
  const v = settingsPauseVerdict({ unsupported: true, why: 'the pipeline controls are kept only in the tracker' }, 'loop-build');
  assert.equal(v.code, 0);
  assert.match(v.line, /^running — this project keeps no pipeline controls \(the pipeline controls are kept only in the tracker\), so nothing can pause \/loop-build$/);
});
