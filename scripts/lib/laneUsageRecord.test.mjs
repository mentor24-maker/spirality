// Every lane pass's Claude usage onto the API Usage report (SP-399): copies
// of the real scripts/loop_runner.sh and what it sources in a scratch
// folder, a stand-in `claude` that notes its arguments, and a stand-in door
// (the scratch folder's own `npm run clickup`) that notes each call and
// answers as told.
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function executable(file, text) {
  writeFileSync(file, text);
  chmodSync(file, 0o755);
}

const manifest = {
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
};

/**
 * A scratch checkout whose door prints `doorSays` and exits `doorExit`, and a
 * stand-in claude that exits `exit`.
 */
function scratch({ doorSays = 'usage-record: /loop-build on SP-1, claude-x: 10 tokens (row 1, read back).', doorExit = 0, exit = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lane-usage-'));
  const repo = join(dir, 'repo');
  const logs = join(dir, 'logs');
  mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(repo, 'lib'), { recursive: true });
  mkdirSync(join(dir, 'bin'));
  mkdirSync(logs);
  for (const f of ['loop_runner.sh', 'run_with_time_limit.sh', 'loop_runner_delay.mjs', 'loop_policy.mjs']) copyFileSync(join(SCRIPTS, f), join(repo, 'scripts', f));
  for (const f of ['back_to_main.sh', 'tracker_restart.sh', 'laneFiles.mjs', 'laneSettings.mjs']) copyFileSync(join(SCRIPTS, 'lib', f), join(repo, 'scripts', 'lib', f));
  for (const f of ['loopRunnerGuard.js', 'loopPolicy.js', 'passClaim.js', 'pipelinePause.js', 'projectConfig.mjs', 'package.json']) copyFileSync(join(ROOT, 'lib', f), join(repo, 'lib', f));
  writeFileSync(join(repo, 'spirality.project.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(repo, 'scripts', 'project_config.mjs'),
    `const v = { projectSlug: 'proj', logDir: ${JSON.stringify(logs)}, launchdPrefix: 'com.example', trackerPort: '', usageLimitSleep: false };\n`
    + 'console.log(v[process.argv[2]] ?? "");\n');
  executable(join(repo, 'scripts', 'pause_check.sh'), '#!/bin/bash\necho "running"\nexit 0\n');
  const doorCalls = join(dir, 'door-calls');
  writeFileSync(join(repo, 'scripts', 'door.mjs'),
    "import { appendFileSync } from 'node:fs';\n"
    + `appendFileSync(${JSON.stringify(doorCalls)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');\n`
    + `console.log(${JSON.stringify(doorSays)});\n`
    + `process.exit(${doorExit});\n`);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'scratch', private: true, scripts: { clickup: 'node scripts/door.mjs' } }));
  executable(join(dir, 'bin', 'claude'),
    `#!/bin/bash\necho "$*" >> ${JSON.stringify(join(dir, 'claude-called'))}\necho "pass report"\nexit ${exit}\n`);
  const env = {
    ...scratchGitEnv(),
    GIT_CEILING_DIRECTORIES: dir,
    CLAUDE_BIN: join(dir, 'bin', 'claude'),
    DOPPLER_BIN: join(dir, 'bin', 'no-doppler'),
    LOOP_WAKE_POLL_SECONDS: '1',
    RUN_WITH_TIME_LIMIT_POLL: '1',
  };
  return { dir, repo, logs, env, doorCalls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const logFile = (s) => join(s.logs, 'proj-loop-build.log');
const readLog = (s) => (existsSync(logFile(s)) ? readFileSync(logFile(s), 'utf8') : '');
const sleeps = (log) => (log.match(/sleeping \d+s before the next \/loop-build/g) || []).length;
const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []);
const usageCalls = (s) => lines(s.doorCalls).map((l) => JSON.parse(l)).filter((c) => c.args[0] === 'usage-record');
const sessionOf = (call) => call.match(/--session-id (\S+)/)?.[1];

/** Runs the runner for `turns` turns of its loop, waking it after each but the last. */
async function runTurns(s, turns = 1) {
  const child = spawn('bash', [join(s.repo, 'scripts', 'loop_runner.sh'), 'loop-build', '3600'], { cwd: s.repo, env: s.env, detached: true, stdio: 'ignore' });
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

test('each pass gets its own session id, and after its END line the door records that session\'s usage for the lane', { timeout: 60_000 }, async () => {
  const s = scratch();
  try {
    const log = await runTurns(s, 2);
    const passes = lines(join(s.dir, 'claude-called'));
    assert.equal(passes.length, 2, log);
    const ids = passes.map(sessionOf);
    for (const id of ids) assert.match(id ?? '', UUID, `a lower-case session id on the claude line: ${passes}`);
    assert.notEqual(ids[0], ids[1], 'a fresh id every pass');
    const calls = usageCalls(s);
    assert.deepEqual(calls.map((c) => c.args), ids.map((id) => ['usage-record', '--session', id, '--action', '/loop-build']));
    for (const c of calls) assert.equal(realpathSync(c.cwd), realpathSync(s.repo), 'from the folder the pass ran from');
    assert.match(log, new RegExp(`Claude session ${ids[0]}`), 'the log names the session');
    const first = log.indexOf('usage-record: /loop-build on SP-1');
    assert.ok(first > log.indexOf('END /loop-build'), `the door's answer is in the log, after the END line:\n${log}`);
  } finally {
    s.cleanup();
  }
});

test('a door that does not know usage-record, or a failed pass, never changes the exit or stops the next pass', { timeout: 60_000 }, async () => {
  const s = scratch({ doorSays: 'Unknown command: usage-record', doorExit: 1, exit: 2 });
  try {
    const log = await runTurns(s, 2);
    assert.equal(lines(join(s.dir, 'claude-called')).length, 2, `the second pass still ran:\n${log}`);
    assert.equal(usageCalls(s).length, 2, 'a failed pass is recorded too');
    assert.match(log, /Unknown command: usage-record/, 'the answer is logged');
    assert.equal((log.match(/END \/loop-build \(exit 2 /g) || []).length, 2, 'the END line keeps the pass\'s own exit');
  } finally {
    s.cleanup();
  }
});
