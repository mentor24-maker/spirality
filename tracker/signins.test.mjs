import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { startServer } from './server.mjs';
import { createSignins, checkSignins, seatsFor } from './signins.mjs';
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
    cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('every seat is an expected secret, so doctor reports each one; the operator takes the configured name', () => {
  const expected = new Set(EXPECTED_SECRETS.map((s) => s.name));
  for (const seat of TRACKER_SEATS) assert.ok(expected.has(seat.secret), seat.secret);
  const seats = seatsFor('Dana');
  assert.deepEqual(seats.filter((s) => s.kind === 'human').map((s) => s.name), ['Dana']);
  assert.ok(seats.every((s) => s.name));
});

test('create makes each actor and the project, stores every token, and GET /me then names each seat', async () => {
  const f = fixture();
  try {
    const r = createSignins({ ...f, env: {}, project: PROJECT });
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

test('create run again leaves working sign-ins alone and refuses to replace a token that is not that seat', () => {
  const f = fixture();
  try {
    createSignins({ ...f, env: {}, project: PROJECT });
    const before = { ...f.vault };
    const again = createSignins({ ...f, env: { ...before }, project: PROJECT });
    assert.equal(again.ok, true, again.lines.join('\n'));
    assert.deepEqual(f.vault, before);
    assert.match(again.lines.join('\n'), /project "alpha": already exists/);

    const wrong = createSignins({ ...f, env: { ...before, TRACKER_TOKEN_RELAY: 'not-a-token' }, project: PROJECT });
    assert.equal(wrong.ok, false);
    assert.match(wrong.lines.join('\n'), /TRACKER_TOKEN_RELAY: REFUSED/);
    assert.deepEqual(f.vault, before);
  } finally { f.cleanup(); }
});

test('a seat whose secret is gone keeps its actor and gets a new token; the old one stops signing in', () => {
  const f = fixture();
  try {
    createSignins({ ...f, env: {}, project: PROJECT });
    const old = f.vault.TRACKER_TOKEN_RELAY;
    const relay = f.store.actorForToken(old);
    const { TRACKER_TOKEN_RELAY: _gone, ...rest } = f.vault;
    const r = createSignins({ ...f, env: rest, project: PROJECT });
    assert.equal(r.ok, true, r.lines.join('\n'));
    assert.match(r.lines.join('\n'), new RegExp(`TRACKER_TOKEN_RELAY: actor ${relay.id} \\(machine, "relay"\\) kept, given a new token`));
    assert.notEqual(f.vault.TRACKER_TOKEN_RELAY, old);
    assert.equal(f.store.actorForToken(old), null);
    assert.equal(f.store.actorForToken(f.vault.TRACKER_TOKEN_RELAY).id, relay.id);
    assert.equal(f.store.actorsNamed({ kind: 'machine', name: 'relay' }).length, 1);
  } finally { f.cleanup(); }
});

test('a token that does not reach Doppler fails loudly, never prints the token, and the project waits for the operator', () => {
  const f = fixture();
  try {
    let leaked = null;
    const r = createSignins({
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

    const misread = createSignins({ ...f, env: { ...f.vault }, project: PROJECT, getSecret: () => 'something else' });
    assert.equal(misread.ok, false);
    assert.match(misread.lines.join('\n'), /TRACKER_TOKEN_OPERATOR: FAILED\..*written to Doppler but not confirmed: the value Doppler gives back is not the one written/);
    assert.doesNotMatch(misread.lines.join('\n'), /did not reach Doppler/);
  } finally { f.cleanup(); }
});

test('a project the store refuses (a bad or taken prefix) is named as NOT made, after the tokens are stored', () => {
  const f = fixture();
  try {
    const bad = createSignins({ ...f, env: {}, project: { ...PROJECT, prefix: 'al' } });
    assert.equal(bad.ok, false);
    assert.match(bad.lines.join('\n'), /project "alpha": NOT made: .*capital letters/);
    assert.equal(Object.keys(f.vault).length, TRACKER_SEATS.length);

    f.store.createProject({ slug: 'other', name: 'Other', prefix: 'AL' });
    const taken = createSignins({ ...f, env: { ...f.vault }, project: PROJECT });
    assert.equal(taken.ok, false);
    assert.match(taken.lines.join('\n'), /project "alpha": NOT made: .*already exists/);
  } finally { f.cleanup(); }
});

test('an existing project whose operator is not the one who signs in is called WRONG', () => {
  const f = fixture();
  try {
    const someone = f.store.createActor({ kind: 'human', name: 'Someone' });
    f.store.createProject({ ...PROJECT, operator: someone.id });
    const r = createSignins({ ...f, env: {}, project: PROJECT });
    assert.equal(r.ok, false);
    assert.match(r.lines.join('\n'), new RegExp(`project "alpha": WRONG\\. Its operator is actor ${someone.id}`));
  } finally { f.cleanup(); }
});

test('the operator is recorded under the import key once; a key held by another actor is called WRONG, not overwritten', () => {
  const f = fixture();
  const operatorImport = { source: 'clickup', sourceId: 'user:7' };
  try {
    const first = createSignins({ ...f, env: {}, project: PROJECT, operatorImport });
    assert.equal(first.ok, true, first.lines.join('\n'));
    const op = f.store.actorForToken(f.vault.TRACKER_TOKEN_OPERATOR);
    assert.match(first.lines.join('\n'), new RegExp(`clickup user:7 now maps to actor ${op.id}`));
    const again = createSignins({ ...f, env: { ...f.vault }, project: PROJECT, operatorImport });
    assert.match(again.lines.join('\n'), new RegExp(`clickup user:7 already maps to actor ${op.id}`));

    const stray = f.store.importActor({ source: 'clickup', sourceId: 'user:8', kind: 'human', name: 'Dana' });
    const clash = createSignins({ ...f, env: { ...f.vault }, project: PROJECT, operatorImport: { source: 'clickup', sourceId: 'user:8' } });
    assert.equal(clash.ok, false);
    assert.match(clash.lines.join('\n'), new RegExp(`WRONG\\. The history import already stands actor ${stray.id} for clickup user:8, not actor ${op.id}`));
    assert.equal(f.store.importedId({ source: 'clickup', kind: 'actor', sourceId: 'user:8' }), stray.id);
  } finally { f.cleanup(); }
});

test('check: one seat whose request fails is named, and the others are still checked', async () => {
  const f = fixture();
  try {
    createSignins({ ...f, env: {}, project: PROJECT });
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
