/**
 * The kept-alive lanes the installer puts on the Mini (SKILLS in
 * scripts/install_loop_runner.sh), checked against what each lane needs to
 * run: a skill for `claude -p /<lane>` to find, and a tracker sign-in seat
 * under the name loop_runner.sh derives from the lane (loop-intake ->
 * TRACKER_TOKEN_LOOP_INTAKE), or the door refuses every pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRACKER_SEATS } from './expectedSecrets.mjs';
import { INTERVALS } from './loopSchedule.mjs';
import scratchGit from '../../lib/scratchGit.js';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const installer = readFileSync(join(REPO, 'scripts/install_loop_runner.sh'), 'utf8');

function lanes() {
  const m = installer.match(/^SKILLS=\(([^)]*)\)$/m);
  assert.ok(m, 'install_loop_runner.sh has no SKILLS=(...) line');
  return m[1].trim().split(/\s+/);
}

/** The secret name loop_runner.sh exports as TRACKER_TOKEN_NAME for a lane. */
const seatSecretFor = (lane) => `TRACKER_TOKEN_${lane.toUpperCase().replace(/-/g, '_')}`;

test('the installer keeps three lanes alive (build, review, intake) beside the relay: four loop jobs', () => {
  assert.deepEqual(lanes(), ['loop-build', 'loop-review', 'loop-intake']);
  assert.match(installer, /^RELAY=relay$/m);
});

test('every lane has a skill and its own machine sign-in seat', () => {
  for (const lane of lanes()) {
    assert.ok(existsSync(join(REPO, '.claude/skills', lane, 'SKILL.md')), `${lane}: no .claude/skills/${lane}/SKILL.md`);
    const seat = TRACKER_SEATS.find((s) => s.secret === seatSecretFor(lane));
    assert.ok(seat, `${lane}: no seat ${seatSecretFor(lane)} in TRACKER_SEATS`);
    assert.equal(seat.kind, 'machine');
    assert.equal(seat.name, lane);
  }
});

test('every lane has its own interval, and labels come from the project config, never typed in', () => {
  // The numbers live in scripts/lib/loopSchedule.mjs, shared with the tracker's Pipeline Status pod (SP-168).
  assert.match(installer, /^interval_of\(\) \{ PATH="\$LAUNCHD_PATH" node "\$REPO\/scripts\/lib\/loopSchedule\.mjs" interval "\$1"; \}$/m);
  for (const job of [...lanes(), 'relay']) assert.ok(Object.hasOwn(INTERVALS, job), `${job}: no interval in scripts/lib/loopSchedule.mjs`);
  assert.match(installer, /^PREFIX="\$\(config_value launchdPrefix\)"$/m);
  assert.doesNotMatch(installer, /com\.spirality/);
});

// The runner itself, run in a scratch copy of the repository (a git checkout
// on a clean main, so it takes the sync lock) whose settings file names
// another project. Spirality's sync lock is held by a live process: a runner
// that still used it would wait ten minutes. The other project's own sync
// lock is left stale, so taking it clears it. Claude is a stand-in that lists
// the log folder mid-pass (the lane's lock is seen held) and then reports a
// sign-in failure (the runner prints its restart line). The runner sleeps
// after one pass, and is stopped there.
test('loop_runner.sh names its log, lock, sync lock and restart label from the settings file', { timeout: 30_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'runner-names-'));
  const logDir = mkdtempSync(join(tmpdir(), 'runner-names-logs-'));
  try {
    mkdirSync(join(scratch, 'scripts'));
    copyFileSync(join(REPO, 'scripts/loop_runner.sh'), join(scratch, 'scripts/loop_runner.sh'));
    // A link, so project_config.mjs still finds lib/ beside the real file.
    for (const f of ['project_config.mjs', 'run_with_time_limit.sh']) symlinkSync(join(REPO, 'scripts', f), join(scratch, 'scripts', f));
    const spirality = JSON.parse(readFileSync(join(REPO, 'spirality.project.json'), 'utf8'));
    writeFileSync(join(scratch, 'spirality.project.json'), JSON.stringify({
      ...spirality, projectSlug: 'normie', launchdPrefix: 'com.normie', logDir,
    }));
    const fakeClaude = join(scratch, 'fake-claude');
    writeFileSync(fakeClaude, `#!/bin/bash\nls "${logDir}"\necho "Please run /login"\n`, { mode: 0o755 });
    const git = (...args) => scratchGit.git(scratch, ...args);
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'scratch');
    mkdirSync(join(logDir, 'spirality-sync.lock'));
    writeFileSync(join(logDir, 'spirality-sync.lock/pid'), String(process.pid));
    mkdirSync(join(logDir, 'normie-sync.lock'));
    writeFileSync(join(logDir, 'normie-sync.lock/pid'), '999999');

    const runner = spawn('bash', [join(scratch, 'scripts/loop_runner.sh'), 'loop-build', '3600'], {
      // The runner pulls main with git: never into a repository a commit hook named (SP-104).
      cwd: scratch, detached: true, stdio: 'ignore', env: { ...scratchGit.scratchGitEnv(), CLAUDE_BIN: fakeClaude, RUN_WITH_TIME_LIMIT_POLL: '1' },
    });
    const log = join(logDir, 'normie-loop-build.log');
    try {
      for (let i = 0; !(existsSync(log) && readFileSync(log, 'utf8').includes('sleeping 3600s')); i++) {
        assert.ok(i < 200, 'the runner never finished its first pass');
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      process.kill(-runner.pid, 'SIGKILL');
    }

    const text = readFileSync(log, 'utf8');
    assert.match(text, /START \/loop-build/);
    assert.match(text, /^normie-loop-build\.lock$/m, 'the lane did not hold normie-loop-build.lock during its pass');
    assert.match(text, /launchctl kickstart -k gui\/\d+\/com\.normie\.loop-build$/m);
    assert.ok(!existsSync(join(logDir, 'normie-sync.lock')), 'the runner never took (and cleared) normie-sync.lock');
    assert.deepEqual(readdirSync(logDir).filter((f) => !f.startsWith('normie-')), ['spirality-sync.lock']);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});

test('loop_runner.sh names no project of its own', () => {
  assert.doesNotMatch(readFileSync(join(REPO, 'scripts/loop_runner.sh'), 'utf8'), /spirality/);
});

// The wake (SP-219): the sleep between passes ends early on the lane's wake
// file, ends on time without one, and a wake sent during a pass neither stops
// nor doubles it. Each test runs the real runner in a scratch copy, as above,
// with the wake file looked for every second.
async function withRunner({ interval, claude }, body) {
  const scratch = mkdtempSync(join(tmpdir(), 'runner-wake-'));
  const logDir = mkdtempSync(join(tmpdir(), 'runner-wake-logs-'));
  let runner;
  try {
    mkdirSync(join(scratch, 'scripts/lib'), { recursive: true });
    copyFileSync(join(REPO, 'scripts/loop_runner.sh'), join(scratch, 'scripts/loop_runner.sh'));
    for (const f of ['project_config.mjs', 'run_with_time_limit.sh', 'lib/wakeLane.mjs']) symlinkSync(join(REPO, 'scripts', f), join(scratch, 'scripts', f));
    const spirality = JSON.parse(readFileSync(join(REPO, 'spirality.project.json'), 'utf8'));
    writeFileSync(join(scratch, 'spirality.project.json'), JSON.stringify({
      ...spirality, projectSlug: 'normie', launchdPrefix: 'com.normie', logDir,
    }));
    const wake = join(logDir, 'normie-loop-build.wake');
    const fakeClaude = join(scratch, 'fake-claude');
    writeFileSync(fakeClaude, `#!/bin/bash\n${claude({ wake, logDir })}\n`, { mode: 0o755 });
    const git = (...args) => scratchGit.git(scratch, ...args);
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'scratch');
    runner = spawn('bash', [join(scratch, 'scripts/loop_runner.sh'), 'loop-build', String(interval)], {
      cwd: scratch, detached: true, stdio: 'ignore',
      env: { ...scratchGit.scratchGitEnv(), CLAUDE_BIN: fakeClaude, RUN_WITH_TIME_LIMIT_POLL: '1', LOOP_WAKE_POLL_SECONDS: '1' },
    });
    const log = join(logDir, 'normie-loop-build.log');
    const read = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
    const count = (re) => (read().match(re) || []).length;
    const until = async (what, ok, seconds) => {
      for (let i = 0; !ok(); i++) {
        assert.ok(i < seconds * 10, `${what} (log so far:\n${read()})`);
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    await body({ scratch, logDir, wake, read, count, until });
  } finally {
    if (runner) try { process.kill(-runner.pid, 'SIGKILL'); } catch { /* already gone */ }
    rmSync(scratch, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
}

const STARTS = /START \/loop-build/g;
const WOKEN = /woken early after \d+s of \d+s/g;

test('a wake ends the runner\'s sleep: wakeLane.mjs starts the next pass within seconds, and the log says so', { timeout: 60_000 }, async () => {
  await withRunner({ interval: 3600, claude: () => 'echo pass' }, async ({ scratch, wake, read, count, until }) => {
    await until('the runner never finished its first pass', () => read().includes('sleeping 3600s'), 20);
    const sent = Date.now();
    const cli = spawnSync(process.execPath, [join(scratch, 'scripts/lib/wakeLane.mjs'), 'loop-build'], { cwd: scratch, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /^loop-build: woken — wake file .*normie-loop-build\.wake written; runner pid \d+/);
    await until('the wake did not start a second pass within 15 seconds', () => count(STARTS) === 2, 15);
    assert.ok(Date.now() - sent < 15_000);
    assert.equal(count(WOKEN), 1);
    assert.ok(!existsSync(wake), 'the wake file was not cleared as the pass started');
  });
});

test('with no wake, the sleep ends on time and the log says nothing of a wake', { timeout: 60_000 }, async () => {
  await withRunner({ interval: 2, claude: () => 'echo pass' }, async ({ read, count, until }) => {
    await until('the timer never started a second pass', () => count(STARTS) === 2, 30);
    assert.equal(count(WOKEN), 0);
    assert.match(read(), /sleeping 2s before the next \/loop-build/);
  });
});

test('wakes sent during a pass never stop or double it: exactly one more pass follows', { timeout: 60_000 }, async () => {
  // The first pass sends two wakes and keeps working; the second only reports.
  const claude = ({ wake, logDir }) => [
    `if [ ! -e "${logDir}/first-done" ]; then`,
    `  : > "${logDir}/first-done"; echo first-pass-begins; : > "${wake}"; sleep 1; : > "${wake}"; sleep 1; echo first-pass-ends`,
    'else echo second-pass; fi',
  ].join('\n');
  await withRunner({ interval: 3600, claude }, async ({ wake, read, count, until }) => {
    await until('the second pass never ran', () => count(/sleeping 3600s/g) === 2, 30);
    await new Promise((r) => setTimeout(r, 3000));
    const text = read();
    assert.equal(count(STARTS), 2, 'not exactly one more pass');
    assert.equal(count(WOKEN), 1);
    const order = text.match(/START \/loop-build|first-pass-begins|first-pass-ends|END \/loop-build|woken early|second-pass/g);
    assert.deepEqual(order, ['START /loop-build', 'first-pass-begins', 'first-pass-ends', 'END /loop-build', 'woken early', 'START /loop-build', 'second-pass', 'END /loop-build']);
    assert.match(text, /woken early after 0s of 3600s/);
    assert.ok(!existsSync(wake));
  });
});
