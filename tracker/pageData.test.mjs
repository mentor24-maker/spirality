// heldUpBy (SP-228): is a ticket held up by a lane that keeps failing, rather
// than waiting on Dane? Plain rows in, no store, no clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldUpBy } from './pageData.mjs';

const DANE = 7;
const LOOP = 9;
const SINCE = '2026-11-11T04:00:00.000Z';

/** GET /pipeline's stages as heldUpBy reads them, with the named jobs failing. */
function lanes(...failing) {
  const stages = [['Relay', 'relay'], ['Build', 'loop-build'], ['Review', 'loop-review'], ['Intake', 'loop-intake']].map(([name, job]) => ({
    name, job,
    failing: failing.includes(job),
    failingSince: failing.includes(job) ? SINCE : null,
    failingReason: failing.includes(job) ? 'keeps failing' : null,
  }));
  return new Map(stages.map((s) => [s.job, s]));
}

const ticket = (status, assignee = DANE) => ({ status, assignee });
let minute = 0;
const said = (author, body) => ({ author, body, createdAt: new Date(Date.UTC(2026, 10, 11, 3, minute++)).toISOString() });
const CARD = said(LOOP, '@@ASKED\nmerge it\n\nYour move: Merge');
const MERGE = said(DANE, 'merge');
const QUESTION = said(LOOP, '@@ASKED\nmerge\n\n@@NEEDED\nWhich one?\nYour move: Reply');

test('a Ready to launch ticket whose newest word is his "merge" is held up by a failing relay, with its name, reason and start (SP-228)', () => {
  assert.deepEqual(heldUpBy(ticket('ready to launch'), [CARD, MERGE], DANE, lanes('relay')),
    { stage: 'Relay', job: 'relay', reason: 'keeps failing', since: SINCE });
  assert.deepEqual(heldUpBy(ticket('needs your input'), [CARD, MERGE], DANE, lanes('relay')).stage, 'Relay');
});

test('a ticket that truly waits on him is never held up, whatever is failing (SP-228)', () => {
  const all = lanes('relay', 'loop-build', 'loop-review', 'loop-intake');
  assert.equal(heldUpBy(ticket('needs your input'), [CARD, MERGE, QUESTION], DANE, all), null, 'a loop\'s question is the newest word, after his');
  assert.equal(heldUpBy(ticket('ready to launch'), [CARD], DANE, all), null);
  // His lane, not assigned: the verdict cannot tell, and his word is not the newest: shown, never hidden.
  assert.equal(heldUpBy(ticket('ready to launch', null), [CARD], DANE, all), null);
});

test('a lane that is passing, or no lanes read, holds nothing up (SP-228)', () => {
  assert.equal(heldUpBy(ticket('ready to launch'), [CARD, MERGE], DANE, lanes('loop-build')), null, 'only the relay acts on his answer');
  assert.equal(heldUpBy(ticket('ready to launch'), [CARD, MERGE], DANE, lanes()), null);
  assert.equal(heldUpBy(ticket('ready to launch'), [CARD, MERGE], DANE, null), null);
  assert.equal(heldUpBy(ticket('ready to launch'), [CARD, MERGE], null, lanes('relay')), null, 'a project with no operator');
});

test('each machine status is held up by the lane that acts on it next; Building and Live by none (SP-228)', () => {
  const by = (status, failing) => heldUpBy(ticket(status, null), [], DANE, lanes(failing))?.stage ?? null;
  assert.equal(by('queued', 'loop-build'), 'Build');
  assert.equal(by('rework', 'loop-build'), 'Build');
  assert.equal(by('in review', 'loop-review'), 'Review');
  assert.equal(by('requested', 'loop-intake'), 'Intake');
  assert.equal(by('queued', 'loop-review'), null, 'another lane failing');
  assert.equal(by('in review', 'relay'), null);
  assert.equal(by('building', 'loop-build'), null, 'a pass is on it');
  assert.equal(by('live', 'relay'), null);
});

test('a failing stage with no reason or start still says it is held up (SP-228)', () => {
  const bare = new Map([['loop-build', { name: 'Build', job: 'loop-build', failing: true }]]);
  assert.deepEqual(heldUpBy(ticket('queued'), [], DANE, bare), { stage: 'Build', job: 'loop-build', reason: 'keeps failing', since: null });
});

// SP-302 (Dane's choice A, 2026-11-14): PP-8 showed on both Dane's and Rich's
// Waiting on You lists; Rich answered it and it stayed on Dane's. Through a
// real store, the way GET /waiting reads it for each of them.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { waitingFor, threadOf } from './pageData.mjs';
import operatorCard from '../lib/operatorCard.js';
import busRelayPlan from '../lib/busRelayPlan.js';

const ASK_CARD = `@@NEEDED\nWhich feed?\n${operatorCard.BANNER_LABEL}Your move: Reply`;

function teamStore() {
  const dir = mkdtempSync(join(tmpdir(), 'sp302-'));
  // A clock that moves a second each write: a reply is always AFTER the card
  // it answers, as it is in life (the same millisecond reads as before it).
  let tick = Date.parse('2026-11-14T21:00:00Z');
  const store = openStore(join(dir, 'tracker.db'), { now: () => new Date((tick += 1000)).toISOString() });
  const dane = store.createActor({ kind: 'human', name: 'Dane' });
  const rich = store.createActor({ kind: 'human', name: 'Rich' });
  const loop = store.createActor({ kind: 'machine', name: 'Loop' });
  store.createProject({ slug: 'pp', name: 'PressPlay', prefix: 'PP', operator: dane.id });
  return { store, dane, rich, loop, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const listed = (w) => [...w.waiting, ...w.unsure].map((x) => x.id);

test('SP-302: a teammate\'s reply to a Needs your input card takes it off every list, and the page says the answer is in', () => {
  const { store, dane, rich, loop, done } = teamStore();
  try {
    const t = store.fileTicket({ project: 'pp', actor: loop.id, name: 'Add a feed', status: 'Needs your input', assignee: dane.id });
    store.postComment({ ticket: t.id, author: loop.id, body: ASK_CARD, parent: null });
    assert.ok(listed(waitingFor(store, dane.id)).includes(t.id), 'on Dane\'s list before anyone answers');
    assert.ok(listed(waitingFor(store, rich.id)).includes(t.id), 'and on Rich\'s');

    store.postComment({ ticket: t.id, author: rich.id, body: 'UPI ok', parent: null });
    assert.deepEqual(listed(waitingFor(store, dane.id)), [], 'off Dane\'s list once Rich answered');
    assert.deepEqual(listed(waitingFor(store, rich.id)), [], 'and off Rich\'s');
    assert.equal(threadOf(store, t.id).answerIn, true);
  } finally { done(); }
});

test('SP-302: in Ready to launch a teammate\'s comment leaves it on Dane\'s list: only his merge word merges', () => {
  const { store, dane, rich, loop, done } = teamStore();
  try {
    const t = store.fileTicket({ project: 'pp', actor: loop.id, name: 'Add a feed', status: 'Ready to launch', assignee: dane.id });
    store.postComment({ ticket: t.id, author: loop.id, body: 'REVIEW: PASSED — all green.', parent: null });
    store.postComment({ ticket: t.id, author: rich.id, body: 'looks good', parent: null });
    assert.ok(waitingFor(store, dane.id).waiting.map((x) => x.id).includes(t.id));
    assert.equal(threadOf(store, t.id).answerIn, false);
  } finally { done(); }
});

test('SP-302: a teammate\'s comment on a ticket parked with no card leaves it on Dane\'s list (the relay never moves it)', () => {
  const { store, dane, rich, loop, done } = teamStore();
  try {
    const t = store.fileTicket({ project: 'pp', actor: loop.id, name: 'Add a feed', status: 'Needs your input', assignee: dane.id });
    store.postComment({ ticket: t.id, author: loop.id, body: 'Parked for Dane by hand.', parent: null });
    store.postComment({ ticket: t.id, author: rich.id, body: 'I will look later', parent: null });
    assert.ok(listed(waitingFor(store, dane.id)).includes(t.id));
    assert.equal(threadOf(store, t.id).answerIn, false);
  } finally { done(); }
});

test('SP-302: after an answer the relay already acted on, a teammate\'s "any update?" leaves it on Dane\'s list', () => {
  const { store, dane, rich, loop, done } = teamStore();
  try {
    const t = store.fileTicket({ project: 'pp', actor: loop.id, name: 'Add a feed', status: 'Needs your input', assignee: dane.id });
    store.postComment({ ticket: t.id, author: loop.id, body: ASK_CARD, parent: null });
    const his = store.postComment({ ticket: t.id, author: dane.id, body: 'B', parent: null });
    store.postComment({ ticket: t.id, author: loop.id, body: busRelayPlan.handbackDoneText({ target: 'Queued' }), parent: his.id });
    store.postComment({ ticket: t.id, author: rich.id, body: 'any update?', parent: null });
    assert.ok(listed(waitingFor(store, dane.id)).includes(t.id));
    assert.equal(threadOf(store, t.id).answerIn, false);
  } finally { done(); }
});

// SP-364: the page's data is split one file per page. pageData.mjs, the one
// name every importer uses, re-exports each page's file; pageData-common.mjs
// holds only what they share and is not re-exported.
test('pageData.mjs re-exports every page\'s data file, and the style check reads them all', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const here = fileURLToPath(new URL('.', import.meta.url));
  const pages = readdirSync(here).filter((n) => /^pageData-[a-z-]+\.mjs$/.test(n) && n !== 'pageData-common.mjs').sort();
  assert.ok(pages.length >= 2, 'the Reporting and search files');
  const hub = readFileSync(`${here}/pageData.mjs`, 'utf8');
  const gathered = [...hub.matchAll(/^export \* from '\.\/(pageData-[\w-]+\.mjs)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(gathered, pages);
  const style = readFileSync(`${here}/style.test.mjs`, 'utf8');
  for (const name of [...pages, 'pageData-common.mjs']) assert.ok(style.includes(`'./${name}'`), `style.test.mjs reads ${name}`);
});
