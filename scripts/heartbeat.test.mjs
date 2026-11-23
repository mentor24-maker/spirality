// scripts/heartbeat.mjs (SP-266), driven with a fixture log folder and a
// stand-in for the bus: nothing here reaches a tracker. Plus the check that
// no project's id, name or label is written in the heartbeat's code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runHeartbeat, laneSettings, passLimitMs, readLaneLog, clearStamp } from './heartbeat.mjs';
import { LANES } from '../lib/onboardLanes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const HOUR = 3600_000;
const NOW = Date.parse('2026-11-14T19:00:00.000Z');

function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const passAt = (lane, ms) => {
  const marker = lane === 'relay' ? 'relay —' : `/${lane}`;
  return `===== ${stamp(ms)} START ${marker} x =====\nreport\n===== ${stamp(ms + 60_000)} END ${marker} (exit 0) =====\n`;
};

const SETTINGS = ['wake.loop-intake=1800', 'wake.loop-build=1800', 'wake.loop-review=1800', 'wake.relay=600',
  'paused=off', 'paused.loop-intake=off', 'paused.loop-build=off', 'paused.loop-review=off', 'paused.relay=off'].join('\n');

/** A scratch project: a log folder with every lane fresh but the ones given an age. */
function scratch({ ages = {}, busProject = 'example-bus', settings = { ok: true, text: SETTINGS }, failPosts = false, installed = LANES, clear = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-'));
  const logDir = join(dir, 'logs');
  mkdirSync(logDir);
  const config = { projectSlug: 'example', logDir, launchdPrefix: 'com.example', ...(busProject ? { busProject } : {}) };
  for (const lane of LANES) {
    writeFileSync(join(logDir, `example-${lane}.log`), passAt(lane, NOW - (ages[lane] ?? 0.2) * HOUR - 60_000));
  }
  const posts = [];
  const lines = [];
  const problems = [];
  const stampFile = (lane) => join(logDir, `example-heartbeat-quiet-${lane}`);
  const run = ({ check = true, now = NOW } = {}) => runHeartbeat({
    config,
    check,
    now,
    env: {},
    readLog: (lane) => ({ readable: true, text: existsSync(join(logDir, `example-${lane}.log`)) ? readFileSync(join(logDir, `example-${lane}.log`), 'utf8') : '' }),
    installed: (lane) => installed.includes(lane),
    settings,
    post: (text) => { posts.push(text); return failPosts ? { ok: false, why: 'tracker down' } : { ok: true }; },
    stamps: {
      read: (lane) => (existsSync(stampFile(lane)) ? readFileSync(stampFile(lane), 'utf8').trim() : null),
      write: (lane, iso) => writeFileSync(stampFile(lane), iso),
      clear: clear || ((lane) => { if (existsSync(stampFile(lane))) unlinkSync(stampFile(lane)); }),
    },
    out: (l) => lines.push(l),
    err: (l) => problems.push(l),
  });
  return { dir, logDir, posts, lines, problems, run, stampFile, config };
}

test('without --check, every lane is one line with its last pass in Mountain time, and nothing is posted', () => {
  const s = scratch();
  assert.equal(s.run({ check: false }), 0);
  assert.equal(s.posts.length, 0);
  assert.equal(s.lines.length, LANES.length);
  for (const lane of LANES) {
    const line = s.lines.find((l) => l.startsWith(`${lane} `));
    assert.ok(line, `a line for ${lane}`);
    assert.match(line, /last pass \d+\/\d+\/\d{4}, \d+:\d{2} (AM|PM) MT {2}running$/);
  }
});

test('a lane whose log is 3 hours old is quiet: --check posts one alarm naming it, and a second run within 6 hours posts nothing', () => {
  const s = scratch({ ages: { 'loop-build': 3.1 } });
  assert.equal(s.run({ check: false }), 3, 'read-only, a quiet lane exits 3');
  assert.match(s.lines.find((l) => l.startsWith('loop-build')), /QUIET \(last ran 3h \d+m ago/);
  assert.equal(s.posts.length, 0);

  assert.equal(s.run(), 0);
  assert.equal(s.posts.length, 1, 'one alarm, for the one quiet lane');
  assert.match(s.posts[0], /^ALARM: a lane has stopped running for example: loop-build\./);
  assert.match(s.posts[0], /last pass \d+\/\d+\/\d{4}, \d+:\d{2} (AM|PM) MT/);
  assert.ok(existsSync(s.stampFile('loop-build')), 'the post is remembered, beside the lane\'s own files');

  // The other lanes keep running; only loop-build stays quiet.
  const keepOthersRunning = (now) => {
    for (const lane of LANES.filter((l) => l !== 'loop-build')) writeFileSync(join(s.logDir, `example-${lane}.log`), passAt(lane, now - 10 * 60_000));
  };
  keepOthersRunning(NOW + 5.9 * HOUR);
  assert.equal(s.run({ now: NOW + 5.9 * HOUR }), 0);
  assert.equal(s.posts.length, 1, 'still quiet inside 6 hours: nothing posted again');
  assert.match(s.lines.join('\n'), /loop-build is still quiet; already said on the bus/);
  keepOthersRunning(NOW + 6 * HOUR);
  assert.equal(s.run({ now: NOW + 6 * HOUR }), 0);
  assert.equal(s.posts.length, 2, 'six hours on, said again');
  assert.match(s.posts[1], /^ALARM: .*loop-build/);
});

test('a quiet lane that runs again gets one closing line, and its stamp goes', () => {
  const s = scratch({ ages: { 'loop-review': 4 } });
  s.run();
  assert.equal(s.posts.length, 1);
  writeFileSync(join(s.logDir, 'example-loop-review.log'), passAt('loop-review', NOW + 10 * 60_000));
  assert.equal(s.run({ now: NOW + 20 * 60_000 }), 0);
  assert.equal(s.posts.length, 2);
  assert.match(s.posts[1], /loop-review is running again for example/);
  assert.equal(existsSync(s.stampFile('loop-review')), false, 'cleared when the lane runs again');
  s.run({ now: NOW + 30 * 60_000 });
  assert.equal(s.posts.length, 2, 'no all-clear on a lane nobody was told about');
});

test('a failed bus post exits 1, says so, and is not marked as said', () => {
  const s = scratch({ ages: { relay: 5 }, failPosts: true });
  assert.equal(s.run(), 1);
  assert.equal(s.posts.length, 1);
  assert.match(s.problems.join('\n'), /relay is quiet, and the bus post FAILED \(tracker down\)/);
  assert.equal(existsSync(s.stampFile('relay')), false, 'the next wake tries again');
});

test('a project with no busProject says it has nowhere to post and exits non-zero', () => {
  const s = scratch({ busProject: null, ages: { 'loop-build': 5 } });
  const code = s.run();
  assert.notEqual(code, 0);
  assert.equal(code, 2);
  assert.equal(s.posts.length, 0);
  assert.match(s.problems.join('\n'), /names no busProject .* nowhere to post/);
});

test('a paused lane or one not installed is never judged; a lane with no pass yet is "cannot tell", never quiet', () => {
  const paused = SETTINGS.replace('paused.loop-build=off', 'paused.loop-build=on');
  const s = scratch({ ages: { 'loop-build': 30, 'loop-intake': 30 }, settings: { ok: true, text: paused }, installed: ['relay', 'loop-build', 'loop-review'] });
  writeFileSync(join(s.logDir, 'example-loop-review.log'), '');
  assert.equal(s.run(), 0);
  assert.equal(s.posts.length, 0);
  assert.match(s.lines.find((l) => l.startsWith('loop-build')), /paused/);
  assert.match(s.lines.find((l) => l.startsWith('loop-intake')), /not installed \(no launchd job com\.example\.loop-intake\)/);
  assert.match(s.lines.find((l) => l.startsWith('loop-review')), /no pass yet {2}cannot tell/);

  const whole = scratch({ ages: { relay: 30 }, settings: { ok: true, text: SETTINGS.replace('paused=off', 'paused=on') } });
  assert.equal(whole.run(), 0);
  assert.equal(whole.posts.length, 0, 'the whole pipeline paused: no lane is judged');
});

test('the Settings page\'s wake time sizes the threshold; an unreadable page is paused, as the runners read it', () => {
  assert.deepEqual(laneSettings({ ok: true, text: SETTINGS.replace('wake.loop-build=1800', 'wake.loop-build=14400') }, 'loop-build'),
    { intervalMs: 14400_000, intervalFrom: 'the Settings page', paused: false, pausedWhy: null });
  const down = laneSettings({ ok: false, why: 'down' }, 'relay');
  assert.equal(down.intervalMs, 600_000);
  assert.equal(down.intervalFrom, 'the default');
  assert.equal(down.paused, true, 'pause_check.sh fails safe on an unreadable page, so the heartbeat does too');
  assert.match(down.pausedWhy, /could not read the pipeline settings.*Reason: down/);
  // A page that lacks a lane's switch is paused to the runner too.
  assert.equal(laneSettings({ ok: true, text: SETTINGS.replace('paused.loop-review=off\n', '') }, 'loop-review').paused, true);
  // Four-hourly wakes: five hours of quiet is normal for that lane.
  const s = scratch({ ages: { 'loop-build': 5 }, settings: { ok: true, text: SETTINGS.replace('wake.loop-build=1800', 'wake.loop-build=14400') } });
  assert.equal(s.run(), 0);
  assert.equal(s.posts.length, 0);
  // Settings unreadable: every runner holds off (it fails safe), so no lane is called quiet.
  const u = scratch({ ages: { 'loop-build': 5 }, settings: { ok: false, why: 'down' } });
  assert.equal(u.run(), 0);
  assert.equal(u.posts.length, 0);
  assert.match(u.lines.find((l) => l.startsWith('loop-build')), /paused \(could not read the pipeline settings/);
});

test('a lane paused for a day, then unpaused, is not called quiet when the relay wakes before the lane does', () => {
  // Its last pass was 25 hours ago; while paused, its runner wrote a dated
  // PAUSED line on every wake (scripts/loop_runner.sh), the newest 20 minutes ago.
  const s = scratch();
  const log = passAt('loop-build', NOW - 25 * HOUR)
    + `[loop-runner] 11:40:00 paused by Dane — not starting /loop-build\n===== ${stamp(NOW - 50 * 60_000)} PAUSED /loop-build =====\n`
    + `===== ${stamp(NOW - 20 * 60_000)} PAUSED /loop-build =====\n`;
  writeFileSync(join(s.logDir, 'example-loop-build.log'), log);
  assert.equal(s.run(), 0);
  assert.equal(s.posts.length, 0, 'no false alarm after a pause');
  assert.match(s.lines.find((l) => l.startsWith('loop-build')), /running$/);
});

test('a stamp that cannot be removed is a failure, said by name, never a success line', () => {
  const s = scratch({ ages: { 'loop-review': 4 }, clear: () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } });
  s.run();
  writeFileSync(join(s.logDir, 'example-loop-review.log'), passAt('loop-review', NOW + 10 * 60_000));
  assert.equal(s.run({ now: NOW + 20 * 60_000 }), 1);
  assert.match(s.problems.join('\n'), /loop-review runs again and the bus was told, but forgetting its quiet report FAILED \(EACCES\)/);
  assert.doesNotMatch(s.lines.join('\n'), /runs again: said so on the bus/);

  // clearStamp: a stamp already gone is fine; any other error is thrown.
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-clear-'));
  assert.doesNotThrow(() => clearStamp(join(dir, 'gone')));
  assert.throws(() => clearStamp(dir), (e) => e.code !== 'ENOENT');
});

test('a lane log is read from its end, and whole only when the end holds no dated line for the lane', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-tail-'));
  const file = join(dir, 'lane.log');
  const old = passAt('loop-build', NOW - 30 * HOUR);
  const recent = passAt('loop-build', NOW - HOUR);
  writeFileSync(file, old + 'x'.repeat(2000) + '\n' + recent);
  const tail = readLaneLog(file, 'loop-build', { tailBytes: 400 });
  assert.equal(tail.readable, true);
  assert.ok(!tail.text.includes('x'.repeat(500)) && tail.text.includes(recent.trim().split('\n')[0]), 'only the end was read');
  // A long pass: its START is further back than the tail reaches.
  writeFileSync(file, `===== ${stamp(NOW - HOUR)} START /loop-build x =====\n` + 'y'.repeat(2000) + '\n');
  const whole = readLaneLog(file, 'loop-build', { tailBytes: 400 });
  assert.match(whole.text, /START \/loop-build/, 'no dated line in the tail, so the whole log was read');
  assert.deepEqual(readLaneLog(join(dir, 'none.log'), 'loop-build'), { readable: true, text: '' });
});

test('the pass limits are the runners\' own', () => {
  assert.equal(passLimitMs('loop-build', {}), 7200_000);
  assert.equal(passLimitMs('relay', {}), 480_000);
  assert.equal(passLimitMs('loop-review', { LOOP_PASS_LIMIT_SECONDS: '600' }), 600_000);
});

test('no list id, project name or label is written in the heartbeat\'s code: every one comes from the config', () => {
  const config = JSON.parse(readFileSync(join(REPO, 'spirality.project.json'), 'utf8'));
  const literals = ['projectSlug', 'launchdPrefix', 'busProject', 'githubRepo', 'dopplerProject', 'loopQueueListId', 'spaceId', 'workspaceId', 'trackerPrefix', 'trackerUrl']
    .map((k) => config[k])
    .filter((v) => typeof v === 'string' && v.length >= 3);
  assert.ok(literals.includes(config.projectSlug), 'the test reads the real config');
  for (const file of ['lib/heartbeat.js', 'scripts/heartbeat.mjs', 'scripts/lib/relay_heartbeat.sh']) {
    const code = readFileSync(join(REPO, file), 'utf8');
    for (const v of literals) {
      assert.ok(!code.includes(v), `${file} names ${JSON.stringify(v)} from spirality.project.json; it must come from the project config`);
    }
    assert.doesNotMatch(code, /~\/loop-logs|com\.(spirality|starcaster)\b/i, `${file} names a log folder or label of its own`);
  }
});

test('a lane the project config names in projectLanes gets the same paused/running answer as pause-check (SP-400)', () => {
  const { settingsPauseVerdict } = createRequire(import.meta.url)('../lib/pipelinePause.js');
  const opts = { projectLanes: ['loop-handoff'] };
  const asControls = (text) => text.split('\n').map((l) => ({ key: l.slice(0, l.indexOf('=')), value: l.slice(l.indexOf('=') + 1) }));
  for (const text of [SETTINGS, SETTINGS.replace('paused=off', 'paused=on')]) {
    const set = laneSettings({ ok: true, text }, 'loop-handoff', opts);
    const check = settingsPauseVerdict({ ok: true, controls: asControls(text), changes: [] }, 'loop-handoff', opts);
    assert.equal(set.paused, check.paused, text);
    assert.equal(set.pausedWhy, check.paused ? check.line : null);
  }
  assert.equal(laneSettings({ ok: true, text: SETTINGS }, 'loop-handoff', opts).paused, false, 'the whole pipeline is not paused: it runs');
  assert.equal(laneSettings({ ok: true, text: SETTINGS }, 'loop-handoff').paused, true, 'not named in projectLanes: still fails safe');
  assert.equal(laneSettings({ ok: false, why: 'down' }, 'loop-handoff', opts).paused, true, 'an unreadable page still pauses it');
});
