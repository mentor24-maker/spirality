'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const {
  REPOSITORY_VARIABLES, scratchGitEnv, forgetOuterRepository, git,
} = require('./scratchGit.js');

const REPO = path.join(__dirname, '..');

/**
 * What a commit hook hands its child: GIT_DIR and GIT_INDEX_FILE pointing at
 * the repository being committed. Here that is a decoy with one commit, whose
 * log, refs and config are read before and after to prove nothing touched it
 * (SP-104: in Normie the real one gained a scratch commit and `user.name=T`).
 */
function decoy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-git-decoy-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'the real work');
  const gitDir = path.join(dir, '.git');
  const env = { GIT_DIR: gitDir, GIT_INDEX_FILE: path.join(gitDir, 'index') };
  const snapshot = () => ({
    log: git(dir, 'log', '--all', '--format=%H %s'),
    refs: git(dir, 'for-each-ref'),
    config: fs.readFileSync(path.join(gitDir, 'config'), 'utf8'),
  });
  return { dir, env, snapshot, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the cleaned environment drops every repository-pointing variable and keeps the rest', () => {
  const env = { PATH: '/bin', HOME: '/h', GIT_AUTHOR_NAME: 'kept' };
  for (const name of REPOSITORY_VARIABLES) env[name] = `/elsewhere/${name}`;
  const out = scratchGitEnv(env);
  for (const name of REPOSITORY_VARIABLES) assert.ok(!(name in out), `${name} is gone`);
  assert.deepEqual(out, { PATH: '/bin', HOME: '/h', GIT_AUTHOR_NAME: 'kept' });
  assert.equal(env.GIT_DIR, '/elsewhere/GIT_DIR', 'the copy, not the original, is cleaned');

  forgetOuterRepository(env);
  assert.deepEqual(env, out, 'forgetOuterRepository cleans in place');
});

test('a scratch commit lands in the scratch repository, with GIT_DIR naming another', (t) => {
  const d = decoy();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-git-'));
  const saved = { ...process.env };
  t.after(() => {
    for (const name of REPOSITORY_VARIABLES) delete process.env[name];
    Object.assign(process.env, saved);
    d.cleanup();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const before = d.snapshot();
  Object.assign(process.env, d.env);

  git(scratch, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(scratch, 'a.txt'), 'a\n');
  git(scratch, 'add', '.');
  git(scratch, 'commit', '-qm', 'scratch');

  assert.equal(git(scratch, 'log', '--format=%s %an'), 'scratch Test');
  assert.doesNotMatch(fs.readFileSync(path.join(scratch, '.git', 'config'), 'utf8'), /\[user\]|gpgsign/,
    'the identity rode on -c flags, not in any config file');
  for (const name of REPOSITORY_VARIABLES) delete process.env[name];
  assert.deepEqual(d.snapshot(), before, 'the decoy repository is byte-identical');
});

// The acceptance check: the four tests that make their own git repositories,
// run the way a commit hook would run them.
test('the four git-repository tests pass from inside a commit hook and leave its repository untouched', { timeout: 120_000 }, (t) => {
  const d = decoy();
  t.after(d.cleanup);
  const before = d.snapshot();
  const files = [
    'lib/mainMoved.test.js',
    'lib/branchCatchUp.test.js',
    'scripts/lib/loopLanes.test.mjs',
    'scripts/tracker/apiTracker.test.mjs',
  ];
  // NODE_TEST_CONTEXT would make the inner run report to this one, not print.
  const { NODE_TEST_CONTEXT, ...outer } = scratchGitEnv();
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
    cwd: REPO, encoding: 'utf8', env: { ...outer, ...d.env },
  });
  assert.equal(r.status, 0, `the tests failed under a commit hook's environment:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^# fail 0$/m);
  assert.deepEqual(d.snapshot(), before, 'the repository the hook named gained nothing: no commit, no ref, no config line');
});
