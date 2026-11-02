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
      assert.equal((await f.call('DELETE', `/tickets/${t.id}`, { token })).status, 401);
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

test('DELETE /tickets/:id removes an unstarted ticket with its comments; a started one is 409 not-deletable; an unknown one is 404', async () => {
  const f = await fixture();
  try {
    for (const status of ['requested', 'queued']) {
      const t = f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: `gone ${status}`, status });
      f.store.postComment({ ticket: t.id, author: f.human.id, body: 'note' });
      const r = await f.call('DELETE', `/tickets/${t.id}`, { token: f.humanToken });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { deleted: t.id, status });
      assert.equal((await f.call('GET', `/tickets/${t.id}`)).status, 404);
      assert.equal((await f.call('GET', `/tickets/${t.id}/events`)).status, 404);
      assert.deepEqual(f.store.listComments(t.id), []);
      assert.ok(f.lines.includes(`deleted ticket ${t.id} (was "${status}") actor=${f.human.id}`));
    }
    for (const status of ['rework', 'building', 'in review', 'needs your input', 'ready to launch', 'live']) {
      const t = f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: status, status });
      f.store.postComment({ ticket: t.id, author: f.human.id, body: 'note' });
      const r = await f.call('DELETE', `/tickets/${t.id}`, { token: f.humanToken });
      assert.equal(r.status, 409, status);
      assert.equal(r.body.error, 'not-deletable');
      assert.equal(r.body.status, status);
      const after = await f.call('GET', `/tickets/${t.id}`);
      assert.equal(after.body.status, status);
      assert.equal(after.body.comments.length, 1);
      assert.equal(f.store.listEvents(t.id).length, 1);
    }
    const unknown = await f.call('DELETE', '/tickets/AL-999', { token: f.humanToken });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, 'unknown-ticket');
  } finally { await f.cleanup(); }
});

test('a delete and a claim of one Queued ticket over HTTP, through two servers on one database: exactly one wins', async () => {
  const f = await fixture();
  try {
    const second = openStore(f.path);
    f.stores.push(second);
    const otherBase = await f.serve(second);
    for (let round = 0; round < 5; round++) {
      const t = f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: `race ${round}`, status: 'queued' });
      const [del, claim] = await Promise.all([
        f.call('DELETE', `/tickets/${t.id}`, { token: f.humanToken }),
        f.call('PATCH', `/tickets/${t.id}`, { body: { ifStatus: 'queued', status: 'building' }, at: otherBase }),
      ]);
      if (del.status === 200) {
        assert.equal(claim.status, 404);
        assert.equal(f.store.getTicket(t.id), null);
      } else {
        assert.equal(del.status, 409);
        assert.equal(del.body.status, 'building');
        assert.equal(claim.status, 200);
        assert.equal(f.store.getTicket(t.id).status, 'building');
      }
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

test('PATCH /projects/:slug changes a project\'s name, web address, logo and owner for a person, answered read back', async () => {
  const f = await fixture();
  try {
    const r = await f.call('PATCH', '/projects/alpha', {
      token: f.humanToken, body: { name: 'Alpha Two', url: 'https://alpha.example', logo: 'https://alpha.example/l.png', owner: f.human.id },
    });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.slug, r.body.prefix, r.body.name, r.body.url, r.body.logo, r.body.owner],
      ['alpha', 'AL', 'Alpha Two', 'https://alpha.example', 'https://alpha.example/l.png', { id: f.human.id, name: 'Operator' }]);
    assert.deepEqual(f.store.getProject('alpha'), {
      slug: 'alpha', name: 'Alpha Two', prefix: 'AL', operator: f.human.id,
      url: 'https://alpha.example', logo: 'https://alpha.example/l.png', owner: f.human.id,
    });
    const listed = (await f.call('GET', '/projects')).body.projects.find((p) => p.slug === 'alpha');
    assert.equal(listed.name, 'Alpha Two');
  } finally { await f.cleanup(); }
});

test('PATCH /projects/:slug refuses a machine (403), a slug or prefix change, a bad field or owner (400), an unknown project (404), and writes nothing', async () => {
  const f = await fixture();
  try {
    const before = f.store.getProject('alpha');
    const machine = await f.call('PATCH', '/projects/alpha', { body: { name: 'Loop was here' } });
    assert.equal(machine.status, 403);
    assert.equal(machine.body.error, 'people-only');
    for (const [body, error] of [
      [{ slug: 'beta' }, 'not-changeable'],
      [{ prefix: 'BE' }, 'not-changeable'],
      [{ name: 'Fine', slug: 'beta' }, 'not-changeable'],
      [{ operator: f.machine.id }, 'bad-field'],
      [{ owner: 'Operator' }, 'bad-owner'],
      [{ owner: f.machine.id }, 'bad-owner'],
      [{ url: 'javascript:alert(1)' }, 'bad-address'],
      [{ name: '' }, 'missing'],
      [{ actor: f.machine.id, name: 'x' }, 'not-your-name'],
    ]) {
      const r = await f.call('PATCH', '/projects/alpha', { token: f.humanToken, body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, error, JSON.stringify(body));
    }
    assert.equal((await f.call('PATCH', '/projects/nope', { token: f.humanToken, body: { name: 'x' } })).status, 404);
    assert.equal((await f.call('PATCH', '/projects/alpha', { token: null, body: { name: 'x' } })).status, 401);
    assert.deepEqual(f.store.getProject('alpha'), before);
  } finally { await f.cleanup(); }
});

test('DELETE /projects/:slug removes a project with no tickets for a person; one with tickets is 409 and nothing is removed', async () => {
  const f = await fixture();
  try {
    f.store.createProject({ slug: 'try-me', name: 'Try me', prefix: 'TRY' });
    const base = f.lines.length;
    const gone = await f.call('DELETE', '/projects/try-me', { token: f.humanToken });
    assert.equal(gone.status, 200);
    assert.deepEqual(gone.body, { deleted: 'try-me' });
    assert.equal(f.store.getProject('try-me'), null);
    assert.equal((await f.call('GET', '/projects/try-me')).status, 404);
    assert.ok(f.lines.slice(base).some((l) => l === `deleted project try-me (prefix TRY) actor=${f.human.id}`), 'the log records the deletion');
    assert.equal((await f.call('DELETE', '/projects/try-me', { token: f.humanToken })).status, 404);

    // The guard that matters: a project with tickets is refused, in plain words, and stays whole.
    f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: 'x', status: 'queued' });
    f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: 'y', status: 'live' });
    const refused = await f.call('DELETE', '/projects/alpha', { token: f.humanToken });
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body, {
      error: 'has-tickets', message: 'AL has 2 tickets; a project with tickets cannot be deleted.', project: 'alpha', tickets: 2,
    });
    assert.ok(f.store.getProject('alpha'));
    assert.equal(f.store.listTickets('alpha').length, 2);
  } finally { await f.cleanup(); }
});

test('DELETE /projects/:slug from a machine is 403 and removes nothing, even an empty project', async () => {
  const f = await fixture();
  try {
    f.store.createProject({ slug: 'try-me', name: 'Try me', prefix: 'TRY' });
    const r = await f.call('DELETE', '/projects/try-me');
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'people-only');
    assert.ok(f.store.getProject('try-me'));
    assert.equal((await f.call('DELETE', '/projects/try-me', { token: null })).status, 401);
    assert.ok(f.store.getProject('try-me'));
  } finally { await f.cleanup(); }
});

test('/projects/:slug/edit is the page to a browser, without a token', async () => {
  const f = await fixture();
  try {
    const res = await fetch(`${await f.serve()}/projects/alpha/edit`, { headers: { accept: 'text/html' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html/);
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
    assert.equal((await f.call('PUT', `/tickets/${t.id}`)).status, 404);

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
      assert.deepEqual(store.getProject('beta'), { slug: 'beta', name: 'Beta', prefix: 'BE', operator: 2, url: null, logo: null, owner: null });
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

test('POST /projects lets a person add a project, read back with its owner by name; a machine gets 403 and nothing is written', async () => {
  const f = await fixture();
  try {
    const before = f.store.listProjects();
    const refused = await f.call('POST', '/projects', { body: { name: 'Beta', slug: 'beta', prefix: 'BE' } });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, 'people-only');
    assert.deepEqual(f.store.listProjects(), before, 'a machine wrote nothing');
    assert.equal((await f.call('POST', '/projects', { token: null, body: { name: 'Beta', slug: 'beta', prefix: 'BE' } })).status, 401);

    const made = await f.call('POST', '/projects', {
      token: f.humanToken,
      body: { name: 'Beta', slug: 'beta', prefix: 'BE', url: 'https://beta.example', logo: 'https://beta.example/l.png', owner: f.human.id },
    });
    assert.equal(made.status, 201);
    assert.equal(made.body.slug, 'beta');
    assert.deepEqual(made.body.owner, { id: f.human.id, name: 'Operator' });
    assert.equal(made.body.url, 'https://beta.example');
    assert.equal(made.body.logo, 'https://beta.example/l.png');
    assert.equal(made.body.operator, null, 'the operator is not set by the form');
    assert.deepEqual((await f.call('GET', '/projects/beta')).body, made.body);
    assert.ok(f.lines.some((l) => /POST \/projects 201 actor=1/.test(l)));
  } finally { await f.cleanup(); }
});

test('POST /projects refuses a missing field, a duplicate slug or prefix, a bad slug, a machine owner and an unknown field, and writes nothing', async () => {
  const f = await fixture();
  try {
    const good = { name: 'Beta', slug: 'beta', prefix: 'BE' };
    for (const [body, error] of [
      [{ ...good, name: '' }, 'missing'],
      [{ ...good, slug: '' }, 'missing'],
      [{ ...good, prefix: '' }, 'bad-prefix'],
      [{ ...good, slug: 'alpha' }, 'duplicate-project'],
      [{ ...good, prefix: 'AL' }, 'duplicate-project'],
      [{ ...good, slug: 'Has Spaces' }, 'bad-slug'],
      [{ ...good, slug: 'a/b' }, 'bad-slug'],
      [{ ...good, slug: 'new' }, 'bad-slug'],
      [{ ...good, owner: f.machine.id }, 'bad-owner'],
      [{ ...good, owner: 'Operator' }, 'bad-owner'],
      [{ ...good, url: 'javascript:alert(1)' }, 'bad-address'],
      [{ ...good, operator: f.human.id }, 'bad-field'],
      [{ ...good, actor: f.machine.id }, 'not-your-name'],
    ]) {
      const r = await f.call('POST', '/projects', { token: f.humanToken, body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, error, JSON.stringify(body));
      assert.ok(r.body.message, 'the form has a reason to show');
    }
    assert.deepEqual(f.store.listProjects().map((p) => p.slug), ['alpha']);
  } finally { await f.cleanup(); }
});

test('GET /people lists the tracker\'s people for the owner picker: humans only, never a token', async () => {
  const f = await fixture();
  try {
    const r = await f.call('GET', '/people', { token: f.humanToken });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { people: [{ id: f.human.id, name: 'Operator' }] });
    for (const token of f.tokens) assert.ok(!r.text.includes(token));
    assert.equal((await f.call('GET', '/people', { token: null })).status, 401);
  } finally { await f.cleanup(); }
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

test('an emailed link sets a password once, with no token; the same link again is refused and nothing changes', async () => {
  const f = await fixture();
  try {
    const link = f.store.makeLink({ purpose: 'setup', email: 'Op@Example.com', actor: f.human.id, madeBy: f.human.id });
    const info = await f.call('POST', '/account/link', { token: null, body: { link: link.token } });
    assert.equal(info.status, 200);
    assert.deepEqual(info.body, { purpose: 'setup', email: 'op@example.com', expiresAt: link.expiresAt });

    const set = await f.call('POST', '/account/set-password', { token: null, body: { link: link.token, password: 'a good long password' } });
    assert.equal(set.status, 200);
    assert.deepEqual(set.body, { purpose: 'setup', name: 'Operator', email: 'op@example.com' });
    assert.equal(f.store.checkPassword({ email: 'op@example.com', password: 'a good long password' })?.id, f.human.id);

    const again = await f.call('POST', '/account/set-password', { token: null, body: { link: link.token, password: 'a different password' } });
    assert.equal(again.status, 400);
    assert.equal(again.body.error, 'used-link');
    assert.equal(f.store.checkPassword({ email: 'op@example.com', password: 'a different password' }), null);
    assert.equal(f.store.checkPassword({ email: 'op@example.com', password: 'a good long password' })?.id, f.human.id);
    assert.equal((await f.call('POST', '/account/link', { token: null, body: { link: link.token } })).body.error, 'used-link');
  } finally { await f.cleanup(); }
});

test('a bad link, a short password, a missing invite name or a stray field is refused with the store\'s code, and spends nothing', async () => {
  const f = await fixture();
  try {
    const invite = f.store.makeLink({ purpose: 'invite', email: 'new@example.com', madeBy: f.human.id });
    const post = (body) => f.call('POST', '/account/set-password', { token: null, body });
    assert.equal((await post({ link: 'not-a-link', password: 'a good long password', name: 'X' })).body.error, 'unknown-link');
    assert.equal((await post({ password: 'a good long password' })).body.error, 'unknown-link');
    assert.equal((await post({ link: invite.token, password: 'short', name: 'New' })).body.error, 'weak-password');
    assert.equal((await post({ link: invite.token, password: 'a good long password' })).body.error, 'missing');
    const stray = await post({ link: invite.token, password: 'a good long password', name: 'New', actor: f.human.id });
    assert.equal(stray.status, 400);
    assert.equal(stray.body.error, 'bad-field');
    assert.equal(f.store.actorForEmail('new@example.com'), null);
    assert.equal(f.store.linkInfo(invite.token).purpose, 'invite', 'still usable');
    const made = await post({ link: invite.token, password: 'a good long password', name: ' New Person ' });
    assert.equal(made.status, 200);
    assert.equal(made.body.name, 'New Person');
    // Only POST: the address does not take a link in a GET.
    assert.equal((await f.call('GET', '/account/link', { token: null })).status, 401);
  } finally { await f.cleanup(); }
});

test('the set-password page is served without a token, and no link token or password reaches the server log', async () => {
  const f = await fixture();
  try {
    const link = f.store.makeLink({ purpose: 'setup', email: 'op@example.com', actor: f.human.id, madeBy: f.human.id });
    const base = await f.serve();
    const page = await fetch(`${base}/set-password?link=${encodeURIComponent(link.token)}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    await f.call('POST', '/account/link', { token: null, body: { link: link.token } });
    await f.call('POST', '/account/set-password', { token: null, body: { link: link.token, password: 'a secret password' } });
    await f.call('POST', '/account/set-password', { token: null, body: { link: link.token, password: 'another secret pw' } });
    const log = f.lines.join('\n');
    assert.match(log, /POST \/account\/set-password 200 actor=-/);
    assert.match(log, new RegExp(`password set through a setup link actor=${f.human.id}`));
    for (const secret of [link.token, encodeURIComponent(link.token), 'a secret password', 'another secret pw']) {
      assert.ok(!log.includes(secret), `the log carries ${secret}`);
    }
  } finally { await f.cleanup(); }
});

test('a person may assign a ticket only to its project\'s operator or to nobody; anyone else is refused and nothing is written', async () => {
  const f = await fixture();
  try {
    const other = f.store.createActor({ kind: 'human', name: 'Someone else' });
    const t = f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: 'x', status: 'queued' });
    const refused = await f.call('PATCH', `/tickets/${t.id}`, { token: f.humanToken, body: { assignee: other.id, priority: 'low' } });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, 'bad-assignee');
    assert.match(refused.body.message, /operator \(actor \d+\) or to nobody/);
    assert.deepEqual(f.store.getTicket(t.id), t, 'nothing was written, not even the priority');
    const toOperator = await f.call('PATCH', `/tickets/${t.id}`, { token: f.humanToken, body: { assignee: f.human.id } });
    assert.equal(toOperator.status, 200);
    assert.equal(f.store.getTicket(t.id).assignee, f.human.id);
    const toNobody = await f.call('PATCH', `/tickets/${t.id}`, { token: f.humanToken, body: { assignee: null } });
    assert.equal(toNobody.status, 200);
    assert.equal(f.store.getTicket(t.id).assignee, null);
  } finally { await f.cleanup(); }
});

test('the thread answer names the project\'s operator and the choices the ticket page offers', async () => {
  const f = await fixture();
  try {
    const t = f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: 'x', status: 'building' });
    const { body } = await f.call('GET', `/tickets/${t.id}/thread`, { token: f.humanToken });
    assert.deepEqual(body.operator, { id: f.human.id, name: 'Operator' });
    assert.deepEqual(body.choices.priorities, ['urgent', 'high', 'normal', 'low']);
    assert.deepEqual(body.choices.statuses.map((s) => s.label), ['Requested', 'Rework', 'Queued', 'Live']);
    assert.equal(body.version, 1);
  } finally { await f.cleanup(); }
});

/**
 * A server on the fixture's store with `options` (accountMail, now), the
 * operator holding an email and a password, and a raw caller that sends
 * exactly the headers given. Answers `{ base, ask, email, password }`.
 */
async function signInServer(f, options = {}) {
  const email = 'operator@example.com';
  const password = 'a good long password';
  f.store.setEmail(f.human.id, email);
  f.store.setPassword(f.human.id, password);
  const server = await startServer({ store: f.store, port: 0, log: (line) => f.lines.push(line), ...options });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function ask(method, path, { headers = {}, body } = {}) {
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text, cookie: res.headers.get('set-cookie') };
  }
  const json = { 'content-type': 'application/json' };
  const signIn = (b) => ask('POST', '/signin', { headers: json, body: b });
  return { base, ask, json, signIn, email, password, close: () => new Promise((r) => server.close(r)) };
}

/** The session cookie a Set-Cookie header carries, as a Cookie header sends it back. */
const cookieOf = (setCookie) => setCookie.split(';')[0];

test('signing in with an email and a password sets a 30-day HttpOnly, SameSite=Strict cookie that signs the page in; signing out ends it', async () => {
  const f = await fixture();
  const s = await signInServer(f);
  try {
    const r = await s.signIn({ email: '  Operator@Example.com ', password: s.password });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, f.human);
    const flags = r.cookie.split(';').map((p) => p.trim());
    assert.match(flags[0], /^tracker_session=[A-Za-z0-9_-]{20,}$/);
    for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000']) assert.ok(flags.includes(flag), flag);
    assert.ok(!flags.some((p) => /^secure$/i.test(p)), 'no Secure flag yet: the tracker is plain http on the home network');
    const cookie = cookieOf(r.cookie);

    // "Reload": the cookie alone signs in, every time.
    for (let i = 0; i < 2; i++) assert.deepEqual((await s.ask('GET', '/me', { headers: { cookie } })).body, f.human);
    assert.equal((await s.ask('GET', '/waiting', { headers: { cookie: `other=1; ${cookie}` } })).status, 200);

    const out = await s.ask('POST', '/signout', { headers: { ...s.json, cookie }, body: {} });
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { signedOut: true });
    assert.match(out.cookie, /^tracker_session=;.*Max-Age=0/);
    assert.equal((await s.ask('GET', '/me', { headers: { cookie } })).status, 401);
  } finally { await s.close(); await f.cleanup(); }
});

test('a wrong password and an unknown email get the same answer; after 5 failures in 15 minutes even the right password is refused for 15 minutes', async () => {
  const f = await fixture();
  let clock = Date.parse('2026-11-01T18:00:00Z');
  const s = await signInServer(f, { now: () => clock });
  try {
    const wrong = await s.signIn({ email: s.email, password: 'not the password' });
    const unknown = await s.signIn({ email: 'nobody@example.com', password: 'not the password' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.text, unknown.text, 'the same answer, word for word');
    assert.equal(wrong.body.message, 'That email and password do not match.');
    assert.equal(wrong.cookie, null);

    for (let i = 0; i < 4; i++) assert.equal((await s.signIn({ email: s.email, password: `wrong ${i}` })).status, 401);
    const sixth = await s.signIn({ email: s.email, password: s.password });
    assert.equal(sixth.status, 429);
    assert.equal(sixth.body.error, 'locked');
    assert.match(sixth.body.message, /Wait 15 minutes/);
    assert.equal(sixth.cookie, null, 'no session is started while locked');
    // Any case of the same email is the same email; another email is not locked.
    assert.equal((await s.signIn({ email: s.email.toUpperCase(), password: s.password })).status, 429);
    assert.equal((await s.signIn({ email: 'nobody@example.com', password: 'x' })).status, 401);

    clock += 14 * 60_000;
    assert.equal((await s.signIn({ email: s.email, password: s.password })).status, 429);
    clock += 60_000;
    assert.equal((await s.signIn({ email: s.email, password: s.password })).status, 200);

    // Failures spread wider than 15 minutes never lock.
    for (let i = 0; i < 8; i++) {
      assert.equal((await s.signIn({ email: s.email, password: 'wrong' })).status, 401, `try ${i + 1}`);
      clock += 4 * 60_000;
    }
  } finally { await s.close(); await f.cleanup(); }
});

test('a machine\'s token can never stand in for a session cookie, and every loop token keeps working unchanged', async () => {
  const f = await fixture();
  const s = await signInServer(f);
  try {
    for (const token of [f.machineToken, f.humanToken]) {
      assert.equal((await s.ask('GET', '/me', { headers: { cookie: `tracker_session=${token}` } })).status, 401);
    }
    assert.throws(() => f.store.startSession(f.machine.id), { code: 'machine-account' });
    // A bearer token still signs in, and a bearer write needs no content type, as before.
    assert.deepEqual((await s.ask('GET', '/me', { headers: { authorization: `Bearer ${f.machineToken}` } })).body, f.machine);
    const filed = await s.ask('POST', '/projects/alpha/tickets', { headers: { authorization: `Bearer ${f.machineToken}` }, body: { name: 'By a loop', status: 'queued' } });
    assert.equal(filed.status, 201);
    // A bearer token beats a cookie: the loop's actor, never the person's.
    const r = await s.signIn({ email: s.email, password: s.password });
    const both = await s.ask('GET', '/me', { headers: { authorization: `Bearer ${f.machineToken}`, cookie: cookieOf(r.cookie) } });
    assert.deepEqual(both.body, f.machine);
    assert.equal((await s.ask('GET', '/me', { headers: { authorization: 'Bearer wrong', cookie: cookieOf(r.cookie) } })).status, 401);
  } finally { await s.close(); await f.cleanup(); }
});

test('a write made with the cookie must say content-type: application/json; a plain form post is refused and writes nothing', async () => {
  const f = await fixture();
  const s = await signInServer(f);
  try {
    const cookie = cookieOf((await s.signIn({ email: s.email, password: s.password })).cookie);
    const before = f.store.listTickets('alpha').length;
    const form = { 'content-type': 'application/x-www-form-urlencoded', cookie };
    const refused = await s.ask('POST', '/projects/alpha/tickets', { headers: form, body: JSON.stringify({ name: 'From another site', status: 'requested' }) });
    assert.equal(refused.status, 415);
    assert.equal(refused.body.error, 'json-only');
    assert.equal((await s.ask('POST', '/projects/alpha/tickets', { headers: { cookie }, body: JSON.stringify({ name: 'No type', status: 'requested' }) })).status, 415);
    assert.equal(f.store.listTickets('alpha').length, before, 'nothing was written');
    // The no-token calls take only JSON too: a form cannot sign anyone in or out.
    assert.equal((await s.ask('POST', '/signin', { headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ email: s.email, password: s.password }) })).status, 415);
    assert.equal((await s.ask('POST', '/signout', { headers: { cookie } })).status, 415);
    assert.equal((await s.ask('GET', '/me', { headers: { cookie } })).status, 200, 'still signed in');

    const filed = await s.ask('POST', '/projects/alpha/tickets', { headers: { ...s.json, cookie }, body: { name: 'From the page', status: 'requested' } });
    assert.equal(filed.status, 201);
    assert.equal(f.store.listEvents(filed.body.id)[0].actor, f.human.id, 'written as the person signed in');
  } finally { await s.close(); await f.cleanup(); }
});

test('Forgot password: an account\'s email gets a 1-hour reset link that works, an unknown email gets nothing, and the answer is the same', async () => {
  const f = await fixture();
  const sent = [];
  const accountMail = { send: async (mail) => { sent.push(mail); }, pageUrl: 'http://tracker.test:4180', productName: 'Alpha' };
  const s = await signInServer(f, { accountMail });
  try {
    const cookie = cookieOf((await s.signIn({ email: s.email, password: s.password })).cookie);
    const known = await s.ask('POST', '/account/forgot', { headers: s.json, body: { email: 'OPERATOR@example.com' } });
    const unknown = await s.ask('POST', '/account/forgot', { headers: s.json, body: { email: 'nobody@example.com' } });
    assert.equal(known.status, 200);
    assert.equal(known.text, unknown.text, 'the same answer, word for word');
    assert.match(known.body.sent, /If that email has an account/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, s.email);
    assert.equal(sent[0].subject, 'Reset your Alpha password');
    const link = /http:\/\/tracker\.test:4180\/set-password\?link=([A-Za-z0-9_%-]+)/.exec(sent[0].text);
    assert.ok(link, sent[0].text);
    const token = decodeURIComponent(link[1]);
    const info = await s.ask('POST', '/account/link', { headers: s.json, body: { link: token } });
    assert.equal(info.body.purpose, 'reset');
    assert.equal(Date.parse(info.body.expiresAt) - Date.now() <= 60 * 60_000, true, 'good for 1 hour');

    for (let i = 0; i < 5; i++) await s.signIn({ email: s.email, password: `wrong ${i}` });
    assert.equal((await s.signIn({ email: s.email, password: s.password })).status, 429);
    const set = await s.ask('POST', '/account/set-password', { headers: s.json, body: { link: token, password: 'a brand new password' } });
    assert.equal(set.status, 200);
    assert.equal((await s.ask('GET', '/me', { headers: { cookie } })).status, 401, 'a reset signs out everywhere');
    assert.equal((await s.signIn({ email: s.email, password: 'a brand new password' })).status, 200, 'a reset forgives the failed tries');
    assert.ok(f.lines.includes(`reset link sent to actor ${f.human.id}, good for 1 hour`));
    assert.ok(f.lines.includes('reset asked for an email with no account; nothing sent'));
    assert.equal((await s.signIn({ email: s.email, password: s.password })).status, 401, 'the old password no longer signs in');
  } finally { await s.close(); await f.cleanup(); }
});

test('Forgot password with no mail sender, or a sender that fails, answers the page the same and says why in the log, leaving no usable link', async () => {
  const f = await fixture();
  const s = await signInServer(f, { accountMail: { send: async () => { throw new Error('Resend answered 500'); }, pageUrl: 'http://tracker.test', productName: 'Alpha' } });
  const off = await signInServer(f);
  try {
    const failed = await s.ask('POST', '/account/forgot', { headers: s.json, body: { email: s.email } });
    const none = await off.ask('POST', '/account/forgot', { headers: off.json, body: { email: s.email } });
    assert.equal(failed.status, 200);
    assert.equal(failed.text, none.text);
    assert.ok(f.lines.some((l) => /^reset NOT sent to actor \d+: Resend answered 500; the link was withdrawn$/.test(l)), f.lines.join('\n'));
    assert.ok(f.lines.some((l) => /^reset NOT sent to actor \d+: RESEND_API_KEY is not in Doppler/.test(l)));
    assert.equal((await s.ask('POST', '/account/forgot', { headers: s.json, body: {} })).status, 400);
  } finally { await s.close(); await off.close(); await f.cleanup(); }
});

test('no password and no session token ever reaches the server log', async () => {
  const f = await fixture();
  const sent = [];
  const s = await signInServer(f, { accountMail: { send: async (m) => { sent.push(m); }, pageUrl: 'http://tracker.test', productName: 'Alpha' } });
  try {
    const r = await s.signIn({ email: s.email, password: s.password });
    const session = cookieOf(r.cookie).split('=')[1];
    for (let i = 0; i < 6; i++) await s.signIn({ email: s.email, password: `a wrong secret ${i}` });
    await s.ask('GET', '/me', { headers: { cookie: `tracker_session=${session}` } });
    await s.ask('POST', '/account/forgot', { headers: s.json, body: { email: s.email } });
    await s.ask('POST', '/signout', { headers: { ...s.json, cookie: `tracker_session=${session}` }, body: {} });
    const resetToken = decodeURIComponent(/link=([^\s]+)/.exec(sent[0].text)[1]);
    const log = f.lines.join('\n');
    for (const secret of [s.password, session, resetToken, ...Array.from({ length: 6 }, (_, i) => `a wrong secret ${i}`)]) {
      assert.ok(!log.includes(secret), `the log carries a secret: ${secret.slice(0, 6)}…`);
    }
    assert.ok(f.lines.includes(`signed in actor=${f.human.id}`));
    assert.ok(f.lines.includes(`GET /me 200 actor=${f.human.id}`));
  } finally { await s.close(); await f.cleanup(); }
});
