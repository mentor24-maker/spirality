// The project's own heartbeat in the runner (SP-397): the manifest's
// `laneHeartbeatCommand`, against copies of the real scripts/loop_runner.sh,
// scripts/lib/laneSettings.mjs, the real config reader and the usage-limit
// guard scripts in a scratch folder, with a stand-in `claude`, a stand-in
// Settings page pause check, and a stand-in heartbeat that records each call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

/** Claude's own words when a window closes, with a reset an hour from now in Mountain time. */
function limitMessage(nowMs = Date.now()) {
  const at = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit', hour12: true })
    .format(new Date(nowMs + 60 * 60 * 1000)).replace(/\s?([AP])M$/, (_, x) => `${x.toLowerCase()}m`);
  return `You've hit your session limit · resets ${at} (America/Denver)`;
}

/**
 * A scratch checkout: the runner and what it sources, the real lane settings
 * script, config reader and usage-limit guard, a manifest naming the stand-in
 * heartbeat (unless `beat: false`), a stand-in project_config.mjs answering
 * `usageLimitSleep` with `sleep`, a Settings page pause check that exits
 * `pauseExit`, a stand-in claude that prints `say`, waits `claudeSleep`
 * seconds and exits `exit`, and the stand-in heartbeat, which notes its
 * folder, arguments and EXAMPLE_CALLER, then (by `beatMode`) exits 0, exits
 * 1 or hangs.
 */
function scratch({ beat = true, beatMode = 'ok', sleep = false, pauseExit = 0, say = 'pass report', exit = 0, claudeSleep = 0, workCheck = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lane-heartbeat-'));
  const repo = join(dir, 'repo');
  const logs = join(dir, 'logs');
  mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(repo, 'lib'), { recursive: true });
  mkdirSync(join(dir, 'bin'));
  mkdirSync(logs);
  for (const f of ['loop_runner.sh', 'run_with_time_limit.sh', 'loop_runner_delay.mjs', 'loop_policy.mjs']) copyFileSync(join(SCRIPTS, f), join(repo, 'scripts', f));
  for (const f of ['back_to_main.sh', 'tracker_restart.sh', 'laneFiles.mjs', 'laneSettings.mjs']) copyFileSync(join(SCRIPTS, 'lib', f), join(repo, 'scripts', 'lib', f));
  for (const f of ['loopRunnerGuard.js', 'loopPolicy.js', 'passClaim.js', 'pipelinePause.js', 'projectConfig.mjs', 'package.json']) copyFileSync(join(ROOT, 'lib', f), join(repo, 'lib', f));
  const beatProgram = join(dir, 'bin', 'beat.mjs');
  const beats = join(dir, 'beats');
  writeFileSync(beatProgram,
    "import { appendFileSync } from 'node:fs';\n"
    + `appendFileSync(${JSON.stringify(beats)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), caller: process.env.EXAMPLE_CALLER ?? '' }) + '\\n');\n`
    + "console.log('beat recorded');\n"
    + (beatMode === 'fail' ? 'process.exit(1);\n' : beatMode === 'hang' ? 'setTimeout(() => {}, 30_000);\n' : ''));
  const extra = { laneEnv: { EXAMPLE_CALLER: 'scheduled' } };
  if (beat) extra.laneHeartbeatCommand = ['node', beatProgram, '--beat'];
  writeFileSync(join(repo, 'spirality.project.json'), JSON.stringify(manifest(extra), null, 2));
  writeFileSync(join(repo, 'scripts', 'project_config.mjs'),
    `const v = { projectSlug: 'proj', logDir: ${JSON.stringify(logs)}, launchdPrefix: 'com.example', trackerPort: '', usageLimitSleep: ${sleep} };\n`
    + 'console.log(v[process.argv[2]] ?? "");\n');
  executable(join(repo, 'scripts', 'pause_check.sh'),
    pauseExit === 0 ? '#!/bin/bash\necho "running"\nexit 0\n' : `#!/bin/bash\necho "paused on the Settings page"\nexit ${pauseExit}\n`);
  if (workCheck) executable(join(repo, 'scripts', 'work_check.sh'), '#!/bin/bash\necho "queue empty"\nexit 3\n');
  executable(join(dir, 'bin', 'claude'),
    `#!/bin/bash\necho "$*" >> ${JSON.stringify(join(dir, 'claude-called'))}\necho ${JSON.stringify(say)}\n`
    + `${claudeSleep ? `sleep ${claudeSleep}\n` : ''}exit ${exit}\n`);
  const env = {
    ...scratchGitEnv(),
    GIT_CEILING_DIRECTORIES: dir,
    CLAUDE_BIN: join(dir, 'bin', 'claude'),
    DOPPLER_BIN: join(dir, 'bin', 'no-doppler'),
    LOOP_WAKE_POLL_SECONDS: '1',
    RUN_WITH_TIME_LIMIT_POLL: '1',
  };
  return { dir, repo, logs, env, beats, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const logFile = (s) => join(s.logs, 'proj-loop-build.log');
const readLog = (s) => (existsSync(logFile(s)) ? readFileSync(logFile(s), 'utf8') : '');
const sleeps = (log) => (log.match(/sleeping \d+s before (the next|asking again whether) \/loop-build/g) || []).length;

/**
 * Runs loop_runner.sh until its log has `turns` sleeping lines (one per turn
 * of the loop), sending a wake after each but the last so the next turn
 * starts at once, then stops it; answers the lane's log.
 */
async function runTurns(s, turns = 1, extraEnv = {}) {
  const child = spawn('bash', [join(s.repo, 'scripts', 'loop_runner.sh'), 'loop-build', '3600'], { cwd: s.repo, env: { ...s.env, ...extraEnv }, detached: true, stdio: 'ignore' });
  const deadline = Date.now() + 30_000;
  let woken = 0;
  try {
    while (Date.now() < deadline) {
      const seen = sleeps(readLog(s));
      if (seen >= turns) break;
      if (seen > woken) { writeFileSync(join(s.logs, 'proj-loop-build.wake'), ''); woken = seen; }
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  return readLog(s);
}

const beatsOf = (s) => (existsSync(s.beats) ? readFileSync(s.beats, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const claudeCalls = (s) => (existsSync(join(s.dir, 'claude-called')) ? readFileSync(join(s.dir, 'claude-called'), 'utf8').trim().split('\n').filter(Boolean) : []);

test('a pass that ran: one beat, --role loop-build and no other flag, in the project\'s checkout with its laneEnv', async () => {
  const s = scratch();
  try {
    const log = await runTurns(s);
    assert.match(log, /END \/loop-build \(exit 0/);
    const got = beatsOf(s);
    assert.equal(got.length, 1, `one beat for one turn:\n${log}`);
    assert.deepEqual(got[0].args, ['--beat', '--role', 'loop-build']);
    assert.equal(realpathSync(got[0].cwd), realpathSync(s.repo));
    assert.equal(got[0].caller, 'scheduled', 'the beat gets the project\'s laneEnv');
    assert.match(log, /beat recorded/, 'its output is in the log');
    assert.ok(log.indexOf('beat recorded') > log.indexOf('END /loop-build'), 'after the pass');
  } finally {
    s.cleanup();
  }
});

test('a paused turn: one --stood-down beat with the pause line, and Claude never started', async () => {
  const s = scratch({ pauseExit: 3 });
  try {
    const log = await runTurns(s);
    assert.match(log, /PAUSED \/loop-build/);
    assert.deepEqual(claudeCalls(s), []);
    const got = beatsOf(s);
    assert.equal(got.length, 1, log);
    assert.deepEqual(got[0].args, ['--beat', '--role', 'loop-build', '--stood-down', 'paused on the Settings page']);
  } finally {
    s.cleanup();
  }
});

test('a usage-limit turn: one --stood-down beat saying the lane sleeps until the reset', async () => {
  const s = scratch({ sleep: true, say: limitMessage(), exit: 1 });
  try {
    const log = await runTurns(s);
    assert.match(log, /usage limit — sleeping \d+s before the next/);
    const got = beatsOf(s);
    assert.equal(got.length, 1, log);
    assert.deepEqual(got[0].args.slice(0, 4), ['--beat', '--role', 'loop-build', '--stood-down']);
    assert.match(got[0].args[4], /^a usage limit closed this pass; the runner is sleeping \d+s until it resets$/);
  } finally {
    s.cleanup();
  }
});

test('a usage limit another lane recorded: the held turn beats --stood-down without starting Claude', async () => {
  const s = scratch({ sleep: true });
  writeFileSync(join(s.logs, 'proj-standdown'), JSON.stringify({ until: new Date(Date.now() + 3600_000).toISOString(), setBy: 'proj/loop-review', reason: 'a usage limit' }));
  try {
    const log = await runTurns(s);
    assert.match(log, /SKIP \/loop-build/);
    assert.deepEqual(claudeCalls(s), []);
    const got = beatsOf(s);
    assert.equal(got.length, 1, log);
    assert.deepEqual(got[0].args.slice(0, 4), ['--beat', '--role', 'loop-build', '--stood-down']);
    assert.match(got[0].args[4], /standing down/);
  } finally {
    s.cleanup();
  }
});

test('a pass that exited non-zero for another reason beats --blocked, with the guard on or off', async () => {
  for (const sleep of [false, true]) {
    const s = scratch({ sleep, say: 'something else broke', exit: 2 });
    try {
      const log = await runTurns(s);
      assert.match(log, /END \/loop-build \(exit 2/);
      const got = beatsOf(s);
      assert.equal(got.length, 1, log);
      assert.deepEqual(got[0].args.slice(0, 4), ['--beat', '--role', 'loop-build', '--blocked'], `usageLimitSleep ${sleep}`);
      assert.ok(got[0].args[4], 'with a sentence');
      assert.doesNotMatch(log, /usage limit — sleeping/);
    } finally {
      s.cleanup();
    }
  }
});

test('a pass the time limit stopped beats --timed-out', async () => {
  const s = scratch({ claudeSleep: 30 });
  try {
    const log = await runTurns(s, 1, { LOOP_PASS_LIMIT_SECONDS: '2' });
    assert.match(log, /END \/loop-build \(exit 124/);
    const got = beatsOf(s);
    assert.equal(got.length, 1, log);
    assert.deepEqual(got[0].args.slice(0, 4), ['--beat', '--role', 'loop-build', '--timed-out']);
  } finally {
    s.cleanup();
  }
});

test('one beat per turn: a pass, then a skipped empty-queue turn with a plain beat', async () => {
  const s = scratch({ workCheck: true });
  try {
    const log = await runTurns(s, 2);
    assert.match(log, /SKIP \/loop-build \(queue empty; Claude not started\)/);
    assert.equal(claudeCalls(s).length, 1);
    const got = beatsOf(s);
    assert.equal(got.length, 2, log);
    for (const b of got) assert.deepEqual(b.args, ['--beat', '--role', 'loop-build']);
  } finally {
    s.cleanup();
  }
});

test('a heartbeat that exits 1: one log line, and the next pass still runs', async () => {
  const s = scratch({ beatMode: 'fail' });
  try {
    const log = await runTurns(s, 2);
    const lines = log.split('\n').filter((l) => /heartbeat command/.test(l));
    assert.equal(lines.length, 2, `one line per failed beat:\n${log}`);
    assert.match(lines[0], /^\[loop-runner\] \d\d:\d\d:\d\d the project's heartbeat command \(node .*beat\.mjs --beat\) exited 1 — this turn's beat is lost; \/loop-build carries on$/);
    assert.equal(claudeCalls(s).length, 2, 'the next pass ran');
    assert.equal((log.match(/END \/loop-build \(exit 0/g) || []).length, 2, 'the pass\'s exit is untouched');
  } finally {
    s.cleanup();
  }
});

test('a heartbeat that hangs is stopped at its limit: one log line, and the next pass still runs', async () => {
  const s = scratch({ beatMode: 'hang' });
  try {
    const started = Date.now();
    const log = await runTurns(s, 2, { LOOP_HEARTBEAT_LIMIT_SECONDS: '2' });
    assert.match(log, /the project's heartbeat command \(node .*beat\.mjs --beat\) ran past 2s and was stopped — this turn's beat is lost; \/loop-build carries on/);
    assert.equal(claudeCalls(s).length, 2, 'the next pass ran');
    assert.ok(Date.now() - started < 25_000, 'not held up by the hung beat');
  } finally {
    s.cleanup();
  }
});

test('with no laneHeartbeatCommand nothing is run and the log is the same as before SP-397', async () => {
  const s = scratch({ beat: false });
  try {
    const log = await runTurns(s);
    assert.deepEqual(beatsOf(s), []);
    const shape = log.split(s.repo).join('REPO')
      .replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/g, 'DATE').replace(/\d\d:\d\d:\d\d/g, 'TIME')
      .split('\n').filter((l) => l && !/not pulling/.test(l));
    // Every line of the turn, exactly as the runner wrote it before SP-397.
    assert.deepEqual(shape, [
      "[loop-runner] TIME the project's laneEnv is given to every pass and its pause command: EXAMPLE_CALLER",
      "[loop-runner] TIME could not read /loop-build's model from the tracker (no answer) — this pass runs on Claude's default",
      '===== DATE START /loop-build (model: default) =====',
      "[loop-runner] TIME the project config in REPO names no Doppler project and config to read CLAUDE_CODE_OAUTH_TOKEN from; this pass uses this machine's own Claude sign-in",
      'pass report',
      "===== DATE END /loop-build (exit 0 — not a verdict; the pass's report above is) =====",
      "[loop-runner] TIME could not read /loop-build's wake time from the tracker (no answer) — keeping the last good value, 3600s",
      '[loop-runner] TIME sleeping 3600s before the next /loop-build (a wake ends it early)',
    ], log);
    assert.doesNotMatch(log, /beat recorded|heartbeat command/);
  } finally {
    s.cleanup();
  }
});
