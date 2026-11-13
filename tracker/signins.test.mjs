import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { startServer } from './server.mjs';
import { createSignins, checkSignins, seatsFor, seatsForConfig, whoIs, trackerAddress } from './signins.mjs';
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
      assert.match(text, /TRACKER_TOKEN_RELAY: WRONG\. GET \/me did not answer \(socket hang up for \[token\]\)/);
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
    const text = r.lines.join('\n');
    assert.match(text, /REFUSED\. .*the tracker at http:\/\/127\.0\.0\.1:1 did not answer \(.*\), so no token can be proven\. Run it again once the tracker is up\. Nothing was written to Doppler; the new token is revoked\./);
    // A tracker that is down says nothing about which database this is.
    assert.doesNotMatch(text, /this database is not/);
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

test('a stray database with every good token in Doppler: says the database is wrong, never to delete them, and stops', async () => {
  const real = await realTracker();
  const stray = fixture();
  try {
    const written = [];
    const r = await createSignins({
      ...stray, env: { ...real.vault }, project: PROJECT,
      setSecret: (name) => { written.push(name); },
      proveToken: (token) => whoIs(real.url, token),
      tracker: { url: real.url, home: 'mini.test' },
    });
    assert.equal(r.ok, false);
    assert.deepEqual(written, []);
    const text = r.lines.join('\n');
    assert.match(text, new RegExp(`${TRACKER_SEATS[0].secret}: WRONG\\. Doppler's token signs in as .* at the tracker at ${real.url}, so it is good, but not in this database: this database is not the one the tracker at ${real.url} serves\\. Run this on the machine the tracker runs on \\(mini\\.test\\)\\. Nothing changed; keep that secret\\.`));
    for (const seat of TRACKER_SEATS.slice(1)) assert.match(text, new RegExp(`${seat.secret}: NOT tried`));
    assert.doesNotMatch(text, /remove that secret/);
    assert.equal(stray.store.actorsNamed({ kind: 'machine', name: 'relay' }).length, 0, 'no actor made here');
    for (const [name, token] of Object.entries(real.vault)) assert.ok(real.store.actorForToken(token), name);
  } finally { await real.close(); stray.cleanup(); }
});

test('a held token the tracker cannot be asked about is NOT checked, and nothing changes', async () => {
  const f = fixture();
  try {
    await createSignins({ ...f, env: {}, project: PROJECT });
    const before = { ...f.vault };
    for (const proveToken of [async () => ({ status: 503, me: null }), async () => { throw new Error('connect ECONNREFUSED'); }]) {
      const r = await createSignins({ ...f, env: { ...before }, project: PROJECT, proveToken });
      assert.equal(r.ok, false);
      const text = r.lines.join('\n');
      assert.match(text, new RegExp(`${TRACKER_SEATS[0].secret}: NOT checked: the tracker at http://tracker\\.test did not answer.*Run it again once the tracker is up\\. Nothing changed\\.`));
      assert.doesNotMatch(text, /this database is not|remove that secret/);
      assert.deepEqual(f.vault, before);
    }
  } finally { f.cleanup(); }
});

test('a token dead both here and at the tracker is stale: REFUSED, the line says to remove it, and the other seats are still checked', async () => {
  const f = fixture();
  try {
    await createSignins({ ...f, env: {}, project: PROJECT });
    const r = await createSignins({ ...f, env: { ...f.vault, TRACKER_TOKEN_RELAY: 'not-a-token' }, project: PROJECT });
    const text = r.lines.join('\n');
    assert.match(text, /TRACKER_TOKEN_RELAY: REFUSED\. Doppler holds a token that signs in as "relay" neither here nor at the tracker at http:\/\/tracker\.test \(it answered 401.*remove that secret in Doppler/);
    assert.doesNotMatch(text, /NOT tried/);
  } finally { f.cleanup(); }
});

test('the tracker is asked at the filed network name, or at 127.0.0.1 on its own machine; never at a dev tracker elsewhere', () => {
  const filed = 'http://mac-mini.local:4180';
  assert.deepEqual(trackerAddress(filed, ['Mac-Mini.local', 'mac-mini']), { url: 'http://127.0.0.1:4180', home: 'mac-mini.local', onHome: true });
  assert.deepEqual(trackerAddress(filed, ['danes-laptop.local', 'danes-laptop']), { url: 'http://mac-mini.local:4180', home: 'mac-mini.local', onHome: false });
  assert.equal(trackerAddress('http://localhost:9000/', ['anything']).url, 'http://127.0.0.1:9000');
  assert.equal(trackerAddress('https://tracker.example.com', ['laptop']).url, 'https://tracker.example.com');
});

const HOME = { operatorName: 'Dana', projectSlug: 'alpha', trackerPort: 4180 };
const GUEST = { operatorName: 'Dana', projectSlug: 'beta', trackerPort: null };

test('the project that runs the tracker keeps the bare seats; another project gets machine seats named for it, and no operator seat', () => {
  const home = seatsForConfig(HOME);
  assert.equal(home.guest, false);
  assert.deepEqual(home.seats, seatsFor('Dana'));
  const guest = seatsForConfig(GUEST);
  assert.equal(guest.guest, true);
  assert.deepEqual(guest.seats.map((s) => [s.secret, s.kind, s.name]), TRACKER_SEATS.filter((s) => s.kind === 'machine').map((s) => [s.secret, 'machine', `beta ${s.name}`]));
  // The door still finds a guest's hand-run seat by its secret.
  assert.deepEqual(guest.seats.filter((s) => s.handRun).map((s) => s.secret), ['TRACKER_TOKEN_HAND_RUN']);
});

test('a lane the project config names in projectLanes gets one more machine seat, named like the others; the built-in seats do not change', () => {
  const lanes = { projectLanes: ['loop-handoff'] };
  const home = seatsForConfig({ ...HOME, ...lanes });
  assert.deepEqual(home.seats.slice(0, -1), seatsForConfig(HOME).seats);
  assert.deepEqual(home.seats.at(-1).secret, 'TRACKER_TOKEN_LOOP_HANDOFF');
  assert.deepEqual([home.seats.at(-1).kind, home.seats.at(-1).name], ['machine', 'loop-handoff']);
  const guest = seatsForConfig({ ...GUEST, ...lanes });
  assert.deepEqual(guest.seats.slice(0, -1), seatsForConfig(GUEST).seats);
  assert.deepEqual([guest.seats.at(-1).secret, guest.seats.at(-1).name], ['TRACKER_TOKEN_LOOP_HANDOFF', 'beta loop-handoff']);
  assert.ok(!seatsForConfig(GUEST).seats.some((s) => s.secret === 'TRACKER_TOKEN_LOOP_HANDOFF'), 'a lane not named has no seat');
});

test('create makes a named lane its sign-in and stores it in Doppler, read back; check then proves it', async () => {
  const f = fixture();
  try {
    const seats = seatsForConfig({ ...HOME, projectLanes: ['loop-handoff'] }).seats;
    const r = await createSignins({ ...f, seats, env: {}, project: PROJECT });
    assert.ok(r.ok, r.lines.join('\n'));
    assert.match(r.lines.join('\n'), /TRACKER_TOKEN_LOOP_HANDOFF: actor \d+ \(machine, "loop-handoff"\) made/);
    assert.equal(f.store.actorForToken(f.vault.TRACKER_TOKEN_LOOP_HANDOFF).name, 'loop-handoff');
    const server = await startServer({ store: f.store, port: 0 });
    try {
      const ok = await checkSignins({ url: `http://127.0.0.1:${server.address().port}`, seats, env: f.vault });
      assert.ok(ok.ok, ok.lines.join('\n'));
      assert.match(ok.lines.join('\n'), /TRACKER_TOKEN_LOOP_HANDOFF: GET \/me answers "loop-handoff" \(machine/);
    } finally { await new Promise((res) => server.close(res)); }
  } finally { f.cleanup(); }
});

test('a second project\'s create leaves every token of the first signing in, and check names every seat of both', async () => {
  const f = fixture();
  try {
    const first = await createSignins({ ...f, seats: seatsForConfig(HOME).seats, env: {}, project: PROJECT });
    assert.equal(first.ok, true, first.lines.join('\n'));
    const homeVault = { ...f.vault };

    // The second project's own Doppler project: empty, a separate vault.
    const guestVault = {};
    const second = await createSignins({
      ...f, seats: seatsForConfig(GUEST).seats, guest: true, env: {}, operatorName: 'Dana',
      project: { slug: 'beta', name: 'Beta', prefix: 'BE' },
      setSecret: (name, value) => { guestVault[name] = value; },
      getSecret: (name) => guestVault[name],
    });
    assert.equal(second.ok, true, second.lines.join('\n'));
    assert.deepEqual(f.vault, homeVault, 'nothing written to the first project\'s Doppler');
    assert.deepEqual(Object.keys(guestVault).sort(), TRACKER_SEATS.filter((s) => s.kind === 'machine').map((s) => s.secret).sort());
    assert.match(second.lines.join('\n'), /TRACKER_TOKEN_LOOP_BUILD: actor \d+ \(machine, "beta loop-build"\) made/);
    for (const [name, token] of Object.entries(homeVault)) assert.ok(f.store.actorForToken(token), `${name} still signs in`);
    // Both projects have the one operator; the guest never issued the operator a token.
    const operator = f.store.actorForToken(homeVault.TRACKER_TOKEN_OPERATOR);
    assert.equal(f.store.getProject('beta').operator, operator.id);
    assert.equal(f.store.actorsNamed({ kind: 'human', name: 'Dana' }).length, 1);

    const server = await startServer({ store: f.store, port: 0 });
    try {
      const url = `http://127.0.0.1:${server.address().port}`;
      const home = await checkSignins({ url, seats: seatsForConfig(HOME).seats, env: homeVault });
      assert.equal(home.ok, true, home.lines.join('\n'));
      assert.match(home.lines.join('\n'), /TRACKER_TOKEN_LOOP_BUILD: GET \/me answers "loop-build"/);
      const guest = await checkSignins({ url, seats: seatsForConfig(GUEST).seats, env: guestVault });
      assert.equal(guest.ok, true, guest.lines.join('\n'));
      assert.match(guest.lines.join('\n'), /TRACKER_TOKEN_LOOP_BUILD: GET \/me answers "beta loop-build"/);
      // The first project's tokens are not the second's seats.
      const crossed = await checkSignins({ url, seats: seatsForConfig(GUEST).seats, env: homeVault });
      assert.equal(crossed.ok, false);
    } finally {
      await new Promise((res) => server.close(res));
    }

    // Run again, with the guest's secrets lost: only the guest's actors get new tokens.
    const again = await createSignins({
      ...f, seats: seatsForConfig(GUEST).seats, guest: true, env: {}, operatorName: 'Dana',
      project: { slug: 'beta', name: 'Beta', prefix: 'BE' },
      setSecret: (name, value) => { guestVault[name] = value; },
      getSecret: (name) => guestVault[name],
    });
    assert.equal(again.ok, true, again.lines.join('\n'));
    for (const [name, token] of Object.entries(homeVault)) assert.ok(f.store.actorForToken(token), `${name} still signs in after the rerun`);
  } finally { f.cleanup(); }
});

test('a project\'s live website gets its own sign-in (SP-279): create makes it under the project\'s name, check proves it, it files a ticket and comments on the bus, and a rerun leaves it alone', async () => {
  const f = fixture();
  try {
    // The app seat is a machine seat of its own: never the hand-run one, never the operator.
    const app = TRACKER_SEATS.filter((s) => s.app);
    assert.deepEqual(app.map((s) => [s.secret, s.kind, s.name, Boolean(s.handRun)]), [['TRACKER_TOKEN_APP', 'machine', 'app', false]]);
    assert.ok(EXPECTED_SECRETS.some((s) => s.name === 'TRACKER_TOKEN_APP' && !s.trackerHome), 'doctor asks every project for it');
    assert.ok(seatsForConfig(HOME).seats.some((s) => s.secret === 'TRACKER_TOKEN_APP' && s.name === 'app'));

    await createSignins({ ...f, seats: seatsForConfig(HOME).seats, env: {}, project: PROJECT });
    const operator = f.store.actorsNamed({ kind: 'human', name: 'Dana' })[0];
    const guestVault = {};
    const guest = {
      ...f, seats: seatsForConfig(GUEST).seats, guest: true, operatorName: 'Dana',
      project: { slug: 'beta', name: 'Beta', prefix: 'BE' },
      setSecret: (name, value) => { guestVault[name] = value; },
      getSecret: (name) => guestVault[name],
    };
    const made = await createSignins({ ...guest, env: {} });
    assert.equal(made.ok, true, made.lines.join('\n'));
    assert.match(made.lines.join('\n'), /TRACKER_TOKEN_APP: actor \d+ \(machine, "beta app"\) made; token stored in Doppler and read back\./);
    const token = guestVault.TRACKER_TOKEN_APP;
    assert.ok(token);
    for (const line of made.lines) assert.ok(!line.includes(token), line);
    f.store.createProject({ slug: 'beta-bus', name: 'Beta bus', prefix: 'BEBUS', operator: operator.id });
    const alarm = f.store.fileTicket({ project: 'beta-bus', name: 'Alarms', status: 'Queued', actor: operator.id });

    const server = await startServer({ store: f.store, port: 0 });
    try {
      const url = `http://127.0.0.1:${server.address().port}`;
      const checked = await checkSignins({ url, seats: seatsForConfig(GUEST).seats, env: guestVault });
      assert.equal(checked.ok, true, checked.lines.join('\n'));
      assert.match(checked.lines.join('\n'), /TRACKER_TOKEN_APP: GET \/me answers "beta app" \(machine, actor \d+\)\. OK/);
      const auth = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const bus = await fetch(`${url}/tickets/${alarm.key ?? alarm.id}`, { headers: auth });
      assert.equal(bus.status, 200);
      const filed = await fetch(`${url}/projects/beta/tickets`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'A client bug report', status: 'Requested' }) });
      assert.equal(filed.status, 201, await filed.clone().text());
      const ticket = await filed.json();
      assert.equal(ticket.project, 'beta');
      const said = await fetch(`${url}/tickets/${alarm.key ?? alarm.id}/comments`, { method: 'POST', headers: auth, body: JSON.stringify({ body: 'ALARM: AI spending is over the line' }) });
      assert.equal(said.status, 201, await said.clone().text());
      assert.equal((await said.json()).author, f.store.actorForToken(token).id);
    } finally {
      await new Promise((res) => server.close(res));
    }

    // Run again with the tokens in the environment, as doppler run gives them: the working app token stays.
    const again = await createSignins({ ...guest, env: { ...guestVault } });
    assert.equal(again.ok, true, again.lines.join('\n'));
    assert.match(again.lines.join('\n'), /TRACKER_TOKEN_APP: already signs in as "beta app" \(actor \d+\), left alone\./);
    assert.equal(guestVault.TRACKER_TOKEN_APP, token);
    assert.equal(f.store.actorForToken(token)?.name, 'beta app');
  } finally { f.cleanup(); }
});

test('a second project that wrongly keeps the bare seat names is refused before any token of the first is replaced', async () => {
  const f = fixture();
  try {
    await createSignins({ ...f, env: {}, project: PROJECT });
    const homeVault = { ...f.vault };
    const guestVault = {};
    const r = await createSignins({
      ...f, env: {}, project: { slug: 'beta', name: 'Beta', prefix: 'BE' },
      setSecret: (name, value) => { guestVault[name] = value; },
      getSecret: (name) => guestVault[name],
    });
    assert.equal(r.ok, false);
    assert.match(r.lines.join('\n'), /TRACKER_TOKEN_LOOP_BUILD: REFUSED\. Actor \d+ \("loop-build"\) already exists, this tracker also holds project "alpha", and this Doppler project holds no working operator sign-in.*Nothing changed/);
    assert.deepEqual(guestVault, {});
    for (const [name, token] of Object.entries(homeVault)) assert.ok(f.store.actorForToken(token), `${name} still signs in`);
    assert.equal(f.store.getProject('beta'), null);
  } finally { f.cleanup(); }
});

test('the same wrong config is refused when the second project\'s project was made on the page first', async () => {
  const f = fixture();
  try {
    await createSignins({ ...f, env: {}, project: PROJECT });
    const homeVault = { ...f.vault };
    // Dane makes the project on the tracker page before create runs for it.
    f.store.createProject({ slug: 'beta', name: 'Beta', prefix: 'BE' });
    const guestVault = {};
    const r = await createSignins({
      ...f, env: {}, project: { slug: 'beta', name: 'Beta', prefix: 'BE' },
      setSecret: (name, value) => { guestVault[name] = value; },
      getSecret: (name) => guestVault[name],
    });
    assert.equal(r.ok, false);
    for (const seat of TRACKER_SEATS) assert.match(r.lines.join('\n'), new RegExp(`${seat.secret}: REFUSED\\. Actor \\d+ .*already exists, this tracker also holds project "alpha"`));
    assert.deepEqual(guestVault, {});
    for (const [name, token] of Object.entries(homeVault)) assert.ok(f.store.actorForToken(token), `${name} still signs in`);
  } finally { f.cleanup(); }
});

test('the project that runs the tracker can still replace a lost token once another project is on it', async () => {
  const f = fixture();
  try {
    await createSignins({ ...f, env: {}, project: PROJECT });
    await createSignins({
      ...f, seats: seatsForConfig(GUEST).seats, guest: true, env: {}, operatorName: 'Dana',
      project: { slug: 'beta', name: 'Beta', prefix: 'BE' },
      setSecret: () => {}, getSecret: () => { throw new Error('not this vault'); },
    });
    const { TRACKER_TOKEN_RELAY: lost, ...held } = f.vault;
    const r = await createSignins({ ...f, env: held, project: PROJECT });
    assert.equal(r.ok, true, r.lines.join('\n'));
    assert.match(r.lines.join('\n'), /TRACKER_TOKEN_RELAY: actor \d+ \(machine, "relay"\) kept, given a new token/);
    assert.equal(f.store.actorForToken(lost), null, 'the lost token no longer signs in');
    assert.equal(f.store.actorForToken(f.vault.TRACKER_TOKEN_RELAY).name, 'relay');
    for (const [name, token] of Object.entries(held)) assert.ok(f.store.actorForToken(token), `${name} still signs in`);
  } finally { f.cleanup(); }
});

test('a second project that lost one token before its project exists gets it back on the retry, never refused', async () => {
  const f = fixture();
  try {
    await createSignins({ ...f, env: {}, project: PROJECT });
    const homeVault = { ...f.vault };
    const guestVault = {};
    const guestRun = (setSecret) => createSignins({
      ...f, seats: seatsForConfig(GUEST).seats, guest: true, env: { ...guestVault }, operatorName: 'Dana',
      project: { slug: 'beta', name: null, prefix: 'BE' },
      setSecret, getSecret: (name) => guestVault[name],
    });
    const first = await guestRun((name, value) => {
      if (name === 'TRACKER_TOKEN_RELAY') throw new Error('Doppler said no');
      guestVault[name] = value;
    });
    assert.equal(first.ok, false);
    assert.match(first.lines.join('\n'), /TRACKER_TOKEN_RELAY: FAILED/);
    assert.equal(f.store.getProject('beta'), null);
    const retry = await guestRun((name, value) => { guestVault[name] = value; });
    assert.doesNotMatch(retry.lines.join('\n'), /REFUSED/);
    assert.match(retry.lines.join('\n'), /TRACKER_TOKEN_RELAY: actor \d+ \(machine, "beta relay"\) kept, given a new token/);
    for (const [name, token] of Object.entries(guestVault)) assert.ok(f.store.actorForToken(token), `${name} signs in`);
    for (const [name, token] of Object.entries(homeVault)) assert.ok(f.store.actorForToken(token), `${name} still signs in`);
  } finally { f.cleanup(); }
});

test('a second project run before the operator exists makes its seats but not its project, and says why', async () => {
  const f = fixture();
  try {
    const r = await createSignins({ ...f, seats: seatsForConfig(GUEST).seats, guest: true, env: {}, operatorName: 'Dana', project: { slug: 'beta', name: 'Beta', prefix: 'BE' } });
    assert.equal(r.ok, false);
    assert.match(r.lines.join('\n'), /project "beta": NOT made, because nobody named "Dana" signs in to this tracker yet: run create for the project that runs the tracker first\./);
    assert.equal(f.store.getProject('beta'), null);
  } finally { f.cleanup(); }
});

test('the command: run under another project\'s Doppler project, it refuses and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signins-cli-'));
  try {
    const db = join(dir, 'tracker.db');
    openStore(db).close();
    const script = fileURLToPath(new URL('./signins.mjs', import.meta.url));
    const r = spawnSync(process.execPath, ['--no-warnings', script, 'create', '--name', 'Alpha'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: dir, TRACKER_DB: db, DOPPLER_PROJECT: 'someone-else', TRACKER_URL: 'http://127.0.0.1:1' },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /runs under Doppler project "someone-else", but the project config names "spirality".*Nothing was made or written/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a new project is made with githubRepo as its GitHub repository, read back', async () => {
  const f = fixture();
  try {
    const r = await createSignins({ ...f, env: {}, project: { ...PROJECT, repo: 'my-org/alpha' } });
    assert.equal(r.ok, true, r.lines.join('\n'));
    assert.equal(f.store.getProject('alpha').repo, 'my-org/alpha');
    assert.match(r.lines.join('\n'), /project "alpha": made, .*GitHub repository my-org\/alpha\./);
  } finally { f.cleanup(); }
});

test('an existing project with no repository has it filled in; one that already agrees is left alone', async () => {
  const f = fixture();
  try {
    await createSignins({ ...f, env: {}, project: PROJECT });
    assert.equal(f.store.getProject('alpha').repo, null);
    const filled = await createSignins({ ...f, env: { ...f.vault }, project: { ...PROJECT, repo: 'my-org/alpha' } });
    assert.equal(filled.ok, true, filled.lines.join('\n'));
    assert.equal(f.store.getProject('alpha').repo, 'my-org/alpha');
    assert.match(filled.lines.join('\n'), /project "alpha": GitHub repository was empty, now my-org\/alpha \(read back\)\./);

    // GitHub ignores case, so this is the same repository.
    const again = await createSignins({ ...f, env: { ...f.vault }, project: { ...PROJECT, repo: 'My-Org/Alpha' } });
    assert.equal(again.ok, true, again.lines.join('\n'));
    assert.equal(f.store.getProject('alpha').repo, 'my-org/alpha');
    assert.match(again.lines.join('\n'), /GitHub repository already my-org\/alpha/);
  } finally { f.cleanup(); }
});

test('an existing project with a different repository is refused, both shown, nothing written', async () => {
  const f = fixture();
  try {
    await createSignins({ ...f, env: {}, project: { ...PROJECT, repo: 'my-org/old' } });
    const r = await createSignins({ ...f, env: { ...f.vault }, project: { ...PROJECT, repo: 'my-org/alpha' } });
    assert.equal(r.ok, false);
    assert.match(r.lines.join('\n'), /project "alpha": REFUSED\. It records the GitHub repository my-org\/old, but githubRepo in the settings file is my-org\/alpha\. Nothing was written/);
    assert.equal(f.store.getProject('alpha').repo, 'my-org/old');
  } finally { f.cleanup(); }
});

test('a repository fill that does not read back says FAILED, never a success line', async () => {
  const f = fixture();
  try {
    await createSignins({ ...f, env: {}, project: PROJECT });
    // A store whose write goes nowhere: the read-back must catch it.
    const lost = Object.create(f.store);
    lost.updateProject = () => {};
    const r = await createSignins({ ...f, store: lost, env: { ...f.vault }, project: { ...PROJECT, repo: 'my-org/alpha' } });
    assert.equal(r.ok, false);
    assert.match(r.lines.join('\n'), /project "alpha": FAILED\. Its GitHub repository was written as my-org\/alpha, but reads back as \(none\)\./);
    assert.doesNotMatch(r.lines.join('\n'), /now my-org\/alpha/);

    const refused = Object.create(f.store);
    refused.updateProject = () => { throw new Error('disk full'); };
    const r2 = await createSignins({ ...f, store: refused, env: { ...f.vault }, project: { ...PROJECT, repo: 'my-org/alpha' } });
    assert.equal(r2.ok, false);
    assert.match(r2.lines.join('\n'), /FAILED\. Its GitHub repository could not be filled in with my-org\/alpha: disk full/);
  } finally { f.cleanup(); }
});

test('the command: --config reads a settings file outside the current folder; without it, a folder with none is named', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signins-cli-'));
  try {
    const here = join(dir, 'elsewhere');
    const away = join(dir, 'project');
    mkdirSync(here);
    mkdirSync(away);
    const config = JSON.parse(readFileSync(fileURLToPath(new URL('../spirality.project.json', import.meta.url)), 'utf8'));
    writeFileSync(join(away, 'spirality.project.json'), JSON.stringify({ ...config, dopplerProject: 'far-away-project' }));
    const db = join(dir, 'tracker.db');
    openStore(db).close();
    const script = fileURLToPath(new URL('./signins.mjs', import.meta.url));
    const env = { PATH: process.env.PATH, HOME: dir, TRACKER_DB: db, DOPPLER_PROJECT: 'someone-else', TRACKER_URL: 'http://127.0.0.1:1' };
    for (const command of ['create', 'check']) {
      const r = spawnSync(process.execPath, ['--no-warnings', script, command, '--config', join('..', 'project', 'spirality.project.json')], { encoding: 'utf8', cwd: here, env });
      assert.notEqual(r.status, 0);
      // The guard names the far file's Doppler project, so that file was the one read.
      assert.match(r.stderr, /but the project config names "far-away-project".*Nothing was made or written/, r.stderr);
    }
    const none = spawnSync(process.execPath, ['--no-warnings', script, 'create', '--name', 'Alpha'], { encoding: 'utf8', cwd: here, env });
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /no spirality\.project\.json found in .*Nothing was made or written\. Give --config/);
    assert.doesNotMatch(none.stderr, /at .*\.mjs:\d+/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
