import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { startServer } from './server.mjs';
import {
  createNotifier, DEFAULT_FROM, handOverEmail, mailEnvFromDoppler, mailSettingsFromEnv, newestAsk, resendSender,
} from './notify.mjs';
import { pageUrlOf } from './server.mjs';
import { cardAsk, tabTitle } from './web/render.mjs';

const PAGE = 'http://tracker.example:8787/';

/** A card as `ask` leaves it on a ticket: rules, the label and the ask in bold runs. */
const CARD = [
  "**DANE'S WORDS — the instruction behind this ticket**",
  '```',
  'make it tell me',
  '```',
  "**WHAT'S GOING ON**",
  'The build is done and needs a choice.',
  `**${'#'.repeat(29)}**`,
  '**NEEDED FROM DANE: pick Resend or Postmark**',
  `**${'#'.repeat(29)}**`,
].join('\n');

/**
 * A store, an operator and a loop with tokens, one project with one ticket,
 * and a server whose notifier sends through a fake. `fail` makes the fake
 * throw while it is true. Every email the fake accepted is in `mail`, every
 * log line in `lines`.
 */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-notify-'));
  const store = openStore(join(dir, 'tracker.db'));
  const dane = store.createActor({ kind: 'human', name: 'Dane' });
  const loop = store.createActor({ kind: 'machine', name: 'Loop' });
  const tokens = [store.issueToken(dane.id), store.issueToken(loop.id)];
  const loopToken = tokens[1];
  store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL', operator: dane.id });
  const ticket = store.fileTicket({ project: 'alpha', actor: loop.id, name: 'Make the thing', status: 'building' });
  const mail = [];
  const lines = [];
  const fake = { fail: false };
  const send = async (message) => {
    if (fake.fail) throw new Error('the mail service answered 503');
    mail.push(message);
  };
  const log = (line) => lines.push(line);
  const notifier = createNotifier({ store, send, to: 'dane@example.com', pageUrl: PAGE, log });
  const server = await startServer({ store, port: 0, log, notifier });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${loopToken}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const answer = { status: res.status, body: await res.json() };
    // The email goes out after the answer; wait for it before looking.
    await notifier.settled();
    return answer;
  }
  /** What `ask` does through the door: the card first, then the move and the assignment. */
  async function ask(id, status = 'needs your input') {
    assert.equal((await call('POST', `/tickets/${id}/comments`, { body: CARD })).status, 201);
    return call('PATCH', `/tickets/${id}`, { status, assignee: dane.id });
  }
  async function cleanup() {
    await new Promise((r) => server.close(r));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return { store, dane, loop, tokens, ticket, mail, lines, fake, notifier, call, ask, cleanup };
}

test('one hand-over sends one email: ticket name, project, the card\'s ask, a link to the ticket page', async () => {
  const f = await fixture();
  try {
    const moved = await f.ask(f.ticket.id);
    assert.equal(moved.status, 200);
    assert.equal(f.mail.length, 1);
    const [email] = f.mail;
    assert.equal(email.to, 'dane@example.com');
    assert.equal(email.subject, 'Waiting on you: Make the thing');
    assert.match(email.text, /^Make the thing$/m);
    assert.match(email.text, /^Project: Alpha$/m);
    assert.match(email.text, /^Status: {2}Needs your input$/m);
    assert.match(email.text, /^Needed: {2}pick Resend or Postmark$/m);
    assert.match(email.text, /^Open it: http:\/\/tracker\.example:8787\/t\/AL-1$/m);
    assert.ok(f.lines.some((l) => l === 'hand-over email sent: AL-1 (needs your input).'));
  } finally { await f.cleanup(); }
});

test('never two emails for one hand-over: the same move again, a comment, another change all send nothing more', async () => {
  const f = await fixture();
  try {
    await f.ask(f.ticket.id);
    const again = await f.call('PATCH', `/tickets/${f.ticket.id}`, { status: 'needs your input', assignee: f.dane.id });
    assert.deepEqual(again.body.changed, []);
    await f.call('POST', `/tickets/${f.ticket.id}/comments`, { body: 'a note' });
    await f.call('PATCH', `/tickets/${f.ticket.id}`, { priority: 'high' });
    assert.equal(f.mail.length, 1);
    assert.deepEqual(f.notifier.pending(), []);
  } finally { await f.cleanup(); }
});

test('a move between machine statuses sends none', async () => {
  const f = await fixture();
  try {
    for (const status of ['in review', 'rework', 'queued', 'building', 'in review', 'live']) {
      assert.equal((await f.call('PATCH', `/tickets/${f.ticket.id}`, { status })).status, 200);
    }
    await f.call('POST', '/projects/alpha/tickets', { name: 'Another', status: 'queued' });
    assert.equal(f.mail.length, 0);
  } finally { await f.cleanup(); }
});

test('each hand-over is its own: Needs your input, then Ready to launch, sends two', async () => {
  const f = await fixture();
  try {
    await f.ask(f.ticket.id, 'needs your input');
    await f.ask(f.ticket.id, 'ready to launch');
    assert.deepEqual(f.mail.map((m) => /^Status: +(.*)$/m.exec(m.text)[1]), ['Needs your input', 'Ready to launch']);
  } finally { await f.cleanup(); }
});

test('a ticket filed straight into an operator status is a hand-over too', async () => {
  const f = await fixture();
  try {
    const filed = await f.call('POST', '/projects/alpha/tickets', { name: 'Filed for him', status: 'needs your input', assignee: f.dane.id });
    assert.equal(filed.status, 201);
    assert.equal(f.mail.length, 1);
    assert.match(f.mail[0].text, /^Needed: {2}\(no question card on the ticket/m);
  } finally { await f.cleanup(); }
});

test('a failed send does not fail the move; it is logged, kept, and sent once on the next change', async () => {
  const f = await fixture();
  try {
    f.fake.fail = true;
    const moved = await f.ask(f.ticket.id);
    assert.equal(moved.status, 200);
    assert.equal(moved.body.ticket.status, 'needs your input');
    assert.equal(f.store.getTicket(f.ticket.id).status, 'needs your input');
    assert.equal(f.mail.length, 0);
    assert.deepEqual(f.notifier.pending(), [`AL-1@${moved.body.ticket.version}`]);
    assert.ok(f.lines.some((l) => /^hand-over email NOT sent: AL-1 \(needs your input\), try 1: the mail service answered 503\./.test(l)));

    // Still failing: the next change tries again, and the write still succeeds.
    assert.equal((await f.call('POST', '/projects/alpha/tickets', { name: 'Other', status: 'queued' })).status, 201);
    assert.ok(f.lines.some((l) => /try 2:/.test(l)));

    f.fake.fail = false;
    await f.call('POST', '/tickets/AL-2/comments', { body: 'any change' });
    assert.equal(f.mail.length, 1);
    assert.equal(f.mail[0].subject, 'Waiting on you: Make the thing');
    assert.deepEqual(f.notifier.pending(), []);
    await f.call('PATCH', '/tickets/AL-2', { priority: 'low' });
    assert.equal(f.mail.length, 1);
  } finally { await f.cleanup(); }
});

test('a kept email is dropped once the ticket has left the operator\'s statuses', async () => {
  const f = await fixture();
  try {
    f.fake.fail = true;
    await f.ask(f.ticket.id);
    f.fake.fail = false;
    await f.call('PATCH', `/tickets/${f.ticket.id}`, { status: 'rework', assignee: null });
    assert.equal(f.mail.length, 0);
    assert.deepEqual(f.notifier.pending(), []);
    assert.ok(f.lines.some((l) => /hand-over email dropped: AL-1 is no longer waiting/.test(l)));
  } finally { await f.cleanup(); }
});

test('writes arriving together never send one hand-over twice', async () => {
  const f = await fixture();
  try {
    f.fake.fail = true;
    await f.ask(f.ticket.id);
    f.fake.fail = false;
    await Promise.all(Array.from({ length: 5 }, (_, i) => f.call('POST', `/tickets/${f.ticket.id}/comments`, { body: `note ${i}` })));
    assert.equal(f.mail.length, 1);
  } finally { await f.cleanup(); }
});

test('no token reaches an email or a log line', async () => {
  const f = await fixture();
  try {
    f.fake.fail = true;
    await f.ask(f.ticket.id);
    f.fake.fail = false;
    await f.ask(f.ticket.id, 'ready to launch');
    const everything = [...f.lines, ...f.mail.map((m) => JSON.stringify(m))].join('\n');
    assert.ok(f.mail.length >= 1);
    for (const token of f.tokens) assert.ok(!everything.includes(token));
  } finally { await f.cleanup(); }
});

test('with no mail service the notifier does nothing, and the server runs without one', async () => {
  const store = openStore(':memory:');
  try {
    const notifier = createNotifier({ store, send: null, to: 'x@example.com', pageUrl: PAGE });
    assert.equal(notifier.enabled, false);
    await notifier.afterWrite({ id: 'AL-1', status: 'needs your input', version: 2 }, ['status']);
    assert.deepEqual(notifier.pending(), []);
    const off = mailSettingsFromEnv({}, { pageUrl: PAGE });
    assert.equal(off.send, null);
    assert.match(off.why, /RESEND_API_KEY and TRACKER_NOTIFY_TO are not in Doppler, so the hand-over email is off/);
  } finally { store.close(); }
});

test('handOverEmail keeps a ticket name on one line in the subject and encodes the link', () => {
  const email = handOverEmail({
    ticket: { id: 'AL 7', name: 'Two\nlines\r\nBcc: someone@example.com', status: 'ready to launch' },
    projectName: 'Alpha',
    ask: 'say merge',
    pageUrl: 'https://t.example///',
  });
  assert.equal(email.subject, 'Waiting on you: Two lines Bcc: someone@example.com');
  assert.ok(!/[\r\n]/.test(email.subject));
  assert.match(email.text, /^Open it: https:\/\/t\.example\/t\/AL%207$/m);
});

test('newestAsk reads the newest card, in the posted form and the raw @@NEEDED form', () => {
  assert.equal(newestAsk([{ body: CARD }, { body: 'a plain note' }]), 'pick Resend or Postmark');
  assert.equal(newestAsk([{ body: CARD }, { body: '@@ASKED\nx\n@@NEEDED\nsay yes\n' }]), 'say yes');
  assert.equal(newestAsk([{ body: 'nothing here' }]), null);
  assert.equal(cardAsk('no card'), null);
});

test('tabTitle: (N) Tracker while N wait, the page\'s own title otherwise', () => {
  assert.equal(tabTitle(3, 'Waiting on you · Tracker'), '(3) Tracker');
  assert.equal(tabTitle(1, 'Some ticket · Tracker'), '(1) Tracker');
  assert.equal(tabTitle(0, 'Waiting on you · Tracker'), 'Waiting on you · Tracker');
  assert.equal(tabTitle(null, 'Sign in · Tracker'), 'Sign in · Tracker');
});

const KEY = 're_test_0123456789abcdef';

/** A stand-in for fetch: records each call and answers with `answer`. */
function fakeFetch(answer) {
  const calls = [];
  const doFetch = async (url, init) => {
    calls.push({ url, init });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, doFetch };
}

test('resendSender: one POST to Resend with the key as a bearer and the email as JSON', async () => {
  const { calls, doFetch } = fakeFetch(new Response('{"id":"x"}', { status: 200 }));
  const send = resendSender({ apiKey: KEY, fetch: doFetch });
  await send({ to: 'dane@example.com', subject: 'Waiting on you: X', text: 'body' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    from: DEFAULT_FROM, to: ['dane@example.com'], subject: 'Waiting on you: X', text: 'body',
  });
});

test('resendSender: a refusal or no answer throws with the reason, and never with the key', async () => {
  const refused = resendSender({
    apiKey: KEY,
    fetch: fakeFetch(new Response(JSON.stringify({ message: `API key ${KEY} is invalid` }), { status: 401 })).doFetch,
  });
  await assert.rejects(refused({ to: 'a@b', subject: 's', text: 't' }), (err) => {
    assert.match(err.message, /^Resend answered 401: API key \[key\] is invalid$/);
    return true;
  });
  const down = resendSender({ apiKey: KEY, fetch: fakeFetch(new Error('getaddrinfo ENOTFOUND')).doFetch });
  await assert.rejects(down({ to: 'a@b', subject: 's', text: 't' }), /Resend could not be reached: getaddrinfo ENOTFOUND/);
  const bare = resendSender({ apiKey: KEY, fetch: fakeFetch(new Response('oops', { status: 500 })).doFetch });
  await assert.rejects(bare({ to: 'a@b', subject: 's', text: 't' }), /^Error: Resend answered 500$/);
});

test('a Resend refusal through the notifier: the move stands, the log has the reason and no key', async () => {
  const store = openStore(':memory:');
  try {
    const dane = store.createActor({ kind: 'human', name: 'Dane' });
    const loop = store.createActor({ kind: 'machine', name: 'Loop' });
    store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL', operator: dane.id });
    const t = store.fileTicket({ project: 'alpha', actor: loop.id, name: 'X', status: 'building' });
    const moved = store.changeTicket(t.id, { actor: loop.id, status: 'needs your input', assignee: dane.id });
    const lines = [];
    const mail = mailSettingsFromEnv(
      { RESEND_API_KEY: KEY, TRACKER_NOTIFY_TO: 'dane@example.com' },
      { pageUrl: PAGE, fetch: fakeFetch(new Response(JSON.stringify({ message: `bad key ${KEY}` }), { status: 403 })).doFetch },
    );
    const notifier = createNotifier({ store, ...mail, log: (l) => lines.push(l) });
    await notifier.afterWrite(moved.ticket, moved.changed);
    assert.equal(store.getTicket(t.id).status, 'needs your input');
    assert.equal(notifier.pending().length, 1);
    assert.match(lines.join('\n'), /NOT sent: AL-1 .*Resend answered 403: bad key \[key\]/);
    assert.ok(!lines.join('\n').includes(KEY));
  } finally { store.close(); }
});

test('mailSettingsFromEnv: both names make a Resend sender; one missing, or no address for the link, keeps it off', () => {
  const on = mailSettingsFromEnv({ RESEND_API_KEY: KEY, TRACKER_NOTIFY_TO: 'dane@example.com' }, { pageUrl: PAGE });
  assert.equal(typeof on.send, 'function');
  assert.equal(on.to, 'dane@example.com');
  assert.equal(on.pageUrl, PAGE);
  assert.ok(!JSON.stringify(on).includes(KEY), 'the key stays inside the sender');
  assert.match(mailSettingsFromEnv({ RESEND_API_KEY: KEY }, { pageUrl: PAGE }).why, /^TRACKER_NOTIFY_TO is not in Doppler/);
  assert.match(mailSettingsFromEnv({ RESEND_API_KEY: KEY, TRACKER_NOTIFY_TO: 'd@e' }).why, /address is unknown/);
});

test('mailEnvFromDoppler keeps only the mail names, and a failed read says so without values', async () => {
  const seen = [];
  const run = async (cmd, args) => {
    seen.push([cmd, ...args]);
    return { stdout: JSON.stringify({ CLICKUP_API_TOKEN: 'pk_other', RESEND_API_KEY: KEY, TRACKER_NOTIFY_TO: 'd@e' }) };
  };
  const { env } = await mailEnvFromDoppler({ project: 'proj', config: 'dev', run });
  assert.deepEqual(env, { RESEND_API_KEY: KEY, TRACKER_NOTIFY_TO: 'd@e' });
  assert.deepEqual(seen[0].slice(0, 3), ['doppler', 'secrets', 'download']);
  assert.ok(seen[0].includes('proj') && seen[0].includes('dev'));
  const failed = await mailEnvFromDoppler({
    project: 'proj', config: 'dev', run: async () => { throw Object.assign(new Error('boom'), { code: 'ENOENT' }); },
  });
  assert.deepEqual(failed, { error: 'could not read Doppler proj/dev (ENOENT)' });
});

test('pageUrlOf: the configured trackerUrl, else this machine by name on the port', () => {
  assert.equal(pageUrlOf({ trackerUrl: 'http://mini.local:4180', host: '0.0.0.0', port: 4180 }), 'http://mini.local:4180');
  assert.equal(pageUrlOf({ host: '127.0.0.1', port: 4180 }), 'http://127.0.0.1:4180');
  assert.match(pageUrlOf({ host: '0.0.0.0', port: 4180 }), /^http:\/\/[^/]+:4180$/);
  assert.ok(!pageUrlOf({ host: '0.0.0.0', port: 4180 }).includes('0.0.0.0'));
});
