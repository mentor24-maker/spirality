// back_to_main_if_merged (scripts/lib/back_to_main.sh) against real scratch
// repositories: a bare "origin" and a clone of it standing in for a product's
// main checkout on the Mini, left on its setup branch (SP-111).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { git, scratchGitEnv } = require('../../lib/scratchGit.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, 'back_to_main.sh');

// origin with a main and a setup branch; a checkout of it on the setup branch.
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'back-to-main-'));
  const origin = join(dir, 'origin.git');
  const seed = join(dir, 'seed');
  const checkout = join(dir, 'checkout');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'init', '-q', '-b', 'main', seed);
  writeFileSync(join(seed, 'a.txt'), 'one\n');
  git(seed, 'add', 'a.txt');
  git(seed, 'commit', '-q', '-m', 'one');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'checkout', '-q', '-b', 'setup');
  writeFileSync(join(seed, 'b.txt'), 'two\n');
  git(seed, 'add', 'b.txt');
  git(seed, 'commit', '-q', '-m', 'two');
  git(seed, 'push', '-q', 'origin', 'setup');
  git(dir, 'clone', '-q', origin, checkout);
  git(checkout, 'checkout', '-q', 'setup');
  return { dir, origin, checkout };
}

function run(cwd) {
  const r = spawnSync('bash', ['-c', 'source "$1"; back_to_main_if_merged', 'x', LIB], {
    cwd,
    encoding: 'utf8',
    // The function's own git calls get the cleaned environment (SP-104).
    env: scratchGitEnv(),
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr, branch: git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD') };
}

test('a branch still on origin is left alone, silently', () => {
  const { checkout } = scratch();
  const r = run(checkout);
  assert.equal(r.status, 1);
  assert.equal(r.out, '');
  assert.equal(r.branch, 'setup');
});

test('a branch gone from origin, with a clean tree, goes back to main and says so', () => {
  const { origin, checkout } = scratch();
  git(origin, 'branch', '-D', 'setup');
  const r = run(checkout);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.branch, 'main');
  assert.match(r.out, /^setup no longer exists on origin and the tree is clean — back to main$/);
});

test('a branch gone from origin with a dirty tree is left alone, and the change is kept', () => {
  const { origin, checkout } = scratch();
  git(origin, 'branch', '-D', 'setup');
  writeFileSync(join(checkout, 'b.txt'), 'somebody is working here\n');
  const r = run(checkout);
  assert.equal(r.status, 1);
  assert.equal(r.out, '');
  assert.equal(r.branch, 'setup');
  assert.equal(readFileSync(join(checkout, 'b.txt'), 'utf8'), 'somebody is working here\n');
});

test('an untracked file counts as a dirty tree', () => {
  const { origin, checkout } = scratch();
  git(origin, 'branch', '-D', 'setup');
  writeFileSync(join(checkout, 'new.txt'), 'x\n');
  const r = run(checkout);
  assert.equal(r.status, 1);
  assert.equal(r.branch, 'setup');
});

test('an origin that cannot be asked is "could not tell", never "gone"', () => {
  const { dir, checkout } = scratch();
  git(checkout, 'remote', 'set-url', 'origin', join(dir, 'no-such-origin.git'));
  const r = run(checkout);
  assert.equal(r.status, 1);
  assert.equal(r.branch, 'setup');
  assert.match(r.out, /^could not tell whether setup still exists on origin \(git ls-remote exit \d+\) — staying on it$/);
});

test('a checkout already on main is a quiet success', () => {
  const { checkout } = scratch();
  git(checkout, 'checkout', '-q', 'main');
  const r = run(checkout);
  assert.equal(r.status, 0);
  assert.equal(r.out, '');
});

test('a detached HEAD is left alone', () => {
  const { checkout } = scratch();
  git(checkout, 'checkout', '-q', '--detach');
  const r = run(checkout);
  assert.equal(r.status, 1);
  assert.equal(r.out, '');
  assert.equal(r.branch, 'HEAD');
});

test('both runners source the helper before their pull', () => {
  for (const name of ['loop_runner.sh', 'run_relay.sh']) {
    const text = readFileSync(join(HERE, '..', name), 'utf8');
    const source = text.indexOf('source "$REPO/scripts/lib/back_to_main.sh"');
    const call = text.indexOf('back_to_main_if_merged');
    const pull = text.indexOf('git pull -q --ff-only origin main');
    assert.ok(source > 0, `${name} sources back_to_main.sh`);
    assert.ok(call > source && call < pull, `${name} calls it after sourcing and before the pull`);
    assert.match(text, /back to main/, `${name} says what the step is for`);
  }
});
