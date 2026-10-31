import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openStore, StoreError, STATUSES } from './store.mjs';

/** A fresh store on disk, with one operator, one machine and one project. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-store-'));
  const path = join(dir, 'tracker.db');
  let tick = 0;
  const store = openStore(path, { now: () => new Date(Date.UTC(2026, 9, 26, 12, 0, tick++)).toISOString() });
  const human = store.createActor({ kind: 'human', name: 'Operator' });
  const machine = store.createActor({ kind: 'machine', name: 'Loop' });
  store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL', operator: human.id });
  const cleanup = () => { store.close(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, path, store, human, machine, cleanup };
}

test('the store knows exactly the eight statuses from lib/loopStatuses.js', () => {
  assert.deepEqual([...STATUSES].sort(), [
    'building', 'in review', 'live', 'needs your input', 'queued', 'ready to launch', 'requested', 'rework',
  ]);
});

test('filing a ticket gives it the project prefix and next number, and it reads back', () => {
  const { store, machine, cleanup } = fixture();
  try {
    const a = store.fileTicket({ project: 'alpha', actor: machine.id, name: 'First', status: 'Queued', priority: 'High', tags: ['tracker'] });
    const b = store.fileTicket({ project: 'alpha', actor: machine.id, name: 'Second', status: 'queued' });
    assert.equal(a.id, 'AL-1');
    assert.equal(b.id, 'AL-2');
    const read = store.getTicket('AL-1');
    assert.equal(read.name, 'First');
    assert.equal(read.status, 'queued');
    assert.equal(read.priority, 'high');
    assert.deepEqual(read.tags, ['tracker']);
    assert.equal(read.version, 1);
    assert.equal(read.project, 'alpha');
    assert.equal(store.getTicket('AL-99'), null);
  } finally { cleanup(); }
});

test('two projects number their tickets independently, each with its own prefix', () => {
  const { store, machine, cleanup } = fixture();
  try {
    store.createProject({ slug: 'beta', name: 'Beta', prefix: 'BE' });
    store.fileTicket({ project: 'alpha', actor: machine.id, name: 'a', status: 'queued' });
    const b = store.fileTicket({ project: 'beta', actor: machine.id, name: 'b', status: 'queued' });
    assert.equal(b.id, 'BE-1');
    assert.throws(() => store.createProject({ slug: 'gamma', name: 'G', prefix: 'AL' }), { code: 'duplicate-project' });
    assert.throws(() => store.createProject({ slug: 'delta', name: 'D', prefix: 'sp-' }), { code: 'bad-prefix' });
  } finally { cleanup(); }
});

test('an unknown status is refused, on filing, on changing and on listing, and nothing is written', () => {
  const { store, machine, cleanup } = fixture();
  try {
    assert.throws(() => store.fileTicket({ project: 'alpha', actor: machine.id, name: 'x', status: 'done' }),
      (err) => err instanceof StoreError && err.code === 'unknown-status');
    assert.equal(store.listTickets('alpha').length, 0);
    const t = store.fileTicket({ project: 'alpha', actor: machine.id, name: 'x', status: 'queued' });
    assert.throws(() => store.changeTicket(t.id, { actor: machine.id, status: 'closed' }), { code: 'unknown-status' });
    assert.throws(() => store.changeTicket(t.id, { actor: machine.id, ifStatus: 'pending', status: 'building' }), { code: 'unknown-status' });
    assert.throws(() => store.listTickets('alpha', { status: 'complete' }), { code: 'unknown-status' });
    const after = store.getTicket(t.id);
    assert.equal(after.status, 'queued');
    assert.equal(after.version, 1);
    assert.equal(store.listEvents(t.id).length, 1);
  } finally { cleanup(); }
});

test('a guarded move succeeds when the ticket is where the caller said, and the version goes up by one', () => {
  const { store, machine, cleanup } = fixture();
  try {
    const t = store.fileTicket({ project: 'alpha', actor: machine.id, name: 'x', status: 'queued' });
    const r = store.changeTicket(t.id, { actor: machine.id, ifStatus: 'Queued', ifVersion: 1, status: 'Building' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.changed, ['status']);
    assert.equal(r.ticket.status, 'building');
    assert.equal(r.ticket.version, 2);
    assert.deepEqual(store.getTicket(t.id), r.ticket);
  } finally { cleanup(); }
});

test('a guarded move is refused when the status has moved, naming where it is now, with nothing written', () => {
  const { store, machine, cleanup } = fixture();
  try {
    const t = store.fileTicket({ project: 'alpha', actor: machine.id, name: 'x', status: 'queued' });
    store.changeTicket(t.id, { actor: machine.id, status: 'in review' });
    const before = store.getTicket(t.id);
    const eventsBefore = store.listEvents(t.id).length;

    const r = store.changeTicket(t.id, { actor: machine.id, ifStatus: 'queued', status: 'building', loopNote: 'claimed' });
    assert.deepEqual(r, { ok: false, refused: 'moved', ticket: t.id, status: 'in review', version: 2 });
    assert.deepEqual(store.getTicket(t.id), before);
    assert.equal(store.listEvents(t.id).length, eventsBefore);

    const v = store.changeTicket(t.id, { actor: machine.id, ifVersion: 1, priority: 'low' });
    assert.equal(v.ok, false);
    assert.equal(v.refused, 'moved');
    assert.deepEqual(store.getTicket(t.id), before);
  } finally { cleanup(); }
});

test('two claims of one Queued ticket from two connections: exactly one wins', () => {
  const { path, store, machine, cleanup } = fixture();
  const other = openStore(path);
  try {
    const t = store.fileTicket({ project: 'alpha', actor: machine.id, name: 'x', status: 'queued' });
    const first = store.changeTicket(t.id, { actor: machine.id, ifStatus: 'queued', status: 'building' });
    const second = other.changeTicket(t.id, { actor: machine.id, ifStatus: 'queued', status: 'building' });
    assert.equal([first, second].filter((r) => r.ok).length, 1);
    assert.equal(second.refused, 'moved');
    assert.equal(store.listEvents(t.id).filter((e) => e.field === 'status').length, 1);
  } finally { other.close(); cleanup(); }
});

test('eight claims of one Queued ticket racing in eight threads: exactly one wins', async () => {
  const { path, store, machine, cleanup } = fixture();
  try {
    const t = store.fileTicket({ project: 'alpha', actor: machine.id, name: 'x', status: 'queued' });
    const storeUrl = new URL('./store.mjs', import.meta.url).href;
    const source = `
      import { workerData, parentPort } from 'node:worker_threads';
      const { openStore } = await import(workerData.storeUrl);
      const s = openStore(workerData.path);
      Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      const r = s.changeTicket(workerData.id, { actor: workerData.actor, ifStatus: 'queued', status: 'building', loopNote: 'claimed by ' + workerData.n });
      s.close();
      parentPort.postMessage(r.ok);
    `;
    const gate = new SharedArrayBuffer(4);
    const results = Array.from({ length: 8 }, (_, n) => new Promise((resolve, reject) => {
      const w = new Worker(source, { eval: true, type: 'module', workerData: { storeUrl, path, id: t.id, actor: machine.id, n, gate } });
      w.once('message', resolve);
      w.once('error', reject);
    }));
    // Give every thread time to open its connection, then release them at once.
    await new Promise((r) => setTimeout(r, 300));
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    const wins = (await Promise.all(results)).filter(Boolean).length;
    assert.equal(wins, 1);
    const after = store.getTicket(t.id);
    assert.equal(after.status, 'building');
    assert.equal(after.version, 2);
    assert.equal(store.listEvents(t.id).filter((e) => e.field === 'status').length, 1);
  } finally { cleanup(); }
});

test('every change leaves one event per changed field, with actor, from, to and time', () => {
  const { store, human, machine, cleanup } = fixture();
  try {
    const t = store.fileTicket({ project: 'alpha', actor: machine.id, name: 'x', status: 'queued' });
    assert.deepEqual(store.listEvents(t.id).map((e) => [e.field, e.from, e.to]), [['created', null, 'queued']]);

    store.changeTicket(t.id, { actor: machine.id, status: 'building' });
    store.changeTicket(t.id, { actor: human.id, priority: 'urgent' });
    store.changeTicket(t.id, { actor: machine.id, assignee: human.id, status: 'needs your input' });
    // Same value again is not a change: no event, no version bump.
    const same = store.changeTicket(t.id, { actor: machine.id, status: 'needs your input' });
    assert.deepEqual(same.changed, []);

    const events = store.listEvents(t.id);
    assert.deepEqual(events.map((e) => [e.actor, e.field, e.from, e.to]), [
      [machine.id, 'created', null, 'queued'],
      [machine.id, 'status', 'queued', 'building'],
      [human.id, 'priority', null, 'urgent'],
      [machine.id, 'assignee', null, String(human.id)],
      [machine.id, 'status', 'building', 'needs your input'],
    ]);
    assert.ok(events.every((e) => /^\d{4}-\d\d-\d\dT/.test(e.at)));
    assert.equal(store.getTicket(t.id).version, 4);
  } finally { cleanup(); }
});

test('comments come back oldest first, replies linked to their parent, and a parent from another ticket is refused', () => {
  const { store, human, machine, cleanup } = fixture();
  try {
    const t = store.fileTicket({ project: 'alpha', actor: machine.id, name: 'x', status: 'queued' });
    const u = store.fileTicket({ project: 'alpha', actor: machine.id, name: 'y', status: 'queued' });
    const a = store.postComment({ ticket: t.id, author: machine.id, body: 'first' });
    const b = store.postComment({ ticket: t.id, author: human.id, body: 'second' });
    const reply = store.postComment({ ticket: t.id, author: machine.id, body: 'reply to first', parent: a.id });
    const list = store.listComments(t.id);
    assert.deepEqual(list.map((c) => c.body), ['first', 'second', 'reply to first']);
    assert.deepEqual(list.map((c) => c.parent), [null, null, a.id]);
    assert.equal(list[1].author, human.id);
    assert.equal(reply.ticket, t.id);
    assert.ok(list[0].createdAt < list[1].createdAt);
    assert.throws(() => store.postComment({ ticket: u.id, author: machine.id, body: 'x', parent: b.id }), { code: 'bad-parent' });
    assert.equal(store.listComments(u.id).length, 0);
  } finally { cleanup(); }
});

test('comments are append-only: the store has no way to edit or delete one', () => {
  const { store, cleanup } = fixture();
  try {
    const names = Object.keys(store);
    assert.ok(names.includes('postComment'));
    // importComment only appends too (with an original time); nothing edits or deletes.
    assert.deepEqual(names.filter((n) => /comment/i.test(n)).sort(), ['importComment', 'listComments', 'postComment']);
  } finally { cleanup(); }
});

test('an imported ticket keeps its original times and maps its old id; a second import of it writes nothing', () => {
  const { store, machine, cleanup } = fixture();
  try {
    const t = store.importTicket({
      source: 'clickup', sourceId: 'abc1', createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-02-01T00:00:00.000Z',
      project: 'alpha', actor: machine.id, name: 'Old', status: 'Live', priority: 'normal', loopNote: 'shipped',
    });
    assert.equal(t.id, 'AL-1');
    assert.equal(t.createdAt, '2026-01-02T03:04:05.000Z');
    assert.equal(t.updatedAt, '2026-02-01T00:00:00.000Z');
    assert.equal(t.loopNote, 'shipped');
    assert.equal(store.listEvents('AL-1')[0].at, '2026-01-02T03:04:05.000Z');
    assert.equal(store.importedId({ source: 'clickup', kind: 'ticket', sourceId: 'abc1' }), 'AL-1');
    assert.equal(store.importedId({ source: 'clickup', kind: 'ticket', sourceId: 'nope' }), null);
    assert.throws(() => store.importTicket({
      source: 'clickup', sourceId: 'abc1', createdAt: '2026-01-02T03:04:05.000Z',
      project: 'alpha', actor: machine.id, name: 'Old again', status: 'live',
    }), { code: 'already-imported' });
    assert.equal(store.listTickets('alpha').length, 1);
    // The refused attempt did not use up a number.
    assert.equal(store.fileTicket({ project: 'alpha', actor: machine.id, name: 'Next', status: 'queued' }).id, 'AL-2');
    assert.throws(() => store.importTicket({
      source: 'clickup', sourceId: 'abc2', createdAt: 'not a date', project: 'alpha', actor: machine.id, name: 'x', status: 'queued',
    }), { code: 'bad-time' });
    assert.throws(() => store.importTicket({
      source: 'clickup', sourceId: 'abc3', createdAt: '2026-01-02T00:00:00Z', project: 'alpha', actor: machine.id, name: 'x', status: 'Doing',
    }), { code: 'unknown-status' });
    assert.equal(store.importedId({ source: 'clickup', kind: 'ticket', sourceId: 'abc3' }), null);
  } finally { cleanup(); }
});

test('imported comments and replies keep their times, bodies and parents, and map their old ids', () => {
  const { store, human, machine, cleanup } = fixture();
  try {
    const t = store.importTicket({ source: 'clickup', sourceId: 't1', createdAt: '2026-01-01T00:00:00Z', project: 'alpha', actor: machine.id, name: 'T', status: 'queued' });
    const c = store.importComment({ source: 'clickup', sourceId: 'c1', createdAt: '2026-01-01T01:00:00Z', ticket: t.id, author: human.id, body: 'hi  \n' });
    const r = store.importComment({ source: 'clickup', sourceId: 'r1', createdAt: '2026-01-01T02:00:00Z', ticket: t.id, author: machine.id, body: 'reply', parent: c.id });
    assert.deepEqual(store.listComments(t.id).map((x) => [x.body, x.parent, x.createdAt]), [
      ['hi  \n', null, '2026-01-01T01:00:00.000Z'],
      ['reply', c.id, '2026-01-01T02:00:00.000Z'],
    ]);
    assert.equal(store.importedId({ source: 'clickup', kind: 'comment', sourceId: 'r1' }), r.id);
    assert.throws(() => store.importComment({ source: 'clickup', sourceId: 'c1', createdAt: '2026-01-01T01:00:00Z', ticket: t.id, author: human.id, body: 'again' }), { code: 'already-imported' });
    assert.equal(store.listComments(t.id).length, 2);
    assert.deepEqual(store.listImportedIds('clickup').map((m) => [m.kind, m.sourceId, m.newId]), [
      ['ticket', 't1', t.id], ['comment', 'c1', String(c.id)], ['comment', 'r1', String(r.id)],
    ]);
  } finally { cleanup(); }
});

test('an imported actor is created once and found again by its old id', () => {
  const { store, cleanup } = fixture();
  try {
    const a = store.importActor({ source: 'clickup', sourceId: 'user:9', kind: 'human', name: 'Someone' });
    const b = store.importActor({ source: 'clickup', sourceId: 'user:9', kind: 'human', name: 'Someone' });
    assert.deepEqual(a, b);
    assert.equal(store.importedId({ source: 'clickup', kind: 'actor', sourceId: 'user:9' }), a.id);
    assert.throws(() => store.importedId({ source: 'clickup', kind: 'project', sourceId: 'x' }), { code: 'bad-import' });
  } finally { cleanup(); }
});

test('imported actors have no sign-in token, and several can sit beside a signed-in one', () => {
  const { store, machine, cleanup } = fixture();
  try {
    const token = store.issueToken(machine.id);
    const a = store.importActor({ source: 'clickup', sourceId: 'user:1', kind: 'human', name: 'One' });
    const b = store.importActor({ source: 'clickup', sourceId: 'user:2', kind: 'machine', name: 'Two' });
    assert.notEqual(a.id, b.id);
    assert.equal(store.actorForToken(token).id, machine.id);
    assert.equal(store.actorForToken(''), null);
    assert.equal(store.actorForToken('not-a-token'), null);
  } finally { cleanup(); }
});

test('copying a ticket files a new one in the other project, in Requested, and leaves the original exactly as it was', () => {
  const { store, human, machine, cleanup } = fixture();
  try {
    store.createProject({ slug: 'beta', name: 'Beta', prefix: 'BE' });
    const t = store.fileTicket({
      project: 'alpha', actor: machine.id, name: 'Copy me', description: '## Goal\nKeep **this**.\n',
      status: 'building', priority: 'high', tags: ['tracker'], assignee: human.id, loopNote: 'note',
    });
    store.postComment({ ticket: t.id, author: machine.id, body: 'a comment that stays here' });
    const before = { ticket: store.getTicket(t.id), comments: store.listComments(t.id), events: store.listEvents(t.id) };

    const copy = store.cloneTicket(t.id, { project: 'beta', actor: human.id });
    assert.equal(copy.id, 'BE-1');
    assert.deepEqual(
      [copy.project, copy.name, copy.description, copy.status, copy.priority, copy.tags, copy.assignee, copy.loopNote, copy.version],
      ['beta', 'Copy me', '## Goal\nKeep **this**.\n', 'requested', 'high', ['tracker'], null, '', 1],
    );
    assert.deepEqual(store.getTicket('BE-1'), copy, 'the copy reads back');
    assert.deepEqual(store.listComments('BE-1').map((c) => [c.author, c.body]), [[human.id, 'Copied from AL-1 in Alpha.']]);
    assert.deepEqual(store.listEvents('BE-1').map((e) => [e.field, e.to, e.actor]), [['created', 'requested', human.id]]);

    assert.deepEqual(store.getTicket(t.id), before.ticket, 'no field or version of the original changed');
    assert.deepEqual(store.listComments(t.id), before.comments);
    assert.deepEqual(store.listEvents(t.id), before.events);
  } finally { cleanup(); }
});

test('copying into the ticket\'s own project, an unknown project or from an unknown ticket is refused, and nothing is written', () => {
  const { store, human, machine, cleanup } = fixture();
  try {
    store.fileTicket({ project: 'alpha', actor: machine.id, name: 'Stay', status: 'queued' });
    assert.throws(() => store.cloneTicket('AL-1', { project: 'alpha', actor: human.id }), { code: 'same-project' });
    assert.throws(() => store.cloneTicket('AL-1', { project: 'gamma', actor: human.id }), { code: 'unknown-project' });
    assert.throws(() => store.cloneTicket('AL-9', { project: 'alpha', actor: human.id }), { code: 'unknown-ticket' });
    store.createProject({ slug: 'beta', name: 'Beta', prefix: 'BE' });
    assert.throws(() => store.cloneTicket('AL-1', { project: 'beta', actor: 999 }), { code: 'unknown-actor' });
    assert.deepEqual(store.listTickets('alpha').map((t) => t.id), ['AL-1']);
    assert.deepEqual(store.listTickets('beta'), []);
    const next = store.fileTicket({ project: 'beta', actor: machine.id, name: 'b', status: 'queued' });
    assert.equal(next.id, 'BE-1', 'a refused copy used up no number');
  } finally { cleanup(); }
});

test('listing filters by status, and "open only" drops Live tickets', () => {
  const { store, machine, cleanup } = fixture();
  try {
    store.fileTicket({ project: 'alpha', actor: machine.id, name: 'a', status: 'queued' });
    store.fileTicket({ project: 'alpha', actor: machine.id, name: 'b', status: 'in review' });
    store.fileTicket({ project: 'alpha', actor: machine.id, name: 'c', status: 'live' });
    assert.deepEqual(store.listTickets('alpha').map((t) => t.name), ['a', 'b', 'c']);
    assert.deepEqual(store.listTickets('alpha', { open: true }).map((t) => t.name), ['a', 'b']);
    assert.deepEqual(store.listTickets('alpha', { status: 'In review' }).map((t) => t.name), ['b']);
    assert.deepEqual(store.listTickets('alpha', { status: 'live', open: true }), []);
  } finally { cleanup(); }
});

test('a failed write throws and leaves nothing behind', () => {
  const { store, machine, cleanup } = fixture();
  try {
    assert.throws(() => store.fileTicket({ project: 'nope', actor: machine.id, name: 'x', status: 'queued' }), { code: 'unknown-project' });
    assert.throws(() => store.fileTicket({ project: 'alpha', actor: 999, name: 'x', status: 'queued' }), { code: 'unknown-actor' });
    assert.throws(() => store.changeTicket('AL-404', { actor: machine.id, status: 'building' }), { code: 'unknown-ticket' });
    const t = store.fileTicket({ project: 'alpha', actor: machine.id, name: 'x', status: 'queued' });
    assert.equal(t.id, 'AL-1', 'a refused filing must not use up a number');
    assert.throws(() => store.changeTicket(t.id, { actor: machine.id, status: 'building', assignee: 999 }), { code: 'unknown-actor' });
    assert.throws(() => store.changeTicket(t.id, { actor: machine.id, version: 7 }), { code: 'bad-field' });
    assert.throws(() => store.postComment({ ticket: t.id, author: machine.id, body: '  ' }), { code: 'missing' });
    assert.equal(store.getTicket(t.id).version, 1);
    assert.equal(store.getTicket(t.id).status, 'queued');
    assert.equal(store.listEvents(t.id).length, 1);
  } finally { cleanup(); }
});

test('the store hard-codes no product: no names, ids or ticket prefixes in its source', () => {
  const source = readFileSync(new URL('./store.mjs', import.meta.url), 'utf8');
  for (const word of [/starcaster/i, /wavecenter/i, /spirality/i, /\bSP-/, /\bSC-/, /\bWC-/, /\b9014\d{8}\b/, /86b[a-z0-9]{6}/]) {
    assert.doesNotMatch(source, word);
  }
});

test('a token is issued once, finds its actor, and only its hash is stored', () => {
  const { dir, path, store, machine, human } = fixture();
  try {
    const token = store.issueToken(machine.id);
    assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
    assert.deepEqual(store.actorForToken(token), machine);
    assert.equal(store.actorForToken('not-a-token'), null);
    assert.equal(store.actorForToken(''), null);
    assert.equal(store.actorForToken(undefined), null);
    assert.equal(store.actorForToken(store.issueToken(human.id))?.id, human.id);

    // A new token replaces the old one.
    const second = store.issueToken(machine.id);
    assert.equal(store.actorForToken(token), null);
    assert.equal(store.actorForToken(second)?.id, machine.id);

    // The database file holds the hash, never the token.
    store.close();
    const raw = readFileSync(path).toString('latin1') + (() => {
      try { return readFileSync(`${path}-wal`).toString('latin1'); } catch { return ''; }
    })();
    assert.ok(!raw.includes(second));
    assert.ok(raw.includes(createHash('sha256').update(second).digest('hex')));
    const again = openStore(path);
    try {
      assert.equal(again.actorForToken(second)?.id, machine.id);
      assert.throws(() => again.issueToken(999), { code: 'unknown-actor' });
    } finally { again.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a revoked token signs in as nobody, and the actor can be given a new one', () => {
  const { dir, store, machine, human } = fixture();
  try {
    const token = store.issueToken(machine.id);
    const other = store.issueToken(human.id);
    store.revokeToken(machine.id);
    assert.equal(store.actorForToken(token), null);
    assert.equal(store.actorForToken(other)?.id, human.id);
    assert.throws(() => store.revokeToken(999), { code: 'unknown-actor' });
    assert.equal(store.actorForToken(store.issueToken(machine.id))?.id, machine.id);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a database made before actors had tokens gains the column, and its rows survive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-store-'));
  const path = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE actors (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK (kind IN ('human', 'machine')), name TEXT NOT NULL)");
    old.exec("INSERT INTO actors (kind, name) VALUES ('machine', 'Old loop')");
    old.close();
    const store = openStore(path);
    try {
      const token = store.issueToken(1);
      assert.deepEqual(store.actorForToken(token), { id: 1, kind: 'machine', name: 'Old loop' });
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stage colours: set, read back, cleared, kept across a reopen; a bad colour or status writes nothing', () => {
  const { path, store, cleanup } = fixture();
  try {
    assert.deepEqual(store.stageColours(), {});
    assert.deepEqual(store.setStageColours({ Queued: '#2B9CF2', 'In review': '#cc0000' }), { 'in review': '#cc0000', queued: '#2b9cf2' });
    assert.deepEqual(store.setStageColours({ queued: null, Live: '#00aa00' }), { 'in review': '#cc0000', live: '#00aa00' });
    const again = openStore(path);
    try { assert.deepEqual(again.stageColours(), { 'in review': '#cc0000', live: '#00aa00' }); } finally { again.close(); }
    const before = store.stageColours();
    for (const colours of [{ Queued: 'blue' }, { Queued: '#abc' }, { Queued: '#2b9cf2', Live: '#zzzzzz' }, { Nope: '#2b9cf2' }, null, ['#2b9cf2']]) {
      assert.throws(() => store.setStageColours(colours), StoreError, JSON.stringify(colours));
    }
    assert.deepEqual(store.stageColours(), before, 'a refused set writes nothing, not even its good values');
  } finally { cleanup(); }
});
