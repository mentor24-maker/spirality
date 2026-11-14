'use strict';

// SP-294: after each merge, every Ready to launch pull request is caught up,
// or has its catch-up ticket filed, before Dane's merge word finds it stale.

const test = require('node:test');
const assert = require('node:assert/strict');

const { catchUpReadyTickets } = require('./readyCatchUp.js');
const { KINDS } = require('./mainMoved.js');
const { conflictTicketBody } = require('./conflictWork.js');

const REPO = 'mentor24-maker/spirality';
const MERGE = { number: 17, url: `https://github.com/${REPO}/pull/17`, oid: 'a'.repeat(40) };
const OPEN = new Map([[18, 'b18'], [19, 'b19'], [20, 'b20']]);

let nextDate = 1000;
const comment = (text) => ({ id: String(nextDate), date: String(nextDate++), comment_text: text });
const prLink = (n, repo = REPO) => comment(`PR opened: https://github.com/${repo}/pull/${n}`);
const findPr = (comments) => {
  for (const c of comments) {
    const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(c.comment_text || '');
    if (m) return { url: m[0], owner: m[1], repo: m[2], number: Number(m[3]) };
  }
  return null;
};

const ticket = (id, status = 'ready to launch') => ({ id, name: `ticket ${id}`, status: { status } });

const CLEAN = { kind: KINDS.SAME_FILES, files: ['x.js'], reason: '' };
const CONFLICT = { kind: KINDS.CONFLICT, files: ['lib/a.js'], reason: '' };

/** Fakes for every read and write, recording what was done. */
function fakeIo({
  trails, statuses = {}, failRead = new Set(), verdicts = {}, contains = {},
  window = { action: 'take', reason: 'free' }, updateFails = new Set(), fileResult = null,
}) {
  const updated = [], filed = [];
  return {
    updated,
    filed,
    io: {
      readComments: async (id) => (failRead.has(id) ? { problem: 'HTTP 500' } : { comments: trails[id] || [] }),
      readStatus: async (id) => (id in statuses ? statuses[id] : 'ready to launch'),
      findPullRequest: findPr,
      contains: ({ branch }) => contains[branch] ?? false,
      check: ({ branch }) => verdicts[branch] || CLEAN,
      window: () => window,
      updateBranch: (n) => {
        if (updateFails.has(n)) return { ok: false, why: 'merge conflict between base and head' };
        updated.push(n);
        return { ok: true };
      },
      fileConflict: async (args) => {
        filed.push(args);
        return fileResult || { ok: true, filed: { id: 'SP-900' }, already: false };
      },
    },
  };
}

const run = (tasks, io, dryRun = false) => catchUpReadyTickets({ tasks, merge: MERGE, base: 'main', repo: REPO, openPrs: OPEN, dryRun, io });

test('a Ready to launch PR that merges cleanly with the new main is caught up through GitHub', async () => {
  const { io, updated, filed } = fakeIo({ trails: { A: [prLink(18)] } });
  const out = await run([ticket('A')], io);
  assert.deepEqual(updated, [18]);
  assert.deepEqual(filed, []);
  assert.equal(out.caughtUp, 1);
  assert.deepEqual(out.problems, []);
  assert.match(out.lines[0], /caught up/);
});

test('a Ready to launch PR that conflicts gets its catch-up ticket filed at once, and its branch is not touched', async () => {
  const { io, updated, filed } = fakeIo({ trails: { A: [prLink(18)] }, verdicts: { b18: CONFLICT } });
  const out = await run([ticket('A')], io);
  assert.deepEqual(updated, [], 'a script never touches a branch that conflicts');
  assert.equal(filed.length, 1);
  assert.equal(filed[0].pr.number, 18);
  assert.equal(filed[0].branch, 'b18');
  assert.deepEqual(filed[0].verdict.files, ['lib/a.js']);
  assert.equal(out.filed, 1);
  assert.match(out.lines[0], /catch-up ticket SP-900 filed/);
});

test('a catch-up ticket already on file is not counted as a new filing', async () => {
  const { io } = fakeIo({ trails: { A: [prLink(18)] }, verdicts: { b18: CONFLICT }, fileResult: { ok: true, filed: { id: 'SP-800' }, already: true } });
  const out = await run([ticket('A')], io);
  assert.equal(out.filed, 0);
  assert.match(out.lines[0], /SP-800 already on file/);
});

test('a filing that fails is a problem, said once, and the next ticket is still looked at', async () => {
  const { io, updated } = fakeIo({
    trails: { A: [prLink(18)], B: [prLink(19)] }, verdicts: { b18: CONFLICT },
    fileResult: { ok: false, problem: 'HTTP 500' },
  });
  const out = await run([ticket('A'), ticket('B')], io);
  assert.equal(out.problems.length, 1);
  assert.match(out.problems[0], /^A: PR #18 conflicts .* NOT filed \(HTTP 500\)/);
  assert.deepEqual(updated, [19]);
});

test('only Ready to launch tickets are looked at: the in-flight ones are main-moved\'s', async () => {
  const { io, updated, filed } = fakeIo({ trails: { A: [prLink(18)], B: [prLink(19)], C: [prLink(20)] } });
  const out = await run([ticket('A', 'in review'), ticket('B', 'needs your input'), ticket('C', 'rework')], io);
  assert.deepEqual(updated, []);
  assert.deepEqual(filed, []);
  assert.deepEqual(out.lines, []);
});

test('a ticket moved out of Ready to launch since the list was read is left alone', async () => {
  const { io, updated } = fakeIo({ trails: { A: [prLink(18)] }, statuses: { A: 'live' } });
  const out = await run([ticket('A')], io);
  assert.deepEqual(updated, []);
  assert.deepEqual(out.problems, []);
  assert.match(out.lines[0], /moved to live .* left alone/);
});

test('a ticket that cannot be re-read before acting is a problem, never a catch-up', async () => {
  const { io, updated } = fakeIo({ trails: { A: [prLink(18)] }, statuses: { A: null } });
  const out = await run([ticket('A')], io);
  assert.deepEqual(updated, []);
  assert.match(out.problems[0], /could not be re-read/);
});

test('a check that could not run catches nothing up, files nothing, and says so', async () => {
  const { io, updated, filed } = fakeIo({ trails: { A: [prLink(18)] }, verdicts: { b18: { kind: KINDS.CANNOT_TELL, files: [], reason: 'the in-memory merge did not run' } } });
  const out = await run([ticket('A')], io);
  assert.deepEqual(updated, []);
  assert.deepEqual(filed, []);
  assert.match(out.problems[0], /could not be checked against PR #17 \(the in-memory merge did not run\)/);
});

test('a branch that already holds the merge is current: nothing to do', async () => {
  const { io, updated } = fakeIo({ trails: { A: [prLink(18)] }, contains: { b18: true } });
  const out = await run([ticket('A')], io);
  assert.deepEqual(updated, []);
  assert.match(out.lines[0], /already contains PR #17/);
});

test('the merged PR itself, a closed PR, another repository\'s PR and no PR are all skipped', async () => {
  const { io, updated, filed } = fakeIo({
    trails: { A: [prLink(17)], B: [prLink(42)], C: [prLink(18, 'someone/else')], D: [] },
  });
  const out = await run([ticket('A'), ticket('B'), ticket('C'), ticket('D')], io);
  assert.deepEqual(updated, []);
  assert.deepEqual(filed, []);
  assert.deepEqual(out.problems, []);
});

test('while another PR holds the merge window, no branch is caught up this time', async () => {
  const { io, updated } = fakeIo({ trails: { A: [prLink(18)] }, window: { action: 'blocked', reason: 'PR #5 is in the merge window' } });
  const out = await run([ticket('A')], io);
  assert.deepEqual(updated, []);
  assert.deepEqual(out.problems, []);
  assert.match(out.lines[0], /not caught up this time — PR #5 is in the merge window/);
});

test('a conflict is filed even while the merge window is held: filing moves no branch', async () => {
  const { io, filed } = fakeIo({ trails: { A: [prLink(18)] }, verdicts: { b18: CONFLICT }, window: { action: 'blocked', reason: 'held' } });
  await run([ticket('A')], io);
  assert.equal(filed.length, 1);
});

test('a catch-up GitHub refuses is a problem, and his merge word still meets the merge step', async () => {
  const { io } = fakeIo({ trails: { A: [prLink(18)] }, updateFails: new Set([18]) });
  const out = await run([ticket('A')], io);
  assert.equal(out.caughtUp, 0);
  assert.match(out.problems[0], /could not be caught up \(merge conflict between base and head\)/);
});

test('a failed comment read is a problem, and the next ticket is still caught up', async () => {
  const { io, updated } = fakeIo({ trails: { B: [prLink(19)] }, failRead: new Set(['A']) });
  const out = await run([ticket('A'), ticket('B')], io);
  assert.deepEqual(updated, [19]);
  assert.match(out.problems[0], /^A: its comments could not be read/);
});

test('a throw on one ticket does not stop the next', async () => {
  const { io, updated } = fakeIo({ trails: { A: [prLink(18)], B: [prLink(19)] } });
  const check = io.check;
  io.check = (args) => { if (args.branch === 'b18') throw new Error('boom'); return check(args); };
  const out = await run([ticket('A'), ticket('B')], io);
  assert.deepEqual(updated, [19]);
  assert.match(out.problems[0], /^A: boom/);
});

test('a dry run says what it would do and does nothing', async () => {
  const { io, updated, filed } = fakeIo({ trails: { A: [prLink(18)], B: [prLink(19)] }, verdicts: { b19: CONFLICT } });
  const out = await run([ticket('A'), ticket('B')], io, true);
  assert.deepEqual(updated, []);
  assert.deepEqual(filed, []);
  assert.match(out.lines[0], /would catch it up/);
  assert.match(out.lines[1], /would file its catch-up ticket/);
});

// ------------------------------------------- the ticket filed before his word

const TASK = { id: 'SP-1', url: 'http://mac-mini.local:4180/t/SP-1', name: 'Some work' };
const PR = { number: 18, url: `https://github.com/${REPO}/pull/18` };

test('a catch-up ticket filed before his merge word does not claim he gave it', () => {
  const body = conflictTicketBody({ task: TASK, pr: PR, branch: 'b18', localVerdict: null, commentId: null, ahead: { mergedNumber: 17, files: ['lib/a.js'] } });
  assert.ok(!/already authorized/.test(body), 'he has not said merge yet');
  assert.ok(!/his comment null/.test(body));
  assert.match(body, /has not said "merge"/);
  assert.match(body, /PR #17 just merged/);
  assert.match(body, /`lib\/a\.js`/, 'it names the files git said conflict');
  assert.match(body, /## The branch\n\n- PR: https:\/\/github\.com\/mentor24-maker\/spirality\/pull\/18/, 'fixup-live reads this line back');
});

test('a catch-up ticket filed at his merge word reads as before', () => {
  const body = conflictTicketBody({ task: TASK, pr: PR, branch: 'b18', localVerdict: null, commentId: '77' });
  assert.match(body, /He already authorized it \(his comment 77/);
  assert.match(body, /no local check was attempted/);
});
