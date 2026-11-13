/**
 * SP-226: the tracker page checks a pull request's live state before it
 * tells Dane a merge is his move. The GitHub read is always a stand-in here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { seedDemo, tickingClock, demoPrState, DEMO_MERGED_PR } from './demoData.mjs';
import { startServer } from './server.mjs';
import { ghPrState, prStateCache, normalState, PR_STATE_KEEP_MS } from './prState.mjs';
import { renderMergeAction, renderQuickAction, renderPullRequestState, prSettled } from './web/render.mjs';
import operatorCard from '../lib/operatorCard.js';
import machineComment from '../lib/machineComment.js';

const { buildCard } = operatorCard;
const { stampMachineComment } = machineComment;

// ── The read and its minute ──────────────────────────────────────────────────

test('ghPrState asks gh for the one PR in the named repository and reads its state', async () => {
  const calls = [];
  const run = (cmd, args, opts, done) => { calls.push({ cmd, args, opts }); done(null, '{"state":"MERGED"}\n'); };
  assert.equal(await ghPrState({ run })({ repo: 'owner/name', number: 169 }), 'MERGED');
  assert.equal(calls[0].cmd, 'gh');
  assert.deepEqual(calls[0].args, ['pr', 'view', '169', '--repo', 'owner/name', '--json', 'state']);
  assert.ok(calls[0].opts.timeout > 0, 'a slow GitHub cannot hold the page forever');
});

test('ghPrState answers null, never a guess, when the read fails in any way', async () => {
  const failing = [
    (c, a, o, done) => done(new Error('gh: not signed in'), ''),
    (c, a, o, done) => done(null, 'not json'),
    (c, a, o, done) => done(null, '{"state":"SOMETHING_NEW"}'),
    (c, a, o, done) => done(null, '{}'),
    () => { throw new Error('spawn gh ENOENT'); },
  ];
  for (const run of failing) assert.equal(await ghPrState({ run })({ repo: 'owner/name', number: 1 }), null);
  let asked = false;
  const run = (c, a, o, done) => { asked = true; done(null, '{"state":"OPEN"}'); };
  assert.equal(await ghPrState({ run })({ repo: null, number: 1 }), null, 'no repository: never asked');
  assert.equal(asked, false);
});

test('normalState keeps only OPEN, MERGED and CLOSED', () => {
  assert.equal(normalState('merged'), 'MERGED');
  assert.equal(normalState(' Closed '), 'CLOSED');
  assert.equal(normalState('OPEN'), 'OPEN');
  for (const v of [null, undefined, '', 'DRAFT', 42]) assert.equal(normalState(v), null);
});

test('the cache asks GitHub at most once a minute per pull request, a failed read included', async () => {
  let at = 1_000_000;
  const asked = [];
  let answer = 'OPEN';
  const cache = prStateCache({ read: async (pr) => { asked.push(`${pr.repo}#${pr.number}`); return answer; }, now: () => at });
  const pr = { repo: 'owner/name', number: 5 };

  // Two at once share one call.
  assert.deepEqual(await Promise.all([cache.stateOf(pr), cache.stateOf(pr)]), ['OPEN', 'OPEN']);
  assert.equal(asked.length, 1);

  answer = 'MERGED';
  at += PR_STATE_KEEP_MS - 1;
  assert.equal(await cache.stateOf(pr), 'OPEN', 'inside the minute: the kept answer');
  assert.equal(asked.length, 1);

  // Another PR is its own question.
  assert.equal(await cache.stateOf({ repo: 'owner/name', number: 6 }), 'MERGED');
  assert.equal(asked.length, 2);

  at += 1;
  assert.equal(await cache.stateOf(pr), 'MERGED', 'a minute on: asked again');
  assert.equal(asked.length, 3);

  // A read that throws is a failed read, kept for the minute too, so an
  // unreachable GitHub is not hammered on every redraw.
  const broken = prStateCache({ read: async () => { asked.push('x'); throw new Error('offline'); }, now: () => at });
  assert.equal(await broken.stateOf(pr), null);
  assert.equal(await broken.stateOf(pr), null);
  assert.equal(asked.filter((a) => a === 'x').length, 1);
});

// ── The page, against the demo data, with a stand-in GitHub ──────────────────

/**
 * The demo data, a server whose GitHub read is `states` (PR number to its
 * state, or 'FAIL' to throw), a clock the test moves, and a caller signed
 * in as the operator.
 */
async function fixture(states = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-prstate-'));
  const clock = tickingClock();
  const store = openStore(join(dir, 'tracker.db'), { now: clock });
  const seed = seedDemo(store, { operatorName: 'Dane', clock });
  const reads = [];
  let at = 5_000_000;
  const readPrState = async ({ repo, number }) => {
    reads.push(`${repo}#${number}`);
    const s = states[number];
    if (s === 'FAIL') throw new Error('GitHub could not be reached');
    if (s !== undefined) return s;
    return demoPrState({ repo, number });
  };
  const server = await startServer({ store, port: 0, mergePhrase: 'merge', now: () => at, readPrState });
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (path) => {
    const res = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${seed.token}` } });
    return { status: res.status, body: await res.json() };
  };
  const idOf = (name) => store.listTickets('beta').concat(store.listTickets('alpha')).find((t) => t.name === name).id;
  const thread = async (id) => ({ ...(await call(`/tickets/${id}/thread`)).body, mergePhrase: 'merge' });
  const cleanup = async () => {
    await new Promise((r) => server.close(r));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { ...seed, store, call, idOf, thread, reads, tick: (ms) => { at += ms; }, cleanup };
}

const REVIEWED = 'Descriptions with HTML break the page: show them as text'; // PR #12, waits on him by status
const MERGED_NOT_LIVE = 'Merged on GitHub but not yet Live'; // PR #14, merged in the demo's stand-in

/** Give a ticket a machine card asking for the merge, as its newest comment. */
function mergeCard(f, id) {
  f.store.postComment({ ticket: id, author: f.loop.id, body: stampMachineComment(buildCard([
    '@@ASKED', 'merge it when it is ready',
    '@@CONTEXT', 'The review passed and the checks are green. The pull request changes how the page shows a description, so markup in it reads as text and never runs. Nothing else on the page changes, and no ticket moves until the merge word is given and the relay acts on it at its next pass, which takes a few minutes at most.',
    '@@NEEDED', 'Merge the pull request.', 'Your move: Merge — the review passed.',
  ].join('\n')).rendered) });
}

test('a Ready to launch ticket whose PR is merged is not waiting on him: off Waiting on You, the bell, the board and the Console', async () => {
  const f = await fixture({ 12: 'MERGED' });
  try {
    const id = f.idOf(REVIEWED);
    mergeCard(f, id);
    const { waiting, unsure } = (await f.call('/waiting')).body;
    assert.ok(!waiting.some((t) => t.id === id), 'not listed: the bell and the tab title count this list');
    assert.ok(!unsure.some((t) => t.id === id));
    const board = (await f.call('/projects/beta/board')).body;
    const row = board.columns.flatMap((c) => c.tickets).find((t) => t.id === id);
    assert.equal(row.waiting, false, 'the List view agrees with Waiting on You (SP-201)');
    const console_ = (await f.call('/in-flight')).body;
    assert.equal(console_.tickets.find((t) => t.id === id).waitingOnOperator, false);
  } finally { await f.cleanup(); }
});

test('the merged ticket\'s page shows no Merge button and no "Your move: Merge", and says the PR is merged', async () => {
  const f = await fixture({ 12: 'MERGED' });
  try {
    const id = f.idOf(REVIEWED);
    mergeCard(f, id);
    const t = await f.thread(id);
    assert.deepEqual(t.pullRequestState, { number: 12, state: 'MERGED' });
    const html = renderMergeAction(t);
    assert.doesNotMatch(html, /<button/);
    assert.match(html, /PR #12 is merged\. The ticket has not moved to Live yet; that is the relay's job, not yours\./);
    assert.doesNotMatch(renderQuickAction(t), /Your move/);
  } finally { await f.cleanup(); }
});

test('a PR closed without merging: no Merge button, the closed line, and not counted as waiting', async () => {
  const f = await fixture({ 12: 'CLOSED' });
  try {
    const id = f.idOf(REVIEWED);
    const { waiting } = (await f.call('/waiting')).body;
    assert.ok(!waiting.some((t) => t.id === id));
    const html = renderMergeAction(await f.thread(id));
    assert.doesNotMatch(html, /<button/);
    assert.match(html, /PR #12 was closed without merging\./);
  } finally { await f.cleanup(); }
});

test('a PR that is open: exactly as before, counted and with its Merge button', async () => {
  const f = await fixture({ 12: 'OPEN' });
  try {
    const id = f.idOf(REVIEWED);
    mergeCard(f, id);
    assert.ok((await f.call('/waiting')).body.waiting.some((t) => t.id === id));
    const t = await f.thread(id);
    const html = renderMergeAction(t);
    assert.match(html, /<button type="submit">Merge<\/button>/);
    assert.doesNotMatch(html, /pr-state/, 'an open PR adds no line');
    assert.match(renderQuickAction(t), /Your move: Merge/);
  } finally { await f.cleanup(); }
});

test('a PR whose state cannot be read: nothing hidden, plus the "Could not check" line', async () => {
  for (const failure of ['FAIL', null]) {
    const f = await fixture({ 12: failure });
    try {
      const id = f.idOf(REVIEWED);
      mergeCard(f, id);
      assert.ok((await f.call('/waiting')).body.waiting.some((t) => t.id === id), 'a failed read never counts as merged');
      const t = await f.thread(id);
      assert.deepEqual(t.pullRequestState, { number: 12, state: null });
      const html = renderMergeAction(t);
      assert.match(html, /<button type="submit">Merge<\/button>/);
      assert.match(html, /Could not check PR #12 on GitHub just now\./);
    } finally { await f.cleanup(); }
  }
});

test('the page asks GitHub about each pull request at most once a minute, however often it redraws', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 3; i++) {
      await f.call('/waiting');
      await f.call('/projects/beta/board');
      await f.thread(f.idOf(REVIEWED));
    }
    const counts = (reads) => reads.reduce((m, r) => m.set(r, (m.get(r) ?? 0) + 1), new Map());
    for (const [pr, n] of counts(f.reads)) assert.equal(n, 1, `${pr} asked ${n} times inside a minute`);
    f.tick(PR_STATE_KEEP_MS);
    await f.call('/waiting');
    for (const [pr, n] of counts(f.reads)) assert.equal(n, 2, `${pr} asked again after the minute`);
  } finally { await f.cleanup(); }
});

test('only tickets in his two statuses are checked, and a PR in another repository than the project\'s is never asked', async () => {
  const f = await fixture();
  try {
    await f.call('/waiting');
    // AL-2 (answered), BE review, the merged demo, the Close card's ticket has no PR: none from a machine status.
    assert.ok(!f.reads.includes('example/repo#9'), 'the Live ticket\'s PR is not asked');
    f.store.updateProject('beta', { repo: 'someone/else' });
    f.tick(PR_STATE_KEEP_MS);
    const before = f.reads.length;
    const t = await f.thread(f.idOf(REVIEWED));
    assert.equal(f.reads.length, before, 'not asked');
    assert.deepEqual(t.pullRequestState, { number: 12, state: null });
  } finally { await f.cleanup(); }
});

test('the demo: "Merged on GitHub but not yet Live" is off Waiting on You and shows the merged line', async () => {
  const f = await fixture();
  try {
    const id = f.idOf(MERGED_NOT_LIVE);
    assert.ok(!(await f.call('/waiting')).body.waiting.some((t) => t.id === id));
    const t = await f.thread(id);
    assert.equal(t.pullRequest, DEMO_MERGED_PR);
    const html = renderMergeAction(t);
    assert.doesNotMatch(html, /<button/);
    assert.match(html, /^<p class="pr-state">PR #14 is merged\./);
  } finally { await f.cleanup(); }
});

test('the PR line is for Ready to launch only, and absent when no read was made', () => {
  const pr = 'https://github.com/o/r/pull/3';
  assert.equal(renderPullRequestState({ status: 'needs your input', pullRequest: pr, pullRequestState: { number: 3, state: 'MERGED' } }), '');
  assert.equal(renderPullRequestState({ status: 'ready to launch', pullRequest: pr }), '');
  assert.equal(renderPullRequestState({ status: 'ready to launch', pullRequest: null, pullRequestState: { number: 3, state: 'MERGED' } }), '');
  assert.equal(prSettled({ status: 'ready to launch', pullRequestState: { number: 3, state: null } }), false);
  assert.equal(prSettled({ status: 'needs your input', pullRequestState: { number: 3, state: 'CLOSED' } }), false);
  // Without a read, exactly as before.
  assert.match(renderMergeAction({ status: 'ready to launch', mergePhrase: 'merge', pullRequest: pr }), /^<form class="merge-action">/);
});
