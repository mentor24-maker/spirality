/**
 * wakeLane.mjs (SP-219): a lane is woken by its wake file, the relay by a
 * `launchctl kickstart` without -k, and a wake that was not sent says so.
 * What the runner does with the wake file is in loopLanes.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOBS, wakeLane } from './wakeLane.mjs';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function scratch() {
  const logDir = mkdtempSync(join(tmpdir(), 'wake-lane-'));
  return { logDir, config: { logDir, projectSlug: 'normie', launchdPrefix: 'com.normie' } };
}

function holdLock(logDir, name, pid) {
  mkdirSync(join(logDir, `normie-${name}.lock`));
  writeFileSync(join(logDir, `normie-${name}.lock/pid`), String(pid));
}

test('the jobs it knows are the scheduled ones: three lanes and the relay', () => {
  assert.deepEqual([...JOBS].sort(), ['loop-build', 'loop-intake', 'loop-review', 'relay']);
});

test('a lane is woken by its wake file, named from the project config like its lock', () => {
  const { logDir, config } = scratch();
  try {
    holdLock(logDir, 'loop-build', process.pid);
    const r = wakeLane('loop-build', { config, launchctl: () => assert.fail('a lane is never kickstarted') });
    assert.equal(r.code, 0);
    assert.match(r.line, /^loop-build: woken — wake file .*normie-loop-build\.wake written; runner pid \d+/);
    assert.ok(existsSync(join(logDir, 'normie-loop-build.wake')));
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test('a lane with no live runner still gets its wake file, and the line says nobody is there to read it yet', () => {
  const { logDir, config } = scratch();
  try {
    holdLock(logDir, 'loop-review', 999999);
    const r = wakeLane('loop-review', { config, isAlive: () => false });
    assert.equal(r.code, 0);
    assert.match(r.line, /no runner holds the lane's lock/);
    assert.ok(existsSync(join(logDir, 'normie-loop-review.wake')));
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test('a wake file that cannot be written exits 1 with one line, never a success line', () => {
  const { logDir, config } = scratch();
  rmSync(logDir, { recursive: true, force: true });
  const r = wakeLane('loop-intake', { config });
  assert.equal(r.code, 1);
  assert.match(r.line, /^loop-intake: NOT WOKEN — the wake file .* could not be written \(ENOENT\)$/);
  assert.doesNotMatch(r.line, /woken —/);
});

test('the relay is kickstarted WITHOUT -k when no pass is running, after its wake file, so the tick it starts runs a pass (SP-236)', () => {
  const { logDir, config } = scratch();
  try {
    const calls = [];
    const r = wakeLane('relay', { config, uid: 501, launchctl: (args) => { calls.push(args); return { status: 0, output: '' }; } });
    assert.deepEqual(calls, [['kickstart', 'gui/501/com.normie.relay']]);
    assert.equal(r.code, 0);
    assert.equal(r.line, 'relay: woken — launchctl kickstart gui/501/com.normie.relay started a pass');
    assert.ok(existsSync(join(logDir, 'normie-relay.wake')), 'the relay\'s wake file was not written: its tick would skip');
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test('a relay pass already running is left alone: nothing is started', () => {
  const { logDir, config } = scratch();
  try {
    holdLock(logDir, 'relay', process.pid);
    const r = wakeLane('relay', { config, launchctl: () => assert.fail('started a second relay') });
    assert.equal(r.code, 0);
    assert.ok(!existsSync(join(logDir, 'normie-relay.wake')), 'a wake for a running pass would start a second one behind it');
    assert.match(r.line, /^relay: a pass is already running \(pid \d+\) — not starting a second/);
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test('a stale relay lock (its pid gone) does not stop the kickstart', () => {
  const { logDir, config } = scratch();
  try {
    holdLock(logDir, 'relay', 999999);
    let kicked = false;
    const r = wakeLane('relay', { config, uid: 501, isAlive: () => false, launchctl: () => { kicked = true; return { status: 0, output: '' }; } });
    assert.ok(kicked);
    assert.equal(r.code, 0);
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test('a kickstart that fails exits 1 naming launchctl\'s answer, and says the next tick runs the pass', () => {
  const { logDir, config } = scratch();
  try {
    const r = wakeLane('relay', { config, uid: 501, launchctl: () => ({ status: 113, output: 'Could not find service "com.normie.relay" in domain for user gui: 501' }) });
    assert.equal(r.code, 1);
    assert.equal(r.line, `relay: NOT WOKEN — launchctl kickstart gui/501/com.normie.relay exited 113 (Could not find service "com.normie.relay" in domain for user gui: 501); the wake file ${join(logDir, 'normie-relay.wake')} is written, so the next tick runs a pass`);
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test('a job it does not know exits 2 with one line naming the ones it does', () => {
  const r = wakeLane('loop-bild', { config: scratch().config });
  assert.equal(r.code, 2);
  assert.equal(r.line, 'wakeLane: "loop-bild" is not a loop job — one of: loop-build, loop-review, loop-intake, relay');
  const cli = spawnSync(process.execPath, [join(REPO, 'scripts/lib/wakeLane.mjs'), 'loop-bild'], { encoding: 'utf8' });
  assert.equal(cli.status, 2);
  assert.equal(cli.stdout, '');
  assert.match(cli.stderr, /^wakeLane: "loop-bild" is not a loop job/);
});

test('wakeLane.mjs names no project of its own', () => {
  assert.doesNotMatch(readFileSync(join(REPO, 'scripts/lib/wakeLane.mjs'), 'utf8'), /spirality|loop-logs|com\./i);
});
