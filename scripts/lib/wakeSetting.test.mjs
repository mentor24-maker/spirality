/**
 * The wake time set on the Settings page, read by the jobs that wake on it
 * (SP-236): wakeSetting.mjs reads it through the door and never answers a
 * number a lane could spin or stop on, and run_relay.sh's one-minute tick
 * runs a pass only when the relay's wake time is up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWake, wakeFrom } from './wakeSetting.mjs';
import { INTERVALS, RELAY_TICK } from './loopSchedule.mjs';
import scratchGit from '../../lib/scratchGit.js';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SETTINGS = ['wake.loop-intake=1800', 'wake.loop-build=600', 'wake.loop-review=1800', 'wake.relay=300', 'paused=off', 'wip-cap=5'].join('\n');

test('wakeFrom reads the job\'s own line, and only a whole number from 60 to 86,400 seconds', () => {
  assert.deepEqual(wakeFrom(SETTINGS, 'loop-build'), { seconds: 600 });
  assert.deepEqual(wakeFrom(SETTINGS, 'relay'), { seconds: 300 });
  for (const bad of ['0', '59', '86401', '', '-60', '600.5', ' 600x', 'soon']) {
    const { seconds, problem } = wakeFrom(`wake.loop-build=${bad}`, 'loop-build');
    assert.equal(seconds, undefined, bad);
    assert.match(problem, /not a whole number from 60 to 86400 seconds/, bad);
  }
  assert.match(wakeFrom('paused=off', 'loop-build').problem, /have no wake\.loop-build line/);
  assert.match(wakeFrom('wake.loop-build-extra=900', 'loop-build').problem, /have no wake\.loop-build line/);
});

test('readWake answers the number, or one line saying why the door could not give one', () => {
  const ok = (stdout) => () => ({ status: 0, stdout, stderr: 'settings: 9 pipeline control(s)\n', error: null });
  assert.deepEqual(readWake('loop-build', { read: ok(SETTINGS) }), { code: 0, line: '600' });
  assert.deepEqual(readWake('loop-build', { read: ok('wake.loop-build=0\n') }), { code: 1, line: 'the tracker answered wake.loop-build=0, not a whole number from 60 to 86400 seconds' });
  assert.deepEqual(
    readWake('loop-build', { read: () => ({ status: 1, stdout: '', stderr: 'read the pipeline controls FAILED — fetch failed (ECONNREFUSED)\n  tracker: 1 request(s)\n', error: null }) }),
    { code: 1, line: 'the settings read failed (exit 1: tracker: 1 request(s))' },
  );
  assert.deepEqual(readWake('loop-build', { read: () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) }) }), { code: 1, line: 'the settings read took longer than 60s and was stopped' });
  assert.deepEqual(readWake('loop-build', { read: () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('no npm'), { code: 'ENOENT' }) }) }), { code: 1, line: 'the settings read could not run (ENOENT)' });
  assert.equal(readWake('loop-bild', { read: () => assert.fail('read for a job it does not know') }).code, 2);
});

test('wakeSetting.mjs names no project of its own', () => {
  assert.doesNotMatch(readFileSync(join(REPO, 'scripts/lib/wakeSetting.mjs'), 'utf8'), /spirality/i);
});

// run_relay.sh's tick, run for real in a scratch copy of the repository whose
// settings file names another project. The pass itself is a stand-in
// (`npm run clickup` is a package.json script that echoes), so nothing here
// reaches a tracker; so is the wake time read (a stand-in wakeSetting.mjs
// that answers from a file).
function relayScratch() {
  const scratch = mkdtempSync(join(tmpdir(), 'relay-tick-'));
  const logDir = mkdtempSync(join(tmpdir(), 'relay-tick-logs-'));
  mkdirSync(join(scratch, 'scripts/lib'), { recursive: true });
  copyFileSync(join(REPO, 'scripts/run_relay.sh'), join(scratch, 'scripts/run_relay.sh'));
  for (const f of ['project_config.mjs', 'run_with_time_limit.sh', 'lib/loopSchedule.mjs', 'lib/back_to_main.sh', 'lib/tracker_restart.sh']) {
    symlinkSync(join(REPO, 'scripts', f), join(scratch, 'scripts', f));
  }
  const answer = join(logDir, 'wake-answer');
  writeFileSync(join(scratch, 'scripts/lib/wakeSetting.mjs'), [
    "import { readFileSync } from 'node:fs';",
    `const [code, line] = readFileSync(${JSON.stringify(answer)}, 'utf8').trim().split(' ');`,
    "if (process.argv[2] !== 'relay') { console.log(`asked for ${process.argv[2]}`); process.exit(1); }",
    'console.log(line ?? ""); process.exit(Number(code));',
  ].join('\n'));
  const spirality = JSON.parse(readFileSync(join(REPO, 'spirality.project.json'), 'utf8'));
  writeFileSync(join(scratch, 'spirality.project.json'), JSON.stringify({
    ...spirality, projectSlug: 'normie', launchdPrefix: 'com.normie', logDir,
  }));
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'scratch', private: true, scripts: { clickup: 'echo stand-in-relay-pass' } }));
  const git = (...args) => scratchGit.git(scratch, ...args);
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'scratch');
  const file = (name) => join(logDir, `normie-relay.${name}`);
  const run = (...args) => spawnSync('bash', [join(scratch, 'scripts/run_relay.sh'), ...args], {
    cwd: scratch, encoding: 'utf8', env: { ...scratchGit.scratchGitEnv(), RUN_WITH_TIME_LIMIT_POLL: '1' }, timeout: 60_000,
  });
  const answers = (text) => writeFileSync(answer, text);
  const cleanup = () => {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  };
  return { logDir, file, run, answers, cleanup };
}

const now = () => Math.floor(Date.now() / 1000);
const ran = (r) => /START relay/.test(r.stdout) && /stand-in-relay-pass/.test(r.stdout);

test('the relay\'s tick: a pass when its wake time is up or a wake was sent, nothing at all otherwise; the wake time it goes by is the one the tracker answered (SP-236)', { timeout: 120_000 }, () => {
  const s = relayScratch();
  try {
    s.answers('0 300');
    // Never started: due. It records its start, and after the pass the wake time it read.
    const first = s.run('--tick');
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.ok(ran(first), first.stdout);
    assert.ok(Math.abs(Number(readFileSync(s.file('last-start'), 'utf8')) - now()) <= 5);
    assert.equal(readFileSync(s.file('interval'), 'utf8').trim(), '300');

    // A minute later is not 300 seconds: the tick ends at once, writing nothing, taking no lock.
    const quiet = s.run('--tick');
    assert.equal(quiet.status, 0);
    assert.equal(quiet.stdout, '', 'a skipped tick wrote to the relay log');
    assert.equal(quiet.stderr, '');
    assert.ok(!existsSync(s.file('lock')));
    writeFileSync(s.file('last-start'), String(now() - 200));
    assert.equal(s.run('--tick').stdout, '', '200s after its start, with 300 set');

    // Within half a tick of 300: due (launchd's start is not to the second).
    writeFileSync(s.file('last-start'), String(now() - (300 - RELAY_TICK / 2)));
    assert.ok(ran(s.run('--tick')));

    // A wake (wakeLane.mjs) runs this tick, and the pass clears it.
    writeFileSync(s.file('wake'), 'now\n');
    const woken = s.run('--tick');
    assert.ok(ran(woken), woken.stdout);
    assert.ok(!existsSync(s.file('wake')));

    // A start time in the future or not a number is due, never a relay that stops.
    writeFileSync(s.file('last-start'), String(now() + 3600));
    assert.ok(ran(s.run('--tick')));
    writeFileSync(s.file('last-start'), 'garbage');
    assert.ok(ran(s.run('--tick')));
  } finally {
    s.cleanup();
  }
});

test('the relay keeps its last good wake time when the tracker cannot say, and says so in one line; a run by hand always runs and leaves the wake time alone (SP-236)', { timeout: 120_000 }, () => {
  const s = relayScratch();
  try {
    // No wake time kept yet: it goes by the default.
    writeFileSync(s.file('last-start'), String(now() - (INTERVALS.relay - 60)));
    assert.equal(s.run('--tick').stdout, '');
    writeFileSync(s.file('interval'), '300\n');
    writeFileSync(s.file('last-start'), String(now() - 400));
    for (const said of ['1 the settings read failed (exit 1)', '0 0', '0 soon']) {
      s.answers(said);
      writeFileSync(s.file('last-start'), String(now() - 400));
      const r = s.run('--tick');
      assert.ok(ran(r), r.stdout);
      assert.equal(readFileSync(s.file('interval'), 'utf8').trim(), '300', said);
      const lines = r.stdout.split('\n').filter((l) => /could not read the relay's wake time/.test(l));
      assert.equal(lines.length, 1, r.stdout);
      assert.match(lines[0], /keeping the last good value, 300s$/);
    }
    // By hand, just after a pass: it runs, and the wake time kept is untouched.
    s.answers('0 900');
    const hand = s.run();
    assert.ok(ran(hand), hand.stdout);
    assert.equal(readFileSync(s.file('interval'), 'utf8').trim(), '300');
    // A dry run writes nothing, its start time included.
    writeFileSync(s.file('last-start'), '12345');
    assert.ok(ran(s.run('--dry-run')));
    assert.equal(readFileSync(s.file('last-start'), 'utf8').trim(), '12345');
  } finally {
    s.cleanup();
  }
});
