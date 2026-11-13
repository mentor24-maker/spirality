import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { startServer } from './server.mjs';
import { createLaneWaker, laneToWake, LANE_FOR_STATUS, RELAY, runWakeCommand } from './wakeLanes.mjs';

const PROJECT = 'spirality';
const dane = { id: 1, kind: 'human', name: 'Dane' };
const relayActor = { id: 4, kind: 'machine', name: 'relay' };
const handRun = { id: 6, kind: 'machine', name: 'hand-run' };
const ticket = (status, project = PROJECT) => ({ id: 'SP-9', project, status });
const moved = (status, extra = {}) => ({ ticket: ticket(status, extra.project), changed: extra.changed ?? ['status'] });

test('each status a lane picks up wakes that lane', () => {
  const expect = { Requested: 'loop-intake', Queued: 'loop-build', Rework: 'loop-build', 'In review': 'loop-review' };
  for (const [status, lane] of Object.entries(expect)) {
    const got = laneToWake(moved(status), { actor: relayActor, project: PROJECT });
    assert.deepEqual(got && { lane: got.lane, ticket: got.ticket }, { lane, ticket: 'SP-9' }, status);
  }
  assert.deepEqual(Object.keys(LANE_FOR_STATUS).sort(), ['in review', 'queued', 'requested', 'rework']);
});

test('a move into a status no lane picks up wakes nothing', () => {
  for (const status of ['building', 'ready to launch', 'needs your input', 'live']) {
    assert.equal(laneToWake(moved(status), { actor: handRun, project: PROJECT }), null, status);
  }
});

test('a write that leaves the status alone wakes nothing', () => {
  assert.equal(laneToWake(moved('queued', { changed: ['name', 'description'] }), { actor: dane, project: PROJECT }), null);
  assert.equal(laneToWake(moved('queued', { changed: [] }), { actor: dane, project: PROJECT }), null);
});

test('a ticket from another project wakes nothing, and neither does a server with no project', () => {
  assert.equal(laneToWake(moved('queued', { project: 'starcaster' }), { actor: dane, project: PROJECT }), null);
  assert.equal(laneToWake(moved('queued'), { actor: dane, project: null }), null);
  const comment = { comment: { id: 1, body: 'merge' }, on: ticket('ready to launch', 'wavecenter') };
  assert.equal(laneToWake(comment, { actor: dane, project: PROJECT }), null);
});

test('a lane never wakes itself; another lane\'s move does wake it', () => {
  const build = { kind: 'machine', name: 'loop-build' };
  assert.equal(laneToWake(moved('rework'), { actor: build, project: PROJECT }), null);
  assert.equal(laneToWake(moved('rework'), { actor: { kind: 'machine', name: 'spirality loop-build' }, project: PROJECT }), null);
  assert.equal(laneToWake(moved('rework'), { actor: { kind: 'machine', name: 'loop-review' }, project: PROJECT }).lane, 'loop-build');
  assert.equal(laneToWake(moved('in review'), { actor: build, project: PROJECT }).lane, 'loop-review');
  // A person named like a lane is still a person.
  assert.equal(laneToWake(moved('queued'), { actor: { kind: 'human', name: 'loop-build' }, project: PROJECT }).lane, 'loop-build');
});

test('a person\'s comment on Ready to launch or Needs your input wakes the relay; others do not', () => {
  for (const status of ['ready to launch', 'needs your input']) {
    const got = laneToWake({ comment: { id: 1, body: 'merge' }, on: ticket(status) }, { actor: dane, project: PROJECT });
    assert.equal(got.lane, RELAY, status);
    assert.match(got.why, /comment from Dane/);
  }
  // A loop's comment, or a comment on a machine status, wakes nothing.
  assert.equal(laneToWake({ comment: { id: 1 }, on: ticket('ready to launch') }, { actor: relayActor, project: PROJECT }), null);
  assert.equal(laneToWake({ comment: { id: 1 }, on: ticket('queued') }, { actor: dane, project: PROJECT }), null);
  assert.equal(laneToWake({ comment: { id: 1 }, on: ticket('ready to launch') }, { actor: null, project: PROJECT }), null);
});

test('a wake is logged once with the ticket, the status and the lane', async () => {
  const lines = [];
  const asked = [];
  const waker = createLaneWaker({ project: PROJECT, log: (l) => lines.push(l), wake: async (lane) => { asked.push(lane); return { code: 0, line: `${lane}: woken` }; } });
  await waker.afterWrite(moved('queued'), { actor: dane });
  await waker.afterWrite(moved('building'), { actor: dane });
  assert.deepEqual(asked, ['loop-build']);
  assert.deepEqual(lines, ['wake lanes: SP-9 entered "queued" → loop-build: loop-build: woken']);
});

test('a failed wake, a thrown wake and a hung wake are each one line, and never reject', async () => {
  const lines = [];
  const log = (l) => lines.push(l);
  await createLaneWaker({ project: PROJECT, log, wake: async () => ({ code: 1, line: 'loop-build: NOT WOKEN — no room' }) }).afterWrite(moved('queued'));
  await createLaneWaker({ project: PROJECT, log, wake: () => { throw new Error('boom'); } }).afterWrite(moved('in review'));
  assert.deepEqual(lines, [
    'wake lanes: SP-9 entered "queued" → loop-build FAILED: loop-build: NOT WOKEN — no room',
    'wake lanes: SP-9 entered "in review" → loop-review FAILED: boom',
  ]);
  // The real runner, against a command that never answers, is stopped at its limit.
  const hung = await runWakeCommand('loop-build', { timeout: 50, run: (_bin, _args, opts, done) => setTimeout(() => done(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), '', ''), opts.timeout) });
  assert.equal(hung.code, 1);
  assert.match(hung.line, /loop-build: NOT WOKEN — the wake command stopped after 0\.05s with no answer/);
  const refused = await runWakeCommand('relay', { run: (_bin, _args, _opts, done) => done(Object.assign(new Error('exit 1'), { code: 1 }), '', 'relay: NOT WOKEN — launchctl kickstart exited 113\n') });
  assert.deepEqual(refused, { code: 1, line: 'relay: NOT WOKEN — launchctl kickstart exited 113 (exited 1)' });
});

test('runWakeCommand runs slice 1\'s command for the lane, with a time limit', async () => {
  let seen;
  const r = await runWakeCommand('loop-review', { run: (bin, args, opts, done) => { seen = { bin, args, opts }; done(null, 'loop-review: woken — wake file written\n', ''); } });
  assert.deepEqual(r, { code: 0, line: 'loop-review: woken — wake file written' });
  assert.equal(seen.bin, process.execPath);
  assert.match(seen.args[0], /scripts\/lib\/wakeLane\.mjs$/);
  assert.equal(seen.args[1], 'loop-review');
  assert.equal(seen.opts.timeout, 5000);
});

/** A server on a free port with its own project, a person and a loop, and a stand-in wake. */
async function served(wake) {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-wake-'));
  const store = openStore(join(dir, 'tracker.db'));
  const human = store.createActor({ kind: 'human', name: 'Operator' });
  const loop = store.createActor({ kind: 'machine', name: 'hand-run' });
  const humanToken = store.issueToken(human.id);
  const loopToken = store.issueToken(loop.id);
  store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL', operator: human.id });
  store.createProject({ slug: 'beta', name: 'Beta', prefix: 'BE', operator: human.id });
  const lines = [];
  const log = (l) => lines.push(l);
  const waker = createLaneWaker({ project: 'alpha', log, wake });
  const server = await startServer({ store, port: 0, log, waker });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, path, body, token = loopToken) {
    const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }
  async function cleanup() {
    await new Promise((r) => server.close(r));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return { store, call, lines, waker, humanToken, cleanup };
}

test('the server wakes the lane after a move, and a failed wake leaves the move written', async () => {
  const asked = [];
  const f = await served(async (lane) => { asked.push(lane); return { code: 1, line: `${lane}: NOT WOKEN — test` }; });
  try {
    const filed = await f.call('POST', '/projects/alpha/tickets', { name: 'One', status: 'requested' });
    assert.equal(filed.status, 201);
    const id = filed.body.id;
    const queued = await f.call('PATCH', `/tickets/${id}`, { status: 'queued' });
    assert.equal(queued.status, 200);
    const renamed = await f.call('PATCH', `/tickets/${id}`, { name: 'One, renamed' });
    assert.equal(renamed.status, 200);
    await f.waker.settled();
    assert.deepEqual(asked, ['loop-intake', 'loop-build']);
    assert.equal(f.store.getTicket(id).status, 'queued');
    assert.deepEqual(f.lines.filter((l) => l.startsWith('wake lanes:')), [
      `wake lanes: ${id} entered "requested" → loop-intake FAILED: loop-intake: NOT WOKEN — test`,
      `wake lanes: ${id} entered "queued" → loop-build FAILED: loop-build: NOT WOKEN — test`,
    ]);
    // Another project's ticket wakes nothing here.
    const other = await f.call('POST', '/projects/beta/tickets', { name: 'Two', status: 'queued' });
    assert.equal(other.status, 201);
    await f.waker.settled();
    assert.equal(asked.length, 2);
  } finally { await f.cleanup(); }
});

test('the server wakes the relay when a person comments on a Ready to launch ticket', async () => {
  const asked = [];
  const f = await served(async (lane) => { asked.push(lane); return { code: 0, line: `${lane}: woken` }; });
  try {
    const filed = await f.call('POST', '/projects/alpha/tickets', { name: 'One', status: 'ready to launch' });
    assert.equal(filed.status, 201);
    const id = filed.body.id;
    assert.equal((await f.call('POST', `/tickets/${id}/comments`, { body: 'PR opened: x' })).status, 201);
    assert.equal((await f.call('POST', `/tickets/${id}/comments`, { body: 'merge' }, f.humanToken)).status, 201);
    await f.waker.settled();
    assert.deepEqual(asked, ['relay']);
    assert.ok(f.lines.some((l) => l === `wake lanes: ${id} has a comment from Operator in "ready to launch" → relay: relay: woken`), f.lines.join('\n'));
  } finally { await f.cleanup(); }
});
