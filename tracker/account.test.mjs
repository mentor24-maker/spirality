import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from './store.mjs';
import { sendSetupLink, setPasswordUrl, setupEmail } from './account.mjs';

const COMMAND = fileURLToPath(new URL('./account.mjs', import.meta.url));
const TRACKER = 'http://tracker.example:4180';

/** A fresh store with a person, a machine and a second person who already has an email; a fake mail service. */
function fixture({ refuse = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-account-'));
  const path = join(dir, 'tracker.db');
  const store = openStore(path);
  const person = store.createActor({ kind: 'human', name: 'Dane' });
  const machine = store.createActor({ kind: 'machine', name: 'Loop' });
  const other = store.createActor({ kind: 'human', name: 'Other' });
  store.setEmail(other.id, 'taken@example.com');
  const sent = [];
  const send = async (mail) => {
    if (refuse) throw new Error(refuse);
    sent.push(mail);
  };
  const run = (args) => sendSetupLink({ store, send, trackerUrl: TRACKER, productName: 'Spirality', ...args });
  const cleanup = () => { store.close(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, path, store, person, machine, other, sent, send, run, cleanup };
}

/** The link token inside an email's text. */
const tokenIn = (text) => new URL(/https?:\/\/\S+/.exec(text)[0]).searchParams.get('link');

test('a setup link goes out once, to that address, titled for the product, and opens the set-password page at the config\'s address', async () => {
  const f = fixture();
  try {
    const r = await f.run({ actor: f.person.id, email: ' Dane@Example.com ' });
    assert.deepEqual(r, { ok: true, line: 'sent to dane@example.com, good for 7 days' });
    assert.equal(f.sent.length, 1);
    const [mail] = f.sent;
    assert.equal(mail.to, 'dane@example.com');
    assert.equal(mail.subject, 'Set your Spirality password');
    const token = tokenIn(mail.text);
    assert.ok(mail.text.includes(setPasswordUrl(TRACKER, token)));
    // The emailed link is the real one: it sets this person's email and password, and keeps the actor.
    assert.equal(f.store.useLink({ token, password: 'a good long password' }).actor.id, f.person.id);
    assert.equal(f.store.emailOf(f.person.id), 'dane@example.com');
    // Never the token in what the command prints.
    assert.ok(!r.line.includes(token));
  } finally { f.cleanup(); }
});

test('refused, each with its reason and nothing sent: a machine, a taken email, no mail key, no tracker address, an unknown actor, a bad email', async () => {
  const f = fixture();
  try {
    const cases = [
      [{ actor: f.machine.id, email: 'loop@example.com' }, /is a machine/],
      [{ actor: f.person.id, email: 'TAKEN@example.com' }, /already belongs to another person/],
      [{ actor: f.person.id, email: 'dane@example.com', send: null }, /RESEND_API_KEY is not in Doppler/],
      [{ actor: f.person.id, email: 'dane@example.com', trackerUrl: null }, /no trackerUrl/],
      [{ actor: 999, email: 'dane@example.com' }, /no actor 999/],
      [{ actor: f.person.id, email: 'not an email' }, /not an email address/],
    ];
    for (const [args, why] of cases) {
      const r = await f.run(args);
      assert.equal(r.ok, false, JSON.stringify(args));
      assert.match(r.line, /^NOT sent: /);
      assert.match(r.line, why);
      assert.match(r.line, /Nothing was made or sent\.$/);
    }
    assert.equal(f.sent.length, 0);
    assert.equal(f.store.emailOf(f.person.id), null);
  } finally { f.cleanup(); }
});

test('a send the mail service refuses says so and leaves no usable link behind', async () => {
  const f = fixture({ refuse: 'Resend answered 403: only your own address' });
  try {
    let made = null;
    const store = new Proxy(f.store, {
      get(target, key) {
        if (key === 'makeLink') return (args) => { made = target.makeLink(args); return made; };
        const v = target[key];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const r = await sendSetupLink({ store, actor: f.person.id, email: 'dane@example.com', send: f.send, trackerUrl: TRACKER, productName: 'Spirality' });
    assert.equal(r.ok, false);
    assert.equal(r.line, 'NOT sent to dane@example.com: Resend answered 403: only your own address. The link was withdrawn, so nothing usable is left.');
    assert.ok(made, 'a link was made before the send');
    assert.throws(() => f.store.linkInfo(made.token), { code: 'unknown-link' });
    assert.throws(() => f.store.useLink({ token: made.token, password: 'a good long password' }), { code: 'unknown-link' });
    assert.ok(!r.line.includes(made.token));
  } finally { f.cleanup(); }
});

test('a mail error that echoes the link has the token cut out of the printed line', async () => {
  const f = fixture();
  try {
    const send = async ({ text }) => { throw new Error(`rejected body: ${text}`); };
    const r = await f.run({ actor: f.person.id, email: 'dane@example.com', send });
    assert.equal(r.ok, false);
    assert.match(r.line, /\[link\]/);
    assert.doesNotMatch(r.line, /link=[A-Za-z0-9_-]{20,}/);
  } finally { f.cleanup(); }
});

test('the email names the person, the link and how long it lasts, and nothing else of theirs', () => {
  const mail = setupEmail({ name: 'Dane', productName: 'Spirality', link: 'http://t.example/set-password?link=abc', days: 7 });
  assert.equal(mail.subject, 'Set your Spirality password');
  assert.match(mail.text, /^Hello Dane,/);
  assert.match(mail.text, /\nhttp:\/\/t\.example\/set-password\?link=abc\n/);
  assert.match(mail.text, /It works once, for the next 7 days\./);
  assert.equal(setPasswordUrl('http://t.example:4180/', 'a/b+c'), 'http://t.example:4180/set-password?link=a%2Fb%2Bc');
});

test('the command refuses a missing mail key with its reason, prints no token, and leaves no link', () => {
  const f = fixture();
  try {
    f.store.close();
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TRACKER_DB: f.path };
    const r = spawnSync(process.execPath, ['--no-warnings', COMMAND, 'setup-link', '--actor', String(f.person.id), '--email', 'dane@example.com'], { env, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.equal(r.stdout.trim(), 'NOT sent: RESEND_API_KEY is not in Doppler, so no email can go out. Nothing was made or sent.');
    const db = new DatabaseSync(f.path);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_links').get().n, 0);
      assert.equal(db.prepare('SELECT email FROM actors WHERE id = ?').get(f.person.id).email, null);
    } finally { db.close(); }
    const usage = spawnSync(process.execPath, ['--no-warnings', COMMAND, 'setup-link'], { env, encoding: 'utf8' });
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /usage/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
