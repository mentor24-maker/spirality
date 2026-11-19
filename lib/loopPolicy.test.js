'use strict';

// One Claude limit shared by Dane and every loop lane on the Mini
// (task 86bcgjbfk). The quiet window, the shared stand-down marker, and the
// failure-open rule that keeps a bad file from silencing the lanes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const p = require('./loopPolicy.js');

const REPO = path.join(__dirname, '..');

// Wednesday 2026-10-14, 10:00am in America/Denver (UTC-6 in October).
const WED_10AM = Date.parse('2026-10-14T16:00:00.000Z');
// Saturday 2026-10-17, 10:00am Denver.
const SAT_10AM = Date.parse('2026-10-17T16:00:00.000Z');
// Wednesday 7:00pm Denver.
const WED_7PM = Date.parse('2026-10-15T01:00:00.000Z');

const policyFile = (quietWindow) => JSON.stringify({ quietWindow });
const WORK_HOURS = { days: 'weekdays', start: '08:00', end: '18:00' };

// ---------------------------------------------------------------------------
// The default: no window until Dane names one.
// ---------------------------------------------------------------------------

test('with no policy file and no marker, a lane runs — exactly as before this existed', () => {
  const v = p.policyVerdict({ nowMs: WED_10AM });
  assert.equal(v.action, 'run');
  assert.equal(v.sleepSeconds, 0);
  assert.deepEqual(v.notes, []);
});

test('the committed default window is the one Dane named (none — he answered "B")', () => {
  // Task 86bcgjbfk, 2026-10-11: Dane picked B, no quiet hours. If he ever
  // names hours, this line and DEFAULT_QUIET_WINDOW change together.
  assert.equal(p.DEFAULT_QUIET_WINDOW, null);
});

// ---------------------------------------------------------------------------
// The quiet window.
// ---------------------------------------------------------------------------

test('inside a weekday 8am-6pm window, a lane does not start and says until when', () => {
  const v = p.policyVerdict({ policyText: policyFile(WORK_HOURS), nowMs: WED_10AM });
  assert.equal(v.action, 'quiet');
  assert.match(v.line, /^quiet window until 6pm MT — not starting a pass/);
  // Eight hours left, but it asks again after the re-check interval.
  assert.equal(v.sleepSeconds, p.RECHECK_SECONDS);
});

test('the window ends on time: the last 5 minutes sleep 5 minutes, not 15', () => {
  const at555 = Date.parse('2026-10-14T23:55:00.000Z'); // 5:55pm Denver
  const v = p.policyVerdict({ policyText: policyFile(WORK_HOURS), nowMs: at555 });
  assert.equal(v.action, 'quiet');
  assert.equal(v.sleepSeconds, 5 * 60);
});

test('outside the window (evening, or a weekend for a weekdays window) a lane runs', () => {
  assert.equal(p.policyVerdict({ policyText: policyFile(WORK_HOURS), nowMs: WED_7PM }).action, 'run');
  assert.equal(p.policyVerdict({ policyText: policyFile(WORK_HOURS), nowMs: SAT_10AM }).action, 'run');
  assert.equal(p.policyVerdict({ policyText: policyFile({ ...WORK_HOURS, days: 'all' }), nowMs: SAT_10AM }).action, 'quiet');
});

test('a window crossing midnight belongs to the day it started', () => {
  const night = { days: 'weekdays', start: '22:00', end: '06:00' };
  // Saturday 2am is the tail of FRIDAY night — inside.
  const sat2am = Date.parse('2026-10-17T08:00:00.000Z');
  assert.equal(p.policyVerdict({ policyText: policyFile(night), nowMs: sat2am }).action, 'quiet');
  // Monday 2am is the tail of SUNDAY night — outside a weekdays window.
  const mon2am = Date.parse('2026-10-19T08:00:00.000Z');
  assert.equal(p.policyVerdict({ policyText: policyFile(night), nowMs: mon2am }).action, 'run');
});

test('{"quietWindow": null} in the file turns the window off', () => {
  const v = p.policyVerdict({ policyText: policyFile(null), nowMs: WED_10AM });
  assert.equal(v.action, 'run');
  assert.deepEqual(v.notes, []);
});

// ---------------------------------------------------------------------------
// Failure-open: an unreadable rule runs the lanes as before, and says so.
// ---------------------------------------------------------------------------

test('an unreadable policy file runs the lanes and leaves a note for the log', () => {
  for (const text of ['{not json', '{}', policyFile({ start: '8am', end: '6pm' }), policyFile({ ...WORK_HOURS, days: 'weekends' }), policyFile({ ...WORK_HOURS, zone: 'Mars/Olympus' })]) {
    const v = p.policyVerdict({ policyText: text, nowMs: WED_10AM });
    assert.equal(v.action, 'run', `should run on ${text}`);
    assert.equal(v.notes.length, 1, `should say what it could not read for ${text}`);
  }
});

test('an unreadable stand-down marker is ignored, with a note', () => {
  for (const text of ['garbage', JSON.stringify({ until: 'soon' }), JSON.stringify({})]) {
    const v = p.policyVerdict({ markerText: text, nowMs: WED_10AM });
    assert.equal(v.action, 'run');
    assert.equal(v.notes.length, 1);
    assert.match(v.notes[0], /stand-down marker/);
  }
});

// ---------------------------------------------------------------------------
// The shared stand-down.
// ---------------------------------------------------------------------------

const markerUntil = (ms, setBy = 'wavecenter/loop-review') => JSON.stringify({ until: new Date(ms).toISOString(), setBy });

test('a live marker another lane wrote stands this lane down, naming who set it and until when', () => {
  const v = p.policyVerdict({ markerText: markerUntil(WED_10AM + 50 * 60 * 1000), nowMs: WED_10AM });
  assert.equal(v.action, 'stand-down');
  assert.equal(v.line, 'standing down until Oct 14 10:50am MT (set by wavecenter/loop-review) — not starting a pass');
  assert.equal(v.sleepSeconds, p.RECHECK_SECONDS);
  // ...and the last few minutes sleep only those minutes.
  assert.equal(p.policyVerdict({ markerText: markerUntil(WED_10AM + 90 * 1000), nowMs: WED_10AM }).sleepSeconds, 90);
});

test('a STALE marker (its time has passed) is ignored without a note — that is the normal morning after', () => {
  const v = p.policyVerdict({ markerText: markerUntil(WED_10AM - 1000), nowMs: WED_10AM });
  assert.equal(v.action, 'run');
  assert.deepEqual(v.notes, []);
});

test('a marker past the 8h sanity cap is ignored, loudly, rather than silencing every lane', () => {
  const v = p.policyVerdict({ markerText: markerUntil(WED_10AM + 9 * 3600 * 1000), nowMs: WED_10AM });
  assert.equal(v.action, 'run');
  assert.match(v.notes[0], /sanity cap/);
});

test('a stand-down outranks the quiet window — it is the harder fact and names a time', () => {
  const v = p.policyVerdict({ policyText: policyFile(WORK_HOURS), markerText: markerUntil(WED_10AM + 600000), nowMs: WED_10AM });
  assert.equal(v.action, 'stand-down');
});

test('writing a stand-down: never shortens one another lane already wrote', () => {
  const first = p.standDownText({ lane: 'starcaster/loop-build', sleepSeconds: 3000, nowMs: WED_10AM });
  assert.ok(first);
  assert.equal(JSON.parse(first).setBy, 'starcaster/loop-build');
  assert.equal(Date.parse(JSON.parse(first).until), WED_10AM + 3000 * 1000);
  // A shorter one is refused; a longer one replaces it.
  assert.equal(p.standDownText({ lane: 'starcaster/loop-review', sleepSeconds: 600, existingText: first, nowMs: WED_10AM }), null);
  const longer = p.standDownText({ lane: 'starcaster/loop-review', sleepSeconds: 4000, existingText: first, nowMs: WED_10AM });
  assert.equal(JSON.parse(longer).setBy, 'starcaster/loop-review');
  // A stale or unreadable existing marker never blocks a fresh one.
  assert.ok(p.standDownText({ lane: 'x', sleepSeconds: 600, existingText: markerUntil(WED_10AM - 1), nowMs: WED_10AM }));
  assert.ok(p.standDownText({ lane: 'x', sleepSeconds: 600, existingText: 'garbage', nowMs: WED_10AM }));
  // No time, no marker.
  assert.equal(p.standDownText({ lane: 'x', sleepSeconds: 0, nowMs: WED_10AM }), null);
});

test('the status line names the window, where it came from, and any stand-down', () => {
  assert.equal(p.describePolicy({ nowMs: WED_10AM }), 'policy:   no quiet window (the committed default); may start a pass now');
  assert.equal(p.describePolicy({ policyText: policyFile(WORK_HOURS), nowMs: WED_10AM }),
    'policy:   quiet 8am–6pm MT weekdays (from the project loops.policy file); quiet window until 6pm MT');
  assert.match(p.describePolicy({ markerText: markerUntil(WED_10AM + 600000), nowMs: WED_10AM }),
    /standing down until Oct 14 10:10am MT \(set by wavecenter\/loop-review\)$/);
  assert.match(p.describePolicy({ policyText: '{bad', nowMs: WED_10AM }), /NOTE: the policy file is not valid JSON/);
});

// ---------------------------------------------------------------------------
// The CLI, end to end against a scratch folder: what the runner actually runs.
// ---------------------------------------------------------------------------

function cli(dir, args, now = '2026-10-14T16:00:00.000Z') {
  // The project's short name, as the runner passes it: the files are named for it (SP-396).
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/loop_policy.mjs'), ...args, '--slug', 'proj'], {
    encoding: 'utf8', env: { ...process.env, LOOP_POLICY_DIR: dir, LOOP_POLICY_NOW: now },
  });
  assert.equal(r.status, 0, 'the CLI never fails the runner');
  return { out: r.stdout.trim(), err: r.stderr };
}

test('CLI: one lane records a limit; another lane\'s next check stands down without hitting it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-policy-'));
  assert.equal(cli(dir, ['check', '--lane', 'starcaster/loop-review']).out, 'run 0');
  cli(dir, ['stand-down', '--lane', 'starcaster/loop-build', '--seconds', '3000', '--reason', 'a usage limit']);
  const { out } = cli(dir, ['check', '--lane', 'starcaster/loop-review']);
  assert.match(out, /^stand-down 900 standing down until Oct 14 10:50am MT \(set by starcaster\/loop-build\)/);
  // An hour later the marker is stale and the lane runs.
  assert.equal(cli(dir, ['check', '--lane', 'x'], '2026-10-14T17:00:00.000Z').out, 'run 0');
});

test('CLI: a broken policy file answers run 0 and explains on stderr', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-policy-'));
  fs.writeFileSync(path.join(dir, 'proj-loops.policy'), '{oops');
  const { out, err } = cli(dir, ['check', '--lane', 'x']);
  assert.equal(out, 'run 0');
  assert.match(err, /not valid JSON/);
});

// ---------------------------------------------------------------------------
// The runner really asks, and really tells the others.
// ---------------------------------------------------------------------------

test('loop_runner.sh asks the policy before starting a pass and records a stand-down after one', () => {
  const sh = fs.readFileSync(path.join(REPO, 'scripts/loop_runner.sh'), 'utf8')
    .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const check = sh.indexOf('loop_policy.mjs" check');
  const start = sh.indexOf('START /$SKILL');
  assert.ok(check > 0 && check < start, 'the policy is read before the START banner');
  // The lane key is "<project>/<skill>"; the runner reads the project's short
  // name from the project config ($SLUG = starcaster) rather than typing it.
  assert.match(sh, /loop_policy\.mjs" check --lane "\$SLUG\/\$SKILL" --dir "\$LOG_DIR" --slug "\$SLUG"/);
  assert.match(sh, /loop_policy\.mjs" stand-down --lane "\$SLUG\/\$SKILL" --dir "\$LOG_DIR" --slug "\$SLUG"/);
  // StarCaster's installer prints the rule in --status; Spirality's does not
  // yet (SP-396 moved the guard, not the status line).
});
