import test from 'node:test';
import assert from 'node:assert/strict';
import { findSecrets } from './secretScan.mjs';

// Fakes are assembled at run time so this file never trips the scan itself.
const fakeClickUp = ['pk', '12345678', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'].join('_');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.${'s'.repeat(43)}`;

test('a .env file is caught wherever it sits; .envrc-like names and docs are not', () => {
  for (const p of ['.env', '.env.local', 'app/.env.production']) assert.notEqual(findSecrets(p, '').length, 0, p);
  for (const p of ['.envrc', 'docs/env.md', 'environment.ts', 'my.env.ts']) assert.deepEqual(findSecrets(p, ''), [], p);
});

test('a ClickUp pk_ token is caught, with its line number', () => {
  const hits = findSecrets('notes.md', `first line\ntoken = ${fakeClickUp}\n`);
  assert.deepEqual(hits, ['line 2: looks like a ClickUp pk_ token']);
});

test('mentioning pk_ in prose is not a token', () => {
  assert.deepEqual(findSecrets('CLAUDE.md', 'a ClickUp `pk_` token lives in Doppler; pk_123 is short'), []);
});

test('a Supabase service-role JWT is caught; the public anon JWT is not', () => {
  assert.equal(findSecrets('a.ts', `const k = "${jwt({ role: 'service_role', ref: 'x' })}";`).length, 1);
  assert.deepEqual(findSecrets('a.ts', `const k = "${jwt({ role: 'anon', ref: 'x' })}";`), []);
});

test('a Supabase sb_secret_ key is caught', () => {
  const key = ['sb', 'secret', 'abcdefghijklmnopqrstuv'].join('_');
  assert.equal(findSecrets('a.ts', key).length, 1);
});
