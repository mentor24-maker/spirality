/**
 * The kept-alive lanes the installer puts on the Mini (SKILLS in
 * scripts/install_loop_runner.sh), checked against what each lane needs to
 * run: a skill for `claude -p /<lane>` to find, and a tracker sign-in seat
 * under the name loop_runner.sh derives from the lane (loop-intake ->
 * TRACKER_TOKEN_LOOP_INTAKE), or the door refuses every pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRACKER_SEATS } from './expectedSecrets.mjs';
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
  for (const lane of lanes()) assert.match(installer, new RegExp(`^\\s+${lane}\\)\\s+echo \\d+ ;;$`, 'm'), `${lane}: no interval_of entry`);
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
      ...spirality, productSlug: 'normie', launchdPrefix: 'com.normie', logDir,
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
