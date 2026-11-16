/**
 * Which files each open pull request changes (lib/prFiles.js): the store's
 * record, the API the door calls, and the ticket page's same-file lines.
 * GitHub is never asked here; the door reads it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { startServer } from './server.mjs';
import { sharedFilesOf, threadOf } from './pageData.mjs';
import { renderSharedFiles } from './web/render.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pr-files-'));
  const store = openStore(join(dir, 'tracker.db'));
  const human = store.createActor({ kind: 'human', name: 'Operator' });
  const machine = store.createActor({ kind: 'machine', name: 'Loop' });
  store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL', operator: human.id });
  store.createProject({ slug: 'beta', name: 'Beta', prefix: 'BE', operator: human.id });
  const file = (project, name) => store.fileTicket({ project, actor: machine.id, name, status: 'Queued' }).id;
  const a = file('alpha', 'First');
  const b = file('alpha', 'Second');
  const c = file('alpha', 'Third');
  const other = file('beta', 'Elsewhere');
  const cleanup = () => { store.close(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, store, human, machine, a, b, c, other, cleanup };
}

const HEAD = 'abc1234def5678abc1234def5678abc1234def56';

test('a loop records a pull request\'s files, replaced whole on the next read, and forgets them once it closes', () => {
  const f = fixture();
  try {
    const saved = f.store.recordPrFiles({ project: 'alpha', number: 40, ticket: f.a.toLowerCase(), repo: 'owner/app', head: HEAD, files: ['b.js', ' a.js', 'b.js'], actor: f.machine.id });
    assert.equal(saved.ticket, f.a);
    assert.deepEqual(saved.files, ['a.js', 'b.js']);
    assert.equal(saved.head, HEAD);
    f.store.recordPrFiles({ project: 'alpha', number: 40, ticket: f.a, repo: 'owner/app', head: 'fff0000', files: ['c.js'], actor: f.machine.id });
    assert.deepEqual(f.store.prFiles('alpha').map((r) => [r.number, r.head, r.files]), [[40, 'fff0000', ['c.js']]]);
    assert.deepEqual(f.store.forgetPrFiles({ project: 'alpha', number: 40, actor: f.machine.id }), { project: 'alpha', number: 40, forgotten: true });
    assert.deepEqual(f.store.prFiles('alpha'), []);
    assert.equal(f.store.forgetPrFiles({ project: 'alpha', number: 40, actor: f.machine.id }).forgotten, false);
  } finally { f.cleanup(); }
});

test('the store refuses a person, a ticket in another project, and files that are not a list of paths', () => {
  const f = fixture();
  try {
    const base = { project: 'alpha', number: 41, ticket: f.a, repo: 'owner/app', head: HEAD, files: ['a.js'], actor: f.machine.id };
    assert.throws(() => f.store.recordPrFiles({ ...base, actor: f.human.id }), { code: 'not-allowed' });
    assert.throws(() => f.store.recordPrFiles({ ...base, ticket: f.other }), { code: 'unknown-ticket' });
    assert.throws(() => f.store.recordPrFiles({ ...base, files: null }), { code: 'bad-files' });
    assert.throws(() => f.store.recordPrFiles({ ...base, files: 'a.js' }), { code: 'bad-files' });
    assert.throws(() => f.store.recordPrFiles({ ...base, number: 0 }), { code: 'bad-number' });
    assert.throws(() => f.store.recordPrFiles({ ...base, repo: 'app' }), { code: 'bad-repo' });
    assert.throws(() => f.store.recordPrFiles({ ...base, head: 'not a sha' }), { code: 'bad-head' });
    assert.throws(() => f.store.forgetPrFiles({ project: 'alpha', number: 41, actor: f.human.id }), { code: 'not-allowed' });
    assert.deepEqual(f.store.prFiles('alpha'), [], 'nothing refused was stored');
  } finally { f.cleanup(); }
});

test('the ticket page names each other open pull request sharing a file, and only the shared files', () => {
  const f = fixture();
  try {
    const put = (number, ticket, files) => f.store.recordPrFiles({ project: 'alpha', number, ticket, repo: 'owner/app', head: HEAD, files, actor: f.machine.id });
    put(40, f.a, ['tracker/app.mjs', 'tracker/store.mjs']);
    put(41, f.b, ['tracker/store.mjs', 'docs/x.md']);
    put(42, f.c, ['docs/y.md']);
    const shared = sharedFilesOf(f.store, f.store.getTicket(f.a));
    assert.deepEqual(shared, [{ ticket: f.b, ticketName: 'Second', number: 41, url: 'https://github.com/owner/app/pull/41', files: ['tracker/store.mjs'] }]);
    assert.deepEqual(sharedFilesOf(f.store, f.store.getTicket(f.c)), []);
    assert.deepEqual(threadOf(f.store, f.a).sharedFiles, shared);
    const html = renderSharedFiles({ sharedFiles: shared });
    assert.match(html, /Changes the same files as <a href="\/t\/AL-2" title="Second">AL-2<\/a> \(<a href="https:\/\/github\.com\/owner\/app\/pull\/41"[^>]*>PR #41<\/a>\): <code>tracker\/store\.mjs<\/code>/);
    assert.equal(renderSharedFiles({ sharedFiles: [] }), '');
    assert.equal(renderSharedFiles({}), '');
  } finally { f.cleanup(); }
});

test('renderSharedFiles writes every name as text and links only a GitHub address', () => {
  const html = renderSharedFiles({ sharedFiles: [{ ticket: 'AL-9', ticketName: '"><b>', number: 3, url: 'javascript:alert(1)', files: ['<img src=x>'] }] });
  assert.ok(!html.includes('<img'), html);
  assert.ok(!html.includes('javascript:'), html);
  assert.match(html, /PR #3: |\(PR #3\)/);
});

test('the API: anyone signed in reads a project\'s records; only a loop writes or forgets one', async () => {
  const f = fixture();
  const loopToken = f.store.issueToken(f.machine.id);
  const personToken = f.store.issueToken(f.human.id);
  const server = await startServer({ store: f.store, port: 0 });
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, method, path, body) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    const write = { ticket: f.a, repo: 'owner/app', head: HEAD, files: ['a.js', 'b.js'] };
    const person = await call(personToken, 'PUT', '/pr-files/alpha/40', write);
    assert.equal(person.status, 403);
    const saved = await call(loopToken, 'PUT', '/pr-files/alpha/40', write);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.files, ['a.js', 'b.js']);
    const bad = await call(loopToken, 'PUT', '/pr-files/alpha/41', { ...write, files: 'a.js' });
    assert.equal(bad.status, 400);
    const elsewhere = await call(loopToken, 'PUT', '/pr-files/alpha/41', { ...write, ticket: f.other });
    assert.equal(elsewhere.status, 404);
    assert.equal(elsewhere.body.error, 'unknown-ticket');
    const extra = await call(loopToken, 'PUT', '/pr-files/alpha/41', { ...write, more: 1 });
    assert.equal(extra.status, 400);
    const read = await call(personToken, 'GET', '/pr-files/alpha');
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.pullRequests.map((r) => [r.number, r.ticket, r.files]), [[40, f.a, ['a.js', 'b.js']]]);
    assert.equal((await call(personToken, 'DELETE', '/pr-files/alpha/40')).status, 403);
    const gone = await call(loopToken, 'DELETE', '/pr-files/alpha/40');
    assert.deepEqual(gone.body, { project: 'alpha', number: 40, forgotten: true });
    assert.deepEqual((await call(loopToken, 'GET', '/pr-files/alpha')).body.pullRequests, []);
    assert.equal((await call(loopToken, 'GET', '/pr-files/nowhere')).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
    f.cleanup();
  }
});
