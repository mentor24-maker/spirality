// Who holds a lane's lock (SP-407). On 2026-11-26 the Mini froze and
// restarted, and four lanes refused every start for hours: their locks named
// pids that, after the boot, belonged to remindd, AirPlayUIAgent and another
// lane's runner, and the runner only asked whether the pid was alive. These
// tests run the runner's own lock functions, and the runner itself, against
// real processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import scratchGit from '../lib/scratchGit.js';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const RUNNER = readFileSync(join(REPO, 'scripts/loop_runner.sh'), 'utf8');

/** The runner's lock functions, cut from the file itself so the test runs the shipped code. */
function lockFunctions() {
  const start = RUNNER.indexOf('current_boot() {');
  const end = RUNNER.indexOf('# One runner per skill.');
  assert.ok(start > 0 && end > start, 'the lock functions are not where the test expects them in loop_runner.sh');
  return RUNNER.slice(start, end);
}

/** Run `script` in bash with the lock functions loaded; returns { status, out }. */
function withLockFunctions(script, env = {}) {
  const r = spawnSync('bash', ['-c', `${lockFunctions()}\n${script}`], {
    encoding: 'utf8', env: { ...process.env, ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`.trim() };
}

/** A live process whose command line is `bash <dir>/<name> <args...>`, sleeping until killed. */
function liveScript(dir, name, args = []) {
  const file = join(dir, name);
  writeFileSync(file, '#!/bin/bash\nsleep 300\n', { mode: 0o755 });
  const child = spawn('bash', [file, ...args], { stdio: 'ignore', detached: true });
  return child;
}

/** Wait until `ps` can name the process (a fresh spawn may not have exec'd yet). */
async function untilCommand(pid, want) {
  for (let i = 0; i < 100; i++) {
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    if (r.stdout.includes(want)) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  assert.fail(`process ${pid} never showed ${want}`);
}

function writeLock(lock, files) {
  mkdirSync(lock, { recursive: true });
  for (const [name, value] of Object.entries(files)) writeFileSync(join(lock, name), `${value}\n`);
}

const check = (lock, ...patterns) => `if lock_holder_live "${lock}" ${patterns.map((p) => `"${p}"`).join(' ')}; then echo "LIVE $LOCK_HOLDER_PID"; else echo "STALE: $LOCK_STALE_WHY"; fi`;
const LANE = '*loop_runner.sh loop-build *';

test('a lock whose live pid is some other program is stale (the 2026-11-26 restart)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp407-'));
  const other = liveScript(dir, 'remindd');
  try {
    await untilCommand(other.pid, 'remindd');
    const lock = join(dir, 'x-loop-build.lock');
    writeLock(lock, { pid: other.pid }); // written before boot and start time were recorded
    const { out } = withLockFunctions(check(lock, LANE));
    assert.match(out, /^STALE: pid \d+ is .*remindd.*, not this lane's runner$/);
  } finally {
    other.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock held by another lane's runner of the same project is stale for this lane", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp407-'));
  const review = liveScript(dir, 'loop_runner.sh', ['loop-review', '1800']);
  try {
    await untilCommand(review.pid, 'loop-review');
    const lock = join(dir, 'x-loop-build.lock');
    writeLock(lock, { pid: review.pid });
    assert.match(withLockFunctions(check(lock, LANE)).out, /^STALE: .*loop_runner\.sh loop-review.*not this lane's runner$/);
  } finally {
    review.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock held by this lane's real runner still refuses, with or without the new records", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp407-'));
  const runner = liveScript(dir, 'loop_runner.sh', ['loop-build', '1800']);
  try {
    await untilCommand(runner.pid, 'loop-build');
    const lock = join(dir, 'x-loop-build.lock');
    writeLock(lock, { pid: runner.pid });
    assert.equal(withLockFunctions(check(lock, LANE)).out, `LIVE ${runner.pid}`, 'an older lock naming the lane runner');
    // The lane's runner launched with no interval still matches.
    const bare = liveScript(dir, 'loop_runner.sh', ['loop-build']);
    try {
      await untilCommand(bare.pid, 'loop-build');
      writeLock(lock, { pid: bare.pid });
      assert.equal(withLockFunctions(check(lock, LANE)).out, `LIVE ${bare.pid}`);
    } finally {
      bare.kill('SIGKILL');
    }
  } finally {
    runner.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claim_lock records the pid, the boot and the start time, and a lock from an earlier boot is stale', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp407-'));
  try {
    const lock = join(dir, 'x-loop-build.lock');
    mkdirSync(lock);
    // The claiming shell checks its own lock while alive: the very process that wrote it.
    const same = withLockFunctions(`claim_lock "${lock}"; ${check(lock, LANE)}; cat "${lock}/boot"`, { LOOP_RUNNER_BOOT_ID: 'boot-A' });
    assert.match(same.out, /^LIVE \d+\nboot-A$/, 'its own claim, though its command line is not a runner: the start time proves it');
    assert.match(readFileSync(join(lock, 'started'), 'utf8'), /\d{4}/, 'the start time is recorded');

    // A lock recorded in boot A, read after a restart (boot B): stale even though the pid is alive.
    const later = withLockFunctions(`claim_lock "${lock}"; LOOP_RUNNER_BOOT_ID=boot-B; ${check(lock, LANE)}`, { LOOP_RUNNER_BOOT_ID: 'boot-A' });
    assert.match(later.out, /^STALE: pid \d+, written before the machine last started \(boot boot-A, now boot-B\)$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real boot is read from the machine, never empty on a Mac or Linux', () => {
  const { out } = withLockFunctions('current_boot', { LOOP_RUNNER_BOOT_ID: '' });
  assert.ok(out.length > 0, 'no boot could be read');
  if (process.platform === 'darwin') assert.match(out, /^\d+$/, 'the boot time in seconds, not the microseconds beside it');
});

test('a live pid whose start time differs from the recorded one is a different process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp407-'));
  const runner = liveScript(dir, 'loop_runner.sh', ['loop-build', '1800']);
  try {
    await untilCommand(runner.pid, 'loop-build');
    const lock = join(dir, 'x-loop-build.lock');
    writeLock(lock, { pid: runner.pid, started: 'Mon Jan  1 00:00:00 2024' });
    assert.match(withLockFunctions(check(lock, LANE)).out, /^STALE: pid \d+ is now a different process, started .*, not the holder started Mon Jan {2}1 00:00:00 2024$/,
      'pid reuse is caught even by a process that looks like the runner');
  } finally {
    runner.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a dead pid, and no pid at all, are stale as before', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp407-'));
  try {
    const lock = join(dir, 'x-loop-build.lock');
    writeLock(lock, { pid: 999999 });
    assert.equal(withLockFunctions(check(lock, LANE)).out, 'STALE: pid 999999, no such process');
    rmSync(join(lock, 'pid'));
    assert.equal(withLockFunctions(check(lock, LANE)).out, 'STALE: no pid recorded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the shared sync lock counts any lane runner or the relay, and nothing else', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp407-'));
  const relay = liveScript(dir, 'run_relay.sh');
  const review = liveScript(dir, 'loop_runner.sh', ['loop-review', '1800']);
  const other = liveScript(dir, 'AirPlayUIAgent');
  try {
    await untilCommand(relay.pid, 'run_relay.sh');
    await untilCommand(review.pid, 'loop-review');
    await untilCommand(other.pid, 'AirPlayUIAgent');
    const sync = join(dir, 'x-sync.lock');
    const patterns = ['*loop_runner.sh *', '*run_relay.sh*'];
    for (const [pid, want] of [[relay.pid, /^LIVE/], [review.pid, /^LIVE/], [other.pid, /^STALE: .*AirPlayUIAgent/]]) {
      writeLock(sync, { pid });
      assert.match(withLockFunctions(check(sync, ...patterns)).out, want);
    }
    // The runner takes it through the same check, and the stale one is cleared and logged.
    assert.match(RUNNER, /lock_holder_live "\$SYNC_LOCK" "\*loop_runner\.sh \*" "\*run_relay\.sh\*"/);
    assert.match(RUNNER, /claim_lock "\$SYNC_LOCK"/);
  } finally {
    for (const c of [relay, review, other]) c.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A scratch copy of the runner under its own project settings, as loopLanes.test.mjs builds. */
function scratchRunner() {
  const scratch = mkdtempSync(join(tmpdir(), 'sp407-runner-'));
  const logDir = mkdtempSync(join(tmpdir(), 'sp407-runner-logs-'));
  mkdirSync(join(scratch, 'scripts'));
  copyFileSync(join(REPO, 'scripts/loop_runner.sh'), join(scratch, 'scripts/loop_runner.sh'));
  writeFileSync(join(scratch, 'scripts/pause_check.sh'), '#!/bin/bash\necho "running"\n', { mode: 0o755 });
  for (const f of ['project_config.mjs', 'run_with_time_limit.sh']) symlinkSync(join(REPO, 'scripts', f), join(scratch, 'scripts', f));
  const spirality = JSON.parse(readFileSync(join(REPO, 'spirality.project.json'), 'utf8'));
  writeFileSync(join(scratch, 'spirality.project.json'), JSON.stringify({
    ...spirality, projectSlug: 'normie', launchdPrefix: 'com.normie', logDir,
  }));
  const fakeClaude = join(scratch, 'fake-claude');
  writeFileSync(fakeClaude, '#!/bin/bash\necho "Please run /login"\n', { mode: 0o755 });
  const git = (...args) => scratchGit.git(scratch, ...args);
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'scratch');
  const env = { ...scratchGit.scratchGitEnv(), CLAUDE_BIN: fakeClaude, DOPPLER_BIN: join(scratch, 'no-doppler'), RUN_WITH_TIME_LIMIT_POLL: '1' };
  return { scratch, logDir, env, done: () => { rmSync(scratch, { recursive: true, force: true }); rmSync(logDir, { recursive: true, force: true }); } };
}

test('the runner takes over a lock an unrelated program holds, and refuses one its lane runner holds', { timeout: 30_000 }, async () => {
  const s = scratchRunner();
  const other = liveScript(s.scratch, 'remindd');
  const lane = liveScript(s.scratch, 'loop_runner.sh', ['loop-build', '1800']);
  try {
    await untilCommand(other.pid, 'remindd');
    await untilCommand(lane.pid, 'loop-build');
    const lock = join(s.logDir, 'normie-loop-build.lock');

    // The lane's own runner holds it: the second one refuses, and the lock is untouched.
    writeLock(lock, { pid: lane.pid });
    const refused = spawnSync('bash', [join(s.scratch, 'scripts/loop_runner.sh'), 'loop-build', '3600'], { cwd: s.scratch, env: s.env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, new RegExp(`loop-build is already running \\(pid ${lane.pid}, `));
    assert.equal(readFileSync(join(lock, 'pid'), 'utf8').trim(), String(lane.pid));

    // remindd holds it (the restart): the runner announces the stale lock and takes it.
    writeLock(lock, { pid: other.pid });
    const runner = spawn('bash', [join(s.scratch, 'scripts/loop_runner.sh'), 'loop-build', '3600'], { cwd: s.scratch, env: s.env, detached: true, stdio: 'ignore' });
    const log = join(s.logDir, 'normie-loop-build.log');
    try {
      for (let i = 0; ; i++) {
        const held = existsSync(join(lock, 'started')) && readFileSync(join(lock, 'pid'), 'utf8').trim() === String(runner.pid);
        if (held && existsSync(log) && /STALE lock/.test(readFileSync(log, 'utf8'))) break;
        assert.ok(i < 200, 'the runner never took over the lock remindd held');
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      process.kill(-runner.pid, 'SIGKILL');
    }
    assert.match(readFileSync(log, 'utf8'), new RegExp(`found a STALE lock \\(pid ${other.pid} is .*remindd.*, not this lane's runner\\) — clearing it and taking over\\.`));
    assert.ok(readFileSync(join(lock, 'boot'), 'utf8').trim().length > 0, 'the new lock records its boot');
  } finally {
    other.kill('SIGKILL');
    lane.kill('SIGKILL');
    s.done();
  }
});
