// A project's own pause switch and lane environment in the runner (SP-395):
// the manifest's `lanePauseCommand` and `laneEnv`, against copies of the real
// scripts/loop_runner.sh, scripts/lib/laneSettings.mjs and the real config
// reader in a scratch folder, with a stand-in `claude`, a stand-in Settings
// page pause check that always says "running", and a stand-in pause command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scratchGitEnv } = require('../../lib/scratchGit.js');

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(SCRIPTS, '..');

function executable(file, text) {
  writeFileSync(file, text);
  chmodSync(file, 0o755);
}

/** A manifest the real reader accepts, plus `extra`. */
const manifest = (extra = {}) => ({
  manifestVersion: 2,
  workspaceId: '111',
  spaceId: '222',
  loopQueueListId: '333',
  operatorUserId: '444',
  machineUserId: '555',
  githubRepo: 'owner/repo',
  dopplerProject: 'proj',
  dopplerConfig: 'dev',
  launchdPrefix: 'com.example',
  logDir: '/nowhere',
  mergePhrases: ['merge'],
  governancePaths: ['CLAUDE.md'],
  autoMergeLanes: [],
  operatorName: 'Dana',
  projectSlug: 'proj',
  legacyMachinePrefixes: [],
  projectScripts: {},
  ...extra,
});

/**
 * A scratch checkout: the runner and what it sources, the real lane settings
 * script and config reader (unless `settings: false`, the runner as it was
 * before SP-395), a manifest holding `extra`, a stand-in `pause` program that
 * notes its folder and EXAMPLE_CALLER and exits PAUSE_EXIT, and a stand-in
 * claude that notes every call and the EXAMPLE_CALLER it was given.
 */
function scratch({ extra = {}, pauseExit = 0, pauseText = 'held by the project', settings = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'project-pause-'));
  const repo = join(dir, 'repo');
  const logs = join(dir, 'logs');
  mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(repo, 'lib'), { recursive: true });
  mkdirSync(join(dir, 'bin'));
  for (const f of ['loop_runner.sh', 'run_with_time_limit.sh']) copyFileSync(join(SCRIPTS, f), join(repo, 'scripts', f));
  for (const f of ['back_to_main.sh', 'tracker_restart.sh']) copyFileSync(join(SCRIPTS, 'lib', f), join(repo, 'scripts', 'lib', f));
  if (settings) {
    copyFileSync(join(SCRIPTS, 'lib', 'laneSettings.mjs'), join(repo, 'scripts', 'lib', 'laneSettings.mjs'));
    copyFileSync(join(ROOT, 'lib', 'projectConfig.mjs'), join(repo, 'lib', 'projectConfig.mjs'));
  }
  writeFileSync(join(repo, 'spirality.project.json'), JSON.stringify(manifest(extra), null, 2));
  writeFileSync(join(repo, 'scripts', 'project_config.mjs'),
    `const v = { projectSlug: 'proj', logDir: ${JSON.stringify(logs)}, launchdPrefix: 'com.example', trackerPort: '' };\n`
    + 'console.log(v[process.argv[2]] ?? "");\n');
  executable(join(repo, 'scripts', 'pause_check.sh'), '#!/bin/bash\necho "running"\nexit 0\n');
  executable(join(dir, 'bin', 'pause'),
    `#!/bin/bash\necho "$(pwd -P) caller=\${EXAMPLE_CALLER:-} args=$*" >> ${JSON.stringify(join(dir, 'pause-asked'))}\n`
    + `${pauseText ? `echo ${JSON.stringify(pauseText)}\n` : ''}exit ${pauseExit}\n`);
  executable(join(dir, 'bin', 'claude'),
    `#!/bin/bash\necho "$* caller=\${EXAMPLE_CALLER:-}" >> ${JSON.stringify(join(dir, 'claude-called'))}\necho "pass report"\n`);
  const env = {
    ...scratchGitEnv(),
    GIT_CEILING_DIRECTORIES: dir,
    CLAUDE_BIN: join(dir, 'bin', 'claude'),
    DOPPLER_BIN: join(dir, 'bin', 'no-doppler'),
    LOOP_WAKE_POLL_SECONDS: '1',
    RUN_WITH_TIME_LIMIT_POLL: '1',
  };
  return { dir, repo, logs, env, pause: join(dir, 'bin', 'pause'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Runs loop_runner.sh until its log matches `until` (its first "sleeping" line), then stops it; answers the lane's log. */
async function oneWake(s, skill = 'loop-build', until = /sleeping 3600s before the next/) {
  const child = spawn('bash', [join(s.repo, 'scripts', 'loop_runner.sh'), skill, '3600'], { cwd: s.repo, env: s.env, detached: true, stdio: 'ignore' });
  const log = join(s.logs, `proj-${skill}.log`);
  const deadline = Date.now() + 20_000;
  try {
    while (Date.now() < deadline) {
      if (existsSync(log) && until.test(readFileSync(log, 'utf8'))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  return existsSync(log) ? readFileSync(log, 'utf8') : '';
}

const read = (s, f) => (existsSync(join(s.dir, f)) ? readFileSync(join(s.dir, f), 'utf8') : '');
const PAUSED_LINE = /^===== \d{4}-\d\d-\d\d \d\d:\d\d:\d\d PAUSED \/loop-build =====$/m;

test('a project pause command that exits 3: a dated PAUSED line, the line it printed, and Claude never started', async () => {
  const s = scratch({ pauseExit: 3, pauseText: 'paused: the pipeline switch is off' });
  writeFileSync(join(s.repo, 'spirality.project.json'), JSON.stringify(manifest({ lanePauseCommand: [s.pause, 'check'] })));
  try {
    mkdirSync(s.logs, { recursive: true });
    writeFileSync(join(s.logs, 'proj-loop-build.wake'), '');
    const log = await oneWake(s);
    assert.match(log, PAUSED_LINE, 'the heartbeat reads it as the runner alive (SP-266)');
    assert.match(log, /\[loop-runner\] \d\d:\d\d:\d\d the project's pause command \(.*\/bin\/pause check\) exited 3, so \/loop-build is PAUSED and not starting — it said: paused: the pipeline switch is off/);
    assert.match(log, /sleeping 3600s before the next \/loop-build/);
    assert.doesNotMatch(log, /START \/loop-build/);
    assert.equal(read(s, 'claude-called'), '', 'claude was never started');
    assert.match(read(s, 'pause-asked'), new RegExp(`^${realpathSync(s.repo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} caller= args=check$`, 'm'), 'run in the project\'s checkout with its arguments');
    assert.equal(existsSync(join(s.logs, 'proj-loop-build.wake')), false, 'a wake sent while paused is answered, not kept');
  } finally {
    s.cleanup();
  }
});

test('a project pause command that does not exist counts as paused (it fails safe)', async () => {
  const s = scratch({ extra: { lanePauseCommand: ['/no/such/pause-program', 'check'] } });
  try {
    const log = await oneWake(s);
    assert.match(log, PAUSED_LINE);
    assert.match(log, /the project's pause command \(\/no\/such\/pause-program check\) could not be started \(exit 127.*\), so \/loop-build is treated as PAUSED and not starting \(it fails safe\)/);
    assert.equal(read(s, 'claude-called'), '');
  } finally {
    s.cleanup();
  }
});

test('a project pause command that runs past its limit is stopped and counts as paused', async () => {
  const s = scratch({ extra: { lanePauseCommand: ['sleep', '30'] } });
  Object.assign(s.env, { LOOP_PAUSE_COMMAND_LIMIT_SECONDS: '1', RUN_WITH_TIME_LIMIT_GRACE: '1' });
  try {
    const log = await oneWake(s);
    assert.match(log, /the project's pause command \(sleep 30\) ran past 1s and was stopped, so \/loop-build is treated as PAUSED/);
    assert.match(log, PAUSED_LINE);
    assert.equal(read(s, 'claude-called'), '');
  } finally {
    s.cleanup();
  }
});

test('a project pause command that exits 0 lets the pass start, and laneEnv reaches both it and the pass', async () => {
  const s = scratch({ pauseExit: 0 });
  writeFileSync(join(s.repo, 'spirality.project.json'), JSON.stringify(manifest({
    lanePauseCommand: [s.pause, 'check'],
    laneEnv: { EXAMPLE_CALLER: 'scheduled' },
  })));
  try {
    const log = await oneWake(s);
    assert.match(log, /START \/loop-build/);
    assert.match(log, /END \/loop-build/);
    assert.doesNotMatch(log, /PAUSED \/loop-build/);
    assert.match(log, /\[loop-runner\] \d\d:\d\d:\d\d the project's laneEnv is set for every pass: EXAMPLE_CALLER$/m, 'names, never values');
    assert.match(read(s, 'claude-called'), /^-p \/loop-build .* caller=scheduled$/m, 'the pass is given the variable');
    assert.match(read(s, 'pause-asked'), /caller=scheduled args=check/, 'the pause command is given it too');
  } finally {
    s.cleanup();
  }
});

test('a manifest that cannot be read pauses the lane rather than letting the pass through', async () => {
  // Pass 1 runs, and its stand-in claude breaks the manifest and sends a wake,
  // so pass 2 asks the pause command of a config that no longer reads.
  const s = scratch({ extra: { lanePauseCommand: ['true'] } });
  const file = join(s.repo, 'spirality.project.json');
  executable(join(s.dir, 'bin', 'claude'),
    `#!/bin/bash\necho "$*" >> ${JSON.stringify(join(s.dir, 'claude-called'))}\n`
    + `echo '{ not json' > ${JSON.stringify(file)}\ntouch ${JSON.stringify(join(s.logs, 'proj-loop-build.wake'))}\necho "pass report"\n`);
  try {
    const log = await oneWake(s, 'loop-build', /PAUSED \/loop-build/);
    assert.match(log, /could not read the project's lanePauseCommand from its config \(exit 1; its errors are above\), so \/loop-build is treated as PAUSED and not starting \(it fails safe\)/);
    assert.match(log, PAUSED_LINE);
    assert.equal(read(s, 'claude-called').trim().split('\n').length, 1, 'only the first pass ran');
  } finally {
    s.cleanup();
  }
});

test('a manifest whose laneEnv cannot be read stops the runner before any pass', () => {
  const s = scratch();
  writeFileSync(join(s.repo, 'spirality.project.json'), '{ not json');
  try {
    const r = spawnSync('bash', [join(s.repo, 'scripts', 'loop_runner.sh'), 'loop-build', '3600'], { cwd: s.repo, env: s.env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /could not read laneEnv from the project config .* Stopping\./);
    assert.equal(read(s, 'claude-called'), '');
    assert.equal(existsSync(join(s.logs, 'proj-loop-build.lock')), false, 'the lock is let go');
  } finally {
    s.cleanup();
  }
});

/** A log with its clock times and scratch paths taken out, to compare two runs. */
const steady = (log, s) => log
  .replaceAll(s.dir, '<dir>')
  .replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/g, '<date>')
  .replace(/\d\d:\d\d:\d\d/g, '<time>');

test('with neither field set the log is exactly what the runner wrote before SP-395', async () => {
  const before = scratch({ settings: false });
  const now = scratch();
  try {
    const was = steady(await oneWake(before), before);
    const is = steady(await oneWake(now), now);
    assert.match(is, /START \/loop-build/);
    assert.equal(is, was);
    assert.equal(read(now, 'pause-asked'), '');
  } finally {
    before.cleanup();
    now.cleanup();
  }
});

test('laneSettings.mjs prints each item NUL-ended, nothing when unset, and exits 1 on a broken manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lane-settings-'));
  const run = (what) => spawnSync('node', [join(SCRIPTS, 'lib', 'laneSettings.mjs'), what], { cwd: dir, env: { ...process.env, SPIRALITY_PROJECT: dir }, encoding: 'utf8' });
  try {
    writeFileSync(join(dir, 'spirality.project.json'), JSON.stringify(manifest()));
    assert.equal(run('pause-command').stdout, '');
    assert.equal(run('env').stdout, '');
    writeFileSync(join(dir, 'spirality.project.json'), JSON.stringify(manifest({
      lanePauseCommand: ['npm', 'run', 'pipeline', '--', 'check'],
      laneEnv: { EXAMPLE_CALLER: 'scheduled', EXAMPLE_MODE: 'a b' },
    })));
    assert.equal(run('pause-command').stdout, 'npm\0run\0pipeline\0--\0check\0');
    assert.equal(run('env').stdout, 'EXAMPLE_CALLER=scheduled\0EXAMPLE_MODE=a b\0');
    writeFileSync(join(dir, 'spirality.project.json'), '{ not json');
    const broken = run('env');
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /the project config is not usable/);
    assert.equal(run('nonsense').status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the runner names no project: no project command, variable or name is written into it (CLAUDE.md rule 2)', () => {
  const runner = readFileSync(join(SCRIPTS, 'loop_runner.sh'), 'utf8');
  assert.doesNotMatch(runner, /STARCASTER|starcaster|pipeline -- check|WaveCenter|wavecenter/);
  assert.ok(runner.indexOf('project_pause_check; then') < runner.indexOf('scripts/pause_check.sh" "$SKILL"'), 'the project\'s switch is asked just before the Settings page\'s');
  assert.ok(runner.indexOf('git pull -q --ff-only origin main') < runner.indexOf('project_pause_check; then'), 'and after the pull');
  assert.ok(runner.indexOf('node "$LANE_SETTINGS" env') < runner.indexOf('while true; do'), 'laneEnv is exported before the loop starts');
});
