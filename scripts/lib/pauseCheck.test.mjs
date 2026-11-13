// The pause check in the runners (SP-237), against copies of the real
// scripts/loop_runner.sh and scripts/run_relay.sh in a scratch folder, with a
// stand-in `claude` and a stand-in scripts/pause_check.sh in place of the
// tracker read. The runners treat any non-zero exit from the check as paused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scratchGitEnv } = require('../../lib/scratchGit.js');

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');

function executable(file, text) {
  writeFileSync(file, text);
  chmodSync(file, 0o755);
}

/**
 * A scratch checkout holding copies of the runners and what they source, a
 * project config that names a scratch log folder and no tracker, a stand-in
 * check that prints PAUSE_TEXT and exits PAUSE_EXIT (noting the lane it was
 * asked about), and a stand-in claude that notes every call.
 */
function scratch({ text, exit }) {
  const dir = mkdtempSync(join(tmpdir(), 'pause-check-'));
  const repo = join(dir, 'repo');
  const logs = join(dir, 'logs');
  mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(dir, 'bin'));
  for (const f of ['loop_runner.sh', 'run_relay.sh', 'run_with_time_limit.sh']) copyFileSync(join(SCRIPTS, f), join(repo, 'scripts', f));
  for (const f of ['back_to_main.sh', 'tracker_restart.sh']) copyFileSync(join(SCRIPTS, 'lib', f), join(repo, 'scripts', 'lib', f));
  writeFileSync(join(repo, 'scripts', 'project_config.mjs'),
    `const v = { projectSlug: 'proj', logDir: ${JSON.stringify(logs)}, launchdPrefix: 'com.example', trackerPort: '' };\n`
    + 'console.log(v[process.argv[2]] ?? "");\n');
  executable(join(repo, 'scripts', 'pause_check.sh'),
    `#!/bin/bash\necho "$1" >> ${JSON.stringify(join(dir, 'asked'))}\n${text ? `echo ${JSON.stringify(text)}\n` : ''}exit ${exit}\n`);
  executable(join(dir, 'bin', 'claude'), `#!/bin/bash\necho "$*" >> ${JSON.stringify(join(dir, 'claude-called'))}\necho "pass report"\n`);
  const env = {
    ...scratchGitEnv(),
    GIT_CEILING_DIRECTORIES: dir,
    CLAUDE_BIN: join(dir, 'bin', 'claude'),
    LOOP_WAKE_POLL_SECONDS: '1',
  };
  return { dir, repo, logs, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Runs loop_runner.sh until its first "sleeping" line, then stops it; answers the lane's log. */
async function oneWake(s, skill = 'loop-build') {
  const child = spawn('bash', [join(s.repo, 'scripts', 'loop_runner.sh'), skill, '3600'], { cwd: s.repo, env: s.env, detached: true, stdio: 'ignore' });
  const log = join(s.logs, `proj-${skill}.log`);
  const deadline = Date.now() + 20_000;
  try {
    while (Date.now() < deadline) {
      if (existsSync(log) && /sleeping 3600s before the next/.test(readFileSync(log, 'utf8'))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  return existsSync(log) ? readFileSync(log, 'utf8') : '';
}

const called = (s) => existsSync(join(s.dir, 'claude-called'));
const asked = (s) => (existsSync(join(s.dir, 'asked')) ? readFileSync(join(s.dir, 'asked'), 'utf8').trim().split('\n') : []);

test('loop_runner.sh: with the lane paused, the wake logs the paused line and never calls claude', async () => {
  const s = scratch({ text: 'paused by Dane at Nov 13, 2026, 7:30 AM MST — not starting /loop-build (loop-build is paused on the Settings page; a pass already running finishes)', exit: 3 });
  try {
    const log = await oneWake(s);
    assert.match(log, /\[loop-runner\] \d\d:\d\d:\d\d paused by Dane at Nov 13, 2026, 7:30 AM MST — not starting \/loop-build/);
    assert.match(log, /sleeping 3600s before the next \/loop-build/);
    assert.doesNotMatch(log, /START \/loop-build/, 'no pass started, so the pod never reads one');
    assert.equal(called(s), false, 'claude was never called');
    assert.deepEqual(asked(s), ['loop-build'], 'the check is asked about this lane');
  } finally { s.cleanup(); }
});

test('loop_runner.sh: not paused, the wake runs a pass (resume)', async () => {
  const s = scratch({ text: 'running — neither the whole pipeline nor loop-review is paused', exit: 0 });
  try {
    const log = await oneWake(s, 'loop-review');
    assert.match(log, /START \/loop-review/);
    assert.match(log, /END \/loop-review/);
    assert.equal(called(s), true, 'claude ran the pass');
    assert.match(readFileSync(join(s.dir, 'claude-called'), 'utf8'), /^-p \/loop-review /);
  } finally { s.cleanup(); }
});

test('loop_runner.sh: a check that fails and says nothing counts as paused, and the log says why (fails safe)', async () => {
  const s = scratch({ text: '', exit: 7 });
  try {
    const log = await oneWake(s);
    assert.match(log, /could not read the pipeline settings \(the check exited 7 and said nothing; its errors are above\), so \/loop-build is treated as PAUSED and not starting \(it fails safe\)/);
    assert.equal(called(s), false);
  } finally { s.cleanup(); }
});

test('loop_runner.sh: a wake sent while paused is answered by the check, not kept to end every sleep', async () => {
  const s = scratch({ text: 'paused by Dane at x — not starting /loop-build', exit: 3 });
  try {
    mkdirSync(s.logs, { recursive: true });
    writeFileSync(join(s.logs, 'proj-loop-build.wake'), '');
    await oneWake(s);
    assert.equal(existsSync(join(s.logs, 'proj-loop-build.wake')), false);
  } finally { s.cleanup(); }
});

test('run_relay.sh: paused, it says so and exits 0 before its START line, its lock or any pass', () => {
  const s = scratch({ text: 'paused by Dane at Nov 13, 2026, 7:30 AM MST — not starting the relay pass (the whole pipeline is paused on the Settings page; a pass already running finishes)', exit: 3 });
  try {
    const r = spawnSync('bash', [join(s.repo, 'scripts', 'run_relay.sh')], { cwd: s.repo, env: s.env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^\[relay\] \d{4}-\d\d-\d\d \d\d:\d\d:\d\d paused by Dane at Nov 13, 2026, 7:30 AM MST — not starting the relay pass/m);
    assert.doesNotMatch(r.stdout, /START relay|END relay/);
    assert.equal(existsSync(join(s.logs, 'proj-relay.lock')), false);
    assert.deepEqual(asked(s), ['relay']);
  } finally { s.cleanup(); }
});

test('run_relay.sh: a check that fails and says nothing counts as paused, saying why', () => {
  const s = scratch({ text: '', exit: 1 });
  try {
    const r = spawnSync('bash', [join(s.repo, 'scripts', 'run_relay.sh')], { cwd: s.repo, env: s.env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /could not read the pipeline settings \(the check exited 1 and said nothing; its errors are above\), so the relay pass is treated as PAUSED/);
  } finally { s.cleanup(); }
});

test('the real pause_check.sh asks the door for this lane, and the relay signs in as itself before asking', () => {
  const check = readFileSync(join(SCRIPTS, 'pause_check.sh'), 'utf8');
  assert.match(check, /exec npm run --silent clickup -- pause-check --lane "\$LANE"/);
  const relay = readFileSync(join(SCRIPTS, 'run_relay.sh'), 'utf8');
  assert.ok(relay.indexOf('export TRACKER_TOKEN_NAME=TRACKER_TOKEN_RELAY') < relay.indexOf('scripts/pause_check.sh" relay'));
  const runner = readFileSync(join(SCRIPTS, 'loop_runner.sh'), 'utf8');
  assert.ok(runner.indexOf('export TRACKER_TOKEN_NAME=') < runner.indexOf('scripts/pause_check.sh" "$SKILL"'));
  assert.ok(runner.indexOf('scripts/pause_check.sh" "$SKILL"') < runner.indexOf('START /$SKILL'), 'asked before the pass starts');
});
