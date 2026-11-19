// The usage-limit guard in the runner (SP-396): the manifest's
// `usageLimitSleep`, against copies of the real scripts/loop_runner.sh, the
// two guard scripts moved from StarCaster (scripts/loop_runner_delay.mjs,
// scripts/loop_policy.mjs) and their modules, in a scratch folder, with a
// stand-in `claude` that dies on a usage limit the way it does live and a
// stand-in Settings page pause check that always says "running".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** Claude's own words when a window closes, with a reset an hour from now in Mountain time. */
function limitMessage(nowMs = Date.now()) {
  const at = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit', hour12: true })
    .format(new Date(nowMs + 60 * 60 * 1000)).replace(/\s?([AP])M$/, (_, x) => `${x.toLowerCase()}m`);
  return `You've hit your session limit · resets ${at} (America/Denver)`;
}

/**
 * A scratch checkout holding the runner, what it sources, the guard scripts
 * and their modules, a stand-in project_config.mjs answering `usageLimitSleep`
 * with `sleep`, and a stand-in claude that notes each call, prints `say` and
 * exits `exit`.
 */
function scratch({ sleep = true, say = limitMessage(), exit = 1 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'usage-limit-'));
  const repo = join(dir, 'repo');
  const logs = join(dir, 'logs');
  mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(repo, 'lib'), { recursive: true });
  mkdirSync(join(dir, 'bin'));
  mkdirSync(logs);
  for (const f of ['loop_runner.sh', 'run_with_time_limit.sh', 'loop_runner_delay.mjs', 'loop_policy.mjs']) copyFileSync(join(SCRIPTS, f), join(repo, 'scripts', f));
  for (const f of ['back_to_main.sh', 'tracker_restart.sh', 'laneFiles.mjs']) copyFileSync(join(SCRIPTS, 'lib', f), join(repo, 'scripts', 'lib', f));
  for (const f of ['loopRunnerGuard.js', 'loopPolicy.js', 'passClaim.js', 'pipelinePause.js', 'projectConfig.mjs', 'package.json']) copyFileSync(join(ROOT, 'lib', f), join(repo, 'lib', f));
  writeFileSync(join(repo, 'scripts', 'project_config.mjs'),
    `const v = { projectSlug: 'proj', logDir: ${JSON.stringify(logs)}, launchdPrefix: 'com.example', trackerPort: '', usageLimitSleep: ${sleep} };\n`
    + 'console.log(v[process.argv[2]] ?? "");\n');
  executable(join(repo, 'scripts', 'pause_check.sh'), '#!/bin/bash\necho "running"\nexit 0\n');
  executable(join(dir, 'bin', 'claude'),
    `#!/bin/bash\necho "$*" >> ${JSON.stringify(join(dir, 'claude-called'))}\necho ${JSON.stringify(say)}\nexit ${exit}\n`);
  const env = {
    ...scratchGitEnv(),
    GIT_CEILING_DIRECTORIES: dir,
    CLAUDE_BIN: join(dir, 'bin', 'claude'),
    DOPPLER_BIN: join(dir, 'bin', 'no-doppler'),
    LOOP_WAKE_POLL_SECONDS: '1',
    RUN_WITH_TIME_LIMIT_POLL: '1',
  };
  return { dir, repo, logs, env, standdown: join(logs, 'proj-standdown'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Runs loop_runner.sh until its log matches `until`, then stops it; answers the lane's log. */
async function runUntil(s, skill, until) {
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

const calls = (s) => (existsSync(join(s.dir, 'claude-called')) ? readFileSync(join(s.dir, 'claude-called'), 'utf8').trim().split('\n').filter(Boolean) : []);
const WAKE_SLEEP = /sleeping 3600s before the next \/loop-build/;
const LIMIT_SLEEP = /usage limit — sleeping (\d+)s before the next \/loop-build/;

test('on: a pass a usage limit closed sleeps the lane until the reset and writes the stand-down file', async () => {
  const s = scratch();
  try {
    const log = await runUntil(s, 'loop-build', LIMIT_SLEEP);
    const m = LIMIT_SLEEP.exec(log);
    assert.ok(m, `the log shows the limit sleep:\n${log}`);
    const secs = Number(m[1]);
    assert.ok(secs > 3000 && secs <= 3600 + 180, `an hour to the reset plus the 2-minute margin, got ${secs}s`);
    assert.match(log, /usageLimitSleep is on/);
    assert.match(log, /END \/loop-build \(exit 1/);
    assert.doesNotMatch(log, WAKE_SLEEP, 'the limit outranks the wake time');
    const marker = JSON.parse(readFileSync(s.standdown, 'utf8'));
    assert.equal(marker.setBy, 'proj/loop-build');
    assert.ok(Date.parse(marker.until) > Date.now() + 50 * 60 * 1000, 'it holds until the reset');
    assert.equal(existsSync(join(s.logs, 'loops.standdown')), false, 'never a file every project would read');
  } finally {
    s.cleanup();
  }
});

test('off: the same pass sleeps the normal wake time and writes no stand-down file', async () => {
  const s = scratch({ sleep: false });
  try {
    const log = await runUntil(s, 'loop-build', WAKE_SLEEP);
    assert.match(log, WAKE_SLEEP);
    assert.match(log, /END \/loop-build \(exit 1/);
    assert.doesNotMatch(log, /usage limit|usageLimitSleep/);
    assert.equal(existsSync(s.standdown), false);
  } finally {
    s.cleanup();
  }
});

test('a second lane started while the stand-down holds sleeps without starting Claude', async () => {
  const s = scratch();
  try {
    await runUntil(s, 'loop-build', LIMIT_SLEEP);
    assert.equal(calls(s).length, 1, 'the first lane met the limit once');
    const log = await runUntil(s, 'loop-review', /sleeping \d+s before asking again whether \/loop-review may start/);
    assert.match(log, /^===== \d{4}-\d\d-\d\d \d\d:\d\d:\d\d SKIP \/loop-review \(standing down until .* \(set by proj\/loop-build\); Claude not started\) =====$/m);
    assert.match(log, /sleeping 900s before asking again/, 'asked again within 15 minutes, so a lifted stand-down is noticed');
    assert.doesNotMatch(log, /START \/loop-review/);
    assert.equal(calls(s).length, 1, 'claude was not started for the second lane');
  } finally {
    s.cleanup();
  }
});

test('a broken guard (exits 1, prints nothing) never stops the runner: the pass counts as blocked and the lane sleeps its wake time', async () => {
  const s = scratch();
  executable(join(s.repo, 'scripts', 'loop_runner_delay.mjs'), 'process.exit(1);\n');
  try {
    const log = await runUntil(s, 'loop-build', WAKE_SLEEP);
    assert.match(log, /the usage-limit guard gave no answer the runner can use \(nothing\) — counting this pass as blocked and sleeping the usual wake time/);
    assert.match(log, WAKE_SLEEP);
    assert.equal(existsSync(s.standdown), false);
  } finally {
    s.cleanup();
  }
});

test('on: a pass that exits 0 is never read for a limit, even when it writes about one', async () => {
  const s = scratch({ exit: 0 });
  try {
    const log = await runUntil(s, 'loop-build', WAKE_SLEEP);
    assert.match(log, WAKE_SLEEP);
    assert.doesNotMatch(log, LIMIT_SLEEP);
    assert.equal(existsSync(s.standdown), false);
  } finally {
    s.cleanup();
  }
});

test('the moved guard code names no project, tracker address or home folder (CLAUDE.md rule 2)', () => {
  for (const f of ['lib/loopRunnerGuard.js', 'lib/loopPolicy.js', 'scripts/loop_runner_delay.mjs', 'scripts/loop_policy.mjs']) {
    const code = readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.doesNotMatch(code, /starcaster|wavecenter|spirality|clickup\.com|loop-logs|\/Users\//i, f);
  }
});
