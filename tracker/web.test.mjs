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
import { escapeHtml, renderComment, renderInline, renderMarkdown, renderQuickAction, renderCommands, cardCommands, cardAsk, renderMergeAction, mergeQuestion, renderCloseAction, closeQuestion, cardMove, renderTrail, cardContext, firstParagraph, canDelete, deleteQuestion, deleteRefusal, renderDeleteAction, bellColour, stageLook, stageLooks, contrast } from './web/render.mjs';
import { loadProjectConfig } from '../lib/projectConfig.mjs';
import operatorCard from '../lib/operatorCard.js';
import machineComment from '../lib/machineComment.js';
import loopStatuses from '../lib/loopStatuses.js';
import mergeOnComment from '../lib/mergeOnComment.js';
import busRelayPlan from '../lib/busRelayPlan.js';

const DOOR = fileURLToPath(new URL('../scripts/clickup.mjs', import.meta.url));
const WEB = (name) => fileURLToPath(new URL(`./web/${name}`, import.meta.url));

/** The demo data in a fresh store, a server on a free port, and a caller signed in as the operator. */
async function fixture({ mergePhrase, closePhrase } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-web-'));
  const store = openStore(join(dir, 'tracker.db'), { now: tickingClock() });
  const seed = seedDemo(store, { operatorName: 'Dane' });
  const loopToken = store.issueToken(seed.loop.id);
  const server = await startServer({ store, port: 0, mergePhrase, closePhrase });
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
  assert.match(app, /c\.status === 'Live'\s*\?\s*`<details class="\$\{cls\}"[^>]*>/);
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
  assert.equal(app.match(/\/board`\)[;,]/g)?.length, 1);
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

test('bellColour: grey while nothing waits, yellow for 1 to 3, red for more than 3', () => {
  assert.equal(bellColour(0), 'grey');
  assert.equal(bellColour(1), 'yellow');
  assert.equal(bellColour(2), 'yellow');
  assert.equal(bellColour(3), 'yellow');
  assert.equal(bellColour(4), 'red');
  assert.equal(bellColour(12), 'red');
  assert.equal(bellColour(null), 'grey');
  assert.equal(bellColour(undefined), 'grey');
});

test('Waiting on you is a bell on the right, just before "Signed in as", coloured from the count wherever it is read', () => {
  const html = readFileSync(WEB('index.html'), 'utf8');
  const nav = /<nav class="site">([\s\S]*?)<\/nav>/.exec(html)[1];
  assert.deepEqual([...nav.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1]), ['Projects', 'Tasks', 'New request', 'Settings']);
  assert.doesNotMatch(nav, /Waiting on you/);
  const me = /<span class="me">([\s\S]*?)<\/span>\s*<\/header>/.exec(html)[1];
  assert.match(me, /<a id="bell" href="\/" title="Waiting on you" aria-label="Waiting on you" data-colour="grey" hidden><svg [^>]*aria-hidden="true">[\s\S]*?<\/svg><\/a>\s*<span id="who"><\/span>/);
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(app, /function showBell\(\) \{\s*bell\.dataset\.colour = bellColour\(waitingCount\);\s*\}/);
  // Every place the count is read colours the bell: the one-minute refresh and the Waiting on you page.
  const refresh = /async function refreshCount\(\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(refresh, /catch \(err\) \{[\s\S]*?return;\s*\}\s*document\.title = tabTitle\(waitingCount, pageTitle\);\s*showBell\(\);/, 'a failed read leaves the colour alone');
  assert.match(/async function drawWaiting\(\) \{[\s\S]*?\n\}/.exec(app)[0], /waitingCount = waiting\.length;\s*showBell\(\);/);
  assert.match(app, /setInterval\(refreshCount, COUNT_EVERY_MS\);/);
  // Hidden while signed out, shown once signed in, and marked current on its own page.
  assert.match(/function drawSignIn[\s\S]*?\n\}/.exec(app)[0], /bell\.hidden = true;/);
  assert.match(/async function route\(\) \{[\s\S]*?\n\}/.exec(app)[0], /signOut\.hidden = false;\s*bell\.hidden = false;/);
  assert.match(app, /bell\.classList\.toggle\('current', which === 'waiting'\);/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  for (const colour of ['grey', 'yellow', 'red']) assert.match(css, new RegExp(`header #bell\\[data-colour="${colour}"\\] \\{ color: #`));
  assert.match(css, /header #bell\[hidden\] \{ display: none; \}/, 'display: flex must not undo hidden');
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
  const { rendered } = operatorCard.buildCard(`@@ASKED\nbuild the list\n@@CONTEXT\n${sixty}\n@@NEEDED\nReply A or B.\nA is cheaper.\nYour move: Reply — A or B.`);
  const plain = machineComment.stripMachineMarker(machineComment.stampMachineComment(rendered));
  // The tracker keeps a card's red banner runs as **bold** lines (scripts/tracker/apiTracker.mjs).
  const stored = plain.split('\n').map((l) => (/^#{29}$|^NEEDED FROM|^A is cheaper|^Your move/.test(l) ? `**${l}**` : l)).join('\n');
  for (const body of [plain, stored]) {
    const html = renderComment(body);
    assert.match(html, /<div class="banner"><strong>NEEDED FROM DANE:<\/strong> Reply A or B\.<br>A is cheaper\.<br>Your move: Reply — A or B\.<\/div>/);
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
    operatorCard.buildCard(`@@ASKED\nbuild it\n@@CONTEXT\n${sixty(tag)}\n@@NEEDED\n${ask}\nYour move: Reply — ${tag}.`).rendered));
  const html = renderQuickAction({
    name: 'Make the page',
    description: '## Goal\nThe description.',
    comments: [{ body: card('old', 'Old ask.') }, { body: card('new', 'Reply A or B.\nA is cheaper.') }, { body: 'go' }],
  });
  assert.match(html, /^<h1>Make the page<\/h1>/);
  assert.match(html, /<p class="summary">new0 new1 [^<]*new59<\/p>/, 'the newest card\'s WHAT\'S GOING ON');
  assert.match(html, /<p class="needed">Reply A or B\.<br>A is cheaper\.<br>Your move: Reply — new\.<\/p>/);
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

// ── Quick Action: commands he is asked to run, click-to-copy ─────────────────

/** A card as `ask` posts it, and as the tracker stores it (every banner line in **…**). */
function commandCards(needed) {
  const sixty = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
  const plain = machineComment.stripMachineMarker(machineComment.stampMachineComment(
    operatorCard.buildCard(`@@ASKED\nbuild it\n@@CONTEXT\n${sixty}\n@@NEEDED\n${needed}\nYour move: Reply — done.`).rendered));
  const lines = plain.split('\n');
  const from = lines.findIndex((l) => /^#{29}$/.test(l));
  const stored = lines.map((l, i) => (i >= from && l.trim() ? `**${l}**` : l)).join('\n');
  return { plain, stored, raw: `@@ASKED\nbuild it\n@@NEEDED\n${needed}` };
}

/** The text a `<code>` element holds, as the browser's textContent reads it. */
const unescape = (html) => html.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
const codes = (html) => [...html.matchAll(/<code>([\s\S]*?)<\/code>/g)].map((m) => unescape(m[1]));

test('a card whose ask has command blocks shows each one on the right with its own Copy button', () => {
  const needed = 'Run these in Terminal:\n```bash\nnpm run clickup -- get --task SP-1\n```\nthen\n~~~\ncd ~/WebApps && ls\n~~~\nReply done.';
  for (const body of Object.values(commandCards(needed))) {
    const html = renderCommands({ comments: [{ body }, { body: 'go' }] });
    assert.equal(codes(html).length, 2);
    assert.equal(html.match(/<button type="button" class="copy-command">Copy<\/button>/g).length, 2);
    assert.match(html, /^<div class="commands">(<div class="command"><pre><code>[^<]*<\/code><\/pre><button[^>]*>Copy<\/button><\/div>){2}<\/div>$/);
  }
  // Only the newest card counts.
  const older = commandCards('```\nold command\n```').plain;
  const newer = commandCards('```\nnew command\n```').plain;
  assert.deepEqual(codes(renderCommands({ comments: [{ body: older }, { body: newer }] })), ['new command']);
});

test('Copy copies exactly the block\'s text: no fence, no extra spaces or line breaks', () => {
  const needed = 'Run:\n```bash\n\n  cat <<\'EOF\' > x.txt   \n    a "quoted" & <b>\n  EOF\n\n```';
  const exact = 'cat <<\'EOF\' > x.txt\n  a "quoted" & <b>\nEOF';
  for (const body of Object.values(commandCards(needed))) {
    assert.deepEqual(cardCommands(body), [exact]);
    assert.deepEqual(codes(renderCommands({ comments: [{ body }] })), [exact]);
  }
  // The page copies the drawn <code>'s own text, through the clipboard or, on the Mini's plain http, a hidden box.
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(app, /button\.parentElement\.querySelector\('code'\)\.textContent/);
  assert.match(app, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(app, /document\.execCommand\('copy'\)/);
  assert.match(app, /'Copied'/);
  const quick = /<section class="quick">([\s\S]*?)<\/section>/.exec(app)[1];
  assert.match(quick, /\$\{renderCommands\(t\)\}[\s\S]*<form class="reply">/, 'the commands sit on the right, above the reply box');
});

test('a card with no command block, or no card at all, shows no Copy buttons', () => {
  for (const body of Object.values(commandCards('Reply A or B.'))) {
    assert.equal(renderCommands({ comments: [{ body }] }), '');
  }
  // A fence outside the banner is not his to run.
  const { plain } = commandCards('Reply A or B.');
  assert.equal(renderCommands({ comments: [{ body: `${plain}\n\n\`\`\`\nnot an ask\n\`\`\`` }] }), '');
  assert.equal(renderCommands({ comments: [{ body: '```\nls\n```' }] }), '');
  assert.equal(renderCommands({ comments: [] }), '');
  assert.equal(renderCommands({}), '');
});

test('command text reaches the page escaped through render.mjs', () => {
  const nasty = '<script>alert(1)</script> "x" \'y\' & <img src=x onerror="z">';
  const html = renderCommands({ comments: [{ body: commandCards(`\`\`\`\n${nasty}\n\`\`\``).plain }] });
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /<code>&lt;script&gt;alert\(1\)&lt;\/script&gt; &quot;x&quot; &#39;y&#39; &amp; &lt;img/);
  assert.deepEqual(codes(html), [nasty]);
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(app, /import \{[^}]*\brenderCommands\b[^}]*\} from '\.\/render\.mjs'/);
});

test('lines inside a command block are copied as written, even ones that look like banner rules, sections or bold', () => {
  const heredoc = "cat <<'EOF' > notes.md\n" + '#'.repeat(29) + "\nls **/*.md**\nNEEDED FROM DANE: nothing\nEOF";
  const needed = `Run this in Terminal:\n\`\`\`bash\n${heredoc}\n\`\`\`\nReply done.`;
  const cards = commandCards(needed);
  for (const body of [cards.plain, cards.stored]) {
    assert.deepEqual(cardCommands(body), [heredoc]);
    assert.deepEqual(codes(renderCommands({ comments: [{ body }] })), [heredoc]);
    // The red ask reads the same banner, so it ends at the closing rule, not inside the block.
    assert.match(cardAsk(body), /Reply done\.\nYour move: Reply — done\.$/);
  }
  // An authored card that reached the tracker unrendered: an @@ line inside the block does not end the ask.
  const withSection = "cat <<'EOF' > notes.md\n@@END\n" + '#'.repeat(29) + '\nEOF';
  const raw = `@@ASKED\nbuild it\n@@NEEDED\nRun this:\n\`\`\`\n${withSection}\n\`\`\`\nReply done.\n@@EVIDENCE\nnone`;
  assert.deepEqual(cardCommands(raw), [withSection]);
});

test('a command block that is never closed is not offered to copy', () => {
  const needed = 'Run:\n```\nnpm run verify\n```\nthen:\n```\nnpm run clickup -- get --task SP-1\nReply done.';
  for (const body of Object.values(commandCards(needed))) {
    assert.deepEqual(cardCommands(body), ['npm run verify']);
    assert.doesNotMatch(renderCommands({ comments: [{ body }] }), /Reply done/);
  }
  // Its red ask still ends at the closing rule, as before.
  assert.match(cardAsk(commandCards(needed).plain), /Reply done\.\nYour move: Reply — done\.$/);
});

test('Copy works on the Mini\'s plain http page and a second click restarts the "Copied" timer', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const copy = /async function copyText[\s\S]*?\n}\n/.exec(app)[0];
  // The hidden box is focused before its text is selected, and the button gets focus back.
  assert.match(copy, /area\.focus\(\);\s*area\.setSelectionRange\(0, area\.value\.length\);[\s\S]*execCommand\('copy'\)/);
  assert.match(copy, /button\?\.focus\(\)/);
  assert.match(app, /clearTimeout\(reset\);\s*reset = setTimeout/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /\.quick \.act \{[^}]*min-width: 0/);
  assert.match(css, /\.quick \.command pre \{[^}]*min-width: 0/);
});

test('the trail links every step but the last, and the last is the page itself', () => {
  const html = renderTrail([
    { label: 'Spirality', href: '/board/spirality' },
    { label: 'Task SP-47', href: '/t/SP-47' },
    { label: 'Details' },
  ]);
  assert.equal(html, '<nav class="trail" aria-label="You are here">'
    + '<a href="/board/spirality">Spirality</a><span class="sep"> &gt; </span>'
    + '<a href="/t/SP-47">Task SP-47</a><span class="sep"> &gt; </span>'
    + '<span aria-current="page">Details</span></nav>');
  // A last step given an address is still not a link.
  assert.equal(renderTrail([{ label: 'Projects', href: '/projects' }]),
    '<nav class="trail" aria-label="You are here"><span aria-current="page">Projects</span></nav>');
});

test('every name in the trail is escaped, in its text and in its address', () => {
  const html = renderTrail([
    { label: 'R&D <b>', href: '/list/a"b' },
    { label: 'Task <script>alert(1)</script>' },
  ]);
  assert.doesNotMatch(html, /<b>|<script|a"b/);
  assert.match(html, /<a href="\/list\/a&quot;b">R&amp;D &lt;b&gt;<\/a>/);
  assert.match(html, /<span aria-current="page">Task &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/span>/);
});

test('every page puts its trail at the top: ticket, board, list, Waiting on you, Projects, New request', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const body = (name) => new RegExp(`async function ${name}\\(([^)]*)\\) \\{([\\s\\S]*?)\\n\\}`).exec(app)[2];
  // The ticket: its project in the view last used, then the ticket, then this page of it.
  assert.match(body('drawTicket'), /putTrail\(\[\s*\{ label: t\.projectName, href: `\/\$\{savedView\(\)\}\/\$\{encodeURIComponent\(t\.project\)\}` \},\s*\{ label: `Task \$\{t\.id\}`, href: `\/t\/\$\{encodeURIComponent\(t\.id\)\}` \},\s*\{ label: 'Details' \},\s*\]\)/);
  // A project's board or list climbs to Projects.
  assert.match(body('drawProject'), /putTrail\(\[\{ label: board\.projectName, href: '\/projects' \}, \{ label: view === 'board' \? 'Board' : 'List' \}\]\)/);
  assert.match(body('drawWaiting'), /putTrail\(\[\{ label: 'Waiting on you' \}\]\)/);
  assert.match(body('drawProjects'), /putTrail\(\[\{ label: 'Projects' \}\]\)/);
  assert.match(body('drawNew'), /putTrail\(\[\{ label: 'New request' \}\]\)/);
  // Each trail goes in after its page is drawn, so it sits first in main.
  assert.match(app, /main\.insertAdjacentHTML\('afterbegin', renderTrail\(steps\)\)/);
  assert.doesNotMatch(/function drawSignIn[\s\S]*?\n\}/.exec(app)[0], /putTrail/, 'no trail on the sign-in screen');
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /nav\.trail \{ font-size: 0\.85rem;/, 'a small, quiet line, not a heading');
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

// ── Editing and deleting a project ───────────────────────────────────────────

test('a project edited from the page shows its new name, web address, logo and owner on the table and its details page', async () => {
  const f = await fixture();
  try {
    await f.call('POST', '/projects', { body: { name: 'Try me', slug: 'try-me', prefix: 'TRY' } });
    const saved = await f.call('PATCH', '/projects/try-me', {
      body: { name: 'Tried', url: 'https://tried.example', logo: 'https://tried.example/l.png', owner: f.operator.id },
    });
    assert.equal(saved.status, 200);
    const row = (await f.call('GET', '/projects')).body.projects.find((p) => p.slug === 'try-me');
    assert.deepEqual(row, {
      slug: 'try-me', name: 'Tried', prefix: 'TRY', url: 'https://tried.example', logo: 'https://tried.example/l.png',
      owner: { id: f.operator.id, name: 'Dane' }, open: 0,
    });
    const details = (await f.call('GET', '/projects/try-me')).body;
    assert.deepEqual([details.name, details.url, details.logo, details.owner], [row.name, row.url, row.logo, row.owner]);
  } finally { await f.cleanup(); }
});

test('a project deleted from the page is gone; the demo\'s own project, which has tickets, is refused and stays', async () => {
  const f = await fixture();
  try {
    await f.call('POST', '/projects', { body: { name: 'Try me', slug: 'try-me', prefix: 'TRY' } });
    assert.equal((await f.call('DELETE', '/projects/try-me')).status, 200);
    assert.ok(!(await f.call('GET', '/projects')).body.projects.some((p) => p.slug === 'try-me'));
    const before = (await f.call('GET', '/projects')).body.projects;
    const full = before.find((p) => p.open > 0);
    const refused = await f.call('DELETE', `/projects/${full.slug}`);
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /^[A-Z][A-Z0-9]* has \d+ tickets?; a project with tickets cannot be deleted\.$/);
    assert.deepEqual((await f.call('GET', '/projects')).body.projects, before);
    // The loop's sign-in can do neither, and nothing changes.
    const loop = f.store.issueToken(f.loop.id);
    await f.call('POST', '/projects', { body: { name: 'Empty', slug: 'empty', prefix: 'EM' } });
    const now = (await f.call('GET', '/projects')).body.projects;
    assert.equal((await f.call('PATCH', '/projects/empty', { token: loop, body: { name: 'x' } })).status, 403);
    assert.equal((await f.call('DELETE', '/projects/empty', { token: loop })).status, 403);
    assert.deepEqual((await f.call('GET', '/projects')).body.projects, now);
  } finally { await f.cleanup(); }
});

test('the Projects table gives a person Edit and Delete on every row and a loop\'s sign-in neither; Delete asks first and a refusal says so', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const table = app.slice(app.indexOf('async function drawProjects'), app.indexOf('/**', app.indexOf('async function drawProjects')));
  // Both icons are drawn only for a person; otherwise the cell holds the View icon alone.
  assert.match(table, /const people = me\?\.kind === 'human';/);
  assert.match(table, /\$\{people\n\s+\? action\(`\/projects\/\$\{encodeURIComponent\(p\.slug\)\}\/edit`, 'Edit project', ICONS\.edit\)\n\s+\+ actionButton\('Delete project', ICONS\.delete, \{ delete: p\.slug, name: p\.name \}\)\n\s+: ''\}/);
  assert.equal((table.match(/ICONS\.edit/g) ?? []).length, 1, 'Edit is drawn in one place, behind the person check');
  assert.equal((table.match(/ICONS\.delete/g) ?? []).length, 1, 'Delete is drawn in one place, behind the person check');
  // Delete asks, by name, before anything is sent.
  const click = table.slice(table.indexOf("addEventListener('click'"));
  assert.ok(click.indexOf('if (!confirm(`Delete ${name}?`)) return;') < click.indexOf("api('DELETE'"), 'it asks before it deletes');
  assert.match(click, /api\('DELETE', `\/projects\/\$\{encodeURIComponent\(slug\)\}`\)/);
  // A refusal shows the server's own words and returns before any success line.
  assert.match(click, /note\.className = 'note error';\n\s+note\.textContent = `Not deleted: \$\{err\.message\}`;\n\s+button\.disabled = false;\n\s+return;/);
  assert.ok(click.indexOf('Not deleted:') < click.indexOf('Deleted ${name}.'), 'the success line is only reached after the call succeeded');
  // A deleted project is gone because the server's table says so: the table is read again.
  assert.match(click, /await drawProjects\(`Deleted \$\{name\}\.`\)/);
  assert.match(click, /localStorage\.removeItem\(PROJECT_KEY\)/);
  // Every name reaches the button's attributes escaped.
  assert.match(app, /Object\.entries\(data\)\.map\(\(\[k, v\]\) => ` data-\$\{k\}="\$\{escapeHtml\(v\)\}"`\)/);
});

test('the Edit project form is a person\'s only, filled in, with the slug and prefix shown but locked; a refused save keeps what was typed and says why', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const form = app.slice(app.indexOf('async function drawEditProject'), app.indexOf('/**', app.indexOf('async function drawEditProject')));
  assert.match(form, /if \(me\?\.kind !== 'human'\)[\s\S]{0,200}Only a person signed in to the tracker can change a project\./);
  assert.match(form, /p = await api\('GET', `\/projects\/\$\{encodeURIComponent\(slug\)\}`\)/);
  assert.match(form, /const filled = \(v\) => ` value="\$\{escapeHtml\(v \?\? ''\)\}"`;/);
  for (const id of ['name', 'url', 'logo']) assert.match(form, new RegExp(`field\\('${id}',[^\\n]*filled\\(p\\.${id}\\)`), id);
  for (const id of ['slug', 'prefix']) assert.match(form, new RegExp(`field\\('${id}',[^\\n]* disabled\\$\\{filled\\(p\\.${id}\\)\\}`), id);
  assert.match(form, /o\.id === p\.owner\?\.id \? ' selected' : ''/);
  // The change names only what may change; never the slug or prefix.
  assert.match(form, /api\('PATCH', `\/projects\/\$\{encodeURIComponent\(p\.slug\)\}`, \{\n\s+name: value\('name'\), url: value\('url'\), logo: value\('logo'\), owner: value\('owner'\) \? Number\(value\('owner'\)\) : null,\n\s+\}\)/);
  assert.match(form, /note\.textContent = `Not saved: \$\{err\.message\}`;/);
  assert.ok(!/main\.innerHTML/.test(form.slice(form.indexOf("addEventListener('submit'"))), 'a refused save never redraws the form, so nothing typed is lost');
  // Saving opens the details page, which reads the project back from the server.
  assert.match(form, /history\.pushState\(null, '', `\/projects\/\$\{encodeURIComponent\(saved\.slug\)\}`\);\n\s+await route\(\);/);
  assert.match(app, /const editProject = \/\^\\\/projects\\\/\(\[\^\/\]\+\)\\\/edit\$\/\.exec\(location\.pathname\);/);
});

// ── Quick Action's Merge button ──────────────────────────────────────────────

const PR = 'https://github.com/o/r/pull/41';

test('only a Ready to launch ticket gets the Merge button, and only when the server named a merge phrase', () => {
  for (const name of loopStatuses.STAGE_ORDER) {
    const html = renderMergeAction({ status: loopStatuses.statusOf(name), mergePhrase: 'merge', pullRequest: PR });
    if (loopStatuses.statusOf(name) === loopStatuses.READY_TO_LAUNCH) assert.match(html, /<form class="merge-action">\s*<button type="submit">Merge<\/button>/, name);
    else assert.equal(html, '', name);
  }
  assert.equal(renderMergeAction({ status: 'ready to launch', mergePhrase: null, pullRequest: PR }), '', 'no phrase, no button');
  assert.doesNotMatch(renderMergeAction({ status: 'ready to launch', mergePhrase: '<b>go</b>', pullRequest: PR }), /<b>/, 'the phrase is escaped');
});

/** A card as `ask` posts it, whose ask ends with `move`. */
function moveCard(move) {
  const sixty = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
  return machineComment.stripMachineMarker(machineComment.stampMachineComment(
    operatorCard.buildCard(`@@ASKED\nx\n@@CONTEXT\n${sixty}\n@@NEEDED\nThe ask.\nYour move: ${move} — a reason.`).rendered));
}

test('Merge shows only for a pull request of its own whose card does not name another move (SP-64)', () => {
  const rtl = { status: 'ready to launch', mergePhrase: 'merge' };
  assert.equal(renderMergeAction({ ...rtl, pullRequest: null }), '', 'no PR of its own: nothing to merge');
  assert.match(renderMergeAction({ ...rtl, pullRequest: PR }), /merge-action/, 'an open PR and an older card with no move line: Merge, as today');
  assert.match(renderMergeAction({ ...rtl, pullRequest: PR, comments: [{ body: moveCard('Merge') }] }), /merge-action/);
  for (const move of ['Close', 'Reply']) {
    assert.equal(renderMergeAction({ ...rtl, pullRequest: PR, comments: [{ body: moveCard(move) }] }), '', move);
  }
});

test('the page reads a card\'s move exactly as `ask` checks it', () => {
  for (const move of operatorCard.YOUR_MOVES) assert.equal(cardMove(moveCard(move)), move);
  // Stored by the tracker with each banner line in **…**, as the Copy tests do.
  const stored = moveCard('Close').split('\n').map((l) => (/^Your move/.test(l) ? `**${l}**` : l)).join('\n');
  assert.equal(cardMove(stored), 'Close');
  for (const needed of ['x\nYour move: Close — y', 'Your move: Merge\nthen more', 'x\nYour move: Approve', 'Pick A.']) {
    assert.equal(cardMove(`@@ASKED\nx\n@@NEEDED\n${needed}`), operatorCard.readYourMove(needed), needed);
  }
  assert.equal(cardMove('An ordinary comment.'), null);
});

test('Close shows on his two statuses when the newest card\'s move is Close, and only with a close word from the server', () => {
  const comments = [{ body: moveCard('Close') }];
  for (const name of loopStatuses.STAGE_ORDER) {
    const status = loopStatuses.statusOf(name);
    const html = renderCloseAction({ status, closePhrase: 'close', comments });
    if (loopStatuses.OPERATOR_HELD_STATUSES.includes(status)) assert.match(html, /<form class="close-action">\s*<button type="submit">Close<\/button>/, name);
    else assert.equal(html, '', name);
  }
  assert.equal(renderCloseAction({ status: 'ready to launch', closePhrase: null, comments }), '', 'no word, no button');
  assert.equal(renderCloseAction({ status: 'ready to launch', closePhrase: 'close', comments: [{ body: moveCard('Merge') }] }), '');
  assert.equal(renderCloseAction({ status: 'ready to launch', closePhrase: 'close', comments: [] }), '', 'no card, no Close');
  // The newest card decides: an older Close card under a newer Reply one is spent.
  assert.equal(renderCloseAction({ status: 'needs your input', closePhrase: 'close', comments: [...comments, { body: moveCard('Reply') }] }), '');
  assert.doesNotMatch(renderCloseAction({ status: 'ready to launch', closePhrase: '<b>x</b>', comments }), /<b>/, 'the word is escaped');
  assert.equal(closeQuestion({ name: 'Fix it' }), 'Close Fix it?');
});

test('the demo\'s SP-64-shaped ticket shows Close and no Merge; a ticket with its own PR shows Merge', async () => {
  const f = await fixture({ mergePhrase: 'merge' });
  try {
    const threads = await Promise.all(f.store.listTickets('beta').map(async (t) => (await f.call('GET', `/tickets/${t.id}/thread`)).body));
    const unstuck = threads.find((t) => /will not merge/.test(t.name));
    const own = threads.find((t) => t.status === 'ready to launch' && t.pullRequest);
    const page = (t) => ({ ...t, closePhrase: busRelayPlan.CLOSE_PHRASES[0] });
    assert.equal(renderMergeAction(page(unstuck)), '');
    assert.match(renderCloseAction(page(unstuck)), /close-action/);
    assert.match(renderMergeAction(page(own)), /merge-action/);
    assert.equal(renderCloseAction(page(own)), '');
  } finally { await f.cleanup(); }
});

test('the ticket page gets the close word from the relay\'s own close list, so Close posts something the relay closes on', async () => {
  const { CLOSE_PHRASE } = await import('./server.mjs');
  assert.equal(CLOSE_PHRASE, busRelayPlan.CLOSE_PHRASES[0]);
  assert.ok(busRelayPlan.isCloseCommand(CLOSE_PHRASE));
  const f = await fixture({ closePhrase: CLOSE_PHRASE });
  try {
    assert.equal((await f.call('GET', '/tickets/AL-1/thread')).body.closePhrase, CLOSE_PHRASE);
  } finally { await f.cleanup(); }
  const none = await fixture();
  try {
    assert.equal((await none.call('GET', '/tickets/AL-1/thread')).body.closePhrase, null, 'no word: no button');
  } finally { await none.cleanup(); }
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
  const handler = /const wordButton = \(selector, question, word, signedOut\) => \{([\s\S]*?)\n  \};/.exec(app)?.[1];
  assert.ok(handler, 'Merge and Close share one submit handler');
  // It asks first; cancelling returns before anything is posted.
  assert.match(handler, /e\.preventDefault\(\);\s*if \(!confirm\(question\)\) return;/);
  // The same call the reply box makes, with the word the server sent, the button held while it posts.
  assert.match(handler, /button\.disabled = true;[\s\S]*api\('POST', `\/tickets\/\$\{encodeURIComponent\(t\.id\)\}\/comments`, \{ body: word \}\)/);
  // A failed post says so, in red, and frees the button; no success line.
  assert.match(handler, /catch \(err\) \{[\s\S]*note\.className = 'note error';\s*note\.textContent = `Not posted: \$\{err\.message\}`;\s*button\.disabled = false;/);
  assert.doesNotMatch(handler, /Merged|merged!|Closed/);
  assert.match(app, /wordButton\('form\.merge-action', mergeQuestion\(t\), t\.mergePhrase,/);
  assert.match(app, /wordButton\('form\.close-action', closeQuestion\(t\), t\.closePhrase,/);
  // Wired inside the ticket page's own drawing, where `t` is that ticket, not at module level.
  const draw = /\nasync function drawTicket\(id\) \{[\s\S]*?\n\}\n/.exec(app)?.[0] ?? '';
  assert.match(draw, /const wordButton = [\s\S]*wordButton\('form\.merge-action'[\s\S]*wordButton\('form\.close-action'/);
  assert.equal(app.match(/const wordButton = /g).length, 1);
  assert.match(app, /<div class="act">\s*(?:\$\{renderCommands\(t\)\}\s*)?\$\{renderMergeAction\(t\)\}\s*\$\{renderCloseAction\(t\)\}\s*<form class="reply">/, 'Merge and Close sit above the reply box on the right');
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

// ── Stage colours on the Tasks page ──────────────────────────────────────────

test('a stage with a colour gets that border, a light tint behind its heading, and heading text in the colour', () => {
  const look = stageLook('#CC0000');
  assert.equal(look.border, '#cc0000');
  assert.equal(look.text, '#cc0000', 'a colour that reads on its own tint is used as it is');
  assert.notEqual(look.tint, look.text, 'the bar is never the same solid colour as the text');
  assert.ok(contrast(look.tint, '#000000') > 15, 'the tint is light: dark text reads on it');
});

test('the heading text reads on its bar for any colour picked, darkening only one too pale to read', () => {
  for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) {
    const colour = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    const look = stageLook(colour);
    assert.ok(contrast(look.text, look.tint) >= 3, colour);
    assert.notEqual(look.text, look.tint, colour);
  }
  const yellow = stageLook('#ffff00');
  assert.notEqual(yellow.text, '#ffff00', 'yellow on pale yellow would not read');
  assert.equal(yellow.border, '#ffff00', 'the border keeps the colour as picked');
});

test('a stage with no colour, or a bad saved value, draws as it always did', () => {
  for (const bad of [null, undefined, '', 'red', '#abc', '#zzzzzz', '#2b9cf2;background:url(x)', '"><script>', 42, {}]) {
    assert.equal(stageLook(bad), null, String(bad));
  }
  assert.deepEqual(stageLooks({ stages: [
    { status: 'Queued', colour: '#2b9cf2' },
    { status: 'Building', colour: null },
    { status: 'Live', colour: 'javascript:alert(1)' },
  ] }), { Queued: stageLook('#2b9cf2') });
  for (const answer of [null, undefined, {}, { stages: 'x' }]) assert.deepEqual(stageLooks(answer), {});
});

test('the Tasks page reads the stage colours with the board, puts them on as properties, and still draws when they cannot be read', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('async function drawProject'), app.indexOf('async function copyText'));
  assert.match(draw, /api\('GET', '\/stage-colours'\)\.then\(stageLooks, \(\) => \(\{\}\)\)/, 'an unreadable answer is no colours, not a broken page');
  assert.match(draw, /data-stage="\$\{escapeHtml\(c\.status\)\}"/);
  assert.match(draw, /el\.style\.setProperty\('--stage-border', look\.border\);/);
  assert.doesNotMatch(draw, /'Queued'|'Requested'|'Building'/, 'the stages come from the board, never typed out');
  const css = readFileSync(WEB('app.css'), 'utf8');
  for (const prop of ['--stage-border', '--stage-tint', '--stage-text']) assert.match(css, new RegExp(`var\\(${prop}\\)`), prop);
});

// ── Deleting a ticket nobody has started ─────────────────────────────────────

test('Delete is offered only for Requested and Queued, in either spelling of the status', () => {
  for (const name of loopStatuses.STAGE_ORDER) {
    const unstarted = name === 'Requested' || name === 'Queued';
    for (const status of [name, loopStatuses.statusOf(name)]) {
      assert.equal(canDelete(status), unstarted, status);
      if (unstarted) assert.match(renderDeleteAction({ status }), /<form class="delete-action">\s*<button type="submit">Delete<\/button>/, status);
      else assert.equal(renderDeleteAction({ status }), '', status);
    }
  }
  assert.equal(canDelete(undefined), false);
});

test('Delete asks once, naming the ticket by id and exact name, and says a refusal in plain words', () => {
  assert.equal(deleteQuestion({ id: 'SP-12', name: 'Fix "it" now' }), 'Delete SP-12 "Fix "it" now"? This cannot be undone.');
  assert.match(deleteRefusal('AL-3', { status: 409, message: 'ticket AL-3 is "building"' }), /^Not deleted: AL-3 has been started since this page was drawn, so it stays\./);
  assert.match(deleteRefusal('AL-3', { status: 404, message: 'no ticket AL-3.' }), /^Not deleted: AL-3 is no longer in the tracker\./);
  assert.equal(deleteRefusal('AL-3', { status: 500, message: 'the disk is full.' }), 'Not deleted: the disk is full.');
});

test('the list draws the bin on exactly the board\'s Requested and Queued rows, and the page\'s delete call removes one', async () => {
  const f = await fixture();
  try {
    const { columns } = (await f.call('GET', '/projects/alpha/board')).body;
    const deletable = columns.filter((c) => canDelete(c.status)).flatMap((c) => c.tickets);
    assert.ok(deletable.length >= 1, 'the test data has an unstarted ticket');
    assert.ok(columns.some((c) => !canDelete(c.status) && c.tickets.length), 'and a started one');
    const target = deletable[0];
    const r = await f.call('DELETE', `/tickets/${target.id}`);
    assert.equal(r.status, 200);
    const after = (await f.call('GET', '/projects/alpha/board')).body.columns.flatMap((c) => c.tickets);
    assert.ok(!after.some((t) => t.id === target.id), 'redrawn from the server, the row is gone');
    // A started ticket is refused, and stays.
    const started = columns.find((c) => c.status === 'Building').tickets[0];
    const refused = await f.call('DELETE', `/tickets/${started.id}`);
    assert.equal(refused.status, 409);
    assert.ok(f.store.getTicket(started.id));
  } finally { await f.cleanup(); }
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(app, /canDelete\(status\) \? actionButton\('Delete ticket', ICONS\.delete, \{ delete: t\.id \}\) : ''/);
  assert.match(app, /c\.tickets\.map\(row\(c\.status\)\)/);
  // No bin on the board's cards.
  const card = /const card = \(t\) => `([\s\S]*?)`;/.exec(app)[1];
  assert.doesNotMatch(card, /delete/i);
});

test('both Deletes confirm before any request, show a refusal on the page, and keep the ticket in view', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const listHandler = /button\.addEventListener\('click', async \(\) => \{\s*const id = button\.dataset\.delete;([\s\S]*?)\n    \}\);/.exec(app)?.[1];
  assert.ok(listHandler, 'the bin has a click handler');
  assert.match(listHandler, /^\s*if \(!confirm\(deleteQuestion\(\{ id, name: names\.get\(id\) \}\)\)\) return;/);
  assert.match(listHandler, /catch \(err\) \{[\s\S]*listNote\.textContent = deleteRefusal\(id, err\);\s*listNote\.hidden = false;\s*button\.disabled = false;\s*return;/);
  assert.match(listHandler, /\}\s*await drawProject\(slug, view\);$/, 'only a delete that succeeded redraws the list');
  const pageHandler = /deleteForm\?\.addEventListener\('submit', async \(e\) => \{([\s\S]*?)\n  \}\);/.exec(app)?.[1];
  assert.ok(pageHandler, 'the Delete button has a submit handler');
  assert.match(pageHandler, /^\s*e\.preventDefault\(\);\s*if \(!confirm\(deleteQuestion\(t\)\)\) return;/);
  assert.match(pageHandler, /catch \(err\) \{[\s\S]*deleteNote\.className = 'note error';\s*deleteNote\.textContent = deleteRefusal\(t\.id, err\);\s*button\.disabled = false;\s*return;/);
  assert.match(pageHandler, /history\.pushState\(null, '', `\/list\/\$\{encodeURIComponent\(t\.project\)\}`\);\s*await route\(\);$/);
  for (const handler of [listHandler, pageHandler]) {
    assert.equal(handler.match(/api\('DELETE', `\/tickets\/\$\{encodeURIComponent\((?:id|t\.id)\)\}`\)/g)?.length, 1);
    assert.ok(handler.indexOf('confirm(') < handler.indexOf("api('DELETE'"), 'asks before it sends');
  }
  assert.match(app, /\$\{renderDeleteAction\(t\)\}\s*<\/div>/, 'Delete sits at the foot of Quick Action\'s right side');
});
