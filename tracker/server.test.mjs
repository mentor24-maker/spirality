import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.mjs';
import { startServer, settingsFromEnv } from './server.mjs';

/**
 * A fresh store in a temporary file, an operator and a loop each holding a
 * token, one project, and a server on a free port. Every log line the server
 * writes is kept in `lines`.
 */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-server-'));
  const path = join(dir, 'tracker.db');
  const store = openStore(path);
  const human = store.createActor({ kind: 'human', name: 'Operator' });
  const machine = store.createActor({ kind: 'machine', name: 'Loop' });
  const humanToken = store.issueToken(human.id);
  const machineToken = store.issueToken(machine.id);
  store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL', operator: human.id });
  const lines = [];
  const servers = [];
  const stores = [store];
  async function serve(s = store) {
    const server = await startServer({ store: s, port: 0, log: (line) => lines.push(line) });
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }
  const base = await serve();
  /** Call the API; answers `{ status, body, text }`. */
  async function call(method, path, { token = machineToken, body, at = base } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${at}${path}`, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text };
  }
  async function cleanup() {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    for (const s of stores) s.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return { dir, path, store, stores, human, machine, humanToken, machineToken, lines, serve, call, cleanup, tokens: [humanToken, machineToken] };
}

test('GET /me names the token\'s own actor, for a loop and for a person', async () => {
  const f = await fixture();
  try {
    const me = await f.call('GET', '/me');
    assert.equal(me.status, 200);
    assert.deepEqual(me.body, f.machine);
    const human = await f.call('GET', '/me', { token: f.humanToken });
    assert.deepEqual(human.body, f.human);
  } finally { await f.cleanup(); }
});

test('GET /actors/:id names an actor (never its token); an unknown or malformed id is 404', async () => {
  const f = await fixture();
  try {
    const human = await f.call('GET', `/actors/${f.human.id}`);
    assert.equal(human.status, 200);
    assert.deepEqual(human.body, f.human);
    for (const token of f.tokens) assert.ok(!human.text.includes(token));
    assert.equal((await f.call('GET', '/actors/999')).status, 404);
    assert.equal((await f.call('GET', '/actors/1x')).status, 404);
    assert.equal((await f.call('GET', `/actors/${f.human.id}`, { token: null })).status, 401);
  } finally { await f.cleanup(); }
});

test('no token and a wrong token both get 401, on reads and on writes, and nothing is written', async () => {
  const f = await fixture();
  try {
    const t = f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: 'x', status: 'queued' });
    for (const token of [null, 'wrong-token', `${f.machineToken}x`]) {
      assert.equal((await f.call('GET', '/me', { token })).status, 401);
      assert.equal((await f.call('GET', '/projects/alpha/tickets', { token })).status, 401);
      assert.equal((await f.call('PATCH', `/tickets/${t.id}`, { token, body: { status: 'building' } })).status, 401);
      assert.equal((await f.call('POST', `/tickets/${t.id}/comments`, { token, body: { body: 'hi' } })).status, 401);
      assert.equal((await f.call('POST', '/projects/alpha/tickets', { token, body: { name: 'y', status: 'queued' } })).status, 401);
    }
    const after = f.store.getTicket(t.id);
    assert.equal(after.status, 'queued');
    assert.equal(after.version, 1);
    assert.equal(f.store.listComments(t.id).length, 0);
    assert.equal(f.store.listTickets('alpha').length, 1);
  } finally { await f.cleanup(); }
});

test('POST /projects/:slug/tickets files a ticket under the caller, and GET lists the queue with its filters', async () => {
  const f = await fixture();
  try {
    const a = await f.call('POST', '/projects/alpha/tickets', { body: { name: 'First', status: 'Queued', priority: 'high', tags: ['tracker'], description: 'the spec' } });
    assert.equal(a.status, 201);
    assert.equal(a.body.id, 'AL-1');
    assert.equal(a.body.description, 'the spec');
    await f.call('POST', '/projects/alpha/tickets', { body: { name: 'Second', status: 'live' } });
    await f.call('POST', '/projects/alpha/tickets', { body: { name: 'Third', status: 'in review' } });

    const all = await f.call('GET', '/projects/alpha/tickets');
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.tickets.map((t) => t.id), ['AL-1', 'AL-2', 'AL-3']);
    const open = await f.call('GET', '/projects/alpha/tickets?open=true');
    assert.deepEqual(open.body.tickets.map((t) => t.id), ['AL-1', 'AL-3']);
    const queued = await f.call('GET', '/projects/alpha/tickets?status=Queued');
    assert.deepEqual(queued.body.tickets.map((t) => t.id), ['AL-1']);
    const review = await f.call('GET', `/projects/alpha/tickets?status=${encodeURIComponent('In review')}&open=1`);
    assert.deepEqual(review.body.tickets.map((t) => t.id), ['AL-3']);

    // The filer recorded in the history is the token's actor.
    assert.equal(f.store.listEvents('AL-1')[0].actor, f.machine.id);
  } finally { await f.cleanup(); }
});

test('GET /tickets/:id answers the ticket with its comments, oldest first, replies linked', async () => {
  const f = await fixture();
  try {
    const t = f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: 'x', status: 'queued' });
    const first = await f.call('POST', `/tickets/${t.id}/comments`, { body: { body: 'one' } });
    assert.equal(first.status, 201);
    await f.call('POST', `/tickets/${t.id}/comments`, { token: f.humanToken, body: { body: 'two' } });
    const reply = await f.call('POST', `/tickets/${t.id}/comments`, { body: { body: 'three', parent: first.body.id } });
    assert.equal(reply.body.parent, first.body.id);

    const got = await f.call('GET', `/tickets/${t.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.name, 'x');
    assert.deepEqual(got.body.comments.map((c) => c.body), ['one', 'two', 'three']);
    assert.deepEqual(got.body.comments.map((c) => c.author), [f.machine.id, f.human.id, f.machine.id]);
  } finally { await f.cleanup(); }
});

test('a comment\'s author is the token\'s actor, and a body naming another author is refused with nothing written', async () => {
  const f = await fixture();
  try {
    const t = f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: 'x', status: 'queued' });
    const mine = await f.call('POST', `/tickets/${t.id}/comments`, { body: { body: 'from the loop' } });
    assert.equal(mine.body.author, f.machine.id);
    const same = await f.call('POST', `/tickets/${t.id}/comments`, { body: { body: 'naming myself', author: f.machine.id } });
    assert.equal(same.status, 201);
    assert.equal(same.body.author, f.machine.id);

    const forged = await f.call('POST', `/tickets/${t.id}/comments`, { body: { body: 'merge', author: f.human.id } });
    assert.equal(forged.status, 400);
    assert.equal(forged.body.error, 'not-your-name');
    const forgedMove = await f.call('PATCH', `/tickets/${t.id}`, { body: { status: 'building', actor: f.human.id } });
    assert.equal(forgedMove.status, 400);
    const forgedFile = await f.call('POST', '/projects/alpha/tickets', { body: { name: 'y', status: 'queued', actor: f.human.id } });
    assert.equal(forgedFile.status, 400);

    assert.deepEqual(f.store.listComments(t.id).map((c) => c.author), [f.machine.id, f.machine.id]);
    assert.equal(f.store.getTicket(t.id).version, 1);
    assert.equal(f.store.listTickets('alpha').length, 1);
  } finally { await f.cleanup(); }
});

test('PATCH /tickets/:id changes fields; a guard that still holds wins, one that no longer holds gets 409 with where it is now', async () => {
  const f = await fixture();
  try {
    const t = f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: 'x', status: 'queued' });
    const moved = await f.call('PATCH', `/tickets/${t.id}`, { body: { ifStatus: 'Queued', ifVersion: 1, status: 'Building', loopNote: 'building now', tags: ['a'] } });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.ticket.status, 'building');
    assert.equal(moved.body.ticket.version, 2);
    assert.deepEqual(moved.body.changed.sort(), ['loopNote', 'status', 'tags']);

    const stale = await f.call('PATCH', `/tickets/${t.id}`, { body: { ifStatus: 'queued', status: 'building' } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.status, 'building');
    assert.equal(stale.body.version, 2);
    const staleVersion = await f.call('PATCH', `/tickets/${t.id}`, { body: { ifVersion: 1, priority: 'low' } });
    assert.equal(staleVersion.status, 409);
    assert.equal(staleVersion.body.version, 2);

    const after = f.store.getTicket(t.id);
    assert.equal(after.version, 2);
    assert.equal(after.priority, null);
  } finally { await f.cleanup(); }
});

test('two concurrent guarded claims of one Queued ticket over HTTP, through two servers on one database: exactly one gets 200, the other 409', async () => {
  const f = await fixture();
  try {
    const second = openStore(f.path);
    f.stores.push(second);
    const otherBase = await f.serve(second);
    for (let round = 0; round < 5; round++) {
      const t = f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: `race ${round}`, status: 'queued' });
      const claim = { ifStatus: 'queued', status: 'building' };
      const answers = await Promise.all([
        f.call('PATCH', `/tickets/${t.id}`, { body: claim }),
        f.call('PATCH', `/tickets/${t.id}`, { body: claim, token: f.humanToken, at: otherBase }),
      ]);
      assert.deepEqual(answers.map((a) => a.status).sort(), [200, 409]);
      const loser = answers.find((a) => a.status === 409);
      assert.equal(loser.body.status, 'building');
      assert.equal(loser.body.version, 2);
      const after = f.store.getTicket(t.id);
      assert.equal(after.version, 2);
      assert.equal(f.store.listEvents(t.id).filter((e) => e.field === 'status').length, 1);
    }
  } finally { await f.cleanup(); }
});

test('GET /tickets/:id/events answers the history, each move with the token\'s actor', async () => {
  const f = await fixture();
  try {
    const t = f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: 'x', status: 'queued' });
    await f.call('PATCH', `/tickets/${t.id}`, { body: { status: 'building' } });
    await f.call('PATCH', `/tickets/${t.id}`, { token: f.humanToken, body: { status: 'in review' } });
    const ev = await f.call('GET', `/tickets/${t.id}/events`);
    assert.equal(ev.status, 200);
    assert.deepEqual(ev.body.events.map((e) => [e.field, e.from, e.to, e.actor]), [
      ['created', null, 'queued', f.machine.id],
      ['status', 'queued', 'building', f.machine.id],
      ['status', 'building', 'in review', f.human.id],
    ]);
  } finally { await f.cleanup(); }
});

test('GET /projects/:slug answers one project\'s details to a call and the page to a browser; an unknown slug is 404 and writes nothing', async () => {
  const f = await fixture();
  try {
    f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: 'x', status: 'queued' });
    f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: 'y', status: 'live' });
    const r = await f.call('GET', '/projects/alpha');
    assert.equal(r.status, 200);
    assert.equal(r.body.prefix, 'AL');
    assert.deepEqual(r.body.operator, { id: f.human.id, name: 'Operator' });
    assert.equal(r.body.open, 1);
    assert.equal(r.body.statuses.find((s) => s.status === 'Queued').count, 1);
    assert.equal(r.body.statuses.find((s) => s.status === 'Live').count, 1);
    const before = f.store.listTickets('alpha').length;
    const unknown = await f.call('GET', '/projects/nope');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, 'unknown-project');
    assert.equal(f.store.listTickets('alpha').length, before);
    assert.equal((await f.call('GET', '/projects/alpha', { token: null })).status, 401);
    // A browser opening the address gets the page, without a token; the page then asks for the data.
    const base = f.lines.length;
    const page = await fetch(`${await f.serve()}/projects/nope`, { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.ok(f.lines.slice(base).some((l) => /GET \/projects\/nope 200 page/.test(l)));
  } finally { await f.cleanup(); }
});

test('unknown projects, tickets and addresses get 404; bad fields get 400; none of them writes anything', async () => {
  const f = await fixture();
  try {
    const t = f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: 'x', status: 'queued' });
    assert.equal((await f.call('GET', '/projects/nope/tickets')).status, 404);
    assert.equal((await f.call('POST', '/projects/nope/tickets', { body: { name: 'y', status: 'queued' } })).status, 404);
    assert.equal((await f.call('GET', '/tickets/AL-99')).status, 404);
    assert.equal((await f.call('PATCH', '/tickets/AL-99', { body: { status: 'building' } })).status, 404);
    assert.equal((await f.call('POST', '/tickets/AL-99/comments', { body: { body: 'hi' } })).status, 404);
    assert.equal((await f.call('GET', '/tickets/AL-99/events')).status, 404);
    assert.equal((await f.call('GET', '/nowhere')).status, 404);
    assert.equal((await f.call('DELETE', `/tickets/${t.id}`)).status, 404);

    const bad = [
      ['PATCH', `/tickets/${t.id}`, { status: 'done' }],
      ['PATCH', `/tickets/${t.id}`, { ifStatus: 'pending', status: 'building' }],
      ['PATCH', `/tickets/${t.id}`, { ifVersion: 'one', status: 'building' }],
      ['PATCH', `/tickets/${t.id}`, { status: 'building', colour: 'red' }],
      ['PATCH', `/tickets/${t.id}`, { priority: 'urgent-ish' }],
      ['PATCH', `/tickets/${t.id}`, { assignee: 999 }],
      ['PATCH', `/tickets/${t.id}`, { tags: 'not-a-list' }],
      ['PATCH', `/tickets/${t.id}`, '{not json'],
      ['PATCH', `/tickets/${t.id}`, '[1,2]'],
      ['POST', '/projects/alpha/tickets', { name: 'y', status: 'closed' }],
      ['POST', '/projects/alpha/tickets', { status: 'queued' }],
      ['POST', `/tickets/${t.id}/comments`, { body: '' }],
      ['POST', `/tickets/${t.id}/comments`, { body: 'reply', parent: 'first' }],
      ['POST', `/tickets/${t.id}/comments`, { body: 'reply', parent: 12345 }],
      ['GET', '/projects/alpha/tickets?status=complete', undefined],
      ['GET', '/projects/alpha/tickets?open=maybe', undefined],
    ];
    for (const [method, path, body] of bad) {
      const r = await f.call(method, path, { body });
      assert.equal(r.status, 400, `${method} ${path} ${JSON.stringify(body)} answered ${r.status}: ${r.text}`);
      assert.ok(r.body.error, 'a refusal names its reason');
    }
    const after = f.store.getTicket(t.id);
    assert.equal(after.status, 'queued');
    assert.equal(after.version, 1);
    assert.equal(f.store.listEvents(t.id).length, 1);
    assert.equal(f.store.listComments(t.id).length, 0);
    assert.equal(f.store.listTickets('alpha').length, 1);
  } finally { await f.cleanup(); }
});

test('a token never appears in any answer or any log line, and every request is logged with its actor id', async () => {
  const f = await fixture();
  try {
    const t = f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: 'x', status: 'queued' });
    const answers = await Promise.all([
      f.call('GET', '/me'),
      f.call('GET', '/me', { token: f.humanToken }),
      f.call('GET', '/me', { token: 'wrong-token' }),
      f.call('GET', '/projects/alpha/tickets'),
      f.call('GET', `/tickets/${t.id}`),
      f.call('GET', `/tickets/${t.id}/events`),
      f.call('POST', `/tickets/${t.id}/comments`, { body: { body: 'hello' } }),
      f.call('PATCH', `/tickets/${t.id}`, { body: { ifStatus: 'live', status: 'building' } }),
      f.call('GET', '/nowhere'),
    ]);
    assert.equal(f.lines.length, answers.length);
    const everything = [...answers.map((a) => a.text), ...f.lines].join('\n');
    for (const token of f.tokens) assert.ok(!everything.includes(token), 'a token leaked into an answer or the log');
    assert.ok(!everything.includes('wrong-token'));
    assert.ok(!/token_hash|tokenHash/.test(everything));
    assert.ok(f.lines.some((l) => l === `GET /me 200 actor=${f.machine.id}`));
    assert.ok(f.lines.some((l) => l === 'GET /me 401 actor=-'));
  } finally { await f.cleanup(); }
});

test('the server reads its database, port and host from the environment, and refuses to guess the first two', () => {
  assert.deepEqual(settingsFromEnv({ TRACKER_DB: '/tmp/x.db', TRACKER_PORT: '4100' }), { db: '/tmp/x.db', port: 4100, host: '127.0.0.1' });
  assert.deepEqual(settingsFromEnv({ TRACKER_DB: '/tmp/x.db', TRACKER_PORT: '4100', TRACKER_HOST: '0.0.0.0' }), { db: '/tmp/x.db', port: 4100, host: '0.0.0.0' });
  assert.throws(() => settingsFromEnv({}), /TRACKER_DB and TRACKER_PORT/);
  assert.throws(() => settingsFromEnv({ TRACKER_DB: '/tmp/x.db' }), /TRACKER_PORT/);
  assert.throws(() => settingsFromEnv({ TRACKER_DB: '/tmp/x.db', TRACKER_PORT: 'eighty' }), /port number/);
});

test('admin: create-actor prints only the token on stdout, and that token signs in; create-project makes a project', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-admin-'));
  const db = join(dir, 'tracker.db');
  const admin = fileURLToPath(new URL('./admin.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [admin, ...args], { encoding: 'utf8', env: { ...process.env, TRACKER_DB: db } });
  try {
    const actor = run('create-actor', '--kind', 'machine', '--name', 'Build loop');
    assert.equal(actor.status, 0, actor.stderr);
    const token = actor.stdout.trim();
    assert.match(actor.stdout, /^[A-Za-z0-9_-]{40,}\n$/);
    assert.ok(!actor.stderr.includes(token));
    const human = run('create-actor', '--kind', 'human', '--name', 'Operator');
    assert.equal(human.status, 0, human.stderr);

    const project = run('create-project', '--slug', 'beta', '--name', 'Beta', '--prefix', 'BE', '--operator', '2');
    assert.equal(project.status, 0, project.stderr);
    assert.ok(!project.stdout.includes(token));

    assert.notEqual(run('create-actor', '--kind', 'robot', '--name', 'x').status, 0);
    assert.notEqual(run('create-project', '--slug', 'gamma', '--name', 'G', '--prefix', 'BE').status, 0);
    assert.notEqual(run('create-project', '--slug', 'gamma', '--name', 'G', '--prefix', 'GA', '--operator', 'two').status, 0);
    assert.notEqual(run('rename-everything').status, 0);
    const noDb = spawnSync(process.execPath, [admin, 'create-actor', '--kind', 'machine', '--name', 'x'], { encoding: 'utf8', env: { ...process.env, TRACKER_DB: '' } });
    assert.notEqual(noDb.status, 0);
    assert.match(noDb.stderr, /TRACKER_DB/);

    const store = openStore(db);
    try {
      assert.deepEqual(store.actorForToken(token), { id: 1, kind: 'machine', name: 'Build loop' });
      assert.deepEqual(store.getProject('beta'), { slug: 'beta', name: 'Beta', prefix: 'BE', operator: 2 });
      assert.equal(store.getProject('gamma'), null);
      const server = await startServer({ store, port: 0 });
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/me`, { headers: { authorization: `Bearer ${token}` } });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).name, 'Build loop');
      } finally { await new Promise((r) => server.close(r)); }
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the server, admin and backup hard-code no product: no names, ids, prefixes or ports in their source', () => {
  for (const file of ['./server.mjs', './admin.mjs', './backup.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const word of [/starcaster/i, /wavecenter/i, /spirality/i, /\bSP-/, /\bSC-/, /\bWC-/, /\b9014\d{8}\b/, /86b[a-z0-9]{6}/, /listen\(\s*\d/, /\bport\s*=\s*\d/i]) {
      assert.doesNotMatch(source, word, `${file} matches ${word}`);
    }
  }
});

test('stage colours: anyone signed in reads all eight in STAGE_ORDER; a person saves and clears them; a loop is refused 403; a bad value is 400; neither writes', async () => {
  const f = await fixture();
  try {
    const read = await f.call('GET', '/stage-colours');
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.stages.map((s) => s.status), ['Requested', 'Rework', 'Queued', 'Building', 'In review', 'Needs your input', 'Ready to launch', 'Live']);
    assert.ok(read.body.stages.every((s) => s.colour === null));
    assert.equal((await f.call('GET', '/stage-colours', { token: null })).status, 401);

    const saved = await f.call('PUT', '/stage-colours', { token: f.humanToken, body: { colours: { Queued: '#2b9cf2', Live: '#00aa00' } } });
    assert.equal(saved.status, 200, saved.text);
    const colourOf = (body, status) => body.stages.find((s) => s.status === status).colour;
    assert.equal(colourOf(saved.body, 'Queued'), '#2b9cf2');
    // Read back by another sign-in: the colours are the tracker's, not one browser's.
    const back = (await f.call('GET', '/stage-colours')).body;
    assert.deepEqual([colourOf(back, 'Queued'), colourOf(back, 'Live'), colourOf(back, 'Rework')], ['#2b9cf2', '#00aa00', null]);

    const cleared = await f.call('PUT', '/stage-colours', { token: f.humanToken, body: { colours: { Queued: null } } });
    assert.equal(colourOf(cleared.body, 'Queued'), null);
    assert.equal(colourOf((await f.call('GET', '/stage-colours')).body, 'Queued'), null);

    const before = f.store.stageColours();
    const loop = await f.call('PUT', '/stage-colours', { token: f.machineToken, body: { colours: { Queued: '#123456' } } });
    assert.equal(loop.status, 403);
    assert.match(loop.body.message, /only a person/);
    for (const body of [{ colours: { Queued: 'red' } }, { colours: { Queued: '#12345' } }, { colours: { Nope: '#123456' } }, { colours: 'red' }, { colours: { Queued: '#123456' }, extra: 1 }]) {
      const bad = await f.call('PUT', '/stage-colours', { token: f.humanToken, body });
      assert.equal(bad.status, 400, JSON.stringify(body));
      assert.ok(bad.body.message);
    }
    assert.deepEqual(f.store.stageColours(), before, 'a refused save stores nothing');
  } finally { await f.cleanup(); }
});
