'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { doorSource, skipWithoutDoor } = require('./productScripts.js');

const {
  CODES,
  parseRepoFromRemoteUrl,
  catchUpBranchLocally,
} = require('./branchCatchUp');

/**
 * The relay handed twelve PRs to a human in one day for conflicts that were
 * not conflicts. This module lets it ask the machine it is running on instead
 * of taking GitHub's word.
 *
 * The centrepiece is a REAL git repository, not a mock — a mocked git would
 * happily confirm any premise written into it. (The original premise test,
 * that the asset-pin driver turned a conflicting merge clean, retired with
 * the pins themselves on 2026-08-24, task 86bbkh288.)
 *
 * The mocked tests cover the decision table around that: every way the check
 * can fail must hand over, and none of them may report clean.
 */

// ── A real repository, built to reproduce the exact failure ───────────────

function git(args, cwd) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: out.status === 0, stdout: String(out.stdout || '').trim(), stderr: String(out.stderr || '').trim() };
}

/**
 * A bare "origin" plus a working clone. The branch and main each add their own
 * file (a clean catch-up); with alsoConflictForReal they both edit the same
 * line of the same file (a genuine conflict a script must hand over).
 */
function buildRepo({ alsoConflictForReal = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-catchup-test-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');

  git(['init', '--bare', '-b', 'main', origin], root);
  git(['clone', origin, work], root);
  git(['config', 'user.email', 'test@example.com'], work);
  git(['config', 'user.name', 'Test'], work);

  fs.writeFileSync(path.join(work, 'site.html'), '<html>\n<p>shared</p>\n</html>\n');
  fs.writeFileSync(path.join(work, 'other.txt'), 'base\n');
  git(['add', '-A'], work);
  git(['commit', '-m', 'base'], work);
  git(['push', 'origin', 'main'], work);

  // The branch: its own file.
  git(['checkout', '-b', 'feature'], work);
  fs.writeFileSync(path.join(work, 'feature.txt'), 'feature work\n');
  if (alsoConflictForReal) fs.writeFileSync(path.join(work, 'other.txt'), 'branch version\n');
  git(['add', '-A'], work);
  git(['commit', '-m', 'feature'], work);
  git(['push', 'origin', 'feature'], work);

  // main moves on: its own file too, so the branch is BEHIND but clean.
  git(['checkout', 'main'], work);
  fs.writeFileSync(path.join(work, 'main.txt'), 'main moved\n');
  if (alsoConflictForReal) fs.writeFileSync(path.join(work, 'other.txt'), 'main version\n');
  git(['add', '-A'], work);
  git(['commit', '-m', 'main moves'], work);
  git(['push', 'origin', 'main'], work);

  return { root, origin, work };
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}

test('a branch that is merely behind is caught up and pushed', (t) => {
  const repo = buildRepo();
  t.after(() => cleanup(repo.root));

  const before = git(['rev-parse', 'origin/feature'], repo.work).stdout;
  const out = catchUpBranchLocally({ repo: '', branch: 'feature', cwd: repo.work });

  assert.equal(out.code, CODES.CLEAN, out.reason);
  assert.equal(out.ok, true);

  git(['fetch', 'origin'], repo.work);
  const after = git(['rev-parse', 'origin/feature'], repo.work).stdout;
  assert.notEqual(after, before, 'the branch must actually have moved on the remote');

  // And it now contains main — the thing the whole exercise was for.
  const contains = git(['merge-base', '--is-ancestor', 'origin/main', 'origin/feature'], repo.work);
  assert.equal(contains.ok, true, 'the caught-up branch must contain main');
});

test('the push is a fast-forward — the branch only ever gains commits', (t) => {
  const repo = buildRepo();
  t.after(() => cleanup(repo.root));

  const before = git(['rev-parse', 'origin/feature'], repo.work).stdout;
  assert.equal(catchUpBranchLocally({ repo: '', branch: 'feature', cwd: repo.work }).ok, true);
  git(['fetch', 'origin'], repo.work);

  // The old head is still an ancestor. A rebase or a force-push would have
  // discarded it, and a force-push inside a script is invisible to the
  // operator's own deny rule (DOCTRINE 6.6).
  const kept = git(['merge-base', '--is-ancestor', before, 'origin/feature'], repo.work);
  assert.equal(kept.ok, true, 'the previous branch head must survive — nothing may be rewritten');
});

test('a REAL conflict is refused, named, and leaves the branch untouched', (t) => {
  const repo = buildRepo({ alsoConflictForReal: true });
  t.after(() => cleanup(repo.root));

  const before = git(['rev-parse', 'origin/feature'], repo.work).stdout;
  const out = catchUpBranchLocally({ repo: '', branch: 'feature', cwd: repo.work });

  assert.equal(out.code, CODES.REAL_CONFLICT);
  assert.equal(out.ok, false);
  assert.ok(out.files.includes('other.txt'), `should name the overlapping file, got ${JSON.stringify(out.files)}`);

  git(['fetch', 'origin'], repo.work);
  assert.equal(git(['rev-parse', 'origin/feature'], repo.work).stdout, before, 'nothing may be pushed on a real conflict');
});

test('the scratch worktree is always cleaned up, conflict or not', (t) => {
  const repo = buildRepo({ alsoConflictForReal: true });
  t.after(() => cleanup(repo.root));

  catchUpBranchLocally({ repo: '', branch: 'feature', cwd: repo.work });
  const list = git(['worktree', 'list'], repo.work).stdout;
  assert.equal(list.split('\n').filter(Boolean).length, 1, `only the main worktree should remain:\n${list}`);
});

// ── The decision table, with git stubbed out ──────────────────────────────

function stubGit(overrides = {}) {
  return (args) => {
    const key = args.slice(0, 2).join(' ');
    if (args[0] === 'remote') return { ok: true, stdout: 'git@github.com:me/starcaster.git', stderr: '' };
    if (args[0] === 'config') return { ok: true, stdout: 'node driver', stderr: '' };
    if (overrides[key]) return overrides[key];
    if (overrides[args[0]]) return overrides[args[0]];
    return { ok: true, stdout: '', stderr: '' };
  };
}

const STUB_OPTS = {
  cwd: '/nowhere',
  makeTempDir: () => '/nowhere/tmp',
  removeDir: () => {},
};

test('a PR on another repo is never caught up from this checkout', () => {
  const out = catchUpBranchLocally({ repo: 'me/normie', branch: 'x', runGit: stubGit(), ...STUB_OPTS });
  assert.equal(out.code, CODES.WRONG_REPO);
  assert.match(out.reason, /me\/starcaster/);
});

test('the right repo passes the repo check regardless of URL style', () => {
  for (const url of [
    'git@github.com:me/starcaster.git',
    'https://github.com/me/starcaster',
    'https://github.com/me/starcaster.git',
  ]) {
    assert.equal(parseRepoFromRemoteUrl(url), 'me/starcaster', url);
  }
  assert.equal(parseRepoFromRemoteUrl(''), '');
  assert.equal(parseRepoFromRemoteUrl('not a url'), '');
});

test('an unreadable remote is treated as the wrong repo, not as a match', () => {
  const run = (args) => (args[0] === 'remote'
    ? { ok: false, stdout: '', stderr: 'no origin' }
    : { ok: true, stdout: 'x', stderr: '' });
  const out = catchUpBranchLocally({ repo: 'me/starcaster', branch: 'x', runGit: run, ...STUB_OPTS });
  assert.equal(out.code, CODES.WRONG_REPO);
});

test('a failed fetch hands over instead of merging stale refs', () => {
  const out = catchUpBranchLocally({
    repo: 'me/starcaster', branch: 'x',
    runGit: stubGit({ fetch: { ok: false, stdout: '', stderr: 'network down' } }),
    ...STUB_OPTS,
  });
  assert.equal(out.code, CODES.FETCH_FAILED);
  assert.match(out.reason, /network down/);
});

test('a failed worktree hands over', () => {
  const out = catchUpBranchLocally({
    repo: 'me/starcaster', branch: 'x',
    runGit: stubGit({ worktree: { ok: false, stdout: '', stderr: 'no space' } }),
    ...STUB_OPTS,
  });
  assert.equal(out.code, CODES.WORKTREE_FAILED);
});

test('a merge that does not contain main is refused, not pushed', () => {
  const pushes = [];
  const run = (args) => {
    if (args[0] === 'push') { pushes.push(args); return { ok: true, stdout: '', stderr: '' }; }
    if (args[0] === 'merge-base') return { ok: false, stdout: '', stderr: '' };
    return stubGit()(args);
  };
  const out = catchUpBranchLocally({ repo: 'me/starcaster', branch: 'x', runGit: run, ...STUB_OPTS });
  assert.equal(out.code, CODES.NOT_ANCESTOR);
  assert.equal(pushes.length, 0, 'nothing may be pushed when the sanity check fails');
});

test('a rejected push hands over and says the next pass will retry', () => {
  const out = catchUpBranchLocally({
    repo: 'me/starcaster', branch: 'x',
    runGit: stubGit({ push: { ok: false, stdout: '', stderr: 'non-fast-forward' } }),
    ...STUB_OPTS,
  });
  assert.equal(out.code, CODES.PUSH_FAILED);
  assert.match(out.reason, /next pass/);
});

test('NO failure path ever reports ok — the whole safety rule, in one assertion', () => {
  const failures = [
    { label: 'wrong repo', opts: { repo: 'me/other', runGit: stubGit() } },
    { label: 'fetch', opts: { runGit: stubGit({ fetch: { ok: false, stdout: '', stderr: 'x' } }) } },
    { label: 'worktree', opts: { runGit: stubGit({ worktree: { ok: false, stdout: '', stderr: 'x' } }) } },
    { label: 'merge', opts: { runGit: stubGit({ merge: { ok: false, stdout: '', stderr: 'x' } }) } },
    { label: 'ancestor', opts: { runGit: stubGit({ 'merge-base': { ok: false, stdout: '', stderr: '' } }) } },
    { label: 'push', opts: { runGit: stubGit({ push: { ok: false, stdout: '', stderr: 'x' } }) } },
    { label: 'no branch', opts: { branch: '', runGit: stubGit() } },
  ];
  for (const f of failures) {
    const out = catchUpBranchLocally({ repo: 'me/starcaster', branch: 'x', ...STUB_OPTS, ...f.opts });
    assert.equal(out.ok, false, `${f.label} must not report ok`);
    assert.notEqual(out.code, CODES.CLEAN, `${f.label} must not report clean`);
    assert.ok(out.reason, `${f.label} must say why`);
  }
});

test('the relay asks locally before handing a conflict over', (t) => {
  if (skipWithoutDoor(t)) return;
  const src = doorSource() || '';
  const ask = src.indexOf('catchUpBranchLocally');
  const handOff = src.indexOf("if (gate.action === 'conflict') {");
  assert.ok(ask > -1, 'the relay must consult the local check');
  assert.ok(handOff > -1, 'the hand-off must still exist');
  assert.ok(ask < handOff, 'the local check runs BEFORE the hand-off, or it changes nothing');
  assert.match(src, /gate\.action === 'conflict' && !dryRun/, 'a dry run must never push anything');
});

test('this script contains no force-push, in any spelling', () => {
  // The same guard scripts/builder/shipThread.test.js carries, because that
  // one only ever covered shipThread.js — and this is now a SECOND script in
  // the repo that pushes. A force-push buried in a node script is invisible to
  // the operator's `Bash(git push --force*)` deny rule, and a convenience
  // command does not get to route around a standing decision (DOCTRINE 6.6).
  const lines = fs.readFileSync(path.join(__dirname, 'branchCatchUp.js'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'));
  const code = lines.join('\n');

  // Scoped to the PUSH, deliberately. A first draft of this assertion banned
  // "--force" outright and failed on `worktree remove --force`, which throws
  // away a scratch directory and has nothing to do with rewriting history.
  // A guard that cries wolf on the safe case gets loosened by the next person
  // who trips it, and then it covers nothing.
  const pushLines = lines.filter((l) => /'push'/.test(l));
  assert.ok(pushLines.length, 'this test is worthless if the push line ever moves — find it or fix this');
  for (const line of pushLines) {
    assert.doesNotMatch(line, /--force/, `push must never force: ${line.trim()}`);
  }
  assert.doesNotMatch(code, /--force-with-lease/, 'no --force-with-lease anywhere');
  assert.doesNotMatch(code, /'rebase'/, 'it catches up by merging, not rebasing — that is what removes the need to force');
});
