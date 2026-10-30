import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { startServer } from './server.mjs';
import { createSignins, checkSignins, seatsFor, whoIs } from './signins.mjs';
import { TRACKER_SEATS, EXPECTED_SECRETS } from '../scripts/lib/expectedSecrets.mjs';

const PROJECT = { slug: 'alpha', name: 'Alpha', prefix: 'AL' };

/** A temporary store and a fake Doppler that holds what is set in memory. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'signins-'));
  const store = openStore(join(dir, 'tracker.db'));
  const vault = {};
  return {
    store, vault,
    seats: seatsFor('Dana'),
    setSecret: (name, value) => { vault[name] = value; },
    getSecret: (name) => vault[name],
    // The tracker serves this same database, as on the right machine.
    proveToken: async (token) => { const me = store.actorForToken(token); return { status: me ? 200 : 401, me }; },
    tracker: { url: 'http://tracker.test', home: 'mini.test' },
    cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('every seat is an expected secret, so doctor reports each one; the operator takes the configured name', async () => {
  const expected = new Set(EXPECTED_SECRETS.map((s) => s.name));
  for (const seat of TRACKER_SEATS) assert.ok(expected.has(seat.secret), seat.secret);
  const seats = seatsFor('Dana');
  assert.deepEqual(seats.filter((s) => s.kind === 'human').map((s) => s.name), ['Dana']);
  assert.ok(seats.every((s) => s.name));
  // A session started by hand signs in as its own machine seat, never the operator.
  assert.deepEqual(TRACKER_SEATS.filter((s) => s.handRun).map((s) => [s.secret, s.kind, s.name]), [['TRACKER_TOKEN_HAND_RUN', 'machine', 'hand-run']]);
});

test('create makes each actor and the project, stores every token, and GET /me then names each seat', async () => {
  const f = fixture();
  try {
    const r = await createSignins({ ...f, env: {}, project: PROJECT });
    assert.equal(r.ok, true, r.lines.join('\n'));
    assert.deepEqual(Object.keys(f.vault).sort(), TRACKER_SEATS.map((s) => s.secret).sort());
    const operator = f.store.actorForToken(f.vault.TRACKER_TOKEN_OPERATOR);
    assert.equal(f.store.getProject('alpha').operator, operator.id);
    for (const line of r.lines) for (const token of Object.values(f.vault)) assert.ok(!line.includes(token), line);

    const server = await startServer({ store: f.store, port: 0 });
    try {
      const url = `http://127.0.0.1:${server.address().port}`;
      const ok = await checkSignins({ url, seats: f.seats, env: f.vault });
      assert.equal(ok.ok, true, ok.lines.join('\n'));
      assert.match(ok.lines.join('\n'), /TRACKER_TOKEN_LOOP_BUILD: GET \/me answers "loop-build" \(machine/);
      const swapped = await checkSignins({ url, seats: f.seats, env: { ...f.vault, TRACKER_TOKEN_RELAY: f.vault.TRACKER_TOKEN_LOOP_BUILD } });
      assert.equal(swapped.ok, false);
      assert.match(swapped.lines.join('\n'), /TRACKER_TOKEN_RELAY: WRONG\. GET \/me answered 200 "loop-build"/);
    } finally {
      await new Promise((res) => server.close(res));
    }
  } finally { f.cleanup(); }
});

test('create run again leaves working sign-ins alone and refuses to replace a token that is not that seat', async () => {
  const f = fixture();
  try {
    await createSignins({ ...f, env: {}, project: PROJECT });
    const before = { ...f.vault };
    const again = await createSignins({ ...f, env: { ...before }, project: PROJECT });
    assert.equal(again.ok, true, again.lines.join('\n'));
    assert.deepEqual(f.vault, before);
    assert.match(again.lines.join('\n'), /project "alpha": already exists/);

    const wrong = await createSignins({ ...f, env: { ...before, TRACKER_TOKEN_RELAY: 'not-a-token' }, project: PROJECT });
    assert.equal(wrong.ok, false);
    assert.match(wrong.lines.join('\n'), /TRACKER_TOKEN_RELAY: REFUSED/);
    assert.deepEqual(f.vault, before);
  } finally { f.cleanup(); }
});

test('a seat whose secret is gone keeps its actor and gets a new token; the old one stops signing in', async () => {
  const f = fixture();
  try {
    await createSignins({ ...f, env: {}, project: PROJECT });
    const old = f.vault.TRACKER_TOKEN_RELAY;
    const relay = f.store.actorForToken(old);
    const { TRACKER_TOKEN_RELAY: _gone, ...rest } = f.vault;
    const r = await createSignins({ ...f, env: rest, project: PROJECT });
    assert.equal(r.ok, true, r.lines.join('\n'));
    assert.match(r.lines.join('\n'), new RegExp(`TRACKER_TOKEN_RELAY: actor ${relay.id} \\(machine, "relay"\\) kept, given a new token`));
    assert.notEqual(f.vault.TRACKER_TOKEN_RELAY, old);
    assert.equal(f.store.actorForToken(old), null);
    assert.equal(f.store.actorForToken(f.vault.TRACKER_TOKEN_RELAY).id, relay.id);
    assert.equal(f.store.actorsNamed({ kind: 'machine', name: 'relay' }).length, 1);
  } finally { f.cleanup(); }
});

test('a token that does not reach Doppler fails loudly, never prints the token, and the project waits for the operator', async () => {
  const f = fixture();
  try {
    let leaked = null;
    const r = await createSignins({
      ...f, env: {}, project: PROJECT,
      setSecret: (name, value) => { if (name === 'TRACKER_TOKEN_OPERATOR') { leaked = value; throw new Error(`doppler said no to ${value}`); } f.vault[name] = value; },
    });
    assert.equal(r.ok, false);
    const text = r.lines.join('\n');
    assert.match(text, /TRACKER_TOKEN_OPERATOR: FAILED\./);
    assert.ok(!text.includes(leaked));
    assert.match(text, /doppler said no to \[token\]/);
    assert.match(text, /project "alpha": NOT made, because the operator has no working sign-in yet/);
    assert.equal(f.store.getProject('alpha'), null);

    const misread = await createSignins({ ...f, env: { ...f.vault }, project: PROJECT, getSecret: () => 'something else' });
    assert.equal(misread.ok, false);
    assert.match(misread.lines.join('\n'), /TRACKER_TOKEN_OPERATOR: FAILED\..*written to Doppler but not confirmed: the value Doppler gives back is not the one written/);
    assert.doesNotMatch(misread.lines.join('\n'), /did not reach Doppler/);
  } finally { f.cleanup(); }
});

test('a project the store refuses (a bad or taken prefix) is named as NOT made, after the tokens are stored', async () => {
  const f = fixture();
  try {
    const bad = await createSignins({ ...f, env: {}, project: { ...PROJECT, prefix: 'al' } });
    assert.equal(bad.ok, false);
    assert.match(bad.lines.join('\n'), /project "alpha": NOT made: .*capital letters/);
    assert.equal(Object.keys(f.vault).length, TRACKER_SEATS.length);

    f.store.createProject({ slug: 'other', name: 'Other', prefix: 'AL' });
    const taken = await createSignins({ ...f, env: { ...f.vault }, project: PROJECT });
    assert.equal(taken.ok, false);
    assert.match(taken.lines.join('\n'), /project "alpha": NOT made: .*already exists/);
  } finally { f.cleanup(); }
});

test('an existing project whose operator is not the one who signs in is called WRONG', async () => {
  const f = fixture();
  try {
    const someone = f.store.createActor({ kind: 'human', name: 'Someone' });
    f.store.createProject({ ...PROJECT, operator: someone.id });
    const r = await createSignins({ ...f, env: {}, project: PROJECT });
    assert.equal(r.ok, false);
    assert.match(r.lines.join('\n'), new RegExp(`project "alpha": WRONG\\. Its operator is actor ${someone.id}`));
  } finally { f.cleanup(); }
});

test('the operator is recorded under the import key once; a key held by another actor is called WRONG, not overwritten', async () => {
  const f = fixture();
  const operatorImport = { source: 'clickup', sourceId: 'user:7' };
  try {
    const first = await createSignins({ ...f, env: {}, project: PROJECT, operatorImport });
    assert.equal(first.ok, true, first.lines.join('\n'));
    const op = f.store.actorForToken(f.vault.TRACKER_TOKEN_OPERATOR);
    assert.match(first.lines.join('\n'), new RegExp(`clickup user:7 now maps to actor ${op.id}`));
    const again = await createSignins({ ...f, env: { ...f.vault }, project: PROJECT, operatorImport });
    assert.match(again.lines.join('\n'), new RegExp(`clickup user:7 already maps to actor ${op.id}`));

    const stray = f.store.importActor({ source: 'clickup', sourceId: 'user:8', kind: 'human', name: 'Dana' });
    const clash = await createSignins({ ...f, env: { ...f.vault }, project: PROJECT, operatorImport: { source: 'clickup', sourceId: 'user:8' } });
    assert.equal(clash.ok, false);
    assert.match(clash.lines.join('\n'), new RegExp(`WRONG\\. The history import already stands actor ${stray.id} for clickup user:8, not actor ${op.id}`));
    assert.equal(f.store.importedId({ source: 'clickup', kind: 'actor', sourceId: 'user:8' }), stray.id);
  } finally { f.cleanup(); }
});

test('check: one seat whose request fails is named, and the others are still checked', async () => {
  const f = fixture();
  try {
    await createSignins({ ...f, env: {}, project: PROJECT });
    const server = await startServer({ store: f.store, port: 0 });
    const url = `http://127.0.0.1:${server.address().port}`;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (u, opts) => (opts.headers.Authorization.endsWith(f.vault.TRACKER_TOKEN_RELAY)
      ? Promise.reject(new Error(`socket hang up for ${f.vault.TRACKER_TOKEN_RELAY}`)) : realFetch(u, opts));
    try {
      const r = await checkSignins({ url, seats: f.seats, env: f.vault });
      assert.equal(r.ok, false);
      const text = r.lines.join('\n');
      assert.match(text, /TRACKER_TOKEN_RELAY: WRONG\. GET \/me did not answer usably: socket hang up for \[token\]/);
      assert.match(text, /TRACKER_TOKEN_LOOP_REVIEW: GET \/me answers "loop-review"/);
      assert.ok(!text.includes(f.vault.TRACKER_TOKEN_RELAY));
    } finally {
      globalThis.fetch = realFetch;
      await new Promise((res) => server.close(res));
    }
  } finally { f.cleanup(); }
});

/** A tracker serving a database of its own, with every seat made: the real one, elsewhere. */
async function realTracker() {
  const real = fixture();
  await createSignins({ ...real, env: {}, project: PROJECT });
  const server = await startServer({ store: real.store, port: 0 });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { ...real, url, async close() { await new Promise((res) => server.close(res)); real.cleanup(); } };
}

test('create on a database the tracker does not serve writes nothing to Doppler, revokes the token, and says so', async () => {
  const real = await realTracker();
  const stray = fixture();
  try {
    const written = [];
    const r = await createSignins({
      ...stray, env: {}, project: PROJECT,
      setSecret: (name) => { written.push(name); },
      proveToken: (token) => whoIs(real.url, token),
      tracker: { url: real.url, home: 'mini.test' },
    });
    assert.equal(r.ok, false);
    assert.deepEqual(written, []);
    const text = r.lines.join('\n');
    const first = TRACKER_SEATS[0].secret;
    assert.match(text, new RegExp(`${first}: REFUSED\\. .*the tracker at ${real.url} answered 401, not .*this database is not the one the tracker at ${real.url} serves\\. Run this on the machine the tracker runs on \\(mini\\.test\\)\\. Nothing was written to Doppler; the new token is revoked\\.`));
    for (const seat of TRACKER_SEATS.slice(1)) assert.match(text, new RegExp(`${seat.secret}: NOT tried`));
    assert.equal(stray.store.getProject('alpha'), null);
  } finally { await real.close(); stray.cleanup(); }
});

test('the token create revokes no longer signs in to the stray database', async () => {
  const stray = fixture();
  try {
    let issued = null;
    const r = await createSignins({
      ...stray, env: {}, project: PROJECT,
      setSecret: () => { throw new Error('must not be called'); },
      proveToken: async (token) => { issued = token; return { status: 401, me: null }; },
    });
    assert.equal(r.ok, false);
    assert.ok(issued);
    assert.equal(stray.store.actorForToken(issued), null);
    assert.ok(!r.lines.join('\n').includes(issued));
  } finally { stray.cleanup(); }
});

test('create with no tracker answering at all writes nothing, and never prints the token', async () => {
  const stray = fixture();
  try {
    const r = await createSignins({
      ...stray, env: {}, project: PROJECT,
      setSecret: () => { throw new Error('must not be called'); },
      proveToken: (token) => whoIs('http://127.0.0.1:1', token),
      tracker: { url: 'http://127.0.0.1:1', home: 'mini.test' },
    });
    assert.equal(r.ok, false);
    assert.match(r.lines.join('\n'), /REFUSED\. .*the tracker at http:\/\/127\.0\.0\.1:1 did not answer usably/);
    assert.deepEqual(stray.vault, {});
  } finally { stray.cleanup(); }
});

test('a Doppler token that signs in only to this database, not at the tracker, is WRONG and nothing changes', async () => {
  const real = await realTracker();
  const stray = fixture();
  try {
    await createSignins({ ...stray, env: {}, project: PROJECT });
    const held = { ...stray.vault };
    const written = [];
    const r = await createSignins({
      ...stray, env: held, project: PROJECT,
      setSecret: (name) => { written.push(name); },
      proveToken: (token) => whoIs(real.url, token),
      tracker: { url: real.url, home: 'mini.test' },
    });
    assert.equal(r.ok, false);
    assert.deepEqual(written, []);
    assert.match(r.lines.join('\n'), new RegExp(`${TRACKER_SEATS[0].secret}: WRONG\\. Doppler's token signs in as .* in this database, but the tracker at ${real.url} answered 401`));
    for (const [name, token] of Object.entries(held)) assert.ok(stray.store.actorForToken(token), name);
  } finally { await real.close(); stray.cleanup(); }
});

test('check: a token that signs in only to a local database, not at the tracker, is WRONG', async () => {
  const real = await realTracker();
  const stray = fixture();
  try {
    await createSignins({ ...stray, env: {}, project: PROJECT });
    const r = await checkSignins({ url: real.url, seats: stray.seats, env: stray.vault });
    assert.equal(r.ok, false);
    for (const seat of TRACKER_SEATS) assert.match(r.lines.join('\n'), new RegExp(`${seat.secret}: WRONG\\. GET /me answered 401`));
    const good = await checkSignins({ url: real.url, seats: real.seats, env: real.vault });
    assert.equal(good.ok, true, good.lines.join('\n'));
  } finally { await real.close(); stray.cleanup(); }
});

test('the command: create with no database file and no --new-database makes no file and names the path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signins-cli-'));
  try {
    const db = join(dir, 'nested', 'tracker.db');
    const script = fileURLToPath(new URL('./signins.mjs', import.meta.url));
    const r = spawnSync(process.execPath, ['--no-warnings', script, 'create', '--name', 'Alpha'], {
      encoding: 'utf8',
      // A fake Doppler project name only gets past the "under doppler run" guard; nothing reaches Doppler.
      env: { PATH: process.env.PATH, HOME: dir, TRACKER_DB: db, DOPPLER_PROJECT: 'not-real', TRACKER_URL: 'http://127.0.0.1:1' },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`There is no tracker database at ${db.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(r.stderr, /--new-database/);
    assert.equal(existsSync(db), false);
    assert.equal(existsSync(join(dir, 'nested')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
