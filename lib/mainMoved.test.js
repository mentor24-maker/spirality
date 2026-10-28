'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  KINDS, MAIN_MOVED_TRAIL, isNotifyTarget, classify, checkBranch, branchContains, tellTickets,
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

  // A branch that already merged main in holds the merge commit: nothing to tell.
  git(work, 'checkout', '-q', '-B', 'caught-up', 'origin/apart');
  git(work, 'merge', '-q', '--no-edit', 'origin/main');
  git(work, 'push', '-q', 'origin', 'HEAD:caught-up');
  git(work, 'checkout', '-q', 'main');
  git(work, 'fetch', '-q', 'origin');
  const contains = (branch) => branchContains({ branch, mergeCommit, cwd: work });
  assert.equal(contains('caught-up'), true);
  assert.equal(contains('apart'), false);
  assert.equal(contains('no-such-branch'), null);

  // Nothing was checked out or written: the clone is where it was, and clean.
  assert.equal(git(work, 'rev-parse', 'HEAD'), mergeCommit);
  assert.equal(git(work, 'status', '--porcelain'), '');
});

// ---------------------------------------------------------------- tellTickets

const REPO = 'mentor24-maker/spirality';
const MERGE = { ...MERGED, oid: OID };
const prLink = (n) => comment(`PR opened: https://github.com/${REPO}/pull/${n}`);
const findPr = (comments) => {
  for (const c of comments) {
    const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(c.comment_text || '');
    if (m) return { owner: m[1], repo: m[2], number: Number(m[3]) };
  }
  return null;
};

/** A fake tracker: per-ticket comments and statuses, with failures on demand. */
function fakeIo({ trails, statuses = {}, failRead = new Set(), verdict = { kind: KINDS.SAME_FILES, files: ['x.js'], reason: '' }, contains = false }) {
  const posted = [];
  let nextId = 5000;
  return {
    posted,
    io: {
      readComments: async (id) => (failRead.has(id) ? { problem: 'HTTP 500' } : { comments: trails[id] || [] }),
      readStatus: async (id) => (id in statuses ? statuses[id] : 'in review'),
      postNote: async (id, text) => {
        const c = { id: String(nextId), date: String(nextId++), comment_text: text };
        (trails[id] = trails[id] || []).push(c);
        posted.push({ id, text });
        return { ok: true, id: c.id };
      },
      findPullRequest: findPr,
      contains: () => contains,
      check: () => verdict,
    },
  };
}

const ticket = (id, status = 'in review') => ({ id, name: `ticket ${id}`, status: { status } });
const OPEN = new Map([[18, 'b18'], [19, 'b19'], [20, 'b20']]);
const run = (tasks, io, dryRun = false) => tellTickets({ tasks, merge: MERGE, base: 'main', repo: REPO, openPrs: OPEN, dryRun, io });

test('tellTickets: a failed comment read on one ticket is a problem, and the next ticket is still told', async () => {
  const { io, posted } = fakeIo({ trails: { A: [prLink(18)], B: [prLink(19)] }, failRead: new Set(['A']) });
  const out = await run([ticket('A'), ticket('B')], io);
  assert.equal(out.told, 1);
  assert.deepEqual(posted.map((p) => p.id), ['B']);
  assert.equal(out.problems.length, 1);
  assert.match(out.problems[0], /^A: its comments could not be read/);
});

test('tellTickets: a ticket moved to one of Dane\'s statuses since the list was read is not told', async () => {
  const { io, posted } = fakeIo({ trails: { A: [prLink(18)], B: [prLink(19)] }, statuses: { A: 'ready to launch', B: 'needs your input' } });
  const out = await run([ticket('A'), ticket('B', 'rework')], io);
  assert.equal(out.told, 0);
  assert.deepEqual(posted, []);
  assert.deepEqual(out.problems, []);
  assert.ok(out.lines.every((l) => /not told/.test(l)));
});

test('tellTickets: a ticket that cannot be re-read before posting is a problem, never a post', async () => {
  const { io, posted } = fakeIo({ trails: { A: [prLink(18)] }, statuses: { A: null } });
  const out = await run([ticket('A')], io);
  assert.deepEqual(posted, []);
  assert.match(out.problems[0], /could not be re-read/);
});

test('tellTickets: Dane\'s statuses in the list are never even looked at', async () => {
  const { io, posted } = fakeIo({ trails: { A: [prLink(18)] } });
  const out = await run([ticket('A', 'ready to launch'), ticket('B', 'needs your input')], io);
  assert.deepEqual(posted, []);
  assert.deepEqual(out.lines, []);
});

test('tellTickets: one note per merge per PR — a second run posts nothing', async () => {
  const trails = { A: [prLink(18)] };
  const first = fakeIo({ trails });
  assert.equal((await run([ticket('A')], first.io)).told, 1);
  const second = fakeIo({ trails });
  const out = await run([ticket('A')], second.io);
  assert.equal(out.told, 0);
  assert.deepEqual(second.posted, []);
  assert.match(out.lines[0], /already told/);
});

test('tellTickets: a branch that already holds the merge is not told', async () => {
  const { io, posted } = fakeIo({ trails: { A: [prLink(18)] }, contains: true });
  const out = await run([ticket('A')], io);
  assert.deepEqual(posted, []);
  assert.match(out.lines[0], /already contains PR #17/);
});

test('tellTickets: dry run posts nothing', async () => {
  const { io, posted } = fakeIo({ trails: { A: [prLink(18)] } });
  const out = await run([ticket('A')], io, true);
  assert.deepEqual(posted, []);
  assert.match(out.lines[0], /would tell: same-files \(x\.js\)/);
});

test('tellTickets: the read-back must find the comment id just posted, not an older note', async () => {
  // An older note for the same pair exists only after the dedupe read, so the
  // post goes ahead; the post "succeeds" with an id that never shows up.
  const trails = { A: [prLink(18)] };
  const { io } = fakeIo({ trails });
  let reads = 0;
  io.readComments = async () => {
    reads += 1;
    return { comments: reads === 1 ? trails.A : [...trails.A, comment(`${MAIN_MOVED_TRAIL} PR #17 -> PR #18 — same-files`)] };
  };
  io.postNote = async () => ({ ok: true, id: 'never-stored' });
  const out = await run([ticket('A')], io);
  assert.equal(out.told, 0);
  assert.match(out.problems[0], /does not read back/);
});

test('tellTickets: a failed post or a throw on one ticket is reported, and the pass carries on', async () => {
  const { io, posted } = fakeIo({ trails: { A: [prLink(18)], B: [prLink(19)], C: [prLink(20)] } });
  const post = io.postNote;
  io.postNote = async (id, text) => (id === 'A' ? { ok: false, problem: 'HTTP 429' } : post(id, text));
  const check = io.check;
  io.check = ({ branch }) => { if (branch === 'b19') throw new Error('boom'); return check({ branch }); };
  const out = await run([ticket('A'), ticket('B'), ticket('C')], io);
  assert.equal(out.told, 1);
  assert.deepEqual(posted.map((p) => p.id), ['C']);
  assert.equal(out.problems.length, 2);
  assert.match(out.problems[0], /FAILED to post \(HTTP 429\)/);
  assert.match(out.problems[1], /^B: boom/);
});
