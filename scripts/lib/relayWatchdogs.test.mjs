// The relay's watchdog step (scripts/lib/relay_watchdogs.sh, SP-267), run
// for real against a scratch checkout whose stale_ready.mjs, stale_answer.mjs
// and reconcile.mjs (SP-354) are stand-ins that record what they were asked
// and exit as told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, 'relay_watchdogs.sh');

function scratch({ answer = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'relay-watchdogs-'));
  mkdirSync(join(repo, 'scripts'));
  copyFileSync(join(HERE, '..', 'run_with_time_limit.sh'), join(repo, 'scripts', 'run_with_time_limit.sh'));
  const stand = (name) => `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(join(repo, 'calls'))}, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');
process.exit(Number(process.env.${name.toUpperCase()}_EXIT || 0));
`;
  writeFileSync(join(repo, 'scripts', 'stale_ready.mjs'), stand('stale_ready'));
  if (answer) writeFileSync(join(repo, 'scripts', 'stale_answer.mjs'), stand('stale_answer'));
  writeFileSync(join(repo, 'scripts', 'reconcile.mjs'), stand('reconcile'));
  writeFileSync(join(repo, 'calls'), '');
  return { repo, calls: () => readFileSync(join(repo, 'calls'), 'utf8').split('\n').filter(Boolean) };
}

function step(s, args = [], env = {}) {
  return spawnSync('bash', ['-c', 'source "$1"; shift; run_relay_watchdogs "$@"; echo "returned $?"', 'x', LIB, s.repo, '30', ...args], {
    encoding: 'utf8',
    // The time-limit wrapper looks every 15s by default; a stand-in exits at
    // once, so look every second or three watchdogs cost 45s a test.
    env: { ...process.env, RUN_WITH_TIME_LIMIT_POLL: '1', ...env },
  });
}

test('all three watchdogs run with --check, one after the other', () => {
  const s = scratch();
  const r = step(s);
  assert.deepEqual(s.calls(), ['stale_ready --check', 'stale_answer --check', 'reconcile --check']);
  assert.match(r.stdout, /returned 0/);
  assert.doesNotMatch(r.stdout, /FAILED/);
});

test('a dry run passes --dry-run to each', () => {
  const s = scratch();
  step(s, ['--dry-run']);
  assert.deepEqual(s.calls(), ['stale_ready --check --dry-run', 'stale_answer --check --dry-run', 'reconcile --check --dry-run']);
});

test('a failing watchdog is named, the next still runs, and the relay is never failed', () => {
  const s = scratch();
  const r = step(s, [], { STALE_READY_EXIT: '1' });
  assert.match(r.stdout, /\[relay\] the stale-ready check FAILED \(exit 1;/);
  assert.deepEqual(s.calls(), ['stale_ready --check', 'stale_answer --check', 'reconcile --check']);
  assert.match(r.stdout, /returned 0/);
});

test('a failing reconcile check is one FAILED line and the relay\'s verdict is unchanged (SP-354)', () => {
  const s = scratch();
  const r = step(s, [], { RECONCILE_EXIT: '2' });
  assert.match(r.stdout, /\[relay\] the reconcile check FAILED \(exit 2;/);
  assert.equal(r.stdout.split('\n').filter((l) => /FAILED/.test(l)).length, 1);
  assert.match(r.stdout, /returned 0/);
});

test('a checkout without a watchdog says so in one line and carries on', () => {
  const s = scratch({ answer: false });
  const r = step(s);
  assert.match(r.stdout, /stale-answer: not in this checkout \(no scripts\/stale_answer\.mjs\)/);
  assert.deepEqual(s.calls(), ['stale_ready --check', 'reconcile --check']);
  assert.match(r.stdout, /returned 0/);
});
