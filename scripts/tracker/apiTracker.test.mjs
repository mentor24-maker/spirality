import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../tracker/store.mjs';
import { startServer } from '../../tracker/server.mjs';
import { createApiTracker } from './apiTracker.mjs';
import { conflictTicketFiledComment, findConflictTicket } from '../../lib/conflictWork.js';
import { isMachineComment } from '../lib/machineComment.mjs';

const DOOR = fileURLToPath(new URL('../clickup.mjs', import.meta.url));
const LIST = '333';
const sixty = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
const CARD = `@@ASKED\nbuild the to-do list\n@@CONTEXT\n${sixty}\n@@NEEDED\nPick option A or B.`;

/**
 * A real tracker server on a temporary database, an operator and a loop each
 * holding a token, one project, and a product folder whose config points the
 * door at that server. `door(...args)` runs the real door there, as a child
 * process, and answers `{ code, out, err }`. A fake `gh` on the PATH answers
 * `pr view` with whatever `f.prBody` holds.
 */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'api-tracker-'));
  const store = openStore(join(dir, 'tracker.db'));
  const human = store.createActor({ kind: 'human', name: 'Dana' });
  const machine = store.createActor({ kind: 'machine', name: 'Loop' });
  const humanToken = store.issueToken(human.id);
  const machineToken = store.issueToken(machine.id);
  store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL', operator: human.id });
  const server = await startServer({ store, port: 0 });
  const url = `http://127.0.0.1:${server.address().port}`;

  const product = join(dir, 'product');
  mkdirSync(product);
  writeFileSync(join(product, 'spirality.project.json'), JSON.stringify({
    workspaceId: '111', spaceId: '222', loopQueueListId: LIST,
    operatorUserId: human.id, machineUserId: machine.id,
    githubRepo: 'owner/repo', dopplerProject: 'proj', dopplerConfig: 'dev',
    launchdPrefix: 'com.example', logDir: '~/loop-logs', mergePhrases: ['merge'],
    governancePaths: [], autoMergeLanes: [], operatorName: 'Dane', productSlug: 'alpha',
    legacyMachinePrefixes: [], productScripts: {}, tracker: 'api', trackerUrl: url,
  }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const prFile = join(dir, 'pr.json');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\ncat "${prFile}"\n`);
  chmodSync(join(bin, 'gh'), 0o755);

  const f = {
    dir, store, human, machine, humanToken, machineToken, url, product,
    set prBody(body) { writeFileSync(prFile, JSON.stringify({ body, url: 'https://github.com/owner/repo/pull/7' })); },
    door(args, { stdin = '', token = machineToken } = {}) {
      return new Promise((resolve) => {
        const env = { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, TRACKER_TOKEN: token };
        const child = spawn(process.execPath, [DOOR, ...args], { cwd: product, env });
        let out = '';
        let err = '';
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { err += c; });
        child.on('close', (code) => resolve({ code, out, err }));
        child.stdin.end(stdin);
      });
    },
    file(fields) {
      return store.fileTicket({ project: 'alpha', actor: machine.id, status: 'queued', ...fields });
    },
    async cleanup() {
      await new Promise((r) => server.close(r));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return f;
}

test('whoami names the loop\'s own actor in the tracker', async () => {
  const f = await fixture();
  try {
    const r = await f.door(['whoami']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `Token valid. Acting as: Loop <machine actor in the tracker> (id ${f.machine.id})\n`);
  } finally { await f.cleanup(); }
});

test('a missing or wrong token is refused the way ClickUp\'s is, naming TRACKER_TOKEN', async () => {
  const f = await fixture();
  try {
    const none = await f.door(['whoami'], { token: '' });
    assert.equal(none.code, 2);
    assert.match(none.err, /TRACKER_TOKEN is not set/);
    const wrong = await f.door(['whoami'], { token: 'not-a-token' });
    assert.equal(wrong.code, 1);
    assert.match(wrong.err, /whoami FAILED — HTTP 401/);
    assert.match(wrong.err, /proj\/dev, TRACKER_TOKEN/);
    assert.doesNotMatch(wrong.err + wrong.out, new RegExp(f.machineToken));
  } finally { await f.cleanup(); }
});

test('task files a ticket and reads it back; get and task-name print it as on ClickUp', async () => {
  const f = await fixture();
  try {
    const r = await f.door(['task', '--name', 'Fix the thing', '--body-file', '-', '--priority', 'high', '--tags', 'tracker,phase-2'], { stdin: '## Goal\nDo it.\n' });
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.startsWith(`\nCreated task AL-1\n  ${f.url}/tickets/AL-1\n`), r.out);
    assert.match(r.out, / {2}status: {6}queued\n {2}priority: {4}high\n {2}tags: {8}tracker, phase-2\n {2}description: 15 characters\n/);

    const get = await f.door(['get', '--task', 'AL-1']);
    assert.equal(get.code, 0, get.err);
    assert.equal(get.out, [
      'id:       AL-1', 'name:     Fix the thing', 'status:   queued', 'priority: high', 'assigned: (nobody)',
      'tags:     tracker, phase-2', 'list:     alpha (alpha)', 'pr:       (none recorded)', 'rounds:   0 send-back(s) so far',
      `url:      ${f.url}/tickets/AL-1`, '---', '## Goal\nDo it.\n', '',
    ].join('\n'));

    const name = await f.door(['task-name', '--task', 'AL-1']);
    assert.equal(name.out, 'Fix the thing\n');

    // lib/ lowercases the ids it reads (ClickUp's are lower case), so any case is the same ticket.
    const lower = await f.door(['get', '--task', 'al-1']);
    assert.equal(lower.code, 0, lower.err);
    assert.equal(lower.out, get.out);

    const missing = await f.door(['get', '--task', 'AL-99']);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /read the task FAILED — HTTP 404\nno ticket AL-99\./);
  } finally { await f.cleanup(); }
});

test('queue --claimable lists every Rework ticket first (oldest first), then Queued by priority', async () => {
  const f = await fixture();
  try {
    f.file({ name: 'queued normal', priority: 'normal' });
    f.file({ name: 'rework newer-filed', status: 'rework', priority: 'low' });
    f.file({ name: 'queued urgent', priority: 'urgent' });
    f.file({ name: 'in review', status: 'in review' });
    f.file({ name: 'live', status: 'live' });
    const r = await f.door(['queue', '--claimable']);
    assert.equal(r.code, 0, r.err);
    const rows = r.out.trim().split('\n').map((l) => l.split('\t'));
    assert.deepEqual(rows.map((x) => [x[0], x[1], x[2], x[4]]), [
      ['AL-2', 'rework', 'low', 'rework newer-filed'],
      ['AL-3', 'queued', 'urgent', 'queued urgent'],
      ['AL-1', 'queued', 'normal', 'queued normal'],
    ]);
    assert.match(r.err, /3 task\(s\) claimable by loop-build \(rework then queued\) in list 333/);
    assert.match(r.err, /claim it: npm run clickup -- claim --task AL-2/);

    const all = await f.door(['queue']);
    assert.ok(!all.out.includes('AL-5'), 'a Live ticket is closed, and the queue leaves it out as on ClickUp');
  } finally { await f.cleanup(); }
});

test('Waits on: a dependent is skipped while its prerequisite is open, and claimable once it is Live', async () => {
  const f = await fixture();
  try {
    f.file({ name: 'first' });
    f.file({ name: 'second', description: 'Waits on: AL-1\n\n## Goal\nAfter the first.' });
    const before = await f.door(['queue', '--claimable']);
    assert.equal(before.code, 0, before.err);
    assert.deepEqual(before.out.trim().split('\n').map((l) => l.split('\t')[0]), ['AL-1']);
    assert.match(before.err, /skipped AL-2: waits on al-1 \(still open\)/);
    const early = await f.door(['claim', '--task', 'AL-2']);
    assert.equal(early.code, 3, early.err);
    assert.equal(f.store.getTicket('AL-2').status, 'queued');

    f.store.changeTicket('AL-1', { actor: f.human.id, status: 'live' });
    const after = await f.door(['queue', '--claimable']);
    assert.equal(after.code, 0, after.err);
    assert.deepEqual(after.out.trim().split('\n').map((l) => l.split('\t')[0]), ['AL-2']);
    assert.doesNotMatch(after.err, /skipped|could not be read/);
    const claim = await f.door(['claim', '--task', 'AL-2']);
    assert.equal(claim.code, 0, claim.err);
    assert.equal(f.store.getTicket('AL-2').status, 'building');
  } finally { await f.cleanup(); }
});

test('claim moves Queued to Building with no assignee; a second claim is refused with exit 3', async () => {
  const f = await fixture();
  try {
    f.file({ name: 'one', assignee: f.human.id });
    const r = await f.door(['claim', '--task', 'AL-1']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'Task AL-1: "queued" -> "building", assigned: (nobody) (verified from the write response).\n');
    assert.match(r.err, /claiming AL-1 out of "queued" \(guarded on that exact status\)/);
    assert.equal(f.store.getTicket('AL-1').status, 'building');
    assert.equal(f.store.getTicket('AL-1').assignee, null);

    const again = await f.door(['claim', '--task', 'AL-1']);
    assert.equal(again.code, 3);
    assert.match(again.err, /NOT claimed: "AL-1" is "building"/);
  } finally { await f.cleanup(); }
});

test('two simultaneous claims of one ticket: exactly one wins, the other exits 3, and one move is recorded', async () => {
  const f = await fixture();
  try {
    for (let round = 0; round < 3; round += 1) {
      const t = f.file({ name: `race ${round}` });
      const results = await Promise.all([f.door(['claim', '--task', t.id]), f.door(['claim', '--task', t.id])]);
      const codes = results.map((r) => r.code).sort();
      assert.deepEqual(codes, [0, 3], results.map((r) => r.err).join('\n'));
      const statusMoves = f.store.listEvents(t.id).filter((e) => e.field === 'status');
      assert.deepEqual(statusMoves.map((e) => [e.from, e.to]), [['queued', 'building']]);
    }
  } finally { await f.cleanup(); }
});

test('the store refuses a raced guarded write, even when both writers read the same status first', async () => {
  const f = await fixture();
  try {
    const t = f.file({ name: 'race' });
    const a = createApiTracker({ token: f.machineToken, baseUrl: f.url, project: 'alpha', listId: LIST, log: () => {} });
    const b = createApiTracker({ token: f.machineToken, baseUrl: f.url, project: 'alpha', listId: LIST, log: () => {} });
    const [ra, rb] = await Promise.all([
      a.updateTask(t.id, { status: 'Building' }, { ifStatus: 'queued' }),
      b.updateTask(t.id, { status: 'Building' }, { ifStatus: 'queued' }),
    ]);
    const won = [ra, rb].filter((r) => r.res.ok);
    const lost = [ra, rb].filter((r) => !r.res.ok);
    assert.equal(won.length, 1);
    assert.equal(won[0].json.status.status, 'building');
    assert.equal(lost[0].res.status, 409);
    assert.equal(lost[0].moved, true);
    assert.match(lost[0].json.err, /has moved: it is "building"/);
    assert.equal(f.store.getTicket(t.id).version, 2);
  } finally { await f.cleanup(); }
});

test('a filed catch-up ticket reads back by its own id through the relay\'s conflict trail', async () => {
  const f = await fixture();
  try {
    const waiting = f.file({ name: 'waiting on a merge', status: 'ready to launch' });
    const t = createApiTracker({ token: f.machineToken, baseUrl: f.url, project: 'alpha', listId: LIST, log: () => {} });
    const filed = await t.createTask(LIST, { name: 'catch up PR #7', markdown_description: '## Goal\nCatch up.\n' });
    assert.equal(filed.res.ok, true, filed.text);
    const { id, url } = filed.json;
    assert.equal(url, `${f.url}/tickets/${id}`);

    // The url is a route the server answers, not a dead link.
    const page = await fetch(url, { headers: { authorization: `Bearer ${f.machineToken}` } });
    assert.equal(page.status, 200);
    assert.equal((await page.json()).id, id);

    // What recordCatchUp writes and reads back, end to end through the store.
    const body = conflictTicketFiledComment({ id, url, prNumber: 7, localVerdict: null });
    const posted = await t.postComment(waiting.id, { comment_text: body });
    assert.equal(posted.res.ok, true, posted.text);
    const read = await t.listComments(waiting.id);
    assert.deepEqual(findConflictTicket(read.paged.comments, 7), { id, url, prNumber: 7 });
  } finally { await f.cleanup(); }
});

test('status --if-status refuses with exit 3 when the ticket moved, and In review clears the assignee', async () => {
  const f = await fixture();
  try {
    f.file({ name: 'one', status: 'building', assignee: f.human.id });
    const moved = await f.door(['status', '--task', 'AL-1', '--status', 'In review', '--if-status', 'Queued']);
    assert.equal(moved.code, 3);
    assert.match(moved.err, /NOT moved: expected status "Queued" but the task is "building"/);
    assert.equal(f.store.getTicket('AL-1').status, 'building');

    const r = await f.door(['status', '--task', 'AL-1', '--status', 'In review', '--if-status', 'Building']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'Task AL-1: "building" -> "in review", assigned: (nobody) (verified from the write response).\n');

    const dane = await f.door(['status', '--task', 'AL-1', '--status', 'Needs your input']);
    assert.equal(dane.code, 2, 'Dane\'s statuses are still `ask`-only on this tracker');

    const bad = await f.door(['status', '--task', 'AL-1', '--status', 'Shipped']);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /set status FAILED — HTTP 400\n"Shipped" is not one of the seven statuses/);
  } finally { await f.cleanup(); }
});

test('ask posts the card, moves to Needs your input and assigns the operator; waiting then says it is his', async () => {
  const f = await fixture();
  try {
    f.file({ name: 'one', status: 'building' });
    const r = await f.door(['ask', '--task', 'AL-1', '--body-file', '-'], { stdin: CARD });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Task AL-1: card \d+ posted, "building" -> "needs your input", assigned: Dana \(1\)\.\n$/);
    const [card] = f.store.listComments('AL-1');
    assert.ok(card.body.includes('build the to-do list'));
    // The card keeps its marks as markdown: his words fenced, the headings bold.
    assert.ok(card.body.includes("**DANE'S WORDS — the instruction behind this ticket**\n\n```\nbuild the to-do list\n```\n"), card.body);
    assert.ok(card.body.includes("**WHAT'S GOING ON**\n\n"), card.body);
    assert.ok(isMachineComment(card.body), 'the card carries the machine stamp');
    assert.equal(card.author, f.machine.id);

    const waiting = await f.door(['waiting', '--task', 'AL-1']);
    assert.equal(waiting.code, 3);
    assert.match(waiting.out, /^AL-1\tneeds your input\tassigned: Dane\tlast word: a loop .* MT\tWAITING ON DANE — "needs your input"\tone\n$/);

    f.store.postComment({ ticket: 'AL-1', author: f.human.id, body: 'A please' });
    const answered = await f.door(['waiting', '--task', 'AL-1']);
    assert.equal(answered.code, 0);
    assert.match(answered.out, /last word: Dana .* MT\tANSWERED/);

    const again = await f.door(['ask', '--task', 'AL-1', '--body-file', '-'], { stdin: CARD });
    assert.equal(again.code, 2);
    assert.match(again.err, /REFUSED — Dane's own comment is the NEWEST one on AL-1/);
  } finally { await f.cleanup(); }
});

test('pr-opened records the PR and reads it back; then verdict --pass reads back through the gate', async () => {
  const f = await fixture();
  try {
    f.file({ name: 'one', status: 'building' });
    f.prBody = 'Summary.\n\nhttps://example.invalid/not-this-ticket\n';
    const refused = await f.door(['pr-opened', '--task', 'AL-1', '--pr', 'https://github.com/owner/repo/pull/7']);
    assert.equal(refused.code, 4);
    assert.equal(f.store.listComments('AL-1').length, 0);

    // The PR-body link reader (lib, unchanged in this phase) still reads the ClickUp link form.
    f.prBody = 'Summary.\n\nhttps://app.clickup.com/t/AL-1\n';
    const r = await f.door(['pr-opened', '--task', 'AL-1', '--pr', 'https://github.com/owner/repo/pull/7']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'Task AL-1: PR #7 recorded (https://github.com/owner/repo/pull/7), read back and parsed by the gate\'s own reader.\n');
    const get = await f.door(['get', '--task', 'AL-1']);
    assert.match(get.out, /\npr: {7}https:\/\/github\.com\/owner\/repo\/pull\/7\n/);

    const once = await f.door(['pr-opened', '--task', 'AL-1', '--pr', 'https://github.com/owner/repo/pull/7', '--if-missing']);
    assert.equal(once.code, 0, once.err);
    assert.match(once.out, /already recorded — nothing written/);

    await f.door(['status', '--task', 'AL-1', '--status', 'In review']);
    const unguarded = await f.door(['verdict', '--task', 'AL-1', '--pass']);
    assert.equal(unguarded.code, 2);
    const wrong = await f.door(['verdict', '--task', 'AL-1', '--pass', '--if-status', 'Building']);
    assert.equal(wrong.code, 3);
    const pass = await f.door(['verdict', '--task', 'AL-1', '--pass', '--if-status', 'In review', '--body-file', '-'], { stdin: 'All good.' });
    assert.equal(pass.code, 0, pass.err);
    assert.match(pass.out, /^Task AL-1: verdict PASSED recorded as comment \d+, verified through the Ready-to-launch gate itself\.\n$/);
  } finally { await f.cleanup(); }
});

test('comment, describe, priority and tag each write and read back', async () => {
  const f = await fixture();
  try {
    f.file({ name: 'one', priority: 'normal' });
    const c = await f.door(['comment', '--task', 'AL-1', '--body-file', '-'], { stdin: 'A note.' });
    assert.equal(c.code, 0, c.err);
    assert.match(c.out, /^Comment \d+ added to task AL-1 \(\d+ characters, verified by reading it back\)\.\n$/);
    f.store.postComment({ ticket: 'AL-1', author: f.human.id, body: 'his reply' });
    const list = await f.door(['comments', '--task', 'AL-1']);
    assert.equal(list.code, 0, list.err);
    const lines = list.out.split('\n');
    assert.match(lines[0], new RegExp(`^\\[.* MT\\] Loop \\[machine\\] \\(${f.machine.id}, comment \\d+\\):$`));
    assert.equal(lines[1], 'A note.');
    assert.match(lines[3], new RegExp(`^\\[.* MT\\] Dana \\(${f.human.id}, comment \\d+\\):$`));
    assert.equal(lines[4], 'his reply');
    assert.match(list.err, /2 comment\(s\) on task AL-1/);

    const d = await f.door(['describe', '--task', 'AL-1', '--body-file', '-'], { stdin: 'New body.' });
    assert.equal(d.out, 'Task AL-1: description replaced (9 characters, read back).\n');
    assert.equal(f.store.getTicket('AL-1').description, 'New body.');

    const p = await f.door(['priority', '--task', 'AL-1', '--priority', 'high']);
    assert.equal(p.out, 'Task AL-1: priority "normal" -> "high".\n');

    const add = await f.door(['tag', '--task', 'AL-1', '--add', 'wont-do']);
    assert.equal(add.out, 'Task AL-1: tags now [wont-do].\n');
    const rem = await f.door(['tag', '--task', 'AL-1', '--remove', 'wont-do']);
    assert.equal(rem.out, 'Task AL-1: tags now [].\n');
  } finally { await f.cleanup(); }
});

test('tag re-reads and tries once more when another write lands between its read and its write', async () => {
  const f = await fixture();
  try {
    f.file({ name: 'one', status: 'building' });
    const t = createApiTracker({ token: f.machineToken, baseUrl: f.url, project: 'alpha', listId: LIST, log: () => {} });
    const realFetch = globalThis.fetch;
    let patches = 0;
    globalThis.fetch = async (url, init) => {
      if (init?.method === 'PATCH' && patches++ === 0) f.store.changeTicket('AL-1', { actor: f.human.id, status: 'in review' });
      return realFetch(url, init);
    };
    let out;
    try { out = await t.setTag('AL-1', 'wont-do', true); } finally { globalThis.fetch = realFetch; }
    assert.equal(out.res.ok, true, out.text);
    assert.equal(patches, 2);
    const now = f.store.getTicket('AL-1');
    assert.deepEqual(now.tags, ['wont-do']);
    assert.equal(now.status, 'in review', 'the other write is kept, not overwritten');
  } finally { await f.cleanup(); }
});

test('relay hands a ticket back on his answer: the move and the reply marker are both read back', async () => {
  const f = await fixture();
  try {
    f.file({ name: 'one', status: 'building' });
    const ask = await f.door(['ask', '--task', 'AL-1', '--body-file', '-'], { stdin: CARD });
    assert.equal(ask.code, 0, ask.err);
    const answer = f.store.postComment({ ticket: 'AL-1', author: f.human.id, body: 'Option A, go ahead.' });

    const r = await f.door(['relay']);
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    assert.match(r.out, /AL-1.*handed-back.*"queued".*marker verified/i);
    const t = f.store.getTicket('AL-1');
    assert.equal(t.status, 'queued');
    assert.equal(t.assignee, null);
    const replies = f.store.listComments('AL-1').filter((c) => c.parent === answer.id);
    assert.equal(replies.length, 1);
    assert.ok(isMachineComment(replies[0].body), 'the reply carries the machine stamp');

    const quiet = await f.door(['relay']);
    assert.equal(quiet.code, 0, quiet.err);
    assert.match(quiet.err, /0 "Needs your input"/);
  } finally { await f.cleanup(); }
});

test('replies: posted under a comment, listed apart from the top-level trail, and refused for a comment never read', async () => {
  const f = await fixture();
  try {
    f.file({ name: 'one' });
    const t = createApiTracker({ token: f.machineToken, baseUrl: f.url, project: 'alpha', listId: LIST, log: () => {} });
    const unknown = await t.replyToComment('1', { comment_text: 'x' });
    assert.equal(unknown.res.ok, false);
    assert.match(unknown.json.err, /was not read in this run/);

    const top = await t.postComment('AL-1', { comment_text: 'top' });
    assert.equal(top.res.status, 201);
    const reply = await t.replyToComment(top.json.id, { comment_text: 'marker' });
    assert.equal(reply.res.status, 201);
    assert.equal(reply.json.parent, top.json.id);

    const { paged, bad } = await t.listComments('AL-1');
    assert.equal(bad, null);
    assert.equal(paged.complete, true);
    assert.deepEqual(paged.comments.map((c) => c.id), [top.json.id]);
    const replies = await t.listReplies(top.json.id);
    assert.deepEqual(replies.json.comments.map((c) => c.id), [reply.json.id]);
    assert.ok(replies.json.comments.every((c) => isMachineComment(c.comment_text)));
  } finally { await f.cleanup(); }
});

test('assignees: one at most, since a ticket in the tracker carries one; more is refused before any write', async () => {
  const f = await fixture();
  try {
    f.file({ name: 'one' });
    const t = createApiTracker({ token: f.machineToken, baseUrl: f.url, project: 'alpha', listId: LIST, log: () => {} });
    const out = await t.updateTask('AL-1', { assignees: { add: [f.human.id, f.machine.id], rem: [] } });
    assert.equal(out.res.ok, false);
    assert.match(out.json.err, /one assignee per ticket/);
    assert.equal(f.store.getTicket('AL-1').version, 1);
  } finally { await f.cleanup(); }
});

test('an unreachable tracker answers HTTP 0, not a throw', async () => {
  const t = createApiTracker({ token: 'tok', baseUrl: 'http://127.0.0.1:1', project: 'alpha', listId: LIST, log: () => {} });
  const out = await t.getTask('AL-1');
  assert.equal(out.res.ok, false);
  assert.equal(out.res.status, 0);
  assert.match(out.text, /never reached the tracker/);
});
