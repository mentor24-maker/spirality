'use strict';

/**
 * The heartbeat's decisions (lib/heartbeat.js), driven with no network, no
 * token and no clock of its own. The recency tests are moved from StarCaster's
 * scripts/builder/nodeHeartbeat.test.js (commit 0682572), with the lanes'
 * cadences passed in rather than read from StarCaster's role table; the tests
 * for the multi-machine roll call and the beat kinds stayed behind with that
 * code. The log reader's tests are new: Spirality's beat is the lane's log.
 *
 * Every test is written against a way this could fail QUIETLY: a watchdog
 * that fails loudly is a nuisance, one that fails quietly is worse than none,
 * because it turns "nobody is watching" into "something is watching".
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const hb = require('./heartbeat.js');

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const NOW = Date.parse('2026-08-30T12:00:00.000Z');
const agoHours = (h) => new Date(NOW - h * HOUR).toISOString();

/** The Spirality lanes at their default wake times (scripts/lib/loopSchedule.mjs). */
const EMITTERS = {
  relay: { intervalMs: 10 * MINUTE, beatMeans: 'liveness' },
  'loop-build': { intervalMs: 30 * MINUTE, beatMeans: 'liveness' },
  'loop-review': { intervalMs: 30 * MINUTE, beatMeans: 'liveness' },
  'loop-intake': { intervalMs: 60 * MINUTE, beatMeans: 'liveness' },
};

/** A beat as the script hands one over. */
const beatAt = (at) => ({ found: true, readable: true, beat: { at, lastLineAt: at } });
const report = (entries) => hb.recencyReport({ entries, now: NOW, emitters: EMITTERS });

// --- the threshold (moved) ------------------------------------------------------

test('the threshold is derived per lane from that lane\'s own cadence, not one global number', () => {
  assert.equal(hb.quietAfterFor('relay', EMITTERS), 3 * HOUR, 'a 10-minute job floors at 3 hours');
  assert.equal(hb.quietAfterFor('loop-build', EMITTERS), 3 * HOUR, '6 x 30 minutes is 3 hours');
  assert.equal(hb.quietAfterFor('loop-intake', EMITTERS), 6 * HOUR);
  assert.equal(hb.quietAfterFor('loop-build', { 'loop-build': { intervalMs: 4 * HOUR } }), 24 * HOUR, 'a lane set to wake every 4 hours may be quiet 24');
  // A lane with no declared cadence is not "fine": there is nothing to judge.
  assert.equal(hb.quietAfterFor('nonsense-lane', EMITTERS), null);
});

test('one or two missed passes do NOT fire it — never tighter than three hours', () => {
  // BREAK TEST, quiet direction: make the threshold tiny and this fails.
  assert.equal(report([{ role: 'loop-build', beat: beatAt(agoHours(1.07)) }]).quiet.length, 0);
  assert.equal(report([{ role: 'loop-build', beat: beatAt(agoHours(2.1)) }]).quiet.length, 0);
  assert.equal(report([{ role: 'relay', beat: beatAt(agoHours(2.9)) }]).quiet.length, 0);
  assert.ok(hb.MIN_QUIET_AFTER_MS >= 3 * HOUR);
});

test('a dead lane alarms once its own threshold has passed', () => {
  // BREAK TEST, the other direction: make the threshold enormous and this fails.
  const r = report([{ role: 'relay', beat: beatAt(agoHours(16)) }]);
  assert.equal(r.quiet.length, 1, 'sixteen hours of silence from a ten-minute job must alarm');
  assert.equal(r.silent, true);
  assert.match(r.quiet[0].reason, /last ran/);
  assert.doesNotMatch(r.quiet[0].reason, /succeeded/, 'a lane beats on liveness, so the alarm never claims its work failed');
  assert.equal(r.fresh.length, 0);
});

test('a lane stuck exactly ON its threshold is not yet quiet, one millisecond past it is', () => {
  const at = (ms) => report([{ role: 'relay', beat: beatAt(new Date(NOW - ms).toISOString()) }]);
  assert.equal(at(3 * HOUR).quiet.length, 0);
  assert.equal(at(3 * HOUR + 1).quiet.length, 1);
});

test('four answers, never two — nothing unmeasurable is reported as running', () => {
  const r = report([
    { role: 'relay', beat: { found: false, readable: true } },
    { role: 'loop-build', beat: { found: false, readable: false, why: 'EACCES' } },
    { role: 'weekly-report', beat: beatAt(agoHours(200)) },
    { role: 'loop-review', beat: beatAt(new Date(NOW + HOUR).toISOString()) },
    { role: 'loop-intake', beat: beatAt('not a date') },
  ]);
  assert.equal(r.quiet.length, 0);
  assert.equal(r.fresh.length, 0, 'not one of these may be counted as running');
  assert.equal(r.unknown.length, 5);
  assert.match(r.unknown.find((u) => u.role === 'relay').why, /no pass in it yet/);
  assert.match(r.unknown.find((u) => u.role === 'loop-build').why, /could not be read: EACCES/);
  assert.match(r.unknown.find((u) => u.role === 'weekly-report').why, /no run interval is known/);
  assert.match(r.unknown.find((u) => u.role === 'loop-review').why, /in the future/);
  assert.match(r.unknown.find((u) => u.role === 'loop-intake').why, /cannot be read as a date/);
});

test('the alarm quotes the lane\'s real cadence, not the threshold divided back down', () => {
  const r = report([{ role: 'relay', beat: beatAt(agoHours(16)) }]);
  assert.equal(r.quiet[0].intervalMs, 10 * MINUTE);
  assert.match(r.quiet[0].reason, /expected about every 10m/);
  assert.doesNotMatch(r.quiet[0].reason, /every 30m/);
});

test('suppression holds inside the window and releases outside it', () => {
  const lastAt = agoHours(5.9);
  assert.equal(hb.dueAgain({ lastAt, now: NOW, everyMs: hb.REPOST_EVERY_MS }), false);
  assert.equal(hb.dueAgain({ lastAt: agoHours(6), now: NOW, everyMs: hb.REPOST_EVERY_MS }), true);
  assert.equal(hb.REPOST_EVERY_MS, 6 * HOUR, 'the ticket\'s limit: once every 6 hours per lane');
});

test('a missing or unreadable suppression stamp posts rather than staying silent', () => {
  assert.equal(hb.dueAgain({ lastAt: null, now: NOW, everyMs: HOUR }), true);
  assert.equal(hb.dueAgain({ lastAt: 'garbage', now: NOW, everyMs: HOUR }), true);
});

test('ages read the way a person says them', () => {
  assert.equal(hb.ageText(5 * MINUTE), '5m ago');
  assert.equal(hb.ageText(3 * HOUR + 10 * MINUTE), '3h 10m ago');
  assert.equal(hb.ageText(50 * HOUR), '2d 2h ago');
  assert.equal(hb.durationText(3 * HOUR), '3h 0m');
  assert.match(hb.ageText(-1), /future/);
});

// --- what goes on the bus ---------------------------------------------------------

test('the quiet post is an alarm, names the lane, the project and when it last ran', () => {
  const r = report([{ role: 'loop-build', beat: beatAt(agoHours(4)) }]);
  const post = hb.renderStalePost({ quiet: r.quiet, project: 'example', now: NOW, when: (iso) => `<${iso}>` });
  assert.match(post, /^ALARM: a lane has stopped running for example: loop-build\./, 'ALARM: first, so the tracker texts it');
  assert.match(post, new RegExp(`last pass <${agoHours(4).replace(/[.]/g, '\\.')}>`));
  assert.match(post, /the runner itself has stopped/);
  assert.match(post, /at most once every 6 hours/);
  assert.doesNotMatch(post, /mac-mini|starcaster|spirality/i, 'no machine or project name of its own');
});

test('the recovery post closes an alarm and cannot become an all-clear x365', () => {
  const post = hb.renderRecoveredPost({ role: 'relay', project: 'example', quietSince: agoHours(9), when: (iso) => iso });
  assert.match(post, /relay is running again for example/);
  assert.match(post, /not a routine all-clear/);
  assert.doesNotMatch(post, /^ALARM:/, 'good news is never texted');
});

// --- reading a lane's log (new) ---------------------------------------------------

/** "YYYY-MM-DD HH:MM:SS" in this machine's own time, the way the runners write it. */
function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const at = (h) => Date.parse(agoHours(h));
const toSecond = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString();

test('the newest dated START, END or SKIP line is the beat; other lines are not', () => {
  const log = [
    `===== ${stamp(at(5))} START /loop-build (model: default) =====`,
    'some report',
    `===== ${stamp(at(4.9))} END /loop-build (exit 0 — not a verdict; the pass's report above is) =====`,
    '[loop-runner] 07:19:35 sleeping 1800s before the next /loop-build',
    `===== ${stamp(at(2))} SKIP /loop-build (no work; Claude not started) =====`,
    `===== ${stamp(at(1))} START /loop-review =====`,
  ].join('\n');
  const b = hb.lastBeatFromLog(log, 'loop-build', { now: NOW, passLimitMs: 2 * HOUR });
  assert.equal(b.found, true);
  assert.equal(b.at, toSecond(at(2)), 'a SKIP line is the runner alive, the review lane\'s START is not this lane');
  assert.equal(b.running, false);
});

test('a dated PAUSED line is the runner alive and holding off, never a pass', () => {
  // Paused a day, the runner wrote PAUSED on every wake; the newest is the beat.
  const log = [
    `===== ${stamp(at(26))} START /loop-build (model: default) =====`,
    `===== ${stamp(at(25.9))} END /loop-build (exit 0) =====`,
    `[loop-runner] 07:19:35 paused by Dane at Nov 13, 2026, 7:30 AM MST — not starting /loop-build`,
    `===== ${stamp(at(1))} PAUSED /loop-build =====`,
    `===== ${stamp(at(0.4))} PAUSED /loop-build =====`,
  ].join('\n');
  const b = hb.lastBeatFromLog(log, 'loop-build', { now: NOW, passLimitMs: 2 * HOUR });
  assert.equal(b.at, toSecond(at(0.4)));
  assert.equal(b.running, false, 'a PAUSED line never opens or closes a pass');
  assert.equal(report([{ role: 'loop-build', beat: { readable: true, found: true, beat: b } }]).quiet.length, 0);
});

test('a pass under way counts as alive until its own time limit, never past now', () => {
  const log = `===== ${stamp(at(1.5))} START /loop-build (model: default) =====\nworking`;
  const b = hb.lastBeatFromLog(log, 'loop-build', { now: NOW, passLimitMs: 2 * HOUR });
  assert.equal(b.running, true);
  assert.equal(b.at, new Date(NOW).toISOString(), 'inside its limit it is alive now');
  assert.equal(b.lastLineAt, toSecond(at(1.5)));

  // A START with no END five hours ago: the runner should have stopped it at
  // two hours, so from there it is silence like any other.
  const stuck = hb.lastBeatFromLog(`===== ${stamp(at(5))} START /loop-build =====`, 'loop-build', { now: NOW, passLimitMs: 2 * HOUR });
  assert.equal(stuck.at, toSecond(at(3)));
  assert.equal(report([{ role: 'loop-build', beat: { readable: true, found: true, beat: stuck } }]).quiet.length, 0, '3h since its limit is exactly the threshold');
  const longer = hb.lastBeatFromLog(`===== ${stamp(at(5.5))} START /loop-build =====`, 'loop-build', { now: NOW, passLimitMs: 2 * HOUR });
  assert.equal(report([{ role: 'loop-build', beat: { readable: true, found: true, beat: longer } }]).quiet.length, 1);
});

test('the relay\'s lines are read by its own marker', () => {
  const log = [
    `===== ${stamp(at(1))} START relay — /some/checkout =====`,
    `===== ${stamp(at(0.9))} END relay — pass complete (exit 0); app-checks finished =====`,
  ].join('\n');
  const b = hb.lastBeatFromLog(log, 'relay', { now: NOW, passLimitMs: 8 * MINUTE });
  assert.equal(b.at, toSecond(at(0.9)));
  assert.equal(hb.lastBeatFromLog(log, 'loop-build').found, false);
});

test('an empty log, or one with no dated line for the lane, has no beat', () => {
  assert.deepEqual(hb.lastBeatFromLog('', 'loop-build'), { found: false });
  assert.deepEqual(hb.lastBeatFromLog('[loop-runner] 09:31:00 sleeping 300s', 'loop-build'), { found: false });
  // A lane whose name is the start of another's is not confused with it.
  assert.equal(hb.lastBeatFromLog(`===== ${stamp(at(1))} START /loop-build-extra =====`, 'loop-build').found, false);
});
