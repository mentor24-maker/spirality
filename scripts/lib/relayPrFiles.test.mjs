// The relay's changed-files step (scripts/lib/relay_pr_files.sh, SP-349),
// run for real against a scratch checkout with a stand-in `npm` on the PATH
// that records what it was asked and exits as told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, 'relay_pr_files.sh');
const REPO = join(HERE, '..', '..');

function scratch() {
  const repo = mkdtempSync(join(tmpdir(), 'relay-pr-files-'));
  mkdirSync(join(repo, 'scripts'));
  mkdirSync(join(repo, 'bin'));
  copyFileSync(join(HERE, '..', 'run_with_time_limit.sh'), join(repo, 'scripts', 'run_with_time_limit.sh'));
  writeFileSync(join(repo, 'bin', 'npm'), `#!/bin/sh\necho "$(pwd) $*" >> "${join(repo, 'calls')}"\nexit "\${NPM_EXIT:-0}"\n`);
  chmodSync(join(repo, 'bin', 'npm'), 0o755);
  writeFileSync(join(repo, 'calls'), '');
  return { repo, calls: () => readFileSync(join(repo, 'calls'), 'utf8').split('\n').filter(Boolean) };
}

function step(s, args = [], env = {}) {
  return spawnSync('bash', ['-c', 'source "$1"; shift; run_relay_pr_files "$@"; echo "returned $?"', 'x', LIB, s.repo, '30', ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(s.repo, 'bin')}:${process.env.PATH}`, ...env },
  });
}

test('the step runs pr-files-refresh through the door, from the checkout it is given', () => {
  const s = scratch();
  const r = step(s);
  assert.equal(s.calls().length, 1);
  assert.match(s.calls()[0], /relay-pr-files-.* run --silent clickup -- pr-files-refresh$/);
  assert.match(r.stdout, /returned 0/);
  assert.doesNotMatch(r.stdout, /FAILED/);
});

test('a dry run passes --dry-run', () => {
  const s = scratch();
  step(s, ['--dry-run']);
  assert.match(s.calls()[0], /pr-files-refresh --dry-run$/);
});

test('a failing refresh is named with its exit code, and the relay is never failed', () => {
  const s = scratch();
  const r = step(s, [], { NPM_EXIT: '1' });
  assert.match(r.stdout, /\[relay\] pr-files-refresh FAILED \(exit 1;/);
  assert.match(r.stdout, /returned 0/);
});

test('run_relay.sh sources the step and runs it after the application checks, before the END line', () => {
  const sh = readFileSync(join(REPO, 'scripts', 'run_relay.sh'), 'utf8');
  assert.match(sh, /source "\$REPO\/scripts\/lib\/relay_pr_files\.sh"/);
  const at = sh.indexOf('run_relay_pr_files "$RUN_DIR"');
  assert.ok(at > sh.indexOf('run_relay_app_checks "$CHECKS_LIMIT"'), 'after the application checks');
  assert.ok(at < sh.lastIndexOf('END relay —'), 'before the END line');
});
