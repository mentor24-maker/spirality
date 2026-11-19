// back_to_main_if_merged (scripts/lib/back_to_main.sh) against real scratch
// repositories: a bare "origin" and a clone of it standing in for a project's
// main checkout on the Mini, left on its setup branch (SP-111).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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

test('back on main, the checkout is at origin\'s main, not the stale one from before the setup branch', () => {
  const { dir, origin, checkout } = scratch();
  // The setup branch merges into main at origin, then is deleted.
  const merger = join(dir, 'merger');
  git(dir, 'clone', '-q', origin, merger);
  git(merger, 'merge', '-q', '--ff-only', 'origin/setup');
  git(merger, 'push', '-q', 'origin', 'main');
  git(origin, 'branch', '-D', 'setup');
  const r = run(checkout);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.branch, 'main');
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'main'));
  assert.equal(readFileSync(join(checkout, 'b.txt'), 'utf8'), 'two\n');
});

test('a branch gone from origin with a changed tracked file stays put, says so naming the file, and keeps the change', () => {
  const { origin, checkout } = scratch();
  git(origin, 'branch', '-D', 'setup');
  writeFileSync(join(checkout, 'b.txt'), 'somebody is working here\n');
  const r = run(checkout);
  assert.equal(r.status, 1);
  assert.equal(r.out, 'setup no longer exists on origin, but the tree has changes (b.txt) — staying on it');
  assert.equal(r.branch, 'setup');
  assert.equal(readFileSync(join(checkout, 'b.txt'), 'utf8'), 'somebody is working here\n');
});

// SP-393: PressPlay's checkout sat on its merged setup branch for 13 days over
// nothing but an untracked .claude/worktrees/ folder.
test('a branch gone from origin with only an untracked folder goes back to main at origin\'s latest, and the folder is kept', () => {
  const { dir, origin, checkout } = scratch();
  const merger = join(dir, 'merger');
  git(dir, 'clone', '-q', origin, merger);
  git(merger, 'merge', '-q', '--ff-only', 'origin/setup');
  git(merger, 'push', '-q', 'origin', 'main');
  git(origin, 'branch', '-D', 'setup');
  mkdirSync(join(checkout, '.claude', 'worktrees', 'some-task'), { recursive: true });
  writeFileSync(join(checkout, '.claude', 'worktrees', 'some-task', 'work.txt'), 'kept\n');
  const r = run(checkout);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.branch, 'main');
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'main'));
  assert.match(r.out, /^setup no longer exists on origin and the tree is clean — back to main$/);
  assert.equal(readFileSync(join(checkout, '.claude', 'worktrees', 'some-task', 'work.txt'), 'utf8'), 'kept\n');
});

test('an untracked file that main tracks makes the checkout refuse: it stays put, says it failed, and the file is kept', () => {
  const { origin, checkout } = scratch();
  // The local main gains c.txt; the setup branch never had it.
  git(checkout, 'checkout', '-q', 'main');
  writeFileSync(join(checkout, 'c.txt'), 'main\'s copy\n');
  git(checkout, 'add', 'c.txt');
  git(checkout, 'commit', '-q', '-m', 'three');
  git(checkout, 'checkout', '-q', 'setup');
  writeFileSync(join(checkout, 'c.txt'), 'untracked here\n');
  git(origin, 'branch', '-D', 'setup');
  const r = run(checkout);
  assert.equal(r.status, 1);
  assert.equal(r.branch, 'setup');
  assert.equal(r.out, 'setup no longer exists on origin, but checking out main FAILED — staying on setup');
  assert.equal(readFileSync(join(checkout, 'c.txt'), 'utf8'), 'untracked here\n');
});

test('a branch still on origin with changes, tracked or untracked, is left alone, silently', () => {
  const { checkout } = scratch();
  writeFileSync(join(checkout, 'b.txt'), 'somebody is working here\n');
  writeFileSync(join(checkout, 'new.txt'), 'x\n');
  const r = run(checkout);
  assert.equal(r.status, 1);
  assert.equal(r.out, '');
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

// SP-393 review: both runners used to guard step 0 on `git status --porcelain`
// being empty, which counts untracked files, so the fixed helper was never
// reached for an untracked-only checkout. Run each runner's real guard.
function stepZeroGuard(name) {
  const lines = readFileSync(join(HERE, '..', name), 'utf8').split('\n');
  const call = lines.findIndex((l) => l.includes('MOVED="$(back_to_main_if_merged)"'));
  assert.ok(call > 0, `${name} calls back_to_main_if_merged`);
  const guard = lines.slice(0, call).reverse().find((l) => /^\s*if \[/.test(l));
  const m = guard && guard.match(/^\s*if (.*); then\s*$/);
  assert.ok(m, `${name} has an if-guard before the call`);
  return m[1];
}

for (const name of ['loop_runner.sh', 'run_relay.sh']) {
  test(`${name}'s step-0 guard reaches the helper on a gone branch with untracked files only, or a tracked change`, () => {
    const guard = stepZeroGuard(name);
    assert.doesNotMatch(guard, /git status/, `${name} leaves the tree check to the helper`);
    const { origin, checkout } = scratch();
    git(origin, 'branch', '-D', 'setup');
    mkdirSync(join(checkout, '.claude', 'worktrees'), { recursive: true });
    writeFileSync(join(checkout, '.claude', 'worktrees', 'x.txt'), 'x\n');
    const passes = () => spawnSync('bash', ['-c', guard], { cwd: checkout, env: scratchGitEnv() }).status;
    assert.equal(passes(), 0, 'untracked-only checkout reaches the helper');
    writeFileSync(join(checkout, 'b.txt'), 'changed\n');
    assert.equal(passes(), 0, 'a tracked change reaches the helper, which names it');
    const r = run(checkout);
    assert.equal(r.out, 'setup no longer exists on origin, but the tree has changes (b.txt) — staying on it');
    git(checkout, 'checkout', '-q', '--', 'b.txt');
    assert.equal(run(checkout).branch, 'main');
    assert.equal(passes(), 1, 'a checkout on main skips step 0');
  });
}
