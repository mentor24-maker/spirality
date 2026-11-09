import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { startServer } from './server.mjs';
import {
  createNotifier, DEFAULT_FROM, handOverEmail, handOverText, imessageSender, mailEnvFromDoppler, mailSettingsFromEnv,
  newestAsk, osascriptArgs, resendSender, SEND_SCRIPT, TEXT_ASK_LIMIT, textSettings,
} from './notify.mjs';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
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
    assert.ok(f.lines.some((l) => l === 'hand-over email sent: AL-1 (needs your input) to TRACKER_NOTIFY_TO.'), f.lines.join('\n'));
  } finally { await f.cleanup(); }
});

test("a project with an alert email gets its hand-over there; the log names which address, never the address", async () => {
  const f = await fixture();
  try {
    f.store.updateProject('alpha', { alertEmail: 'alpha-alerts@example.com' });
    const moved = await f.ask(f.ticket.id);
    assert.equal(moved.status, 200);
    assert.equal(f.mail.length, 1);
    assert.equal(f.mail[0].to, 'alpha-alerts@example.com');
    assert.ok(f.lines.some((l) => l === "hand-over email sent: AL-1 (needs your input) to the project's alert email."), f.lines.join('\n'));
    assert.ok(!f.lines.join('\n').includes('@example.com'), 'no address in the log');
  } finally { await f.cleanup(); }
});

test('a project whose alert email is cleared goes back to TRACKER_NOTIFY_TO', async () => {
  const f = await fixture();
  try {
    f.store.updateProject('alpha', { alertEmail: 'alpha-alerts@example.com' });
    f.store.updateProject('alpha', { alertEmail: '' });
    await f.ask(f.ticket.id);
    assert.deepEqual(f.mail.map((m) => m.to), ['dane@example.com']);
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
    assert.ok(f.lines.some((l) => /^hand-over email NOT sent: AL-1 \(needs your input\) to TRACKER_NOTIFY_TO, try 1: the mail service answered 503\./.test(l)));

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

// ---- The hand-over text (SP-114) ------------------------------------------

/** A made-up number in international form. It must never reach a log line. */
const PHONE = '+18015550123';

/**
 * A notifier with both channels, each through its own fake. `fake.mailFail`
 * and `fake.textFail` make one of them throw while true.
 */
async function bothFixture({ phone = PHONE, sendText = null } = {}) {
  const store = openStore(':memory:');
  const dane = store.createActor({ kind: 'human', name: 'Dane' });
  const loop = store.createActor({ kind: 'machine', name: 'Loop' });
  store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL', operator: dane.id, alertPhone: phone });
  const fake = { mailFail: false, textFail: false };
  const mail = [];
  const texts = [];
  const lines = [];
  /** The notifier's clock: `clock.t` moves only when a test moves it. */
  const clock = { t: 1_000_000 };
  const notifier = createNotifier({
    store, to: 'dane@example.com', pageUrl: PAGE, log: (l) => lines.push(l), now: () => clock.t,
    send: async (m) => { if (fake.mailFail) throw new Error('the mail service answered 503'); mail.push(m); },
    sendText: sendText ?? (async (t) => { if (fake.textFail) throw new Error('Messages refused it: not signed in'); texts.push(t); }),
  });
  const file = (name = 'Make the thing') => store.fileTicket({ project: 'alpha', actor: loop.id, name, status: 'building' });
  async function move(id, status, extra = {}) {
    const moved = store.changeTicket(id, { actor: loop.id, status, ...extra });
    await notifier.afterWrite(moved.ticket, moved.changed);
    return moved;
  }
  async function card(id, body = CARD) {
    store.postComment({ ticket: id, author: loop.id, body });
  }
  return { store, dane, loop, fake, mail, texts, lines, clock, notifier, file, move, card };
}

test('one hand-over sends one text to the project\'s alert phone: id, name, status, the ask, the link', async () => {
  const f = await bothFixture();
  const t = f.file();
  await f.card(t.id);
  await f.move(t.id, 'needs your input', { assignee: f.dane.id });
  assert.equal(f.texts.length, 1);
  assert.equal(f.texts[0].to, PHONE);
  assert.equal(f.texts[0].text, [
    'Waiting on you: AL-1 Make the thing',
    'Status: Needs your input',
    'Needed: pick Resend or Postmark',
    'http://tracker.example:8787/t/AL-1',
  ].join('\n'));
  assert.equal(f.mail.length, 1, 'the email still goes too');
  assert.ok(f.lines.includes("hand-over text sent: AL-1 (needs your input) to the project's alert phone."), f.lines.join('\n'));
  f.store.close();
});

test('never two texts for one hand-over: the same status again, a comment, another change send nothing more', async () => {
  const f = await bothFixture();
  const t = f.file();
  const moved = await f.move(t.id, 'ready to launch', { assignee: f.dane.id });
  await f.notifier.afterWrite(moved.ticket, moved.changed); // the same write heard twice
  await f.card(t.id);
  await f.notifier.afterWrite(null, []);
  await f.move(t.id, 'ready to launch', { priority: 'high' });
  assert.equal(f.texts.length, 1);
  await f.move(t.id, 'needs your input');
  assert.equal(f.texts.length, 2, 'a new hand-over is its own');
  f.store.close();
});

test('a move between machine statuses sends no text', async () => {
  const f = await bothFixture();
  const t = f.file();
  await f.move(t.id, 'in review');
  await f.move(t.id, 'rework');
  assert.equal(f.texts.length, 0);
  f.store.close();
});

test('a failed text never fails the move or the email; it is kept, waits a minute, and is sent once', async () => {
  const f = await bothFixture();
  const t = f.file();
  f.fake.textFail = true;
  const moved = await f.move(t.id, 'needs your input', { assignee: f.dane.id });
  assert.equal(moved.ticket.status, 'needs your input');
  assert.equal(f.mail.length, 1, 'the email went regardless');
  assert.equal(f.texts.length, 0);
  assert.deepEqual(f.notifier.pendingTexts(), [`AL-1@${moved.ticket.version}`]);
  assert.deepEqual(f.notifier.pending(), [], 'the email is not kept: it went');
  assert.ok(f.lines.some((l) => l === "hand-over text NOT sent: AL-1 (needs your input) to the project's alert phone, try 1: Messages refused it: not signed in. It is tried again in 1 minute(s), or at once on that ticket's next change."), f.lines.join('\n'));
  f.fake.textFail = false;
  await f.card(t.id);
  await f.notifier.afterWrite(null, []);
  assert.equal(f.texts.length, 0, 'not yet: a write to another ticket inside the minute does not retry it');
  f.clock.t += 60_000;
  await f.notifier.afterWrite(null, []);
  assert.equal(f.texts.length, 1);
  assert.equal(f.mail.length, 1, 'the retry of the text sends no second email');
  await f.notifier.afterWrite(null, []);
  assert.equal(f.texts.length, 1, 'never twice');
  f.store.close();
});

test('a failed email never stops or repeats the text', async () => {
  const f = await bothFixture();
  const t = f.file();
  f.fake.mailFail = true;
  await f.move(t.id, 'needs your input', { assignee: f.dane.id });
  assert.equal(f.texts.length, 1);
  assert.equal(f.notifier.pending().length, 1);
  f.fake.mailFail = false;
  await f.notifier.afterWrite(null, []);
  assert.equal(f.mail.length, 1);
  assert.equal(f.texts.length, 1, 'the email retry sends no second text');
  f.store.close();
});

test('an email that breaks before it is sent still lets the text go', async () => {
  const store = openStore(':memory:');
  const dane = store.createActor({ kind: 'human', name: 'Dane' });
  const loop = store.createActor({ kind: 'machine', name: 'Loop' });
  store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL', operator: dane.id, alertPhone: PHONE });
  const texts = [];
  const lines = [];
  // The email reads the comments first; that read breaks once.
  const brokenStore = Object.create(store);
  let calls = 0;
  brokenStore.listComments = (...a) => { calls += 1; if (calls === 1) throw new Error('disk gone'); return store.listComments(...a); };
  const notifier = createNotifier({
    store: brokenStore, to: 'x@example.com', pageUrl: PAGE, log: (l) => lines.push(l),
    send: async () => {}, sendText: async (t) => { texts.push(t); },
  });
  const t = store.fileTicket({ project: 'alpha', actor: loop.id, name: 'X', status: 'building' });
  const moved = store.changeTicket(t.id, { actor: loop.id, status: 'needs your input' });
  await notifier.afterWrite(moved.ticket, moved.changed);
  assert.equal(texts.length, 1, lines.join('\n'));
  store.close();
});

test('a hanging text never delays an email: a later hand-over\'s email goes while Messages is stuck', async () => {
  // Messages stuck on macOS's "allow control?" box: every send hangs until the test lets it go.
  const hung = [];
  const f = await bothFixture({ sendText: () => new Promise((resolve, reject) => { hung.push({ resolve, reject }); }) });
  const [a, b, c, d] = ['One', 'Two', 'Three', 'Four'].map((name) => f.file(name));
  for (const t of [a, b, c]) {
    const m = f.store.changeTicket(t.id, { actor: f.loop.id, status: 'needs your input' });
    f.notifier.afterWrite(m.ticket, m.changed);
  }
  for (let i = 0; i < 3; i += 1) { f.store.postComment({ ticket: a.id, author: f.loop.id, body: `note ${i}` }); f.notifier.afterWrite(null, []); }
  const moved = f.store.changeTicket(d.id, { actor: f.loop.id, status: 'ready to launch' });
  f.notifier.afterWrite(moved.ticket, moved.changed);
  await f.notifier.emailSettled();
  assert.equal(f.mail.length, 4, 'all four emails went, the fourth without waiting on any text');
  assert.equal(hung.length, 1, 'one text is being tried; the rest wait their turn in the text queue alone');
  // Messages gives up: each kept text fails once and then waits, rather than costing a try on every write.
  for (let n = 0; n < 4; n += 1) {
    while (!hung.length) await new Promise((r) => setImmediate(r));
    hung.shift().reject(new Error('Messages did not answer within 30 seconds'));
  }
  await f.notifier.settled();
  assert.equal(f.notifier.pendingTexts().length, 4);
  for (let i = 0; i < 5; i += 1) await f.notifier.afterWrite(null, []);
  assert.equal(hung.length, 0, 'writes inside the wait try no kept text again');
  f.store.close();
});

test('a failed text waits longer after each try, at most half an hour; its own ticket\'s change tries it at once', async () => {
  const f = await bothFixture();
  const t = f.file();
  f.fake.textFail = true;
  await f.move(t.id, 'needs your input');
  const tries = () => f.lines.filter((l) => l.startsWith('hand-over text NOT sent')).length;
  assert.equal(tries(), 1);
  f.clock.t += 59_000;
  await f.notifier.afterWrite(null, []);
  assert.equal(tries(), 1, 'not inside the first minute');
  f.clock.t += 1_000;
  await f.notifier.afterWrite(null, []);
  assert.equal(tries(), 2);
  assert.match(f.lines.at(-1), /tried again in 2 minute\(s\)/);
  for (let i = 0; i < 8; i += 1) { f.clock.t += 60 * 60_000; await f.notifier.afterWrite(null, []); }
  assert.match(f.lines.at(-1), /tried again in 30 minute\(s\)/, 'the wait stops growing at half an hour');
  const before = tries();
  await f.move(t.id, 'needs your input', { priority: 'high' });
  assert.equal(tries(), before + 1, 'a change to the ticket itself tries its text at once');
  f.fake.textFail = false;
  await f.move(t.id, 'needs your input', { priority: 'low' });
  assert.equal(f.texts.length, 1);
  f.store.close();
});

test('the text links to its own address, the one that opens on a phone, not the email\'s', async () => {
  const store = openStore(':memory:');
  const dane = store.createActor({ kind: 'human', name: 'Dane' });
  const loop = store.createActor({ kind: 'machine', name: 'Loop' });
  store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL', operator: dane.id, alertPhone: PHONE });
  const mail = [];
  const texts = [];
  const notifier = createNotifier({
    store, to: 'x@example.com', pageUrl: 'http://127.0.0.1:4180', textPageUrl: 'http://mac-mini.local:4180',
    send: async (m) => { mail.push(m); }, sendText: async (t) => { texts.push(t); },
  });
  const t = store.fileTicket({ project: 'alpha', actor: loop.id, name: 'X', status: 'building' });
  const moved = store.changeTicket(t.id, { actor: loop.id, status: 'needs your input' });
  await notifier.afterWrite(moved.ticket, moved.changed);
  assert.match(texts[0].text, /\nhttp:\/\/mac-mini\.local:4180\/t\/AL-1$/);
  assert.match(mail[0].text, /http:\/\/127\.0\.0\.1:4180\/t\/AL-1/, 'the email is unchanged');
  store.close();
});

test('a project with no alert phone gets no text, said once in the log until it has one', async () => {
  const f = await bothFixture({ phone: null });
  const a = f.file('One');
  const b = f.file('Two');
  await f.move(a.id, 'needs your input');
  await f.move(b.id, 'needs your input');
  assert.equal(f.texts.length, 0);
  assert.equal(f.mail.length, 2, 'the email is unaffected');
  assert.deepEqual(f.notifier.pendingTexts(), [], 'nothing kept to retry forever');
  const off = f.lines.filter((l) => l.startsWith('hand-over text: off for project "alpha"'));
  assert.equal(off.length, 1, f.lines.join('\n'));
  f.store.updateProject('alpha', { alertPhone: PHONE });
  const c = f.file('Three');
  await f.move(c.id, 'ready to launch');
  assert.equal(f.texts.length, 1);
  assert.equal(f.texts[0].to, PHONE);
  f.store.close();
});

test('no phone number reaches a log line, sent or failed', async () => {
  const f = await bothFixture();
  const t = f.file();
  f.fake.textFail = true;
  await f.move(t.id, 'needs your input');
  f.fake.textFail = false;
  f.clock.t += 60_000;
  await f.notifier.afterWrite(null, []);
  assert.equal(f.texts.length, 1);
  const log = f.lines.join('\n');
  assert.ok(!log.includes(PHONE) && !log.includes('8015550123'), log);
  f.store.close();
});

test('with texts on and the email off, the notifier still texts', async () => {
  const store = openStore(':memory:');
  const dane = store.createActor({ kind: 'human', name: 'Dane' });
  const loop = store.createActor({ kind: 'machine', name: 'Loop' });
  store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL', operator: dane.id, alertPhone: PHONE });
  const texts = [];
  const notifier = createNotifier({ store, send: null, pageUrl: PAGE, sendText: async (t) => { texts.push(t); } });
  assert.equal(notifier.enabled, true);
  const t = store.fileTicket({ project: 'alpha', actor: loop.id, name: 'X', status: 'building' });
  const moved = store.changeTicket(t.id, { actor: loop.id, status: 'needs your input' });
  await notifier.afterWrite(moved.ticket, moved.changed);
  assert.equal(texts.length, 1);
  assert.deepEqual(notifier.pending(), []);
  store.close();
});

test('handOverText: the ask cut to about 300 characters, the name kept on one line, the link encoded', () => {
  const long = 'word '.repeat(200);
  const text = handOverText({ ticket: { id: 'AL 1', name: 'Two\nlines', status: 'ready to launch' }, ask: long, pageUrl: 'http://x:1/' });
  const [first, status, needed, link] = text.split('\n');
  assert.equal(first, 'Waiting on you: AL 1 Two lines');
  assert.equal(status, 'Status: Ready to launch');
  assert.ok(needed.length <= 'Needed: '.length + TEXT_ASK_LIMIT, needed.length);
  assert.ok(needed.endsWith('…'));
  assert.equal(link, 'http://x:1/t/AL%201');
  assert.match(handOverText({ ticket: { id: 'A', name: 'n', status: 'needs your input' }, ask: null, pageUrl: 'http://x' }), /no question card/);
});

/** A ticket name built to break out of an AppleScript string, were it ever pasted into one. */
const HOSTILE = 'Fix "quotes"; do shell script "touch /tmp/pwned"; "';

test('osascriptArgs: the script is fixed, and the number and text come after it as plain arguments', () => {
  const text = handOverText({ ticket: { id: 'AL-1', name: HOSTILE, status: 'needs your input' }, ask: HOSTILE, pageUrl: PAGE });
  const args = osascriptArgs({ to: PHONE, text });
  const script = SEND_SCRIPT.flatMap((line) => ['-e', line]);
  assert.deepEqual(args.slice(0, script.length), script, 'the script is the same whatever the ticket says');
  assert.deepEqual(args.slice(script.length), [PHONE, text]);
  assert.ok(!SEND_SCRIPT.join('\n').includes('do shell script'));
  assert.ok(SEND_SCRIPT[0] === 'on run argv');
});

test('imessageSender: runs osascript with the fixed script, the values as arguments, and a time limit', async () => {
  const calls = [];
  const sendText = imessageSender({ run: async (file, args, opts) => { calls.push({ file, args, opts }); return { stdout: '' }; }, timeoutMs: 5000 });
  await sendText({ to: PHONE, text: HOSTILE });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'osascript');
  assert.deepEqual(calls[0].args, osascriptArgs({ to: PHONE, text: HOSTILE }));
  assert.equal(calls[0].opts.timeout, 5000);
});

test('imessageSender: a refusal, a timeout or no osascript throws a reason with no phone number in it', async () => {
  const refuse = imessageSender({ run: async () => { const e = new Error('Command failed'); e.code = 1; e.stderr = `execution error: Messages got an error: Can't get participant "${PHONE}". (-1728)\n`; throw e; } });
  await assert.rejects(refuse({ to: PHONE, text: 'x' }), (err) => {
    assert.match(err.message, /^Messages refused it: execution error: .*\[phone\]/);
    assert.ok(!err.message.includes(PHONE));
    return true;
  });
  const slow = imessageSender({ run: async () => { const e = new Error('Command failed'); e.killed = true; e.signal = 'SIGKILL'; throw e; }, timeoutMs: 30_000 });
  await assert.rejects(slow({ to: PHONE, text: 'x' }), /did not answer within 30 seconds .*allow control of Messages/);
  // No stderr: execFile's own message repeats the whole command line, text and number included; none of it is used.
  const quiet = imessageSender({ run: async () => { const e = new Error(`Command failed: osascript -e on run argv ${PHONE} Secret ticket text`); e.code = 1; e.stderr = ''; throw e; } });
  await assert.rejects(quiet({ to: PHONE, text: 'Secret ticket text' }), (err) => {
    assert.equal(err.message, 'Messages refused it: osascript exited 1');
    return true;
  });
  const none = imessageSender({ run: async () => { const e = new Error('spawn osascript ENOENT'); e.code = 'ENOENT'; throw e; } });
  await assert.rejects(none({ to: PHONE, text: 'x' }), /osascript is not on this machine/);
});

test('real osascript (Macs only): a hostile ticket name comes back as plain text, and nothing runs', { skip: !existsSync('/usr/bin/osascript') && 'no osascript on this machine' }, async () => {
  // The same argv route as SEND_SCRIPT, with a script that hands the values back instead of sending.
  const echo = ['on run argv', 'return (item 1 of argv) & "|" & (item 2 of argv)', 'end run'];
  const marker = join(tmpdir(), `sp114-injected-${process.pid}`);
  const hostile = `Fix "quotes"; do shell script "touch ${marker}"; "`;
  const { stdout } = await promisify(execFile)('/usr/bin/osascript', osascriptArgs({ to: PHONE, text: hostile }, echo), { timeout: 20_000 });
  assert.equal(stdout.replace(/\n$/, ''), `${PHONE}|${hostile}`);
  assert.equal(existsSync(marker), false, 'the ticket name ran as AppleScript');
});

test('textSettings: off on a machine that is not a Mac or has no osascript; on otherwise', () => {
  const linux = textSettings({ platform: 'linux', exists: () => true, run: async () => {} });
  assert.equal(linux.sendText, null);
  assert.match(linux.why, /not a Mac \(linux\)/);
  const bare = textSettings({ platform: 'darwin', exists: () => false, run: async () => {} });
  assert.equal(bare.sendText, null);
  assert.match(bare.why, /osascript is not on this machine/);
  const mac = textSettings({ platform: 'darwin', exists: () => true, run: async () => {} });
  assert.equal(typeof mac.sendText, 'function');
});

// ── The bus alarm text (SP-163, Dane's choice D: a text for alarms only) ──

/**
 * A bus project with a "Team chat" ticket, as bus-post leaves it, and a
 * server whose notifier texts through a fake. `post(text)` is what the door
 * sends: the "**From <machine>** · <time>" header, then the message.
 */
async function busFixture({ phone = PHONE, stamp = false } = {}) {
  const { stampMachineComment } = await import('../scripts/lib/machineComment.mjs');
  const store = openStore(':memory:');
  const dane = store.createActor({ kind: 'human', name: 'Dane' });
  const loop = store.createActor({ kind: 'machine', name: 'Loop' });
  const loopToken = store.issueToken(loop.id);
  store.createProject({ slug: 'sc-bus', name: 'StarCaster Bus', prefix: 'SB', operator: dane.id, alertPhone: phone });
  const chat = store.fileTicket({ project: 'sc-bus', actor: loop.id, name: 'Team chat', status: 'live' });
  const other = store.fileTicket({ project: 'sc-bus', actor: loop.id, name: 'A steward question', status: 'queued' });
  const fake = { textFail: false };
  const texts = [];
  const lines = [];
  const clock = { t: 1_000_000 };
  /** The retry timers the alarm channel set, fired by hand: `{ fn, ms, cleared }`. */
  const timers = [];
  const notifier = createNotifier({
    store, pageUrl: PAGE, log: (l) => lines.push(l), now: () => clock.t,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
    sendText: async (t) => { if (fake.textFail) throw new Error('Messages refused it: not signed in'); texts.push(t); },
  });
  const server = await startServer({ store, port: 0, log: () => {}, notifier });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(text, { on = chat.id, from = 'mini' } = {}) {
    const res = await fetch(`${base}/tickets/${on}/comments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${loopToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: (stamp ? stampMachineComment : String)(`**From ${from}** · 11/9/2026, 10:15 AM MT\n\n${text}`) }),
    });
    await notifier.settled();
    return { status: res.status, body: await res.json() };
  }
  async function cleanup() {
    await new Promise((r) => server.close(r));
    store.close();
  }
  return { store, chat, other, fake, texts, lines, clock, timers, notifier, post, cleanup };
}

test('an ALARM: post on Team chat sends one text to the bus project\'s alert phone: the bus, the machine, the alarm, the link', async () => {
  const f = await busFixture();
  const r = await f.post('ALARM: the heartbeat stopped at 09:10');
  assert.equal(r.status, 201);
  assert.equal(f.texts.length, 1);
  assert.equal(f.texts[0].to, PHONE);
  assert.equal(f.texts[0].text, [
    'Alarm on StarCaster Bus from mini',
    'ALARM: the heartbeat stopped at 09:10',
    'http://tracker.example:8787/t/SB-1',
  ].join('\n'));
  assert.ok(f.lines.includes(`bus alarm text sent: comment ${r.body.id} on SB-1 to the project's alert phone.`), f.lines.join('\n'));
  await f.cleanup();
});

test('a routine post, an alarm on another ticket, and a post that only mentions ALARM: send no text', async () => {
  const f = await busFixture();
  await f.post('weekly report: 12 merged');
  await f.post('the job said ALARM: earlier, now fine');
  await f.post('ALARM: on a steward question, not the bus', { on: f.other.id });
  assert.equal(f.texts.length, 0);
  assert.deepEqual(f.notifier.pendingAlarms(), []);
  await f.post('alarm: lower case still counts');
  assert.equal(f.texts.length, 1);
  await f.cleanup();
});

test('a failed alarm text never fails the post; it is kept, waits a minute, and is sent once', async () => {
  const f = await busFixture();
  f.fake.textFail = true;
  const r = await f.post('ALARM: queue STALLED');
  assert.equal(r.status, 201, 'the post stands');
  assert.equal(f.texts.length, 0);
  assert.deepEqual(f.notifier.pendingAlarms(), [String(r.body.id)]);
  assert.ok(f.lines.some((l) => l.startsWith(`bus alarm text NOT sent: comment ${r.body.id} on SB-1`) && l.includes('Messages refused it')), f.lines.join('\n'));
  f.fake.textFail = false;
  await f.notifier.afterWrite(null, []);
  assert.equal(f.texts.length, 0, 'not inside the minute');
  f.clock.t += 60_000;
  await f.notifier.afterWrite(null, []);
  assert.equal(f.texts.length, 1);
  await f.notifier.afterWrite(null, []);
  assert.equal(f.texts.length, 1, 'never twice');
  assert.ok(!f.lines.join('\n').includes(PHONE), 'no phone number in the log');
  await f.cleanup();
});

test('a bus project with no alert phone gets no alarm text, said once in the log, nothing kept', async () => {
  const f = await busFixture({ phone: null });
  await f.post('ALARM: one');
  await f.post('ALARM: two');
  assert.equal(f.texts.length, 0);
  assert.deepEqual(f.notifier.pendingAlarms(), []);
  assert.equal(f.lines.filter((l) => l.startsWith('bus alarm text: off for project "sc-bus"')).length, 1, f.lines.join('\n'));
  f.store.updateProject('sc-bus', { alertPhone: PHONE });
  await f.post('ALARM: three');
  assert.equal(f.texts.length, 1);
  await f.cleanup();
});

test('with texts off, an alarm post sends nothing and the post still stands', async () => {
  const store = openStore(':memory:');
  const loop = store.createActor({ kind: 'machine', name: 'Loop' });
  store.createProject({ slug: 'sc-bus', name: 'Bus', prefix: 'SB', alertPhone: PHONE });
  const chat = store.fileTicket({ project: 'sc-bus', actor: loop.id, name: 'Team chat', status: 'live' });
  const mail = [];
  const notifier = createNotifier({ store, send: async (m) => { mail.push(m); }, to: 'd@example.com', pageUrl: PAGE });
  const c = store.postComment({ ticket: chat.id, author: loop.id, body: 'ALARM: x' });
  await notifier.afterWrite(null, [], { comment: c, on: chat });
  assert.equal(mail.length, 0, 'Dane chose no alarm email');
  assert.deepEqual(notifier.pendingAlarms(), []);
  store.close();
});

test('a stamped alarm post (as bus-post really sends it) is texted without the "[machine]" line', async () => {
  const f = await busFixture({ stamp: true });
  const r = await f.post('ALARM: heartbeat stopped', { from: 'mac-mini' });
  assert.match(f.store.listComments(f.chat.id).at(-1).body, /\[machine\]/, 'the stored post carries the stamp');
  assert.equal(r.status, 201);
  assert.equal(f.texts.length, 1);
  assert.equal(f.texts[0].text, 'Alarm on StarCaster Bus from mac-mini\nALARM: heartbeat stopped\nhttp://tracker.example:8787/t/SB-1');
  assert.doesNotMatch(f.texts[0].text, /\[machine\]/);
  await f.cleanup();
});

test('a failed alarm text is tried again on a timer when it falls due, with no other write needed', async () => {
  const f = await busFixture();
  f.fake.textFail = true;
  await f.post('ALARM: queue STALLED');
  assert.equal(f.timers.length, 1, 'one retry timer');
  assert.equal(f.timers[0].ms, 60_000, 'set for the one-minute wait');
  assert.ok(f.lines.some((l) => l.includes('tried again in 60 second(s)')), f.lines.join('\n'));
  f.fake.textFail = false;
  f.clock.t += 60_000;
  f.timers[0].fn();
  await f.notifier.settled();
  assert.equal(f.texts.length, 1, 'sent by the timer alone');
  assert.deepEqual(f.notifier.pendingAlarms(), []);
  await f.cleanup();
});

test('a retry that fails again sets the next, doubled timer; a sooner write sends it and the late timer sends nothing twice', async () => {
  const f = await busFixture();
  f.fake.textFail = true;
  await f.post('ALARM: one');
  f.clock.t += 60_000;
  f.timers[0].fn();
  await f.notifier.settled();
  assert.equal(f.timers.length, 2);
  assert.equal(f.timers[1].ms, 120_000, 'doubled');
  f.fake.textFail = false;
  f.clock.t += 120_000;
  await f.notifier.afterWrite(null, []);
  assert.equal(f.texts.length, 1, 'the write got there first');
  f.timers[1].fn();
  await f.notifier.settled();
  assert.equal(f.texts.length, 1, 'never twice');
  await f.cleanup();
});

test('a retry timer that fires a moment early sets itself again rather than leaving the alarm for the next write', async () => {
  const f = await busFixture();
  f.fake.textFail = true;
  await f.post('ALARM: early');
  f.fake.textFail = false;
  f.clock.t += 59_000;
  f.timers[0].fn();
  await f.notifier.settled();
  assert.equal(f.texts.length, 0, 'not due yet');
  assert.equal(f.timers.length, 2, 'a new timer for the rest of the minute');
  assert.equal(f.timers[1].ms, 1_000);
  f.clock.t += 1_000;
  f.timers[1].fn();
  await f.notifier.settled();
  assert.equal(f.texts.length, 1);
  await f.cleanup();
});
