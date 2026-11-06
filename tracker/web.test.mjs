import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.mjs';
import { seedDemo, tickingClock } from './demoData.mjs';
import { reportsOf, REPORT_RANGES, searchTickets } from './pageData.mjs';
import { escapeHtml, renderComment, renderInline, renderMarkdown, renderQuickAction, renderCommands, cardCommands, cardAsk, renderMergeAction, renderAnswerIn, statusLabel, ANSWER_IN_NOTE, mergeQuestion, renderCloseAction, closeQuestion, renderGoAction, goQuestion, cardMove, renderTrail, renderProjectPicker, cardContext, firstParagraph, canDelete, deleteQuestion, deleteRefusal, renderDeleteAction, renderEditPanel, MOVED_MESSAGE, bellColour, stageLook, stageLooks, contrast, linkProblem, passwordProblem, renderSetPassword, renderPasswordSet, renderSignIn, renderForgot, MIN_PASSWORD, boldMatches, searchPattern, renderSearchResults, renderSearchFilters, activeFilters, redrawHold, drawnChoice, renderSetupNext, renderSetupSteps, renderSetupList, renderSetupForm, setupBody, setupSlug, setupSlugProblem, setupFollows, firstTicket } from './web/render.mjs';
import { startServer, setupSettingsOf } from './server.mjs';
import { saveAnswers, setupFields, setupOf } from './setup.mjs';
import { DANE_FIELDS as SETUP_FIELDS, STEPS as SETUP_STEPS } from '../scripts/onboard/onboard.mjs';
import { slugFromName } from '../lib/onboardAnswers.mjs';
import { loadProjectConfig } from '../lib/projectConfig.mjs';
import operatorCard from '../lib/operatorCard.js';
import machineComment from '../lib/machineComment.js';
import loopStatuses from '../lib/loopStatuses.js';
import mergeOnComment from '../lib/mergeOnComment.js';
import busRelayPlan from '../lib/busRelayPlan.js';
import { prOpenedComment } from '../scripts/lib/loopTrail.mjs';

const DOOR = fileURLToPath(new URL('../scripts/clickup.mjs', import.meta.url));
const WEB = (name) => fileURLToPath(new URL(`./web/${name}`, import.meta.url));

/** The demo data in a fresh store, a server on a free port, and a caller signed in as the operator. */
async function fixture({ mergePhrase, closePhrase, goPhrase } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-web-'));
  const clock = tickingClock();
  const store = openStore(join(dir, 'tracker.db'), { now: clock });
  const seed = seedDemo(store, { operatorName: 'Dane', clock });
  const loopToken = store.issueToken(seed.loop.id);
  const server = await startServer({ store, port: 0, mergePhrase, closePhrase, goPhrase });
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
      governancePaths: [], autoMergeLanes: [], operatorName: 'Dane', projectSlug: slug,
      legacyMachinePrefixes: [], projectScripts: {}, tracker: 'api', trackerUrl: url,
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

// ── His answer is in (SP-93) ─────────────────────────────────────────────────

/** Every ticket on a project's board, flattened, by id. */
async function boardTickets(f, slug) {
  const board = (await f.call('GET', `/projects/${slug}/board`)).body;
  return new Map(board.columns.flatMap((c) => c.tickets).map((t) => [t.id, t]));
}

test('pressing Merge puts "your answer is in" on the ticket page and the board, until a machine comment is newest', async () => {
  const f = await fixture({ mergePhrase: 'merge' });
  try {
    // BE-1: Ready to launch, a PR, the review's word newest: the Merge button, no note.
    let thread = (await f.call('GET', '/tickets/BE-1/thread')).body;
    assert.equal(thread.answerIn, false);
    assert.match(renderMergeAction(thread), /merge-action/);
    assert.equal(renderAnswerIn(thread), '');
    assert.equal((await boardTickets(f, 'beta')).get('BE-1').answerIn, false);

    // He presses Merge: the button posts his word, and the page redraws.
    assert.equal((await f.call('POST', '/tickets/BE-1/comments', { body: { body: 'merge' } })).status, 201);
    thread = (await f.call('GET', '/tickets/BE-1/thread')).body;
    assert.equal(thread.answerIn, true);
    assert.equal(renderMergeAction(thread), '', 'no second Merge button');
    assert.match(renderAnswerIn(thread), /Your answer is in\. The relay acts on it at its next pass\./);
    assert.equal(statusLabel(thread), `Ready to launch · ${ANSWER_IN_NOTE}`);
    assert.equal((await boardTickets(f, 'beta')).get('BE-1').answerIn, true, 'the board and list say so too');

    // The relay answers (here with a refusal): its comment is newest, the note goes, the button returns.
    const loopToken = f.store.issueToken(f.loop.id);
    assert.equal((await f.call('POST', '/tickets/BE-1/comments', { token: loopToken, body: { body: 'MERGE REFUSED: the check is red.' } })).status, 201);
    thread = (await f.call('GET', '/tickets/BE-1/thread')).body;
    assert.equal(thread.answerIn, false);
    assert.match(renderMergeAction(thread), /merge-action/);
    assert.equal(statusLabel(thread), 'Ready to launch');
    assert.equal((await boardTickets(f, 'beta')).get('BE-1').answerIn, false);
  } finally { await f.cleanup(); }
});

test('a loop writing under his token does not count as his answer', async () => {
  const f = await fixture();
  try {
    const tickets = await boardTickets(f, 'beta');
    const underToken = [...tickets.values()].find((t) => t.name === 'A question a loop asked under your token');
    assert.equal(underToken.answerIn, false);
  } finally { await f.cleanup(); }
});

test('a ticket outside his two statuses never shows "your answer is in", even with his comment newest', async () => {
  const f = await fixture();
  try {
    for (const [id, t] of await boardTickets(f, 'alpha')) {
      if (['needs your input', 'ready to launch'].includes(f.store.getTicket(id).status)) continue;
      assert.equal((await f.call('POST', `/tickets/${id}/comments`, { body: { body: 'any news?' } })).status, 201);
      assert.equal((await f.call('GET', `/tickets/${id}/thread`)).body.answerIn, false, `${id}: ${t.name}`);
    }
    for (const t of (await boardTickets(f, 'alpha')).values()) {
      if (!['needs your input', 'ready to launch'].includes(f.store.getTicket(t.id).status)) assert.equal(t.answerIn, false, t.id);
    }
  } finally { await f.cleanup(); }
});

test('"your answer is in" and "Waiting on you" never disagree: an answered ticket is never on the list', async () => {
  const f = await fixture();
  try {
    const { waiting } = (await f.call('GET', '/waiting')).body;
    const listed = new Set(waiting.map((t) => t.id));
    let answered = 0;
    for (const slug of ['alpha', 'beta']) {
      for (const t of (await boardTickets(f, slug)).values()) {
        if (!t.answerIn) continue;
        answered += 1;
        assert.ok(!listed.has(t.id), `${t.id} is answered and on the list`);
      }
    }
    assert.ok(answered >= 1, 'the demo data holds an answered ticket');
    // The rule is the waiting module's own, not a second copy of it.
    const source = readFileSync(fileURLToPath(new URL('./pageData.mjs', import.meta.url)), 'utf8');
    assert.match(source, /operatorSpokeLast\(/);
  } finally { await f.cleanup(); }
});

test('once his answer is in, Close and Go stand down too, and the ticket page, board and list draw the note', () => {
  const closeCard = moveCard('Close');
  const goCard = intakeCard();
  assert.match(renderCloseAction({ status: 'needs your input', closePhrase: 'close', comments: [{ body: closeCard }] }), /close-action/);
  assert.equal(renderCloseAction({ status: 'needs your input', closePhrase: 'close', comments: [{ body: closeCard }], answerIn: true }), '');
  assert.match(renderGoAction({ status: 'needs your input', goPhrase: 'go', comments: [{ body: goCard }] }), /go-action/);
  assert.equal(renderGoAction({ status: 'needs your input', goPhrase: 'go', comments: [{ body: goCard }], answerIn: true }), '');
  assert.equal(statusLabel({ status: 'needs your input', answerIn: false }), 'Needs your input');
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(app, /\$\{renderAnswerIn\(t\)\}/, 'the ticket page draws the line');
  assert.match(app, /statusLabel\(t\)/, 'the ticket page writes the status with the note');
  assert.equal(app.match(/t\.answerIn \? /g)?.length, 2, 'the board card and the list row both draw the note');
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
      { slug: 'alpha', name: 'Alpha', prefix: 'AL', url: null, logo: null, owner: null, repo: null, open: openIn('alpha') },
      { slug: 'beta', name: 'Beta', prefix: 'BE', url: null, logo: null, owner: null, repo: null, open: openIn('beta') },
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
      repo: null,
      alertEmail: null,
      alertPhone: null,
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
  assert.match(app, /action\(`\/projects\/\$\{encodeURIComponent\(p\.slug\)\}`, 'View Project', ICONS\.view\)/);
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
  assert.match(app, /action\(at, 'Open Ticket', ICONS\.open\)/);
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

test('the projects list names the project the server was given as its default, and none it does not hold', async () => {
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

test('the Add Task box on the Tasks page files into the project shown, in Requested as typed, keeps the text when refused or signed out, and is gone from the header', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const wire = app.slice(app.indexOf('function wireAddTask'), app.indexOf('/**', app.indexOf('function wireAddTask')));
  assert.match(wire, /api\('POST', `\/projects\/\$\{encodeURIComponent\(into\)\}\/tickets`, \{\s*name: title\.value, description: description\.value, status: 'Requested',\s*\}\)/);
  assert.ok(!/assignee/.test(wire), 'a request is filed unassigned');
  assert.match(wire, /note\.textContent = `Not filed: \$\{err\.message\}`;/);
  assert.match(wire, /localStorage\.setItem\(DRAFT_KEY,/);
  assert.match(wire, /title\.value = draft\.title;\s*description\.value = draft\.description;/);
  assert.match(wire, /if \(adding \|\| draft\.title \|\| draft\.description\) box\.open = true;/, 'kept text opens the box on its own');
  assert.match(wire, /drawSignIn\('You were signed out; your request was not filed\. What you typed is kept/);
  // Filed: the draft is forgotten and the page redraws, box closed, naming the new id.
  assert.match(wire, /localStorage\.removeItem\(DRAFT_KEY\);[\s\S]*await drawAgain\(\(\) => drawProject\(into, view, \{ filed: ticket\.id, unchecked, uploaded, notUploaded \}\)\);/);
  const draw = app.slice(app.indexOf('async function drawProject'), app.indexOf('async function copyText'));
  assert.match(draw, /<details class="add-task">\s*<summary>Add Task<\/summary>\s*<form class="request">/, 'drawn closed, on the board and the list alike');
  assert.match(draw, /Filed <a href="\/t\/\$\{encodeURIComponent\(filed\)\}">\$\{escapeHtml\(filed\)\}<\/a>/);
  assert.match(draw, /wireAddTask\(board\.project, view, adding\);/);
  assert.doesNotMatch(app, /drawNew/, 'the separate New request page is gone');
  // The old address opens the Tasks page with the box open.
  assert.match(/async function route\(\{ place = null \} = \{\}\) \{[\s\S]*?\n\}/.exec(app)[0], /\} else if \(isNew\) \{[\s\S]*?await drawTasks\(savedView\(\), \{ adding: true \}\);/);
  assert.doesNotMatch(readFileSync(WEB('index.html'), 'utf8'), /New request|href="\/new"/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  const box = /details\.add-task \{([^}]*)\}/.exec(css);
  assert.ok(box, 'the Add Task box has its own rule');
  assert.match(box[1], /background: var\(--blue\);/, 'the box is the logo blue, closed and open');
  assert.match(box[1], /color: var\(--ink\);/, 'dark text on the blue, not white');
  assert.match(css, /details\.add-task form\.request input, details\.add-task form\.request textarea \{[^}]*background: #fff;/, 'the fields stay white');
  // The status line (Filing…, Not filed: …) keeps its quiet grey and red, so it sits on white, readable on the blue.
  assert.match(css, /details\.add-task \.note:not\(:empty\) \{[^}]*background: #fff;/, 'the note sits on a white pill inside the blue box');
});

test('the Add Task box takes files: the ticket is filed first, then each file goes up as itself, and the note names any that did not (SP-140)', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const wire = app.slice(app.indexOf('function wireAddTask'), app.indexOf('/**', app.indexOf('function wireAddTask')));
  const draw = app.slice(app.indexOf('async function drawProject'), app.indexOf('async function copyText'));
  assert.match(draw, /<label for="files">Files<\/label>\s*<input id="files" type="file" multiple>/, 'several at once');
  assert.match(draw, /Files are not kept in the saved draft: after a reload, pick them again\./);
  // Filed first, then the files, one at a time; a failure is kept by name and the ticket stands.
  const filed = wire.indexOf("api('POST', `/projects/${encodeURIComponent(into)}/tickets`");
  const sent = wire.indexOf('await uploadFile(ticket.id, file);');
  assert.ok(filed > 0 && sent > filed, 'the ticket is filed before any file is sent');
  assert.match(wire, /notUploaded\.push\(\{ name: file\.name, why: err\.message \}\);/);
  assert.match(wire, /notUploaded\.push\(\{ name: file\.name, why: 'over 10 MB' \}\);/);
  assert.match(wire, /You were signed out; \$\{ticket\.id\} was filed, but \$\{file\.name\} and any files after it were not uploaded\./);
  assert.doesNotMatch(/function savedDraft[\s\S]*?\n\}/.exec(app)[0], /files/, 'the draft keeps only the text');
  // The upload is the file itself, with a type and headers only the page's own script can send.
  const up = /async function uploadFile[\s\S]*?\n\}/.exec(app)[0];
  assert.match(up, /'content-type': 'application\/octet-stream'/);
  assert.match(up, /'x-file-name': encodeURIComponent\(file\.name\)/);
  assert.match(up, /body: file,/);
  // The note: uploaded names, then the ones that were not, each with why, escaped.
  const note = /function filesNote[\s\S]*?\n\}/.exec(app)[0];
  assert.match(note, /Uploaded \$\{names\(uploaded\)\}/);
  assert.match(note, /Not uploaded: /);
  assert.match(note, /The ticket is filed without/);
  assert.match(note, /escapeHtml\(n\)/);
  assert.match(note, /escapeHtml\(f\.name\)/);
  assert.match(draw, /\$\{filesNote\(uploaded, notUploaded\)\}<\/p>/);
});

test('the ticket page lists its attachments by name and size, each a download, a plain picture also previewed, never an SVG (SP-140)', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const list = /function renderAttachments[\s\S]*?\n\}/.exec(app)[0];
  assert.match(list, /href="\$\{href\}" download="\$\{escapeHtml\(a\.name\)\}">\$\{escapeHtml\(a\.name\)\}<\/a> <span class="quiet">\$\{escapeHtml\(sizeOf\(a\.size\)\)\}<\/span>/);
  assert.match(list, /PREVIEW_TYPES\.includes\(a\.type\) \? `<a class="preview"[^`]*<img src="\$\{href\}"/);
  assert.match(list, /<h2>Attachments<\/h2>/);
  assert.match(app, /const PREVIEW_TYPES = Object\.freeze\(\['image\/png', 'image\/jpeg', 'image\/gif', 'image\/webp'\]\);/);
  const ticket = app.slice(app.indexOf('async function drawTicket'), app.indexOf('wireCopyButtons();', app.indexOf('async function drawTicket')));
  assert.match(ticket, /<section class="description">[^\n]*<\/section>\s*\$\{renderAttachments\(t\)\}/, 'right under the description');
});

test('the Add Task box checks the project before filing: asks "Did you mean ...?" when another fits, files where he says, never blocks on a failed check', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const wire = app.slice(app.indexOf('function wireAddTask'), app.indexOf('/**', app.indexOf('function wireAddTask')));
  // The check comes first, with the words as typed, and writes nothing (its server test reads the store).
  const check = wire.indexOf("api('POST', `/projects/${encodeURIComponent(slug)}/tickets/check`, {");
  const file = wire.indexOf("api('POST', `/projects/${encodeURIComponent(into)}/tickets`, {");
  assert.ok(check > 0 && file > check, 'the check is asked before the ticket is filed');
  assert.match(wire.slice(check), /^api\('POST', [^,]+, \{\s*name: title\.value, description: description\.value,\s*\}\)/);
  // No suggestion: files into the project shown, as before.
  assert.match(wire, /let into = slug;\s*if \(suggest\) \{/);
  // A suggestion: File in X files there; Keep in files here; closing files nothing and keeps the text.
  assert.match(wire, /const choice = await askProject\(question, suggest\);\s*if \(choice === 'move'\) into = suggest\.slug;\s*else if \(choice !== 'keep'\) \{[^}]*button\.disabled = false;[^}]*return;\s*\}/);
  assert.doesNotMatch(wire.slice(wire.indexOf("else if (choice !== 'keep')"), wire.indexOf('return;', wire.indexOf("else if (choice !== 'keep')"))), /removeItem|title\.value =|description\.value =/, 'closing leaves the form and the draft as they were');
  // A failed check (anything but a sign-out) files into the project shown, and the note says so.
  assert.match(wire, /\} catch \(err\) \{\s*if \(err instanceof SignedOut\) return drawSignIn\([^)]*\);\s*unchecked = true;\s*\}/);
  assert.match(app, /const UNCHECKED_NOTE = 'The project check could not run, so it went into the project shown\.';/);
  const draw = app.slice(app.indexOf('async function drawProject'), app.indexOf('async function copyText'));
  assert.match(draw, /\$\{unchecked \? `\. \$\{UNCHECKED_NOTE\}` : ''\}/);
  // Filed elsewhere: X's board opens, naming X's new ticket id.
  assert.match(wire, /if \(into !== slug\) history\.pushState\(null, '', `\/\$\{view\}\/\$\{encodeURIComponent\(into\)\}`\);/);
  // The question box: the words of the ticket, File in X, Keep in the project shown, and a close.
  assert.match(draw, /<dialog class="project-check"[^>]*>\s*<form method="dialog">/);
  assert.match(draw, /Did you mean for that to be associated with project <strong class="project-name"><\/strong>\?/);
  assert.match(draw, /<button type="submit" value="move">File in<\/button>/);
  assert.match(draw, /<button type="submit" value="keep">Keep in \$\{escapeHtml\(board\.projectName\)\}<\/button>/);
  assert.match(draw, /<button type="submit" class="close" value="" aria-label="Close: file nothing">/);
  const ask = app.slice(app.indexOf('function askProject'), app.indexOf('/**', app.indexOf('function askProject')));
  assert.match(ask, /\.project-name'\)\.textContent = suggest\.name;/, 'the name goes in as text, never markup');
  assert.match(ask, /button\[value="move"\]'\)\.textContent = `File in \$\{suggest\.name\}`;/);
  assert.match(ask, /question\.returnValue = '';[\s\S]*resolve\(question\.returnValue\)[\s\S]*question\.showModal\(\);/, 'Esc or the close button answers empty: file nothing');
  assert.match(readFileSync(WEB('app.css'), 'utf8'), /dialog\.project-check \{/);
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

test('the page is served at /, at a ticket\'s address, at Projects, at Tasks, at the board, at the list and at the old New request address without a token, locked to its own scripts', async () => {
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

test('the Settings page is in the header after Reporting and Users, lists the stages the server gives, saves them all, reads them back, and shows a refusal', async () => {
  const html = readFileSync(WEB('index.html'), 'utf8');
  assert.match(html, /<a href="\/reporting" data-nav="reporting">Reporting<\/a>\s*<a href="\/users" data-nav="users">Users<\/a>\s*<a href="\/settings" data-nav="settings">Settings<\/a>/);
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('async function drawSettings'), app.indexOf('/**\n * The Users page'));
  assert.match(draw, /const \{ stages \} = await api\('GET', '\/stage-colours'\);/, 'the stages come from the server, never typed out');
  assert.doesNotMatch(draw, /'Queued'|'Requested'|'Live'/);
  assert.match(draw, /type="color"/);
  assert.match(draw, /chosen\[tr\.dataset\.status\] = null;/, 'Clear sets no colour');
  assert.match(draw, /await api\('PUT', '\/stage-colours', \{ colours: chosen \}\);\s*\/\/ Read back before saying it worked\.\s*const back = await api\('GET', '\/stage-colours'\);/);
  assert.match(draw, /note\.textContent = `Not saved: \$\{err\.message\}`;/);
  assert.match(draw, /escapeHtml\(s\.status\)/);
  assert.match(app, /markNav\(reporting \? 'reporting' : settings \? 'settings' :/);
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
  assert.deepEqual([...nav.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1]), ['Projects', 'Tasks', 'Reporting', 'Users', 'Settings']);
  assert.doesNotMatch(nav, /Waiting on you/);
  const me = /<span class="me">([\s\S]*?)<\/span>\s*<\/header>/.exec(html)[1];
  assert.match(me, /<a id="bell" href="\/" title="Waiting on You" aria-label="Waiting on You" data-colour="grey" hidden><svg [^>]*aria-hidden="true">[\s\S]*?<\/svg><\/a>\s*<span id="who"><\/span>/);
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(app, /function showBell\(\) \{\s*bell\.dataset\.colour = bellColour\(waitingCount\);\s*\}/);
  // Every place the count is read colours the bell: the one-minute refresh and the Waiting on you page.
  const refresh = /async function refreshCount\(\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(refresh, /catch \(err\) \{[\s\S]*?return;\s*\}\s*document\.title = tabTitle\(waitingCount, pageTitle\);\s*showBell\(\);/, 'a failed read leaves the colour alone');
  assert.match(/async function drawWaiting\(\) \{[\s\S]*?\n\}/.exec(app)[0], /waitingCount = waiting\.length;\s*showBell\(\);/);
  assert.match(app, /async function beat\(\) \{\s*await refreshCount\(\);/);
  assert.match(app, /setInterval\(beat, REFRESH_EVERY_MS\);/);
  // Hidden while signed out, shown once signed in, and marked current on its own page.
  assert.match(/function signedOutHeader[\s\S]*?\n\}/.exec(app)[0], /bell\.hidden = true;/);
  assert.match(/function drawSignIn[\s\S]*?\n\}/.exec(app)[0], /signedOutHeader\(/);
  assert.match(/async function route\(\{ place = null \} = \{\}\) \{[\s\S]*?\n\}/.exec(app)[0], /signOut\.hidden = false;\s*bell\.hidden = false;/);
  assert.match(app, /bell\.classList\.toggle\('current', which === 'waiting'\);/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  for (const colour of ['grey', 'yellow', 'red']) assert.match(css, new RegExp(`header #bell\\[data-colour="${colour}"\\] \\{ color: #`));
  assert.match(css, /header #bell\[hidden\] \{ display: none; \}/, 'display: flex must not undo hidden');
});

// ── Keeping an open page current (SP-94) ─────────────────────────────────────

test('a beat leaves the page alone while the tab is hidden, a draw or a save is under way, or he is typing', () => {
  const idle = { focused: false, value: '', initial: '' };
  assert.equal(redrawHold(), null);
  assert.equal(redrawHold({ fields: [idle, { focused: false, value: 'SP-94', initial: 'SP-94' }] }), null, 'a box as drawn is not typing');
  assert.equal(redrawHold({ hidden: true }), 'hidden');
  assert.equal(redrawHold({ hidden: true, fields: [idle] }), 'hidden', 'hidden wins: nothing is read at all');
  assert.equal(redrawHold({ drawing: true }), 'drawing');
  assert.equal(redrawHold({ writing: true }), 'writing');
  assert.equal(redrawHold({ fields: [idle, { focused: true, value: '', initial: '' }] }), 'typing', 'a box with focus, even empty');
  assert.equal(redrawHold({ fields: [idle, { focused: false, value: 'half a repl', initial: '' }] }), 'typing', 'unsent text, focus gone');
  assert.equal(redrawHold({ fields: [{ focused: false, value: 'Old name, edited', initial: 'Old name' }] }), 'typing', 'an edited name');
});

test('a chooser picked and left (Copy to another project) holds the beat; one as drawn does not', () => {
  const opt = (value, defaultSelected = false) => ({ value, defaultSelected });
  assert.equal(drawnChoice([opt('normie'), opt('wavecenter')]), 'normie', 'nothing marked: the first option');
  assert.equal(drawnChoice([opt('low'), opt('high', true)]), 'high', 'the option drawn selected');
  assert.equal(drawnChoice([]), '');
  // Picked WaveCenter, then clicked somewhere blank: not his focus, but not as drawn.
  const copyTo = [opt('normie'), opt('wavecenter')];
  assert.equal(redrawHold({ fields: [{ focused: false, value: 'wavecenter', initial: drawnChoice(copyTo) }] }), 'typing');
  assert.equal(redrawHold({ fields: [{ focused: false, value: 'normie', initial: drawnChoice(copyTo) }] }), null);
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(/const fieldsOf = [\s\S]*?\n\}\)\);/.exec(app)[0], /initial: el\.tagName === 'SELECT' \? drawnChoice\(el\.options\) : el\.defaultValue,/);
});

test('an open page reads again once a minute and on coming back to the tab, never while hidden, and keeps his place', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(app, /const REFRESH_EVERY_MS = 60_000;/);
  assert.match(app, /document\.addEventListener\('visibilitychange', \(\) => \{\s*if \(!document\.hidden\) beat\(\);\s*\}\);/);
  // The guard reads the tab's visibility, the draws and saves under way, and every text box on the page.
  assert.match(app, /redrawHold\(\{ hidden: document\.hidden, drawing: drawing > 0, writing: writing > 0, fields: fieldsOf\(main\) \}\)/);
  const refresh = /async function refreshPage\(\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(refresh, /if \(checking \|\| !me \|\| !drawn \|\| drawn\.address !== here\(\) \|\| hold\(\)\) return;/, 'checked before any read');
  assert.match(refresh, /if \(!changed \|\| lastDrawn !== drawn \|\| drawn\.address !== here\(\) \|\| hold\(\)\) return;/, 'and again before drawing');
  assert.match(refresh, /await route\(\{ place: keepPlace\(\) \}\);/);
  assert.match(refresh, /catch \(err\) \{\s*if \(err instanceof SignedOut\) drawSignIn\(\);\s*\}/, 'a failed read leaves the page as it is');
  // Only Waiting on you, the board and list, and a ticket keep themselves current.
  const route = /async function route\(\{ place = null \} = \{\}\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(route, /lastDrawn = ticket \|\| project \|\| tasks \|\| isNew \|\| waiting \? \{ address: here\(\), reads \} : null;/);
  assert.match(route, /place\?\.restore\(\);\s*const kept = recording === reads;\s*if \(kept\) recording = null;\s*\/\/[^\n]*\n\s*if \(!waiting\) await refreshCount\(\);\s*if \(kept\) lastDrawn = /, 'his place is back before the page is shown, and the count is not part of what it was drawn from');
  assert.match(route, /me = await api\('GET', '\/me'\);\s*\/\/[^\n]*\n\s*recording = reads;/, 'who is signed in is not part of it either');
  // A save's own redraw keeps what the beat compares against, so the next beat does not undo its "Saved" note.
  assert.match(/async function drawAgain\(draw\) \{[\s\S]*?\n\}/.exec(app)[0], /await draw\(\);\s*if \(recording === reads && lastDrawn\?\.address === here\(\)\) lastDrawn = \{ address: here\(\), reads \};/);
  assert.equal(app.match(/await drawTicket\(t\.id/g), null, 'every in-page ticket redraw goes through drawAgain');
  assert.equal((app.match(/await drawAgain\(\(\) => draw(Ticket|Project)\(/g) ?? []).length, 5);
  assert.match(route, /if \(place && !\(err instanceof SignedOut\)\) return;/, "a beat's failed draw does not replace the page with an error");
  assert.match(app, /if \(location\.hash === '#reply' && !refreshing\) \{/, 'a beat does not jump to the reply box again');
  assert.match(/function keepPlace\(\) \{[\s\S]*?\n\}/.exec(app)[0], /main\.querySelectorAll\('details'\)[\s\S]*window\.scrollTo\(0, y\);/);
  // Every GET of a draw is kept; a write counts as a save under way until it answers.
  const api = /async function api\(method, path, body\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(api, /if \(write\) writing \+= 1;/);
  assert.match(api, /finally \{\s*if \(write\) writing -= 1;\s*\}/);
  assert.match(api, /if \(!write\) reads\?\.set\(path, JSON\.stringify\(json\)\);/);
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
  for (const part of [/statusLabel\(t\)/, /renderMarkdown\(t\.description\)/, /\$\{comments \|\|/]) assert.match(details, part);
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
    status: 'needs your input',
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
    status: 'needs your input',
    comments: [{ body: `@@ASKED\nx\n@@CONTEXT\n${nasty}\n@@NEEDED\n${nasty} <img src=x onerror="y">` }],
  });
  assert.doesNotMatch(html, /<script|<img/);
  assert.equal(html.match(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/g).length, 3);
});

test('Quick Action asks for his move only while the ticket waits on him (SP-118)', () => {
  const sixty = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
  const goCard = machineComment.stripMachineMarker(machineComment.stampMachineComment(operatorCard.buildCard(
    `@@ASKED\nbuild it\n@@CONTEXT\n${sixty}\n@@NEEDED\nReply "go" to queue it as written, or reply with what to change.\nYour move: Reply — "go", or what to change.`).rendered));
  const ticket = { name: 'SP-112', description: '', comments: [{ body: goCard }], goPhrase: 'go' };
  // SP-112: answered go, built, sent back. The old card is still the newest card.
  const rework = renderQuickAction({ ...ticket, status: 'rework' });
  assert.doesNotMatch(rework, /Your move|class="needed"/);
  assert.match(rework, /<p class="where quiet">In Rework: the build loop is fixing what review found\. Nothing is needed from you\.<\/p>/);
  assert.equal(renderGoAction({ ...ticket, status: 'rework' }), '', 'and no Go button');
  // The same card on Needs your input: the ask and the Go button, and no quiet line.
  const nyi = renderQuickAction({ ...ticket, status: 'needs your input' });
  assert.match(nyi, /<p class="needed">[^<]*go[\s\S]*Your move: Reply/);
  assert.doesNotMatch(nyi, /class="where/);
  assert.match(renderGoAction({ ...ticket, status: 'needs your input' }), /go-action/);
  // His answer is in: no ask, even in his status.
  assert.doesNotMatch(renderQuickAction({ ...ticket, status: 'needs your input', answerIn: true }), /Your move|class="needed"/);
  assert.doesNotMatch(renderQuickAction({ ...ticket, status: 'Ready to launch', answerIn: true }), /Your move|class="needed"/);
  // Every machine status has its line and never an ask.
  for (const status of ['requested', 'queued', 'building', 'in review', 'rework', 'live']) {
    const html = renderQuickAction({ ...ticket, status });
    assert.doesNotMatch(html, /Your move|class="needed"/, status);
    assert.match(html, /class="where quiet">[^<]*Nothing is needed from you\.<\/p>/, status);
  }
  // The page hands the function the ticket's status and answerIn (the whole thread).
  assert.match(readFileSync(WEB('app.mjs'), 'utf8'), /renderQuickAction\(t\)/);
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

test('every page puts its trail at the top: ticket, board, list, Waiting on you, Projects', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const body = (name) => new RegExp(`async function ${name}\\(([^)]*)\\) \\{([\\s\\S]*?)\\n\\}`).exec(app)[2];
  // The ticket: its project in the view last used, then the ticket, then this page of it.
  assert.match(body('drawTicket'), /putTrail\(\[\s*\{ label: t\.projectName, href: `\/\$\{savedView\(\)\}\/\$\{encodeURIComponent\(t\.project\)\}` \},\s*\{ label: `Task \$\{t\.id\}`, href: `\/t\/\$\{encodeURIComponent\(t\.id\)\}` \},\s*\{ label: 'Details' \},\s*\]\)/);
  // A project's board or list climbs to Projects.
  assert.match(body('drawProject'), /putTrail\(\[\{ label: board\.projectName, href: '\/projects' \}, \{ label: view === 'board' \? 'Board' : 'List' \}\]\)/);
  assert.match(body('drawWaiting'), /putTrail\(\[\{ label: 'Waiting on You' \}\]\)/);
  assert.match(body('drawProjects'), /putTrail\(\[\{ label: 'Projects' \}\]\)/);
  // Each trail goes in after its page is drawn, so it sits first in main.
  assert.match(app, /main\.insertAdjacentHTML\('afterbegin', renderTrail\(steps\)\)/);
  assert.doesNotMatch(/function drawSignIn[\s\S]*?\n\}/.exec(app)[0], /putTrail/, 'no trail on the sign-in screen');
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /nav\.trail \{ font-size: 0\.85rem;/, 'a small, quiet line, not a heading');
});

// ── Create Project ───────────────────────────────────────────────────────────

test('a project added from the page shows on the Projects screen and its details page with its logo, web address, GitHub repository and owner', async () => {
  const f = await fixture();
  try {
    const people = await f.call('GET', '/people');
    assert.deepEqual(people.body.people.map((p) => p.name), ['Dane'], 'the owner picker offers the people, not the loop');
    const made = await f.call('POST', '/projects', {
      body: {
        name: 'Try me', slug: 'try-me', prefix: 'TRY', url: 'https://try.example', logo: 'https://try.example/logo.png',
        repo: 'https://github.com/my-org/try-me', owner: f.operator.id,
      },
    });
    assert.equal(made.status, 201);
    const row = (await f.call('GET', '/projects')).body.projects.find((p) => p.slug === 'try-me');
    assert.deepEqual(row, {
      slug: 'try-me', name: 'Try me', prefix: 'TRY', url: 'https://try.example', logo: 'https://try.example/logo.png',
      owner: { id: f.operator.id, name: 'Dane' }, repo: 'my-org/try-me', open: 0,
    });
    const details = (await f.call('GET', '/projects/try-me')).body;
    assert.deepEqual([details.url, details.logo, details.owner, details.repo], [row.url, row.logo, row.owner, row.repo]);
    // A box that is not a repository is refused with the store's own words, and nothing is added.
    const bad = await f.call('POST', '/projects', { body: { name: 'Bad', slug: 'bad', prefix: 'BAD', repo: 'https://gitlab.com/my-org/bad' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'bad-repo');
    assert.match(bad.body.message, /owner\/name/);
    assert.ok(!(await f.call('GET', '/projects')).body.projects.some((p) => p.slug === 'bad'));
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
  // SP-127: the Projects page's button is Set up a product; the bare form is a link on its page.
  assert.match(app, /me\?\.kind === 'human' \? '<div class="toolbar"><a class="button" href="\/setup\/new">Set Up a Product<\/a><\/div>' : ''/);
  assert.match(app, /<a href="\/projects\/new">New project<\/a>/);
  const form = app.slice(app.indexOf('async function drawCreateProject'), app.indexOf('/**', app.indexOf('async function drawCreateProject')));
  assert.match(form, /if \(me\?\.kind !== 'human'\)[\s\S]{0,200}Only a person signed in to the tracker can add a project\./);
  for (const id of ['name', 'slug', 'prefix', 'url', 'logo', 'repo']) assert.match(form, new RegExp(`field\\('${id}',`), id);
  assert.match(form, /url: value\('url'\), logo: value\('logo'\), repo: value\('repo'\), owner:/);
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
  // A GitHub repository is drawn as a link to it on GitHub only when it is owner/name, escaped; otherwise "none".
  assert.match(app, /const isRepo = \(v\) => typeof v === 'string' && \/\^\[A-Za-z0-9-\]\+\\\/\[A-Za-z0-9\._-\]\+\$\/\.test\(v\);/);
  assert.match(app, /<a href="https:\/\/github\.com\/\$\{escapeHtml\(p\.repo\)\}" target="_blank" rel="noopener noreferrer">\$\{escapeHtml\(p\.repo\)\}<\/a>/);
  assert.match(app, /<td class="repo">\$\{repoOf\(p\)\}<\/td>/);
  assert.match(app, /<th class="repo">GitHub Repository<\/th>/);
  assert.match(app, /<dt>GitHub repository<\/dt><dd>\$\{repoOf\(p\)\}<\/dd>/);
});

// ── Editing and deleting a project ───────────────────────────────────────────

test('a project edited from the page shows its new name, web address, logo, GitHub repository and owner on the table and its details page', async () => {
  const f = await fixture();
  try {
    await f.call('POST', '/projects', { body: { name: 'Try me', slug: 'try-me', prefix: 'TRY' } });
    const saved = await f.call('PATCH', '/projects/try-me', {
      body: { name: 'Tried', url: 'https://tried.example', logo: 'https://tried.example/l.png', repo: 'my-org/tried', owner: f.operator.id },
    });
    assert.equal(saved.status, 200);
    const row = (await f.call('GET', '/projects')).body.projects.find((p) => p.slug === 'try-me');
    assert.deepEqual(row, {
      slug: 'try-me', name: 'Tried', prefix: 'TRY', url: 'https://tried.example', logo: 'https://tried.example/l.png',
      owner: { id: f.operator.id, name: 'Dane' }, repo: 'my-org/tried', open: 0,
    });
    const details = (await f.call('GET', '/projects/try-me')).body;
    assert.deepEqual([details.name, details.url, details.logo, details.owner, details.repo], [row.name, row.url, row.logo, row.owner, row.repo]);
    // An emptied box clears it.
    assert.equal((await f.call('PATCH', '/projects/try-me', { body: { repo: '' } })).body.repo, null);
    // The alert boxes save, read back on the Edit form's own GET, and never reach the projects table.
    await f.call('PATCH', '/projects/try-me', { body: { alertEmail: 'tried@example.com', alertPhone: '+1 801 555 0123' } });
    const edit = (await f.call('GET', '/projects/try-me')).body;
    assert.deepEqual([edit.alertEmail, edit.alertPhone], ['tried@example.com', '+18015550123']);
    const listed = (await f.call('GET', '/projects')).body.projects.find((p) => p.slug === 'try-me');
    assert.ok(!('alertEmail' in listed) && !('alertPhone' in listed));
  } finally { await f.cleanup(); }
});

test('both project forms carry an Alert email and an Alert phone box with their hints, and send them', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(app, /const ALERT_EMAIL_HINT = "Where hand-over alerts for this project go\. Empty: the tracker's default address\.";/);
  assert.match(app, /const ALERT_PHONE_HINT = 'For iMessage alerts, e\.g\. 801 555 0123, or \+44 20 7946 0000 outside the US\. Empty: no texts\.';/);
  for (const fn of ['drawCreateProject', 'drawEditProject']) {
    const form = app.slice(app.indexOf(`async function ${fn}`), app.indexOf('/**', app.indexOf(`async function ${fn}`)));
    assert.match(form, /field\('alertEmail', 'Alert email', ALERT_EMAIL_HINT,/, fn);
    assert.match(form, /field\('alertPhone', 'Alert phone', ALERT_PHONE_HINT,/, fn);
    assert.match(form, /alertEmail: value\('alertEmail'\), alertPhone: value\('alertPhone'\),/, fn);
  }
  const table = app.slice(app.indexOf('async function drawProjects'), app.indexOf('/**', app.indexOf('async function drawProjects')));
  assert.doesNotMatch(table, /alertEmail|alertPhone/, 'not in the projects table');
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
  assert.match(table, /\$\{people\n\s+\? action\(`\/projects\/\$\{encodeURIComponent\(p\.slug\)\}\/edit`, 'Edit Project', ICONS\.edit\)\n\s+\+ actionButton\('Delete Project', ICONS\.delete, \{ delete: p\.slug, name: p\.name \}\)\n\s+: ''\}/);
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
  for (const id of ['name', 'url', 'logo', 'repo', 'alertEmail', 'alertPhone']) assert.match(form, new RegExp(`field\\('${id}',[^\\n]*filled\\(p\\.${id}\\)`), id);
  for (const id of ['slug', 'prefix']) assert.match(form, new RegExp(`field\\('${id}',[^\\n]* disabled\\$\\{filled\\(p\\.${id}\\)\\}`), id);
  assert.match(form, /o\.id === p\.owner\?\.id \? ' selected' : ''/);
  // The change names only what may change; never the slug or prefix.
  assert.match(form, /api\('PATCH', `\/projects\/\$\{encodeURIComponent\(p\.slug\)\}`, \{\n\s+name: value\('name'\), url: value\('url'\), logo: value\('logo'\), repo: value\('repo'\), owner: value\('owner'\) \? Number\(value\('owner'\)\) : null,\n\s+alertEmail: value\('alertEmail'\), alertPhone: value\('alertPhone'\),\n\s+\}\)/);
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

test('the Close note on Ready to launch promises the merge check the relay makes there', () => {
  const html = renderCloseAction({ status: 'ready to launch', closePhrase: 'close', comments: [{ body: moveCard('Close') }] });
  assert.match(html, /once its work is merged/);
});

test('the Close note on Needs your input says it closes on the next pass, with no merge check (the hand-back closes at once)', () => {
  const html = renderCloseAction({ status: 'needs your input', closePhrase: 'close', comments: [{ body: moveCard('Close') }] });
  assert.match(html, /on its next pass/);
  assert.doesNotMatch(html, /merged/);
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

// ── Quick Action's Go button (SP-86) ─────────────────────────────────────────

/** An intake card as loop-intake posts it: reply "go", and its move is Reply. */
function intakeCard({ needed = 'Reply "go" to queue it as written, or reply with what to change.', move = 'Reply' } = {}) {
  const sixty = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
  return machineComment.stripMachineMarker(machineComment.stampMachineComment(
    operatorCard.buildCard(`@@ASKED\nx\n@@CONTEXT\n${sixty}\n@@NEEDED\n${needed}\nYour move: ${move} — a reason.`).rendered));
}

test('Go shows only on Needs your input, under an intake card, with a go word from the server', () => {
  const comments = [{ body: intakeCard() }];
  for (const name of loopStatuses.STAGE_ORDER) {
    const status = loopStatuses.statusOf(name);
    const html = renderGoAction({ status, goPhrase: 'go', comments });
    if (status === loopStatuses.NEEDS_YOUR_INPUT) assert.match(html, /<form class="go-action">\s*<button type="submit">Go<\/button>/, name);
    else assert.equal(html, '', name);
  }
  const nyi = { status: 'needs your input', goPhrase: 'go' };
  assert.equal(renderGoAction({ ...nyi, goPhrase: null, comments }), '', 'no word, no button');
  assert.equal(renderGoAction({ ...nyi, comments: [] }), '', 'no card, no Go');
  for (const move of ['Merge', 'Close']) assert.equal(renderGoAction({ ...nyi, comments: [{ body: intakeCard({ move }) }] }), '', move);
  assert.equal(renderGoAction({ ...nyi, comments: [{ body: moveCard('Reply') }] }), '', 'a Reply card that offers no "go"');
  assert.equal(renderGoAction({ ...nyi, comments: [{ body: intakeCard({ needed: 'Reply A or B; then we go on.' }) }] }), '', 'the bare word, unquoted, is not an offer');
  assert.match(renderGoAction({ ...nyi, comments: [{ body: intakeCard({ needed: 'Reply \u201cgo\u201d to queue it.' }) }] }), /go-action/, 'curly quotes count');
  // The newest card decides: an older intake card under a newer question is spent.
  assert.equal(renderGoAction({ ...nyi, comments: [...comments, { body: moveCard('Reply') }] }), '');
  assert.doesNotMatch(renderGoAction({ ...nyi, goPhrase: '<b>', comments: [{ body: intakeCard({ needed: 'Reply "<b>".' }) }] }), /<b>/, 'the word is escaped');
  assert.equal(goQuestion({ name: 'Fix it' }), 'Send Fix it to the build queue?');
});

test('the Go button posts the substrate\'s one go word, handed to the page by the server, and the demo shows it on its intake ticket only', async () => {
  const { GO_PHRASE } = await import('./server.mjs');
  assert.equal(GO_PHRASE, busRelayPlan.GO_PHRASE);
  const f = await fixture({ goPhrase: GO_PHRASE });
  try {
    const threads = await Promise.all(f.store.listTickets('beta').map(async (t) => (await f.call('GET', `/tickets/${t.id}/thread`)).body));
    for (const t of threads) assert.equal(t.goPhrase, GO_PHRASE, t.id);
    const shown = threads.filter((t) => renderGoAction(t));
    assert.deepEqual(shown.map((t) => t.name), ['A request written up as a spec, waiting for your go']);
    assert.equal(renderGoAction(threads.find((t) => t.name === 'A question a loop asked under your token')), '');
    const posted = await f.call('POST', `/tickets/${shown[0].id}/comments`, { body: { body: GO_PHRASE } });
    assert.equal(posted.status, 201);
    const stored = f.store.listComments(shown[0].id).at(-1);
    assert.deepEqual([stored.body, stored.author], [GO_PHRASE, f.operator.id]);
  } finally { await f.cleanup(); }
  const none = await fixture();
  try {
    assert.equal((await none.call('GET', '/tickets/AL-1/thread')).body.goPhrase, null, 'no word: no button');
  } finally { await none.cleanup(); }
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(app, /wordButton\('form\.go-action', goQuestion\(t\), t\.goPhrase,/);
  assert.match(app, /\$\{renderCloseAction\(t\)\}\s*\$\{renderGoAction\(t\)\}\s*<form class="reply">/, 'Go sits between Close and the reply box');
});

test('no go word is written into the page\'s code, and the Go button has the Merge look with 10px corners', () => {
  const code = (name) => readFileSync(WEB(name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const name of ['app.mjs', 'render.mjs', 'index.html']) {
    assert.doesNotMatch(code(name), new RegExp(`['"\`]${busRelayPlan.GO_PHRASE}['"\`]`, 'i'), name);
  }
  const rules = code('app.css').split('}').map((r) => r.split('{')).filter((r) => r.length === 2)
    .map(([sel, body]) => ({ sel: sel.split(',').map((x) => x.trim()), body }));
  // One rule draws Merge's weight and padding, and Go is in it; the green comes from `.quick button`, which both share.
  const shared = rules.filter((r) => r.sel.includes('.quick form.merge-action button'));
  assert.ok(shared.length && shared.every((r) => r.sel.includes('.quick form.go-action button')), 'Go has every Merge button rule');
  assert.ok(rules.some((r) => r.sel.includes('.quick button') && /background: #00AA00/i.test(r.body)), 'the Merge colour');
  assert.ok(rules.some((r) => r.sel.length === 1 && r.sel[0] === '.quick form.go-action button' && /border-radius: 10px/.test(r.body)), '10px corners of its own');
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
  const draw = /\nasync function drawTicket\(id(?:, said = null(?:, kept = null)?)?\) \{[\s\S]*?\n\}\n/.exec(app)?.[0] ?? '';
  assert.match(draw, /const wordButton = [\s\S]*wordButton\('form\.merge-action'[\s\S]*wordButton\('form\.close-action'/);
  assert.equal(app.match(/const wordButton = /g).length, 1);
  assert.match(app, /<div class="act">\s*(?:\$\{renderCommands\(t\)\}\s*)?\$\{renderAnswerIn\(t\)\}\s*\$\{renderMergeAction\(t\)\}\s*\$\{renderCloseAction\(t\)\}\s*\$\{renderGoAction\(t\)\}\s*<form class="reply">/, 'the answer-is-in line, then Merge, Close and Go, sit above the reply box on the right');
});

test('after a reply, Merge, Close or Go posts, the page stays at the top and a confirmation box opens; a failed post opens none', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const html = readFileSync(WEB('index.html'), 'utf8');
  const css = readFileSync(WEB('app.css'), 'utf8');
  // The box: the browser's own <dialog>, closed by its OK button (Escape closes a modal dialog by itself).
  assert.match(html, /<dialog id="posted"[^>]*>\s*<form method="dialog">\s*<p id="posted-text">Your reply was posted\.<\/p>\s*<button type="submit">OK<\/button>/);
  assert.match(css, /^dialog#posted \{/m);
  // One helper: Details open, the page at the top, the box shown as a modal.
  const helper = /const showPosted = \(\) => \{([\s\S]*?)\n  \};/.exec(app)?.[1];
  assert.ok(helper, 'one shared helper');
  assert.match(helper, /details\.details'\)\.open = true;\s*window\.scrollTo\(0, 0\);\s*if \(!posted\.open\) posted\.showModal\(\);/);
  // Nothing scrolls to the last comment any more.
  assert.doesNotMatch(app, /\.comment:last-of-type/);
  // The reply box and the word buttons both call it after the redraw, inside the try, so a failure never does.
  const word = /const wordButton = \(selector, question, word, signedOut\) => \{([\s\S]*?)\n  \};/.exec(app)?.[1];
  const reply = /\{ body: box\.value \}\);([\s\S]*?)\n  \}\);\n\}/.exec(app)?.[1];
  for (const [name, body] of [['word buttons', word], ['reply box', reply]]) {
    assert.ok(body, name);
    assert.match(body, /await drawAgain\(\(\) => drawTicket\(t\.id\)\);\s*showPosted\(\);\s*\} catch \(err\) \{/, name);
    assert.doesNotMatch(body.split('catch (err)')[1], /showPosted/, `${name}: no box on failure`);
  }
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
  assert.match(app, /canDelete\(status\) \? actionButton\('Delete Ticket', ICONS\.delete, \{ delete: t\.id \}\) : ''/);
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
  assert.match(listHandler, /\}\s*await drawAgain\(\(\) => drawProject\(slug, view\)\);$/, 'only a delete that succeeded redraws the list');
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

test('the set-password page is served without a token, drawn before any sign-in, and sends the link only in a body', async () => {
  const f = await fixture();
  try {
    const r = await f.call('GET', '/set-password?link=anything', { token: null });
    assert.equal(r.status, 200);
    assert.equal(r.text, readFileSync(WEB('index.html'), 'utf8'));
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  } finally { await f.cleanup(); }
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  // The emailed link's page comes before GET /me, so nobody has to be signed in.
  assert.ok(app.indexOf("location.pathname === '/set-password'") < app.indexOf("me = await api('GET', '/me')"));
  assert.match(app, /linkCall\('\/account\/link', \{ link \}\)/);
  assert.match(app, /linkCall\('\/account\/set-password', \{ link, password: typed\.password/);
  assert.doesNotMatch(app, /fetch\(`[^`]*\$\{link\}/, 'the link never goes into an address the page fetches');
});

test('the set-password form shows the email read-only, two password boxes, a name box only for an invite, and escapes the email', () => {
  const setup = renderSetPassword({ purpose: 'setup', email: 'dane@example.com' });
  assert.match(setup, /<input id="email" type="email" value="dane@example\.com" readonly/);
  assert.equal((setup.match(/type="password"/g) ?? []).length, 2);
  assert.doesNotMatch(setup, /id="name"/);
  assert.match(renderSetPassword({ purpose: 'invite', email: 'new@example.com' }), /<input id="name" type="text"/);
  assert.match(renderSetPassword({ purpose: 'setup', email: '"><script>x</script>' }), /value="&quot;&gt;&lt;script&gt;x&lt;\/script&gt;"/);
  assert.match(renderPasswordSet('http://tracker.example:4180'), /Password set\. Sign in at <a href="\/">http:\/\/tracker\.example:4180<\/a>\./);
});

test('a used, expired or unknown link says which in plain words; a form with a short, unmatched or nameless password says why before sending', () => {
  assert.match(linkProblem('used-link'), /already been used/);
  assert.match(linkProblem('expired-link'), /expired/);
  assert.match(linkProblem('unknown-link'), /not one the tracker made/);
  for (const code of ['used-link', 'expired-link', 'unknown-link']) assert.match(linkProblem(code), /Nothing was changed\./);
  assert.equal(linkProblem('weak-password'), null);
  assert.equal(MIN_PASSWORD, 12);
  const good = 'twelve chars';
  assert.equal(passwordProblem({ purpose: 'setup', password: good, confirm: good }), null);
  assert.match(passwordProblem({ purpose: 'setup', password: 'eleven char', confirm: 'eleven char' }), /at least 12/);
  assert.match(passwordProblem({ purpose: 'setup', password: good, confirm: 'twelve charz' }), /not the same/);
  assert.match(passwordProblem({ purpose: 'invite', name: '  ', password: good, confirm: good }), /your name/);
  assert.equal(passwordProblem({ purpose: 'invite', name: 'New', password: good, confirm: good }), null);
});

test('the Change panel offers the server\'s priorities and person statuses, keeps the current status in view, and names the operator from the ticket', () => {
  const choices = { priorities: ['urgent', 'high', 'normal', 'low'], statuses: ['requested', 'rework', 'queued', 'live'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })) };
  const operator = { id: 7, name: 'Pat <b>' };
  const html = renderEditPanel({ name: 'A <name>', description: 'Line', status: 'in review', priority: 'high', tags: ['x"y'], assignee: operator, operator, pullRequest: null, choices });
  const statusSelect = /<select id="edit-status"[^>]*>([\s\S]*?)<\/select>/.exec(html)[1];
  const labels = [...statusSelect.matchAll(/>([^<]+)<\/option>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['In review (now)', 'Requested', 'Rework', 'Queued', 'Live']);
  assert.match(statusSelect, /<option value="in review" selected>/);
  for (const never of ['Needs your input', 'Ready to launch', 'Building']) assert.ok(!statusSelect.includes(never), never);
  // A status a person may choose is not doubled.
  const queued = renderEditPanel({ name: 'n', status: 'queued', choices });
  assert.equal(/<select id="edit-status"[^>]*>([\s\S]*?)<\/select>/.exec(queued)[1].match(/<option/g).length, 4);
  assert.match(html, /<option value="high" selected>High<\/option>/);
  assert.match(html, /<option value="7" selected>Pat &lt;b&gt;<\/option><option value="">Nobody<\/option>/);
  assert.match(html, /value="A &lt;name&gt;"/);
  assert.match(html, /data-tag="x&quot;y"/);
  assert.match(html, /<details class="edit" open>/);
  // No priority yet: "None" shows and is chosen; nobody assigned: Nobody is chosen.
  const bare = renderEditPanel({ name: 'n', status: 'queued', priority: null, assignee: null, operator, choices });
  assert.match(bare, /<option value="" selected>None<\/option>/);
  assert.match(bare, /<option value="" selected>Nobody<\/option>/);
});

test('the name is locked, with the reason, once a pull request is recorded', () => {
  const open = renderEditPanel({ name: 'n', status: 'queued', pullRequest: null });
  assert.match(open, /<input id="edit-name" type="text" value="n" required>/);
  const locked = renderEditPanel({ name: 'n', status: 'in review', pullRequest: 'https://github.com/o/r/pull/3' });
  assert.ok(!/<input id="edit-name"/.test(locked));
  assert.match(locked, /a pull request is recorded, and its title must match the name exactly/);
});

test('every Change panel field saves through the API and reads back; a stale version gets 409 and overwrites nothing; a refusal keeps nothing half-written', async () => {
  const f = await fixture();
  try {
    const queued = f.store.listTickets('alpha', { status: 'queued' })[0];
    const thread = (await f.call('GET', `/tickets/${queued.id}/thread`)).body;
    assert.deepEqual(thread.operator, { id: f.operator.id, name: 'Dane' });
    let version = thread.version;
    const change = async (body) => {
      const r = await f.call('PATCH', `/tickets/${queued.id}`, { body: { ...body, ifVersion: version } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const back = (await f.call('GET', `/tickets/${queued.id}/thread`)).body;
      version = back.version;
      return back;
    };
    assert.equal((await change({ priority: 'low' })).priority, 'low');
    assert.deepEqual((await change({ tags: [...thread.tags, 'try-me'] })).tags, [...thread.tags, 'try-me']);
    assert.deepEqual((await change({ tags: thread.tags })).tags, thread.tags);
    assert.equal((await change({ assignee: null })).assignee, null);
    assert.equal((await change({ assignee: f.operator.id })).assignee.name, 'Dane');
    assert.equal((await change({ status: 'rework' })).status, 'rework');
    assert.equal((await change({ name: 'A new name' })).name, 'A new name');
    assert.equal((await change({ description: 'One\n\nTwo' })).description, 'One\n\nTwo');
    // A loop moves it; the page's next save carries the old version.
    f.store.changeTicket(queued.id, { actor: f.loop.id, loopNote: 'a loop was here' });
    const stale = await f.call('PATCH', `/tickets/${queued.id}`, { body: { priority: 'urgent', ifVersion: version } });
    assert.equal(stale.status, 409);
    assert.equal(f.store.getTicket(queued.id).priority, 'low', 'nothing was overwritten');
    // A refusal says why.
    const refused = await f.call('PATCH', `/tickets/${queued.id}`, { body: { name: '', ifVersion: version + 1 } });
    assert.equal(refused.status, 400);
    assert.ok(refused.body.message);
    assert.equal(f.store.getTicket(queued.id).name, 'A new name');
  } finally { await f.cleanup(); }
});

test('the page sends each change with ifVersion, redraws from the server after a save, says "has moved" without retrying, and keeps typed text on a refusal', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const wire = /function wireEditPanel\(t\) \{([\s\S]*?)\n\}/.exec(app)?.[1];
  assert.ok(wire, 'the panel has its wiring');
  assert.equal(wire.match(/api\('PATCH'/g).length, 1, 'one save path for every field');
  assert.match(wire, /api\('PATCH', `\/tickets\/\$\{encodeURIComponent\(t\.id\)\}`, \{ \[field\]: value, ifVersion: t\.version \}\)/);
  assert.match(wire, /err\.status === 409\) return redraw\(\{ text: MOVED_MESSAGE, error: true \}, typed\(\), note, /);
  assert.match(wire, /note\.textContent = `Not saved: \$\{err\.message\}`;\s*for \(const c of held\) c\.disabled = false;\s*saving = false;\s*return;/, 'a refusal shows the reason, redraws nothing and frees the panel');
  assert.match(wire, /await redraw\(\{ field, text: 'Saved' \}, typed\(field\), note, /);
  assert.match(wire, /await drawAgain\(\(\) => drawTicket\(t\.id, said, kept\)\);/, 'the one redraw, carrying what was typed');
  assert.match(app, /\$\{me\?\.kind === 'human' \? renderEditPanel\(t\) : ''\}\s*<section class="description">/, 'a person only, above the description');
  assert.match(MOVED_MESSAGE, /nothing was overwritten/);
  // Nothing project-specific: no operator name, priority or status list written into the page.
  for (const literal of ["'Dane'", "'urgent'", "'needs your input'", "'ready to launch'"]) assert.ok(!wire.includes(literal), literal);
});

test('a save holds the whole panel until it answers, so two quick changes never share one version', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const wire = /function wireEditPanel\(t\) \{([\s\S]*?)\n\}/.exec(app)?.[1];
  const save = wire.slice(wire.indexOf('const save = async'), wire.indexOf("for (const select of"));
  assert.match(save, /if \(saving\) return;\s*saving = true;/, 'a second save while one is in flight does nothing');
  assert.match(save, /panel\.querySelectorAll\('input, select, textarea, button'\)/, 'every control in the panel is held, not just the one changed');
  // The flag only comes back down on a refusal; after a save the panel is drawn anew.
  assert.equal(save.match(/saving = false/g).length, 1);
});

test('a save carries over what is typed elsewhere on the page: the reply box, an open description edit, an unsaved name or tag', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const wire = /function wireEditPanel\(t\) \{([\s\S]*?)\n\}/.exec(app)?.[1];
  const typed = wire.slice(wire.indexOf('const typed ='), wire.indexOf('const redraw ='));
  assert.match(typed, /reply: main\.querySelector\('form\.reply textarea'\)\?\.value/);
  assert.match(typed, /description: field !== 'description' && !editor\.hidden \? area\.value : null/, 'an open edit is kept unless it is what was saved');
  assert.match(typed, /name: field !== 'name' && nameBox && nameBox\.value !== t\.name \? nameBox\.value : null/);
  assert.match(typed, /tag: field === 'tags' \? '' : tagBox\.value/);
  const draw = /\nasync function drawTicket\(id, said = null, kept = null\) \{[\s\S]*?\n\}\n/.exec(app)?.[0] ?? '';
  assert.match(draw, /const panel = wireEditPanel\(t\);\s*if \(kept\) \{\s*main\.querySelector\('form\.reply textarea'\)\.value = kept\.reply;\s*panel\?\.restore\(kept\);/);
  assert.match(wire, /restore\(kept\) \{[\s\S]*area\.value = kept\.description;\s*openEditor\(\);/, 'the description edit opens again with its text');
});

test('a save whose redraw fails says what happened instead of sitting on "Saving…"', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const wire = /function wireEditPanel\(t\) \{([\s\S]*?)\n\}/.exec(app)?.[1];
  const redraw = wire.slice(wire.indexOf('const redraw ='), wire.indexOf('let saving'));
  assert.match(redraw, /try \{\s*await drawAgain\(\(\) => drawTicket\(t\.id, said, kept\)\);\s*\} catch \(err\) \{/);
  assert.match(redraw, /if \(err instanceof SignedOut\) return drawSignIn\(/);
  assert.match(redraw, /note\.textContent = `The page could not refresh \(\$\{err\.message\}\): \$\{outcome\}\. Reload to see the ticket as stored\.`/);
  assert.match(wire, /`the \$\{field\} was saved`/);
  assert.match(wire, /`the \$\{field\} was not saved`/);
});

test('the sign-in form is an email and a password with "Forgot password?"; the page keeps no token and signs in and out at the server', () => {
  const form = renderSignIn();
  assert.match(form, /<input id="email" type="email" autocomplete="username" required>/);
  assert.match(form, /<input id="password" type="password" autocomplete="current-password" required>/);
  assert.match(form, /<button type="button" class="link forgot">Forgot Password\?<\/button>/);
  assert.doesNotMatch(form, /token/i);
  assert.match(renderSignIn('<b>no</b>'), /<p class="note error">&lt;b&gt;no&lt;\/b&gt;<\/p>/);
  const forgot = renderForgot('a"b@example.com');
  assert.match(forgot, /value="a&quot;b@example\.com"/);
  assert.match(forgot, /works for 1 hour/);
  assert.match(forgot, /<a href="\/">Back to Sign In<\/a>/);

  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.doesNotMatch(app, /authorization|Bearer/, 'the page never sends a token');
  assert.doesNotMatch(app, /localStorage\.(?:setItem|getItem)\(OLD_TOKEN_KEY/, 'the old token is never kept or read');
  assert.match(app, /localStorage\.removeItem\(OLD_TOKEN_KEY\)/, 'an old pasted token is cleared');
  assert.match(app, /linkCall\('\/signin', \{ email: [^,]+, password: /);
  assert.match(app, /linkCall\('\/signout', \{\}\)/);
  assert.match(app, /linkCall\('\/account\/forgot', \{ email: /);
  // Every write the page makes says it is JSON, which the server requires of a cookie's writes.
  assert.match(app, /headers: write \? \{ 'content-type': 'application\/json' \} : \{\}/);
});

test('the demo tracker prints an email and a password to sign in with, never a token', () => {
  const demo = readFileSync(fileURLToPath(new URL('./demo.mjs', import.meta.url)), 'utf8');
  assert.match(demo, /store\.setEmail\(operator\.id, DEMO_EMAIL\)/);
  assert.match(demo, /store\.setPassword\(operator\.id, password\)/);
  assert.match(demo, /email: {4}\$\{DEMO_EMAIL\}\\n {2}password: \$\{password\}/);
  assert.doesNotMatch(demo, /throwaway token/);
});

// ── Reporting ────────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60_000;

/** A fresh store whose clock the test sets, one project and a loop to move tickets. */
function reportingStore() {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-reports-'));
  const clock = tickingClock();
  const store = openStore(join(dir, 'tracker.db'), { now: clock });
  const loop = store.createActor({ kind: 'machine', name: 'Loop' });
  store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL' });
  store.createProject({ slug: 'beta', name: 'Beta', prefix: 'BE' });
  const now = Date.parse('2026-10-27T15:00:00Z');
  /** File a ticket in `status` `filedDaysAgo` before `now`; each later [days, status] moves it then. */
  const filedAs = (status, project, filedDaysAgo, ...moves) => {
    clock.moveTo(now - filedDaysAgo * DAY);
    const { id } = store.fileTicket({ project, actor: loop.id, name: `filed ${filedDaysAgo} days ago`, status });
    for (const [days, to] of moves) {
      clock.moveTo(now - days * DAY);
      store.changeTicket(id, { actor: loop.id, status: to });
    }
    return id;
  };
  const ticket = (...args) => filedAs('queued', ...args);
  const done = () => { store.close(); rmSync(dir, { recursive: true, force: true }); };
  return { store, loop, ticket, filedAs, now, done };
}

test('Reporting: a task finished 3 days ago counts in all three ranges, 20 days ago in two, 60 days ago only in all time', () => {
  const r = reportingStore();
  try {
    r.ticket('alpha', 70, [3, 'live']);
    r.ticket('alpha', 70, [20, 'live']);
    r.ticket('alpha', 70, [60, 'live']);
    assert.deepEqual(reportsOf(r.store, { now: r.now }).finished, { week: 1, month: 2, all: 3 });
    for (const [days, expected] of [[3, { week: 1, month: 1, all: 1 }], [20, { week: 0, month: 1, all: 1 }], [60, { week: 0, month: 0, all: 1 }]]) {
      const one = reportingStore();
      try {
        one.ticket('alpha', 70, [days, 'live']);
        assert.deepEqual(reportsOf(one.store, { now: one.now }).finished, expected, `${days} days ago`);
      } finally { one.done(); }
    }
  } finally { r.done(); }
});

test('Reporting: a task moved to Live and back out counts nowhere; moved to Live twice, once, at its latest move', () => {
  const r = reportingStore();
  try {
    r.ticket('alpha', 70, [40, 'live'], [35, 'rework']);
    r.ticket('alpha', 70, [40, 'live'], [35, 'rework'], [2, 'live']);
    assert.deepEqual(reportsOf(r.store, { now: r.now }).finished, { week: 1, month: 1, all: 1 });
  } finally { r.done(); }
});

test('Reporting: tasks started are those filed in each range; a task filed already Live counts as finished then', () => {
  const r = reportingStore();
  try {
    r.ticket('alpha', 2);
    r.ticket('alpha', 15);
    r.ticket('beta', 90);
    const born = r.store.fileTicket({ project: 'beta', actor: r.loop.id, name: 'filed already Live', status: 'live' });
    // The clock last stood 90 days back, so that is when it was filed, and finished.
    const back = reportsOf(r.store, { now: Date.parse(born.createdAt) + DAY });
    assert.deepEqual(back.finished, { week: 1, month: 1, all: 1 });
    assert.deepEqual(reportsOf(r.store, { now: r.now }).started, { week: 1, month: 2, all: 4 });
  } finally { r.done(); }
});

test('Reporting: one project or all of them; an unknown project is null; open counts every stage but Live, in STAGE_ORDER, with its colour', () => {
  const r = reportingStore();
  try {
    r.ticket('alpha', 5, [4, 'building']);
    r.ticket('alpha', 5);
    r.ticket('beta', 5);
    r.ticket('beta', 5, [1, 'live']);
    r.store.setStageColours({ Queued: '#2b9cf2' });
    const all = reportsOf(r.store, { now: r.now });
    assert.equal(all.project, null);
    assert.deepEqual(all.ranges, REPORT_RANGES.map(({ key, label }) => ({ key, label })));
    const stages = loopStatuses.STAGE_ORDER.filter((s) => s !== 'Live');
    assert.deepEqual(all.open.map((s) => s.status), stages);
    const count = (rep, s) => rep.open.find((o) => o.status === s).count;
    assert.equal(count(all, 'Queued'), 2);
    assert.equal(count(all, 'Building'), 1);
    assert.equal(all.open.find((o) => o.status === 'Queued').colour, '#2b9cf2');
    assert.equal(all.open.find((o) => o.status === 'Building').colour, null);
    const beta = reportsOf(r.store, { project: 'beta', now: r.now });
    assert.equal(beta.project, 'beta');
    assert.equal(beta.projectName, 'Beta');
    assert.equal(count(beta, 'Queued'), 1);
    assert.equal(count(beta, 'Building'), 0);
    assert.deepEqual(beta.finished, { week: 1, month: 1, all: 1 });
    assert.equal(reportsOf(r.store, { project: 'no-such-thing' }), null);
  } finally { r.done(); }
});

test('Reporting is in the header after Tasks, served at /reporting, and its figures need a sign-in; the demo holds finished tasks', async () => {
  const html = readFileSync(WEB('index.html'), 'utf8');
  assert.match(html, /<a href="\/tasks" data-nav="tasks">Tasks<\/a>\s*<a href="\/reporting" data-nav="reporting">Reporting<\/a>/);
  const f = await fixture();
  try {
    const page = await f.call('GET', '/reporting', { token: null });
    assert.equal(page.status, 200);
    assert.equal(page.text, html);
    assert.equal((await f.call('GET', '/reports', { token: null })).status, 401);
    assert.equal((await f.call('GET', '/reports?project=alpha', { token: null })).status, 401);
    const all = await f.call('GET', '/reports');
    assert.equal(all.status, 200);
    // The board's Live column is what "all time" finished counts.
    const live = (slug) => f.store.listTickets(slug, { status: 'live' }).length;
    assert.equal(all.body.finished.all, live('alpha') + live('beta'));
    assert.ok(all.body.finished.all >= 7, 'the demo files finished tasks over the last month');
    const alpha = await f.call('GET', '/reports?project=alpha');
    assert.equal(alpha.body.project, 'alpha');
    assert.equal(alpha.body.finished.all, live('alpha'));
    assert.equal((await f.call('GET', '/reports?project=no-such-thing')).status, 404);
  } finally { await f.cleanup(); }
});

/** True when `ms` is within ten minutes of `days` days: the test clock ticks a minute per reading. */
const near = (ms, days) => ms != null && Math.abs(ms - days * DAY) < 10 * 60_000;

test('Reporting flow: time to finish, sent back and waiting, from known status changes; a task sent back twice counts once; one never Queued is left out', () => {
  const r = reportingStore();
  try {
    // Sent back twice; 9 days from Queued to Live; a day in Ready to launch.
    r.ticket('alpha', 10, [9, 'building'], [8, 'in review'], [7, 'rework'], [6, 'building'], [5, 'in review'],
      [4.5, 'rework'], [4, 'building'], [3, 'in review'], [2, 'ready to launch'], [1, 'live']);
    // 3.5 days from Queued to Live; a day in Needs your input, half a day in Ready to launch.
    r.ticket('beta', 5, [4, 'needs your input'], [3, 'building'], [2, 'ready to launch'], [1.5, 'live']);
    // Filed straight into review, never Queued: left out of time to finish; half a day waiting.
    r.filedAs('in review', 'alpha', 3, [2.5, 'ready to launch'], [2, 'live']);
    // Finished 20 days ago, 5 days from Queued; never waited.
    r.ticket('alpha', 25, [21, 'in review'], [20, 'live']);
    // Still open: counts nowhere in flow; the two in the operator's stages are waiting now.
    r.ticket('alpha', 3, [2, 'building']);
    r.ticket('alpha', 3, [1, 'needs your input']);
    r.ticket('beta', 3, [1, 'ready to launch']);
    const { flow, waitingNow } = reportsOf(r.store, { now: r.now });
    assert.equal(waitingNow, 2);

    const week = flow.week;
    assert.equal(week.finished, 3);
    assert.equal(week.timeToFinish.counted, 2);
    assert.equal(week.timeToFinish.leftOut, 1);
    assert.ok(near(week.timeToFinish.median, (9 + 3.5) / 2), String(week.timeToFinish.median / DAY));
    assert.ok(near(week.timeToFinish.longest, 9));
    assert.deepEqual(week.sentBack, { count: 1, share: 1 / 3 });
    assert.ok(near(week.waiting.total, 1 + 1.5 + 0.5), String(week.waiting.total / DAY));
    assert.ok(near(week.waiting.median, 1));

    const month = flow.month;
    assert.equal(month.finished, 4);
    assert.equal(month.timeToFinish.counted, 3);
    assert.ok(near(month.timeToFinish.median, 5));
    assert.ok(near(month.timeToFinish.longest, 9));
    assert.deepEqual(month.sentBack, { count: 1, share: 1 / 4 });
    assert.ok(near(month.waiting.total, 3));
    assert.ok(near(month.waiting.median, (0.5 + 1) / 2));
    assert.deepEqual(flow.all, month);

    const beta = reportsOf(r.store, { project: 'beta', now: r.now });
    assert.equal(beta.flow.all.finished, 1);
    assert.equal(beta.flow.all.sentBack.count, 0);
    assert.equal(beta.waitingNow, 1);
  } finally { r.done(); }
});

test('Reporting flow: a range with no finished tasks has no times and no share, never a zero', () => {
  const r = reportingStore();
  try {
    r.ticket('alpha', 70, [65, 'rework'], [60, 'live']);
    const { flow } = reportsOf(r.store, { now: r.now });
    assert.deepEqual(flow.week, {
      finished: 0,
      timeToFinish: { counted: 0, leftOut: 0, median: null, longest: null },
      sentBack: { count: 0, share: null },
      waiting: { total: null, median: null },
    });
    assert.deepEqual(flow.month, flow.week);
    assert.equal(flow.all.finished, 1);
    assert.deepEqual(flow.all.sentBack, { count: 1, share: 1 });
    assert.ok(near(flow.all.timeToFinish.median, 10));
  } finally { r.done(); }
});

test('Reporting human hours: the estimates of the tasks finished in each range added up, a task with none counted as not estimated, per day to one decimal', () => {
  const r = reportingStore();
  try {
    let pr = 10;
    const estimate = (id, hours) => r.store.postComment({
      ticket: id, author: r.loop.id, body: prOpenedComment(`https://github.com/o/r/pull/${pr++}`, 'Why that estimate: a test.', { humanHours: hours }),
    });
    estimate(r.ticket('alpha', 5, [2, 'live']), 6);
    estimate(r.ticket('alpha', 5, [3, 'live']), 2.5);
    // Finished this week with a pull request but no estimate on it, and one with no pull request at all.
    const bare = r.ticket('beta', 5, [4, 'live']);
    r.store.postComment({ ticket: bare, author: r.loop.id, body: 'PR opened: https://github.com/o/r/pull/3' });
    // Re-recorded on rework: only the newest PR opened line counts.
    const reworked = r.ticket('alpha', 30, [20, 'live']);
    estimate(reworked, 3);
    estimate(reworked, 10);
    estimate(r.ticket('alpha', 70, [60, 'live']), 4);
    // Still open: counts nowhere, estimate or not.
    estimate(r.ticket('alpha', 5, [1, 'building']), 50);

    const { humanHours } = reportsOf(r.store, { now: r.now });
    assert.deepEqual(humanHours.week, { finished: 3, estimated: 2, notEstimated: 1, hours: 8.5, days: 7, perDay: 1.2 });
    assert.deepEqual(humanHours.month, { finished: 4, estimated: 3, notEstimated: 1, hours: 18.5, days: 30, perDay: 0.6 });
    // All time runs from the first ticket filed, 70 days back.
    assert.deepEqual(humanHours.all, { finished: 5, estimated: 4, notEstimated: 1, hours: 22.5, days: 70, perDay: 0.3 });

    const beta = reportsOf(r.store, { project: 'beta', now: r.now }).humanHours;
    assert.deepEqual(beta.week, { finished: 1, estimated: 0, notEstimated: 1, hours: null, days: 7, perDay: null });
  } finally { r.done(); }
});

test('Reporting human hours: a range with no estimates has no total and no per-day figure, never 0 hours', () => {
  const r = reportingStore();
  try {
    r.ticket('alpha', 70, [60, 'live']);
    const { humanHours } = reportsOf(r.store, { now: r.now });
    assert.deepEqual(humanHours.week, { finished: 0, estimated: 0, notEstimated: 0, hours: null, days: 7, perDay: null });
    assert.deepEqual(humanHours.all, { finished: 1, estimated: 0, notEstimated: 1, hours: null, days: 70, perDay: null });
  } finally { r.done(); }
});

test('the demo spreads its finished tasks over the last month, so every range has some', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-demo-reports-'));
  const clock = tickingClock();
  const store = openStore(join(dir, 'tracker.db'), { now: clock });
  try {
    seedDemo(store, { operatorName: 'Dane', clock });
    const { finished, flow, waitingNow } = reportsOf(store, { now: clock.time() });
    assert.ok(finished.week > 0 && finished.month > finished.week && finished.all > finished.month, JSON.stringify(finished));
    // Every flow report shows a figure in every range. All time leaves two out,
    // never Queued: the oldest, filed into review, and one filed already Live.
    for (const key of ['week', 'month', 'all']) {
      const f = flow[key];
      assert.ok(f.timeToFinish.median > 0 && f.timeToFinish.longest >= f.timeToFinish.median, `${key} ${JSON.stringify(f)}`);
      assert.ok(f.sentBack.count > 0, `${key} sent back`);
      assert.ok(f.waiting.total > 0 && f.waiting.median > 0, `${key} waiting`);
    }
    assert.equal(flow.all.timeToFinish.leftOut, 2);
    assert.ok(waitingNow > 0);
    // Human hours show a total in every range, beside a task with none.
    const { humanHours } = reportsOf(store, { now: clock.time() });
    for (const key of ['week', 'month', 'all']) {
      const h = humanHours[key];
      assert.ok(h.hours > 0 && h.perDay > 0 && h.notEstimated > 0, `${key} ${JSON.stringify(h)}`);
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the Reporting page draws only the server\'s figures: ranges and stages from its answer, colours as properties, the selected project first', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('async function drawReporting'), app.indexOf('/**\n * The Settings page'));
  assert.ok(draw.length > 0);
  assert.match(draw, /api\('GET', `\/reports\$\{slug \? `\?project=\$\{encodeURIComponent\(slug\)\}` : ''\}`\)/);
  assert.match(draw, /r\.ranges\.map/);
  assert.match(draw, /r\.open\.map/);
  assert.match(draw, /savedProject\(\)/, 'it opens on the selected project');
  assert.match(draw, /<option value="">All projects<\/option>/);
  assert.doesNotMatch(draw, /'Queued'|'Requested'|'Building'|'Live'/, 'the stages come from the server, never typed out');
  assert.match(draw, /el\.style\.setProperty\('--stage-border', look\.border\);/);
  assert.match(draw, /escapeHtml\(s\.status\)/);
  for (const title of ['Time to Finish', 'Sent Back', 'Waiting on You']) assert.match(draw, new RegExp(`flow\\('${title}',\\s*'[^']+'`), `${title} has its how-it-is-counted line`);
  assert.match(draw, /r\.flow\[g\.key\]/, 'flow figures per range, from the server');
  assert.match(draw, /<h2>Human Hours of Work Done<\/h2>\s*<p class="quiet">[^<]*estimate, not a measurement/, 'the human-hours report says where its number comes from');
  assert.match(draw, /r\.humanHours\[g\.key\]/, 'human-hours figures per range, from the server');
  assert.match(draw, /h\.estimated \? escapeHtml\(cell\(h\)\) : '<span class="quiet">no estimates yet in this range<\/span>'/, 'no estimates is said in words, never 0 hours');
  assert.match(draw, /of \$\{Number\(h\.finished\)\} estimated/);
  assert.match(draw, /about \$\{Number\(h\.perDay\)\} human hour/);
  assert.match(draw, /f\.finished \? .* : '<span class="quiet">none finished in this range<\/span>'/);
  assert.match(draw, /r\.waitingNow/);
  assert.match(app, /markNav\(reporting \? 'reporting' :/);
  assert.match(app, /if \(reporting\) \{\s*await drawReporting\(\);/);
});

test('every button on a ticket\'s page is green with a darker border and rounded corners; other pages keep theirs', () => {
  const css = readFileSync(WEB('app.css'), 'utf8');
  const rule = /^\.quick button, details\.details form\.copy button, details\.edit button:not\(\.remove-tag\) \{([^}]*)\}/m.exec(css);
  assert.ok(rule, 'one rule covers Copy, Merge, Close, Post reply, Delete, the Change panel and the Details Copy');
  for (const part of ['background: #00AA00;', 'border: 1px solid #006600;', 'border-radius: 10px;', 'color: #fff;']) assert.ok(rule[1].includes(part), part);
  // Delete no longer overrides the green with its old red outline.
  assert.doesNotMatch(css, /\.quick form\.delete-action button \{/);
  // Scoped to the ticket page: the plain button rule every other page uses is untouched.
  assert.match(css, /^button \{ font: inherit; padding: 0\.4rem 1rem; \}$/m);
  assert.doesNotMatch(css, /^button \{[^}]*#00AA00/m);
});

// ── Users ────────────────────────────────────────────────────────────────────

test('Users is in the header before Settings, served at /users to a browser, and its data needs a sign-in', async () => {
  const html = readFileSync(WEB('index.html'), 'utf8');
  assert.match(html, /<a href="\/users" data-nav="users">Users<\/a>\s*<a href="\/settings" data-nav="settings">Settings<\/a>/);
  assert.doesNotMatch(html, />People</);
  const f = await fixture();
  try {
    const page = await fetch(`${f.url}/users`, { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), html);
    assert.equal((await f.call('GET', '/people', { token: null })).status, 401);
  } finally { await f.cleanup(); }
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(app, /usersPage \? 'users' :/);
  assert.match(app, /\} else if \(usersPage\) \{\s*await drawUsers\(\);/);
});

test('a browser opening /people (an old bookmark) is sent on to /users, never cached; the data call to /people still answers the data', async () => {
  const f = await fixture();
  try {
    const old = await fetch(`${f.url}/people?x=1`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    assert.equal(old.status, 302);
    assert.equal(old.headers.get('location'), '/users?x=1');
    assert.equal(old.headers.get('cache-control'), 'no-store');
    assert.match(old.headers.get('vary') ?? '', /accept/i);
    const followed = await fetch(`${f.url}/people`, { headers: { accept: 'text/html' } });
    assert.equal(followed.status, 200);
    assert.equal(new URL(followed.url).pathname, '/users');
    // The page's own call (and the onboarding scripts') asks for anything, not HTML: it gets the data.
    const data = await f.call('GET', '/people');
    assert.equal(data.status, 200);
    assert.ok(Array.isArray(data.body.people));
    // /users is a page only: it holds no data of its own.
    const users = await fetch(`${f.url}/users`);
    assert.match(users.headers.get('content-type'), /text\/html/);
  } finally { await f.cleanup(); }
});

test('the Users page escapes every name and email, offers the form and Cancel to a person only, and reads back before saying it worked', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('async function drawUsers'), app.indexOf('/** Underline the header link'));
  assert.ok(draw.length > 100);
  for (const field of ['p.name', 'p.email', 'i.email', 'i.invitedBy.name']) assert.match(draw, new RegExp(`escapeHtml\\(${field.replace('.', '\\.')}\\)`), field);
  assert.match(draw, /\$\{person \? `<form class="invite">/);
  assert.match(draw, /\$\{person \? `<button type="button" data-cancel=/);
  assert.match(draw, /api\('POST', '\/invites', \{ email \}\)/);
  assert.match(draw, /api\('DELETE', `\/invites\/\$\{encodeURIComponent\(id\)\}`\)/);
  // Each write is read back with GET /people before the page says it worked.
  assert.equal(draw.match(/await api\('GET', '\/people'\)\.catch/g).length, 2);
  assert.match(draw, /putTrail\(\[\{ label: 'Users' \}\]\)/);
  assert.match(draw, /setTitle\('Users · Tracker'\)/);
  assert.match(draw, /<h1>Users<\/h1>/);
  assert.match(draw, /<h2>Users with an Account<\/h2>/);
});

test('the Tasks toolbar picks a project from a dropdown, "Project: ", the one in view selected', () => {
  const projects = [{ slug: 'alpha', name: 'Alpha' }, { slug: 'beta', name: 'Beta' }];
  assert.equal(renderProjectPicker(projects, 'beta'),
    '<label class="project-picker">Project: <select name="project">'
    + '<option value="alpha">Alpha</option><option value="beta" selected>Beta</option></select></label>');
  // One project: still shown, selected.
  assert.equal(renderProjectPicker([projects[0]], 'alpha'),
    '<label class="project-picker">Project: <select name="project"><option value="alpha" selected>Alpha</option></select></label>');
  // Names and slugs are typed by people: escaped.
  const odd = renderProjectPicker([{ slug: 'a"b', name: 'R&D <b>' }], 'a"b');
  assert.doesNotMatch(odd, /<b>|a"b/);
  assert.match(odd, /<option value="a&quot;b" selected>R&amp;D &lt;b&gt;<\/option>/);
  // The board and list draw it from GET /projects, in place of the old link, and a pick opens that project in the same view.
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('async function drawProject'), app.indexOf('async function copyText'));
  assert.match(draw, /api\('GET', '\/projects'\),\n  \]\);/);
  assert.match(draw, /<div class="toolbar">\s*\$\{renderProjectPicker\(projects, board\.project\)\}\s*\$\{searchForm\(''\)\}\s*<nav class="views"/);
  assert.doesNotMatch(app, /Change project/);
  assert.match(draw, /querySelector\('\.project-picker select'\)\.addEventListener\('change', \(e\) => \{\s*history\.pushState\(null, '', at\(view, e\.target\.value\)\);\s*route\(\);/);
  assert.match(readFileSync(WEB('app.css'), 'utf8'), /\.toolbar \.project-picker select \{/);
});

test('search bolds every occurrence of the term, any case, after escaping the ticket\'s own text', () => {
  assert.equal(boldMatches('Widget and widget and WIDGET', 'widget'), '<b>Widget</b> and <b>widget</b> and <b>WIDGET</b>');
  assert.equal(boldMatches('a <b>bold</b> claim', 'bold'), 'a &lt;b&gt;<b>bold</b>&lt;/b&gt; claim');
  assert.equal(boldMatches('<script>alert(1)</script>', 'alert'), '&lt;script&gt;<b>alert</b>(1)&lt;/script&gt;');
  // A term that spells part of an escape never breaks one; one that is markup is matched as text.
  assert.equal(boldMatches('Tom & Jerry', 'amp'), 'Tom &amp; Jerry');
  assert.equal(boldMatches('a <b> tag', '<b>'), 'a <b>&lt;b&gt;</b> tag');
  assert.equal(boldMatches('cost (1+1)?', '(1+1)?'), 'cost <b>(1+1)?</b>');
  assert.equal(boldMatches('nothing here', ''), 'nothing here');
  assert.equal(searchPattern('  '), null);
  assert.ok(searchPattern('Sign-In').test('the sign-in page'));
});

test('the search results show each ticket\'s id, a link to its page, its project and status, and the excerpt\'s place', () => {
  const html = renderSearchResults({
    query: 'widget',
    results: [
      { id: 'AL-1', name: '<script>Widget</script> <b>x</b>', projectName: 'Alpha & Co', status: 'In review', place: null, excerpt: null },
      { id: 'BE-2', name: 'Other', projectName: 'Beta', status: 'Live', place: 'description', excerpt: '…the widget <img src=x> breaks…' },
    ],
  });
  assert.match(html, /<a href="\/t\/AL-1">&lt;script&gt;<b>Widget<\/b>&lt;\/script&gt; &lt;b&gt;x&lt;\/b&gt;<\/a>/);
  assert.ok(!/<script>|<img/.test(html), 'no ticket text reaches the page as markup');
  assert.match(html, /Alpha &amp; Co · In review/);
  assert.match(html, /Beta · Live/);
  assert.match(html, /…the <b>widget<\/b> &lt;img src=x&gt; breaks… <span class="quiet">in the description<\/span>/);
  assert.ok(html.indexOf('AL-1') < html.indexOf('BE-2'), 'drawn in the server\'s order');
  assert.match(renderSearchResults({ query: 'zzqqxx', results: [] }), /<p class="quiet search-note">No tickets match zzqqxx<\/p>/);
  assert.match(renderSearchResults({ query: '  ', results: [] }), /<p class="quiet search-note">Type a word to search every task\.<\/p>/);
  assert.match(renderSearchResults({ query: '<i>', results: [] }), /No tickets match &lt;i&gt;/);
});

test('the search finds the demo\'s tickets in every project and names its statuses from the contract', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-search-'));
  const store = openStore(join(dir, 'tracker.db'), { now: tickingClock() });
  try {
    seedDemo(store, { operatorName: 'Dane', clock: tickingClock() });
    const all = store.listProjects().flatMap((p) => store.listTickets(p.slug));
    const word = all[0].name.split(/\s+/).find((w) => w.length > 3);
    const { results } = searchTickets(store, word);
    assert.ok(results.length >= 1);
    for (const r of results) {
      assert.ok(Object.values(loopStatuses.DISPLAY).includes(r.status), r.status);
      assert.ok(store.getProject(r.project));
    }
    for (let i = 1; i < results.length; i += 1) assert.ok(results[i - 1].score >= results[i].score);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the Tasks page\'s toolbar holds the Search field, and Enter opens the results page', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(app, /\$\{renderProjectPicker\(projects, board\.project\)\}\s*\$\{searchForm\(''\)\}/);
  assert.match(app, /history\.pushState\(null, '', searchAddress\(form\.elements\.q\.value\.trim\(\)\)\)/);
  assert.match(app, /renderSearchResults\(answer\)/);
});

/** The filters as the server answers them, Status set to Queued and Assigned to to Nobody. */
const FILTERS = [
  { key: 'status', label: 'Status', value: 'Queued', options: [{ value: 'Rework', label: 'Rework' }, { value: 'Queued', label: 'Queued' }] },
  { key: 'priority', label: 'Priority', value: null, options: [{ value: 'urgent', label: 'Urgent' }, { value: 'none', label: 'None' }] },
  { key: 'createdBy', label: 'Created by', value: null, options: [{ value: '3', label: 'Tom & <Jerry>' }] },
  { key: 'assignee', label: 'Assigned to', value: 'nobody', options: [{ value: 'nobody', label: 'Nobody' }, { value: '3', label: 'Tom & <Jerry>' }] },
];

test('the search filters are one picker each, "Any" first, the server\'s choices in its order, the chosen one selected', () => {
  const html = renderSearchFilters(FILTERS);
  assert.match(html, /^<div class="search-filters">/);
  assert.equal((html.match(/<select /g) ?? []).length, 4);
  assert.match(html, /<label>Status\s*<select name="status"><option value="">Any<\/option><option value="Rework">Rework<\/option><option value="Queued" selected>Queued<\/option><\/select>/);
  assert.match(html, /<select name="priority"><option value="" selected>Any<\/option><option value="urgent">Urgent<\/option><option value="none">None<\/option>/);
  assert.match(html, /<select name="createdBy"><option value="" selected>Any<\/option><option value="3">Tom &amp; &lt;Jerry&gt;<\/option>/);
  assert.match(html, /<select name="assignee"><option value="">Any<\/option><option value="nobody" selected>Nobody<\/option>/);
  assert.deepEqual(activeFilters(FILTERS), ['Status: Queued', 'Assigned to: Nobody']);
  assert.match(renderSearchResults({ query: 'widget', filters: FILTERS, results: [] }),
    /<p class="quiet search-note">No tickets match widget with Status: Queued, Assigned to: Nobody<\/p>/);
  assert.match(renderSearchResults({ query: 'widget', filters: FILTERS.map((f) => ({ ...f, value: null })), results: [] }),
    /<p class="quiet search-note">No tickets match widget<\/p>/);
});

test('the search results page draws the filters from the server\'s answer, keeps them in the address, and shows a refusal', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('function searchAddress('), app.indexOf('/**\n * Put `text` on the clipboard'));
  assert.match(draw, /renderSearchFilters\(answer\.filters\)/);
  assert.match(draw, /api\('GET', `\/search\?\$\{params\}`\)/);
  assert.match(draw, /for \(const select of main\.querySelectorAll\('\.search-filters select'\)\) select\.addEventListener\('change', go\)/);
  assert.match(draw, /<p class="error">\$\{escapeHtml\(refusal\)\}<\/p>/);
  // No status, priority or person is typed out: every choice comes from the server.
  for (const word of [...loopStatuses.STAGE_ORDER, 'urgent', 'Urgent', 'Nobody', 'nobody']) {
    assert.ok(!draw.includes(`'${word}'`), word);
  }
  assert.match(app, /await drawSearch\(new URLSearchParams\(location\.search\)\)/);
});

// ── Set up a product (SP-127) ────────────────────────────────────────────────

/**
 * A tracker home for the setup page, as tracker/server.test.mjs's: this
 * repository's settings file with its own log folder, read the way the
 * server reads it. `state(slug, ...)` writes a state file as the wizard
 * leaves it; `of(slug)` is the server's answer for that product.
 */
function setupHome() {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-setup-page-'));
  const home = join(dir, 'home');
  const logDir = join(dir, 'logs');
  mkdirSync(home);
  const settings = JSON.parse(readFileSync(new URL('../spirality.project.json', import.meta.url), 'utf8'));
  writeFileSync(join(home, 'spirality.project.json'), JSON.stringify({ ...settings, logDir }));
  const { setup, why } = setupSettingsOf({ db: join(dir, 'tracker.db'), folder: home });
  assert.ok(setup, why);
  const onboard = join(logDir, 'onboard');
  const state = (slug, { outcomes = {}, stop = null, finished = false } = {}) => {
    mkdirSync(onboard, { recursive: true });
    const steps = SETUP_STEPS.map((step) => ({ step, outcome: outcomes[step] ?? 'pending', at: null, why: outcomes[step] ? `${step} said so` : null }));
    writeFileSync(join(onboard, `${slug}.state.json`), JSON.stringify({ product: slug, updatedAt: '2026-11-05T08:15:00.000Z', steps, stop, finished }));
  };
  return { dir, setup, state, of: (slug) => setupOf(setup, slug), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The `<code>` texts in a box, and how many Copy buttons sit beside them. */
const copies = (html) => ({ codes: codes(html), buttons: (html.match(/<button type="button" class="copy-command">Copy<\/button>/g) ?? []).length });

test('the setup page\'s next-step box, for a state file of each kind: every command with a Copy button whose text is exactly it', () => {
  const h = setupHome();
  try {
    saveAnswers(h.setup, 'press-play', { projectName: 'Press Play', githubRepo: 'example-owner/press-play', description: 'A test product.', trackerPrefix: '', mergePhrases: '', autoMergeLanes: 'none', extraGovernancePaths: 'none' });
    const command = h.of('press-play').commands.resume;
    assert.match(command, /npm run onboard -- --product press-play --no-prompt$/);
    const kind = (html) => /data-next="([a-z]+)"/.exec(html)[1];

    // Nothing run yet: the start command, to paste on the Mini.
    let html = renderSetupNext(h.of('press-play'));
    assert.equal(kind(html), 'start');
    assert.match(html, /Paste this into a Terminal on the Mini/);
    assert.deepEqual(copies(html), { codes: [command], buttons: 1 });
    assert.match(renderSetupSteps(null), /Not started yet/);

    // Stopped for answers: the start command, and the way back to the form.
    h.state('press-play', { outcomes: { answers: 'stopped' }, stop: { step: 'answers', kind: 'answers', why: 'still to answer: description', commands: [], link: null } });
    html = renderSetupNext(h.of('press-play'));
    assert.equal(kind(html), 'answers');
    assert.match(html, /still to answer: description/);
    assert.match(html, /<a href="\/setup\/press-play\/answers">Fill in the answers<\/a>/);
    assert.deepEqual(copies(html), { codes: [command], buttons: 1 });

    // Stopped at the paste: "Your Move (Real Secret Values)", one Copy for every line, then the resume command.
    const block = ["cd '/x/spirality'", "doppler projects create 'press-play'", "TRACKER_DB='/x/t.db' npm run tracker:signins -- create --name 'Press Play' --prefix 'PR' --config '/x/p.json'"];
    h.state('press-play', { outcomes: { answers: 'done', look: 'done', clone: 'skip', settings: 'done', signins: 'stopped' }, stop: { step: 'signins', kind: 'paste', why: 'waiting on you to run the block above', commands: block, link: null } });
    html = renderSetupNext(h.of('press-play'));
    assert.equal(kind(html), 'paste');
    assert.match(html, /Your Move \(Real Secret Values\)/);
    assert.deepEqual(copies(html), { codes: [block.join('\n'), command], buttons: 2 });
    assert.ok(html.indexOf(escapeHtml(block[0])) < html.indexOf(escapeHtml(command)), 'the block first, then the resume command');

    // Stopped at the merge: the setup ticket's link (its Merge button is there), then the resume command.
    h.state('press-play', { outcomes: { answers: 'done', signins: 'done', copy: 'done', lanes: 'done', merge: 'stopped' }, stop: { step: 'merge', kind: 'merge', why: 'not merged yet', commands: [], link: 'http://mac-mini.local:4180/t/PR-1' } });
    html = renderSetupNext(h.of('press-play'));
    assert.equal(kind(html), 'merge');
    assert.match(html, /<a href="http:\/\/mac-mini\.local:4180\/t\/PR-1">Open the setup ticket<\/a>/);
    assert.deepEqual(copies(html), { codes: [command], buttons: 1 });
    // A link that is not a web address is not drawn as one.
    h.state('press-play', { outcomes: { merge: 'stopped' }, stop: { step: 'merge', kind: 'merge', why: 'not merged yet', commands: [], link: 'javascript:alert(1)' } });
    assert.doesNotMatch(renderSetupNext(h.of('press-play')), /javascript:/);

    // Failed: the FAILED text, then the resume command.
    h.state('press-play', { outcomes: { answers: 'done', look: 'failed' }, stop: { step: 'look', kind: 'failed', why: 'something is BLOCKED <here>', commands: [], link: null } });
    html = renderSetupNext(h.of('press-play'));
    assert.equal(kind(html), 'failed');
    assert.deepEqual(copies(html), { codes: ['FAILED: look: something is BLOCKED <here>', command], buttons: 1 });
    assert.match(renderSetupSteps(h.of('press-play').state), /<li class="step failed"><span class="step-name">look<\/span> <span class="outcome">failed<\/span>/);

    // A step running: says which, and still offers the command should its run have ended.
    h.state('press-play', { outcomes: { answers: 'done', look: 'running' } });
    html = renderSetupNext(h.of('press-play'));
    assert.equal(kind(html), 'running');
    assert.match(html, /Running: look/);
    assert.deepEqual(copies(html), { codes: [command], buttons: 1 });

    // Finished: "<name> is set up", its project and its first ticket; nothing to copy.
    h.state('press-play', { outcomes: Object.fromEntries(SETUP_STEPS.map((s) => [s, 'done'])), finished: true });
    const done = h.of('press-play');
    html = renderSetupNext(done, { firstTicketId: 'PR-1' });
    assert.equal(kind(html), 'finished');
    assert.match(html, /<h2>Press Play Is Set Up<\/h2>/);
    assert.match(html, /<a href="\/projects\/press-play">its project<\/a>/);
    assert.match(html, /<a href="\/t\/PR-1">its first ticket, PR-1<\/a>/);
    assert.deepEqual(copies(html), { codes: [], buttons: 0 });
    // Every step listed, in the wizard's order, with its outcome.
    const steps = renderSetupSteps(done.state);
    assert.deepEqual([...steps.matchAll(/<span class="step-name">([a-z]+)<\/span>/g)].map((m) => m[1]), SETUP_STEPS);
    assert.equal(steps.match(/<span class="outcome">done<\/span>/g).length, SETUP_STEPS.length);

    // The page follows the setup every few seconds until it is finished.
    assert.equal(setupFollows(done), false);
    assert.equal(setupFollows({ ...done, finished: false }), true);

    // A state file that does not read says so, and offers the command.
    writeFileSync(join(h.setup.homeConfig.logDir, 'onboard', 'press-play.state.json'), '{ not json');
    html = renderSetupNext(h.of('press-play'));
    assert.equal(kind(html), 'unreadable');
    assert.deepEqual(copies(html), { codes: [command], buttons: 1 });
  } finally { h.cleanup(); }
});

test('the first ticket is the lowest-numbered on its board; a board with none has none', () => {
  assert.equal(firstTicket({ columns: [{ tickets: [{ id: 'PR-12' }, { id: 'PR-3' }] }, { tickets: [{ id: 'PR-10' }] }] }), 'PR-3');
  assert.equal(firstTicket({ columns: [{ tickets: [] }] }), null);
  assert.equal(firstTicket(null), null);
});

test('the setup form asks the wizard\'s own questions with their defaults, and sends a default as null so it stays the wizard\'s', () => {
  const h = setupHome();
  try {
    const fields = setupFields(h.setup, 'press-play');
    const html = renderSetupForm(fields);
    assert.deepEqual([...html.matchAll(/name="([A-Za-z]+)"/g)].map((m) => m[1]), SETUP_FIELDS.map((f) => f.key));
    assert.match(html, /<label for="setup-projectName">Project name, as the tracker shows it<\/label>/);
    assert.match(html, /name="trackerPrefix" data-default="PR" autocapitalize="off" spellcheck="false" value="PR">/);
    assert.match(html, /<textarea id="setup-description"/);
    assert.match(html, /<span class="note field-note" data-for="githubRepo"><\/span>/);
    // Saved answers fill it in: a list with commas, an empty list as "none".
    const again = renderSetupForm(fields, { projectName: 'Press <Play>', autoMergeLanes: [], extraGovernancePaths: ['docs/A.md', 'ops/'] });
    assert.match(again, /name="projectName"[^>]*value="Press &lt;Play&gt;"/);
    assert.match(again, /name="autoMergeLanes"[^>]*value="none"/);
    assert.match(again, /name="extraGovernancePaths"[^>]*value="docs\/A\.md, ops\/"/);
    // The body: each answer as typed, a default as null; the server's checker accepts it.
    const values = Object.fromEntries(fields.map((f) => [f.key, f.default ?? '']));
    Object.assign(values, { projectName: 'Press Play', githubRepo: 'example-owner/press-play', description: 'A test product.', autoMergeLanes: 'relay' });
    const body = setupBody(fields, values);
    assert.equal(body.trackerPrefix, null);
    assert.equal(body.mergePhrases, null);
    assert.equal(body.autoMergeLanes, 'relay');
    assert.equal(body.projectName, 'Press Play');
    const saved = saveAnswers(h.setup, setupSlug('Press Play'), body);
    assert.equal(saved.product, 'press-play');
    assert.equal(saved.resolved.trackerPrefix, 'PR');
    assert.deepEqual(saved.resolved.autoMergeLanes, ['relay']);
  } finally { h.cleanup(); }
});

test('the page makes a slug by the wizard\'s rule, and refuses the two that are other pages\' addresses', () => {
  for (const name of ['Press Play', '  PressPlay!! 2 ', 'a--b', 'Ünïcode name', '---']) {
    assert.equal(setupSlug(name), slugFromName(name), name);
  }
  assert.equal(setupSlugProblem('press-play'), null);
  assert.match(setupSlugProblem(''), /letter or a digit/);
  assert.match(setupSlugProblem('new'), /another name/);
  assert.match(setupSlugProblem('fields'), /another name/);
});

test('the Projects page has Set up a product, lists the products mid-setup, and keeps New project a link away', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const projects = /async function drawProjects\(done = ''\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(projects, /<a class="button" href="\/setup\/new">Set Up a Product<\/a>/);
  assert.doesNotMatch(projects, /href="\/projects\/new">New project/);
  assert.match(projects, /api\('GET', '\/setup'\)/);
  assert.match(projects, /\$\{renderSetupList\(setups\)\}/);
  const setupNew = /async function drawSetupNew\(product\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(setupNew, /<a href="\/projects\/new">New project<\/a>/);
  assert.match(setupNew, /api\('PUT', `\/setup\/\$\{encodeURIComponent\(slug\)\}`, setupBody\(fields, values\)\)/);
  assert.match(setupNew, /history\.pushState\(null, '', `\/setup\/\$\{encodeURIComponent\(slug\)\}`\)/, 'Save opens its setup page');
  assert.match(setupNew, /err\.field \? form\.querySelector\(`\.field-note\[data-for="\$\{err\.field\}"\]`\)/, 'a refusal naming a field shows beside it');
  // The setup page wires the same Copy buttons as a ticket's, and follows the setup every few seconds.
  assert.match(/async function drawSetup\(slug\) \{[\s\S]*?\n\}/.exec(app)[0], /wireCopyButtons\(\);\s*return setupFollows\(setup\);/);
  assert.match(app, /const SETUP_REFRESH_EVERY_MS = 4_000;/);
  assert.match(app, /if \(lastDrawn\?\.fast\) refreshPage\(\);\s*\}, SETUP_REFRESH_EVERY_MS\);/);
  assert.match(app, /if \(kept && following\) lastDrawn = \{ address: here\(\), reads, fast: true \};/);

  // The list: each product not finished, linking its setup page; nothing when there are none.
  const list = renderSetupList({ setups: [
    { product: 'press-play', step: 'signins', finished: false, started: true, stateError: null },
    { product: 'done-one', step: null, finished: true, started: true, stateError: null },
    { product: 'fresh', step: null, finished: false, started: false, stateError: null },
  ] });
  assert.match(list, /<h2>Being Set Up<\/h2>/);
  assert.match(list, /<a href="\/setup\/press-play">press-play<\/a> <span class="quiet">at signins<\/span>/);
  assert.match(list, /<a href="\/setup\/fresh">fresh<\/a> <span class="quiet">not started yet<\/span>/);
  assert.doesNotMatch(list, /done-one/);
  assert.equal(renderSetupList({ setups: [] }), '');
});

test('the setup pages are served to a browser at /setup/new, /setup/<slug> and its answers form; the page\'s own call still gets the data', async () => {
  const f = await fixture();
  try {
    const html = { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
    const page = readFileSync(WEB('index.html'), 'utf8');
    for (const path of ['/setup/new', '/setup/press-play', '/setup/press-play/answers']) {
      const r = await fetch(`${f.url}${path}`, { headers: html });
      assert.equal(r.status, 200, path);
      assert.equal(await r.text(), page, path);
    }
    // Without asking for HTML, /setup/<slug> is the call (this fixture's server has no tracker home: 503), and needs a sign-in.
    assert.equal((await f.call('GET', '/setup/press-play')).status, 503);
    assert.equal((await f.call('GET', '/setup/press-play', { token: null })).status, 401);
    // /setup/fields is only ever the call.
    assert.notEqual((await fetch(`${f.url}/setup/fields`, { headers: html })).headers.get('content-type'), 'text/html; charset=utf-8');
  } finally { await f.cleanup(); }
});
