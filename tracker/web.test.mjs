import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.mjs';
import { startServer } from './server.mjs';
import { seedDemo, tickingClock } from './demoData.mjs';
import { escapeHtml, renderComment, renderInline, renderMarkdown, renderQuickAction, renderMergeAction, mergeQuestion, cardContext, firstParagraph } from './web/render.mjs';
import { loadProjectConfig } from '../lib/projectConfig.mjs';
import operatorCard from '../lib/operatorCard.js';
import machineComment from '../lib/machineComment.js';
import loopStatuses from '../lib/loopStatuses.js';
import mergeOnComment from '../lib/mergeOnComment.js';

const DOOR = fileURLToPath(new URL('../scripts/clickup.mjs', import.meta.url));
const WEB = (name) => fileURLToPath(new URL(`./web/${name}`, import.meta.url));

/** The demo data in a fresh store, a server on a free port, and a caller signed in as the operator. */
async function fixture({ mergePhrase } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-web-'));
  const store = openStore(join(dir, 'tracker.db'), { now: tickingClock() });
  const seed = seedDemo(store, { operatorName: 'Dane' });
  const loopToken = store.issueToken(seed.loop.id);
  const server = await startServer({ store, port: 0, mergePhrase });
  const url = `http://127.0.0.1:${server.address().port}`;
  async function call(method, path, { token = seed.token, body } = {}) {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* a page, not JSON */ }
    return { status: res.status, headers: res.headers, text, body: json };
  }
  /** Run the real door against this tracker, for one project, as the loop. */
  function door(slug, ...args) {
    const product = join(dir, slug);
    mkdirSync(product, { recursive: true });
    writeFileSync(join(product, 'spirality.project.json'), JSON.stringify({
      workspaceId: '111', spaceId: '222', loopQueueListId: '333',
      operatorUserId: seed.operator.id, machineUserId: seed.loop.id,
      githubRepo: 'owner/repo', dopplerProject: 'proj', dopplerConfig: 'dev',
      launchdPrefix: 'com.example', logDir: '~/loop-logs', mergePhrases: ['merge'],
      governancePaths: [], autoMergeLanes: [], operatorName: 'Dane', productSlug: slug,
      legacyMachinePrefixes: [], productScripts: {}, tracker: 'api', trackerUrl: url,
    }));
    return new Promise((resolve) => {
      const env = { PATH: process.env.PATH, HOME: process.env.HOME, TRACKER_TOKEN_HAND_RUN: loopToken };
      const child = spawn(process.execPath, [DOOR, ...args], { cwd: product, env });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { err += c; });
      child.on('close', (code) => resolve({ code, out, err }));
    });
  }
  async function cleanup() {
    await new Promise((r) => server.close(r));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  const waitingCommand = (slug) => door(slug, 'waiting');
  return { ...seed, store, url, call, door, waitingCommand, cleanup };
}

const idsWhere = (expect, outcome) => Object.keys(expect).filter((id) => expect[id] === outcome).sort();

// ── What waits on him ────────────────────────────────────────────────────────

test('"Waiting on you" lists exactly what the `waiting` command says is waiting on Dane, across both projects', async () => {
  const f = await fixture();
  try {
    const page = await f.call('GET', '/waiting');
    assert.equal(page.status, 200);

    // The real command, run against the same tickets, one project at a time.
    const said = { assigned: [], unassigned: [] };
    for (const slug of ['alpha', 'beta']) {
      const r = await f.waitingCommand(slug);
      assert.equal(r.code, 3, r.err);
      for (const line of r.out.trim().split('\n')) {
        const [id, , assigned, , verdict] = line.split('\t');
        if (!verdict.startsWith('WAITING ON DANE')) continue;
        said[assigned === 'assigned: Dane' ? 'assigned' : 'unassigned'].push(id);
      }
    }

    assert.deepEqual(page.body.waiting.map((t) => t.id).sort(), said.assigned.sort());
    // The command also counts his status with nobody assigned, flagged; the page shows those apart, never drops them.
    assert.deepEqual(page.body.unsure.map((t) => t.id).sort(), said.unassigned.sort());
    // And both agree with what the test data was built to be.
    assert.deepEqual(said.assigned.sort(), idsWhere(f.expect, 'waiting'));
    assert.deepEqual(said.unassigned.sort(), idsWhere(f.expect, 'unassigned'));
  } finally { await f.cleanup(); }
});

test('"Waiting on you" is newest first and names each ticket\'s project, status and name', async () => {
  const f = await fixture();
  try {
    const { waiting } = (await f.call('GET', '/waiting')).body;
    const times = waiting.map((t) => t.updatedAt);
    assert.deepEqual(times, [...times].sort().reverse());
    assert.ok(new Set(waiting.map((t) => t.project)).size === 2, 'tickets from both projects');
    const first = waiting.find((t) => t.id === 'AL-1');
    assert.equal(first.projectName, 'Alpha');
    assert.equal(first.status, 'needs your input');
    assert.equal(first.name, 'The tracker has nowhere to run: choose where it lives');
  } finally { await f.cleanup(); }
});

test('"Waiting on you" is the caller\'s own: a loop asking sees nothing of Dane\'s', async () => {
  const f = await fixture();
  try {
    const loopToken = f.store.issueToken(f.loop.id);
    const r = await f.call('GET', '/waiting', { token: loopToken });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.waiting, []);
    assert.equal((await f.call('GET', '/waiting', { token: null })).status, 401);
  } finally { await f.cleanup(); }
});

test('once Dane answers on the page, the ticket leaves "Waiting on you"', async () => {
  const f = await fixture();
  try {
    assert.ok((await f.call('GET', '/waiting')).body.waiting.some((t) => t.id === 'BE-1'));
    assert.equal((await f.call('POST', '/tickets/BE-1/comments', { body: { body: 'merge' } })).status, 201);
    assert.ok(!(await f.call('GET', '/waiting')).body.waiting.some((t) => t.id === 'BE-1'));
  } finally { await f.cleanup(); }
});

// ── The board ────────────────────────────────────────────────────────────────

test('the board\'s columns are the eight statuses in STAGE_ORDER, each ticket in its own status\'s column', async () => {
  const f = await fixture();
  try {
    const r = await f.call('GET', '/projects/alpha/board');
    assert.equal(r.status, 200);
    assert.equal(r.body.projectName, 'Alpha');
    assert.deepEqual(r.body.columns.map((c) => c.status), [...loopStatuses.STAGE_ORDER]);
    const all = f.store.listTickets('alpha');
    for (const column of r.body.columns) {
      const want = all.filter((t) => t.status === column.status.toLowerCase()).map((t) => t.id).sort();
      assert.deepEqual(column.tickets.map((t) => t.id).sort(), want, column.status);
      assert.ok(want.length > 0, `the test data has a ${column.status} ticket`);
    }
    const urgent = r.body.columns.find((c) => c.status === 'Queued').tickets.find((t) => t.name === 'An urgent fix filed after it');
    assert.deepEqual({ priority: urgent.priority, tags: urgent.tags }, { priority: 'urgent', tags: ['tracker', 'fix'] });
  } finally { await f.cleanup(); }
});

test('within each column the board\'s order is exactly what `queue --status` prints', async () => {
  const f = await fixture();
  try {
    const { columns } = (await f.call('GET', '/projects/alpha/board')).body;
    // `queue` lists open tickets only, so Live is not in it.
    for (const column of columns.filter((c) => c.status !== 'Live')) {
      const r = await f.door('alpha', 'queue', '--status', column.status);
      assert.equal(r.code, 0, r.err);
      const printed = r.out.trim().split('\n').filter(Boolean).map((line) => line.split('\t')[0]);
      assert.deepEqual(column.tickets.map((t) => t.id), printed, column.status);
    }
    // And the test data makes that order matter: filed low first, urgent shows first.
    const queued = columns.find((c) => c.status === 'Queued').tickets.map((t) => t.name);
    assert.ok(queued.indexOf('An urgent fix filed after it') < queued.indexOf('A low-priority chore filed first'));
  } finally { await f.cleanup(); }
});

test('the Projects screen lists every project with its open count; an unknown project is 404; both need a token', async () => {
  const f = await fixture();
  try {
    const openIn = (slug) => f.store.listTickets(slug, { open: true }).length;
    assert.ok(openIn('alpha') > 0 && openIn('alpha') < f.store.listTickets('alpha').length, 'the demo data has open and Live tickets');
    assert.deepEqual((await f.call('GET', '/projects')).body.projects, [
      { slug: 'alpha', name: 'Alpha', prefix: 'AL', url: null, logo: null, owner: null, open: openIn('alpha') },
      { slug: 'beta', name: 'Beta', prefix: 'BE', url: null, logo: null, owner: null, open: openIn('beta') },
    ]);
    assert.equal((await f.call('GET', '/projects/beta/board')).body.projectName, 'Beta');
    assert.equal((await f.call('GET', '/projects/nope/board')).status, 404);
    assert.equal((await f.call('GET', '/projects', { token: null })).status, 401);
    assert.equal((await f.call('GET', '/projects/alpha/board', { token: null })).status, 401);
  } finally { await f.cleanup(); }
});

test('a project\'s details name its prefix, operator, open count and a count per status in STAGE_ORDER; an unknown slug is 404; it needs a token', async () => {
  const f = await fixture();
  try {
    const r = await f.call('GET', '/projects/alpha');
    assert.equal(r.status, 200);
    const tickets = f.store.listTickets('alpha');
    assert.deepEqual(r.body, {
      slug: 'alpha',
      name: 'Alpha',
      prefix: 'AL',
      operator: { id: f.operator.id, name: 'Dane' },
      url: null,
      logo: null,
      owner: null,
      open: f.store.listTickets('alpha', { open: true }).length,
      statuses: loopStatuses.STAGE_ORDER.map((name) => ({
        status: name,
        count: tickets.filter((t) => t.status === loopStatuses.statusOf(name)).length,
      })),
    });
    assert.equal(r.body.statuses.reduce((n, s) => n + s.count, 0), tickets.length, 'every ticket is counted once');
    assert.equal((await f.call('GET', '/projects/beta')).body.name, 'Beta');
    const unknown = await f.call('GET', '/projects/no-such-thing');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, 'unknown-project');
    assert.equal((await f.call('GET', '/projects/alpha', { token: null })).status, 401);
  } finally { await f.cleanup(); }
});

test('a project with no operator shows none, not a guess', async () => {
  const f = await fixture();
  try {
    f.store.createProject({ slug: 'gamma', name: 'Gamma', prefix: 'GA' });
    const { body } = await f.call('GET', '/projects/gamma');
    assert.equal(body.operator, null);
    assert.equal(body.open, 0);
    assert.ok(body.statuses.every((s) => s.count === 0));
  } finally { await f.cleanup(); }
});

test('the Projects screen is a table whose View icon opens the details page; a name still selects the project and opens its tasks', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(app, /<table class="projects">/);
  assert.match(app, /<th class="actions">Actions<\/th><\/tr><\/thead><tbody>\$\{projects\.map\(row\)/);
  assert.match(app, /action\(`\/projects\/\$\{encodeURIComponent\(p\.slug\)\}`, 'View project', ICONS\.view\)/);
  // SP-42's behaviour: the name goes to the project's tasks in the last view, and opening it selects it.
  assert.match(app, /<td class="name"><a href="\/\$\{savedView\(\)\}\/\$\{encodeURIComponent\(p\.slug\)\}"/);
  assert.match(app, /localStorage\.setItem\(PROJECT_KEY, board\.project\)/);
  // The details page links to the project's board and list, and says plainly when there is no such project.
  assert.match(app, /<a href="\$\{at\('board'\)\}">Board<\/a><a href="\$\{at\('list'\)\}">List<\/a>/);
  assert.match(app, /err\.status !== 404[\s\S]{0,200}There is no project \$\{escapeHtml\(slug\)\}\./);
});

test('the board and the list both fold Live by default, and every card and row opens its ticket page', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(app, /c\.status === 'Live'\s*\?\s*`<details class="\$\{cls\}">/);
  assert.match(app, /block\(c, 'column',/);
  assert.match(app, /block\(c, 'group',/);
  assert.match(app, /<a class="card" href="\/t\/\$\{encodeURIComponent\(t\.id\)\}">/);
  assert.match(app, /<td class="name"><a href="\/t\/\$\{encodeURIComponent\(t\.id\)\}">/);
  assert.ok(!/<details[^>]*\bopen\b/.test(app), 'Live is never drawn open');
});

test('a ticket\'s pull request on the list is the one the merge step would act on, and null without one', async () => {
  const f = await fixture();
  try {
    const tickets = (await f.call('GET', '/projects/alpha/board')).body.columns.flatMap((c) => c.tickets);
    for (const t of tickets) {
      const comments = f.store.listComments(t.id).map((c) => ({ id: c.id, comment_text: c.body, date: String(Date.parse(c.createdAt)) }));
      assert.equal(t.pullRequest, mergeOnComment.findPullRequest(comments)?.url ?? null, t.id);
    }
    assert.equal(tickets.find((t) => t.id === 'AL-2').pullRequest, 'https://github.com/example/repo/pull/7');
    assert.ok(tickets.some((t) => t.pullRequest === null), 'the test data has a ticket with no PR');
  } finally { await f.cleanup(); }
});

test('the list\'s actions only go where the page already goes: the ticket, its reply box, its pull request', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(app, /action\(at, 'Open ticket', ICONS\.open\)/);
  assert.match(app, /action\(`\$\{at\}#reply`, 'Reply', ICONS\.reply\)/);
  // The PR icon shows only when there is one, and opens GitHub in its own tab.
  assert.match(app, /t\.pullRequest \? action\(t\.pullRequest, '[^']+', ICONS\.pullRequest, true\) : ''/);
  assert.match(app, /target="_blank" rel="noopener noreferrer"/);
  // The address keeps #reply when the page moves to it, and the ticket page acts on it.
  assert.match(app, /history\.pushState\(null, '', a\.pathname \+ a\.hash\)/);
  assert.match(app, /location\.hash === '#reply'[\s\S]{0,120}box\.focus\(\)/);
});

test('the list and the board draw one object: the toggle keeps the project and only the view changes', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  // One fetch serves both views, so they cannot disagree about what is where.
  assert.equal(app.match(/\/board`\);/g)?.length, 1);
  assert.match(app, /\['board', 'list'\]\.map\(\(v\) => `<a href="\$\{at\(v, board\.project\)\}"/);
});

test('each ticket on the board carries its assignee\'s name and its last change, for the list', async () => {
  const f = await fixture();
  try {
    const { columns } = (await f.call('GET', '/projects/alpha/board')).body;
    const tickets = columns.flatMap((c) => c.tickets);
    for (const t of tickets) {
      const stored = f.store.getTicket(t.id);
      assert.equal(t.updatedAt, stored.updatedAt, t.id);
      assert.equal(t.assignee, stored.assignee == null ? null : f.store.getActor(stored.assignee).name, t.id);
    }
    assert.ok(tickets.some((t) => t.assignee === 'Dane'), 'the test data assigns a ticket to Dane');
    assert.ok(tickets.some((t) => t.assignee === null), 'and leaves one unassigned');
  } finally { await f.cleanup(); }
});

// ── A ticket's thread ────────────────────────────────────────────────────────

test('a ticket\'s thread is oldest first, names each author, and marks machine comments, stamped or not', async () => {
  const f = await fixture();
  try {
    const r = await f.call('GET', '/tickets/AL-2/thread');
    assert.equal(r.status, 200);
    assert.equal(r.body.projectName, 'Alpha');
    assert.equal(r.body.assignee.name, 'Dane');
    assert.deepEqual(r.body.comments.map((c) => [c.author.name, c.machine, c.body]), [
      ['Loop (build)', true, 'PR opened: https://github.com/example/repo/pull/7'],
      ['Loop (build)', true, 'REVIEW: PASSED. Ready for your merge word.'],
      ['Dane', false, 'merge'],
    ]);
    // A loop posting under Dane's own token: his name, but marked, and the stamp line not shown.
    const under = (await f.call('GET', '/tickets/BE-3/thread')).body.comments[0];
    assert.equal(under.author.name, 'Dane');
    assert.equal(under.machine, true);
    assert.equal(under.body, 'Which name should the tab show?');
    assert.equal((await f.call('GET', '/tickets/NOPE-1/thread')).status, 404);
    assert.equal((await f.call('GET', '/tickets/AL-2/thread', { token: null })).status, 401);
  } finally { await f.cleanup(); }
});

test('a reply from the page is stored exactly as typed, under Dane\'s actor, and shows at the end of the thread', async () => {
  const f = await fixture();
  try {
    const typed = '  merge \n\n**not bold**\n> kept\n';
    const posted = await f.call('POST', '/tickets/AL-1/comments', { body: { body: typed } });
    assert.equal(posted.status, 201);
    assert.equal(posted.body.author, f.operator.id);
    const stored = f.store.listComments('AL-1').at(-1);
    assert.equal(stored.body, typed);
    assert.equal(stored.author, f.operator.id);
    const last = (await f.call('GET', '/tickets/AL-1/thread')).body.comments.at(-1);
    assert.deepEqual([last.author.name, last.machine, last.body], ['Dane', false, typed]);
  } finally { await f.cleanup(); }
});

// ── A new request ────────────────────────────────────────────────────────────

test('a request filed from the page lands in Requested, unassigned, under Dane, exactly as typed, first on the board', async () => {
  const f = await fixture();
  try {
    const typed = '  Please add a thing.\n\n**not bold**\n> kept\n';
    const filed = await f.call('POST', '/projects/beta/tickets', {
      body: { name: 'Test request, please close', description: typed, status: 'Requested' },
    });
    assert.equal(filed.status, 201, filed.text);
    const back = await f.call('GET', `/tickets/${filed.body.id}`);
    assert.equal(back.status, 200);
    assert.deepEqual(
      [back.body.project, back.body.name, back.body.status, back.body.assignee, back.body.description],
      ['beta', 'Test request, please close', 'requested', null, typed],
    );
    const [created] = f.store.listEvents(filed.body.id);
    assert.deepEqual([created.field, created.to, created.actor], ['created', 'requested', f.operator.id]);
    const [first] = (await f.call('GET', '/projects/beta/board')).body.columns;
    assert.equal(first.status, 'Requested');
    assert.deepEqual(first.tickets.map((t) => t.id), [filed.body.id]);
  } finally { await f.cleanup(); }
});

test('a refused request writes nothing and says why', async () => {
  const f = await fixture();
  try {
    const before = f.store.listTickets('beta').length;
    const refused = await f.call('POST', '/projects/beta/tickets', { body: { name: '', description: 'kept', status: 'Requested' } });
    assert.equal(refused.status, 400);
    assert.ok(refused.body.message, 'the server gives a reason the form can show');
    assert.equal(f.store.listTickets('beta').length, before);
  } finally { await f.cleanup(); }
});

test('the form starts on the project the server was given, and on none it does not hold', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('GET', '/projects')).body.default, null, 'no project config named: the page takes the first');
    for (const [given, want] of [['beta', 'beta'], ['gamma', null]]) {
      const server = await startServer({ store: f.store, port: 0, defaultProject: given });
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/projects`, { headers: { authorization: `Bearer ${f.token}` } });
        assert.equal((await res.json()).default, want, given);
      } finally { await new Promise((r) => server.close(r)); }
    }
  } finally { await f.cleanup(); }
});

test('the New request form files into Requested as typed, keeps the text when refused or signed out, and is in the header', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(app, /api\('POST', `\/projects\/\$\{encodeURIComponent\(project\.value\)\}\/tickets`, \{\s*name: title\.value, description: description\.value, status: 'Requested',\s*\}\)/);
  assert.ok(!/assignee/.test(app.slice(app.indexOf('async function drawNew'), app.indexOf('/** Underline'))), 'a request is filed unassigned');
  assert.match(app, /note\.textContent = `Not filed: \$\{err\.message\}`;/);
  assert.match(app, /localStorage\.setItem\(DRAFT_KEY,/);
  assert.match(app, /title\.value = draft\.title;\s*description\.value = draft\.description;/);
  assert.match(app, /history\.pushState\(null, '', `\/t\/\$\{encodeURIComponent\(ticket\.id\)\}`\)/);
  assert.match(readFileSync(WEB('index.html'), 'utf8'), /<a href="\/new" data-nav="new">New request<\/a>/);
});

// ── Copy to another project ──────────────────────────────────────────────────

test('a ticket copied from the page lands in the other project in Requested, under Dane, and the original does not change', async () => {
  const f = await fixture();
  try {
    const before = (await f.call('GET', '/tickets/AL-1')).body;
    const events = f.store.listEvents('AL-1');
    const copied = await f.call('POST', '/tickets/AL-1/clone', { body: { project: 'beta' } });
    assert.equal(copied.status, 201, copied.text);
    const back = (await f.call('GET', `/tickets/${copied.body.id}/thread`)).body;
    assert.deepEqual(
      [back.project, back.name, back.description, back.status, back.assignee],
      ['beta', before.name, before.description, 'requested', null],
    );
    assert.deepEqual(back.comments.map((c) => [c.author.name, c.body]), [['Dane', 'Copied from AL-1 in Alpha.']]);
    assert.deepEqual((await f.call('GET', '/tickets/AL-1')).body, before, 'the original and its comments are as they were');
    assert.deepEqual(f.store.listEvents('AL-1'), events);
    const [first] = (await f.call('GET', '/projects/beta/board')).body.columns;
    assert.ok(first.tickets.some((t) => t.id === copied.body.id), 'the copy is in Requested on the other board');
  } finally { await f.cleanup(); }
});

test('a refused copy writes nothing and says why: its own project, an unknown one, none named, another author, no token', async () => {
  const f = await fixture();
  try {
    const count = () => f.store.listTickets('alpha').length + f.store.listTickets('beta').length;
    const before = count();
    for (const [body, status, opts] of [
      [{ project: 'alpha' }, 400], [{ project: 'gamma' }, 404], [{}, 400],
      [{ project: 'beta', actor: 999 }, 400], [{ project: 'beta', extra: 1 }, 400],
      [{ project: 'beta' }, 401, { token: null }],
    ]) {
      const res = await f.call('POST', '/tickets/AL-1/clone', { body, ...opts });
      assert.equal(res.status, status, JSON.stringify(body));
      assert.ok(res.body.message, 'the server gives a reason the form can show');
    }
    assert.equal((await f.call('POST', '/tickets/NOPE-1/clone', { body: { project: 'beta' } })).status, 404);
    assert.equal(count(), before);
  } finally { await f.cleanup(); }
});

test('the ticket page offers every other project to copy into, opens the copy, and says so when there is none', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('async function drawTicket'), app.indexOf('/** The draft kept'));
  assert.match(draw, /const others = projects\.filter\(\(p\) => p\.slug !== t\.project\);/);
  assert.match(draw, /api\('POST', `\/tickets\/\$\{encodeURIComponent\(t\.id\)\}\/clone`, \{ project: copyForm\.querySelector\('#copy-to'\)\.value \}\)/);
  assert.match(draw, /history\.pushState\(null, '', `\/t\/\$\{encodeURIComponent\(copy\.id\)\}`\)/);
  assert.match(draw, /copyNote\.textContent = `Not copied: \$\{err\.message\}`;/);
  assert.match(draw, /There is no other project to copy into yet\./);
  assert.match(draw, /escapeHtml\(p\.name\)/, 'project names are escaped');
});

// ── The page itself ──────────────────────────────────────────────────────────

test('the page is served at /, at a ticket\'s address, at Projects, at Tasks, at the board, at the list and at the New request form without a token, locked to its own scripts', async () => {
  const f = await fixture();
  try {
    for (const path of ['/', '/t/AL-1', '/tasks', '/board', '/board/alpha', '/list', '/list/alpha', '/new']) {
      const r = await f.call('GET', path, { token: null });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /^text\/html/);
      assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
      assert.equal(r.text, readFileSync(WEB('index.html'), 'utf8'));
    }
    for (const name of ['app.mjs', 'render.mjs', 'app.css']) {
      const r = await f.call('GET', `/web/${name}`, { token: null });
      assert.equal(r.status, 200, name);
      assert.equal(r.text, readFileSync(WEB(name), 'utf8'));
    }
    // The header's wordmark and the tab's icon, as images the page's lock allows.
    for (const name of ['wordmark.png', 'icon.png']) {
      const r = await fetch(`${f.url}/web/${name}`);
      assert.equal(r.status, 200, name);
      assert.equal(r.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await r.arrayBuffer()), readFileSync(WEB(name)));
    }
    assert.match(readFileSync(WEB('index.html'), 'utf8'), /<img src="\/web\/wordmark\.png" alt="Spirality"/);
    // /projects is the page to a browser opening it, and still the data to the page's own call.
    const opened = await fetch(`${f.url}/projects`, { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
    assert.equal(opened.status, 200);
    assert.equal(await opened.text(), readFileSync(WEB('index.html'), 'utf8'));
    assert.equal((await f.call('GET', '/projects')).body.projects.length, 2);
    assert.equal((await f.call('GET', '/projects', { token: null })).status, 401);
    // So is a project's details page, known or not: the page itself says when there is no such project.
    for (const path of ['/projects/alpha', '/projects/no-such-thing']) {
      const page = await fetch(`${f.url}${path}`, { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
      assert.equal(page.status, 200, path);
      assert.equal(await page.text(), readFileSync(WEB('index.html'), 'utf8'), path);
    }
    assert.equal((await f.call('GET', '/projects/alpha')).body.slug, 'alpha');
    // The header: Projects picks a project, Tasks opens the one picked.
    assert.match(readFileSync(WEB('index.html'), 'utf8'), /<a href="\/projects" data-nav="projects">Projects<\/a>\s*<a href="\/tasks" data-nav="tasks">Tasks<\/a>/);
    // Only those files: nothing else on disk is reachable, with or without a token.
    for (const path of ['/web/../store.mjs', '/web/%2e%2e%2fstore.mjs', '/web/demo.mjs', '/store.mjs']) {
      assert.notEqual((await f.call('GET', path, { token: null })).status, 200, path);
      assert.notEqual((await f.call('GET', path)).status, 200, path);
    }
    // The ticket data still needs the token.
    assert.equal((await f.call('GET', '/tickets/AL-1', { token: null })).status, 401);
  } finally { await f.cleanup(); }
});

test('the Settings page is in the header after New request, lists the stages the server gives, saves them all, reads them back, and shows a refusal', async () => {
  const html = readFileSync(WEB('index.html'), 'utf8');
  assert.match(html, /<a href="\/new" data-nav="new">New request<\/a>\s*<a href="\/settings" data-nav="settings">Settings<\/a>/);
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('async function drawSettings'), app.indexOf('/** Underline'));
  assert.match(draw, /const \{ stages \} = await api\('GET', '\/stage-colours'\);/, 'the stages come from the server, never typed out');
  assert.doesNotMatch(draw, /'Queued'|'Requested'|'Live'/);
  assert.match(draw, /type="color"/);
  assert.match(draw, /chosen\[tr\.dataset\.status\] = null;/, 'Clear sets no colour');
  assert.match(draw, /await api\('PUT', '\/stage-colours', \{ colours: chosen \}\);\s*\/\/ Read back before saying it worked\.\s*const back = await api\('GET', '\/stage-colours'\);/);
  assert.match(draw, /note\.textContent = `Not saved: \$\{err\.message\}`;/);
  assert.match(draw, /escapeHtml\(s\.status\)/);
  assert.match(app, /markNav\(settings \? 'settings' :/);
  const f = await fixture();
  try {
    const page = await f.call('GET', '/settings', { token: null });
    assert.equal(page.status, 200);
    assert.equal(page.text, readFileSync(WEB('index.html'), 'utf8'));
    // Dane renamed it from Admin: the old address is not the page.
    assert.notEqual((await f.call('GET', '/admin', { token: null })).text, page.text);
    // The demo's loop is refused with a message the page can show.
    const loop = await f.call('PUT', '/stage-colours', { token: f.store.issueToken(f.loop.id), body: { colours: { Queued: '#2b9cf2' } } });
    assert.equal(loop.status, 403);
    assert.ok(loop.body.message);
    const saved = await f.call('PUT', '/stage-colours', { body: { colours: { Queued: '#2b9cf2' } } });
    assert.equal(saved.status, 200, saved.text);
  } finally { await f.cleanup(); }
});

test('the page has no inline script or style, so its lock does not have to be loosened', () => {
  const html = readFileSync(WEB('index.html'), 'utf8');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.doesNotMatch(html + readFileSync(WEB('app.mjs'), 'utf8'), /style="/);
});

// ── Drawing ticket text ──────────────────────────────────────────────────────

test('HTML in a description or comment shows as text and never becomes markup', () => {
  const nasty = '<script>alert("ran")</script>\n\n<img src=x onerror="alert(1)">\n\n**<b>x</b>** `<i>` [<u>l</u>](https://e.com/"onmouseover="x)';
  for (const html of [renderMarkdown(nasty), renderComment(nasty)]) {
    assert.doesNotMatch(html, /<script|<img|<b>|<i>|<u>/);
    assert.match(html, /&lt;script&gt;alert\(&quot;ran&quot;\)&lt;\/script&gt;/);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.doesNotMatch(html, /href="[^"]*"onmouseover/);
  }
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
});

test('only http(s) addresses become links; `PR opened:` lines are clickable', () => {
  assert.doesNotMatch(renderInline('[bad](javascript:alert(1))'), /<a /);
  assert.doesNotMatch(renderInline('javascript:alert(1)'), /<a /);
  assert.equal(
    renderInline('PR opened: https://github.com/o/r/pull/7.'),
    'PR opened: <a href="https://github.com/o/r/pull/7" rel="noopener noreferrer" target="_blank">https://github.com/o/r/pull/7</a>.',
  );
  assert.match(renderInline('[the PR](https://github.com/o/r/pull/7?a=1&b=2)'), /href="https:\/\/github.com\/o\/r\/pull\/7\?a=1&amp;b=2"/);
});

test('a description renders from Markdown: headings, lists, checkboxes, code and emphasis', () => {
  const html = renderMarkdown('## Goal\nDo **it** *now*, with `npm run verify`.\n\n- [x] done\n- [ ] not yet\n\n1. one\n2. two\n\n```\n<kept> as code\n```\n---');
  assert.match(html, /<h4>Goal<\/h4>/);
  assert.match(html, /<p>Do <strong>it<\/strong> <em>now<\/em>, with <code>npm run verify<\/code>\.<\/p>/);
  assert.match(html, /<li class="check done"><span class="box">☑<\/span> done<\/li><li class="check"><span class="box">☐<\/span> not yet<\/li>/);
  assert.match(html, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
  assert.match(html, /<pre><code>&lt;kept&gt; as code<\/code><\/pre>/);
  assert.match(html, /<hr>$/);
});

test('a fence closes only on its own kind and length, so his own ``` inside a ```` block shows as written', () => {
  assert.equal(renderMarkdown('````\n```\n> his line\n```\n````\nafter'), '<pre><code>```\n&gt; his line\n```</code></pre>\n<p>after</p>');
  assert.equal(renderMarkdown('~~~\n```\nx\n~~~'), '<pre><code>```\nx</code></pre>');
});

test('an operator card draws its NEEDED FROM DANE banner in the red box, as `ask` posts it and as the tracker stores it', () => {
  const sixty = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  const { rendered } = operatorCard.buildCard(`@@ASKED\nbuild the list\n@@CONTEXT\n${sixty}\n@@NEEDED\nReply A or B.\nA is cheaper.`);
  const plain = machineComment.stripMachineMarker(machineComment.stampMachineComment(rendered));
  // The tracker keeps a card's red banner runs as **bold** lines (scripts/tracker/apiTracker.mjs).
  const stored = plain.split('\n').map((l) => (/^#{29}$|^NEEDED FROM|^A is cheaper/.test(l) ? `**${l}**` : l)).join('\n');
  for (const body of [plain, stored]) {
    const html = renderComment(body);
    assert.match(html, /<div class="banner"><strong>NEEDED FROM DANE:<\/strong> Reply A or B\.<br>A is cheaper\.<\/div>/);
    assert.doesNotMatch(html, /#{29}/, 'the rules are the box, not text');
    assert.match(html, /<strong>DANE&#39;S WORDS/);
  }
  // A card that reached the tracker as its authored @@ text still gets the banner.
  const raw = renderComment(`@@ASKED\nx\n@@NEEDED\nPick one.`, { operatorName: 'Dane' });
  assert.match(raw, /<div class="banner"><strong>NEEDED FROM DANE:<\/strong> Pick one\.<\/div>/);
  assert.doesNotMatch(renderComment('An ordinary comment.'), /banner/);
});

// ── The ticket page's Quick Action section ───────────────────────────────────

test('the ticket page opens on the Quick Action section, with everything it showed before in a closed Details box', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const page = /main\.innerHTML = `\s*<section class="quick">([\s\S]*?)<\/section>\s*<details class="details">([\s\S]*?)<\/details>`;/.exec(app);
  assert.ok(page, 'Quick Action first, then Details');
  const [, quick, details] = page;
  assert.match(quick, /renderQuickAction\(t\)/);
  assert.match(quick, /<form class="reply">[\s\S]*<textarea id="reply" required>/, 'the reply box is on the right of Quick Action');
  assert.match(details, /^\s*<summary>Details<\/summary>/);
  // The status line, the description and the comments, all inside Details.
  for (const part of [/statusName\(t\.status\)/, /renderMarkdown\(t\.description\)/, /\$\{comments \|\|/]) assert.match(details, part);
  assert.ok(!/<details[^>]*\bopen\b/.test(app), 'Details is never drawn open');
  // The reply posts exactly as typed, and #reply still lands in the box (it is outside Details, so focusable).
  assert.match(app, /\/comments`, \{ body: box\.value \}\)/);
  assert.match(app, /location\.hash === '#reply'[\s\S]{0,120}box\.focus\(\)/);
});

test('Quick Action\'s left side: the title, the newest card\'s context and its ask in bold red', () => {
  const sixty = (tag) => Array.from({ length: 60 }, (_, i) => `${tag}${i}`).join(' ');
  const card = (tag, ask) => machineComment.stripMachineMarker(machineComment.stampMachineComment(
    operatorCard.buildCard(`@@ASKED\nbuild it\n@@CONTEXT\n${sixty(tag)}\n@@NEEDED\n${ask}`).rendered));
  const html = renderQuickAction({
    name: 'Make the page',
    description: '## Goal\nThe description.',
    comments: [{ body: card('old', 'Old ask.') }, { body: card('new', 'Reply A or B.\nA is cheaper.') }, { body: 'go' }],
  });
  assert.match(html, /^<h1>Make the page<\/h1>/);
  assert.match(html, /<p class="summary">new0 new1 [^<]*new59<\/p>/, 'the newest card\'s WHAT\'S GOING ON');
  assert.match(html, /<p class="needed">Reply A or B\.<br>A is cheaper\.<\/p>/);
  assert.doesNotMatch(html, /old|The description|NEEDED FROM/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /\.quick \.needed \{ color: var\(--red\); font-weight: 700;/, 'the same red as the banner, bold');
  // An authored card that reached the tracker as @@ text reads the same way.
  assert.equal(cardContext('@@ASKED\nx\n@@CONTEXT\nWhy it\nmatters.\n@@NEEDED\nPick.'), 'Why it matters.');
});

test('Quick Action with no card: the title and the description\'s first paragraph, and no red line', () => {
  const html = renderQuickAction({
    name: 'Fix it',
    description: '## Asked\n~~~\nhis words\n~~~\n\n## Goal\nOpen a ticket and\nsee it.\n\nMore.',
    comments: [{ body: 'An ordinary comment.' }],
  });
  assert.equal(html, '<h1>Fix it</h1>\n<p class="summary">Open a ticket and see it.</p>');
  assert.equal(renderQuickAction({ name: 'Empty', description: '' }), '<h1>Empty</h1>');
  assert.equal(firstParagraph('- a list\n\nProse.'), 'Prose.');
});

test('every word of ticket text in Quick Action is escaped', () => {
  const nasty = '<script>alert(1)</script>';
  const html = renderQuickAction({
    name: nasty,
    description: '',
    comments: [{ body: `@@ASKED\nx\n@@CONTEXT\n${nasty}\n@@NEEDED\n${nasty} <img src=x onerror="y">` }],
  });
  assert.doesNotMatch(html, /<script|<img/);
  assert.equal(html.match(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/g).length, 3);
});

// ── Create Project ───────────────────────────────────────────────────────────

test('a project added from the page shows on the Projects screen and its details page with its logo, web address and owner', async () => {
  const f = await fixture();
  try {
    const people = await f.call('GET', '/people');
    assert.deepEqual(people.body.people.map((p) => p.name), ['Dane'], 'the owner picker offers the people, not the loop');
    const made = await f.call('POST', '/projects', {
      body: { name: 'Try me', slug: 'try-me', prefix: 'TRY', url: 'https://try.example', logo: 'https://try.example/logo.png', owner: f.operator.id },
    });
    assert.equal(made.status, 201);
    const row = (await f.call('GET', '/projects')).body.projects.find((p) => p.slug === 'try-me');
    assert.deepEqual(row, {
      slug: 'try-me', name: 'Try me', prefix: 'TRY', url: 'https://try.example', logo: 'https://try.example/logo.png',
      owner: { id: f.operator.id, name: 'Dane' }, open: 0,
    });
    const details = (await f.call('GET', '/projects/try-me')).body;
    assert.deepEqual([details.url, details.logo, details.owner], [row.url, row.logo, row.owner]);
    // The loop's sign-in cannot, and leaves the projects as they were.
    const before = (await f.call('GET', '/projects')).body.projects;
    const loop = await f.call('POST', '/projects', { token: f.store.issueToken(f.loop.id), body: { name: 'L', slug: 'loop-made', prefix: 'LM' } });
    assert.equal(loop.status, 403);
    assert.deepEqual((await f.call('GET', '/projects')).body.projects, before);
  } finally { await f.cleanup(); }
});

test('/projects/new is the page to a browser, and its logo can be drawn: the lock lets images in, never scripts', async () => {
  const f = await fixture();
  try {
    const page = await fetch(`${f.url}/projects/new`, { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), readFileSync(WEB('index.html'), 'utf8'));
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /img-src 'self' http: https:/);
    assert.match(csp, /script-src 'self';/);
    assert.match(csp, /default-src 'none'/);
  } finally { await f.cleanup(); }
});

test('the New project button and form are a person\'s only; a refused save keeps what was typed and says why; success opens the details page', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(app, /me\?\.kind === 'human' \? '<div class="toolbar"><a class="button" href="\/projects\/new">New project<\/a><\/div>' : ''/);
  const form = app.slice(app.indexOf('async function drawCreateProject'), app.indexOf('/**', app.indexOf('async function drawCreateProject')));
  assert.match(form, /if \(me\?\.kind !== 'human'\)[\s\S]{0,200}Only a person signed in to the tracker can add a project\./);
  for (const id of ['name', 'slug', 'prefix', 'url', 'logo']) assert.match(form, new RegExp(`field\\('${id}',`), id);
  assert.match(form, /<select id="owner"><option value="">Nobody<\/option>\$\{people\.map/);
  assert.match(form, /api\('GET', '\/people'\)/);
  assert.match(form, /api\('POST', '\/projects', \{/);
  assert.match(form, /note\.textContent = `Not added: \$\{err\.message\}`;/);
  assert.ok(!/main\.innerHTML/.test(form.slice(form.indexOf("addEventListener('submit'"))), 'a refused save never redraws the form, so nothing typed is lost');
  assert.match(form, /history\.pushState\(null, '', `\/projects\/\$\{encodeURIComponent\(made\.slug\)\}`\)/);
  // /projects/new is the form, never a project called "new".
  assert.match(app, /const details = !newProject && /);
  // The table and details page draw a logo and web address only for an http(s) address, escaped.
  assert.match(app, /const isWebAddress = \(v\) => typeof v === 'string' && \/\^https\?:\\\/\\\/\/i\.test\(v\);/);
  assert.match(app, /<img class="\$\{cls\}" src="\$\{escapeHtml\(p\.logo\)\}"/);
  assert.match(app, /<td class="owner">\$\{p\.owner \? escapeHtml\(p\.owner\.name\)/);
  assert.match(app, /<dt>Owner<\/dt><dd>\$\{p\.owner \? escapeHtml\(p\.owner\.name\)/);
});

// ── Quick Action's Merge button ──────────────────────────────────────────────

test('only a Ready to launch ticket gets the Merge button, and only when the server named a merge phrase', () => {
  for (const name of loopStatuses.STAGE_ORDER) {
    const html = renderMergeAction({ status: loopStatuses.statusOf(name), mergePhrase: 'merge' });
    if (loopStatuses.statusOf(name) === loopStatuses.READY_TO_LAUNCH) assert.match(html, /<form class="merge-action">\s*<button type="submit">Merge<\/button>/, name);
    else assert.equal(html, '', name);
  }
  assert.equal(renderMergeAction({ status: 'ready to launch', mergePhrase: null }), '', 'no phrase, no button');
  assert.doesNotMatch(renderMergeAction({ status: 'ready to launch', mergePhrase: '<b>go</b>' }), /<b>/, 'the phrase is escaped');
});

test('the Merge button asks once, naming the PR number and the ticket', () => {
  assert.equal(mergeQuestion({ name: 'Fix it', pullRequest: 'https://github.com/o/r/pull/41' }), 'Merge PR #41 for Fix it?');
  assert.equal(mergeQuestion({ name: 'Fix it', pullRequest: null }), 'Merge the pull request for Fix it?');
});

test('the ticket page gets the first merge phrase from spirality.project.json, and the PR the merge step would act on', async () => {
  const config = loadProjectConfig();
  const f = await fixture({ mergePhrase: config.mergePhrases[0] });
  try {
    for (const t of f.store.listTickets('alpha')) {
      const thread = (await f.call('GET', `/tickets/${t.id}/thread`)).body;
      assert.equal(thread.mergePhrase, config.mergePhrases[0]);
      const comments = f.store.listComments(t.id).map((c) => ({ id: c.id, comment_text: c.body, date: String(Date.parse(c.createdAt)) }));
      assert.equal(thread.pullRequest, mergeOnComment.findPullRequest(comments)?.url ?? null, t.id);
    }
  } finally { await f.cleanup(); }
  const none = await fixture();
  try {
    assert.equal((await none.call('GET', '/tickets/AL-1/thread')).body.mergePhrase, null, 'no config phrase: no button');
  } finally { await none.cleanup(); }
});

test('clicking Merge and confirming posts exactly the merge phrase as Dane\'s own comment, one the relay reads as a merge', async () => {
  const f = await fixture({ mergePhrase: loadProjectConfig().mergePhrases[0] });
  try {
    const { mergePhrase } = (await f.call('GET', '/tickets/AL-1/thread')).body;
    // The page's own call, with the page's own body.
    const posted = await f.call('POST', '/tickets/AL-1/comments', { body: { body: mergePhrase } });
    assert.equal(posted.status, 201);
    const stored = f.store.listComments('AL-1').at(-1);
    assert.deepEqual([stored.body, stored.author], [mergePhrase, f.operator.id]);
    assert.ok(mergeOnComment.isMergeCommand(stored.body), 'the relay reads it as a merge');
  } finally { await f.cleanup(); }
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const handler = /mergeForm\?\.addEventListener\('submit', async \(e\) => \{([\s\S]*?)\n  \}\);/.exec(app)?.[1];
  assert.ok(handler, 'the Merge button has a submit handler');
  // It asks first; cancelling returns before anything is posted.
  assert.match(handler, /^\s*e\.preventDefault\(\);\s*if \(!confirm\(mergeQuestion\(t\)\)\) return;/);
  // The same call the reply box makes, with the phrase the server sent, the button held while it posts.
  assert.match(handler, /button\.disabled = true;[\s\S]*api\('POST', `\/tickets\/\$\{encodeURIComponent\(t\.id\)\}\/comments`, \{ body: t\.mergePhrase \}\)/);
  // A failed post says so, in red, and frees the button; no success line.
  assert.match(handler, /catch \(err\) \{[\s\S]*mergeNote\.className = 'note error';\s*mergeNote\.textContent = `Not posted: \$\{err\.message\}`;\s*button\.disabled = false;/);
  assert.doesNotMatch(handler, /Merged|merged!/);
  assert.match(app, /<div class="act">\s*\$\{renderMergeAction\(t\)\}\s*<form class="reply">/, 'Merge sits above the reply box on the right');
});

test('no merge phrase is written into the page\'s code', () => {
  const code = (name) => readFileSync(WEB(name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const name of ['app.mjs', 'render.mjs', 'index.html']) {
    for (const phrase of loadProjectConfig().mergePhrases) {
      const quoted = new RegExp(`['"\`]${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`, 'i');
      assert.doesNotMatch(code(name), quoted, `${name} spells "${phrase}"`);
    }
  }
});
