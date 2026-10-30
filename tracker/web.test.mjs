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
import { escapeHtml, renderComment, renderInline, renderMarkdown } from './web/render.mjs';
import operatorCard from '../lib/operatorCard.js';
import machineComment from '../lib/machineComment.js';
import loopStatuses from '../lib/loopStatuses.js';
import mergeOnComment from '../lib/mergeOnComment.js';

const DOOR = fileURLToPath(new URL('../scripts/clickup.mjs', import.meta.url));
const WEB = (name) => fileURLToPath(new URL(`./web/${name}`, import.meta.url));

/** The demo data in a fresh store, a server on a free port, and a caller signed in as the operator. */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-web-'));
  const store = openStore(join(dir, 'tracker.db'), { now: tickingClock() });
  const seed = seedDemo(store, { operatorName: 'Dane' });
  const loopToken = store.issueToken(seed.loop.id);
  const server = await startServer({ store, port: 0 });
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

test('the board\'s columns are the seven statuses in STAGE_ORDER, each ticket in its own status\'s column', async () => {
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
    const urgent = r.body.columns[1].tickets.find((t) => t.name === 'An urgent fix filed after it');
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
      { slug: 'alpha', name: 'Alpha', prefix: 'AL', open: openIn('alpha') },
      { slug: 'beta', name: 'Beta', prefix: 'BE', open: openIn('beta') },
    ]);
    assert.equal((await f.call('GET', '/projects/beta/board')).body.projectName, 'Beta');
    assert.equal((await f.call('GET', '/projects/nope/board')).status, 404);
    assert.equal((await f.call('GET', '/projects', { token: null })).status, 401);
    assert.equal((await f.call('GET', '/projects/alpha/board', { token: null })).status, 401);
  } finally { await f.cleanup(); }
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

// ── The page itself ──────────────────────────────────────────────────────────

test('the page is served at /, at a ticket\'s address, at Projects, at Tasks, at the board and at the list without a token, locked to its own scripts', async () => {
  const f = await fixture();
  try {
    for (const path of ['/', '/t/AL-1', '/p', '/tasks', '/board', '/board/alpha', '/list', '/list/alpha']) {
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
    // The header: Projects picks a project, Tasks opens the one picked.
    assert.match(readFileSync(WEB('index.html'), 'utf8'), /<a href="\/p" data-nav="projects">Projects<\/a>\s*<a href="\/tasks" data-nav="tasks">Tasks<\/a>/);
    // Only those files: nothing else on disk is reachable, with or without a token.
    for (const path of ['/web/../store.mjs', '/web/%2e%2e%2fstore.mjs', '/web/demo.mjs', '/store.mjs']) {
      assert.notEqual((await f.call('GET', path, { token: null })).status, 200, path);
      assert.notEqual((await f.call('GET', path)).status, 200, path);
    }
    // The ticket data still needs the token.
    assert.equal((await f.call('GET', '/tickets/AL-1', { token: null })).status, 401);
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
