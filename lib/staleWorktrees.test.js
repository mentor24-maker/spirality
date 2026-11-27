'use strict';

// SP-421: `npm run clickup -- stale-worktrees` lists every worktree under
// .claude/worktrees/ with what it belongs to and a flag. lib/staleWorktrees.js
// decides; these tests pass it a fake porcelain listing and fake pull request
// and ticket readings.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sw = require('./staleWorktrees.js');

const MAIN = '/Users/x/WebApps/proj';
const LISTING = [
  `worktree ${MAIN}\nHEAD aaa\nbranch refs/heads/main\n`,
  `worktree ${MAIN}/.claude/worktrees/merged-one\nHEAD bbb\nbranch refs/heads/merged-one\n`,
  `worktree ${MAIN}/.claude/worktrees/closed-one\nHEAD ccc\nbranch refs/heads/closed-one\n`,
  `worktree ${MAIN}/.claude/worktrees/live-one\nHEAD ddd\nbranch refs/heads/live-one\n`,
  `worktree ${MAIN}/.claude/worktrees/review-one\nHEAD eee\nbranch refs/heads/review-one\n`,
  `worktree ${MAIN}/.claude/worktrees/dead-pass\nHEAD fff\nbranch refs/heads/dead-pass\n`,
  `worktree ${MAIN}/.claude/worktrees/loose-head\nHEAD 999\ndetached\n`,
  `worktree /Users/x/loop-logs/releases/release-2\nHEAD 111\ndetached\n`,
  `worktree ${MAIN}/.claude/worktrees/nested/deeper\nHEAD 222\nbranch refs/heads/deeper\n`,
].join('\n');

const body = (id) => `Summary\n\nTicket: http://mac-mini.local:4180/t/${id}\n`;
const PRS = [
  { number: 10, state: 'MERGED', headRefName: 'merged-one', body: body('SP-10') },
  { number: 11, state: 'CLOSED', headRefName: 'closed-one', body: body('SP-11') },
  { number: 12, state: 'OPEN', headRefName: 'live-one', body: body('SP-12') },
  { number: 13, state: 'OPEN', headRefName: 'review-one', body: body('SP-13') },
];
const worktree = (branch, more = {}) => ({ path: `${MAIN}/.claude/worktrees/${branch || 'x'}`, branch, detached: !branch, pushed: true, dirty: false, ...more });
const ticket = (id, status) => ({ id, status: { status } });

test('the porcelain listing parses to path, branch and detached, main checkout first', () => {
  const entries = sw.parseWorktreeList(LISTING);
  assert.equal(entries.length, 9);
  assert.deepEqual(entries[0], { path: MAIN, head: 'aaa', branch: 'main', detached: false });
  assert.deepEqual(entries[6], { path: `${MAIN}/.claude/worktrees/loose-head`, head: '999', branch: '', detached: true });
  assert.deepEqual(sw.parseWorktreeList(''), []);
});

test('only worktrees directly under .claude/worktrees/ are listed: not the main checkout, not a release', () => {
  const names = sw.passWorktrees(sw.parseWorktreeList(LISTING)).map((e) => path.basename(e.path));
  assert.deepEqual(names, ['merged-one', 'closed-one', 'live-one', 'review-one', 'dead-pass', 'loose-head']);
});

test('a merged pull request is STALE, whatever its ticket says', () => {
  const v = sw.worktreeFlag(worktree('merged-one'), sw.prForBranch(PRS, 'merged-one'), { id: 'SP-10', unread: true });
  assert.equal(v.flag, 'STALE');
  assert.match(v.why, /#10 is merged/);
});

test('a closed pull request is STALE', () => {
  assert.equal(sw.worktreeFlag(worktree('closed-one'), sw.prForBranch(PRS, 'closed-one'), { id: 'SP-11', unread: true }).flag, 'STALE');
});

test('an open pull request whose ticket is Live or Done is STALE', () => {
  const pr = sw.prForBranch(PRS, 'live-one');
  assert.equal(sw.worktreeFlag(worktree('live-one'), pr, ticket('SP-12', 'Live')).flag, 'STALE');
  assert.equal(sw.worktreeFlag(worktree('live-one'), pr, ticket('SP-12', 'done')).flag, 'STALE');
  assert.equal(sw.worktreeFlag(worktree('live-one'), pr, ticket('SP-12', 'Closed')).flag, 'STALE');
});

test('a ticket moved where nothing builds on the branch (Queued) is STALE', () => {
  const v = sw.worktreeFlag(worktree('live-one'), sw.prForBranch(PRS, 'live-one'), ticket('SP-12', 'Queued'));
  assert.equal(v.flag, 'STALE');
  assert.match(v.why, /nothing builds on this branch/);
});

test('an open pull request whose ticket is In review is ACTIVE, and so is every other in-flight status', () => {
  const pr = sw.prForBranch(PRS, 'review-one');
  for (const status of ['In review', 'Building', 'Rework', 'Ready to launch', 'Needs your input']) {
    assert.equal(sw.worktreeFlag(worktree('review-one'), pr, ticket('SP-13', status)).flag, 'ACTIVE', status);
  }
});

test('an unpushed branch with no pull request is UNPUSHED', () => {
  const v = sw.worktreeFlag(worktree('dead-pass', { pushed: false, dirty: true }), sw.prForBranch(PRS, 'dead-pass'));
  assert.equal(v.flag, 'UNPUSHED');
  const line = sw.worktreeLine(worktree('dead-pass', { pushed: false, dirty: true }), null, { id: '' }, v);
  assert.deepEqual(line.split('\t').slice(0, 7), ['dead-pass', 'dead-pass', 'not pushed', 'uncommitted edits', 'no pull request', '(no ticket)', 'UNPUSHED']);
});

test('a detached worktree prints "(detached)" and reads as UNPUSHED, never STALE', () => {
  const w = { ...worktree(''), path: `${MAIN}/.claude/worktrees/loose-head`, pushed: false };
  assert.equal(sw.prForBranch(PRS, ''), null);
  const v = sw.worktreeFlag(w, null);
  assert.equal(v.flag, 'UNPUSHED');
  assert.match(sw.worktreeLine(w, null, { id: '' }, v), /^loose-head\t\(detached\)\tnot pushed/);
});

test("a review pass's clean local branch whose commit is on main is STALE; with uncommitted edits it is not", () => {
  const w = worktree('add-x-review', { pushed: false, onMain: true });
  const v = sw.worktreeFlag(w, sw.prForBranch(PRS, 'add-x-review'));
  assert.equal(v.flag, 'STALE');
  assert.match(v.why, /already on main/);
  assert.equal(sw.worktreeFlag({ ...w, dirty: true }, null).flag, 'UNPUSHED');
  assert.equal(sw.worktreeFlag({ ...w, branch: '', detached: true }, null).flag, 'STALE');
});

test('an unreadable ticket is UNKNOWN, never STALE, and the line says what', () => {
  const pr = sw.prForBranch(PRS, 'review-one');
  const t = { id: 'SP-13', problem: 'HTTP 503' };
  const v = sw.worktreeFlag(worktree('review-one'), pr, t);
  assert.equal(v.flag, 'UNKNOWN');
  assert.match(v.why, /SP-13 could not be read \(HTTP 503\)/);
  assert.match(sw.worktreeLine(worktree('review-one'), pr, t, v), /\tSP-13 \(unreadable\)\tUNKNOWN\t/);
});

test('an open pull request naming no ticket is ACTIVE, never STALE on a guess', () => {
  const pr = { number: 20, state: 'OPEN', headRefName: 'old', body: 'no link here' };
  assert.equal(sw.worktreeFlag(worktree('old'), pr, { id: '' }).flag, 'ACTIVE');
});

test("a review pass's -review checkout belongs to the pull request whose head commit it sits on", () => {
  const prs = [{ number: 108, state: 'MERGED', headRefName: 'add-task-blue', headRefOid: 'abc123', body: body('SP-108') }];
  const w = { ...worktree('add-task-blue-review', { pushed: false }), head: 'abc123' };
  const pr = sw.prForBranch(prs, w);
  assert.equal(pr.number, 108);
  assert.equal(sw.worktreeFlag(w, pr, { id: 'SP-108', unread: true }).flag, 'STALE');
  // A detached checkout of that commit too; a different commit belongs to none.
  assert.equal(sw.prForBranch(prs, { branch: '', head: 'abc123' }).number, 108);
  assert.equal(sw.prForBranch(prs, { branch: 'other-review', head: 'fff' }), null);
});

test("a review pass's -review checkout that merged main in still belongs to the branch it reviews", () => {
  const prs = [{ number: 200, state: 'MERGED', headRefName: 'go-button', headRefOid: 'aaa', body: body('SP-200') }];
  for (const branch of ['go-button-review', 'go-button-review2']) {
    const pr = sw.prForBranch(prs, { branch, head: 'moved-on' });
    assert.equal(pr && pr.number, 200, branch);
  }
  assert.equal(sw.reviewedBranch('answer-is-in-review'), 'answer-is-in');
  assert.equal(sw.reviewedBranch('plain-branch'), '');
  // A branch's own pull request comes before the one it would review.
  const own = [...prs, { number: 201, state: 'OPEN', headRefName: 'go-button-review', body: '' }];
  assert.equal(sw.prForBranch(own, 'go-button-review').number, 201);
});

test('a branch with several pull requests takes the open one, else the newest', () => {
  const prs = [
    { number: 5, state: 'CLOSED', headRefName: 'b' },
    { number: 9, state: 'OPEN', headRefName: 'b' },
    { number: 7, state: 'MERGED', headRefName: 'b' },
  ];
  assert.equal(sw.prForBranch(prs, 'b').number, 9);
  assert.equal(sw.prForBranch(prs.filter((p) => p.state !== 'OPEN'), 'b').number, 7);
});

test('the count line names every flag, zeros included', () => {
  assert.equal(sw.countLine(['STALE', 'STALE', 'ACTIVE']), '3 worktree(s): 2 STALE, 0 UNPUSHED, 1 ACTIVE, 0 UNKNOWN');
  assert.equal(sw.countLine([]), '0 worktree(s): 0 STALE, 0 UNPUSHED, 0 ACTIVE, 0 UNKNOWN');
});

// ── It deletes nothing ────────────────────────────────────────────────────────

const DESTRUCTIVE = [/worktree['",\s]+remove/, /worktree['",\s]+prune/, /branch['",\s]+-[dD]\b/, /push['",\s]+.*--delete/, /\brmSync\b|\bunlinkSync\b|\brmdirSync\b/];

test('the module runs nothing: no child process, no file write, no delete', () => {
  const src = fs.readFileSync(path.join(__dirname, 'staleWorktrees.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"]node:(child_process|fs)['"]\)|require\(['"](child_process|fs)['"]\)/);
  for (const re of DESTRUCTIVE) assert.doesNotMatch(src, re);
  for (const [name, value] of Object.entries(sw)) {
    if (typeof value === 'function') assert.doesNotMatch(String(value), /spawn|execSync|execFile|child_process/, name);
  }
});

test("the door's stale-worktrees branch removes nothing and writes nothing to the tracker", () => {
  const door = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'clickup.mjs'), 'utf8');
  const start = door.indexOf("} else if (cmd === 'stale-worktrees') {");
  assert.ok(start > 0, 'the door has a stale-worktrees branch');
  const end = door.indexOf('} else if (cmd ===', start + 10);
  const branch = door.slice(start, end);
  for (const re of DESTRUCTIVE) assert.doesNotMatch(branch, re);
  assert.doesNotMatch(branch, /tracker\.(update|post|create|delete|set|add|remove)\w*\(/);
  // One gh call, for every pull request at once.
  assert.equal((branch.match(/\bgh\(/g) || []).length, 1);
  assert.match(branch, /'pr', 'list'[^\n]*'--state', 'all'/);
  // Listed in the door's usage text.
  assert.match(door, /\n  stale-worktrees\s+read-only:/);
});
