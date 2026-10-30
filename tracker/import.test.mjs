import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { importLoopQueue, formatReport, ImportReadError, SOURCE } from './import.mjs';
import { MACHINE_MARKER_LINE } from '../scripts/lib/machineComment.mjs';
import { createSignins, seatsFor } from './signins.mjs';
import { operatorImportKey } from './import.mjs';

const OPERATOR = '700';
const SERVICE = '800';
const OTHER = '900';

/** A config with made-up values, so nothing can pass by matching a real product. */
const CONFIG = Object.freeze({
  loopQueueListId: '4242',
  operatorUserId: OPERATOR,
  machineUserId: SERVICE,
  operatorName: 'Pat',
  productSlug: 'widget',
  trackerPrefix: 'WG',
});

const ms = (iso) => String(Date.parse(iso));
const ok = (json) => ({ res: { ok: true, status: 200 }, json, text: '' });
const failed = (status) => ({ res: { ok: false, status }, json: { err: 'boom' }, text: '' });

function task(id, { status = 'queued', created, name = `Ticket ${id}`, ...rest } = {}) {
  return {
    id, name, status: { status, type: status === 'live' ? 'closed' : 'custom' },
    date_created: ms(created), date_updated: ms(created),
    priority: { priority: 'normal' }, tags: [{ name: 'tracker' }], creator: { id: Number(OPERATOR) },
    assignees: [], ...rest,
  };
}

function comment(id, { at, user = OPERATOR, text, replies } = {}) {
  return { id, comment_text: text, user: { id: Number(user), username: `user${user}` }, date: ms(at), reply_count: replies ?? 0 };
}

/**
 * A fake ClickUp tracker over plain data. `tasks` are list-shaped; `bodies`
 * the markdown descriptions; `comments` per task (any order: ClickUp sends
 * newest first); `replies` per comment. `fail` names a method to break.
 * `calls` records every write-looking call, which must stay empty.
 */
function fakeTracker({ tasks, bodies = {}, comments = {}, replies = {}, fail = {} }) {
  const calls = [];
  const writes = [];
  const t = {
    calls, writes,
    async listTasksPage(list, page, opts) {
      calls.push(['listTasksPage', list, page, opts]);
      if (fail.listTasksPage) return failed(500);
      return ok({ tasks: page === 0 ? tasks : [], last_page: true });
    },
    async getTask(id, opts) {
      calls.push(['getTask', id, opts]);
      if (fail.getTask === id) return failed(404);
      const base = tasks.find((x) => x.id === id);
      return ok({ ...base, markdown_description: bodies[id] ?? '' });
    },
    async listComments(id) {
      calls.push(['listComments', id]);
      if (fail.listComments === id) return { paged: { complete: false, comments: [] }, bad: failed(503) };
      const list = (comments[id] || []).slice().sort((a, b) => Number(b.date) - Number(a.date));
      return { paged: { complete: true, comments: list }, bad: null };
    },
    async listReplies(id) {
      calls.push(['listReplies', id]);
      if (fail.listReplies === id) return failed(500);
      return ok({ comments: replies[id] || [] });
    },
  };
  for (const w of ['createTask', 'updateTask', 'setTag', 'postComment', 'replyToComment']) {
    t[w] = async (...a) => { writes.push([w, ...a]); return ok({}); };
  }
  return t;
}

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-import-'));
  const store = openStore(join(dir, 'tracker.db'));
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** One open ticket with a thread, one closed ticket, and one with a status nobody knows. */
function queue() {
  return {
    tasks: [
      // Listed newest first, as ClickUp may: the import files oldest first.
      task('cu-closed', { status: 'Live', created: '2026-02-01T00:00:00Z', name: 'Closed one',
        custom_fields: [{ name: 'Loop note', value: 'shipped (Feb 1)' }] }),
      task('cu-odd', { status: 'Doing', created: '2026-01-15T00:00:00Z', name: 'Odd one' }),
      task('cu-open', { status: 'In review', created: '2026-01-01T00:00:00Z', name: 'Open one',
        assignees: [{ id: Number(SERVICE) }] }),
    ],
    bodies: { 'cu-open': '## Goal\nOpen body', 'cu-closed': 'Closed body' },
    comments: {
      'cu-open': [
        comment('c1', { at: '2026-01-02T00:00:00Z', text: 'Please build this.', replies: 2 }),
        comment('c2', { at: '2026-01-03T00:00:00Z', text: `PR opened: https://example.test/pr/1\n\n${MACHINE_MARKER_LINE}` }),
        comment('c3', { at: '2026-01-04T00:00:00Z', user: OTHER, text: 'A teammate chimes in' }),
      ],
      'cu-closed': [comment('c9', { at: '2026-02-02T00:00:00Z', text: 'merge' })],
    },
    replies: {
      c1: [
        comment('r2', { at: '2026-01-02T02:00:00Z', text: 'Thanks.' }),
        comment('r1', { at: '2026-01-02T01:00:00Z', text: `On it.\n${MACHINE_MARKER_LINE}` }),
      ],
    },
  };
}

test('an open and a closed ticket are copied with their times, bodies, statuses and map rows; ClickUp is never written', async () => {
  const { store, cleanup } = freshStore();
  try {
    const tracker = fakeTracker(queue());
    const { counts } = await importLoopQueue({ tracker, store, config: CONFIG });
    const tickets = store.listTickets('widget');
    assert.deepEqual(tickets.map((t) => [t.id, t.name, t.status]), [
      ['WG-1', 'Open one', 'in review'],
      ['WG-2', 'Closed one', 'live'],
    ]);
    assert.equal(tickets[0].createdAt, '2026-01-01T00:00:00.000Z');
    assert.equal(tickets[0].description, '## Goal\nOpen body');
    assert.equal(tickets[0].assignee, null, 'the service account is never an assignee');
    assert.deepEqual(tickets[0].tags, ['tracker']);
    assert.equal(tickets[1].loopNote, 'shipped (Feb 1)');
    assert.equal(store.importedId({ source: SOURCE, kind: 'ticket', sourceId: 'cu-open' }), 'WG-1');
    assert.equal(store.importedId({ source: SOURCE, kind: 'ticket', sourceId: 'cu-closed' }), 'WG-2');
    assert.equal(store.getProject('widget').prefix, 'WG');
    assert.deepEqual(counts.tickets, { read: 3, written: 2, skipped: 0, refused: 1 });
    assert.deepEqual(tracker.writes, []);
    // Closed tickets were asked for, from the configured list.
    assert.deepEqual(tracker.calls[0], ['listTasksPage', '4242', 0, { includeClosed: true }]);
  } finally { cleanup(); }
});

test('comments and replies keep their order, original times, exact bodies and parent links', async () => {
  const { store, cleanup } = freshStore();
  try {
    await importLoopQueue({ tracker: fakeTracker(queue()), store, config: CONFIG });
    const list = store.listComments('WG-1');
    const c1 = store.importedId({ source: SOURCE, kind: 'comment', sourceId: 'c1' });
    assert.deepEqual(list.map((c) => [c.body.split('\n')[0], c.parent, c.createdAt]), [
      ['Please build this.', null, '2026-01-02T00:00:00.000Z'],
      ['On it.', c1, '2026-01-02T01:00:00.000Z'],
      ['Thanks.', c1, '2026-01-02T02:00:00.000Z'],
      ['PR opened: https://example.test/pr/1', null, '2026-01-03T00:00:00.000Z'],
      ['A teammate chimes in', null, '2026-01-04T00:00:00.000Z'],
    ]);
    // Stored exactly as ClickUp returned it, stamp and all.
    assert.equal(list[3].body, `PR opened: https://example.test/pr/1\n\n${MACHINE_MARKER_LINE}`);
  } finally { cleanup(); }
});

test('a stamped comment goes to the machine actor, an unstamped one from the operator to the operator', async () => {
  const { store, cleanup } = freshStore();
  try {
    await importLoopQueue({ tracker: fakeTracker(queue()), store, config: CONFIG });
    const who = (sourceId) => {
      const id = store.importedId({ source: SOURCE, kind: 'comment', sourceId });
      const c = store.listComments('WG-1').concat(store.listComments('WG-2')).find((x) => x.id === id);
      return store.getActor(c.author);
    };
    // c2 and r1 were posted under the operator's seat, but carry the stamp.
    assert.deepEqual([who('c2').kind, who('c2').name], ['machine', 'widget loop (imported from ClickUp)']);
    assert.equal(who('r1').kind, 'machine');
    assert.deepEqual([who('c1').kind, who('c1').name], ['human', 'Pat']);
    assert.equal(who('r2').name, 'Pat');
    assert.equal(who('c9').name, 'Pat');
    assert.equal(store.getProject('widget').operator, who('c1').id);
    // Someone else gets an actor of their own.
    assert.deepEqual([who('c3').kind, who('c3').name], ['human', 'user900']);
  } finally { cleanup(); }
});

test('an unknown status is refused and named, and that ticket costs no further reads', async () => {
  const { store, cleanup } = freshStore();
  try {
    const tracker = fakeTracker(queue());
    const result = await importLoopQueue({ tracker, store, config: CONFIG });
    assert.equal(result.refusals.length, 1);
    assert.match(result.refusals[0], /cu-odd "Odd one".*status "Doing" is not one of the seven/);
    assert.equal(store.importedId({ source: SOURCE, kind: 'ticket', sourceId: 'cu-odd' }), null);
    assert.ok(!tracker.calls.some((c) => c[1] === 'cu-odd'), 'no reads for a refused ticket');
    assert.match(formatReport(result), /Refused \(1\):\n {2}- ticket cu-odd "Odd one"/);
  } finally { cleanup(); }
});

test('a second run writes nothing new and skips everything; a new reply on an old comment is the only thing added', async () => {
  const { store, cleanup } = freshStore();
  try {
    const data = queue();
    const first = await importLoopQueue({ tracker: fakeTracker(data), store, config: CONFIG });
    assert.deepEqual(first.counts.comments, { read: 4, written: 4, skipped: 0, refused: 0 });
    assert.deepEqual(first.counts.replies, { read: 2, written: 2, skipped: 0, refused: 0 });

    const second = await importLoopQueue({ tracker: fakeTracker(data), store, config: CONFIG });
    for (const k of ['tickets', 'comments', 'replies']) assert.equal(second.counts[k].written, 0, k);
    assert.deepEqual(second.counts.tickets, { read: 3, written: 0, skipped: 2, refused: 1 });
    assert.deepEqual(second.counts.comments, { read: 4, written: 0, skipped: 4, refused: 0 });
    assert.deepEqual(second.counts.replies, { read: 2, written: 0, skipped: 2, refused: 0 });
    assert.equal(store.listTickets('widget').length, 2);
    assert.equal(store.listComments('WG-1').length, 5);

    data.replies.c1.push(comment('r3', { at: '2026-03-01T00:00:00Z', text: 'Late reply' }));
    const third = await importLoopQueue({ tracker: fakeTracker(data), store, config: CONFIG });
    assert.deepEqual(third.counts.replies, { read: 3, written: 1, skipped: 2, refused: 0 });
    assert.equal(store.listComments('WG-1').at(-1).body, 'Late reply');
  } finally { cleanup(); }
});

test('a failed read stops the run with ImportReadError, and leaves no half-copied ticket', async () => {
  for (const fail of [{ listTasksPage: true }, { getTask: 'cu-closed' }, { listComments: 'cu-closed' }, { listReplies: 'c1' }]) {
    const { store, cleanup } = freshStore();
    try {
      await assert.rejects(
        importLoopQueue({ tracker: fakeTracker({ ...queue(), fail }), store, config: CONFIG }),
        (err) => err instanceof ImportReadError && /failed: HTTP \d+/.test(err.message) && Boolean(err.counts),
        JSON.stringify(fail),
      );
      // Every ticket that IS in the store has all of its comments.
      for (const t of store.listTickets('widget')) {
        const expected = { 'WG-1': 5, 'WG-2': 1 }[t.id];
        assert.equal(store.listComments(t.id).length, expected, `${JSON.stringify(fail)}: ${t.id}`);
      }
      if (fail.listReplies) assert.equal(store.listTickets('widget').length, 0);
      if (fail.getTask || fail.listComments) assert.deepEqual(store.listTickets('widget').map((t) => t.id), ['WG-1']);
    } finally { cleanup(); }
  }
});

test('a missing trackerPrefix, or a store holding the project under another prefix, is refused before any read', async () => {
  const { store, cleanup } = freshStore();
  try {
    const tracker = fakeTracker(queue());
    await assert.rejects(importLoopQueue({ tracker, store, config: { ...CONFIG, trackerPrefix: null } }), /"trackerPrefix" is not set/);
    await importLoopQueue({ tracker, store, config: CONFIG });
    const before = tracker.calls.length;
    await assert.rejects(importLoopQueue({ tracker, store, config: { ...CONFIG, trackerPrefix: 'XX' } }), /prefix "WG", but the config says "XX"/);
    assert.equal(tracker.calls.length, before);
  } finally { cleanup(); }
});

/** Run tracker/signins.mjs's create against `store` with a fake Doppler; answers the vault. */
async function signIn(store, env = {}) {
  const vault = {};
  const r = await createSignins({
    store, seats: seatsFor(CONFIG.operatorName), env,
    project: { slug: CONFIG.productSlug, name: 'Widget', prefix: CONFIG.trackerPrefix },
    operatorImport: operatorImportKey(CONFIG),
    setSecret: (name, value) => { vault[name] = value; }, getSecret: (name) => vault[name],
    proveToken: async (token) => { const me = store.actorForToken(token); return { status: me ? 200 : 401, me }; },
    tracker: { url: 'http://tracker.test' },
  });
  assert.equal(r.ok, true, r.lines.join('\n'));
  return { vault, lines: r.lines };
}

/** The one human named as the operator, and every comment of his ClickUp seat on cu-closed. */
function oneOperator(store) {
  const humans = store.actorsNamed({ kind: 'human', name: CONFIG.operatorName });
  assert.equal(humans.length, 1, `humans named ${CONFIG.operatorName}: ${humans.map((a) => a.id)}`);
  assert.equal(store.getProject(CONFIG.productSlug).operator, humans[0].id);
  const closed = store.importedId({ source: SOURCE, kind: 'ticket', sourceId: 'cu-closed' });
  assert.deepEqual(store.listComments(closed).map((c) => c.author), [humans[0].id]);
  return humans[0];
}

test('sign-ins made first, then the import: one operator, the project\'s, and his history is filed under him', async () => {
  const { store, cleanup } = freshStore();
  try {
    const { vault } = await signIn(store);
    await importLoopQueue({ tracker: fakeTracker(queue()), store, config: CONFIG });
    const operator = oneOperator(store);
    assert.equal(store.actorForToken(vault.TRACKER_TOKEN_OPERATOR).id, operator.id);
  } finally { cleanup(); }
});

test('the import made first, then the sign-ins: the operator\'s seat is given to the imported operator, not a second one', async () => {
  const { store, cleanup } = freshStore();
  try {
    await importLoopQueue({ tracker: fakeTracker(queue()), store, config: CONFIG });
    const { vault } = await signIn(store);
    const operator = oneOperator(store);
    assert.equal(store.actorForToken(vault.TRACKER_TOKEN_OPERATOR).id, operator.id);
  } finally { cleanup(); }
});

test('a database whose sign-ins predate the mapping is refused by the import untouched, repaired by running create again, then imported under him', async () => {
  const { store, cleanup } = freshStore();
  try {
    // As the first create left the live database: operator and project, no map row.
    const op = store.createActor({ kind: 'human', name: CONFIG.operatorName });
    const env = { TRACKER_TOKEN_OPERATOR: store.issueToken(op.id) };
    store.createProject({ slug: CONFIG.productSlug, name: 'Widget', prefix: CONFIG.trackerPrefix, operator: op.id });
    const tracker = fakeTracker(queue());
    await assert.rejects(importLoopQueue({ tracker, store, config: CONFIG }),
      new RegExp(`names actor ${op.id} as its operator, but the operator's ClickUp seat maps to no actor yet`));
    assert.equal(tracker.calls.length, 0);
    assert.deepEqual(store.listImportedIds(SOURCE), []);

    const { lines } = await signIn(store, env);
    assert.match(lines.join('\n'), new RegExp(`TRACKER_TOKEN_OPERATOR: clickup user:${OPERATOR} now maps to actor ${op.id}`));
    await importLoopQueue({ tracker, store, config: CONFIG });
    assert.equal(oneOperator(store).id, op.id);
  } finally { cleanup(); }
});

test('the importer hard-codes no product: no ids, names, slugs or prefixes in its source', () => {
  const src = readFileSync(new URL('./import.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\b\d{6,}\b/, 'no ClickUp ids');
  assert.doesNotMatch(src, /spirality|starcaster|wavecenter|\bDane\b/i);
  assert.doesNotMatch(src, /\b(SP|SC|WC)-/);
});
