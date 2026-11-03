import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../tracker/store.mjs';
import { startServer } from '../../tracker/server.mjs';
import { createApiTracker, trackerTokenEnv } from './apiTracker.mjs';
import { conflictTicketFiledComment, findConflictTicket } from '../../lib/conflictWork.js';
import { isMachineComment } from '../lib/machineComment.mjs';
import { renderMarkdown } from '../../tracker/web/render.mjs';

const DOOR = fileURLToPath(new URL('../clickup.mjs', import.meta.url));
const LIST = '333';
const sixty = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
const CARD = `@@ASKED\nbuild the to-do list\n@@CONTEXT\n${sixty}\n@@NEEDED\nPick option A or B.\nYour move: Reply — A or B.`;

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
    legacyMachinePrefixes: [], productScripts: {}, tracker: 'api', trackerUrl: url, trackerPrefix: 'AL',
  }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const prFile = join(dir, 'pr.json');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\ncat "${prFile}"\n`);
  chmodSync(join(bin, 'gh'), 0o755);

  const f = {
    dir, store, human, machine, humanToken, machineToken, url, product, server, bin,
    set prBody(body) { writeFileSync(prFile, JSON.stringify({ body, url: 'https://github.com/owner/repo/pull/7' })); },
    /** What the fake `gh pr view` prints, as an object. */
    set prJson(json) { writeFileSync(prFile, JSON.stringify(json)); },
    door(args, { stdin = '', token = machineToken, env: extra = {} } = {}) {
      return new Promise((resolve) => {
        const env = { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, TRACKER_TOKEN_HAND_RUN: token, ...extra };
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

test('a missing or wrong token is refused the way ClickUp\'s is, naming TRACKER_TOKEN_HAND_RUN', async () => {
  const f = await fixture();
  try {
    const none = await f.door(['whoami'], { token: '' });
    assert.equal(none.code, 2);
    assert.match(none.err, /TRACKER_TOKEN_HAND_RUN is not set/);
    const wrong = await f.door(['whoami'], { token: 'not-a-token' });
    assert.equal(wrong.code, 1);
    assert.match(wrong.err, /whoami FAILED — HTTP 401/);
    assert.match(wrong.err, /proj\/dev, TRACKER_TOKEN_HAND_RUN/);
    assert.doesNotMatch(wrong.err + wrong.out, new RegExp(f.machineToken));
  } finally { await f.cleanup(); }
});

test('trackerTokenEnv: the hand-run seat by default, a loop\'s own secret when a runner names one, never the operator\'s', () => {
  assert.equal(trackerTokenEnv({}), 'TRACKER_TOKEN_HAND_RUN');
  assert.equal(trackerTokenEnv({ TRACKER_TOKEN_NAME: '' }), 'TRACKER_TOKEN_HAND_RUN');
  const noHandRun = [{ secret: 'TRACKER_TOKEN_RELAY', kind: 'machine', name: 'relay' }, { secret: 'TRACKER_TOKEN_OPERATOR', kind: 'human', name: null, handRun: true }];
  assert.throws(() => trackerTokenEnv({}, noHandRun), /no hand-run seat/);
  for (const ok of ['TRACKER_TOKEN_LOOP_BUILD', 'TRACKER_TOKEN_LOOP_REVIEW', 'TRACKER_TOKEN_RELAY', 'TRACKER_TOKEN_HAND_RUN']) {
    assert.equal(trackerTokenEnv({ TRACKER_TOKEN_NAME: ok }), ok);
  }
  for (const bad of ['TRACKER_TOKEN_OPERATOR', 'TRACKER_TOKEN_LOOP_SPEC', 'CLICKUP_API_TOKEN', 'TRACKER_TOKEN', 'TRACKER_TOKEN_', 'tracker_token_relay', 'TRACKER_TOKEN_A;B']) {
    assert.throws(() => trackerTokenEnv({ TRACKER_TOKEN_NAME: bad }), /must name a loop's own tracker secret/, bad);
  }
});

test('a runner that names its own secret signs the door in as that loop, and a missing one is named', async () => {
  const f = await fixture();
  try {
    const r = await f.door(['whoami'], { token: f.humanToken, env: { TRACKER_TOKEN_NAME: 'TRACKER_TOKEN_LOOP_BUILD', TRACKER_TOKEN_LOOP_BUILD: f.machineToken } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`Acting as: Loop .*\\(id ${f.machine.id}\\)`));
    const missing = await f.door(['whoami'], { env: { TRACKER_TOKEN_NAME: 'TRACKER_TOKEN_RELAY' } });
    assert.equal(missing.code, 2);
    assert.match(missing.err, /TRACKER_TOKEN_RELAY is not set/);
    const bad = await f.door(['whoami'], { env: { TRACKER_TOKEN_NAME: 'CLICKUP_API_TOKEN' } });
    assert.equal(bad.code, 1);
    assert.match(bad.err, /must name a loop's own tracker secret/);
    const operator = await f.door(['whoami'], { env: { TRACKER_TOKEN_NAME: 'TRACKER_TOKEN_OPERATOR', TRACKER_TOKEN_OPERATOR: f.humanToken } });
    assert.equal(operator.code, 1);
    assert.match(operator.err, /must name a loop's own tracker secret.*not "TRACKER_TOKEN_OPERATOR"/);
    assert.doesNotMatch(operator.out, /Acting as/);
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
      'main:     (no MAIN MOVED note)', `url:      ${f.url}/tickets/AL-1`, '---', '## Goal\nDo it.\n', '',
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

test('a Requested ticket is never claimable and never waiting on Dane, even assigned to him with the newest word a loop\'s', async () => {
  const f = await fixture();
  try {
    f.file({ name: 'asked for from the page', status: 'requested', priority: 'urgent', assignee: f.human.id });
    f.store.postComment({ ticket: 'AL-1', author: f.machine.id, body: 'a loop spoke last' });
    f.file({ name: 'queued low', priority: 'low' });
    const claimable = await f.door(['queue', '--claimable']);
    assert.equal(claimable.code, 0, claimable.err);
    assert.deepEqual(claimable.out.trim().split('\n').map((l) => l.split('\t')[0]), ['AL-2']);

    const all = await f.door(['waiting']);
    assert.equal(all.code, 0, all.err);
    assert.ok(!all.out.includes('AL-1'), all.out);
    assert.match(all.err, /0 ticket\(s\) actually waiting on Dane/);

    const one = await f.door(['waiting', '--task', 'AL-1']);
    assert.equal(one.code, 0, one.err);
    assert.match(one.out, /^AL-1\trequested\t.*NOT HIS — status "requested" is a machine status/);
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
    assert.match(bad.err, /set status FAILED — HTTP 400\n"Shipped" is not one of the eight statuses/);
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

test('a card whose @@ASKED holds his own "> " and ``` lines posts, stores and renders with the ask outside the code box (SP-44)', async () => {
  const f = await fixture();
  try {
    f.file({ name: 'one', status: 'building' });
    const asked = 'forward this:\n> the old email line\n```\nnpm run thing\n```\nthanks';
    const card = `@@ASKED\n${asked}\n@@CONTEXT\n${sixty}\n@@NEEDED\nReply "go" to queue it.\nYour move: Reply — go.`;
    const r = await f.door(['ask', '--task', 'AL-1', '--body-file', '-'], { stdin: card });
    assert.equal(r.code, 0, r.err);
    const [stored] = f.store.listComments('AL-1');
    // His words sit in one fence longer than his own ```, so it holds them all.
    assert.ok(stored.body.includes(`\`\`\`\`\n${asked}\n\`\`\`\``), stored.body);
    const html = renderMarkdown(stored.body);
    const pres = html.match(/<pre><code>[\s\S]*?<\/code><\/pre>/g) || [];
    assert.equal(pres.length, 1, html);
    assert.ok(pres[0].includes('&gt; the old email line') && pres[0].includes('npm run thing') && pres[0].includes('thanks'), pres[0]);
    const outside = html.replace(pres[0], '');
    assert.match(outside, /NEEDED FROM DANE: Reply/);
    assert.match(outside, /WHAT&#39;S GOING ON|WHAT'S GOING ON/);
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
    // The refusal prints the line for THIS tracker: its own link, not ClickUp's (SP-32).
    // The page (/t/), not the API route, on the config file's address.
    assert.ok(refused.err.includes(`\n  Ticket: ${f.url}/t/AL-1\n`), refused.err);
    // Reached through a TRACKER_URL override (Doppler's 127.0.0.1 on the Mini),
    // the line it prints still uses the address in the config file.
    const viaOverride = await f.door(['pr-opened', '--task', 'AL-1', '--pr', 'https://github.com/owner/repo/pull/7'],
      { env: { TRACKER_URL: `http://localhost:${new URL(f.url).port}` } });
    assert.equal(viaOverride.code, 4, viaOverride.err);
    assert.ok(viaOverride.err.includes(`\n  Ticket: ${f.url}/t/AL-1\n`), viaOverride.err);

    // A neighbour's id is not this ticket's: AL-10 does not name AL-1. On the
    // fixture's own port, so it is refused for the id and not the port.
    f.prBody = 'Summary.\n\nTicket: http://127.0.0.1:' + new URL(f.url).port + '/t/AL-10\n';
    assert.equal((await f.door(['pr-opened', '--task', 'AL-1', '--pr', 'https://github.com/owner/repo/pull/7'])).code, 4);

    // The ClickUp link form, which PRs opened before the switch carry, still names a tracker id.
    f.prBody = 'Summary.\n\nhttps://app.clickup.com/t/AL-1\n';
    const old = await f.door(['pr-opened', '--task', 'AL-1', '--pr', 'https://github.com/owner/repo/pull/7', '--if-missing']);
    assert.equal(old.code, 0, old.err);

    // The tracker's own link, by another name for the same machine, is the line a PR now carries.
    f.prBody = 'Summary.\n\nTicket: http://mac-mini.local:' + new URL(f.url).port + '/tickets/AL-1\n';
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

test('pr-opened --human-hours records the estimate and reads it back; a bad value writes nothing (SP-78)', async () => {
  const f = await fixture();
  try {
    f.file({ name: 'one', status: 'building' });
    f.prBody = 'Summary.\n\nTicket: ' + f.url + '/t/AL-1\n';
    const pr = ['pr-opened', '--task', 'AL-1', '--pr', 'https://github.com/owner/repo/pull/7'];
    for (const bad of ['0', '-2', '201', 'six']) {
      const r = await f.door([...pr, '--human-hours', bad]);
      assert.equal(r.code, 2, `${bad}: ${r.err}`);
      assert.match(r.err, /Nothing was written/);
    }
    assert.equal((await f.door([...pr, '--human-hours'])).code, 2);
    assert.equal(f.store.listComments('AL-1').length, 0);

    const r = await f.door([...pr, '--human-hours', '6', '--body-file', '-'], { stdin: 'Why that estimate: one module and its tests.' });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /human-hours estimate 6 recorded and read back/);
    const [only] = f.store.listComments('AL-1');
    const text = only.body ?? only.comment_text ?? '';
    assert.match(text, /^PR opened: https:\/\/github\.com\/owner\/repo\/pull\/7\nHuman-hours estimate: 6\n\nWhy that estimate/);
    const get = await f.door(['get', '--task', 'AL-1']);
    assert.match(get.out, /\npr: {7}https:\/\/github\.com\/owner\/repo\/pull\/7\n/);
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

test('relay merges on his word and the merge marker lands as a reply, even after gh outlasts the keep-alive (SP-102)', async () => {
  const f = await fixture();
  try {
    f.file({ name: 'one', status: 'building' });
    f.prBody = `Summary.\n\nTicket: ${f.url}/t/AL-1\n`;
    assert.equal((await f.door(['pr-opened', '--task', 'AL-1', '--pr', 'https://github.com/owner/repo/pull/7'])).code, 0);
    await f.door(['status', '--task', 'AL-1', '--status', 'In review']);
    const pass = await f.door(['verdict', '--task', 'AL-1', '--pass', '--if-status', 'In review', '--body-file', '-'], { stdin: 'All good.' });
    assert.equal(pass.code, 0, pass.err);
    f.store.changeTicket('AL-1', { actor: f.machine.id, status: 'ready to launch', assignee: f.human.id });
    const word = f.store.postComment({ ticket: 'AL-1', author: f.human.id, body: 'merge' });

    // On the Mini, `gh pr merge` took six seconds against the tracker's
    // five-second keep-alive, and the marker POST after it went out on the
    // closed connection. Here: a three-second keep-alive (fetch will not
    // reuse a connection on a shorter one) and a fake merge of four and a half.
    f.server.keepAliveTimeout = 3000;
    const open = { number: 7, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', url: 'https://github.com/owner/repo/pull/7', headRefName: 'one',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
    f.prJson = open;
    const merged = join(f.dir, 'merged.json');
    writeFileSync(merged, JSON.stringify({ ...open, state: 'MERGED', mergedAt: '2026-11-03T19:32:41Z' }));
    writeFileSync(join(f.bin, 'gh'), `#!/bin/sh\ncase "$2" in merge) sleep 4.5; cp "${merged}" "${join(f.dir, 'pr.json')}" ;; *) cat "${join(f.dir, 'pr.json')}" ;; esac\n`);

    const r = await f.door(['relay']);
    assert.match(r.out, /AL-1.*merged.*PR #7/, `${r.out}\n${r.err}`);
    assert.doesNotMatch(r.err, /could NOT write the dedup marker/, r.err);
    const replies = f.store.listComments('AL-1').filter((c) => c.parent === word.id);
    assert.equal(replies.length, 1, 'the marker is a reply on his word');
    assert.match(replies[0].body, /merged PR #7/);
    assert.equal(f.store.getTicket('AL-1').status, 'live');
  } finally { await f.cleanup(); }
});

/** A Ready to launch catch-up ticket shaped like SP-64: no PR of its own, a Close card, and his close word. */
async function closeOnReadyToLaunch(f) {
  f.file({ name: 'Find out why PR #7 (fix) will not merge', status: 'ready to launch', description: '## The branch\n\n- PR: https://github.com/owner/repo/pull/7\n- Branch: `fix`' });
  const card = `@@ASKED\nmerge\n@@CONTEXT\n${sixty}\n@@NEEDED\nNothing to merge: PR #7 has already landed.\nYour move: Close — its work is live.`;
  const ask = await f.door(['ask', '--task', 'AL-1', '--no-move', '--body-file', '-'], { stdin: card });
  assert.equal(ask.code, 0, ask.err);
  return f.store.postComment({ ticket: 'AL-1', author: f.human.id, body: 'close' });
}

test('relay closes a Ready to launch ticket on his close word once the PR it unstuck is merged, and replies saying so (SP-68)', async () => {
  const f = await fixture();
  try {
    const answer = await closeOnReadyToLaunch(f);
    f.prJson = { number: 7, state: 'MERGED' };
    const dry = await f.door(['relay', '--dry-run']);
    assert.equal(dry.code, 0, `${dry.out}\n${dry.err}`);
    assert.match(dry.out, /AL-1.*would-close.*"Live".*PR #7, the pull request this ticket was filed to unstick, is merged/);
    assert.equal(f.store.getTicket('AL-1').status, 'ready to launch', 'a dry run moves nothing');

    const r = await f.door(['relay']);
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    assert.match(r.out, /AL-1.*closed.*reply verified/);
    const t = f.store.getTicket('AL-1');
    assert.equal(t.status, 'live');
    assert.equal(t.assignee, null);
    const replies = f.store.listComments('AL-1').filter((c) => c.parent === answer.id);
    assert.equal(replies.length, 1);
    assert.match(replies[0].body, /this ticket was closed \(moved to "live"\), as you asked/i);
  } finally { await f.cleanup(); }
});

test('a close word on a ticket whose work is not merged moves nothing, and the relay says why once (SP-68)', async () => {
  const f = await fixture();
  try {
    const answer = await closeOnReadyToLaunch(f);
    f.prJson = { number: 7, state: 'OPEN' };
    for (let pass = 0; pass < 2; pass += 1) {
      const r = await f.door(['relay']);
      assert.equal(r.code, 0, `${r.out}\n${r.err}`);
      assert.match(r.out, pass === 0 ? /AL-1.*close-refused\t.*is still open/ : /AL-1.*close-refused-quiet/);
      assert.equal(f.store.getTicket('AL-1').status, 'ready to launch');
    }
    const replies = f.store.listComments('AL-1').filter((c) => c.parent === answer.id);
    assert.equal(replies.length, 1, 'said once, not once per pass');
    assert.match(replies[0].body, /Not closed yet: PR #7, the pull request this ticket was filed to unstick, is still open/);

    // The PR merges: his same word now closes it.
    f.prJson = { number: 7, state: 'MERGED' };
    const r = await f.door(['relay']);
    assert.match(r.out, /AL-1.*closed/);
    assert.equal(f.store.getTicket('AL-1').status, 'live');
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

// ── A ticket a dead build pass left in Building (SP-101) ─────────────────────
/**
 * The build runner, as far as the door can see it: a home folder holding the
 * lane's lock with a live pid in it (a `sleep` standing in for the runner),
 * and the product folder made a git checkout so the claim marker has a home.
 * `ours` is the env of a pass the runner started; `hand` is a hand-run session.
 */
function buildRunner(f) {
  const home = join(f.dir, 'home');
  const lock = join(home, 'loop-logs', 'alpha-loop-build.lock');
  mkdirSync(lock, { recursive: true });
  const runner = spawn('sleep', ['60'], { stdio: 'ignore' });
  writeFileSync(join(lock, 'pid'), `${runner.pid}\n`);
  spawnSync('git', ['init', '-q'], { cwd: f.product });
  return {
    marker: join(f.product, '.git', 'loop-pass-claim.json'),
    ours: { HOME: home, LOOP_RUNNER_PID: String(runner.pid) },
    hand: { HOME: home },
    async stop() {
      if (runner.exitCode !== null || runner.signalCode !== null) return;
      const exited = new Promise((r) => runner.once('exit', r));
      runner.kill();
      await exited;
    },
  };
}

test('pass-reconcile: the runner\'s next pass hands back a no-PR ticket its dead pass left in Building, to Queued, with a note read back', async () => {
  const f = await fixture();
  const lane = buildRunner(f);
  try {
    f.file({ name: 'one' });
    const claim = await f.door(['claim', '--task', 'AL-1'], { env: lane.ours });
    assert.equal(claim.code, 0, claim.err);
    assert.match(claim.err, /pass marker written for AL-1/);
    assert.ok(existsSync(lane.marker), 'the claim armed the marker before it moved the ticket');
    // ...and the pass dies here. Its comments, or the lack of them, do not matter: there is no timer.

    const r = await f.door(['pass-reconcile'], { env: lane.ours });
    assert.equal(r.code, 3, r.err);
    assert.match(r.out, /THE PREVIOUS PASS DROPPED ITS TICKET .*Handed back to Queued/);
    assert.equal(f.store.getTicket('AL-1').status, 'queued');
    const notes = f.store.listComments('AL-1');
    assert.equal(notes.length, 1, 'one note');
    assert.match(notes[0].body, /^Put back in Queued: the build pass that claimed this ticket at .* MT ended without handing it on/);
    assert.match(notes[0].body, /Nothing was deleted/);
    assert.match(r.err, /AL-1: note \d+ read back/);
    assert.ok(!existsSync(lane.marker), 'a finished hand-back spends the marker');

    const again = await f.door(['pass-reconcile'], { env: lane.ours });
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /No claim was left behind/);
  } finally { await lane.stop(); await f.cleanup(); }
});

test('pass-reconcile: a hand-run claim arms nothing, and a hand-run reconcile leaves a live runner\'s ticket alone until the runner is gone', async () => {
  const f = await fixture();
  const lane = buildRunner(f);
  try {
    f.file({ name: 'hand' });
    f.file({ name: 'loop' });
    const hand = await f.door(['claim', '--task', 'AL-1'], { env: lane.hand });
    assert.equal(hand.code, 0, hand.err);
    assert.match(hand.err, /no pass marker: a build runner \(pid \d+\) is running and this session is not under it/);
    assert.ok(!existsSync(lane.marker), 'a person\'s claim never arms the marker, so no pass can take it back');

    const loop = await f.door(['claim', '--task', 'AL-2'], { env: lane.ours });
    assert.equal(loop.code, 0, loop.err);
    const held = await f.door(['pass-reconcile'], { env: lane.hand });
    assert.equal(held.code, 0, held.err);
    assert.match(held.out, /^LEFT ALONE — .*AL-2 may be the ticket it is building/);
    assert.equal(f.store.getTicket('AL-2').status, 'building');
    assert.equal(f.store.listComments('AL-2').length, 0);
    assert.ok(existsSync(lane.marker), 'the live claim keeps its marker');

    await lane.stop();
    const gone = await f.door(['pass-reconcile'], { env: lane.hand });
    assert.equal(gone.code, 3, gone.err);
    assert.match(gone.err, /build lock .*: free/);
    assert.equal(f.store.getTicket('AL-2').status, 'queued', 'no runner, so the pass that marked it is gone too');
    assert.equal(f.store.getTicket('AL-1').status, 'building', 'the hand-run claim is never touched');
  } finally { await lane.stop(); await f.cleanup(); }
});

test('pass-reconcile: a dead Rework pass, whose ticket already has a PR, goes back to Rework', async () => {
  const f = await fixture();
  const lane = buildRunner(f);
  try {
    f.file({ name: 'one', status: 'building' });
    f.prBody = `Summary.\n\nTicket: ${f.url}/t/AL-1\n`;
    assert.equal((await f.door(['pr-opened', '--task', 'AL-1', '--pr', 'https://github.com/owner/repo/pull/7'])).code, 0);
    assert.equal((await f.door(['status', '--task', 'AL-1', '--status', 'Rework'])).code, 0);

    assert.equal((await f.door(['claim', '--task', 'AL-1'], { env: lane.ours })).code, 0);
    const r = await f.door(['pass-reconcile'], { env: lane.ours });
    assert.equal(r.code, 3, r.err);
    assert.equal(f.store.getTicket('AL-1').status, 'rework');
    const note = f.store.listComments('AL-1').at(-1).body;
    assert.match(note, /^Put back in Rework: .*\nWhy Rework: it already has a pull request, so the next pass finishes that one\./);
  } finally { await lane.stop(); await f.cleanup(); }
});

test('pass-reconcile: a pass that handed its ticket on leaves nothing behind', async () => {
  const f = await fixture();
  const lane = buildRunner(f);
  try {
    f.file({ name: 'one' });
    assert.equal((await f.door(['claim', '--task', 'AL-1'], { env: lane.ours })).code, 0);
    const handoff = await f.door(['status', '--task', 'AL-1', '--status', 'In review'], { env: lane.ours });
    assert.equal(handoff.code, 0, handoff.err);
    assert.match(handoff.err, /pass marker cleared: AL-1 was handed on/);
    assert.ok(!existsSync(lane.marker));
    const r = await f.door(['pass-reconcile'], { env: lane.ours });
    assert.equal(r.code, 0, r.err);
    assert.equal(f.store.getTicket('AL-1').status, 'in review');
  } finally { await lane.stop(); await f.cleanup(); }
});

test('pass-reconcile: a marker still owed a hand-back is never overwritten by the next claim, so a failed reconcile is retried', async () => {
  const f = await fixture();
  const lane = buildRunner(f);
  try {
    f.file({ name: 'stranded' });
    f.file({ name: 'next' });
    assert.equal((await f.door(['claim', '--task', 'AL-1'], { env: lane.ours })).code, 0);
    // ...the pass dies, and the reconcile that should hand AL-1 back fails
    // (exit 1 or 2), keeping the marker. The same pass then tries to claim.
    const r = await f.door(['claim', '--task', 'AL-2'], { env: lane.ours });
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /NOT claimed: the claim marker names AL-1, still in Building/);
    assert.match(r.err, /pass-reconcile/);
    assert.equal(f.store.getTicket('AL-2').status, 'queued', 'nothing was claimed');
    assert.match(readFileSync(lane.marker, 'utf8'), /"task": "AL-1"/, 'the marker still names the stranded ticket');

    const fixed = await f.door(['pass-reconcile'], { env: lane.ours });
    assert.equal(fixed.code, 3, fixed.err);
    assert.equal(f.store.getTicket('AL-1').status, 'queued');
    assert.equal((await f.door(['claim', '--task', 'AL-2'], { env: lane.ours })).code, 0, 'once handed back, the next claim goes ahead');
  } finally { await lane.stop(); await f.cleanup(); }
});

test('pass-reconcile: a claim refused at its guard clears the marker it wrote, so a hand-run session that won the race keeps its ticket', async () => {
  const f = await fixture();
  const lane = buildRunner(f);
  try {
    f.file({ name: 'raced' });
    // A hand-run session takes AL-1 between the loop's read and its guarded write.
    const change = f.store.changeTicket.bind(f.store);
    f.store.changeTicket = (id, fields) => {
      if (fields.ifStatus !== undefined && fields.status === 'Building') {
        f.store.changeTicket = change;
        change(id, { actor: f.human.id, status: 'building' });
      }
      return change(id, fields);
    };
    const r = await f.door(['claim', '--task', 'AL-1'], { env: lane.ours });
    assert.equal(r.code, 3, r.err);
    assert.match(r.err, /NOT moved: expected status "queued" but the tracker refused the write/);
    assert.match(r.err, /pass marker cleared: the claim of AL-1 was refused/);
    assert.ok(!existsSync(lane.marker), 'no marker names a ticket this pass never took');

    const next = await f.door(['pass-reconcile'], { env: lane.ours });
    assert.equal(next.code, 0, next.err);
    assert.equal(f.store.getTicket('AL-1').status, 'building', 'the hand session\'s ticket is never handed back');
    assert.equal(f.store.listComments('AL-1').length, 0);
  } finally { await lane.stop(); await f.cleanup(); }
});

test('an unreachable tracker answers HTTP 0, not a throw', async () => {
  const t = createApiTracker({ token: 'tok', baseUrl: 'http://127.0.0.1:1', project: 'alpha', listId: LIST, log: () => {} });
  const out = await t.getTask('AL-1');
  assert.equal(out.res.ok, false);
  assert.equal(out.res.status, 0);
  assert.match(out.text, /never reached the tracker \(fetch failed — \S/, 'the reason is kept, not only "fetch failed"');
});
