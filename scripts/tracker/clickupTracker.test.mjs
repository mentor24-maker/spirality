import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClickupTracker, NO_ATTACHMENTS_ON_CLICKUP } from './clickupTracker.mjs';
import { isMachineComment } from '../lib/machineComment.mjs';

/** A stand-in ClickUp: records every request, answers with `reply(req)`. */
async function fakeClickup(reply = () => ({ status: 200, json: {} })) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const entry = { method: req.method, path: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null };
      seen.push(entry);
      const { status = 200, json = {}, headers = {} } = reply(entry, seen.length);
      res.writeHead(status, { 'content-type': 'application/json', 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '42', ...headers });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  return { seen, apiBase, close: () => new Promise((r) => server.close(r)) };
}

test('every method reaches the same ClickUp address the door used to call', async () => {
  const api = await fakeClickup(() => ({ json: { comments: [] } }));
  const lines = [];
  const t = createClickupTracker({ token: 'tok', apiBase: api.apiBase, log: (l) => lines.push(l) });
  try {
    await t.whoAmI();
    await t.listsInSpace('9');
    await t.foldersInSpace('9');
    await t.listTasksPage('5', 2);
    await t.listTasksPage('5', 0, { includeClosed: true });
    await t.listTasksPage('5', 1, { markdown: true });
    await t.getTask('abc');
    await t.getTask('abc', { markdown: true });
    await t.createTask('5', { name: 'n' });
    await t.updateTask('abc', { status: 'queued' });
    await t.setTag('abc', 'wont do', true);
    await t.setTag('abc', 'wont do', false);
    await t.listComments('abc');
    await t.listReplies('77');
    assert.deepEqual(api.seen.map((r) => `${r.method} ${r.path}`), [
      'GET /api/v2/user',
      'GET /api/v2/space/9/list?archived=false',
      'GET /api/v2/space/9/folder?archived=false',
      'GET /api/v2/list/5/task?archived=false&page=2',
      'GET /api/v2/list/5/task?archived=false&include_closed=true&page=0',
      'GET /api/v2/list/5/task?archived=false&include_markdown_description=true&page=1',
      'GET /api/v2/task/abc',
      'GET /api/v2/task/abc?include_markdown_description=true',
      'POST /api/v2/list/5/task',
      'PUT /api/v2/task/abc',
      'POST /api/v2/task/abc/tag/wont%20do',
      'DELETE /api/v2/task/abc/tag/wont%20do',
      'GET /api/v2/task/abc/comment',
      'GET /api/v2/comment/77/reply',
    ]);
    assert.ok(api.seen.every((r) => r.auth === 'tok'));
    t.reportLimits();
    assert.deepEqual(lines, ["  ClickUp's own limit: 42 of 100 left this minute (14 request(s) this run)"]);
  } finally { await api.close(); }
});

test('a comment or a reply carries the machine stamp; a task write does not', async () => {
  const api = await fakeClickup();
  const t = createClickupTracker({ token: 'tok', apiBase: api.apiBase, log: () => {} });
  try {
    await t.postComment('abc', { comment_text: 'hello' });
    await t.replyToComment('77', { comment_text: 'marker' });
    await t.updateTask('abc', { markdown_description: 'body' });
    const [comment, reply, update] = api.seen;
    assert.equal(comment.path, '/api/v2/task/abc/comment');
    assert.equal(reply.path, '/api/v2/comment/77/reply');
    assert.ok(isMachineComment(comment.body.comment_text));
    assert.ok(isMachineComment(reply.body.comment_text));
    assert.deepEqual(update.body, { markdown_description: 'body' });
  } finally { await api.close(); }
});

test('a failed comment read comes back as `bad`, for the door to report', async () => {
  const api = await fakeClickup(() => ({ status: 500, json: { err: 'boom' } }));
  const t = createClickupTracker({ token: 'tok', apiBase: api.apiBase, log: () => {} });
  try {
    const { paged, bad } = await t.listComments('abc');
    assert.equal(paged.complete, false);
    assert.equal(bad.res.status, 500);
    assert.equal(bad.json.err, 'boom');
  } finally { await api.close(); }
});

test('a 429 is repeated after the reset, then answered', async () => {
  const api = await fakeClickup((_, n) => (n === 1
    ? { status: 429, headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000)) } }
    : { json: { user: { id: 1 } } }));
  const lines = [];
  const t = createClickupTracker({ token: 'tok', apiBase: api.apiBase, log: (l) => lines.push(l) });
  try {
    const out = await t.whoAmI();
    assert.equal(out.res.status, 200);
    assert.equal(api.seen.length, 2);
    assert.match(lines[0], /rate limit \(attempt 1\)/);
  } finally { await api.close(); }
});

test('a request that never arrives answers HTTP 0, not a throw', async () => {
  const t = createClickupTracker({ token: 'tok', apiBase: 'http://127.0.0.1:1', log: () => {} });
  const out = await t.getTask('abc');
  assert.equal(out.res.ok, false);
  assert.equal(out.res.status, 0);
  assert.match(out.text, /never reached ClickUp/);
});

test('the door names no ClickUp address of its own', () => {
  const door = readFileSync(new URL('../clickup.mjs', import.meta.url), 'utf8');
  assert.equal((door.match(/\/api\/v2/g) || []).length, 0);
});

/** The real door on a ClickUp project config, against the stand-in ClickUp. */
function clickupDoor(apiBase, args) {
  const dir = mkdtempSync(join(tmpdir(), 'clickup-door-'));
  writeFileSync(join(dir, 'spirality.project.json'), JSON.stringify({
    workspaceId: '111', spaceId: '222', loopQueueListId: '333',
    operatorUserId: 1, machineUserId: 2,
    githubRepo: 'owner/repo', dopplerProject: 'proj', dopplerConfig: 'dev',
    launchdPrefix: 'com.example', logDir: '~/loop-logs', mergePhrases: ['merge'],
    governancePaths: [], autoMergeLanes: [], operatorName: 'Dane', projectSlug: 'alpha',
    legacyMachinePrefixes: [], projectScripts: {}, tracker: 'clickup',
  }));
  const door = fileURLToPath(new URL('../clickup.mjs', import.meta.url));
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, CLICKUP_API_TOKEN: 'tok', CLICKUP_API_BASE: apiBase };
    const child = spawn(process.execPath, [door, ...args.map((a) => a.replace('<dir>', dir))], { cwd: dir, env });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => { rmSync(dir, { recursive: true, force: true }); resolve({ code, out, err, dir }); });
    child.stdin.end();
  });
}

test('attachments on ClickUp: no request, and the command exits 1 with a plain sentence, never a success line (SP-142)', async () => {
  const api = await fakeClickup();
  const t = createClickupTracker({ token: 'tok', apiBase: api.apiBase, log: () => {} });
  try {
    for (const out of [await t.listAttachments('abc'), await t.downloadAttachment('abc', 1)]) {
      assert.equal(out.res.ok, false);
      assert.equal(out.unsupported, true);
      assert.equal(out.json.err, NO_ATTACHMENTS_ON_CLICKUP);
    }
    assert.equal(api.seen.length, 0);

    const r = await clickupDoor(api.apiBase, ['attachments', '--task', 'abc', '--to', '<dir>/saved']);
    assert.equal(r.code, 1);
    assert.equal(r.out, '');
    assert.equal(r.err.trim(), NO_ATTACHMENTS_ON_CLICKUP);
    assert.equal(existsSync(join(r.dir, 'saved')), false);
  } finally { await api.close(); }
});

test('get on ClickUp says files are not kept there, rather than "(none)" (SP-142)', async () => {
  const api = await fakeClickup((req) => (req.path.includes('/comment')
    ? { json: { comments: [] } }
    : { json: { id: 'abc', name: 'A ticket', status: { status: 'queued' }, list: { id: '333', name: 'Loop Queue' }, url: 'https://app.clickup.com/t/abc' } }));
  try {
    const r = await clickupDoor(api.apiBase, ['get', '--task', 'abc']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\nattachments: \(not kept on ClickUp\)\nurl: /);
    assert.ok(!api.seen.some((q) => /attach/.test(q.path)));
  } finally { await api.close(); }
});
