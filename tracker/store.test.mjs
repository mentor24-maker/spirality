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

test('a Requested or Queued ticket is deleted with its comments and events; nothing of it reads back', () => {
  const { store, human, machine, cleanup } = fixture();
  try {
    for (const status of ['requested', 'queued']) {
      const keep = store.fileTicket({ project: 'alpha', actor: machine.id, name: 'kept', status });
      store.postComment({ ticket: keep.id, author: human.id, body: 'stays' });
      const t = store.fileTicket({ project: 'alpha', actor: machine.id, name: `gone ${status}`, status });
      const a = store.postComment({ ticket: t.id, author: human.id, body: 'first' });
      store.postComment({ ticket: t.id, author: machine.id, body: 'reply', parent: a.id });
      store.changeTicket(t.id, { actor: human.id, priority: 'high' });

      assert.deepEqual(store.deleteTicket(t.id, { actor: human.id }), { id: t.id, status });
      assert.equal(store.getTicket(t.id), null);
      assert.deepEqual(store.listComments(t.id), []);
      assert.deepEqual(store.listEvents(t.id), []);
      // Its neighbour is untouched.
      assert.equal(store.getTicket(keep.id).name, 'kept');
      assert.equal(store.listComments(keep.id).length, 1);
      assert.equal(store.listEvents(keep.id).length, 1);
    }
  } finally { cleanup(); }
});

test('a started ticket, in any of the other six statuses, is refused with not-deletable naming its status, and all of it stays', () => {
  const { store, human, machine, cleanup } = fixture();
  try {
    for (const status of STATUSES.filter((s) => !['requested', 'queued'].includes(s))) {
      const t = store.fileTicket({ project: 'alpha', actor: machine.id, name: status, status });
      store.postComment({ ticket: t.id, author: human.id, body: 'note' });
      assert.throws(() => store.deleteTicket(t.id, { actor: human.id }),
        (err) => err instanceof StoreError && err.code === 'not-deletable' && err.status === status
          && err.message.includes(`"${status}"`), status);
      assert.equal(store.getTicket(t.id).status, status);
      assert.equal(store.listComments(t.id).length, 1);
      assert.equal(store.listEvents(t.id).length, 1);
    }
    assert.throws(() => store.deleteTicket('AL-99', { actor: human.id }), { code: 'unknown-ticket' });
    const q = store.fileTicket({ project: 'alpha', actor: machine.id, name: 'q', status: 'queued' });
    assert.throws(() => store.deleteTicket(q.id, { actor: 999 }), { code: 'unknown-actor' });
    assert.equal(store.getTicket(q.id).status, 'queued');
  } finally { cleanup(); }
});

test('the check and the delete are one transaction: a ticket claimed after the caller read it Queued is refused', () => {
  const { path, store, human, machine, cleanup } = fixture();
  const loop = openStore(path);
  try {
    const t = store.fileTicket({ project: 'alpha', actor: machine.id, name: 'x', status: 'queued' });
    assert.equal(store.getTicket(t.id).status, 'queued'); // the caller's read
    assert.ok(loop.changeTicket(t.id, { actor: machine.id, ifStatus: 'queued', status: 'building' }).ok);
    assert.throws(() => store.deleteTicket(t.id, { actor: human.id }), { code: 'not-deletable', status: 'building' });
    assert.equal(store.getTicket(t.id).status, 'building');
    // And the other way round: a delete that wins leaves the claim nothing to find.
    const u = store.fileTicket({ project: 'alpha', actor: machine.id, name: 'y', status: 'queued' });
    store.deleteTicket(u.id, { actor: human.id });
    assert.throws(() => loop.changeTicket(u.id, { actor: machine.id, ifStatus: 'queued', status: 'building' }), { code: 'unknown-ticket' });
  } finally { loop.close(); cleanup(); }
});

test('a delete and a claim racing in two threads: exactly one wins, never half of each', async () => {
  const { path, store, human, machine, cleanup } = fixture();
  try {
    const storeUrl = new URL('./store.mjs', import.meta.url).href;
    const source = `
      import { workerData, parentPort } from 'node:worker_threads';
      const { openStore } = await import(workerData.storeUrl);
      const s = openStore(workerData.path);
      Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      let ok;
      try {
        ok = workerData.op === 'delete'
          ? Boolean(s.deleteTicket(workerData.id, { actor: workerData.actor }))
          : s.changeTicket(workerData.id, { actor: workerData.actor, ifStatus: 'queued', status: 'building' }).ok;
      } catch (err) {
        ok = false;
        if (!['not-deletable', 'unknown-ticket'].includes(err.code)) throw err;
      }
      s.close();
      parentPort.postMessage(ok);
    `;
    for (let round = 0; round < 4; round++) {
      const t = store.fileTicket({ project: 'alpha', actor: machine.id, name: `race ${round}`, status: 'queued' });
      const gate = new SharedArrayBuffer(4);
      const ops = [['delete', human.id], ['claim', machine.id]];
      const results = ops.map(([op, actor]) => new Promise((resolve, reject) => {
        const w = new Worker(source, { eval: true, type: 'module', workerData: { storeUrl, path, id: t.id, actor, op, gate } });
        w.once('message', resolve);
        w.once('error', reject);
      }));
      await new Promise((r) => setTimeout(r, 200));
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0);
      const [deleted, claimed] = await Promise.all(results);
      assert.equal(Number(deleted) + Number(claimed), 1, `round ${round}`);
      const after = store.getTicket(t.id);
      if (deleted) {
        assert.equal(after, null);
        assert.deepEqual(store.listEvents(t.id), []);
      } else {
        assert.equal(after.status, 'building');
        assert.equal(store.listEvents(t.id).length, 2);
      }
    }
  } finally { cleanup(); }
});

test('deleting an imported ticket keeps its map rows, so the import cannot file it again', () => {
  const { store, human, cleanup } = fixture();
  try {
    const t = store.importTicket({
      source: 'old', sourceId: 'x1', createdAt: '2026-01-01T00:00:00Z',
      project: 'alpha', actor: human.id, name: 'imported', status: 'queued',
    });
    store.importComment({ source: 'old', sourceId: 'c1', createdAt: '2026-01-02T00:00:00Z', ticket: t.id, author: human.id, body: 'hi' });
    store.deleteTicket(t.id, { actor: human.id });
    assert.equal(store.importedId({ source: 'old', kind: 'ticket', sourceId: 'x1' }), t.id);
    assert.equal(typeof store.importedId({ source: 'old', kind: 'comment', sourceId: 'c1' }), 'number');
    assert.throws(() => store.importTicket({
      source: 'old', sourceId: 'x1', createdAt: '2026-01-01T00:00:00Z',
      project: 'alpha', actor: human.id, name: 'imported', status: 'queued',
    }), { code: 'already-imported' });
    assert.equal(store.listTickets('alpha').length, 0);
  } finally { cleanup(); }
});

test('a project keeps its web address, logo and owner, and reads them back; none given is null', () => {
  const { store, human, cleanup } = fixture();
  try {
    assert.deepEqual(store.getProject('alpha'), { slug: 'alpha', name: 'Alpha', prefix: 'AL', operator: human.id, url: null, logo: null, owner: null });
    const made = store.createProject({
      slug: 'beta', name: 'Beta', prefix: 'BE',
      url: 'https://beta.example', logo: 'https://beta.example/logo.png', owner: human.id,
    });
    assert.deepEqual(made, {
      slug: 'beta', name: 'Beta', prefix: 'BE', operator: null,
      url: 'https://beta.example', logo: 'https://beta.example/logo.png', owner: human.id,
    });
    assert.deepEqual(store.getProject('beta'), made);
    assert.deepEqual(store.listProjects().map((p) => p.slug), ['alpha', 'beta']);
    assert.equal(store.createProject({ slug: 'gamma', name: 'G', prefix: 'GA', url: '', logo: '' }).url, null, 'an empty address is none');
  } finally { cleanup(); }
});

test('a project\'s owner must be a person, and its addresses must be http(s); a refusal writes nothing', () => {
  const { store, machine, cleanup } = fixture();
  try {
    for (const [fields, code] of [
      [{ owner: machine.id }, 'bad-owner'],
      [{ owner: 999 }, 'unknown-actor'],
      [{ url: 'javascript:alert(1)' }, 'bad-address'],
      [{ logo: 'data:image/png;base64,AAAA' }, 'bad-address'],
      [{ url: 'not an address' }, 'bad-address'],
      [{ slug: 'alpha' }, 'duplicate-project'],
      [{ prefix: 'AL' }, 'duplicate-project'],
      [{ name: '' }, 'missing'],
    ]) {
      assert.throws(() => store.createProject({ slug: 'beta', name: 'Beta', prefix: 'BE', ...fields }), { code }, JSON.stringify(fields));
    }
    assert.deepEqual(store.listProjects().map((p) => p.slug), ['alpha']);
  } finally { cleanup(); }
});

test('updateProject changes only the name, web address, logo and owner it is given, and reads them back', () => {
  const { store, human, cleanup } = fixture();
  try {
    const changed = store.updateProject('alpha', { name: 'Alpha Two', url: 'https://alpha.example', owner: human.id });
    assert.deepEqual(changed, {
      slug: 'alpha', name: 'Alpha Two', prefix: 'AL', operator: human.id,
      url: 'https://alpha.example', logo: null, owner: human.id,
    });
    assert.deepEqual(store.getProject('alpha'), changed);
    // Only what is given changes; an empty address and a null owner are none.
    assert.deepEqual(store.updateProject('alpha', { logo: 'https://alpha.example/l.png' }).url, 'https://alpha.example');
    const cleared = store.updateProject('alpha', { url: '', logo: '', owner: null });
    assert.deepEqual([cleared.name, cleared.url, cleared.logo, cleared.owner], ['Alpha Two', null, null, null]);
    // Tickets keep their ids and their project.
    const t = store.fileTicket({ project: 'alpha', actor: human.id, name: 'x', status: 'queued' });
    store.updateProject('alpha', { name: 'Alpha Three' });
    assert.deepEqual([store.getTicket(t.id).id, store.getTicket(t.id).project], ['AL-1', 'alpha']);
  } finally { cleanup(); }
});

test('updateProject refuses a new slug, prefix or operator, a machine owner, a bad address or an empty name, and writes nothing', () => {
  const { store, machine, cleanup } = fixture();
  try {
    const before = store.getProject('alpha');
    for (const [changes, code] of [
      [{ slug: 'beta' }, 'not-changeable'],
      [{ prefix: 'BE' }, 'not-changeable'],
      [{ operator: machine.id }, 'not-changeable'],
      [{ name: 'Fine', prefix: 'BE' }, 'not-changeable'],
      [{ owner: machine.id }, 'bad-owner'],
      [{ owner: 999 }, 'unknown-actor'],
      [{ url: 'javascript:alert(1)' }, 'bad-address'],
      [{ logo: 'not an address' }, 'bad-address'],
      [{ name: '' }, 'missing'],
      [{ name: '   ' }, 'missing'],
    ]) {
      assert.throws(() => store.updateProject('alpha', changes), { code }, JSON.stringify(changes));
      assert.deepEqual(store.getProject('alpha'), before, JSON.stringify(changes));
    }
    assert.throws(() => store.updateProject('nope', { name: 'x' }), { code: 'unknown-project' });
  } finally { cleanup(); }
});

test('deleteProject removes a project with no tickets, and refuses one with tickets, naming how many, removing nothing', () => {
  const { store, human, cleanup } = fixture();
  try {
    store.createProject({ slug: 'beta', name: 'Beta', prefix: 'BE' });
    assert.deepEqual(store.deleteProject('beta'), { slug: 'beta', prefix: 'BE' });
    assert.equal(store.getProject('beta'), null);
    assert.deepEqual(store.listProjects().map((p) => p.slug), ['alpha']);
    assert.throws(() => store.deleteProject('beta'), { code: 'unknown-project' });

    // One ticket, then two: refused both times, the project and its tickets untouched. Live ones count too.
    store.fileTicket({ project: 'alpha', actor: human.id, name: 'x', status: 'queued' });
    assert.throws(() => store.deleteProject('alpha'), { code: 'has-tickets', message: 'AL has 1 ticket; a project with tickets cannot be deleted.', tickets: 1 });
    store.fileTicket({ project: 'alpha', actor: human.id, name: 'y', status: 'live' });
    assert.throws(() => store.deleteProject('alpha'), { code: 'has-tickets', message: 'AL has 2 tickets; a project with tickets cannot be deleted.', tickets: 2 });
    assert.equal(store.getProject('alpha').name, 'Alpha');
    assert.equal(store.listTickets('alpha').length, 2);

    // A deleted project's slug and prefix are free again.
    store.createProject({ slug: 'beta', name: 'Beta again', prefix: 'BE' });
    assert.equal(store.getProject('beta').name, 'Beta again');
  } finally { cleanup(); }
});

test('the people are the human actors only, by id and name, never a token', () => {
  const { store, human, machine, cleanup } = fixture();
  try {
    store.issueToken(human.id);
    const second = store.createActor({ kind: 'human', name: 'Second' });
    assert.deepEqual(store.listPeople(), [{ id: human.id, name: 'Operator' }, { id: second.id, name: 'Second' }]);
    assert.ok(!store.listPeople().some((p) => p.id === machine.id));
  } finally { cleanup(); }
});

test('a database made before projects had a web address, logo and owner gains the columns, and every project and ticket is unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-store-'));
  const path = join(dir, 'old.db');
  try {
    // The shape the live tracker was made with, before this change.
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE actors (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK (kind IN ('human', 'machine')), name TEXT NOT NULL, token_hash TEXT);
      CREATE TABLE projects (slug TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL UNIQUE, operator INTEGER REFERENCES actors(id), next_number INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE tickets (id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(slug), number INTEGER NOT NULL, name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, priority TEXT, tags TEXT NOT NULL DEFAULT '[]', assignee INTEGER REFERENCES actors(id),
        loop_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, UNIQUE (project, number));
      INSERT INTO actors (kind, name) VALUES ('human', 'Old operator');
      INSERT INTO projects (slug, name, prefix, operator, next_number) VALUES ('old', 'Old', 'OL', 1, 3);
      INSERT INTO tickets (id, project, number, name, description, status, priority, tags, assignee, loop_note, created_at, updated_at, version)
        VALUES ('OL-1', 'old', 1, 'First', 'the spec', 'queued', 'high', '["x"]', 1, 'note', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z', 4),
               ('OL-2', 'old', 2, 'Second', '', 'live', NULL, '[]', NULL, '', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z', 1);
    `);
    const ticketsBefore = old.prepare('SELECT * FROM tickets ORDER BY id').all();
    old.close();

    const store = openStore(path);
    try {
      assert.deepEqual(store.getProject('old'), { slug: 'old', name: 'Old', prefix: 'OL', operator: 1, url: null, logo: null, owner: null });
      assert.deepEqual(store.listTickets('old').map((t) => [t.id, t.name, t.status, t.version]), [['OL-1', 'First', 'queued', 4], ['OL-2', 'Second', 'live', 1]]);
      // The next ticket still takes the old project's next number.
      assert.equal(store.fileTicket({ project: 'old', actor: 1, name: 'Third', status: 'queued' }).id, 'OL-3');
      assert.equal(store.createProject({ slug: 'new-one', name: 'New', prefix: 'NW', owner: 1, url: 'https://n.example' }).owner, 1);
    } finally { store.close(); }

    // Opened a second time, nothing is added twice, and the old rows are byte-for-byte what they were.
    const again = openStore(path);
    again.close();
    const raw = new DatabaseSync(path);
    try {
      assert.deepEqual(raw.prepare('PRAGMA table_info(projects)').all().map((c) => c.name),
        ['slug', 'name', 'prefix', 'operator', 'next_number', 'url', 'logo', 'owner']);
      assert.deepEqual(raw.prepare("SELECT * FROM tickets WHERE id IN ('OL-1', 'OL-2') ORDER BY id").all(), ticketsBefore);
    } finally { raw.close(); }
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

/** A store whose clock only moves when the test moves it, with one person and one machine. */
function accountsFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-store-'));
  const path = join(dir, 'tracker.db');
  const clock = { at: Date.UTC(2026, 10, 1, 12, 0, 0) };
  const store = openStore(path, { now: () => new Date(clock.at).toISOString() });
  const person = store.createActor({ kind: 'human', name: 'Person' });
  const machine = store.createActor({ kind: 'machine', name: 'Loop' });
  const advance = (ms) => { clock.at += ms; };
  const cleanup = () => { store.close(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, path, store, person, machine, advance, cleanup };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** The database file and its write-ahead log, as text, to search for things that must not be there. */
function rawBytes(path) {
  let wal = '';
  try { wal = readFileSync(`${path}-wal`).toString('latin1'); } catch { /* no log */ }
  return readFileSync(path).toString('latin1') + wal;
}

test('a person\'s password: the right one finds them, a wrong one, an unknown email or no password finds nobody', () => {
  const { store, person, cleanup } = accountsFixture();
  try {
    assert.equal(store.setEmail(person.id, '  Person@Example.COM '), 'person@example.com');
    assert.equal(store.emailOf(person.id), 'person@example.com');
    assert.equal(store.checkPassword({ email: 'person@example.com', password: 'correct horse battery' }), null);
    store.setPassword(person.id, 'correct horse battery');
    assert.deepEqual(store.checkPassword({ email: 'PERSON@example.com', password: 'correct horse battery' }), person);
    assert.equal(store.checkPassword({ email: 'person@example.com', password: 'correct horse batterY' }), null);
    assert.equal(store.checkPassword({ email: 'nobody@example.com', password: 'correct horse battery' }), null);
    assert.equal(store.checkPassword({ email: 'person@example.com', password: undefined }), null);
    // A new password replaces the old one.
    store.setPassword(person.id, 'a different long one');
    assert.equal(store.checkPassword({ email: 'person@example.com', password: 'correct horse battery' }), null);
    assert.equal(store.checkPassword({ email: 'person@example.com', password: 'a different long one' })?.id, person.id);
    // getActor and listPeople still never show an email or a password.
    assert.deepEqual(store.getActor(person.id), person);
    assert.deepEqual(store.listPeople(), [{ id: person.id, name: 'Person' }]);
  } finally { cleanup(); }
});

test('a password under 12 characters is refused and the old one stays', () => {
  const { store, person, cleanup } = accountsFixture();
  try {
    store.setEmail(person.id, 'p@example.com');
    store.setPassword(person.id, 'twelve chars');
    for (const bad of ['elevenchars', '', undefined, 12345678901234]) {
      assert.throws(() => store.setPassword(person.id, bad), { code: 'weak-password' });
    }
    assert.equal(store.checkPassword({ email: 'p@example.com', password: 'twelve chars' })?.id, person.id);
  } finally { cleanup(); }
});

test('an email is unique whatever its case, and a bad one is refused', () => {
  const { store, person, cleanup } = accountsFixture();
  try {
    const other = store.createActor({ kind: 'human', name: 'Other' });
    store.setEmail(person.id, 'same@example.com');
    assert.throws(() => store.setEmail(other.id, 'SAME@Example.com'), { code: 'duplicate-email' });
    assert.equal(store.emailOf(other.id), null);
    assert.equal(store.setEmail(person.id, 'Same@example.com'), 'same@example.com');
    assert.deepEqual(store.actorForEmail('SAME@EXAMPLE.COM'), person);
    assert.equal(store.actorForEmail('else@example.com'), null);
    for (const bad of ['', 'not-an-email', 'a@b', 'two words@example.com', null]) {
      assert.throws(() => store.setEmail(other.id, bad), { code: 'bad-email' });
    }
  } finally { cleanup(); }
});

test('a machine is refused an email, a password, a session and a setup link, and nothing is written', () => {
  const { store, person, machine, cleanup } = accountsFixture();
  try {
    assert.throws(() => store.setEmail(machine.id, 'loop@example.com'), { code: 'machine-account' });
    assert.throws(() => store.setPassword(machine.id, 'a long enough password'), { code: 'machine-account' });
    assert.throws(() => store.startSession(machine.id), { code: 'machine-account' });
    assert.throws(() => store.makeLink({ purpose: 'setup', email: 'loop@example.com', actor: machine.id, madeBy: person.id }), { code: 'machine-account' });
    assert.throws(() => store.startSession(999), { code: 'unknown-actor' });
    assert.equal(store.actorForEmail('loop@example.com'), null);
    // Its sign-in token still works exactly as before.
    assert.equal(store.actorForToken(store.issueToken(machine.id))?.id, machine.id);
  } finally { cleanup(); }
});

test('a session finds its person, lasts 30 days, and ends one at a time or all at once', () => {
  const { store, person, advance, cleanup } = accountsFixture();
  try {
    const a = store.startSession(person.id);
    const b = store.startSession(person.id);
    assert.match(a.token, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(a.expiresAt, '2026-12-01T12:00:00.000Z');
    assert.deepEqual(store.actorForSession(a.token), person);
    assert.equal(store.actorForSession('not-a-session'), null);
    assert.equal(store.actorForSession(undefined), null);
    // A session token is not a sign-in token, nor the other way round.
    assert.equal(store.actorForToken(a.token), null);

    assert.equal(store.endSession(a.token), true);
    assert.equal(store.endSession(a.token), false);
    assert.equal(store.actorForSession(a.token), null);
    assert.equal(store.actorForSession(b.token)?.id, person.id);

    const c = store.startSession(person.id);
    assert.equal(store.endAllSessions(person.id), 2);
    assert.equal(store.actorForSession(b.token), null);
    assert.equal(store.actorForSession(c.token), null);

    const d = store.startSession(person.id);
    advance(30 * DAY - 1);
    assert.equal(store.actorForSession(d.token)?.id, person.id);
    advance(1);
    assert.equal(store.actorForSession(d.token), null);
  } finally { cleanup(); }
});

test('a setup link gives an existing person an email and a password, once', () => {
  const { store, person, machine, cleanup } = accountsFixture();
  try {
    const link = store.makeLink({ purpose: 'setup', email: 'Dane@Example.com', actor: person.id, madeBy: machine.id });
    assert.equal(link.expiresAt, '2026-11-08T12:00:00.000Z');
    assert.equal(store.emailOf(person.id), null);
    const used = store.useLink({ token: link.token, password: 'my first password' });
    assert.deepEqual(used, { purpose: 'setup', actor: person });
    assert.equal(store.emailOf(person.id), 'dane@example.com');
    assert.equal(store.checkPassword({ email: 'dane@example.com', password: 'my first password' })?.id, person.id);
    assert.throws(() => store.useLink({ token: link.token, password: 'a second password' }), { code: 'used-link' });
    assert.equal(store.checkPassword({ email: 'dane@example.com', password: 'a second password' }), null);
  } finally { cleanup(); }
});

test('an invite link makes a new person with its email, the name given and the password, once', () => {
  const { store, person, cleanup } = accountsFixture();
  try {
    const link = store.makeLink({ purpose: 'invite', email: 'new@example.com', madeBy: person.id });
    assert.equal(link.expiresAt, '2026-11-08T12:00:00.000Z');
    assert.throws(() => store.useLink({ token: link.token, password: 'a long password' }), { code: 'missing' });
    const { purpose, actor } = store.useLink({ token: link.token, password: 'a long password', name: ' New Person ' });
    assert.equal(purpose, 'invite');
    assert.deepEqual(actor, { id: actor.id, kind: 'human', name: 'New Person' });
    assert.equal(store.checkPassword({ email: 'new@example.com', password: 'a long password' })?.id, actor.id);
    assert.throws(() => store.useLink({ token: link.token, password: 'a long password', name: 'Twice' }), { code: 'used-link' });
    assert.equal(store.actorsNamed({ kind: 'human', name: 'Twice' }).length, 0);
    // Nobody can be invited at an email a person already holds.
    assert.throws(() => store.makeLink({ purpose: 'invite', email: 'NEW@example.com', madeBy: person.id }), { code: 'duplicate-email' });
  } finally { cleanup(); }
});

test('a reset link sets a new password, once, and ends every session that person had', () => {
  const { store, person, cleanup } = accountsFixture();
  try {
    const other = store.createActor({ kind: 'human', name: 'Other' });
    store.setEmail(person.id, 'p@example.com');
    store.setPassword(person.id, 'the old password');
    const mine = store.startSession(person.id);
    const theirs = store.startSession(other.id);
    assert.throws(() => store.makeLink({ purpose: 'reset', email: 'nobody@example.com' }), { code: 'unknown-email' });
    const link = store.makeLink({ purpose: 'reset', email: 'P@example.com' });
    assert.equal(link.expiresAt, '2026-11-01T13:00:00.000Z');
    assert.deepEqual(store.useLink({ token: link.token, password: 'the new password' }), { purpose: 'reset', actor: person });
    assert.equal(store.checkPassword({ email: 'p@example.com', password: 'the old password' }), null);
    assert.equal(store.checkPassword({ email: 'p@example.com', password: 'the new password' })?.id, person.id);
    assert.equal(store.actorForSession(mine.token), null);
    assert.equal(store.actorForSession(theirs.token)?.id, other.id);
    assert.throws(() => store.useLink({ token: link.token, password: 'yet another one' }), { code: 'used-link' });
  } finally { cleanup(); }
});

test('each kind of link is refused once it has expired, and an unknown link or a short password spends nothing', () => {
  const { store, person, machine, advance, cleanup } = accountsFixture();
  try {
    const other = store.createActor({ kind: 'human', name: 'Other' });
    store.setEmail(other.id, 'other@example.com');
    const setup = store.makeLink({ purpose: 'setup', email: 'p@example.com', actor: person.id, madeBy: machine.id });
    const invite = store.makeLink({ purpose: 'invite', email: 'new@example.com', madeBy: person.id });
    const reset = store.makeLink({ purpose: 'reset', email: 'other@example.com' });

    assert.throws(() => store.useLink({ token: 'no-such-link', password: 'a long password' }), { code: 'unknown-link' });
    assert.throws(() => store.useLink({ token: undefined, password: 'a long password' }), { code: 'unknown-link' });
    // A short password is refused before the link is looked at, so the link still works.
    assert.throws(() => store.useLink({ token: reset.token, password: 'short' }), { code: 'weak-password' });

    advance(HOUR);
    assert.throws(() => store.useLink({ token: reset.token, password: 'a long password' }), { code: 'expired-link' });
    advance(7 * DAY - HOUR - 1);
    assert.equal(store.useLink({ token: setup.token, password: 'a long password' }).purpose, 'setup');
    advance(1);
    assert.throws(() => store.useLink({ token: invite.token, password: 'a long password', name: 'Late' }), { code: 'expired-link' });
    assert.equal(store.actorForEmail('new@example.com'), null);
    assert.throws(() => store.makeLink({ purpose: 'forgot', email: 'p@example.com', madeBy: person.id }), { code: 'bad-link' });
    assert.throws(() => store.makeLink({ purpose: 'invite', email: 'x@example.com' }), { code: 'unknown-actor' });
  } finally { cleanup(); }
});

test('linkInfo says what a link is for without spending it, and refuses as useLink does', () => {
  const { store, person, machine, advance, cleanup } = accountsFixture();
  try {
    const setup = store.makeLink({ purpose: 'setup', email: 'P@Example.com', actor: person.id, madeBy: machine.id });
    assert.deepEqual(store.linkInfo(setup.token), { purpose: 'setup', email: 'p@example.com', expiresAt: setup.expiresAt });
    assert.deepEqual(store.linkInfo(setup.token).email, 'p@example.com', 'asking twice spends nothing');
    assert.throws(() => store.linkInfo('no-such-link'), { code: 'unknown-link' });
    assert.throws(() => store.linkInfo(undefined), { code: 'unknown-link' });
    store.useLink({ token: setup.token, password: 'a long password' });
    assert.throws(() => store.linkInfo(setup.token), { code: 'used-link' });
    const invite = store.makeLink({ purpose: 'invite', email: 'new@example.com', madeBy: person.id });
    advance(7 * DAY);
    assert.throws(() => store.linkInfo(invite.token), { code: 'expired-link' });
  } finally { cleanup(); }
});

test('cancelLink withdraws an unused link for good, and leaves a used one as the record', () => {
  const { store, person, machine, cleanup } = accountsFixture();
  try {
    const link = store.makeLink({ purpose: 'setup', email: 'p@example.com', actor: person.id, madeBy: machine.id });
    assert.equal(store.cancelLink(link.token), true);
    assert.throws(() => store.useLink({ token: link.token, password: 'a long password' }), { code: 'unknown-link' });
    assert.equal(store.emailOf(person.id), null);
    assert.equal(store.cancelLink(link.token), false);
    assert.equal(store.cancelLink(undefined), false);
    const used = store.makeLink({ purpose: 'setup', email: 'p@example.com', actor: person.id, madeBy: machine.id });
    store.useLink({ token: used.token, password: 'a long password' });
    assert.equal(store.cancelLink(used.token), false);
    assert.throws(() => store.linkInfo(used.token), { code: 'used-link' });
  } finally { cleanup(); }
});

test('no password, session token or link token is ever in the database file, only their hashes', () => {
  const { dir, path, store, person, machine } = accountsFixture();
  try {
    const setup = store.makeLink({ purpose: 'setup', email: 'p@example.com', actor: person.id, madeBy: machine.id });
    store.useLink({ token: setup.token, password: 'setup password xyz' });
    store.setPassword(person.id, 'changed password xyz');
    const session = store.startSession(person.id);
    const invite = store.makeLink({ purpose: 'invite', email: 'n@example.com', madeBy: person.id });
    const reset = store.makeLink({ purpose: 'reset', email: 'p@example.com' });
    store.close();

    const raw = rawBytes(path);
    for (const secret of ['setup password xyz', 'changed password xyz', session.token, setup.token, invite.token, reset.token]) {
      assert.ok(!raw.includes(secret), 'a raw secret is in the database file');
    }
    const db = new DatabaseSync(path);
    try {
      const sha = (t) => createHash('sha256').update(t).digest('hex');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(sha(session.token)).n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_links WHERE token_hash IN (?, ?, ?)').get(sha(setup.token), sha(invite.token), sha(reset.token)).n, 3);
      assert.match(db.prepare('SELECT password_hash FROM actors WHERE id = ?').get(person.id).password_hash, /^scrypt\$\d+\$\d+\$\d+\$[\w-]+\$[\w-]+$/);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('two people with the same password get different stored hashes (a salt each)', () => {
  const { path, store, person, cleanup } = accountsFixture();
  try {
    const other = store.createActor({ kind: 'human', name: 'Other' });
    store.setPassword(person.id, 'the very same one');
    store.setPassword(other.id, 'the very same one');
    const db = new DatabaseSync(path);
    try {
      const [a, b] = db.prepare('SELECT password_hash FROM actors WHERE id IN (?, ?)').all(person.id, other.id).map((r) => r.password_hash);
      assert.notEqual(a, b);
    } finally { db.close(); }
  } finally { cleanup(); }
});

test('today\'s database gains emails, passwords, sessions and links, and every existing row is unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-store-'));
  const path = join(dir, 'old.db');
  try {
    // The shape the live tracker has before this change.
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE actors (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK (kind IN ('human', 'machine')), name TEXT NOT NULL, token_hash TEXT);
      CREATE TABLE projects (slug TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL UNIQUE, operator INTEGER REFERENCES actors(id),
        next_number INTEGER NOT NULL DEFAULT 1, url TEXT, logo TEXT, owner INTEGER REFERENCES actors(id));
      CREATE TABLE tickets (id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(slug), number INTEGER NOT NULL, name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, priority TEXT, tags TEXT NOT NULL DEFAULT '[]', assignee INTEGER REFERENCES actors(id),
        loop_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, UNIQUE (project, number));
      CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket TEXT NOT NULL REFERENCES tickets(id), parent INTEGER REFERENCES comments(id),
        author INTEGER NOT NULL REFERENCES actors(id), body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE stage_colours (status TEXT PRIMARY KEY, colour TEXT NOT NULL);
      CREATE UNIQUE INDEX actors_by_token ON actors (token_hash);
      INSERT INTO actors (kind, name, token_hash) VALUES ('human', 'Dane', 'aaaa'), ('machine', 'Loop', 'bbbb');
      INSERT INTO projects (slug, name, prefix, operator, next_number, owner) VALUES ('old', 'Old', 'OL', 1, 2, 1);
      INSERT INTO tickets (id, project, number, name, status, created_at, updated_at, version)
        VALUES ('OL-1', 'old', 1, 'First', 'queued', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z', 3);
      INSERT INTO comments (ticket, author, body, created_at) VALUES ('OL-1', 2, 'a note', '2026-10-02T00:00:00.000Z');
      INSERT INTO stage_colours (status, colour) VALUES ('queued', '#2b9cf2');
    `);
    const before = Object.fromEntries(['actors', 'projects', 'tickets', 'comments', 'stage_colours']
      .map((t) => [t, old.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
    old.close();

    // Opening it adds the columns and tables; a second opening adds nothing twice.
    openStore(path).close();
    const store = openStore(path);
    let link;
    try {
      assert.deepEqual(store.getActor(1), { id: 1, kind: 'human', name: 'Dane' });
      assert.equal(store.emailOf(1), null);
      link = store.makeLink({ purpose: 'setup', email: 'dane@example.com', actor: 1, madeBy: 2 });
    } finally { store.close(); }

    const raw = new DatabaseSync(path);
    try {
      assert.deepEqual(raw.prepare('PRAGMA table_info(actors)').all().map((c) => c.name), ['id', 'kind', 'name', 'token_hash', 'email', 'password_hash']);
      assert.deepEqual(raw.prepare('SELECT id, kind, name, token_hash FROM actors ORDER BY id').all(), before.actors);
      for (const t of ['projects', 'tickets', 'comments', 'stage_colours']) {
        assert.deepEqual(raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(), before[t], t);
      }
    } finally { raw.close(); }

    // Dane's existing actor takes the setup link, so his history stays his.
    const again = openStore(path);
    try {
      assert.equal(again.useLink({ token: link.token, password: 'dane first password' }).actor.id, 1);
      assert.equal(again.checkPassword({ email: 'dane@example.com', password: 'dane first password' })?.id, 1);
      assert.equal(again.listComments('OL-1')[0].author, 2);
      assert.equal(again.getProject('old').owner, 1);
    } finally { again.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
