import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.mjs';
import { SOURCE as IMPORT_SOURCE } from './import.mjs';
import { startServer, settingsFromEnv, setupSettingsOf, viaPublicAddress, failureCounter, outsidePageUrl } from './server.mjs';
import { DANE_FIELDS, STEPS } from '../scripts/onboard/onboard.mjs';
import loopStatuses from '../lib/loopStatuses.js';

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
  async function serve(s = store, options = {}) {
    const server = await startServer({ store: s, port: 0, log: (line) => lines.push(line), ...options });
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
      assert.equal((await f.call('GET', '/reports', { token })).status, 401);
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

test('POST /projects/:slug/tickets/check names the project the words fit better, or none, and writes nothing', async () => {
  const f = await fixture();
  try {
    f.store.createProject({ slug: 'game', name: 'Starfield', prefix: 'GA', operator: f.human.id });
    for (const name of ['Spaceship engine sound cuts out', 'Spaceship warp drive crashes', 'Warp drive trail looks flat']) {
      f.store.fileTicket({ project: 'game', name, status: 'queued', actor: f.machine.id });
    }
    for (const name of ['Tasks page search box finds nothing', 'Add Task box loses its text', 'Tasks page columns too narrow']) {
      f.store.fileTicket({ project: 'alpha', name, status: 'queued', actor: f.machine.id });
    }
    const before = JSON.stringify([f.store.listTickets('alpha'), f.store.listTickets('game'), f.store.listEvents('AL-1')]);

    const elsewhere = await f.call('POST', '/projects/alpha/tickets/check', { token: f.humanToken, body: { name: 'Spaceship warp drive stutters', description: 'and the engine sound' } });
    assert.equal(elsewhere.status, 200, elsewhere.text);
    assert.deepEqual(elsewhere.body, { suggest: { slug: 'game', name: 'Starfield' } });
    const here = await f.call('POST', '/projects/alpha/tickets/check', { token: f.humanToken, body: { name: 'Tasks page search box is slow', description: '' } });
    assert.deepEqual(here.body, { suggest: null });
    const nothing = await f.call('POST', '/projects/game/tickets/check', { token: f.humanToken, body: { name: 'Quarterly invoice' } });
    assert.deepEqual(nothing.body, { suggest: null });

    // Refused: an unknown project, a field it does not read, words that are not text, no token.
    assert.equal((await f.call('POST', '/projects/nowhere/tickets/check', { body: { name: 'x' } })).status, 404);
    assert.equal((await f.call('POST', '/projects/alpha/tickets/check', { body: { name: 'x', status: 'queued' } })).status, 400);
    assert.equal((await f.call('POST', '/projects/alpha/tickets/check', { body: { name: 7 } })).status, 400);
    assert.equal((await f.call('POST', '/projects/alpha/tickets/check', { token: null, body: { name: 'x' } })).status, 401);

    assert.equal(JSON.stringify([f.store.listTickets('alpha'), f.store.listTickets('game'), f.store.listEvents('AL-1')]), before, 'the check wrote nothing');
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

test('an old ClickUp id the importer mapped reads, changes and deletes the ticket it became; an unmapped id is still a 404 (SP-157)', async () => {
  const f = await fixture();
  try {
    const t = f.store.importTicket({
      source: IMPORT_SOURCE, sourceId: '86bcold1', createdAt: '2026-01-02T03:04:05.000Z',
      project: 'alpha', actor: f.machine.id, name: 'Imported', status: 'queued', priority: 'normal',
    });
    const byOld = await f.call('GET', '/tickets/86bcold1');
    assert.equal(byOld.status, 200, byOld.text);
    const byNew = await f.call('GET', `/tickets/${t.id}`);
    assert.deepEqual(byOld.body, byNew.body);
    assert.equal(byOld.body.id, t.id);
    // The door sends every id upper-cased; ClickUp's are lower case.
    const shouted = await f.call('GET', '/tickets/86BCOLD1');
    assert.equal(shouted.status, 200, shouted.text);
    assert.equal(shouted.body.id, t.id);

    const comment = await f.call('POST', '/tickets/86bcold1/comments', { body: { body: 'by the old id' } });
    assert.equal(comment.status, 201, comment.text);
    assert.equal(comment.body.ticket, t.id);

    for (const id of ['86bcnone', 'AL-999', '%20']) {
      const unknown = await f.call('GET', `/tickets/${id}`);
      assert.equal(unknown.status, 404, id);
      assert.equal(unknown.body.error, 'unknown-ticket');
    }
    // A map row from another source is not a ClickUp id.
    const other = f.store.importTicket({
      source: 'elsewhere', sourceId: '86bcother', createdAt: '2026-01-02T03:04:05.000Z',
      project: 'alpha', actor: f.machine.id, name: 'Other', status: 'queued', priority: 'normal',
    });
    assert.equal((await f.call('GET', '/tickets/86bcother')).status, 404);

    const gone = await f.call('DELETE', '/tickets/86bcold1', { token: f.humanToken });
    assert.equal(gone.status, 200, gone.text);
    assert.equal(gone.body.deleted, t.id);
    assert.equal(f.store.getTicket(t.id), null);
    assert.ok(f.store.getTicket(other.id));
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
      url: 'https://alpha.example', logo: 'https://alpha.example/l.png', owner: f.human.id, repo: null,
      alertEmail: null, alertPhone: null,
    });
    const listed = (await f.call('GET', '/projects')).body.projects.find((p) => p.slug === 'alpha');
    assert.equal(listed.name, 'Alpha Two');
  } finally { await f.cleanup(); }
});

test("a project's alert email and phone save for a person, read back on GET, clear when empty; a loop never sees them", async () => {
  const f = await fixture();
  try {
    const r = await f.call('PATCH', '/projects/alpha', {
      token: f.humanToken, body: { alertEmail: 'alpha-alerts@example.com', alertPhone: '+1 (801) 555-0123' },
    });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.alertEmail, r.body.alertPhone], ['alpha-alerts@example.com', '+18015550123']);
    const again = await f.call('GET', '/projects/alpha', { token: f.humanToken });
    assert.deepEqual([again.body.alertEmail, again.body.alertPhone], ['alpha-alerts@example.com', '+18015550123']);
    const loop = await f.call('GET', '/projects/alpha');
    assert.equal(loop.status, 200);
    assert.ok(!('alertEmail' in loop.body) && !('alertPhone' in loop.body), 'a loop is not shown them');
    const listed = (await f.call('GET', '/projects', { token: f.humanToken })).body.projects.find((p) => p.slug === 'alpha');
    assert.ok(!('alertEmail' in listed) && !('alertPhone' in listed), 'not in the projects table');
    const cleared = await f.call('PATCH', '/projects/alpha', { token: f.humanToken, body: { alertEmail: '', alertPhone: '' } });
    assert.deepEqual([cleared.body.alertEmail, cleared.body.alertPhone], [null, null]);
    const made = await f.call('POST', '/projects', {
      token: f.humanToken, body: { name: 'Beta', slug: 'beta', prefix: 'BE', alertEmail: 'beta@example.com', alertPhone: '+44 20 7946 0000' },
    });
    assert.equal(made.status, 201);
    assert.deepEqual([made.body.alertEmail, made.body.alertPhone], ['beta@example.com', '+442079460000']);
  } finally { await f.cleanup(); }
});

test('a malformed alert email or phone is refused (400) with a message naming the field, and nothing is written', async () => {
  const f = await fixture();
  try {
    f.store.updateProject('alpha', { alertEmail: 'kept@example.com', alertPhone: '+15555550100' });
    const before = f.store.getProject('alpha');
    for (const [body, error, named] of [
      [{ alertEmail: 'no-at-sign.example.com' }, 'bad-alert-email', /alert email/],
      [{ alertEmail: 'two@at@example.com' }, 'bad-alert-email', /alert email/],
      [{ alertEmail: 'nodot@example' }, 'bad-alert-email', /alert email/],
      [{ alertPhone: '801 555 012' }, 'bad-alert-phone', /alert phone/],
      [{ alertPhone: '801 555 0123 4' }, 'bad-alert-phone', /alert phone/],
      [{ alertPhone: '+1 555' }, 'bad-alert-phone', /alert phone/],
      [{ alertPhone: '+1 555 0100 0100 0100 01' }, 'bad-alert-phone', /alert phone/],
      [{ alertPhone: '+1 555 CALL ME' }, 'bad-alert-phone', /alert phone/],
      [{ name: 'Changed', alertPhone: 'nope' }, 'bad-alert-phone', /alert phone/],
    ]) {
      const r = await f.call('PATCH', '/projects/alpha', { token: f.humanToken, body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, error, JSON.stringify(body));
      assert.match(r.body.message, named, JSON.stringify(body));
    }
    assert.deepEqual(f.store.getProject('alpha'), before);
    const made = await f.call('POST', '/projects', { token: f.humanToken, body: { name: 'Beta', slug: 'beta', prefix: 'BE', alertEmail: 'bad' } });
    assert.equal(made.status, 400);
    assert.equal(f.store.getProject('beta'), null);
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
    const site = run('create-actor', '--kind', 'machine', '--name', 'Site page', '--site-url', 'https://site.example/spirality');
    assert.equal(site.status, 0, site.stderr);
    assert.match(site.stderr, /a site at https:\/\/site\.example\/spirality/);
    assert.match(site.stdout, /^[A-Za-z0-9_-]{40,}\n$/);
    for (const [kind, url] of [['machine', 'http://site.example/x'], ['human', 'https://site.example/x']]) {
      const refused = run('create-actor', '--kind', kind, '--name', 'Nope', '--site-url', url);
      assert.notEqual(refused.status, 0, `${kind} ${url}`);
      assert.equal(refused.stdout, '', 'no token for a refused site');
    }

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
      assert.deepEqual(store.listSites(), [{ id: 3, name: 'Site page', url: 'https://site.example/spirality' }]);
      assert.deepEqual(store.listActors().map((a) => a.name), ['Build loop', 'Operator', 'Site page'], 'a refused site made no actor');
      assert.deepEqual(store.getProject('beta'), { slug: 'beta', name: 'Beta', prefix: 'BE', operator: 2, url: null, logo: null, owner: null, repo: null, alertEmail: null, alertPhone: null });
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

test('the server, admin and backup hard-code no project: no names, ids, prefixes or ports in their source', () => {
  for (const file of ['./server.mjs', './setup.mjs', './admin.mjs', './backup.mjs']) {
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
    const { canEditMembers, ...read } = (await f.call('GET', '/projects/beta', { token: f.humanToken })).body;
    assert.deepEqual(read, made.body);
    assert.equal(canEditMembers, true);
    // Its creator (who is also its owner here) is its first member.
    assert.deepEqual(made.body.members.map((m) => [m.id, m.addedBy?.id]), [[f.human.id, f.human.id]]);
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

test('GET /people lists the tracker\'s people: humans only, with emails and open invites for a person, names alone for a loop, never a token', async () => {
  const f = await fixture();
  try {
    f.store.setEmail(f.human.id, 'op@example.com');
    const link = f.store.makeLink({ purpose: 'invite', email: 'new@example.com', madeBy: f.human.id });
    const r = await f.call('GET', '/people', { token: f.humanToken });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.people, [{ id: f.human.id, name: 'Operator', email: 'op@example.com', role: 'admin', seesEveryProject: true, projects: [{ slug: 'alpha', name: 'Alpha' }] }]);
    assert.equal(r.body.canEditRoles, true);
    assert.deepEqual(r.body.roles.map((x) => x.name), ['admin', 'editor', 'contributor', 'reviewer', 'viewer']);
    assert.deepEqual(r.body.permissions.map((x) => x.name), ['user.read', 'user.edit', 'ticket.read', 'ticket.create', 'ticket.edit', 'ticket.delete']);
    assert.deepEqual(r.body.invites.map((i) => [i.email, i.invitedBy.name]), [['new@example.com', 'Operator']]);
    assert.ok(!r.text.includes(link.token));
    const loop = await f.call('GET', '/people');
    assert.deepEqual(loop.body, { people: [{ id: f.human.id, name: 'Operator' }] });
    for (const token of f.tokens) assert.ok(!r.text.includes(token));
    assert.equal((await f.call('GET', '/people', { token: null })).status, 401);
  } finally { await f.cleanup(); }
});

test('PUT /people/<id>/role: an admin changes a person\'s role, read back on GET /people; a non-admin and a loop get 403, the last admin 409, and nothing changes', async () => {
  const f = await fixture();
  try {
    const other = f.store.createActor({ kind: 'human', name: 'Other' });
    const otherToken = f.store.issueToken(other.id);
    const roleIn = async (id) => (await f.call('GET', '/people', { token: f.humanToken })).body.people.find((p) => p.id === id).role;
    assert.equal(await roleIn(other.id), 'contributor');
    // Only an admin sees every project; the Users page says so from this flag (SP-197).
    const everyIn = async (id) => (await f.call('GET', '/people', { token: f.humanToken })).body.people.find((p) => p.id === id).seesEveryProject;
    assert.equal(await everyIn(other.id), false);
    assert.equal(await everyIn(f.human.id), true);

    const ok = await f.call('PUT', `/people/${other.id}/role`, { token: f.humanToken, body: { role: 'reviewer' } });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(ok.body, { id: other.id, role: 'reviewer' });
    assert.equal(await roleIn(other.id), 'reviewer');

    // A non-admin is refused, and sees no picker.
    const notAdmin = await f.call('PUT', `/people/${f.human.id}/role`, { token: otherToken, body: { role: 'viewer' } });
    assert.equal(notAdmin.status, 403);
    assert.equal(notAdmin.body.error, 'not-admin');
    assert.equal((await f.call('GET', '/people', { token: otherToken })).body.canEditRoles, false);
    // A loop's token is refused before anything is read.
    const loop = await f.call('PUT', `/people/${other.id}/role`, { body: { role: 'admin' } });
    assert.equal(loop.status, 403);
    assert.equal(loop.body.error, 'people-only');
    // The only admin cannot step down; the reason is plain words.
    const last = await f.call('PUT', `/people/${f.human.id}/role`, { token: f.humanToken, body: { role: 'viewer' } });
    assert.equal(last.status, 409);
    assert.equal(last.body.error, 'last-admin');
    assert.match(last.body.message, /only admin/);
    // A bad role, an unknown person, a machine, a stray field: refused.
    assert.equal((await f.call('PUT', `/people/${other.id}/role`, { token: f.humanToken, body: { role: 'boss' } })).body.error, 'bad-role');
    assert.equal((await f.call('PUT', `/people/${other.id}/role`, { token: f.humanToken, body: {} })).status, 400);
    assert.equal((await f.call('PUT', `/people/${other.id}/role`, { token: f.humanToken, body: { role: 'viewer', extra: 1 } })).body.error, 'bad-field');
    assert.equal((await f.call('PUT', '/people/9999/role', { token: f.humanToken, body: { role: 'viewer' } })).status, 404);
    assert.equal((await f.call('PUT', `/people/${f.machine.id}/role`, { token: f.humanToken, body: { role: 'viewer' } })).status, 404);
    assert.equal((await f.call('PUT', `/people/${other.id}/role`, { token: null, body: { role: 'viewer' } })).status, 401);
    // Nothing those refusals asked for happened.
    assert.equal(f.store.roleOf(f.human.id), 'admin');
    assert.equal(f.store.roleOf(other.id), 'reviewer');
    assert.equal(f.store.roleOf(f.machine.id), null);
    // The role is recorded, not enforced: the viewer-to-be, on the project, still files a ticket.
    f.store.addMember({ project: 'alpha', actor: other.id, by: f.human.id });
    f.store.setRole({ actor: other.id, role: 'viewer', by: f.human.id });
    const filed = await f.call('POST', '/projects/alpha/tickets', { token: otherToken, body: { name: 'A viewer files', status: 'Requested' } });
    assert.equal(filed.status, 201, filed.text);
  } finally { await f.cleanup(); }
});

test('GET /projects carries each project\'s operator and members, and says only an admin signed in as a person may change members (the Users and Projects pages)', async () => {
  const f = await fixture();
  try {
    const other = f.store.createActor({ kind: 'human', name: 'Other' });
    const otherToken = f.store.issueToken(other.id);
    const admin = (await f.call('GET', '/projects', { token: f.humanToken })).body;
    assert.equal(admin.canEditMembers, true);
    const alpha = admin.projects.find((p) => p.slug === 'alpha');
    assert.deepEqual(alpha.operator, { id: f.human.id, name: 'Operator' });
    assert.deepEqual(alpha.members, [{ id: f.human.id, name: 'Operator' }], 'just id and name: no added-by or dates in the list');
    // A loop's token sees every project, but may not change members.
    assert.equal((await f.call('GET', '/projects')).body.canEditMembers, false);
    // A non-admin sees only their own projects, so only those projects' members, and no controls.
    f.store.addMember({ project: 'alpha', actor: other.id, by: f.human.id });
    const theirs = (await f.call('GET', '/projects', { token: otherToken })).body;
    assert.equal(theirs.canEditMembers, false);
    assert.deepEqual(theirs.projects.map((p) => [p.slug, p.members.map((m) => m.name)]), [['alpha', ['Operator', 'Other']]]);
  } finally { await f.cleanup(); }
});

test('project members: an admin adds and removes one, answered with the list read back; the owner and operator stay (409); a non-admin and a loop get 403; someone taken off no longer sees it', async () => {
  const f = await fixture();
  try {
    const other = f.store.createActor({ kind: 'human', name: 'Other' });
    const otherToken = f.store.issueToken(other.id);
    const membersOf = async (token = f.humanToken) => (await f.call('GET', '/projects/alpha', { token })).body.members.map((m) => m.name);
    assert.deepEqual(await membersOf(), ['Operator']);

    const added = await f.call('POST', '/projects/alpha/members', { token: f.humanToken, body: { person: other.id } });
    assert.equal(added.status, 201, added.text);
    assert.deepEqual(added.body.members.map((m) => m.name), ['Operator', 'Other']);
    assert.deepEqual(await membersOf(), ['Operator', 'Other']);
    assert.deepEqual((await f.call('GET', '/people', { token: f.humanToken })).body.people.find((p) => p.id === other.id).projects, [{ slug: 'alpha', name: 'Alpha' }]);
    assert.equal((await f.call('POST', '/projects/alpha/members', { token: f.humanToken, body: { person: other.id } })).status, 409);

    // A non-admin is refused, and is told they may not.
    assert.equal((await f.call('GET', '/projects/alpha', { token: otherToken })).body.canEditMembers, false);
    const notAdmin = await f.call('DELETE', `/projects/alpha/members/${other.id}`, { token: otherToken });
    assert.equal(notAdmin.status, 403);
    assert.equal(notAdmin.body.error, 'not-admin');
    // A loop's token is refused before anything is read.
    for (const [method, path, body] of [['POST', '/projects/alpha/members', { person: other.id }], ['DELETE', `/projects/alpha/members/${other.id}`]]) {
      const loop = await f.call(method, path, { body });
      assert.equal(loop.status, 403, `${method} ${path}`);
      assert.equal(loop.body.error, 'people-only');
    }
    assert.equal((await f.call('GET', '/projects/alpha')).body.canEditMembers, false);
    // The operator cannot be removed, with a plain reason.
    const operator = await f.call('DELETE', `/projects/alpha/members/${f.human.id}`, { token: f.humanToken });
    assert.equal(operator.status, 409);
    assert.equal(operator.body.error, 'required-member');
    assert.match(operator.body.message, /operator/);
    // A machine, an unknown person, an unknown project, a stray field: refused.
    assert.equal((await f.call('POST', '/projects/alpha/members', { token: f.humanToken, body: { person: f.machine.id } })).status, 404);
    assert.equal((await f.call('POST', '/projects/alpha/members', { token: f.humanToken, body: { person: 9999 } })).status, 404);
    assert.equal((await f.call('POST', '/projects/alpha/members', { token: f.humanToken, body: {} })).status, 400);
    assert.equal((await f.call('POST', '/projects/alpha/members', { token: f.humanToken, body: { person: other.id, extra: 1 } })).body.error, 'bad-field');
    assert.equal((await f.call('POST', '/projects/nope/members', { token: f.humanToken, body: { person: other.id } })).status, 404);
    assert.equal((await f.call('DELETE', '/projects/alpha/members/x', { token: f.humanToken })).status, 404);
    assert.equal((await f.call('DELETE', `/projects/alpha/members/${other.id}`, { token: null })).status, 401);
    assert.deepEqual(await membersOf(), ['Operator', 'Other'], 'no refusal changed anything');

    const removed = await f.call('DELETE', `/projects/alpha/members/${other.id}`, { token: f.humanToken });
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual(removed.body.members.map((m) => m.name), ['Operator']);
    assert.equal((await f.call('DELETE', `/projects/alpha/members/${other.id}`, { token: f.humanToken })).status, 404);
    // Membership is enforced: someone on no project sees none, and cannot file in it.
    assert.equal((await f.call('GET', '/projects', { token: otherToken })).body.projects.length, 0);
    assert.equal((await f.call('GET', '/projects/alpha/board', { token: otherToken })).status, 404);
    const filed = await f.call('POST', '/projects/alpha/tickets', { token: otherToken, body: { name: 'Not a member files', status: 'Requested' } });
    assert.equal(filed.status, 404, filed.text);
    assert.equal(f.store.listTickets('alpha').length, 0, 'nothing was filed');
    assert.ok(f.lines.some((l) => /removed member \d+ from alpha actor=1/.test(l)));
  } finally { await f.cleanup(); }
});

test('strict membership: a person who is not an admin sees only their own projects and tickets, everywhere; another project\'s ticket is 404, the same as one that does not exist; an admin and a loop see everything', async () => {
  const f = await fixture();
  try {
    f.store.createProject({ slug: 'beta', name: 'Beta', prefix: 'BE', operator: f.human.id });
    const viewer = f.store.createActor({ kind: 'human', name: 'Viewer' });
    const vt = f.store.issueToken(viewer.id);
    f.store.setRole({ actor: viewer.id, role: 'viewer', by: f.human.id });
    f.store.addMember({ project: 'alpha', actor: viewer.id, by: f.human.id });
    const mine = f.store.fileTicket({ project: 'alpha', actor: f.human.id, name: 'Shared comet', status: 'queued' });
    const theirs = f.store.fileTicket({ project: 'beta', actor: f.human.id, name: 'Hidden comet', status: 'Needs your input', assignee: f.human.id });
    f.store.postComment({ ticket: theirs.id, author: f.machine.id, body: 'comet notes', parent: null });
    const theirFile = f.store.addAttachment({ ticket: theirs.id, name: 'comet.txt', type: 'text/plain', bytes: Buffer.from('c'), actor: f.human.id });
    const as = (token) => (method, path, body) => f.call(method, path, { token, body });
    const v = as(vt);

    // Projects, search and reporting: only alpha and its ticket.
    assert.deepEqual((await v('GET', '/projects')).body.projects.map((p) => p.slug), ['alpha']);
    assert.deepEqual((await v('GET', '/search?q=comet')).body.results.map((r) => r.id), [mine.id]);
    assert.equal((await v('GET', '/reports')).body.started.all, 1);
    assert.deepEqual((await v('GET', '/people')).body.people.find((p) => p.id === f.human.id).projects.map((p) => p.slug), ['alpha']);
    const w = (await v('GET', '/waiting')).body;
    assert.equal(w.waiting.length + w.unsure.length, 0);
    assert.equal((await v('GET', '/projects/alpha/board')).status, 200);
    assert.equal((await v('GET', `/tickets/${mine.id}/thread`)).status, 200);

    // Another project's ticket and the project itself: 404, word for word the same as one that does not exist.
    const ghost = 'BE-999';
    const reads = [
      ['GET', '/projects/beta'], ['GET', '/projects/beta/board'], ['GET', '/projects/beta/tickets'],
      ['POST', '/projects/beta/tickets', { name: 'Sneak in', status: 'Requested' }],
      ['POST', '/projects/beta/tickets/check', { name: 'x' }], ['GET', '/reports?project=beta'],
      ['GET', `/tickets/${theirs.id}`], ['GET', `/tickets/${theirs.id}/thread`], ['GET', `/tickets/${theirs.id}/events`],
      ['GET', `/tickets/${theirs.id}/attachments`], ['GET', `/tickets/${theirs.id}/attachments/1`], ['GET', '/projects/beta/attachments'],
      ['PATCH', `/tickets/${theirs.id}/attachments/${theirFile.id}`, { name: 'renamed.txt' }], ['DELETE', `/tickets/${theirs.id}/attachments/${theirFile.id}`],
      ['PATCH', `/tickets/${theirs.id}`, { name: 'Renamed' }], ['DELETE', `/tickets/${theirs.id}`],
      ['POST', `/tickets/${theirs.id}/comments`, { body: 'hello' }], ['POST', `/tickets/${theirs.id}/clone`, { project: 'alpha' }],
    ];
    for (const [method, path, body] of reads) {
      const r = await v(method, path, body);
      assert.equal(r.status, 404, `${method} ${path}: ${r.text}`);
      assert.equal(r.body.yourProjectsOnly, true, `${method} ${path}`);
      assert.ok(!r.text.includes('Hidden comet') && !r.text.includes('Beta'), `${method} ${path} gives nothing of it away`);
      const missing = await v(method, path.replace(theirs.id, ghost).replace('beta', 'nope'), body);
      assert.equal(missing.status, 404, `${method} ${path} (missing)`);
      assert.equal(missing.text.replace(ghost, theirs.id).replace('nope', 'beta'), r.text, `${method} ${path}: the same answer as one that does not exist`);
    }
    // Copying their own ticket into another project is refused the same way.
    assert.equal((await v('POST', `/tickets/${mine.id}/clone`, { project: 'beta' })).status, 404);
    // Nothing those refusals asked for happened.
    assert.deepEqual(f.store.listTickets('beta').map((t) => [t.id, t.name]), [[theirs.id, 'Hidden comet']]);
    assert.equal(f.store.listComments(theirs.id).length, 1);
    assert.deepEqual(f.store.listAttachments(theirs.id).map((a) => a.name), ['comet.txt'], 'their file is neither renamed nor removed');
    assert.deepEqual(f.store.listTickets('alpha').map((t) => t.id), [mine.id]);

    // An admin and a loop see everything, as before.
    for (const call of [as(f.humanToken), as(f.machineToken)]) {
      assert.deepEqual((await call('GET', '/projects')).body.projects.map((p) => p.slug), ['alpha', 'beta']);
      assert.deepEqual((await call('GET', '/search?q=comet')).body.results.map((r) => r.id).sort(), [mine.id, theirs.id].sort());
      const t = await call('GET', `/tickets/${theirs.id}`);
      assert.equal(t.status, 200);
      assert.equal(t.body.name, 'Hidden comet');
      const none = await call('GET', `/tickets/${ghost}`);
      assert.equal(none.status, 404);
      assert.equal(none.body.yourProjectsOnly, undefined, 'a 404 to someone who sees everything means there is none');
    }
    const listed = (w) => [...w.waiting, ...w.unsure].map((x) => x.id);
    assert.ok(listed((await as(f.humanToken)('GET', '/waiting')).body).includes(theirs.id), 'the admin\'s Waiting on you still lists it');

    // Added to beta, the viewer sees it at once; taken off, it is gone again.
    f.store.addMember({ project: 'beta', actor: viewer.id, by: f.human.id });
    assert.deepEqual((await v('GET', '/projects')).body.projects.map((p) => p.slug), ['alpha', 'beta']);
    assert.equal((await v('GET', `/tickets/${theirs.id}`)).status, 200);
    f.store.removeMember({ project: 'beta', actor: viewer.id, by: f.human.id });
    assert.equal((await v('GET', `/tickets/${theirs.id}`)).status, 404);
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
    assert.ok(!flags.some((p) => /^secure$/i.test(p)), 'no Secure flag on the home network: the tracker is plain http there');
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

const PUBLIC_URL = 'https://mini.example.ts.net:8443';
/** What Tailscale Funnel adds to every request it hands the tracker. */
const FUNNEL = Object.freeze({ host: 'mini.example.ts.net:8443', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9', 'tailscale-funnel-request': '?1' });

test('through the public address the session cookie carries Secure and every answer carries Strict-Transport-Security; on the home network neither (SP-152)', async () => {
  const f = await fixture();
  const s = await signInServer(f, { publicUrl: PUBLIC_URL });
  try {
    const raw = (path, init = {}) => fetch(`${s.base}${path}`, init);
    // Reached, not signed in: 401, with the header.
    const me = await raw('/me', { headers: FUNNEL });
    assert.equal(me.status, 401);
    assert.equal(me.headers.get('strict-transport-security'), 'max-age=31536000');

    const signin = await raw('/signin', { method: 'POST', headers: { ...FUNNEL, ...s.json }, body: JSON.stringify({ email: s.email, password: s.password }) });
    assert.equal(signin.status, 200);
    const flags = signin.headers.get('set-cookie').split(';').map((p) => p.trim());
    for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Secure']) assert.ok(flags.includes(flag), flag);
    const cookie = flags[0];
    assert.equal((await raw('/me', { headers: { ...FUNNEL, cookie } })).status, 200, 'the Secure cookie signs in through the public address');
    const out = await raw('/signout', { method: 'POST', headers: { ...FUNNEL, ...s.json, cookie }, body: '{}' });
    assert.ok(out.headers.get('set-cookie').split(';').map((p) => p.trim()).includes('Secure'), 'the sign-out cookie matches');

    // The home network: plain http, no Secure, no header, so the Mini's page keeps working.
    const home = await raw('/signin', { method: 'POST', headers: { host: 'mac-mini.local:4180', ...s.json }, body: JSON.stringify({ email: s.email, password: s.password }) });
    assert.equal(home.status, 200);
    assert.ok(!home.headers.get('set-cookie').split(';').some((p) => /^secure$/i.test(p.trim())));
    assert.equal(home.headers.get('strict-transport-security'), null);
    assert.equal((await raw('/me', { headers: { cookie: home.headers.get('set-cookie').split(';')[0] } })).status, 200);
  } finally { await s.close(); await f.cleanup(); }
});

test('forwarded from another https name (spirality.alphire.agency), the sign-in cookie names no Domain, so the browser keeps it for that name, and it signs the page in (SP-164)', async () => {
  const f = await fixture();
  const s = await signInServer(f, { publicUrl: PUBLIC_URL });
  try {
    // A forwarding site passes the request on to the Funnel address; Funnel adds its marks.
    const forwarded = { ...FUNNEL, 'x-forwarded-host': 'tracker.example.com' };
    const signin = await fetch(`${s.base}/signin`, { method: 'POST', headers: { ...forwarded, ...s.json }, body: JSON.stringify({ email: s.email, password: s.password }) });
    assert.equal(signin.status, 200);
    const flags = signin.headers.get('set-cookie').split(';').map((p) => p.trim());
    assert.ok(!flags.some((p) => /^domain=/i.test(p)), 'no Domain: the cookie belongs to whichever name the browser opened');
    assert.ok(flags.includes('Path=/') && flags.includes('Secure'));
    const cookie = flags[0];
    for (const path of ['/me', '/projects']) {
      assert.equal((await fetch(`${s.base}${path}`, { headers: { ...forwarded, cookie } })).status, 200, `${path} signed in through the forwarded name`);
    }
    const page = await fetch(`${s.base}/`, { headers: { ...forwarded, accept: 'text/html', cookie }, redirect: 'manual' });
    assert.equal(page.status, 200);
  } finally { await s.close(); await f.cleanup(); }
});

test('the invite and reset emails link to trackerPageUrl when it is set, else to the shared address (SP-164)', () => {
  assert.equal(outsidePageUrl({ trackerPageUrl: 'https://tracker.example.com', shared: 'http://mini.local:4180' }), 'https://tracker.example.com');
  assert.equal(outsidePageUrl({ trackerPageUrl: null, shared: 'http://mini.local:4180' }), 'http://mini.local:4180');
  assert.equal(outsidePageUrl({ shared: 'http://mini.local:4180' }), 'http://mini.local:4180');
});

test('any one of Funnel\'s marks makes a request public: the https proto, the Funnel header, or the public name as Host (SP-152)', () => {
  const host = 'mini.example.ts.net:8443';
  const req = (headers) => ({ headers });
  assert.equal(viaPublicAddress(req({ 'x-forwarded-proto': 'https' }), host), true);
  assert.equal(viaPublicAddress(req({ 'x-forwarded-proto': 'HTTPS, http' }), host), true);
  assert.equal(viaPublicAddress(req({ 'tailscale-funnel-request': '?1' }), host), true);
  assert.equal(viaPublicAddress(req({ host: 'Mini.Example.ts.net:8443' }), host), true);
  assert.equal(viaPublicAddress(req({ host: 'mac-mini.local:4180' }), host), false);
  assert.equal(viaPublicAddress(req({ host: '127.0.0.1:4180', 'x-forwarded-proto': 'http' }), host), false);
  assert.equal(viaPublicAddress(req({ host }), null), false, 'no public address set: the Host alone means nothing');
});

test('through the public address the page and its redirects answer as at home, with Strict-Transport-Security, and the API is unchanged (SP-162)', async () => {
  const f = await fixture();
  const s = await signInServer(f, { publicUrl: PUBLIC_URL });
  try {
    const html = { accept: 'text/html' };
    for (const path of ['/', '/board', '/list/alpha', '/t/SP-1', '/projects', '/users', '/settings']) {
      const r = await fetch(`${s.base}${path}`, { headers: { ...FUNNEL, ...html }, redirect: 'manual' });
      assert.equal(r.status, 200, `${path} answered ${r.status}`);
      assert.match(r.headers.get('content-type'), /^text\/html/, `${path} is the page`);
      assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000', `${path} carries HSTS`);
      const text = await r.text();
      assert.ok(!/(src|href)="https?:/i.test(text.replace(/<a [^>]*target="_blank"[^>]*>/g, '')), `${path}: every address in the page is relative to the name it was served under`);
    }
    const script = await fetch(`${s.base}/web/app.mjs`, { headers: FUNNEL });
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    const old = await fetch(`${s.base}/people`, { headers: { ...FUNNEL, ...html }, redirect: 'manual' });
    assert.equal(old.status, 302);
    assert.equal(old.headers.get('location'), '/users', 'the redirect is relative, so it stays on whichever name forwarded it');

    // Signed out, the page is only the page: every data call still needs a session.
    for (const path of ['/me', '/projects/alpha/tickets', '/people', '/waiting']) {
      const r = await fetch(`${s.base}${path}`, { headers: FUNNEL });
      assert.equal(r.status, 401, `${path} answered ${r.status} signed out`);
      assert.match(r.headers.get('content-type'), /application\/json/);
    }
    // A data call that does not ask for HTML still gets the data, not the page.
    const signin = await fetch(`${s.base}/signin`, { method: 'POST', headers: { ...FUNNEL, ...s.json }, body: JSON.stringify({ email: s.email, password: s.password }) });
    const flags = signin.headers.get('set-cookie').split(';').map((p) => p.trim());
    assert.ok(flags.includes('Secure'));
    assert.ok(!flags.some((p) => /^domain=/i.test(p)), 'no Domain: the browser keeps the cookie for whichever name served the page');
    const people = await fetch(`${s.base}/people`, { headers: { ...FUNNEL, cookie: flags[0] } });
    assert.equal(people.status, 200);
    assert.match(people.headers.get('content-type'), /application\/json/);

    // The home network: the page, and no HSTS.
    const home = await fetch(`${s.base}/board`, { headers: html });
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.equal(home.headers.get('strict-transport-security'), null);
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
  const accountMail = { send: async (mail) => { sent.push(mail); }, pageUrl: 'http://tracker.test:4180', projectName: 'Alpha' };
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
  const s = await signInServer(f, { accountMail: { send: async () => { throw new Error('Resend answered 500'); }, pageUrl: 'http://tracker.test', projectName: 'Alpha' } });
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

/** Wait until the log has `count` lines matching `re` (the reset email goes out after the answer). */
async function logged(f, re, count = 1) {
  for (let i = 0; i < 100 && f.lines.filter((l) => re.test(l)).length < count; i++) await new Promise((r) => setTimeout(r, 10));
  return f.lines.filter((l) => re.test(l)).length;
}

test('five wrong passwords through the public address lock only the public door: the home network still signs that person in (SP-152)', async () => {
  const f = await fixture();
  let clock = Date.parse('2026-11-06T18:00:00Z');
  const s = await signInServer(f, { now: () => clock, publicUrl: 'https://mini.example.ts.net:8443' });
  const outside = (b) => s.ask('POST', '/signin', { headers: { ...s.json, ...FUNNEL }, body: b });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await outside({ email: s.email, password: `wrong ${i}` })).status, 401);
    assert.equal((await outside({ email: s.email, password: s.password })).status, 429, 'the public door is locked');
    assert.ok(f.lines.includes('sign-in refused: that email is locked for 15 minutes after 5 failures (public door)'), f.lines.join('\n'));
    const home = await s.signIn({ email: s.email, password: s.password });
    assert.equal(home.status, 200, 'the Mini\'s page is not locked out by tries from the internet');

    // And the other way round: the home door's lock does not close the public one.
    clock += 16 * 60_000;
    for (let i = 0; i < 5; i++) assert.equal((await s.signIn({ email: s.email, password: `wrong ${i}` })).status, 401);
    assert.equal((await s.signIn({ email: s.email, password: s.password })).status, 429);
    assert.equal((await outside({ email: s.email, password: s.password })).status, 200);
  } finally { await s.close(); await f.cleanup(); }
});

test('the sign-in failure count drops emails whose window and lock have both passed, so random emails never pile up (SP-152)', () => {
  let clock = 0;
  const failures = failureCounter(() => clock);
  for (let i = 0; i < 50; i++) failures.failed('public', `random${i}@example.com`);
  clock += 10 * 60_000;
  for (let i = 0; i < 5; i++) failures.failed('public', 'locked@example.com');
  assert.equal(failures.size(), 51);
  clock += 6 * 60_000;
  failures.failed('public', 'one.more@example.com');
  assert.equal(failures.size(), 2, 'only the newest try and the lock still running are kept');
  assert.equal(failures.locked('public', 'locked@example.com'), true);
  assert.equal(failures.locked('home', 'locked@example.com'), false);
  clock += 15 * 60_000;
  failures.failed('home', 'last@example.com');
  assert.equal(failures.size(), 1, 'a lock that has run out is dropped too');
});

test('reset emails are limited: one per account every 15 minutes, 4 a day, 20 an hour per door, and the answer never changes (SP-152)', async () => {
  const f = await fixture();
  let clock = Date.parse('2026-11-06T18:00:00Z');
  const sent = [];
  const accountMail = { send: async (mail) => { sent.push(mail); }, pageUrl: 'http://tracker.test:4180', projectName: 'Alpha' };
  const s = await signInServer(f, { now: () => clock, accountMail, publicUrl: 'https://mini.example.ts.net:8443' });
  const forgot = (email, headers = {}) => s.ask('POST', '/account/forgot', { headers: { ...s.json, ...headers }, body: { email } });
  try {
    const first = await forgot(s.email, FUNNEL);
    await logged(f, /^reset link sent/);
    const again = await forgot(s.email.toUpperCase(), FUNNEL);
    await logged(f, /^reset NOT sent/);
    assert.equal(again.status, 200);
    assert.equal(again.text, first.text, 'a refused reset answers word for word the same');
    assert.equal(sent.length, 1, 'a second email within 15 minutes is not sent');
    assert.ok(f.lines.includes(`reset NOT sent to actor ${f.human.id}: one was sent to that account less than 15 minutes ago (public door)`), f.lines.join('\n'));

    // 4 a day: two more 15 minutes apart, then the fifth in the day is refused.
    for (let i = 0; i < 3; i++) { clock += 16 * 60_000; await forgot(s.email); await logged(f, /^reset link sent/, 2 + i); }
    assert.equal(sent.length, 4);
    clock += 16 * 60_000;
    await forgot(s.email);
    assert.equal(await logged(f, /in the last 24 hours/), 1);
    assert.equal(sent.length, 4);
    clock += 24 * 60 * 60_000;
    await forgot(s.email);
    await logged(f, /^reset link sent/, 5);
    assert.equal(sent.length, 5, 'a day later it sends again');

    // Made-up emails send nothing and use up nothing.
    for (let i = 0; i < 30; i++) await forgot(`nobody${i}@example.com`, FUNNEL);
    await logged(f, /no account; nothing sent/, 30);

    // 20 an hour through one door, across many accounts; the home door keeps its own 20.
    const people = Array.from({ length: 21 }, (_, i) => {
      const p = f.store.createActor({ kind: 'human', name: `Person ${i}` });
      f.store.setEmail(p.id, `person${i}@example.com`);
      return p;
    });
    clock += 2 * 60 * 60_000;
    const before = sent.length;
    for (const [i] of people.entries()) await forgot(`person${i}@example.com`, FUNNEL);
    assert.equal(await logged(f, /20 went out through this door in the last hour \(public door\)$/), 1);
    assert.equal(sent.length - before, 20);
    await forgot('person20@example.com');
    await logged(f, /^reset link sent/, 5 + 21);
    assert.equal(sent.length - before, 21, 'the home door is not used up by the public one');
  } finally { await s.close(); await f.cleanup(); }
});

test('no password and no session token ever reaches the server log', async () => {
  const f = await fixture();
  const sent = [];
  const s = await signInServer(f, { accountMail: { send: async (m) => { sent.push(m); }, pageUrl: 'http://tracker.test', projectName: 'Alpha' } });
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

test('GET /reports answers the Reporting figures for every project or one, 404 for an unknown one, and writes nothing', async () => {
  const f = await fixture();
  try {
    const t = f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: 'x', status: 'queued' });
    f.store.changeTicket(t.id, { actor: f.machine.id, status: 'live' });
    for (const path of ['/reports', '/reports?project=alpha', '/reports?project=']) {
      const r = await f.call('GET', path);
      assert.equal(r.status, 200, path);
      assert.deepEqual(r.body.finished, { week: 1, month: 1, all: 1 }, path);
      assert.deepEqual(r.body.started, { week: 1, month: 1, all: 1 }, path);
      assert.deepEqual(r.body.humanHours.week, { finished: 1, estimated: 0, notEstimated: 1, hours: null, days: 7, perDay: null }, path);
    }
    assert.equal((await f.call('GET', '/reports?project=alpha')).body.projectName, 'Alpha');
    const unknown = await f.call('GET', '/reports?project=nope');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, 'unknown-project');
    assert.equal(f.store.getTicket(t.id).version, 2);
  } finally { await f.cleanup(); }
});

test('GET /reports answers Where the Time Goes: the four buckets per range and the open ticket by its exact name (SP-220)', async () => {
  const f = await fixture();
  try {
    const t = f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: 'An open one', status: 'queued' });
    await new Promise((resolve) => setTimeout(resolve, 20)); // so it has been open a while when the figures are read
    const r = await f.call('GET', '/reports?project=alpha');
    assert.equal(r.status, 200);
    for (const key of ['week', 'month', 'all']) {
      const split = r.body.timeSplit[key];
      assert.deepEqual(Object.keys(split.buckets), ['working', 'lane', 'operator', 'broken'], key);
      assert.ok(split.total > 0, key);
      assert.equal(split.buckets.lane.share, 1, `${key}: its time in Queued, waiting for a lane`);
      assert.deepEqual(split.tickets.map((x) => [x.id, x.name]), [[t.id, 'An open one']], key);
    }
    assert.equal(f.store.getTicket(t.id).version, 1, 'reading the figures writes nothing');
  } finally { await f.cleanup(); }
});

test('GET /search ranks title over description over people\'s comments over loop comments, across every project, and writes nothing', async () => {
  const f = await fixture();
  try {
    f.store.createProject({ slug: 'beta', name: 'Beta', prefix: 'BE', operator: f.human.id });
    const file = (project, name, description = '') => f.store.fileTicket({ project, actor: f.machine.id, name, description, status: 'queued' });
    const loopsOnly = file('alpha', 'Fourth');
    f.store.postComment({ ticket: loopsOnly.id, author: f.machine.id, body: 'PR opened for the widget fix.' });
    const stamped = file('alpha', 'Fifth');
    f.store.postComment({ ticket: stamped.id, author: f.human.id, body: 'Built the widget.\n[machine] posted by a loop under Operator\'s token — not his word' });
    const discussed = file('alpha', 'Third');
    f.store.postComment({ ticket: discussed.id, author: f.human.id, body: 'The WIDGET is broken again.' });
    const described = file('beta', 'Other', `${'Long words before it. '.repeat(10)}the Widget breaks on sign-in.`);
    f.store.changeTicket(described.id, { actor: f.machine.id, status: 'live' });
    const titled = file('alpha', 'Fix the widget page');
    file('alpha', 'Nothing to see');

    const before = f.store.listProjects().flatMap((p) => f.store.listTickets(p.slug))
      .map((t) => [t.id, t.version, t.updatedAt, f.store.listEvents(t.id).length, f.store.listComments(t.id).length]);
    const r = await f.call('GET', '/search?q=widget');
    assert.equal(r.status, 200);
    assert.equal(r.body.query, 'widget');
    const ids = r.body.results.map((x) => x.id);
    assert.deepEqual(ids.slice(0, 3), [titled.id, described.id, discussed.id]);
    assert.deepEqual(ids.slice(3).sort(), [loopsOnly.id, stamped.id].sort());
    const byId = Object.fromEntries(r.body.results.map((x) => [x.id, x]));
    assert.deepEqual([titled, described, discussed, loopsOnly, stamped].map((t) => byId[t.id].score), [8, 4, 2, 1, 1]);
    assert.equal(byId[titled.id].place, null);
    assert.equal(byId[titled.id].excerpt, null);
    assert.equal(byId[described.id].place, 'description');
    assert.equal(byId[described.id].projectName, 'Beta');
    assert.equal(byId[described.id].status, 'Live');
    assert.match(byId[described.id].excerpt, /^….*the Widget breaks on sign-in\.$/);
    assert.ok(byId[described.id].excerpt.length <= 162);
    assert.equal(byId[discussed.id].place, 'discussion');
    assert.equal(byId[loopsOnly.id].place, 'development');
    assert.equal(byId[stamped.id].place, 'development');
    assert.equal(byId[stamped.id].excerpt, 'Built the widget.');

    // One phrase, as typed, any case; regular-expression characters are plain text.
    assert.deepEqual((await f.call('GET', '/search?q=WIDGET%20PAGE')).body.results.map((x) => x.id), [titled.id]);
    assert.deepEqual((await f.call('GET', '/search?q=page%20widget')).body.results, []);
    assert.deepEqual((await f.call('GET', '/search?q=w.dget')).body.results, []);
    for (const empty of ['/search?q=', '/search']) {
      const { query, results } = (await f.call('GET', empty)).body;
      assert.deepEqual({ query, results }, { query: '', results: [] });
    }

    const after = f.store.listProjects().flatMap((p) => f.store.listTickets(p.slug))
      .map((t) => [t.id, t.version, t.updatedAt, f.store.listEvents(t.id).length, f.store.listComments(t.id).length]);
    assert.deepEqual(after, before);
    assert.equal((await f.call('GET', '/search?q=widget', { token: null })).status, 401);
    // A browser opening the address gets the page, without a token; the page then asks for the results.
    const page = await fetch(`${await f.serve()}/search?q=widget`, { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
  } finally { await f.cleanup(); }
});

test('GET /search narrows by Status, Priority, Created by and Assigned to, alone and together, keeping the order', async () => {
  const f = await fixture();
  try {
    const other = f.store.createActor({ kind: 'human', name: 'Someone Else' });
    const file = (actor, name, status, { priority = null, assignee = null } = {}) =>
      f.store.fileTicket({ project: 'alpha', actor, name, status, priority, assignee });
    const a = file(f.machine.id, 'Widget one', 'queued', { priority: 'urgent' });
    const b = file(other.id, 'Widget two', 'queued', { priority: 'low', assignee: f.human.id });
    const c = file(f.machine.id, 'Widget three', 'rework');
    const d = file(other.id, 'Widget four', 'queued');
    f.store.postComment({ ticket: d.id, author: f.human.id, body: 'about the widget' });
    const e = file(f.machine.id, 'Four', 'queued');
    f.store.postComment({ ticket: e.id, author: f.human.id, body: 'the widget again' });
    const ids = async (query) => (await f.call('GET', `/search?q=widget${query}`)).body.results.map((x) => x.id).sort();

    const all = (await f.call('GET', '/search?q=widget')).body;
    assert.deepEqual(all.filters.map((x) => [x.key, x.label, x.value]),
      [['project', 'Project', null], ['status', 'Status', null], ['priority', 'Priority', null], ['createdBy', 'Created by', null], ['assignee', 'Assigned to', null]]);
    assert.deepEqual(all.filters[1].options.map((o) => o.value), loopStatuses.STAGE_ORDER);
    assert.deepEqual(all.filters[2].options.map((o) => o.value), ['urgent', 'high', 'normal', 'low', 'none']);
    assert.deepEqual(all.filters[3].options, [f.human, f.machine, other].map((x) => ({ value: String(x.id), label: x.name })));
    assert.deepEqual(all.filters[4].options[0], { value: 'nobody', label: 'Nobody' });

    assert.deepEqual(await ids('&status=Queued'), [a.id, b.id, d.id, e.id].sort());
    assert.deepEqual(await ids('&status=rework'), [c.id]);
    assert.deepEqual(await ids('&priority=urgent'), [a.id]);
    assert.deepEqual(await ids('&priority=none'), [c.id, d.id, e.id].sort());
    assert.deepEqual(await ids(`&createdBy=${other.id}`), [b.id, d.id].sort());
    assert.deepEqual(await ids(`&assignee=${f.human.id}`), [b.id]);
    assert.deepEqual(await ids('&assignee=nobody'), [a.id, c.id, d.id, e.id].sort());
    assert.deepEqual(await ids(`&status=Queued&priority=none&createdBy=${other.id}&assignee=nobody`), [d.id]);
    assert.deepEqual(await ids('&status=Queued&priority=high'), []);
    assert.deepEqual(await ids('&status=&priority='), [a.id, b.id, c.id, d.id, e.id].sort());

    // The weighted order holds: a title match before a comment match, whatever the filter.
    const ranked = (await f.call('GET', `/search?q=widget&status=Queued&createdBy=${f.machine.id}`)).body;
    assert.deepEqual(ranked.results.map((x) => x.id), [a.id, e.id]);
    assert.deepEqual(ranked.filters.map((x) => x.value), [null, 'Queued', null, String(f.machine.id), null]);

    // Created by is the actor on the `created` event, not whoever changed the ticket last.
    f.store.changeTicket(b.id, { actor: f.machine.id, status: 'rework' });
    assert.deepEqual(await ids(`&createdBy=${other.id}`), [b.id, d.id].sort());

    for (const [query, words] of [
      ['&status=Nonsense', /no status "Nonsense"/],
      ['&priority=whenever', /no priority "whenever"/],
      ['&createdBy=999', /no actor "999"/],
      ['&assignee=someone', /no actor "someone"/],
    ]) {
      const r = await f.call('GET', `/search?q=widget${query}`);
      assert.equal(r.status, 400, query);
      assert.equal(r.body.error, 'unknown-filter');
      assert.match(r.body.message, words);
    }
  } finally { await f.cleanup(); }
});

test('GET /search narrows to one project with Project, offers and answers only the projects the reader may see, and refuses one that is not a choice', async () => {
  const f = await fixture();
  try {
    f.store.createProject({ slug: 'beta', name: 'Beta', prefix: 'BE', operator: f.human.id });
    f.store.createProject({ slug: 'gamma', name: 'Gamma', prefix: 'GA', operator: f.human.id });
    const a = f.store.fileTicket({ project: 'alpha', actor: f.human.id, name: 'Comet in alpha', status: 'queued' });
    const b = f.store.fileTicket({ project: 'beta', actor: f.human.id, name: 'Comet in beta', status: 'queued' });
    const g = f.store.fileTicket({ project: 'gamma', actor: f.human.id, name: 'Comet in gamma', status: 'live' });
    const ids = async (query, token = f.humanToken) => (await f.call('GET', `/search?q=comet${query}`, { token })).body.results.map((x) => x.id).sort();

    // Project comes first, "Any" (no value) plus every project by name.
    const all = (await f.call('GET', '/search?q=comet')).body;
    assert.equal(all.filters[0].key, 'project');
    assert.deepEqual(all.filters[0].options, [{ value: 'alpha', label: 'Alpha' }, { value: 'beta', label: 'Beta' }, { value: 'gamma', label: 'Gamma' }]);
    assert.deepEqual(await ids(''), [a.id, b.id, g.id].sort());
    assert.deepEqual(await ids('&project='), [a.id, b.id, g.id].sort());
    assert.deepEqual(await ids('&project=beta'), [b.id]);
    assert.deepEqual(await ids('&project=gamma'), [g.id], 'closed tickets too');
    assert.deepEqual(await ids('&project=beta&status=Live'), []);
    const chosen = (await f.call('GET', '/search?q=comet&project=alpha')).body;
    assert.equal(chosen.filters[0].value, 'alpha');

    const nosuch = await f.call('GET', '/search?q=comet&project=nosuch');
    assert.equal(nosuch.status, 400);
    assert.equal(nosuch.body.error, 'unknown-filter');
    assert.match(nosuch.body.message, /no project "nosuch"/);

    // A viewer on alpha and beta only: gamma is neither offered nor answered.
    const viewer = f.store.createActor({ kind: 'human', name: 'Viewer' });
    const vt = f.store.issueToken(viewer.id);
    f.store.setRole({ actor: viewer.id, role: 'viewer', by: f.human.id });
    f.store.addMember({ project: 'alpha', actor: viewer.id, by: f.human.id });
    f.store.addMember({ project: 'beta', actor: viewer.id, by: f.human.id });
    const seen = (await f.call('GET', '/search?q=comet', { token: vt })).body;
    assert.deepEqual(seen.filters[0].options.map((o) => o.value), ['alpha', 'beta']);
    assert.ok(!JSON.stringify(seen).includes('Gamma'));
    assert.deepEqual(await ids('&project=beta', vt), [b.id]);
    const hidden = await f.call('GET', '/search?q=comet&project=gamma', { token: vt });
    const missing = await f.call('GET', '/search?q=comet&project=nosuch', { token: vt });
    assert.equal(hidden.status, 400);
    assert.ok(!hidden.text.includes('Comet in gamma'));
    assert.equal(hidden.text.replace('gamma', 'nosuch'), missing.text, 'the same answer as a project that does not exist');
  } finally { await f.cleanup(); }
});

test('GET /search offers the Ticket number field every ticket of the chosen project, closed ones too, or of every project the reader may see, with or without a word', async () => {
  const f = await fixture();
  try {
    f.store.createProject({ slug: 'beta', name: 'Beta', prefix: 'BE', operator: f.human.id });
    f.store.createProject({ slug: 'gamma', name: 'Gamma', prefix: 'GA', operator: f.human.id });
    const a = f.store.fileTicket({ project: 'alpha', actor: f.human.id, name: 'First in alpha', status: 'queued' });
    const a2 = f.store.fileTicket({ project: 'alpha', actor: f.human.id, name: 'Done in alpha', status: 'live' });
    const b = f.store.fileTicket({ project: 'beta', actor: f.human.id, name: 'In beta', status: 'queued' });
    const g = f.store.fileTicket({ project: 'gamma', actor: f.human.id, name: 'In gamma', status: 'live' });
    const before = f.store.listEvents(a.id).length;
    const offered = async (query, token = f.humanToken) => (await f.call('GET', `/search${query}`, { token })).body.tickets;
    const ids = (tickets) => tickets.map((t) => t.id);

    assert.deepEqual(await offered('?project=alpha'), [{ id: a.id, name: 'First in alpha' }, { id: a2.id, name: 'Done in alpha' }], 'Live ones too, with no search word');
    assert.deepEqual(ids(await offered('?q=zzqq&project=beta')), [b.id], 'a word that matches nothing still offers them');
    const any = ids(await offered('?q='));
    for (const t of [a, a2, b, g]) assert.ok(any.includes(t.id), t.id);
    assert.deepEqual(ids(await offered('')), any);

    // A viewer on alpha only: neither beta's nor gamma's tickets are offered.
    const viewer = f.store.createActor({ kind: 'human', name: 'Viewer' });
    const vt = f.store.issueToken(viewer.id);
    f.store.setRole({ actor: viewer.id, role: 'viewer', by: f.human.id });
    f.store.addMember({ project: 'alpha', actor: viewer.id, by: f.human.id });
    const seen = await f.call('GET', '/search', { token: vt });
    assert.deepEqual(ids(seen.body.tickets), [a.id, a2.id]);
    assert.ok(!seen.text.includes('In beta') && !seen.text.includes('In gamma'));
    assert.equal((await f.call('GET', '/search?project=gamma', { token: vt })).status, 400, 'a hidden project is refused, never offered');
    assert.equal(f.store.listEvents(a.id).length, before, 'reads only');
  } finally { await f.cleanup(); }
});

/** A people server whose sent emails are kept in `sent`; `fail` makes the next send refused. */
async function inviteServer(f, options = {}) {
  const sent = [];
  const mail = { fail: null };
  const accountMail = {
    send: async (m) => { if (mail.fail) throw new Error(mail.fail); sent.push(m); },
    pageUrl: 'http://tracker.test:4180', projectName: 'Alpha',
  };
  const s = await signInServer(f, { accountMail, ...options });
  const cookie = cookieOf((await s.signIn({ email: s.email, password: s.password })).cookie);
  const asPerson = (method, path, body) => s.ask(method, path, { headers: { ...s.json, cookie }, body });
  return { ...s, sent, mail, cookie, asPerson };
}

test('an invite from start to finish: a person invites an email, the link makes the new person, and they sign in', async () => {
  const f = await fixture();
  const s = await inviteServer(f);
  try {
    const r = await s.asPerson('POST', '/invites', { email: ' Test@Example.com ' });
    assert.equal(r.status, 201, r.text);
    assert.match(r.body.sent, /^Invite sent to test@example\.com, good for 7 days\.$/);
    assert.deepEqual(r.body.invites.map((i) => [i.email, i.invitedBy.name]), [['test@example.com', 'Operator']]);
    assert.equal(s.sent.length, 1);
    assert.equal(s.sent[0].to, 'test@example.com');
    assert.equal(s.sent[0].subject, 'Operator invited you to the Alpha tracker');
    assert.match(s.sent[0].text, /Operator invited you/);
    const m = /http:\/\/tracker\.test:4180\/set-password\?link=([A-Za-z0-9_%-]+)/.exec(s.sent[0].text);
    assert.ok(m, s.sent[0].text);
    const token = decodeURIComponent(m[1]);
    assert.ok(!r.text.includes(token), 'the answer never carries the link');
    assert.ok(!f.lines.some((l) => l.includes(token) || l.includes('test@example.com')), 'the log carries neither the link nor the email');
    assert.ok(f.lines.includes(`invite sent actor=${f.human.id}`));

    const info = await s.ask('POST', '/account/link', { headers: s.json, body: { link: token } });
    assert.deepEqual([info.body.purpose, info.body.email], ['invite', 'test@example.com']);
    const set = await s.ask('POST', '/account/set-password', { headers: s.json, body: { link: token, password: 'the new person password', name: 'Tess' } });
    assert.equal(set.status, 200);
    const signedIn = await s.signIn({ email: 'test@example.com', password: 'the new person password' });
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.body.name, 'Tess');
    const waiting = await s.ask('GET', '/waiting', { headers: { cookie: cookieOf(signedIn.cookie) } });
    assert.equal(waiting.status, 200);

    const after = await s.asPerson('GET', '/people');
    assert.deepEqual(after.body.people.map((p) => [p.name, p.email]), [['Operator', 'operator@example.com'], ['Tess', 'test@example.com']]);
    assert.deepEqual(after.body.invites, [], 'the used invite is gone from the open ones');
  } finally { await s.close(); await f.cleanup(); }
});

test('an invite is refused for a taken email, a second invite, a machine and a bad body, each with its reason, and nothing is made or sent', async () => {
  const f = await fixture();
  const s = await inviteServer(f);
  try {
    const taken = await s.asPerson('POST', '/invites', { email: 'OPERATOR@example.com' });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error, 'duplicate-email');
    assert.match(taken.body.message, /already belongs to a person/);

    assert.equal((await s.asPerson('POST', '/invites', { email: 'new@example.com' })).status, 201);
    const twice = await s.asPerson('POST', '/invites', { email: 'New@example.com' });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error, 'duplicate-invite');
    assert.match(twice.body.message, /already has an open invite/);

    const machine = await f.call('POST', '/invites', { at: s.base, body: { email: 'loop@example.com' } });
    assert.equal(machine.status, 403);
    assert.equal(machine.body.error, 'people-only');
    const machineCancel = await f.call('DELETE', `/invites/${f.store.listInvites()[0].id}`, { at: s.base });
    assert.equal(machineCancel.status, 403);
    assert.equal(machineCancel.body.error, 'people-only');

    assert.equal((await s.asPerson('POST', '/invites', { email: '' })).body.error, 'missing');
    assert.equal((await s.asPerson('POST', '/invites', { email: 'not an email' })).body.error, 'bad-email');
    assert.equal((await s.asPerson('POST', '/invites', { email: 'x@example.com', role: 'admin' })).body.error, 'bad-field');

    assert.equal(s.sent.length, 1, 'only the one invite that was made went out');
    assert.deepEqual(f.store.listInvites().map((i) => i.email), ['new@example.com']);
  } finally { await s.close(); await f.cleanup(); }
});

test('a cancelled invite\'s link is refused; cancelling twice or an unknown id is 404', async () => {
  const f = await fixture();
  const s = await inviteServer(f);
  try {
    await s.asPerson('POST', '/invites', { email: 'gone@example.com' });
    const token = decodeURIComponent(/link=([A-Za-z0-9_%-]+)/.exec(s.sent[0].text)[1]);
    const [invite] = f.store.listInvites();
    const r = await s.asPerson('DELETE', `/invites/${invite.id}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { cancelled: invite.id });
    assert.deepEqual((await s.asPerson('GET', '/people')).body.invites, []);
    const use = await s.ask('POST', '/account/set-password', { headers: s.json, body: { link: token, password: 'a good long password', name: 'Gone' } });
    assert.equal(use.status, 400);
    assert.equal(use.body.error, 'unknown-link');
    assert.equal(f.store.actorForEmail('gone@example.com'), null);
    assert.equal((await s.asPerson('DELETE', `/invites/${invite.id}`)).status, 404);
    assert.equal((await s.asPerson('DELETE', '/invites/999')).body.error, 'unknown-invite');
    assert.equal((await s.asPerson('DELETE', '/invites/abc')).status, 404);
  } finally { await s.close(); await f.cleanup(); }
});

test('an invite whose email does not go out, or with no mail sender, leaves no open invite and says so', async () => {
  const f = await fixture();
  const s = await inviteServer(f);
  try {
    s.mail.fail = 'Resend answered 403: you can only send testing emails to your own address';
    const failed = await s.asPerson('POST', '/invites', { email: 'far@example.com' });
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error, 'not-sent');
    assert.match(failed.body.message, /^Not invited: the email to far@example\.com did not go out \(Resend answered 403: you can only send testing emails to your own address\)\. The invite was withdrawn/);
    assert.deepEqual(f.store.listInvites(), []);
    s.mail.fail = null;
    assert.equal((await s.asPerson('POST', '/invites', { email: 'far@example.com' })).status, 201, 'a later try is not blocked');
  } finally { await s.close(); }

  const n = await signInServer(f);
  try {
    const cookie = cookieOf((await n.signIn({ email: n.email, password: n.password })).cookie);
    const r = await n.ask('POST', '/invites', { headers: { ...n.json, cookie }, body: { email: 'none@example.com' } });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'no-mail');
    assert.ok(!f.store.listInvites().some((i) => i.email === 'none@example.com'));
  } finally { await n.close(); await f.cleanup(); }
});

/**
 * An outside site (docs/OUTSIDE_SITE_API.md): a machine actor with a page
 * address and a token, on an invite server. Answers the invite server with
 * `{ site, siteToken, siteUrl }` added.
 */
async function siteServer(f, options = {}) {
  const s = await inviteServer(f, options);
  const siteUrl = 'https://site.example/spirality';
  const site = f.store.createActor({ kind: 'machine', name: 'Site page', siteUrl });
  const siteToken = f.store.issueToken(site.id);
  return { ...s, site, siteToken, siteUrl };
}

/** The address an email carries, and its link token. */
const linkIn = (text) => {
  const address = /https?:\/\/\S+/.exec(text)[0];
  return { address, token: new URL(address).searchParams.get('link') };
};

test('an invite made with a site emails a link to the site\'s page; without one, to the tracker page; a site that is not a site actor is 400 and nothing is sent', async () => {
  const f = await fixture();
  const s = await siteServer(f);
  try {
    const people = await s.asPerson('GET', '/people');
    assert.deepEqual(people.body.sites, [{ id: s.site.id, name: 'Site page' }], 'the Users page lists the sites by id and name');
    assert.equal((await f.call('GET', '/people', { at: s.base })).body.sites, undefined, 'a loop sees no sites');

    const viaSite = await s.asPerson('POST', '/invites', { email: 'far@example.com', site: s.site.id });
    assert.equal(viaSite.status, 201, viaSite.text);
    const sent = linkIn(s.sent[0].text);
    assert.equal(sent.address, `${s.siteUrl}?link=${encodeURIComponent(sent.token)}`);
    assert.equal(f.store.linkInfo(sent.token).purpose, 'invite');
    assert.ok(f.lines.includes(`invite sent through site ${s.site.id} actor=${f.human.id}`));

    const plain = await s.asPerson('POST', '/invites', { email: 'near@example.com' });
    assert.equal(plain.status, 201);
    assert.ok(linkIn(s.sent[1].text).address.startsWith('http://tracker.test:4180/set-password?link='), 'no site: the tracker page, as before');

    for (const site of [f.machine.id, f.human.id, 999, 'abc', String(s.site.id), true]) {
      const r = await s.asPerson('POST', '/invites', { email: 'nope@example.com', site });
      assert.equal(r.status, 400, `site ${JSON.stringify(site)}`);
      assert.equal(r.body.error, 'not-a-site');
    }
    const odd = await s.asPerson('POST', '/invites', { email: 'nope@example.com', site: { x: 1 } });
    assert.equal(odd.status, 400);
    assert.match(odd.body.message, /not that value\./, 'an object is never printed as "[object Object]"');
    assert.ok(!odd.body.message.includes('[object Object]'));
    const named = await s.asPerson('POST', '/invites', { email: 'nope@example.com', site: 999 });
    assert.match(named.body.message, /not "999"\./, 'a number is quoted as sent');
    assert.equal(s.sent.length, 2, 'a refused site sends nothing');
    assert.ok(!f.store.listInvites().some((i) => i.email === 'nope@example.com'), 'and makes no invite');

    const bySite = await f.call('POST', '/invites', { at: s.base, token: s.siteToken, body: { email: 'self@example.com', site: s.site.id } });
    assert.equal(bySite.status, 403, 'a site may not invite anyone: inviting stays people-only');
    assert.equal(bySite.body.error, 'people-only');
  } finally { await s.close(); await f.cleanup(); }
});

test('Forgot password with a site\'s token sends a link to the site\'s page; with a loop\'s token, a wrong one or none, to the tracker page; the answer is the same every time', async () => {
  const f = await fixture();
  // One email gets one reset per 15 minutes (PR #120), so the clock steps
  // past that gap before each ask: every one here is meant to send.
  let clock = Date.parse('2026-11-08T18:00:00Z');
  const s = await siteServer(f, { now: () => clock });
  try {
    const forgot = (authorization) => { clock += 16 * 60_000; return s.ask('POST', '/account/forgot', { headers: { ...s.json, ...(authorization ? { authorization } : {}) }, body: { email: s.email } }); };
    const answers = [
      await forgot(`Bearer ${s.siteToken}`),
      await forgot(`Bearer ${f.machineToken}`),
      await forgot('Bearer not-a-real-token'),
      await forgot(null),
      await s.ask('POST', '/account/forgot', { headers: { ...s.json, authorization: `Bearer ${s.siteToken}` }, body: { email: 'nobody@example.com' } }),
    ];
    for (const a of answers) {
      assert.equal(a.status, 200);
      assert.equal(a.text, answers[0].text, 'word for word the same');
    }
    assert.equal(s.sent.length, 4, 'one reset per known email; the unknown one gets nothing');
    const [site, ...rest] = s.sent.map((m) => linkIn(m.text));
    assert.equal(site.address, `${s.siteUrl}?link=${encodeURIComponent(site.token)}`);
    for (const r of rest) assert.ok(r.address.startsWith('http://tracker.test:4180/set-password?link='), r.address);
    assert.ok(f.lines.includes(`reset link sent to actor ${f.human.id} through a site, good for 1 hour`));
    const log = f.lines.join('\n');
    for (const secret of [s.siteToken, f.machineToken, site.token, ...rest.map((r) => r.token)]) assert.ok(!log.includes(secret), 'no token or link in the log');
  } finally { await s.close(); await f.cleanup(); }
});

test('an outside site\'s whole journey, server to server: invite through the site, set a password, sign in, list tickets, read the board, file a Requested ticket, comment, reset through the site, sign out', async () => {
  const f = await fixture();
  const s = await siteServer(f);
  try {
    // The site's server: it holds the person's session cookie itself, and
    // sends exactly what a server would; never a browser.
    const site = (method, path, { cookie, body, authorization } = {}) => s.ask(method, path, {
      headers: { ...(body !== undefined ? s.json : {}), ...(cookie ? { cookie } : {}), ...(authorization ? { authorization } : {}) }, body,
    });
    f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: 'Already queued', status: 'queued' });

    // 1. An admin invites through the site.
    assert.equal((await s.asPerson('POST', '/invites', { email: 'tess@example.com', site: s.site.id })).status, 201);
    const invite = linkIn(s.sent.at(-1).text);
    assert.ok(invite.address.startsWith(`${s.siteUrl}?link=`));

    // 2. The site's page read ?link= and its server finishes the link.
    const info = await site('POST', '/account/link', { body: { link: invite.token } });
    assert.deepEqual([info.status, info.body.purpose, info.body.email], [200, 'invite', 'tess@example.com']);
    const set = await site('POST', '/account/set-password', { body: { link: invite.token, password: 'tess has a long password', name: 'Tess' } });
    assert.equal(set.status, 200, set.text);
    const tess = f.store.actorForEmail('tess@example.com');
    // The admin gives Tess the project (SP-145's membership).
    assert.equal((await s.asPerson('POST', '/projects/alpha/members', { person: tess.id })).status, 201);

    // 3. Sign in: the tracker's cookie stays on the site's server.
    const signedIn = await site('POST', '/signin', { body: { email: 'tess@example.com', password: 'tess has a long password' } });
    assert.equal(signedIn.status, 200);
    const cookie = cookieOf(signedIn.cookie);
    assert.equal((await site('GET', '/me', { cookie })).body.name, 'Tess');
    assert.deepEqual((await site('GET', '/projects', { cookie })).body.projects.map((p) => p.slug), ['alpha']);

    // 4. List the project's tickets and its board.
    const tickets = await site('GET', '/projects/alpha/tickets', { cookie });
    assert.equal(tickets.status, 200);
    assert.deepEqual(tickets.body.tickets.map((t) => t.name), ['Already queued']);
    const board = await site('GET', '/projects/alpha/board', { cookie });
    assert.equal(board.status, 200);
    assert.deepEqual(board.body.columns.find((c) => c.status === 'Queued').tickets.map((t) => t.name), ['Already queued']);

    // 5. File a Requested ticket and comment on it.
    const filed = await site('POST', '/projects/alpha/tickets', { cookie, body: { name: 'Tess wants a thing', description: 'In her words.', status: 'requested' } });
    assert.equal(filed.status, 201, filed.text);
    assert.equal(filed.body.status, 'requested');
    const comment = await site('POST', `/tickets/${filed.body.id}/comments`, { cookie, body: { body: 'One more detail.' } });
    assert.equal(comment.status, 201);
    const thread = await site('GET', `/tickets/${filed.body.id}/thread`, { cookie });
    assert.equal(thread.status, 200);
    assert.deepEqual(thread.body.comments.map((c) => [c.author.name, c.body]), [['Tess', 'One more detail.']]);

    // 6. Forgot password through the site, and the reset link finishes there too.
    const forgot = await site('POST', '/account/forgot', { authorization: `Bearer ${s.siteToken}`, body: { email: 'tess@example.com' } });
    assert.equal(forgot.status, 200);
    const reset = linkIn(s.sent.at(-1).text);
    assert.ok(reset.address.startsWith(`${s.siteUrl}?link=`));
    assert.equal((await site('POST', '/account/link', { body: { link: reset.token } })).body.purpose, 'reset');
    assert.equal((await site('POST', '/account/set-password', { body: { link: reset.token, password: 'tess has a new password' } })).status, 200);
    assert.equal((await site('GET', '/me', { cookie })).status, 401, 'a reset signs out everywhere');

    // 7. Sign in again with the new password, then sign out.
    const again = cookieOf((await site('POST', '/signin', { body: { email: 'tess@example.com', password: 'tess has a new password' } })).cookie);
    const out = await site('POST', '/signout', { cookie: again, body: {} });
    assert.equal(out.status, 200);
    assert.equal((await site('GET', '/me', { cookie: again })).status, 401);

    // No answer carried a token or link meant for something else, and the log carried none.
    const log = f.lines.join('\n');
    for (const secret of [invite.token, reset.token, s.siteToken, cookie.split('=')[1], again.split('=')[1]]) assert.ok(!log.includes(secret), 'a secret in the log');
    for (const a of [info, set, signedIn, tickets, board, filed, comment, thread, forgot, out]) {
      for (const secret of [invite.token, reset.token, s.siteToken]) assert.ok(!a.text.includes(secret), 'a token in an answer');
    }
  } finally { await s.close(); await f.cleanup(); }
});

test('GET /projects/:slug/board keeps the shape outside sites read: the eight columns in queue order, each a status name and its tickets with these fields', async () => {
  const f = await fixture();
  try {
    f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: 'One', status: 'queued', priority: 'high', tags: ['x'] });
    const r = await f.call('GET', '/projects/alpha/board', { token: f.humanToken });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body), ['project', 'projectName', 'columns']);
    assert.deepEqual([r.body.project, r.body.projectName], ['alpha', 'Alpha']);
    assert.deepEqual(r.body.columns.map((c) => c.status), [...loopStatuses.STAGE_ORDER]);
    assert.deepEqual(r.body.columns.map((c) => c.status), ['Requested', 'Rework', 'Queued', 'Building', 'In review', 'Needs your input', 'Ready to launch', 'Live']);
    for (const c of r.body.columns) {
      assert.deepEqual(Object.keys(c), ['status', 'tickets']);
      assert.ok(Array.isArray(c.tickets));
    }
    const [ticket] = r.body.columns.find((c) => c.status === 'Queued').tickets;
    assert.deepEqual(Object.keys(ticket), ['id', 'name', 'priority', 'tags', 'assignee', 'updatedAt', 'pullRequest', 'answerIn', 'waiting', 'version']);
    assert.equal(ticket.version, f.store.getTicket('AL-1').version, 'the version the list saves with is the stored one');
    assert.deepEqual([ticket.id, ticket.name, ticket.priority, ticket.tags, ticket.assignee, ticket.pullRequest], ['AL-1', 'One', 'high', ['x'], null, null]);
    assert.equal(typeof ticket.updatedAt, 'string');
    // docs/OUTSIDE_SITE_API.md lists it among the calls outside sites read.
    const doc = readFileSync(new URL('../docs/OUTSIDE_SITE_API.md', import.meta.url), 'utf8');
    assert.match(doc, /GET \/projects\/:slug\/board/);
  } finally { await f.cleanup(); }
});

/**
 * A tracker home for the setup calls: a settings file copied from this
 * repository's own, with its logDir moved into a scratch folder, and a
 * server started with it. Answers `{ ...fixture, setup, onboard, at }`.
 */
async function setupFixture() {
  const f = await fixture();
  const home = join(f.dir, 'home');
  const logDir = join(f.dir, 'logs');
  mkdirSync(home);
  const repoSettings = JSON.parse(readFileSync(new URL('../spirality.project.json', import.meta.url), 'utf8'));
  writeFileSync(join(home, 'spirality.project.json'), JSON.stringify({ ...repoSettings, logDir }));
  const { setup, why } = setupSettingsOf({ db: f.path, folder: home });
  assert.ok(setup, why);
  const server = await startServer({ store: f.store, port: 0, log: (line) => f.lines.push(line), setup });
  const at = `http://127.0.0.1:${server.address().port}`;
  const close = f.cleanup;
  return {
    ...f, setup, home, onboard: join(logDir, 'onboard'), at,
    cleanup: async () => { await new Promise((r) => server.close(r)); await close(); },
  };
}

const GOOD_ANSWERS = Object.freeze({
  projectName: 'Press Play',
  githubRepo: 'example-owner/press-play',
  trackerPrefix: '',
  mergePhrases: '',
  autoMergeLanes: 'none',
  extraGovernancePaths: 'docs/RULES.md, ops/',
  description: 'A test project. It plays things.',
});

/** A state file as the wizard leaves it: every step pending except those given. */
function writeState(dir, slug, { outcomes = {}, stop = null, finished = false } = {}) {
  mkdirSync(dir, { recursive: true });
  const state = {
    project: slug,
    updatedAt: '2026-11-05T08:15:00.000Z',
    steps: STEPS.map((step) => ({ step, outcome: outcomes[step] ?? 'pending', at: outcomes[step] ? '2026-11-05T07:20:00.000Z' : null, why: null })),
    stop,
    finished,
  };
  writeFileSync(join(dir, `${slug}.state.json`), JSON.stringify(state));
  return state;
}

test('GET /setup/fields answers the wizard\'s own questions, with the tracker home\'s defaults, to a person', async () => {
  const f = await setupFixture();
  try {
    const r = await f.call('GET', '/setup/fields', { token: f.humanToken, at: f.at });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.fields.map((x) => x.key), DANE_FIELDS.map((x) => x.key));
    const byKey = Object.fromEntries(r.body.fields.map((x) => [x.key, x]));
    assert.equal(byKey.projectName.required, true);
    assert.equal(byKey.projectName.default, null);
    assert.equal(byKey.projectName.question, DANE_FIELDS[0].question);
    assert.equal(byKey.mergePhrases.default, f.setup.homeConfig.mergePhrases.join(', '));
    assert.equal(byKey.mergePhrases.list, true);
    assert.equal(byKey.autoMergeLanes.default, 'none');
    assert.equal(byKey.trackerPrefix.default, null, 'no project named: no slug to make a prefix from');
    const named = await f.call('GET', '/setup/fields?project=press-play', { token: f.humanToken, at: f.at });
    assert.equal(named.body.fields.find((x) => x.key === 'trackerPrefix').default, 'PR');
    // ?product= is the address's old name (SP-156): a page opened before the rename still gets its defaults.
    const old = await f.call('GET', '/setup/fields?product=press-play', { token: f.humanToken, at: f.at });
    assert.equal(old.body.fields.find((x) => x.key === 'trackerPrefix').default, 'PR');
  } finally { await f.cleanup(); }
});

test('every setup call is a person\'s only: a machine gets 403 and nothing is written', async () => {
  const f = await setupFixture();
  try {
    for (const [method, path, body] of [['GET', '/setup'], ['GET', '/setup/fields'], ['GET', '/setup/press-play'], ['PUT', '/setup/press-play', GOOD_ANSWERS]]) {
      const r = await f.call(method, path, { token: f.machineToken, at: f.at, body });
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal(r.body.error, 'people-only');
    }
    assert.equal(existsSync(f.onboard), false, 'nothing written');
    assert.equal((await f.call('GET', '/setup', { token: null, at: f.at })).status, 401);
  } finally { await f.cleanup(); }
});

test('a server started without a usable tracker home answers the setup calls 503 and reads nothing', async () => {
  const f = await fixture();
  try {
    const r = await f.call('GET', '/setup/fields', { token: f.humanToken });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'no-setup');
    const bad = join(f.dir, 'guest');
    mkdirSync(bad);
    const { trackerPort, ...guest } = JSON.parse(readFileSync(new URL('../spirality.project.json', import.meta.url), 'utf8'));
    assert.ok(trackerPort);
    writeFileSync(join(bad, 'spirality.project.json'), JSON.stringify(guest));
    const off = setupSettingsOf({ db: f.path, folder: bad });
    assert.equal(off.setup, null);
    assert.match(off.why, /trackerPort/);
  } finally { await f.cleanup(); }
});

test('PUT /setup/:slug writes the answers file, checked by the wizard\'s checker and read back; GET answers it with the command to paste', async () => {
  const f = await setupFixture();
  try {
    const put = await f.call('PUT', '/setup/press-play', { token: f.humanToken, at: f.at, body: GOOD_ANSWERS });
    assert.equal(put.status, 200, put.text);
    const file = join(f.onboard, 'press-play.answers.json');
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(onDisk, {
      projectSlug: 'press-play',
      projectName: 'Press Play',
      githubRepo: 'example-owner/press-play',
      trackerPrefix: null,
      mergePhrases: null,
      autoMergeLanes: [],
      extraGovernancePaths: ['docs/RULES.md', 'ops/'],
      description: 'A test project. It plays things.',
    });
    assert.deepEqual(put.body.answers, onDisk, 'answered as read back');
    assert.equal(put.body.resolved.trackerPrefix, 'PR');
    assert.deepEqual(put.body.resolved.mergePhrases, f.setup.homeConfig.mergePhrases);
    assert.equal(put.body.state, null);
    assert.equal(put.body.locked, false);
    const get = await f.call('GET', '/setup/press-play', { token: f.humanToken, at: f.at });
    assert.equal(get.status, 200);
    assert.deepEqual(get.body.answers, onDisk);
    assert.equal(get.body.commands.start, `cd ${f.home} && TRACKER_DB=${f.path} npm run onboard -- --project press-play --no-prompt`);
    assert.equal(get.body.commands.resume, get.body.commands.start);
    // A second save changes one field and keeps the rest.
    const again = await f.call('PUT', '/setup/press-play', { token: f.humanToken, at: f.at, body: { trackerPrefix: 'PP' } });
    assert.equal(again.status, 200, again.text);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).trackerPrefix, 'PP');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).projectName, 'Press Play');
    assert.equal(existsSync(`${file}.${process.pid}.tmp`), false, 'no file left beside it');
  } finally { await f.cleanup(); }
});

test('PUT /setup/:slug refuses a bad answer (400 naming it), an unknown field, a bad slug, and a setup past its sign-ins (409), writing nothing', async () => {
  const f = await setupFixture();
  try {
    const file = join(f.onboard, 'press-play.answers.json');
    const bad = await f.call('PUT', '/setup/press-play', { token: f.humanToken, at: f.at, body: { ...GOOD_ANSWERS, githubRepo: 'not a repo' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.field, 'githubRepo');
    assert.match(bad.body.message, /githubRepo/);
    const missing = await f.call('PUT', '/setup/press-play', { token: f.humanToken, at: f.at, body: { projectName: 'Press Play' } });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.field, 'description');
    const unknown = await f.call('PUT', '/setup/press-play', { token: f.humanToken, at: f.at, body: { ...GOOD_ANSWERS, checkoutDir: '/tmp/x' } });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.message, /checkoutDir/);
    const wrongShape = await f.call('PUT', '/setup/press-play', { token: f.humanToken, at: f.at, body: { ...GOOD_ANSWERS, projectName: 7 } });
    assert.equal(wrongShape.status, 400);
    assert.equal((await f.call('PUT', '/setup/Press%20Play', { token: f.humanToken, at: f.at, body: GOOD_ANSWERS })).status, 400);
    const own = await f.call('PUT', `/setup/${f.setup.homeConfig.projectSlug}`, { token: f.humanToken, at: f.at, body: GOOD_ANSWERS });
    assert.equal(own.status, 400, 'the tracker home\'s own slug is not a new project');
    assert.equal(existsSync(file), false, 'nothing written');

    assert.equal((await f.call('PUT', '/setup/press-play', { token: f.humanToken, at: f.at, body: GOOD_ANSWERS })).status, 200);
    const before = readFileSync(file, 'utf8');
    writeState(f.onboard, 'press-play', { outcomes: { answers: 'done', look: 'done', clone: 'skip', settings: 'done', signins: 'done' } });
    const late = await f.call('PUT', '/setup/press-play', { token: f.humanToken, at: f.at, body: { trackerPrefix: 'PP' } });
    assert.equal(late.status, 409);
    assert.equal(late.body.error, 'setup-under-way');
    assert.equal(readFileSync(file, 'utf8'), before, 'nothing written');
    writeState(f.onboard, 'press-play', { outcomes: { answers: 'done', signins: 'skip' } });
    assert.equal((await f.call('PUT', '/setup/press-play', { token: f.humanToken, at: f.at, body: { trackerPrefix: 'PP' } })).status, 409, 'skip: the sign-ins were already there');
    writeState(f.onboard, 'press-play', { outcomes: { answers: 'done', signins: 'stopped' } });
    assert.equal((await f.call('PUT', '/setup/press-play', { token: f.humanToken, at: f.at, body: { trackerPrefix: 'PP' } })).status, 200, 'stopped at the sign-ins: not made yet');
  } finally { await f.cleanup(); }
});

test('GET /setup/:slug and GET /setup read the state file: none yet, stopped at a paste, and finished', async () => {
  const f = await setupFixture();
  try {
    const none = await f.call('GET', '/setup/press-play', { token: f.humanToken, at: f.at });
    assert.equal(none.status, 200);
    assert.equal(none.body.answers, null);
    assert.equal(none.body.state, null);
    assert.equal(none.body.step, null);
    assert.equal(none.body.finished, false);
    assert.deepEqual((await f.call('GET', '/setup', { token: f.humanToken, at: f.at })).body, { setups: [] });

    assert.equal((await f.call('PUT', '/setup/press-play', { token: f.humanToken, at: f.at, body: GOOD_ANSWERS })).status, 200);
    const listed = await f.call('GET', '/setup', { token: f.humanToken, at: f.at });
    assert.deepEqual(listed.body.setups, [{ project: 'press-play', step: null, finished: false, started: false, stateError: null }]);

    const stop = { step: 'signins', kind: 'paste', why: 'the sign-ins are not made yet', commands: ['cd /x', 'npm run tracker:signins -- create'], link: null };
    writeState(f.onboard, 'press-play', { outcomes: { answers: 'done', look: 'done', clone: 'skip', settings: 'done', signins: 'stopped' }, stop });
    const stopped = await f.call('GET', '/setup/press-play', { token: f.humanToken, at: f.at });
    assert.equal(stopped.body.step, 'signins');
    assert.deepEqual(stopped.body.state.stop, stop);
    assert.equal(stopped.body.finished, false);
    assert.equal(stopped.body.locked, false);
    assert.deepEqual((await f.call('GET', '/setup', { token: f.humanToken, at: f.at })).body.setups,
      [{ project: 'press-play', step: 'signins', finished: false, started: true, stateError: null }]);

    writeState(f.onboard, 'press-play', { outcomes: Object.fromEntries(STEPS.map((s) => [s, 'done'])), finished: true });
    const done = await f.call('GET', '/setup/press-play', { token: f.humanToken, at: f.at });
    assert.equal(done.body.finished, true);
    assert.equal(done.body.step, null);
    assert.equal(done.body.locked, true);
    assert.deepEqual((await f.call('GET', '/setup', { token: f.humanToken, at: f.at })).body.setups,
      [{ project: 'press-play', step: null, finished: true, started: true, stateError: null }]);

    writeFileSync(join(f.onboard, 'press-play.state.json'), '{ not json');
    const broken = await f.call('GET', '/setup/press-play', { token: f.humanToken, at: f.at });
    assert.equal(broken.status, 200);
    assert.equal(broken.body.state, null);
    assert.match(broken.body.stateError, /not valid JSON/);
    assert.equal((await f.call('PUT', '/setup/press-play', { token: f.humanToken, at: f.at, body: GOOD_ANSWERS })).status, 409, 'cannot tell how far it is: nothing written');
  } finally { await f.cleanup(); }
});

// ── Attachments (SP-140) ─────────────────────────────────────────────────────

/** Upload `bytes` to a ticket as the page does; answers `{ status, body }`. */
async function upload(at, ticket, bytes, { name = 'shot.png', type = 'image/png', headers = {} } = {}) {
  const res = await fetch(`${at}/tickets/${ticket}/attachments`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), 'x-file-type': type, ...headers },
    body: bytes,
  });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) };
}

test('a project\'s files are listed in one call, newest first, with each task\'s name, and never the bytes (SP-171)', async () => {
  const f = await fixture();
  try {
    const t = f.store.fileTicket({ project: 'alpha', actor: f.human.id, name: 'With a file', status: 'requested' });
    const empty = await f.call('GET', '/projects/alpha/attachments');
    assert.equal(empty.status, 200, empty.text);
    assert.deepEqual(empty.body, { project: 'alpha', attachments: [] });
    const base = await f.serve();
    const made = await upload(base, t.id, Buffer.from('hello'), { name: 'notes.txt', type: 'text/plain', headers: { authorization: `Bearer ${f.humanToken}` } });
    assert.equal(made.status, 201);
    const list = await f.call('GET', '/projects/alpha/attachments');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.attachments.map((a) => [a.id, a.name, a.ticket, a.ticketName, a.size]), [[made.body.id, 'notes.txt', t.id, 'With a file', 5]]);
    assert.equal(list.body.attachments[0].addedByName, f.human.name);
    assert.equal(list.text.includes('hello'), false, 'never the bytes');
    assert.equal((await f.call('GET', '/projects/nope/attachments')).status, 404);
    assert.equal((await f.call('GET', '/projects/alpha/attachments', { token: null })).status, 401);
  } finally { await f.cleanup(); }
});

test('GET /commands lists the checkout\'s commands and loop skills, signed in only, reading nothing outside the two folders (SP-179)', async () => {
  const f = await fixture();
  const root = join(f.dir, 'checkout');
  const put = (folder, name, text) => {
    mkdirSync(join(root, folder, name), { recursive: true });
    writeFileSync(join(root, folder, name, 'SKILL.md'), text);
  };
  put('commands', 'why-stuck', '---\nname: why-stuck\ndescription: Find out why a ticket is stuck.\n---\n\n# Why stuck\n');
  put('.claude/skills', 'loop-review', '---\nname: loop-review\ndescription: Review the next pull request.\n---\n\n# Loop: Review\n');
  writeFileSync(join(f.dir, 'outside.md'), '---\nname: outside\ndescription: OUTSIDE-TEXT\n---\n');
  mkdirSync(join(root, 'commands', 'linked'));
  symlinkSync(join(f.dir, 'outside.md'), join(root, 'commands', 'linked', 'SKILL.md'));
  try {
    const server = await startServer({ store: f.store, port: 0, log: () => {}, commandsRoot: root });
    const at = `http://127.0.0.1:${server.address().port}`;
    try {
      const r = await f.call('GET', '/commands', { token: f.humanToken, at });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.body.commands.map((c) => [c.name, c.source, c.description]), [
        ['why-stuck', 'Your command', 'Find out why a ticket is stuck.'],
        ['loop-review', 'Loop skill', 'Review the next pull request.'],
      ]);
      assert.equal(r.body.commands[1].steps, '# Loop: Review\n');
      assert.equal(r.text.includes('OUTSIDE-TEXT'), false, 'a linked file is never read');
      assert.equal((await f.call('GET', '/commands', { token: null, at })).status, 401);
    } finally { await new Promise((done) => server.close(done)); }
    // With no root given, the tracker lists its own checkout's loop skills.
    const own = await f.call('GET', '/commands', { token: f.humanToken });
    assert.ok(['loop-build', 'loop-intake', 'loop-review', 'loop-spec'].every((n) => own.body.commands.some((c) => c.name === n && c.source === 'Loop skill')));
  } finally { await f.cleanup(); }
});

test('a file on a ticket is renamed and removed by its own calls, each in the ticket\'s history with who did it (SP-177)', async () => {
  const f = await fixture();
  try {
    const t = f.store.fileTicket({ project: 'alpha', actor: f.human.id, name: 'With a file', status: 'requested' });
    const base = await f.serve();
    const made = (await upload(base, t.id, Buffer.from('hello'), { name: 'notes.txt', type: 'text/plain', headers: { authorization: `Bearer ${f.humanToken}` } })).body;
    const path = `/tickets/${t.id}/attachments/${made.id}`;
    const h = (method, at, opts = {}) => f.call(method, at, { token: f.humanToken, ...opts });

    const renamed = await h('PATCH', path, { body: { name: 'Plan.txt' } });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(renamed.body.name, 'Plan.txt');
    assert.equal(renamed.body.changed, true);
    assert.deepEqual((await h('GET', `/tickets/${t.id}/thread`)).body.attachments.map((a) => a.name), ['Plan.txt'], 'the ticket page shows the new name');
    assert.deepEqual((await h('GET', '/projects/alpha/attachments')).body.attachments.map((a) => a.name), ['Plan.txt'], 'and so does the Docs table');

    // An empty name, a missing one or another field is refused and nothing changes.
    for (const body of [{ name: '' }, { name: '   ' }, {}, { name: 7 }, { name: 'x.txt', size: 1 }]) {
      const r = await h('PATCH', path, { body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal((await h('PATCH', path, { body: { name: '..' } })).status, 400, 'the upload\'s name rules');
    assert.equal((await h('PATCH', `/tickets/${t.id}/attachments/999`, { body: { name: 'x.txt' } })).status, 404);
    assert.equal((await h('PATCH', `/tickets/${t.id}/attachments/x`, { body: { name: 'x.txt' } })).status, 404);
    assert.equal((await h('PATCH', path, { token: null, body: { name: 'x.txt' } })).status, 401);
    assert.deepEqual(f.store.listAttachments(t.id).map((a) => a.name), ['Plan.txt']);

    assert.equal((await h('DELETE', path, { token: null })).status, 401);
    assert.equal(f.store.listAttachments(t.id).length, 1);
    const gone = await h('DELETE', path);
    assert.equal(gone.status, 200, gone.text);
    assert.deepEqual(gone.body, { removed: made.id, ticket: t.id, name: 'Plan.txt' });
    assert.deepEqual((await h('GET', `/tickets/${t.id}/thread`)).body.attachments, []);
    assert.deepEqual((await h('GET', '/projects/alpha/attachments')).body.attachments, []);
    assert.equal((await h('GET', path)).status, 404, 'the download is gone too');
    assert.equal((await h('DELETE', path)).status, 404, 'removing it twice is a 404');

    const history = (await h('GET', `/tickets/${t.id}/events`)).body.events.filter((e) => e.field === 'attachment');
    assert.deepEqual(history.map((e) => [e.actor, e.from, e.to]), [[f.human.id, 'notes.txt', 'Plan.txt'], [f.human.id, 'Plan.txt', null]]);
  } finally { await f.cleanup(); }
});

test('a file posted to a ticket comes back byte for byte, listed with its name and size, and always as a download', async () => {
  const f = await fixture();
  try {
    const t = f.store.fileTicket({ project: 'alpha', actor: f.human.id, name: 'With a file', status: 'requested' });
    const bytes = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 31) % 256));
    const base = await f.serve();
    const made = await upload(base, t.id, bytes, { name: 'Screen shot é.png', headers: { authorization: `Bearer ${f.humanToken}` } });
    assert.equal(made.status, 201);
    assert.equal(made.body.name, 'Screen shot é.png');
    assert.equal(made.body.size, bytes.length);
    assert.equal(made.body.type, 'image/png');
    assert.equal(made.body.addedBy, f.human.id);
    assert.equal('bytes' in made.body, false, 'the answer never carries the file');

    const list = await f.call('GET', `/tickets/${t.id}/attachments`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.attachments.map((a) => [a.name, a.size]), [['Screen shot é.png', bytes.length]]);
    const thread = await f.call('GET', `/tickets/${t.id}/thread`);
    assert.deepEqual(thread.body.attachments, list.body.attachments, 'the ticket page reads the same list');

    const res = await fetch(`${base}/tickets/${t.id}/attachments/${made.body.id}`, { headers: { authorization: `Bearer ${f.machineToken}` } });
    assert.equal(res.status, 200);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(bytes), 'byte for byte');
    assert.equal(res.headers.get('content-disposition'), "attachment; filename=\"Screen shot _.png\"; filename*=UTF-8''Screen%20shot%20%C3%A9.png");
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
    assert.equal(res.headers.get('content-type'), 'image/png');

    assert.equal((await f.call('GET', `/tickets/${t.id}/attachments/999`)).status, 404);
    assert.equal((await f.call('GET', `/tickets/${t.id}/attachments/x`)).status, 404);
    assert.equal((await f.call('GET', '/tickets/AL-99/attachments')).status, 404);
  } finally { await f.cleanup(); }
});

test('an 11 MB file is refused with 413 and a plain sentence, and nothing is stored', async () => {
  const f = await fixture();
  try {
    const t = f.store.fileTicket({ project: 'alpha', actor: f.human.id, name: 'Too big', status: 'requested' });
    const base = await f.serve();
    const auth = { authorization: `Bearer ${f.humanToken}` };
    const r = await upload(base, t.id, Buffer.alloc(11 * 1024 * 1024, 7), { headers: auth });
    assert.equal(r.status, 413);
    assert.equal(r.body.error, 'too-large');
    assert.equal(r.body.message, 'That file is over 10 MB. Attach a smaller one; nothing was saved.');
    assert.deepEqual(f.store.listAttachments(t.id), []);
    // A file of exactly 10 MB still goes in.
    assert.equal((await upload(base, t.id, Buffer.alloc(10 * 1024 * 1024, 1), { headers: auth })).status, 201);
  } finally { await f.cleanup(); }
});

test('signed out, every attachment route answers 401 and nothing is stored', async () => {
  const f = await fixture();
  try {
    const t = f.store.fileTicket({ project: 'alpha', actor: f.human.id, name: 'Locked', status: 'requested' });
    const a = f.store.addAttachment({ ticket: t.id, name: 'a.txt', type: 'text/plain', bytes: Buffer.from('hello'), actor: f.human.id });
    const base = await f.serve();
    for (const authorization of [undefined, 'Bearer wrong']) {
      const headers = authorization ? { authorization } : {};
      assert.equal((await upload(base, t.id, Buffer.from('x'), { headers })).status, 401);
      assert.equal((await fetch(`${base}/tickets/${t.id}/attachments`, { headers })).status, 401);
      const dl = await fetch(`${base}/tickets/${t.id}/attachments/${a.id}`, { headers });
      assert.equal(dl.status, 401);
      assert.doesNotMatch(await dl.text(), /hello/);
    }
    assert.equal(f.store.listAttachments(t.id).length, 1);
  } finally { await f.cleanup(); }
});

test('the page uploads with its session cookie as the file itself; a cookie upload that is not octet-stream, or names no file, is refused', async () => {
  const f = await fixture();
  try {
    const s = await signInServer(f);
    try {
      const cookie = cookieOf((await s.signIn({ email: s.email, password: s.password })).cookie);
      const t = f.store.fileTicket({ project: 'alpha', actor: f.human.id, name: 'From the page', status: 'requested' });
      const ok = await upload(s.base, t.id, Buffer.from('notes'), { name: 'notes.txt', type: 'text/plain', headers: { cookie } });
      assert.equal(ok.status, 201);
      assert.equal(ok.body.addedBy, f.human.id);
      // A form on another site can send text/plain, multipart or urlencoded, never octet-stream.
      for (const type of ['text/plain', 'multipart/form-data; boundary=x', 'application/x-www-form-urlencoded']) {
        const r = await s.ask('POST', `/tickets/${t.id}/attachments`, { headers: { cookie, 'content-type': type, 'x-file-name': 'x.txt' }, body: 'x' });
        assert.equal(r.status, 415);
      }
      assert.equal((await upload(s.base, t.id, Buffer.from('x'), { name: '', headers: { cookie } })).status, 400);
      const empty = await upload(s.base, t.id, Buffer.alloc(0), { headers: { cookie } });
      assert.equal(empty.status, 400);
      assert.equal(empty.body.error, 'empty-file');
      assert.deepEqual(f.store.listAttachments(t.id).map((a) => a.name), ['notes.txt']);
    } finally { await s.close(); }
  } finally { await f.cleanup(); }
});

// ── Context documents (SP-176) ──────────────────────────────────────────────

/** Upload `bytes` to a project's context documents as the page does; answers `{ status, body }`. */
async function uploadDoc(at, project, bytes, { name = 'brief.pdf', type = 'application/pdf', headers = {} } = {}) {
  const res = await fetch(`${at}/projects/${project}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), 'x-file-type': type, ...headers },
    body: bytes,
  });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) };
}

test('a project\'s context document is uploaded as the file itself, listed for that project only, downloaded byte for byte as a file to save, and removed', async () => {
  const f = await fixture();
  try {
    f.store.createProject({ slug: 'beta', name: 'Beta', prefix: 'BE', operator: f.human.id });
    const base = await f.serve();
    const auth = { authorization: `Bearer ${f.humanToken}` };
    assert.deepEqual((await f.call('GET', '/projects/alpha/docs')).body, { project: 'alpha', docs: [] });
    const bytes = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 17) % 256));
    const made = await uploadDoc(base, 'alpha', bytes, { name: 'Brief é.pdf', headers: auth });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.name, 'Brief é.pdf');
    assert.equal(made.body.size, bytes.length);
    assert.equal(made.body.project, 'alpha');
    assert.equal(made.body.addedBy, f.human.id);
    assert.equal(made.body.addedByName, 'Operator');
    assert.equal('bytes' in made.body, false, 'the answer never carries the file');

    const list = await f.call('GET', '/projects/alpha/docs');
    assert.deepEqual(list.body.docs.map((d) => [d.id, d.name, d.size, d.type, d.addedByName]), [[made.body.id, 'Brief é.pdf', bytes.length, 'application/pdf', 'Operator']]);
    assert.deepEqual((await f.call('GET', '/projects/beta/docs')).body.docs, [], 'another project has its own list');

    const res = await fetch(`${base}/projects/alpha/docs/${made.body.id}`, { headers: auth });
    assert.equal(res.status, 200);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(bytes), 'byte for byte');
    assert.equal(res.headers.get('content-disposition'), "attachment; filename=\"Brief _.pdf\"; filename*=UTF-8''Brief%20%C3%A9.pdf");
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
    assert.equal((await f.call('GET', `/projects/beta/docs/${made.body.id}`)).status, 404, 'another project never reaches it');
    assert.equal((await f.call('GET', '/projects/alpha/docs/999')).status, 404);
    assert.equal((await f.call('GET', '/projects/alpha/docs/x')).status, 404);

    // A project holding a document is not deleted.
    const beta = await uploadDoc(base, 'beta', Buffer.from('b'), { name: 'b.txt', headers: auth });
    const del = await f.call('DELETE', '/projects/beta', { token: f.humanToken });
    assert.equal(del.status, 409, del.text);
    assert.equal(del.body.error, 'has-docs');
    assert.equal(del.body.docs, 1);

    assert.equal((await f.call('DELETE', `/projects/beta/docs/${made.body.id}`, { token: f.humanToken })).status, 404, 'removing through another project is refused');
    assert.equal((await f.call('DELETE', '/projects/alpha/docs/x', { token: f.humanToken })).status, 404);
    const removed = await f.call('DELETE', `/projects/alpha/docs/${made.body.id}`, { token: f.humanToken });
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual(removed.body, { removed: made.body.id, name: 'Brief é.pdf', project: 'alpha' });
    assert.deepEqual(f.store.listProjectDocs('alpha'), []);
    assert.equal((await f.call('DELETE', `/projects/alpha/docs/${made.body.id}`, { token: f.humanToken })).status, 404, 'a second removal finds nothing');
    assert.equal(f.store.listProjectDocs('beta')[0].id, beta.body.id, 'the other project keeps its own');
    assert.ok(f.lines.some((l) => /added context document Brief é\.pdf \(70000 bytes\) to alpha actor=1/.test(l)));
    assert.ok(f.lines.some((l) => new RegExp(`removed context document ${made.body.id} \\(Brief é\\.pdf\\) from alpha actor=1`).test(l)));
  } finally { await f.cleanup(); }
});

test('a context document over 10 MB is refused with 413 and a plain sentence; an empty or nameless one with 400; nothing is stored', async () => {
  const f = await fixture();
  try {
    const base = await f.serve();
    const auth = { authorization: `Bearer ${f.humanToken}` };
    const big = await uploadDoc(base, 'alpha', Buffer.alloc(11 * 1024 * 1024, 7), { headers: auth });
    assert.equal(big.status, 413);
    assert.equal(big.body.error, 'too-large');
    assert.equal(big.body.message, 'That file is over 10 MB. Attach a smaller one; nothing was saved.');
    const empty = await uploadDoc(base, 'alpha', Buffer.alloc(0), { headers: auth });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, 'empty-file');
    assert.equal((await uploadDoc(base, 'alpha', Buffer.from('x'), { name: '', headers: auth })).status, 400);
    assert.deepEqual(f.store.listProjectDocs('alpha'), []);
    assert.equal((await uploadDoc(base, 'alpha', Buffer.alloc(10 * 1024 * 1024, 1), { headers: auth })).status, 201, 'exactly 10 MB still goes in');
  } finally { await f.cleanup(); }
});

test('someone who is not on the project gets 404 from every context document call, the same as a project that does not exist; signed out is 401; nothing changes', async () => {
  const f = await fixture();
  try {
    const base = await f.serve();
    const d = f.store.addProjectDoc({ project: 'alpha', name: 'secret.txt', type: 'text/plain', bytes: Buffer.from('hidden words'), actor: f.human.id });
    const viewer = f.store.createActor({ kind: 'human', name: 'Viewer' });
    const vt = f.store.issueToken(viewer.id);
    f.store.setRole({ actor: viewer.id, role: 'viewer', by: f.human.id });
    const calls = [
      (p, h) => fetch(`${base}/projects/${p}/docs`, { headers: h }),
      (p, h) => fetch(`${base}/projects/${p}/docs/${d.id}`, { headers: h }),
      (p, h) => fetch(`${base}/projects/${p}/docs/${d.id}`, { method: 'DELETE', headers: h }),
      (p, h) => fetch(`${base}/projects/${p}/docs`, { method: 'POST', headers: { ...h, 'content-type': 'application/octet-stream', 'x-file-name': 'x.txt' }, body: 'x' }),
    ];
    for (const [i, call] of calls.entries()) {
      const r = await call('alpha', { authorization: `Bearer ${vt}` });
      const text = await r.text();
      assert.equal(r.status, 404, `call ${i}: ${text}`);
      assert.equal(JSON.parse(text).yourProjectsOnly, true);
      assert.ok(!text.includes('secret') && !text.includes('hidden'), `call ${i} gives nothing away`);
      const missing = await call('nope', { authorization: `Bearer ${vt}` });
      assert.equal(missing.status, 404);
      assert.equal((await missing.text()).replace('nope', 'alpha'), text, `call ${i}: the same answer as a project that does not exist`);
      assert.equal((await call('alpha', {})).status, 401, `call ${i} signed out`);
    }
    assert.deepEqual(f.store.listProjectDocs('alpha').map((x) => x.name), ['secret.txt'], 'nothing was added or removed');
    // Made a member, the same person reaches them.
    f.store.addMember({ project: 'alpha', actor: viewer.id, by: f.human.id });
    assert.equal((await fetch(`${base}/projects/alpha/docs`, { headers: { authorization: `Bearer ${vt}` } })).status, 200);
  } finally { await f.cleanup(); }
});

test('the page uploads and removes context documents with its session cookie; a cookie upload that is not octet-stream, or a removal that is not JSON, is refused', async () => {
  const f = await fixture();
  try {
    const s = await signInServer(f);
    try {
      const cookie = cookieOf((await s.signIn({ email: s.email, password: s.password })).cookie);
      const ok = await uploadDoc(s.base, 'alpha', Buffer.from('notes'), { name: 'notes.txt', type: 'text/plain', headers: { cookie } });
      assert.equal(ok.status, 201);
      assert.equal(ok.body.addedBy, f.human.id);
      for (const type of ['text/plain', 'multipart/form-data; boundary=x', 'application/x-www-form-urlencoded']) {
        const r = await s.ask('POST', '/projects/alpha/docs', { headers: { cookie, 'content-type': type, 'x-file-name': 'x.txt' }, body: 'x' });
        assert.equal(r.status, 415, type);
      }
      const bare = await s.ask('DELETE', `/projects/alpha/docs/${ok.body.id}`, { headers: { cookie } });
      assert.equal(bare.status, 415, 'a cookie removal must say it is JSON, which another site\'s form cannot');
      assert.equal(f.store.listProjectDocs('alpha').length, 1);
      const gone = await s.ask('DELETE', `/projects/alpha/docs/${ok.body.id}`, { headers: { cookie, ...s.json }, body: {} });
      assert.equal(gone.status, 200, gone.text);
      assert.deepEqual(f.store.listProjectDocs('alpha'), []);
    } finally { await s.close(); }
  } finally { await f.cleanup(); }
});

test('GET /bus counts the posts on each Team chat ticket the caller has not seen; POST /tickets/:id/seen marks them (SP-163)', async () => {
  const f = await fixture();
  try {
    f.store.createProject({ slug: 'sc-bus', name: 'StarCaster Bus', prefix: 'SB', operator: f.human.id });
    const chat = f.store.fileTicket({ project: 'sc-bus', actor: f.machine.id, name: 'Team chat', status: 'live' });
    const other = f.store.fileTicket({ project: 'sc-bus', actor: f.machine.id, name: 'A steward question', status: 'queued' });
    const as = { token: f.humanToken };
    assert.deepEqual((await f.call('GET', '/bus', as)).body, { total: 0, unseen: [] }, 'nothing posted, nothing counted');
    for (const body of ['ALARM: one', 'weekly report']) {
      assert.equal((await f.call('POST', `/tickets/${chat.id}/comments`, { body: { body } })).status, 201);
    }
    await f.call('POST', `/tickets/${other.id}/comments`, { body: { body: 'not the bus' } });
    await f.call('POST', `/tickets/${chat.id}/comments`, { ...as, body: { body: 'stop' } });
    assert.deepEqual((await f.call('GET', '/bus', as)).body, {
      total: 2, unseen: [{ id: chat.id, name: 'Team chat', project: 'sc-bus', projectName: 'StarCaster Bus', count: 2 }],
    }, 'only Team chat counts, and never his own comment');
    const seen = await f.call('POST', `/tickets/${chat.id}/seen`, as);
    assert.equal(seen.status, 200);
    assert.equal(seen.body.ticket, chat.id);
    assert.deepEqual((await f.call('GET', '/bus', as)).body, { total: 0, unseen: [] });
    assert.equal((await f.call('GET', '/bus')).body.total, 1, 'the mark is his only: the loop has its own count, his "stop"');
    await f.call('POST', `/tickets/${chat.id}/comments`, { body: { body: 'a new one' } });
    assert.equal((await f.call('GET', '/bus', as)).body.total, 1);
    assert.equal((await f.call('POST', '/tickets/SB-99/seen', as)).status, 404);
    assert.equal((await f.call('GET', '/bus', { token: null })).status, 401);
  } finally { await f.cleanup(); }
});

test('GET /pipeline answers each loop stage from the logs the project config names, to any signed-in caller; times and flags only (SP-168)', async () => {
  const f = await fixture();
  try {
    const logs = join(f.dir, 'logs');
    mkdirSync(logs);
    const stamp = (d) => d.toLocaleString('sv-SE').replace('T', ' '); // 2026-11-09 18:22:34, local time
    const began = new Date('2026-11-09T18:22:34');
    writeFileSync(join(logs, 'alpha-loop-review.log'), `===== ${stamp(began)} START /loop-review =====\nreport text\n`);
    const server = await startServer({ store: f.store, port: 0, pipeline: { logDir: logs, slug: 'alpha' } });
    try {
      const at = `http://127.0.0.1:${server.address().port}`;
      for (const token of [f.humanToken, f.machineToken]) {
        const answer = await f.call('GET', '/pipeline', { token, at });
        assert.equal(answer.status, 200);
        assert.deepEqual(answer.body.stages.map((s) => [s.name, s.logged, s.running]), [
          ['Relay', false, false], ['Build', false, false], ['Review', true, true], ['Intake', false, false],
        ]);
        assert.equal(answer.body.stages[2].lastStart, began.toISOString());
        // SP-173's extra fields for the dialog: the last end and its exit code, and how often it wakes.
        assert.deepEqual([answer.body.stages[2].lastEnd, answer.body.stages[2].lastExit, answer.body.stages[2].interval], [null, null, 1800]);
        // SP-218's health fields: nothing has failed, so nothing is failing.
        for (const s of answer.body.stages) assert.deepEqual([s.failing, s.failedPasses, s.failingSince, s.failingReason], [false, 0, null, null]);
        assert.doesNotMatch(answer.text, /report text/);
      }
      assert.equal((await f.call('GET', '/pipeline', { token: null, at })).status, 401);
    } finally { await new Promise((r) => server.close(r)); }
    // A tracker started without a usable project config says why, and nothing else changes.
    const none = await f.call('GET', '/pipeline');
    assert.equal(none.status, 503);
    assert.equal(none.body.error, 'no-pipeline');
  } finally { await f.cleanup(); }
});

test('a relay that keeps failing holds up a ticket he already answered: the ticket says so and GET /waiting leaves it out; one passing pass brings it back only if it is still his move (SP-228)', async () => {
  const f = await fixture();
  try {
    const logs = join(f.dir, 'logs');
    mkdirSync(logs);
    const stamp = (d) => d.toLocaleString('sv-SE').replace('T', ' ');
    const first = new Date('2026-11-10T21:00:00');
    const pass = (start, exit) => [
      `===== ${stamp(start)} START relay — /repo =====`,
      exit ? 'gh: a step failed' : 'merged nothing',
      `===== ${stamp(new Date(start.getTime() + 15000))} END relay — ${exit ? 'A STEP FAILED AND SAID SO ABOVE' : 'pass complete'} (exit ${exit}) =====`,
    ];
    const relayLog = join(logs, 'alpha-relay.log');
    const failed = [0, 10, 20].flatMap((m) => pass(new Date(first.getTime() + m * 60000), 1));
    writeFileSync(relayLog, `${failed.join('\n')}\n`);

    const answered = f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: 'Answered comet', status: 'Ready to launch', assignee: f.human.id });
    f.store.postComment({ ticket: answered.id, author: f.machine.id, body: '@@ASKED\nmerge it\n\nYour move: Merge', parent: null });
    f.store.postComment({ ticket: answered.id, author: f.human.id, body: 'merge', parent: null });
    const asked = f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: 'Asked comet', status: 'Needs your input', assignee: f.human.id });
    f.store.postComment({ ticket: asked.id, author: f.human.id, body: 'an earlier word', parent: null });
    f.store.postComment({ ticket: asked.id, author: f.machine.id, body: '@@ASKED\nwhich?\n\nYour move: Reply', parent: null });

    const server = await startServer({ store: f.store, port: 0, pipeline: { logDir: logs, slug: 'alpha' } });
    try {
      const at = `http://127.0.0.1:${server.address().port}`;
      const as = (method, path) => f.call(method, path, { token: f.humanToken, at });
      const listed = async () => (await as('GET', '/waiting')).body.waiting.map((t) => t.id);

      const held = (await as('GET', `/tickets/${answered.id}/thread`)).body;
      assert.deepEqual(held.heldUp, { stage: 'Relay', job: 'relay', reason: 'keeps failing', since: first.toISOString() });
      assert.equal((await as('GET', `/tickets/${asked.id}/thread`)).body.heldUp, null, 'a loop\'s question is truly his move, failing relay or not');
      assert.deepEqual(await listed(), [asked.id], 'the held-up ticket is not on Waiting on You; the real wait is');

      // One passing relay pass: the line goes. His "merge" is still the newest word, so by the loop's own verdict it is not his move.
      writeFileSync(relayLog, `${[...failed, ...pass(new Date(first.getTime() + 30 * 60000), 0)].join('\n')}\n`);
      assert.equal((await as('GET', `/tickets/${answered.id}/thread`)).body.heldUp, null);
      assert.deepEqual(await listed(), [asked.id]);
      // The relay answers him (as on SP-207, a refusal): now it is his move again, and listed.
      f.store.postComment({ ticket: answered.id, author: f.machine.id, body: 'The PR is already merged. Your move: Close', parent: null });
      assert.deepEqual((await listed()).sort(), [answered.id, asked.id].sort());
    } finally { await new Promise((r) => server.close(r)); }
    // A tracker that reads no logs holds nothing up.
    assert.equal((await f.call('GET', `/tickets/${answered.id}/thread`, { token: f.humanToken })).body.heldUp, null);
  } finally { await f.cleanup(); }
});

test('GET /in-flight lists every ticket but Live on the projects the caller may see, with next change from the loop logs; a member of one project sees only it; signed out is 401 (SP-221)', async () => {
  const f = await fixture();
  try {
    f.store.createProject({ slug: 'beta', name: 'Beta', prefix: 'BE', operator: f.human.id });
    const viewer = f.store.createActor({ kind: 'human', name: 'Viewer' });
    const vt = f.store.issueToken(viewer.id);
    f.store.setRole({ actor: viewer.id, role: 'viewer', by: f.human.id });
    f.store.addMember({ project: 'alpha', actor: viewer.id, by: f.human.id });
    const statuses = loopStatuses.STAGE_ORDER;
    for (const status of statuses) f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: `Alpha ${status}`, status });
    const hidden = f.store.fileTicket({ project: 'beta', actor: f.machine.id, name: 'Hidden comet', status: 'Queued' });

    const logs = join(f.dir, 'logs');
    mkdirSync(logs);
    const stamp = (d) => d.toLocaleString('sv-SE').replace('T', ' ');
    const ended = new Date('2026-11-09T18:25:36');
    writeFileSync(join(logs, 'alpha-loop-build.log'), [
      `===== ${stamp(new Date('2026-11-09T18:22:34'))} START /loop-build =====`,
      `===== ${stamp(ended)} END /loop-build (exit 0) =====`,
      `[loop-runner] ${stamp(ended).slice(11)} sleeping 1800s before the next /loop-build`, '',
    ].join('\n'));
    const server = await startServer({ store: f.store, port: 0, pipeline: { logDir: logs, slug: 'alpha' } });
    try {
      const at = `http://127.0.0.1:${server.address().port}`;
      const admin = await f.call('GET', '/in-flight', { token: f.humanToken, at });
      assert.equal(admin.status, 200, admin.text);
      assert.deepEqual(admin.body.projects.map((p) => [p.slug, p.logo]), [['alpha', null], ['beta', null]]);
      assert.deepEqual(admin.body.tickets.filter((t) => t.project === 'alpha').map((t) => t.status), statuses.filter((s) => s !== 'Live'));
      assert.ok(admin.body.tickets.some((t) => t.id === hidden.id), 'an admin sees every project');
      const byStatus = Object.fromEntries(admin.body.tickets.filter((t) => t.project === 'alpha').map((t) => [t.status, t.nextChange]));
      const due = new Date(ended.getTime() + 1800 * 1000).toISOString();
      assert.deepEqual(byStatus.Queued, { kind: 'lane', lane: 'Build', job: 'loop-build', running: false, due });
      assert.deepEqual(byStatus.Rework, byStatus.Queued);
      assert.equal(byStatus['In review'], null, 'no review log: null, never a guess');
      assert.equal(byStatus.Requested, null, 'no intake log');
      assert.deepEqual(byStatus.Building, { kind: 'running', lane: 'Build', job: 'loop-build' });
      assert.deepEqual(byStatus['Needs your input'], { kind: 'operator' });
      assert.equal(admin.body.tickets.find((t) => t.id === hidden.id).nextChange, null, 'beta is not the project whose logs this tracker reads');

      const member = await f.call('GET', '/in-flight', { token: vt, at });
      assert.equal(member.status, 200);
      assert.deepEqual(member.body.projects.map((p) => p.slug), ['alpha']);
      assert.ok(member.body.tickets.every((t) => t.project === 'alpha'));
      assert.ok(!member.text.includes('Hidden comet') && !member.text.includes('Beta'), 'nothing of beta is given away');

      assert.equal((await f.call('GET', '/in-flight', { token: null, at })).status, 401);
    } finally { await new Promise((r) => server.close(r)); }
    // A tracker that cannot read the loop logs still answers, with no lane times.
    const blind = await f.call('GET', '/in-flight');
    assert.equal(blind.status, 200);
    assert.equal(blind.body.tickets.find((t) => t.status === 'Queued').nextChange, null);
  } finally { await f.cleanup(); }
});

test('GET /documentation lists the docs folder\'s Markdown by title and reads one; a path outside it is 404 and reads nothing (SP-175)', async () => {
  const f = await fixture();
  try {
    const docs = join(f.dir, 'docs');
    mkdirSync(join(docs, 'onboarding'), { recursive: true });
    writeFileSync(join(docs, 'LOOP_CONTRACT.md'), '# Loop Contract\n\n## Statuses\n\n- Queued\n');
    writeFileSync(join(docs, 'onboarding', 'WIZARD.md'), 'No heading here.\n');
    writeFileSync(join(docs, 'notes.txt'), 'not Markdown');
    // A file beside the folder, and one a link inside the folder points at: neither may ever be read.
    writeFileSync(join(f.dir, 'secret.md'), '# Secret\nSECRET-WORDS\n');
    symlinkSync(join(f.dir, 'secret.md'), join(docs, 'linked.md'));
    const server = await startServer({ store: f.store, port: 0, docsDir: docs });
    try {
      const at = `http://127.0.0.1:${server.address().port}`;
      for (const token of [f.humanToken, f.machineToken]) {
        const list = await f.call('GET', '/documentation', { token, at });
        assert.equal(list.status, 200);
        assert.deepEqual(list.body.files, [
          { path: 'LOOP_CONTRACT.md', title: 'Loop Contract' },
          { path: 'onboarding/WIZARD.md', title: 'WIZARD' },
        ]);
      }
      const one = await f.call('GET', '/documentation/LOOP_CONTRACT.md', { at });
      assert.equal(one.status, 200);
      assert.deepEqual(one.body, { path: 'LOOP_CONTRACT.md', title: 'Loop Contract', text: '# Loop Contract\n\n## Statuses\n\n- Queued\n' });
      assert.equal((await f.call('GET', '/documentation/onboarding/WIZARD.md', { at })).body.title, 'WIZARD');
      for (const path of [
        '/documentation/..%2Fsecret.md', '/documentation/%2E%2E/secret.md', '/documentation/onboarding/..%2F..%2Fsecret.md',
        `/documentation/${encodeURIComponent(join(f.dir, 'secret.md'))}`, '/documentation/%2Fetc%2Fpasswd',
        '/documentation/linked.md', '/documentation/notes.txt', '/documentation/missing.md', '/documentation/onboarding',
      ]) {
        const answer = await f.call('GET', path, { at });
        assert.equal(answer.status, 404, path);
        assert.doesNotMatch(answer.text, /SECRET-WORDS/, path);
      }
      assert.equal((await f.call('GET', '/documentation', { token: null, at })).status, 401);
      assert.equal((await f.call('GET', '/documentation/LOOP_CONTRACT.md', { token: null, at })).status, 401);
    } finally { await new Promise((r) => server.close(r)); }
    // With no folder named, the tracker reads this repository's own docs/.
    const own = await f.call('GET', '/documentation');
    assert.ok(own.body.files.some((d) => d.path === 'LOOP_CONTRACT.md'));
    assert.ok(own.body.files.some((d) => d.path.startsWith('work-log/')));
  } finally { await f.cleanup(); }
});

test('a /docs/spirality/<path> address is the page, whatever the browser asks for (SP-175)', async () => {
  const f = await fixture();
  try {
    const base = await f.serve();
    for (const path of ['/docs/spirality/LOOP_CONTRACT.md', '/docs/spirality/onboarding/WIZARD.md']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type'), /text\/html/);
    }
  } finally { await f.cleanup(); }
});

test('pipeline controls: anyone signed in reads them, defaults marked; the operator changes one and the change is logged; anyone else or a loop is refused 403; a bad value is 400; neither writes (SP-224)', async () => {
  const f = await fixture();
  try {
    const other = f.store.createActor({ kind: 'human', name: 'Someone Else' });
    f.store.addMember({ project: 'alpha', actor: other.id, by: f.human.id });
    const otherToken = f.store.issueToken(other.id);
    const control = (view, key) => view.controls.find((c) => c.key === key);

    const all = await f.call('GET', '/pipeline-controls');
    assert.equal(all.status, 200, all.text);
    assert.deepEqual(all.body.projects.map((p) => p.project.slug), ['alpha']);
    const read = await f.call('GET', '/pipeline-controls/alpha');
    assert.equal(read.status, 200);
    assert.deepEqual(control(read.body, 'wake.loop-build'), { ...control(read.body, 'wake.loop-build'), value: '1800', isDefault: true });
    assert.equal(read.body.canChange, false, 'a loop may never change its own controls');
    assert.deepEqual(read.body.groups.map((g) => g.wiredBy), ['SP-236', 'SP-237', 'SP-238', 'SP-239', null], 'Quiet Days Before Moving is in use already (SP-277)');
    assert.equal((await f.call('GET', '/pipeline-controls/alpha', { token: f.humanToken })).body.canChange, true);
    assert.equal((await f.call('GET', '/pipeline-controls/alpha', { token: otherToken })).body.canChange, false);
    assert.equal((await f.call('GET', '/pipeline-controls/nope')).status, 404);
    assert.equal((await f.call('GET', '/pipeline-controls', { token: null })).status, 401);

    const saved = await f.call('PUT', '/pipeline-controls/alpha', { token: f.humanToken, body: { setting: 'wake.loop-build', value: '900' } });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(saved.body.saved, { setting: 'wake.loop-build', from: '1800', to: '900', changed: true });
    assert.equal(control(saved.body, 'wake.loop-build').value, '900');
    assert.deepEqual(saved.body.changes.map((c) => [c.actorName, c.label, c.from, c.to]), [['Operator', 'loop-build wake time', '1800', '900']]);
    assert.equal(control((await f.call('GET', '/pipeline-controls/alpha')).body, 'wake.loop-build').value, '900', 'read back by another sign-in');

    for (const [token, why] of [[f.machineToken, /a loop sign-in may not/], [otherToken, /you are not its operator/]]) {
      const refused = await f.call('PUT', '/pipeline-controls/alpha', { token, body: { setting: 'wake.loop-build', value: '600' } });
      assert.equal(refused.status, 403, refused.text);
      assert.match(refused.body.message, why);
    }
    for (const body of [{ setting: 'wake.loop-build', value: '30' }, { setting: 'wip-cap', value: 0 }, { setting: 'model.loop-build', value: 'gpt-9' }, { setting: 'nope', value: '1' }, { setting: 'wip-cap', value: 3, extra: 1 }]) {
      const bad = await f.call('PUT', '/pipeline-controls/alpha', { token: f.humanToken, body });
      assert.equal(bad.status, 400, JSON.stringify(body));
      assert.ok(bad.body.message);
    }
    assert.equal(f.store.pipelineSettingChanges('alpha').length, 1, 'a refused change logs nothing');
    assert.equal(control(f.store.pipelineSettings('alpha').reduce((v, c) => ({ controls: [...v.controls, c] }), { controls: [] }), 'wake.loop-build').value, '900');
  } finally { await f.cleanup(); }
});

test('Quiet Days Before Moving: 0 to 30, default 0; set for another project, refused 409 for the tracker\'s home, whose page view leaves it out (SP-277)', async () => {
  const f = await fixture();
  try {
    f.store.createProject({ slug: 'home', name: 'Home', prefix: 'HO', operator: f.human.id });
    const at = await f.serve(f.store, { ownProject: 'home' });
    const value = (view) => view.controls.find((c) => c.key === 'release.quiet-days');
    const alpha = (await f.call('GET', '/pipeline-controls/alpha', { at })).body;
    assert.equal(alpha.own, false);
    assert.deepEqual({ ...value(alpha) }, { ...value(alpha), value: '0', isDefault: true, min: 0, max: 30, kind: 'days', group: 'release-move' });
    assert.deepEqual(alpha.groups.at(-1), { key: 'release-move', title: 'Quiet Days Before Moving', wiredBy: null, notOnOwnProject: true });
    assert.equal((await f.call('GET', '/pipeline-controls/home', { at })).body.own, true);

    const saved = await f.call('PUT', '/pipeline-controls/alpha', { at, token: f.humanToken, body: { setting: 'release.quiet-days', value: '7' } });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(saved.body.saved, { setting: 'release.quiet-days', from: '0', to: '7', changed: true });
    for (const bad of ['31', '-1', 'soon']) {
      assert.equal((await f.call('PUT', '/pipeline-controls/alpha', { at, token: f.humanToken, body: { setting: 'release.quiet-days', value: bad } })).status, 400, bad);
    }
    const own = await f.call('PUT', '/pipeline-controls/home', { at, token: f.humanToken, body: { setting: 'release.quiet-days', value: '3' } });
    assert.equal(own.status, 409, own.text);
    assert.match(own.body.message, /Home is the tracker's home project: its lanes always run main, so "Quiet Days Before Moving" is not set for it/);
    assert.equal(f.store.pipelineSettingChanges('home').length, 0, 'the refusal wrote nothing');
    const wake = await f.call('PUT', '/pipeline-controls/home', { at, token: f.humanToken, body: { setting: 'wake.relay', value: '900' } });
    assert.equal(wake.status, 200, 'the home project\'s other controls still change');
  } finally { await f.cleanup(); }
});

test('releases: GET answers each project\'s release, Spirality\'s own as main; a loop or the operator names one and rolls it back, read back (SP-265)', async () => {
  const f = await fixture();
  try {
    f.store.createProject({ slug: 'home', name: 'Home', prefix: 'HO', operator: f.human.id });
    const at = await f.serve(f.store, { ownProject: 'home' });
    const all = await f.call('GET', '/releases', { at });
    assert.equal(all.status, 200);
    assert.equal(all.body.ownProject, 'home');
    assert.equal(all.body.ownRelease, 'main (always the newest)');
    assert.deepEqual(all.body.projects.map((p) => [p.slug, p.own, p.release]), [['alpha', false, null], ['home', true, null]]);

    const named = await f.call('PUT', '/releases/alpha', { at, body: { release: 'release-1' } });
    assert.equal(named.status, 200);
    assert.deepEqual(named.body.saved, { project: 'alpha', from: null, to: 'release-1', changed: true });
    assert.equal(named.body.release, 'release-1');
    await f.call('PUT', '/releases/alpha', { at, token: f.humanToken, body: { release: 'release-2' } });
    const read = await f.call('GET', '/releases/alpha', { at, token: f.humanToken });
    assert.equal(read.body.release, 'release-2', 'read back by another sign-in');
    assert.deepEqual(read.body.history.map((h) => [h.release, h.actor]), [['release-2', f.human.id], ['release-1', f.machine.id]]);

    const back = await f.call('POST', '/releases/alpha/back', { at });
    assert.equal(back.status, 200);
    assert.deepEqual(back.body.saved, { project: 'alpha', from: 'release-2', to: 'release-1', changed: true });
    assert.equal((await f.call('GET', '/releases/alpha', { at })).body.release, 'release-1');
    assert.ok(f.lines.some((l) => l === `release alpha release-2 -> release-1 (roll-back) actor=${f.machine.id}`));
  } finally { await f.cleanup(); }
});

test('releases: Spirality\'s own project, a bad name, a roll-back with nowhere to go, someone else and a tracker that cannot tell its own project are refused, writing nothing (SP-265)', async () => {
  const f = await fixture();
  try {
    f.store.createProject({ slug: 'home', name: 'Home', prefix: 'HO', operator: f.human.id });
    const at = await f.serve(f.store, { ownProject: 'home' });
    const own = await f.call('PUT', '/releases/home', { at, body: { release: 'release-1' } });
    assert.equal(own.status, 409);
    assert.equal(own.body.error, 'own-project');
    assert.match(own.body.message, /its lanes always run main/);
    assert.equal((await f.call('POST', '/releases/home/back', { at })).body.error, 'own-project');
    const bad = await f.call('PUT', '/releases/alpha', { at, body: { release: 'v2' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'bad-release');
    assert.equal((await f.call('PUT', '/releases/alpha', { at, body: { release: 'release-1', extra: 1 } })).body.error, 'bad-field');
    const nowhere = await f.call('POST', '/releases/alpha/back', { at });
    assert.equal(nowhere.status, 409);
    assert.equal(nowhere.body.error, 'nothing-to-roll-back-to');
    const someone = f.store.createActor({ kind: 'human', name: 'Someone Else' });
    f.store.addMember({ project: 'alpha', actor: someone.id, by: f.human.id });
    const otherToken = f.store.issueToken(someone.id);
    const other = await f.call('PUT', '/releases/alpha', { at, token: otherToken, body: { release: 'release-1' } });
    assert.equal(other.status, 403);
    assert.equal(other.body.error, 'not-allowed');
    assert.equal((await f.call('GET', '/releases/nope', { at })).status, 404);
    assert.equal((await f.call('GET', '/releases', { at, token: null })).status, 401);
    // The fixture's first server was started with no project config.
    const blind = await f.call('PUT', '/releases/alpha', { body: { release: 'release-1' } });
    assert.equal(blind.status, 503);
    assert.equal(blind.body.error, 'no-own-project');
    assert.deepEqual(f.store.projectReleases('alpha'), []);
  } finally { await f.cleanup(); }
});
