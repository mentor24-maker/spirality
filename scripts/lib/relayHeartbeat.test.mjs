// The relay's heartbeat step (scripts/lib/relay_heartbeat.sh, SP-266), run
// for real against a scratch checkout whose scripts/heartbeat.mjs is a stand-in
// that exits as told: whatever the heartbeat does, the step returns 0, so the
// relay pass carries on to its END line, and a failure is one line naming it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const LIB = join(HERE, 'relay_heartbeat.sh');

function scratch(exitCode) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-heartbeat-'));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(join(REPO, 'scripts', 'run_with_time_limit.sh'), join(dir, 'scripts', 'run_with_time_limit.sh'));
  chmodSync(join(dir, 'scripts', 'run_with_time_limit.sh'), 0o755);
  writeFileSync(join(dir, 'scripts', 'heartbeat.mjs'), `console.log('heartbeat ran with: ' + JSON.stringify(process.argv.slice(2))); process.exit(${exitCode});\n`);
  return dir;
}

/** The step, then a line standing for the rest of the relay pass. */
function step(dir, ...args) {
  return spawnSync('bash', ['-c', 'source "$1"; shift; run_relay_heartbeat "$@"; echo "step returned $?"; echo "===== END relay"', 'x', LIB, dir, '30', ...args], { encoding: 'utf8' });
}

test('a clean heartbeat runs with --check and says nothing more', () => {
  const r = step(scratch(0));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /heartbeat ran with: \["--check"\]/);
  assert.doesNotMatch(r.stdout, /FAILED/);
  assert.match(r.stdout, /step returned 0\n===== END relay/);
});

for (const code of [1, 2, 124]) {
  test(`a heartbeat that exits ${code} is named in one line, and the relay still reaches its END line`, () => {
    const r = step(scratch(code));
    assert.match(r.stdout, new RegExp(`\\[relay\\] the heartbeat check FAILED \\(exit ${code};`));
    assert.match(r.stdout, /step returned 0\n===== END relay/);
  });
}

test('a dry run asks only: no --check, and exit 3 (a quiet lane, already printed) is not a failure', () => {
  const r = step(scratch(3), '--dry-run');
  assert.match(r.stdout, /heartbeat ran with: \[\]/);
  assert.doesNotMatch(r.stdout, /FAILED/);
  assert.match(r.stdout, /step returned 0/);
});

test('a checkout with no heartbeat says so in one line and does not fail', () => {
  const dir = scratch(0);
  const r = spawnSync('bash', ['-c', 'rm "$2/scripts/heartbeat.mjs"; source "$1"; run_relay_heartbeat "$2" 30; echo "step returned $?"', 'x', LIB, dir], { encoding: 'utf8' });
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^heartbeat: not in this checkout \(no scripts\/heartbeat\.mjs\), so no lane is watched\nstep returned 0\n$/);
});

test('run_relay.sh sources the step and runs it after the application checks, before the END line', () => {
  const sh = readFileSync(join(REPO, 'scripts', 'run_relay.sh'), 'utf8');
  assert.match(sh, /source "\$REPO\/scripts\/lib\/relay_heartbeat\.sh"/);
  const at = sh.indexOf('run_relay_heartbeat "$RUN_DIR"');
  assert.ok(at > sh.indexOf('run_relay_app_checks "$CHECKS_LIMIT"'), 'after the application checks');
  assert.ok(at < sh.lastIndexOf('END relay —'), 'before the END line');
  const between = sh.slice(at, sh.lastIndexOf('END relay —')).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(between, /\$\?|exit /, 'its result never reaches the pass\'s verdict');
});
