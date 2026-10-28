import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { startServer } from './server.mjs';
import { importLoopQueue } from './import.mjs';
import { compareQueues, databasePath, formatSwitchCheck, runSwitchCheck, trackerAddress } from './switchCheck.mjs';

/** A config with made-up values, so nothing can pass by matching a real product. */
const CONFIG = Object.freeze({
  loopQueueListId: '4242',
  operatorUserId: '700',
  machineUserId: '800',
  operatorName: 'Pat',
  productSlug: 'widget',
  trackerPrefix: 'WG',
});

const ok = (json) => ({ res: { ok: true, status: 200 }, json, text: '' });

function task(id, status = 'queued', name = `Ticket ${id}`) {
  return {
    id, name, status: { status, type: 'custom' }, date_created: '1767225600000', date_updated: '1767225600000',
    priority: { priority: 'normal' }, tags: [], creator: { id: 700 }, assignees: [],
  };
}

/** A fake ClickUp with only the reads; a write would throw, because it is not there. */
function fakeClickup(tasks) {
  return {
    async listTasksPage(list, page) { return ok({ tasks: page === 0 ? tasks : [], last_page: true }); },
    async getTask(id) { return ok({ ...tasks.find((t) => t.id === id), markdown_description: '' }); },
    async listComments() { return { paged: { complete: true, comments: [] }, bad: null }; },
    async listReplies() { return ok({ comments: [] }); },
  };
}

const ticket = (id, status, name = `Tracker ${id}`) => ({ id, name, status });

test('compareQueues: the same tickets with the same statuses pass', () => {
  const r = compareQueues({
    clickupTasks: [task('a', 'queued'), task('b', 'live')],
    trackerTickets: [ticket('WG-1', 'queued'), ticket('WG-2', 'live')],
    importedFrom: new Map([['WG-1', 'a'], ['WG-2', 'b']]),
  });
  assert.equal(r.ok, true);
  assert.match(r.lines.join('\n'), /2 ticket\(s\), 1 open/);
  assert.match(r.lines.join('\n'), /Every ticket is in both/);
});

test('compareQueues: a ticket missing from the tracker fails by name', () => {
  const r = compareQueues({
    clickupTasks: [task('a'), task('b', 'rework', 'Second one')],
    trackerTickets: [ticket('WG-1', 'queued')],
    importedFrom: new Map([['WG-1', 'a']]),
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['b "Second one" (Rework): in ClickUp, not in the tracker']);
  assert.match(r.lines.join('\n'), /MISSING from the tracker \(1\)/);
});

test('compareQueues: an extra ticket in the tracker fails by name, whether filed there or gone from ClickUp', () => {
  const r = compareQueues({
    clickupTasks: [task('a')],
    trackerTickets: [ticket('WG-1', 'queued'), ticket('WG-2', 'queued', 'Filed by hand'), ticket('WG-3', 'live', 'Gone')],
    importedFrom: new Map([['WG-1', 'a'], ['WG-3', 'z']]),
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.extra, [
    'WG-2 "Filed by hand": in the tracker, but not imported from ClickUp',
    'WG-3 "Gone": imported from ClickUp ticket z, which is no longer in the Loop Queue',
  ]);
});

test('compareQueues: a status that differs fails by name, showing both', () => {
  const r = compareQueues({
    clickupTasks: [task('a', 'in review', 'Moved one')],
    trackerTickets: [ticket('WG-1', 'building')],
    importedFrom: new Map([['WG-1', 'a']]),
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.mismatched, ['a "Moved one": ClickUp says In review, the tracker (WG-1) says Building']);
});

test('compareQueues: nothing imported yet says to run the import, and a long list is cut short', () => {
  const tasks = Array.from({ length: 20 }, (_, i) => task(`t${i}`));
  const r = compareQueues({ clickupTasks: tasks, trackerTickets: [], importedFrom: new Map() });
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 20);
  const text = r.lines.join('\n');
  assert.match(text, /and 5 more/);
  assert.match(text, /Nothing is imported yet: run `npm run tracker:import/);
});

test('trackerAddress and databasePath come from the config', () => {
  assert.equal(trackerAddress({ trackerUrl: 'http://mini.local:4180/' }), 'http://mini.local:4180');
  assert.equal(trackerAddress({ trackerPort: 4999 }), 'http://127.0.0.1:4999');
  assert.equal(trackerAddress({}), null);
  assert.equal(databasePath({ trackerDataDir: '/data/x' }, {}), '/data/x/tracker.db');
  assert.equal(databasePath({ trackerDataDir: '/data/x' }, { TRACKER_DB: '/elsewhere.db' }), '/elsewhere.db');
  assert.equal(databasePath({}, {}), null);
});

/** A port nothing listens on. */
async function closedPort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/** A database with the operator's and the loops' sign-ins, and `tasks` imported. */
async function preparedDatabase(tasks) {
  const dir = mkdtempSync(join(tmpdir(), 'switch-check-'));
  const db = join(dir, 'tracker.db');
  const store = openStore(db);
  const env = {};
  for (const [secret, kind, name] of [
    ['TRACKER_TOKEN_OPERATOR', 'human', 'Pat'], ['TRACKER_TOKEN_LOOP_BUILD', 'machine', 'loop-build'],
    ['TRACKER_TOKEN_LOOP_REVIEW', 'machine', 'loop-review'], ['TRACKER_TOKEN_RELAY', 'machine', 'relay'],
  ]) {
    env[secret] = store.issueToken(store.createActor({ kind, name }).id);
  }
  await importLoopQueue({ tracker: fakeClickup(tasks), store, config: CONFIG });
  return { dir, db, store, env };
}

const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('runSwitchCheck: with the tracker down it says so and fails, checks sign-ins on a copy, and writes nothing', async () => {
  const tasks = [task('a'), task('b', 'live')];
  const { dir, db, store, env } = await preparedDatabase(tasks);
  store.close();
  const before = digest(db);
  try {
    const port = await closedPort();
    const r = await runSwitchCheck({ config: { ...CONFIG, trackerPort: port }, env, db, clickup: fakeClickup(tasks) });
    const by = Object.fromEntries(r.sections.map((s) => [s.name, s]));
    assert.equal(r.ok, false);
    assert.equal(by['tracker service'].ok, false);
    assert.match(by['tracker service'].lines[0], new RegExp(`NOTHING ANSWERS at http://127.0.0.1:${port}`));
    assert.equal(by['sign-ins'].ok, true);
    assert.match(by['sign-ins'].lines[0], /a copy of the database/);
    assert.equal(by['queues match'].ok, true);
    assert.equal(by['dry-run import'].ok, true);
    assert.match(formatSwitchCheck(r), /NOT OK  tracker service[\s\S]*NOT SAFE TO SWITCH/);
    assert.equal(digest(db), before, 'the real database is untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSwitchCheck: with the tracker running and everything imported, it is safe to switch', async () => {
  const tasks = [task('a'), task('b', 'in review')];
  const { dir, db, store, env } = await preparedDatabase(tasks);
  const server = await startServer({ store, port: 0 });
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const r = await runSwitchCheck({ config: { ...CONFIG, tracker: 'api', trackerUrl: url }, env, db, clickup: fakeClickup(tasks) });
    assert.equal(r.ok, true, formatSwitchCheck(r));
    const signins = r.sections.find((s) => s.name === 'sign-ins');
    assert.match(signins.lines[0], /the running tracker/);
    assert.match(formatSwitchCheck(r), /Safe to switch\.$/);
  } finally {
    await new Promise((res) => server.close(res));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSwitchCheck: a ticket that moved in ClickUp after the import, and a missing sign-in, each fail', async () => {
  const { dir, db, store, env } = await preparedDatabase([task('a')]);
  store.close();
  delete env.TRACKER_TOKEN_RELAY;
  try {
    const r = await runSwitchCheck({
      config: { ...CONFIG, trackerPort: await closedPort() }, env, db, clickup: fakeClickup([task('a', 'building'), task('new')]),
    });
    const by = Object.fromEntries(r.sections.map((s) => [s.name, s]));
    assert.equal(by['sign-ins'].ok, false);
    assert.match(by['sign-ins'].lines.join('\n'), /TRACKER_TOKEN_RELAY: MISSING/);
    assert.equal(by['queues match'].ok, false);
    const text = by['queues match'].lines.join('\n');
    assert.match(text, /a "Ticket a": ClickUp says Building, the tracker \(WG-1\) says Queued/);
    assert.match(text, /new "Ticket new" \(Queued\): in ClickUp, not in the tracker/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSwitchCheck: no database and no tracker configured each fail plainly', async () => {
  const r = await runSwitchCheck({ config: CONFIG, env: {}, db: join(tmpdir(), 'no-such-switch-check.db'), clickup: fakeClickup([task('a')]) });
  const by = Object.fromEntries(r.sections.map((s) => [s.name, s]));
  assert.equal(r.ok, false);
  assert.match(by['tracker service'].lines[0], /neither trackerUrl nor trackerPort/);
  assert.equal(by.database.ok, false);
  assert.match(by['sign-ins'].lines[0], /no database/);
  assert.match(by['queues match'].lines.join('\n'), /Nothing is imported yet/);
});

test('runSwitchCheck: something else answering on the port is not the tracker', async () => {
  const other = createHttpServer((req, res) => res.end('hello'));
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  try {
    const r = await runSwitchCheck({ config: { ...CONFIG, trackerPort: other.address().port }, env: {}, db: null, clickup: fakeClickup([]) });
    const service = r.sections.find((s) => s.name === 'tracker service');
    assert.equal(service.ok, false);
    assert.match(service.lines[0], /HTTP 200 to GET \/me, so it is not the tracker/);
  } finally {
    await new Promise((r) => other.close(r));
  }
});
