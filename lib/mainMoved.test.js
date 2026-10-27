'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  KINDS, MAIN_MOVED_TRAIL, isNotifyTarget, classify, checkBranch,
  mainMovedComment, findMainMovedNote, latestMainMoved,
} = require('./mainMoved.js');

const OID = 'a'.repeat(40);
const MERGED = { number: 17, url: 'https://github.com/mentor24-maker/spirality/pull/17' };
const PR = { number: 18 };

let nextDate = 1000;
const comment = (text) => ({ id: String(nextDate), date: String(nextDate++), comment_text: text });

// ---------------------------------------------------------------- classify

test('a clean merge touching none of the same files is no-overlap', () => {
  const v = classify({ mergedFiles: ['a.js'], branchFiles: ['b.js'], mergeTree: { status: 0, stdout: OID } });
  assert.equal(v.kind, KINDS.NO_OVERLAP);
});

test('a clean merge touching the same files names them', () => {
  const v = classify({ mergedFiles: ['a.js', 'c.js'], branchFiles: ['c.js', 'b.js'], mergeTree: { status: 0, stdout: OID } });
  assert.deepEqual(v, { kind: KINDS.SAME_FILES, files: ['c.js'], reason: '' });
});

test('a conflict is a tree id followed by the conflicted files', () => {
  const v = classify({ mergedFiles: ['a.js'], branchFiles: ['a.js'], mergeTree: { status: 1, stdout: `${OID}\na.js\n` } });
  assert.deepEqual(v, { kind: KINDS.CONFLICT, files: ['a.js'], reason: '' });
});

test('THE TRAP: exit 1 with nothing on stdout is a failed check, never a conflict or a pass', () => {
  // git merge-tree exits 1 for a branch it cannot find, exactly as for a
  // conflict. Calling that a conflict would send good work back to Rework;
  // calling it clean would be a pass over a check that never ran.
  const v = classify({ mergedFiles: [], branchFiles: [], mergeTree: { status: 1, stdout: '', stderr: 'merge-tree: origin/x - not something we can merge' } });
  assert.equal(v.kind, KINDS.CANNOT_TELL);
  assert.match(v.reason, /not something we can merge/);
});

test('any read that failed is cannot-tell', () => {
  const ok = { status: 0, stdout: OID };
  assert.equal(classify({ mergedFiles: null, branchFiles: [], mergeTree: ok }).kind, KINDS.CANNOT_TELL);
  assert.equal(classify({ mergedFiles: [], branchFiles: null, mergeTree: ok }).kind, KINDS.CANNOT_TELL);
  assert.equal(classify({ mergedFiles: [], branchFiles: [], mergeTree: null }).kind, KINDS.CANNOT_TELL);
  assert.equal(classify({ mergedFiles: [], branchFiles: [], mergeTree: { status: 128, stdout: OID } }).kind, KINDS.CANNOT_TELL);
});

// ---------------------------------------------------------------- who is told

test('only the machine statuses with a branch are told, never Dane\'s', () => {
  assert.ok(isNotifyTarget({ status: { status: 'Building' } }));
  assert.ok(isNotifyTarget({ status: { status: 'in review' } }));
  assert.ok(isNotifyTarget({ status: { status: 'Rework' } }));
  for (const s of ['Queued', 'Ready to launch', 'Needs your input', 'Live']) {
    assert.equal(isNotifyTarget({ status: { status: s } }), false, s);
  }
});

// ---------------------------------------------------------------- the trail

test('the note it writes is the note it reads back, for every kind', () => {
  for (const kind of Object.values(KINDS)) {
    const body = mainMovedComment({ merged: MERGED, pr: PR, base: 'main', verdict: { kind, files: ['x.js'], reason: 'r' } });
    assert.ok(body.startsWith(MAIN_MOVED_TRAIL));
    const got = findMainMovedNote([comment(body)], 17, 18);
    assert.ok(got, kind);
    assert.equal(got.kind, kind);
  }
});

test('it still reads back with the machine stamp appended', () => {
  const body = mainMovedComment({ merged: MERGED, pr: PR, base: 'main', verdict: { kind: KINDS.CONFLICT, files: ['a.js'], reason: '' } });
  assert.ok(findMainMovedNote([comment(`${body}\n\n[machine] posted by a loop`)], 17, 18));
});

test('THE DUPLICATE GUARD is per merge and per PR', () => {
  const body = mainMovedComment({ merged: MERGED, pr: PR, base: 'main', verdict: { kind: KINDS.NO_OVERLAP, files: [], reason: '' } });
  const comments = [comment(body)];
  assert.ok(findMainMovedNote(comments, 17, 18));
  assert.equal(findMainMovedNote(comments, 19, 18), null, 'a later merge is news');
  assert.equal(findMainMovedNote(comments, 17, 20), null, 'a rebuilt PR is news');
});

test('the newest note for the PR is the one a pass acts on', () => {
  const note = (n, kind) => mainMovedComment({ merged: { ...MERGED, number: n }, pr: PR, base: 'main', verdict: { kind, files: [], reason: '' } });
  const comments = [comment(note(17, KINDS.SAME_FILES)), comment('looks fine'), comment(note(19, KINDS.CONFLICT))];
  assert.deepEqual({ ...latestMainMoved(comments, 18), commentId: undefined }, { merged: 19, pr: 18, kind: KINDS.CONFLICT, commentId: undefined });
  assert.equal(latestMainMoved(comments, 99), null);
  assert.equal(latestMainMoved([comment('PR opened: x')], 18), null);
});

test('a conflict note names the files and says what happens next', () => {
  const body = mainMovedComment({ merged: MERGED, pr: PR, base: 'main', verdict: { kind: KINDS.CONFLICT, files: ['lib/a.js'], reason: '' } });
  assert.match(body, /`lib\/a\.js`/);
  assert.match(body, /straight back to Rework/);
});

// ---------------------------------------------------------------- real git

const git = (cwd, ...args) => {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};

/** A bare "origin" and a clone with origin/main and two branches off its first commit. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'main-moved-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, work);
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) git(work, 'config', k, v);
  const write = (f, s) => fs.writeFileSync(path.join(work, f), s);
  write('shared.txt', 'one\n'); write('a.txt', 'a\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'start'); git(work, 'push', '-q', 'origin', 'HEAD:main');
  const branch = (name, edits) => {
    git(work, 'checkout', '-q', '-B', name, 'origin/main');
    for (const [f, s] of edits) write(f, s);
    git(work, 'add', '.'); git(work, 'commit', '-qm', name); git(work, 'push', '-q', 'origin', `HEAD:${name}`);
  };
  branch('clashes', [['shared.txt', 'clash\n']]);
  branch('apart', [['b.txt', 'b\n']]);
  branch('beside', [['a.txt', 'a\n'], ['c.txt', 'c\n'], ['shared.txt', 'one\n'], ['d.txt', 'd\n']]);
  // The "merged PR": a squash commit on main changing shared.txt.
  git(work, 'checkout', '-q', '-B', 'main', 'origin/main');
  write('shared.txt', 'merged\n'); write('c.txt', 'c\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'squash'); git(work, 'push', '-q', 'origin', 'HEAD:main');
  git(work, 'fetch', '-q', 'origin');
  return { root, work, mergeCommit: git(work, 'rev-parse', 'HEAD') };
}

test('against a real repository: conflict, no-overlap, same-files and a missing branch', (t) => {
  const { root, work, mergeCommit } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const check = (branch) => checkBranch({ base: 'main', branch, mergeCommit, cwd: work });

  const clash = check('clashes');
  assert.equal(clash.kind, KINDS.CONFLICT);
  assert.deepEqual(clash.files, ['shared.txt']);

  assert.equal(check('apart').kind, KINDS.NO_OVERLAP);

  const beside = check('beside');
  assert.equal(beside.kind, KINDS.SAME_FILES);
  assert.deepEqual(beside.files, ['c.txt']);

  assert.equal(check('no-such-branch').kind, KINDS.CANNOT_TELL);

  // Nothing was checked out or written: the clone is where it was, and clean.
  assert.equal(git(work, 'rev-parse', 'HEAD'), mergeCommit);
  assert.equal(git(work, 'status', '--porcelain'), '');
});
