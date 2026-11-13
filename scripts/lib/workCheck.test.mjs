// The work check (SP-292): its verdicts with a stand-in door, and the runner
// skipping the Claude session on "no work", against a copy of the real
// scripts/loop_runner.sh with a stand-in `claude`, pause check and work check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { workVerdict, WORK, NO_WORK, LANES } from './workCheck.mjs';

const require = createRequire(import.meta.url);
const { scratchGitEnv } = require('../../lib/scratchGit.js');

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── The verdicts ─────────────────────────────────────────────────────────────

/** A stand-in door: answers by the command's first words, and notes every call. */
function door(answers) {
  const calls = [];
  const fn = (args) => {
    calls.push(args.join(' '));
    const key = Object.keys(answers).find((k) => args.join(' ').startsWith(k));
    const a = key ? answers[key] : { status: 1, stderr: 'no stand-in answer' };
    return { status: a.status ?? 0, stdout: a.stdout ?? '', stderr: a.stderr ?? '', error: a.error ?? null };
  };
  return { fn, calls };
}

const ROW = (id, status) => `${id}\t${status}\tnormal\t2026-11-13\tA ticket\n`;

test('loop-build: nothing claimable is no work, after pass-reconcile and wip-check, in that order', () => {
  const d = door({ 'pass-reconcile': { status: 0 }, 'wip-check': { status: 0, stdout: 'room: 1 of 5 in flight\n' }, 'queue --claimable': { stdout: '' } });
  const v = workVerdict('loop-build', { door: d.fn });
  assert.equal(v.code, NO_WORK);
  assert.match(v.line, /^no work: no claimable ticket \(Rework or Queued\)$/);
  assert.deepEqual(d.calls, ['pass-reconcile', 'wip-check', 'queue --claimable']);
});

test('loop-build: a claimable ticket is work, naming it', () => {
  const d = door({ 'pass-reconcile': { status: 0 }, 'wip-check': { status: 0 }, 'queue --claimable': { stdout: ROW('SP-1', 'rework') + ROW('SP-2', 'queued') } });
  const v = workVerdict('loop-build', { door: d.fn });
  assert.equal(v.code, WORK);
  assert.equal(v.line, 'work: 2 claimable ticket(s) (SP-1, SP-2)');
});

test('loop-build: a full cap is no work, and the queue is not read', () => {
  const d = door({ 'pass-reconcile': { status: 0 }, 'wip-check': { status: 3, stdout: 'full: 5 of 5 in flight (SP-1, SP-2, SP-3, SP-4, SP-5)\n' } });
  const v = workVerdict('loop-build', { door: d.fn });
  assert.equal(v.code, NO_WORK);
  assert.match(v.line, /the work-in-progress cap is full \(full: 5 of 5 in flight/);
  assert.deepEqual(d.calls, ['pass-reconcile', 'wip-check']);
});

test('loop-build: a cap that could not be read still reads the queue (the pass would claim anyway)', () => {
  const d = door({ 'pass-reconcile': { status: 0 }, 'wip-check': { status: 1 }, 'queue --claimable': { stdout: ROW('SP-9', 'queued') } });
  assert.equal(workVerdict('loop-build', { door: d.fn }).code, WORK);
});

test('loop-build: pass-reconcile handing a ticket back (exit 3) carries on to the queue', () => {
  const d = door({ 'pass-reconcile': { status: 3 }, 'wip-check': { status: 0 }, 'queue --claimable': { stdout: ROW('SP-7', 'rework') } });
  const v = workVerdict('loop-build', { door: d.fn });
  assert.equal(v.code, WORK);
  assert.deepEqual(d.calls, ['pass-reconcile', 'wip-check', 'queue --claimable']);
});

test('loop-build: pass-reconcile failing starts the pass, so the skill stops and reports it', () => {
  for (const status of [1, 2]) {
    const d = door({ 'pass-reconcile': { status, stderr: 'a write failed' } });
    const v = workVerdict('loop-build', { door: d.fn });
    assert.equal(v.code, WORK);
    assert.match(v.line, /^could not tell \(pass-reconcile failed \(exit \d: a write failed\)\), so the pass starts and reports it$/);
  }
});

test('loop-review and loop-intake read their own status', () => {
  const r = door({ 'queue --status In review': { stdout: '' } });
  assert.deepEqual(workVerdict('loop-review', { door: r.fn }), { code: NO_WORK, line: 'no work: no ticket in In review' });
  assert.deepEqual(r.calls, ['queue --status In review']);
  const i = door({ 'queue --status Requested': { stdout: ROW('SP-4', 'requested') } });
  assert.deepEqual(workVerdict('loop-intake', { door: i.fn }), { code: WORK, line: 'work: 1 ticket(s) in Requested (SP-4)' });
});

test('it fails open: a door that fails, times out or cannot run, or an unknown lane, starts the pass', () => {
  const failed = door({ 'queue --status In review': { status: 1, stderr: 'HTTP 0: the request never left this machine' } });
  const v = workVerdict('loop-review', { door: failed.fn });
  assert.equal(v.code, WORK);
  assert.match(v.line, /^could not tell \(the In review queue read failed \(exit 1: HTTP 0: the request never left this machine\)\), so the pass starts$/);
  const slow = door({ 'queue --status Requested': { status: null, error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) } });
  assert.match(workVerdict('loop-intake', { door: slow.fn }).line, /took longer than 60s and was stopped/);
  const missing = door({ 'queue --status Requested': { status: null, error: Object.assign(new Error('x'), { code: 'ENOENT' }) } });
  assert.equal(workVerdict('loop-intake', { door: missing.fn }).code, WORK);
  const unknown = door({});
  assert.equal(workVerdict('loop-handoff', { door: unknown.fn }).code, WORK);
  assert.deepEqual(unknown.calls, [], 'an unknown lane asks the door nothing');
  assert.deepEqual(LANES, ['loop-build', 'loop-review', 'loop-intake']);
});

// ── The runner ───────────────────────────────────────────────────────────────

function executable(file, text) {
  writeFileSync(file, text);
  chmodSync(file, 0o755);
}

/**
 * A scratch checkout with copies of the runner and what it sources, a stand-in
 * pause check that always says run, a stand-in work check that prints `text`
 * and exits `exit` (noting the lane it was asked about), and a stand-in claude
 * that notes every call.
 */
function scratch({ text, exit, env = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'work-check-'));
  const repo = join(dir, 'repo');
  const logs = join(dir, 'logs');
  mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(dir, 'bin'));
  for (const f of ['loop_runner.sh', 'run_with_time_limit.sh']) copyFileSync(join(SCRIPTS, f), join(repo, 'scripts', f));
  for (const f of ['back_to_main.sh', 'tracker_restart.sh']) copyFileSync(join(SCRIPTS, 'lib', f), join(repo, 'scripts', 'lib', f));
  writeFileSync(join(repo, 'scripts', 'project_config.mjs'),
    `const v = { projectSlug: 'proj', logDir: ${JSON.stringify(logs)}, launchdPrefix: 'com.example', trackerPort: '' };\n`
    + 'console.log(v[process.argv[2]] ?? "");\n');
  executable(join(repo, 'scripts', 'pause_check.sh'), '#!/bin/bash\necho "running"\nexit 0\n');
  executable(join(repo, 'scripts', 'work_check.sh'),
    `#!/bin/bash\necho "$1" >> ${JSON.stringify(join(dir, 'asked'))}\n${text ? `echo ${JSON.stringify(text)}\n` : ''}exit ${exit}\n`);
  executable(join(dir, 'bin', 'claude'), `#!/bin/bash\necho "$*" >> ${JSON.stringify(join(dir, 'claude-called'))}\necho "pass report"\n`);
  return {
    dir, repo, logs,
    env: { ...scratchGitEnv(), GIT_CEILING_DIRECTORIES: dir, CLAUDE_BIN: join(dir, 'bin', 'claude'), LOOP_WAKE_POLL_SECONDS: '1', ...env },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Runs loop_runner.sh through `wakes` sleeps: after each "sleeping" line but
 * the last it writes the wake file, so the next pass starts at once. Answers
 * the lane's log.
 */
async function run(s, { skill = 'loop-build', wakes = 2 } = {}) {
  const child = spawn('bash', [join(s.repo, 'scripts', 'loop_runner.sh'), skill, '3600'], { cwd: s.repo, env: s.env, detached: true, stdio: 'ignore' });
  const log = join(s.logs, `proj-${skill}.log`);
  const deadline = Date.now() + 30_000;
  let woken = 0;
  try {
    while (Date.now() < deadline) {
      const n = existsSync(log) ? (readFileSync(log, 'utf8').match(/sleeping 3600s before the next/g) || []).length : 0;
      if (n >= wakes) break;
      if (n > woken) { writeFileSync(join(s.logs, `proj-${skill}.wake`), ''); woken = n; }
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  return existsSync(log) ? readFileSync(log, 'utf8') : '';
}

const claudeCalls = (s) => (existsSync(join(s.dir, 'claude-called')) ? readFileSync(join(s.dir, 'claude-called'), 'utf8').trim().split('\n').length : 0);
const asked = (s) => (existsSync(join(s.dir, 'asked')) ? readFileSync(join(s.dir, 'asked'), 'utf8').trim().split('\n') : []);

test('loop_runner.sh: the first pass always runs, and the check is not asked before it', async () => {
  const s = scratch({ text: 'no work: no claimable ticket (Rework or Queued)', exit: 3 });
  try {
    const log = await run(s, { wakes: 1 });
    assert.match(log, /START \/loop-build/);
    assert.equal(claudeCalls(s), 1);
    assert.deepEqual(asked(s), []);
  } finally { s.cleanup(); }
});

test('loop_runner.sh: no work after the first pass skips the Claude session with a dated SKIP line, and still sleeps', async () => {
  const s = scratch({ text: 'no work: no claimable ticket (Rework or Queued)', exit: 3 });
  try {
    const log = await run(s, { wakes: 2 });
    assert.equal(claudeCalls(s), 1, 'claude ran the first pass only');
    assert.deepEqual(asked(s), ['loop-build']);
    assert.match(log, /^===== \d{4}-\d\d-\d\d \d\d:\d\d:\d\d SKIP \/loop-build \(no work: no claimable ticket \(Rework or Queued\); Claude not started\) =====$/m);
    assert.equal((log.match(/START \/loop-build/g) || []).length, 1);
    assert.doesNotMatch(log.split('SKIP /loop-build')[1], /START|END/, 'the skip writes no START or END line');
    assert.match(log.split('SKIP /loop-build')[1], /sleeping 3600s before the next \/loop-build/);
  } finally { s.cleanup(); }
});

test('loop_runner.sh: work starts the pass and logs what the check found', async () => {
  const s = scratch({ text: 'work: 1 ticket(s) in In review (SP-3)', exit: 0 });
  try {
    const log = await run(s, { skill: 'loop-review', wakes: 2 });
    assert.equal(claudeCalls(s), 2);
    assert.match(log, /\[loop-runner\] \d\d:\d\d:\d\d work check: work: 1 ticket\(s\) in In review \(SP-3\) — starting \/loop-review/);
    assert.doesNotMatch(log, /SKIP/);
  } finally { s.cleanup(); }
});

test('loop_runner.sh: a check that fails and says nothing starts the pass (fails open)', async () => {
  const s = scratch({ text: '', exit: 5 });
  try {
    const log = await run(s, { wakes: 2 });
    assert.equal(claudeCalls(s), 2);
    assert.match(log, /work check: the check exited 5 and said nothing — starting \/loop-build/);
  } finally { s.cleanup(); }
});

test('loop_runner.sh: LOOP_IDLE_PASS_EVERY_SECONDS=0 turns the skipping off: the check is never asked', async () => {
  const s = scratch({ text: 'no work: x', exit: 3, env: { LOOP_IDLE_PASS_EVERY_SECONDS: '0' } });
  try {
    await run(s, { wakes: 2 });
    assert.equal(claudeCalls(s), 2);
    assert.deepEqual(asked(s), []);
  } finally { s.cleanup(); }
});

test('the real work_check.sh runs workCheck.mjs for the lane, and the runner asks it after the pause check and before START', () => {
  const check = readFileSync(join(SCRIPTS, 'work_check.sh'), 'utf8');
  assert.match(check, /exec node "\$REPO\/scripts\/lib\/workCheck\.mjs" "\$LANE"/);
  const runner = readFileSync(join(SCRIPTS, 'loop_runner.sh'), 'utf8');
  const at = (s) => runner.indexOf(s);
  assert.ok(at('export TRACKER_TOKEN_NAME=') < at('scripts/work_check.sh" "$SKILL"'), 'the check signs in as the lane');
  assert.ok(at('scripts/pause_check.sh" "$SKILL"') < at('scripts/work_check.sh" "$SKILL"'));
  assert.ok(at('scripts/work_check.sh" "$SKILL"') < at('START /$SKILL'));
});
