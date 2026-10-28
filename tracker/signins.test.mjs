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
    assert.match(misread.lines.join('\n'), /TRACKER_TOKEN_OPERATOR: FAILED\..*not the one written/);
  } finally { f.cleanup(); }
});
