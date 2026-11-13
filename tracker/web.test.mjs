import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.mjs';
import { DEMO_NEWEST_RELEASE, DEMO_OWN_PROJECT, demoNewestRelease, seedDemo, tickingClock } from './demoData.mjs';
import { reportsOf, REPORT_RANGES, searchTickets, PRIORITIES, timeSplitOf, isFailureNote, TIME_BUCKETS, pipelineControlsOf } from './pageData.mjs';
import { escapeHtml, renderComment, renderInline, renderMarkdown, unwrapDoc, renderQuickAction, renderCommands, renderFilesMade, filesMade, cardCommands, isCommand, askParagraphs, cardAsk, renderMergeAction, renderAnswerIn, renderHeldUp, heldUpLine, renderReplyForm, statusLabel, ANSWER_IN_NOTE, MERGE_STANDS_NOTE, mergeQuestion, renderCloseAction, closeQuestion, renderGoAction, goQuestion, cardMove, renderTrail, renderProjectPicker, cardContext, firstParagraph, originalRequest, canDelete, deleteQuestion, deleteRefusal, renderDeleteAction, renderEditPanel, MOVED_MESSAGE, bellColour, busLink, stageLook, stageLooks, contrast, linkProblem, passwordProblem, renderSetPassword, renderPasswordSet, renderSignIn, renderForgot, MIN_PASSWORD, boldMatches, searchPattern, renderSearchResults, renderSearchFilters, renderTicketLookup, lookupTicket, activeFilters, redrawHold, drawnChoice, renderSetupNext, renderSetupSteps, renderSetupList, renderSetupForm, setupBody, setupSlug, setupSlugProblem, setupFollows, firstTicket, renderPipelinePod, healthLines, renderHealth, PIPELINE_UNAVAILABLE, renderPipelineDetails, passOutcome, wakesEvery, pipelinePodLabel, matchCommands, renderCommandList, renderCommandView, renderCommandDetails, commandSummary, commandAbout, commandHref, renderContextDocs, PRIORITY_ORDER, SORT_COLUMNS, sortTickets, nextSort, renderSortHeadings, renderListPriority, docInfo, docDay, docRows, sortDocs, filterDocs, renderDocHeadings, renderDocBody, docCountLine, renderDocumentation, DOC_KINDS, PIPELINE_SOON_MS, lowerMeridiem, renderPipelineControls, renderReleaseGroup, controlValueText, mountainTime, wakeInEffectText, modelLastPassText, renderConsole, renderConsoleTile, consoleNextChange, consoleAge, consoleWaiting, CONSOLE_UNKNOWN, consoleFeature, featureColourIndex, renderFeatureKey, FEATURE_PALETTE, drainLine, capInFlightText } from './web/render.mjs';
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
    const project = join(dir, slug);
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'spirality.project.json'), JSON.stringify({
      manifestVersion: 2, workspaceId: '111', spaceId: '222', loopQueueListId: '333',
      operatorUserId: seed.operator.id, machineUserId: seed.loop.id,
      githubRepo: 'owner/repo', dopplerProject: 'proj', dopplerConfig: 'dev',
      launchdPrefix: 'com.example', logDir: '~/loop-logs', mergePhrases: ['merge'],
      governancePaths: [], autoMergeLanes: [], operatorName: 'Dane', projectSlug: slug,
      legacyMachinePrefixes: [], projectScripts: {}, tracker: 'api', trackerUrl: url,
    }));
    return new Promise((resolve) => {
      const env = { PATH: process.env.PATH, HOME: process.env.HOME, TRACKER_TOKEN_HAND_RUN: loopToken };
      const child = spawn(process.execPath, [DOOR, ...args], { cwd: project, env });
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
      // 1 when any ticket is undecided (it outranks 3), else 3: both projects have waits.
      assert.ok([1, 3].includes(r.code), r.err);
      for (const line of r.out.trim().split('\n')) {
        // The command and the page share one verdict (SP-217): WAITING is his,
        // CANNOT TELL is his status with nobody assigned.
        const [id, , , , , verdict] = line.split('\t');
        if (verdict.startsWith('WAITING ON DANE')) said.assigned.push(id);
        else if (verdict.startsWith('CANNOT TELL')) said.unassigned.push(id);
      }
    }

    assert.deepEqual(page.body.waiting.map((t) => t.id).sort(), said.assigned.sort());
    // The command calls his status with nobody assigned CANNOT TELL; the page shows those apart, never drops them.
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
    assert.match(renderReplyForm(thread, 'Dane'), /<form class="reply">/);
    assert.equal((await boardTickets(f, 'beta')).get('BE-1').answerIn, false);

    // He presses Merge: the button posts his word, and the page redraws.
    assert.equal((await f.call('POST', '/tickets/BE-1/comments', { body: { body: 'merge' } })).status, 201);
    thread = (await f.call('GET', '/tickets/BE-1/thread')).body;
    assert.equal(thread.answerIn, true);
    assert.equal(renderMergeAction(thread), '', 'no second Merge button');
    assert.match(renderAnswerIn(thread), /Your answer is in\. The relay acts on it at its next pass\./);
    assert.equal(renderReplyForm(thread, 'Dane'), '', 'no reply box and no Post Reply button while his answer is in (SP-160)');
    assert.equal(statusLabel(thread), `Ready to launch · ${ANSWER_IN_NOTE}`);
    assert.equal((await boardTickets(f, 'beta')).get('BE-1').answerIn, true, 'the board and list say so too');

    // The relay answers (here with a refusal): its comment is newest, so "your answer is in" goes and
    // the reply box returns. But his merge word still stands (SP-285): the relay re-tries it on every
    // pass, so no Merge button, no place on Waiting on You, and the page says it stands.
    const loopToken = f.store.issueToken(f.loop.id);
    assert.equal((await f.call('POST', '/tickets/BE-1/comments', { token: loopToken, body: { body: 'MERGE REFUSED: the check is red.' } })).status, 201);
    thread = (await f.call('GET', '/tickets/BE-1/thread')).body;
    assert.equal(thread.answerIn, false);
    assert.equal(thread.mergeStands, true);
    assert.doesNotMatch(renderMergeAction(thread), /merge-action/, 'no second Merge button while his word stands (SP-285)');
    assert.match(renderAnswerIn(thread), /Your merge word stands\. The relay merges this on its own as soon as it can; you do not need to say it again\./);
    assert.doesNotMatch(renderQuickAction(thread), /Your move|class="needed"/);
    assert.equal(statusLabel(thread), `Ready to launch · ${MERGE_STANDS_NOTE}`);
    assert.match(renderReplyForm(thread, 'Dane'), /<form class="reply">[\s\S]*Post Reply/, "the reply box comes back with the relay's comment");
    const row = (await boardTickets(f, 'beta')).get('BE-1');
    assert.deepEqual([row.answerIn, row.mergeStands, row.waiting], [false, true, false]);
    assert.ok(!(await f.call('GET', '/waiting')).body.waiting.some((t) => t.id === 'BE-1'), 'not back on Waiting on You (SP-285)');
  } finally { await f.cleanup(); }
});

test('SP-285: a new review PASS after his merge is a new round — the Merge button and Waiting on You come back', async () => {
  const f = await fixture({ mergePhrase: 'merge' });
  try {
    const loopToken = f.store.issueToken(f.loop.id);
    assert.equal((await f.call('POST', '/tickets/BE-1/comments', { body: { body: 'merge' } })).status, 201);
    assert.equal((await f.call('POST', '/tickets/BE-1/comments', { token: loopToken, body: { body: 'REVIEW: PASSED — round 2, after a rework.' } })).status, 201);
    const thread = (await f.call('GET', '/tickets/BE-1/thread')).body;
    assert.equal(thread.mergeStands, false);
    assert.match(renderMergeAction(thread), /merge-action/);
    assert.ok((await f.call('GET', '/waiting')).body.waiting.some((t) => t.id === 'BE-1'));
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
  assert.equal(app.match(/t\.answerIn \? /g)?.length, 1, 'the board card draws the note; the list row draws a check instead (SP-201)');
});

test('with his answer in, the ticket page draws no reply box and copes with it missing, and the notice is boxed (SP-160)', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = /\nasync function drawTicket\(id(?:, said = null(?:, kept = null)?)?\) \{[\s\S]*?\n\}\n/.exec(app)?.[0] ?? '';
  assert.ok(draw, 'drawTicket found');
  assert.doesNotMatch(draw, /<form class="reply">/, 'the box comes only from renderReplyForm');
  // Every reach for the box survives its absence: the kept text, the #reply jump, the submit wiring.
  assert.doesNotMatch(draw, /querySelector\('form\.reply textarea'\)\.value =/);
  assert.match(draw, /const form = main\.querySelector\('form\.reply'\);\s*if \(!form\) return;\s*const box = form\.querySelector\('textarea'\);/);
  assert.match(draw, /if \(!form\) return;[\s\S]*location\.hash === '#reply'[\s\S]*form\.addEventListener\('submit'/);
  assert.match(app, /reply: main\.querySelector\('form\.reply textarea'\)\?\.value \?\? ''/);
  // The ticket page's notice: tinted, a blue bar on the left, ink, upright. The board and list note unchanged.
  const css = readFileSync(WEB('app.css'), 'utf8');
  const notice = /\np\.answer-in \{([^}]*)\}/.exec(css)?.[1] ?? '';
  for (const rule of [/font-style: normal/, /color: var\(--ink\)/, /background: #/, /border-left: \d+px solid var\(--blue\)/, /padding: /]) assert.match(notice, rule);
  assert.match(css, /\n\.answer-in \{ font-size: 0\.85rem; font-style: italic; color: var\(--quiet\); \}/);
  assert.equal(renderAnswerIn({ answerIn: true }), '<p class="answer-in">Your answer is in. The relay acts on it at its next pass.</p>');
});

test('a ticket held up by a failing lane says so in one line above the card, with the stage, reason and start, before any "Your move" (SP-228)', () => {
  const timeOf = (iso) => `at ${iso}`;
  const held = { heldUp: { stage: 'Relay', job: 'relay', reason: 'keeps failing', since: '2026-11-11T04:00:00.000Z' } };
  assert.equal(heldUpLine(held, timeOf), 'Held up: Relay keeps failing since at 2026-11-11T04:00:00.000Z');
  assert.equal(renderHeldUp(held, timeOf), '<p class="held-up" role="status">Held up: Relay keeps failing since at 2026-11-11T04:00:00.000Z</p>');
  assert.equal(heldUpLine({ heldUp: { stage: 'Build', reason: "can't reach the internet", since: null } }, timeOf), "Held up: Build can't reach the internet");
  assert.equal(heldUpLine({ heldUp: { stage: 'Review' } }, timeOf), 'Held up: Review keeps failing');
  assert.match(renderHeldUp({ heldUp: { stage: '<b>', reason: 'keeps failing' } }, timeOf), /&lt;b&gt;/, 'escaped');
  for (const none of [{}, { heldUp: null }, { heldUp: {} }, { heldUp: { stage: '' } }]) assert.equal(renderHeldUp(none, timeOf), '');

  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = /\nasync function drawTicket\(id[^)]*\) \{[\s\S]*?\n\}\n/.exec(app)?.[0] ?? '';
  const line = draw.indexOf('${renderHeldUp(t, sinceTime)}');
  assert.ok(line > 0, 'the ticket page draws the line, with the header health line\'s times');
  assert.ok(line < draw.indexOf('${renderQuickAction(t)}'), 'above the card, so it is read first');
  const css = readFileSync(WEB('app.css'), 'utf8');
  const rule = /\n\.quick \.held-up \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(rule, /grid-column: 1 \/ -1/, 'across the whole top, not in one column');
  const ink = /(?:^|;)\s*color: (#[0-9a-f]{6})/.exec(rule)?.[1];
  const paper = /background: (#[0-9a-f]{6})/.exec(rule)?.[1];
  assert.ok(contrast(ink, paper) >= 4.5, `readable: ${ink} on ${paper}`);
});

// ── The list's status icons (SP-201) ─────────────────────────────────────────

test('the board\'s `waiting` flag is exactly the Waiting on You list, for whoever is signed in (SP-201)', async () => {
  const f = await fixture();
  try {
    const listed = async (token) => new Set((await f.call('GET', '/waiting', { token })).body.waiting.map((t) => t.id));
    const flagged = async (token) => {
      const ids = new Set();
      for (const slug of ['alpha', 'beta']) {
        const board = (await f.call('GET', `/projects/${slug}/board`, { token })).body;
        for (const t of board.columns.flatMap((c) => c.tickets)) {
          assert.equal(typeof t.waiting, 'boolean', t.id);
          assert.ok(!(t.waiting && t.answerIn), `${t.id}: a clock and a check together`);
          if (t.waiting) ids.add(t.id);
        }
      }
      return ids;
    };
    const dane = await listed(f.token);
    assert.ok(dane.size >= 1, 'the demo data holds a ticket waiting on Dane');
    assert.deepEqual([...await flagged(f.token)].sort(), [...dane].sort());

    // Someone else signed in: their own Waiting on You, never Dane's.
    const other = f.store.createActor({ kind: 'human', name: 'Someone Else' });
    for (const project of ['alpha', 'beta']) f.store.addMember({ project, actor: other.id, by: f.operator.id });
    const otherToken = f.store.issueToken(other.id);
    const theirs = await listed(otherToken);
    assert.deepEqual([...await flagged(otherToken)].sort(), [...theirs].sort());
    for (const id of dane) assert.ok(!theirs.has(id), `${id} waits on Dane, not on them`);

    // His reply takes the clock away: the ticket's answer is in instead.
    const [id] = dane;
    assert.equal((await f.call('POST', `/tickets/${id}/comments`, { body: { body: 'looks good' } })).status, 201);
    const after = new Map((await Promise.all(['alpha', 'beta'].map((s) => boardTickets(f, s)))).flatMap((m) => [...m]));
    assert.equal(after.get(id).waiting, false);
    assert.equal(after.get(id).answerIn, true);
  } finally { await f.cleanup(); }
});

test('the list row starts its Actions cell with a check, a clock or an empty slot, drawn as line icons with the colour in the stylesheet (SP-201)', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const icon = /\nfunction statusIcon\(t\) \{[\s\S]*?\n\}\n/.exec(app)?.[0] ?? '';
  assert.ok(icon, 'statusIcon found');
  assert.match(icon, /if \(t\.answerIn \|\| t\.mergeStands\)[\s\S]*'Your Merge Word Stands' : 'Your Answer Is In'[\s\S]*title="\$\{said\}" aria-label="\$\{said\}"[\s\S]*ICONS\.answerIn/);
  assert.match(icon, /if \(t\.waiting\) return action\(`\$\{at\}#reply`, 'Waiting on Your Response', ICONS\.waiting\);/);
  assert.match(icon, /<span class="action status-icon empty" aria-hidden="true"><\/span>/);
  assert.doesNotMatch(icon, /style=/, 'no inline style');
  const actions = /const actions = \(t, status\) => \{[\s\S]*?\n {2}\};/.exec(app)?.[0] ?? '';
  assert.match(actions, /return \[\s*statusIcon\(t\),\s*action\(at, 'Open Ticket'/, 'the status icon comes first');
  for (const key of ['answerIn', 'waiting']) assert.match(app, new RegExp(`\\n  ${key}: '<(path|circle) `), `ICONS.${key} is a line drawing`);
  // The card keeps its words; the ticket page keeps its notice.
  assert.match(app, /\$\{t\.answerIn \? `<span class="answer-in">\$\{escapeHtml\(ANSWER_IN_NOTE\)\}<\/span>` : t\.mergeStands \? `<span class="answer-in">\$\{escapeHtml\(MERGE_STANDS_NOTE\)\}<\/span>` : ''\}/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  const green = /\nspan\.action\.answer-in-icon \{ color: (#[0-9a-fA-F]{6}); \}/.exec(css)?.[1];
  assert.ok(green, 'the check has its own colour');
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(green.slice(i, i + 2), 16));
  assert.ok(g > r * 1.5 && g > b * 1.5, `${green} is a green`);
  assert.match(css, /\nspan\.action\.status-icon\.empty \{ width: 18px; height: 18px; \}/, 'the empty slot is an icon wide');
  const box = (sel) => new RegExp(`\\n${sel} \\{ display: inline-flex; padding: 0\\.2rem; margin-right: 0\\.15rem;`);
  assert.match(css, box('a\\.action, button\\.action'));
  assert.match(css, box('span\\.action\\.status-icon'), 'the status slot has the same padding and gap as the icons after it');
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
    // Each project's operator and members (the Projects page's Members column) ride with it.
    const dane = { id: f.operator.id, name: 'Dane' };
    assert.deepEqual((await f.call('GET', '/projects')).body.projects, [
      { slug: 'alpha', name: 'Alpha', prefix: 'AL', url: null, logo: null, owner: null, repo: null, open: openIn('alpha'), operator: dane, members: [dane] },
      { slug: 'beta', name: 'Beta', prefix: 'BE', url: null, logo: null, owner: null, repo: null, open: openIn('beta'), operator: dane, members: [dane] },
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
      members: [{ id: f.operator.id, name: 'Dane', addedAt: r.body.members[0]?.addedAt, addedBy: null }],
      canEditMembers: true,
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

test('every stage on the board and the list folds, Live starts folded and the rest open, and every card and row opens its ticket page (SP-196)', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = /async function drawProject\(([^)]*)\) \{([\s\S]*?)\n\}/.exec(app)[2];
  // One block for every stage: a folding section whose summary is its heading. No stage is drawn unfoldable.
  assert.match(draw, /const block = \(c, cls, body\) => `<details class="\$\{cls\}" data-stage="\$\{escapeHtml\(c\.status\)\}"\$\{startsOpen\(c\) \? ' open' : ''\}><summary>\$\{head\(c\)\}<\/summary>\$\{body\}<\/details>`;/);
  assert.match(draw, /const startsOpen = \(c\) => c\.status !== 'Live';/, 'every stage but Live starts open');
  assert.doesNotMatch(draw, /<section class="\$\{cls\}"/, 'no stage is a plain section any more');
  assert.match(draw, /block\(c, 'column',/);
  assert.match(draw, /block\(c, 'group',/);
  assert.match(app, /<a class="card" href="\/t\/\$\{encodeURIComponent\(t\.id\)\}">/);
  assert.match(app, /<td class="name"><a href="\/t\/\$\{encodeURIComponent\(t\.id\)\}">/);
  // Only a stage's block may be drawn open: no other folding section starts open.
  assert.deepEqual(app.match(/<details[^>]*\bopen\b[^>]*>/g), ['<details class="${cls}" data-stage="${escapeHtml(c.status)}"${startsOpen(c) ? \' open\' : \'\'}>']);
});

test('a stage heading reads its name, then the count right-aligned, then one arrow that shows open or folded (SP-196)', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = /async function drawProject\(([^)]*)\) \{([\s\S]*?)\n\}/.exec(app)[2];
  assert.match(draw, /const head = \(c\) => `<h2><span class="stage-name">\$\{escapeHtml\(c\.status\)\}<\/span><span class="count quiet">\$\{c\.tickets\.length\}<\/span><\/h2><span class="fold" aria-hidden="true"><\/span>`;/,
    'name, then count, then the arrow, in that order');
  const css = readFileSync(WEB('app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = css.split('}').map((r) => r.split('{')).filter((r) => r.length === 2)
    .map(([sel, body]) => ({ sel: sel.split(',').map((x) => x.trim()), body }));
  const ruleFor = (sel, body) => rules.some((r) => r.sel.includes(sel) && body.test(r.body));
  for (const stage of ['.column', '.group']) {
    assert.ok(ruleFor(`${stage} > summary`, /display: flex;/) && ruleFor(`${stage} > summary`, /list-style: none;/), `${stage}: one row, no list marker`);
    assert.ok(ruleFor(`${stage} > summary::-webkit-details-marker`, /display: none;/), `${stage}: the browser's own arrow is hidden`);
    assert.ok(ruleFor(`${stage} > summary h2`, /flex: 1;/), `${stage}: the heading fills the row, so the arrow sits at its right`);
    assert.ok(ruleFor(`${stage} > summary .count`, /margin-left: auto;/), `${stage}: the count is right-aligned`);
    assert.ok(ruleFor(`${stage} > summary .fold::before`, /content: '▸';/), `${stage}: folded points right`);
    assert.ok(ruleFor(`${stage}[open] > summary .fold::before`, /content: '▾';/), `${stage}: open points down`);
    assert.ok(ruleFor(`${stage} > summary`, /cursor: pointer;/), `${stage}: the heading is clickable`);
  }
  // A stage's colour tints its whole heading bar, the arrow included, open or folded.
  assert.ok(ruleFor('.coloured > summary', /background: var\(--stage-tint\);/));
  assert.ok(ruleFor('.coloured > summary .fold', /color: var\(--stage-text\);/));
  // A folded Board column keeps its width: nothing shrinks it.
  assert.doesNotMatch(css, /details\.column:not\(\[open\]\)\s*\{[^}]*flex-basis/);
});

test('a stage folded or opened by hand stays that way through the page\'s own redraw, even if its colour changed (SP-196)', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const place = /function keepPlace\(\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(place, /const key = \(d\) => \(d\.dataset\.stage \? `stage\|\$\{d\.dataset\.stage\}` : d\.className\);/, 'a stage is known by its name, not its classes');
  assert.match(place, /const open = new Map\(\[\.\.\.main\.querySelectorAll\('details'\)\]\.map\(\(d\) => \[key\(d\), d\.open\]\)\);/, 'every stage is a details, so every stage is kept');
  assert.match(place, /for \(const d of main\.querySelectorAll\('details'\)\) if \(open\.has\(key\(d\)\)\) d\.open = open\.get\(key\(d\)\);/);
});

test('the board has no Live column: Live is a list section below the columns, newest change first, with its count (SP-165)', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = /async function drawProject\(([^)]*)\) \{([\s\S]*?)\n\}/.exec(app)[2];
  assert.match(draw, /const working = board\.columns\.filter\(\(c\) => c\.status !== 'Live'\);/);
  assert.match(draw, /<div class="board">\$\{working\.map\(column\)\.join\(''\)\}<\/div>\$\{live \? `<div class="list board-live">\$\{group\(live\)\}<\/div>` : ''\}/);
  assert.doesNotMatch(draw, /board\.columns\.map\(column\)/, 'no column is drawn for Live');
  // Newest change first, without reordering the List view's Live.
  assert.match(draw, /liveColumn\.tickets\.slice\(\)\.sort\(\(a, b\) => \(a\.updatedAt < b\.updatedAt \? 1 : a\.updatedAt > b\.updatedAt \? -1 : 0\)\)/);
  assert.match(draw, /<div class="list">\$\{board\.columns\.map\(group\)\.join\(''\)\}<\/div>/, 'the List view is unchanged');
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
  assert.match(app, /\$\{viewSwitch\(board\.project, view\)\}/);
  assert.match(/function viewSwitch\(slug, current\) \{([\s\S]*?)\n\}/.exec(app)[1], /\['board', 'Board', `\/board\/\$\{encodeURIComponent\(slug\)\}`\], \['list', 'List', `\/list\/\$\{encodeURIComponent\(slug\)\}`\]/);
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
  assert.match(draw, /<button type="submit">Submit Task<\/button>/, 'the button says Submit Task, in his words');
  assert.doesNotMatch(app, /File request/i, 'the old button words are gone');
  assert.match(app, /Filed <a href="\/t\/\$\{encodeURIComponent\(filed\)\}">\$\{escapeHtml\(filed\)\}<\/a>/);
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
  // Uploaded names ride in the filed pod; the ones that were not stay in the lasting line, each with why, escaped (SP-223).
  const pod = /function filedPod[\s\S]*?\n\}/.exec(app)[0];
  assert.match(pod, /Uploaded \$\{names\}/);
  assert.match(pod, /escapeHtml\(n\)/);
  const note = /function notUploadedNote[\s\S]*?\n\}/.exec(app)[0];
  assert.match(note, /Not uploaded: /);
  assert.match(note, /The ticket is filed without/);
  assert.match(note, /escapeHtml\(f\.name\)/);
  assert.match(draw, /\$\{notUploadedNote\(notUploaded\)\}<\/p>/);
});

test('a filed task shows a larger pod centred on the Tasks heading row, above the page and out of its flow, for 3 seconds then a 1-second fade, then gone; warnings stay as a lasting line (SP-223)', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('async function drawProject'), app.indexOf('async function copyText'));
  // The pod sits in the heading's own row, drawn only after a filing.
  assert.match(draw, /<div class="tasks-head"><h1>Tasks<\/h1>\$\{filed \? filedPod\(filed, uploaded\) : ''\}<\/div>/);
  const pod = /function filedPod[\s\S]*?\n\}/.exec(app)[0];
  assert.match(pod, /<output class="filed-pod">Filed <a href="\/t\/\$\{encodeURIComponent\(filed\)\}">\$\{escapeHtml\(filed\)\}<\/a>/, 'the id is still a link');
  // The old line under the toolbar is drawn only for a warning, and never says Filed.
  assert.match(draw, /\$\{filed && \(unchecked \|\| notUploaded\.length\) \? `<p class="filed-note">/);
  assert.doesNotMatch(draw, /<p class="filed-note">Filed/, 'a plain success is the pod alone');
  // Off the page once faded, so it catches no clicks.
  assert.match(app, /const FILED_POD_MS = 4000;/);
  assert.match(/function wireFiledPod[\s\S]*?\n\}/.exec(app)[0], /setTimeout\(\(\) => pod\.remove\(\), FILED_POD_MS\);/);
  assert.match(draw, /wireFiledPod\(\);/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /\.tasks-head \{ position: relative; \}/, 'the row the pod is centred on; adds no height of its own');
  const rule = /\.filed-pod \{([^}]*)\}/.exec(css)[1];
  assert.match(rule, /position: absolute;/, 'out of the page flow: nothing moves');
  assert.match(rule, /top: 50%; left: 50%; transform: translate\(-50%, -50%\);/, 'centred on the heading row');
  assert.match(rule, /z-index: 10;/, 'drawn above the heading, toolbar and tables');
  assert.match(rule, /font-size: 1\.25rem;/, 'larger than the body text');
  assert.match(rule, /animation: filed-pod-fade 4s linear forwards;/);
  assert.match(css, /@keyframes filed-pod-fade \{ 0%, 75% \{ opacity: 1; \} 100% \{ opacity: 0; \} \}/, '3 seconds full, then 1 second to nothing');
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
  assert.match(draw, /\$\{unchecked \? UNCHECKED_NOTE : ''\}/);
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

test('the page is served at /, at a ticket\'s address, at Projects, at Tasks, at the board, at the list, at the Console and at the old New request address without a token, locked to its own scripts', async () => {
  const f = await fixture();
  try {
    for (const path of ['/', '/t/AL-1', '/tasks', '/board', '/board/alpha', '/list', '/list/alpha', '/console', '/new']) {
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
  assert.match(html, /<a href="\/reporting" data-nav="reporting">Reporting<\/a>\s*<a href="\/users" data-nav="users">Users<\/a>\s*<a href="\/docs" data-nav="docs">Docs<\/a>\s*<a href="\/settings" data-nav="settings">Settings<\/a>/);
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

test('the Settings page\'s Spirality Release group: the release, when and by whom, the one before, Move to Newest and Roll Back for the operator; Spirality\'s own and a project with none named say so (SP-275)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-web-release-'));
  const clock = tickingClock();
  const store = openStore(join(dir, 'tracker.db'), { now: clock });
  const seed = seedDemo(store, { operatorName: 'Dane', clock });
  // As the demo serves it: Alpha stands in for Spirality's own, the newest is a stand-in.
  const server = await startServer({ store, port: 0, ownProject: DEMO_OWN_PROJECT, newestRelease: demoNewestRelease });
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => (await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${seed.token}` } })).json();
  try {
    const { projects } = await get('/pipeline-controls');
    const beta = projects.find((p) => p.project.slug === 'beta');
    const html = renderPipelineControls(beta);
    assert.match(html, /<h4>Spirality Release<\/h4>/);
    assert.ok(html.indexOf('Spirality Release') < html.indexOf('Change Log'), 'above the change log');
    assert.match(html, /Runs <strong>release-2<\/strong>, named [^<]+M[SD]T by Dane\./);
    assert.match(html, /Before that: <strong>release-1<\/strong>, named [^<]+ by Loop \(build\)\./);
    assert.match(html, new RegExp(`The newest release is <strong>${DEMO_NEWEST_RELEASE}</strong>\\.`));
    assert.match(html, /<button type="button" data-release-action="newest">Move to Newest<\/button>/);
    assert.match(html, /<button type="button" data-release-action="back">Roll Back to release-1<\/button>/);
    assert.match(html, /Named, but the lanes do not run from it yet \(SP-276\)\./);

    const alpha = projects.find((p) => p.project.slug === 'alpha');
    const own = renderPipelineControls(alpha);
    assert.match(own, /Always the newest release: Spirality&#39;s own lanes meet every change first\./);
    assert.doesNotMatch(own, /data-release-action/);

    // Another reader sees the release, never the buttons.
    assert.doesNotMatch(renderReleaseGroup({ ...beta.release, canChange: false }), /<button/);
    // None named yet: the line, and only Move to Newest.
    const none = renderReleaseGroup({ ...beta.release, current: null, previous: null, rollBackTo: null });
    assert.match(none, /No release named yet\./);
    assert.match(none, /Move to Newest/);
    assert.doesNotMatch(none, /Roll Back/);
    // Already on the newest: Move to Newest is greyed and says why; nowhere back says so.
    const upToDate = renderReleaseGroup({ ...beta.release, current: { ...beta.release.current, release: DEMO_NEWEST_RELEASE }, rollBackTo: null });
    assert.match(upToDate, /data-release-action="newest" disabled>Move to Newest/);
    assert.match(upToDate, /It runs the newest release\./);
    assert.match(upToDate, /No earlier release to roll back to\./);
    // The newest unreadable: said, and Move to Newest greyed.
    const blind = renderReleaseGroup({ ...beta.release, newest: null, newestProblem: 'git ls-remote failed: offline' });
    assert.match(blind, /The newest release could not be read: git ls-remote failed: offline/);
    assert.match(blind, /data-release-action="newest" disabled/);
    // A button's outcome shows beside the buttons.
    assert.match(renderReleaseGroup(beta.release, { ok: false, text: 'Not saved: no' }), /<span class="note error">Not saved: no<\/span>/);

    // Roll Back on the demo: release-2 back to release-1.
    const back = await fetch(`${url}/releases/beta/back`, { method: 'POST', headers: { authorization: `Bearer ${seed.token}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(back.status, 200);
    assert.equal((await get('/pipeline-controls/beta')).release.current.release, 'release-1');
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Pipeline Controls on the Settings page: each control with its value, "default" while it has it, the not-yet line naming its slice, and the change log in Mountain time (SP-224)', async () => {
  const f = await fixture();
  try {
    const { body } = await f.call('GET', '/pipeline-controls');
    const alpha = body.projects.find((p) => p.project.slug === 'alpha');
    assert.equal(alpha.canChange, true);
    assert.ok(alpha.controls.every((c) => c.isDefault), 'the demo leaves every control on its default');
    assert.deepEqual(alpha.changes.map((c) => [c.actorName, c.label, c.from, c.to]), [['Dane', 'work-in-progress cap', '3', '5'], ['Dane', 'work-in-progress cap', '5', '3']]);
    const html = renderPipelineControls(alpha);
    assert.match(html, /<h3>Alpha<\/h3>/);
    for (const title of ['Wake Times', 'Pause and Resume', 'Work-in-Progress Cap', 'Model per Lane', 'Change Log']) assert.match(html, new RegExp(`<h4>${title}</h4>`));
    // Every group is wired now (SP-238 the cap, SP-239 the models): no not-yet line at all.
    assert.doesNotMatch(html, /Saved, but the lanes do not use this yet/);
    assert.doesNotMatch(html, /\(SP-23[89]\)/);
    assert.match(html, /Claude&#39;s default<span class="in-effect">Last pass ran on: not known on this machine yet\.<\/span>/);
    assert.equal(alpha.capInFlight.count, alpha.capInFlight.ids.length);
    assert.match(html, new RegExp(`<tr data-control="wip-cap"[\\s\\S]*?<span class="in-flight[^"]*">${alpha.capInFlight.count} in flight now`));
    // The lanes use the wake times (SP-236): no not-yet line, and each says what its lane last used.
    assert.doesNotMatch(html, /SP-236/);
    assert.match(html, /1,800 seconds \(Every 30 minutes\)<span class="in-effect">Last used: not known on this machine yet\.<\/span>/);
    // The pause switches are wired in (SP-237): no not-yet line, and no drain line while nothing is paused.
    assert.doesNotMatch(html, /\(SP-237\)/);
    assert.doesNotMatch(html, /Draining|Paused: nothing in flight/);
    assert.match(html, /<tr data-control="wake\.loop-build" data-kind="seconds">[\s\S]*?loop-build wake time<\/label> <span class="default">default<\/span>[\s\S]*?type="number" min="60" max="86400" step="1" value="1800"[\s\S]*?1,800 seconds \(Every 30 minutes\)[\s\S]*?<button type="button">Save<\/button>/);
    assert.match(html, /<option value="default" selected>Claude&#39;s default<\/option>/);
    assert.match(html, /<option value="off" selected>Off<\/option><option value="on">On<\/option>/);
    assert.match(html, /<td>Dane<\/td><td>work-in-progress cap<\/td><td>3<\/td><td>5<\/td>/);
    assert.match(html, /M[SD]T<\/td>/, 'the times are Mountain time');

    // Another reader sees the values, locked, and who may change them.
    const locked = renderPipelineControls({ ...alpha, canChange: false });
    assert.doesNotMatch(locked, /<button/);
    assert.match(locked, /type="number"[^>]*disabled/);
    assert.match(locked, /Only Dane, the project's operator, may change these\./);
    // A Save's outcome shows beside its control.
    assert.match(renderPipelineControls(alpha, { 'wip-cap': { ok: false, text: 'Not saved: too small' } }), /<span class="note error">Not saved: too small<\/span>/);
    assert.match(renderPipelineControls({ ...alpha, changes: [] }), /No changes yet\./);

    // The demo's loop may read them, never change them.
    const loopToken = f.store.issueToken(f.loop.id);
    assert.equal((await f.call('PUT', '/pipeline-controls/alpha', { token: loopToken, body: { setting: 'wake.loop-build', value: '900' } })).status, 403);
    const saved = await f.call('PUT', '/pipeline-controls/alpha', { body: { setting: 'wake.loop-build', value: '900' } });
    assert.equal(saved.status, 200, saved.text);
    assert.match(renderPipelineControls(saved.body), /<td>Dane<\/td><td>loop-build wake time<\/td><td>1800<\/td><td>900<\/td>/);
  } finally { await f.cleanup(); }
});

test('each model on the Settings page says what its lane\'s last pass ran on, read from the lane\'s START line, and says plainly while the next pass has yet to pick up a change (SP-239)', async () => {
  const f = await fixture();
  try {
    const lanes = [{ job: 'loop-review', model: 'claude-opus-5-5' }, { job: 'loop-build', model: 'default' }, { job: 'loop-intake', model: null }, { job: 'relay', model: null }];
    const view = pipelineControlsOf(f.store, 'alpha', { lanes });
    const lastOf = (key) => view.controls.find((c) => c.key === key).lastModel;
    assert.deepEqual(['model.loop-review', 'model.loop-build', 'model.loop-intake'].map(lastOf), ['claude-opus-5-5', 'default', null]);
    assert.equal(lastOf('wip-cap'), undefined);
    const html = renderPipelineControls(view);
    assert.match(html, /data-control="model\.loop-build"[\s\S]*?<span class="in-effect">In effect: the last pass ran on Claude&#39;s default\.<\/span>/);
    assert.match(html, /data-control="model\.loop-review"[\s\S]*?<span class="in-effect waiting">Last pass ran on: Opus 5\.5\. The lane&#39;s next pass picks this up\.<\/span>/);
    assert.match(html, /data-control="model\.loop-intake"[\s\S]*?<span class="in-effect">Last pass ran on: not known on this machine yet\.<\/span>/);
    const models = view.models;
    assert.equal(modelLastPassText({ value: 'claude-opus-5-5', lastModel: 'claude-opus-5-5' }, models), 'In effect: the last pass ran on Opus 5.5.');
    assert.equal(modelLastPassText({ value: 'default', lastModel: 'claude-x-9' }, models), 'Last pass ran on: claude-x-9. The lane\'s next pass picks this up.');
  } finally { await f.cleanup(); }
});

test('each wake time on the Settings page says what its lane last used, and says plainly while the lane has not picked up the set value (SP-236)', async () => {
  const f = await fixture();
  try {
    const alpha = (await f.call('GET', '/pipeline-controls')).body.projects.find((p) => p.project.slug === 'alpha');
    const withUsed = (key, used) => ({ ...alpha, controls: alpha.controls.map((c) => (c.key === key ? { ...c, value: '600', isDefault: false, used, inEffect: used == null ? null : String(used) === '600' } : c)) });
    const waiting = renderPipelineControls(withUsed('wake.loop-build', 1800));
    assert.match(waiting, /600 seconds \(Every 10 minutes\)<span class="in-effect waiting">Last used: 1,800 seconds\. Waiting for the lane&#39;s next pass to pick this up\.<\/span>/);
    const taken = renderPipelineControls(withUsed('wake.loop-build', 600));
    assert.match(taken, /<span class="in-effect">In effect: the lane last used 600 seconds\.<\/span>/);
    assert.doesNotMatch(taken, /Waiting for the lane/);
    assert.equal(wakeInEffectText({ used: null, inEffect: null }), 'Last used: not known on this machine yet.');
    // Only the wake times and the models (SP-239) say it.
    assert.equal((taken.match(/class="in-effect/g) || []).length, 4 + 3);
    assert.equal((taken.match(/Last used:|In effect: the lane/g) || []).length, 4);
  } finally { await f.cleanup(); }
});

test('the Settings page draws Pipeline Controls from the server and says Saved only when the stored value read back is the one sent (SP-224)', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('async function drawSettings'), app.indexOf('/**\n * The Users page'));
  assert.match(draw, /await api\('GET', '\/pipeline-controls'\)/);
  assert.match(draw, /<h2>Pipeline Controls<\/h2>/);
  assert.match(draw, /await api\('PUT', `\/pipeline-controls\/\$\{encodeURIComponent\(slug\)\}`, \{ setting: key, value: sent \}\);\s*\/\/ Read back before saying it worked/);
  assert.match(draw, /if \(stored !== sent \|\| answer\.saved\?\.to !== sent\) throw/);
  assert.match(draw, /text: `Not saved: \$\{err\.message\}`/);
});

test('controlValueText and mountainTime say a control and a time in words', () => {
  assert.equal(controlValueText({ kind: 'seconds', value: '900' }), '900 seconds (Every 15 minutes)');
  assert.equal(controlValueText({ kind: 'switch', value: 'on' }), 'On');
  assert.equal(controlValueText({ kind: 'model', value: 'x' }, [{ id: 'x', label: 'Model X' }]), 'Model X');
  assert.equal(mountainTime('2026-11-12T13:48:00Z'), 'Nov 12, 2026, 6:48 AM MST');
  assert.equal(mountainTime('2026-07-01T18:00:00Z'), 'Jul 1, 2026, 12:00 PM MDT');
  assert.equal(mountainTime('nope'), '–');
});

test('npm run clickup -- settings prints every control as name=value, defaults included, and exits non-zero saying why when it cannot read them (SP-224)', async () => {
  const f = await fixture();
  try {
    f.store.setPipelineSetting({ project: 'alpha', setting: 'wake.loop-build', value: '900', actor: f.operator.id });
    const r = await f.door('alpha', 'settings');
    assert.equal(r.code, 0, r.err);
    const lines = r.out.trim().split('\n');
    assert.equal(lines.length, f.store.pipelineSettings('alpha').length);
    assert.ok(lines.every((l) => /^[a-z.-]+=[^\s]+$/.test(l)), r.out);
    for (const l of ['wake.loop-build=900', 'wake.relay=600', 'paused=off', 'wip-cap=5', 'model.loop-review=default']) assert.ok(lines.includes(l), l);
    assert.match(r.err, /13 pipeline control\(s\) for alpha, 1 changed from the default/);
    const missing = await f.door('nope', 'settings');
    assert.equal(missing.code, 1);
    assert.equal(missing.out, '');
    assert.match(missing.err, /read the pipeline controls FAILED — HTTP 404/);
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
  const nav = /<nav class="site" hidden>([\s\S]*?)<\/nav>/.exec(html)[1];
  assert.deepEqual([...nav.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1]), ['Projects', 'Tasks', 'Reporting', 'Users', 'Docs', 'Settings']);
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

test('the main menu shows only to someone signed in: hidden in the page, shown with "Signed in as", hidden on every signed-out view (SP-211)', () => {
  const html = readFileSync(WEB('index.html'), 'utf8');
  // Starts hidden, so it never shows during "Loading…" before the sign-in check answers.
  assert.match(html, /<nav class="site" hidden>/);
  assert.doesNotMatch(html, /<nav class="site">/);
  // The wordmark stays visible to everyone.
  assert.match(html, /<a class="brand" href="\/"><img src="\/web\/wordmark\.png"/);
  assert.doesNotMatch(/<a class="brand"[^>]*>/.exec(html)[0], /hidden/);
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(app, /const siteNav = document\.querySelector\('header nav\.site'\);/);
  // Shown in the same place as "Signed in as", once /me has answered.
  const route = /async function route\(\{ place = null \} = \{\}\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(route, /me = await api\('GET', '\/me'\);[\s\S]*?who\.textContent = `Signed in as \$\{me\.name\}`;\s*signOut\.hidden = false;\s*bell\.hidden = false;\s*siteNav\.hidden = false;/);
  assert.equal((app.match(/siteNav\.hidden = false;/g) ?? []).length, 1, 'shown in one place only');
  // Hidden on the sign-in screen, Forgot password, after Sign Out or an expired sign-in (all through signedOutHeader), and on Set Your Password.
  assert.match(/function signedOutHeader[\s\S]*?\n\}/.exec(app)[0], /siteNav\.hidden = true;/);
  assert.match(/async function drawSetPassword\(\) \{[\s\S]*?\n\}/.exec(app)[0], /siteNav\.hidden = true;/);
  assert.match(/function drawSignIn[\s\S]*?\n\}/.exec(app)[0], /signedOutHeader\(/);
  assert.match(/function drawForgot[\s\S]*?\n\}/.exec(app)[0], /signedOutHeader\(/);
  assert.match(app, /signOut\.addEventListener\('click', async \(\) => \{[\s\S]*?drawSignIn\(/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /header nav\.site\[hidden\] \{ display: none; \}/, 'display: flex must not undo hidden');
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
  assert.match(app, /redrawHold\(\{ hidden: document\.hidden, drawing: drawing > 0, writing: writing > 0, dialog: Boolean\(main\.querySelector\('dialog\[open\]'\)\), fields: fieldsOf\(main\) \}\)/);
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
  assert.equal((app.match(/await drawAgain\(\(\) => draw(Ticket|Project)\(/g) ?? []).length, 6, "SP-208 added the List view priority save");
  assert.match(route, /if \(place && !\(err instanceof SignedOut\)\) return;/, "a beat's failed draw does not replace the page with an error");
  assert.match(app, /if \(location\.hash === '#reply' && !refreshing\) \{/, 'a beat does not jump to the reply box again');
  assert.match(/function keepPlace\(\) \{[\s\S]*?\n\}/.exec(app)[0], /main\.querySelectorAll\('details'\)[\s\S]*window\.scrollTo\(0, y\);/);
  // Every GET of a draw is kept; a write counts as a save under way until it answers.
  const api = /async function api\(method, path, body, \{ unrecorded = false \} = \{\}\) \{[\s\S]*?\n\}/.exec(app)[0];
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
  const page = /main\.innerHTML = `\s*<section class="quick">([\s\S]*?)<\/section>\s*(?:\$\{renderFilesMade\(t\)\}\s*)?<details class="details">([\s\S]*?)<\/details>`;/.exec(app);
  assert.ok(page, 'Quick Action first, then Details');
  const [, quick, details] = page;
  assert.match(quick, /renderQuickAction\(t\)/);
  assert.match(quick, /\$\{renderReplyForm\(t, me\?\.name\)\}/, 'the reply box is on the right of Quick Action');
  assert.match(renderReplyForm({}, 'Dane'), /<form class="reply">[\s\S]*<label for="reply">Reply as Dane<\/label>[\s\S]*<textarea id="reply" required>/);
  assert.match(details, /^\s*<summary>Details<\/summary>/);
  // The status line, the description and the comments, all inside Details.
  for (const part of [/statusLabel\(t\)/, /renderMarkdown\(t\.description\)/, /\$\{comments \|\|/]) assert.match(details, part);
  assert.ok(!/<details class="details"[^>]*\bopen\b/.test(app), 'Details is never drawn open');
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
  assert.equal(html, [
    '<h1>his words</h1>',
    '<p class="ticket-name quiet">Ticket name: Fix it</p>',
    '<h2 class="request-heading">Original Request</h2>',
    '<p class="original-request">his words</p>',
    '<h2 class="request-heading">How the Loop Understood It</h2>',
    '<p class="summary">Open a ticket and see it.</p>',
  ].join('\n'));
  // A ticket with no ## Asked block is drawn as it always was.
  assert.equal(renderQuickAction({ name: 'Fix it', description: '## Goal\nOpen a ticket and\nsee it.\n\nMore.' }),
    '<h1>Fix it</h1>\n<p class="summary">Open a ticket and see it.</p>');
  assert.equal(renderQuickAction({ name: 'Empty', description: '' }), '<h1>Empty</h1>');
  assert.equal(firstParagraph('- a list\n\nProse.'), 'Prose.');
});

// ── Quick Action: his original request first (SP-213) ────────────────────────

test('originalRequest reads his title and words off the ## Asked fence, whatever the fence', () => {
  const words = 'In the attached screenshot there is no reference.\n\n> a quoted line\n`code` and *stars*';
  for (const fence of ['```', '~~~', '````', '~~~~~']) {
    const description = `## Asked\n${fence}\nShow the prompt\n\n${words}\n${fence}\nAttached: shot.png\n\n## Goal\nThe goal.`;
    assert.deepEqual(originalRequest(description), { title: 'Show the prompt', words, slicedFrom: null }, fence);
  }
  // A shorter or different run inside his words does not close a four-backtick fence.
  assert.equal(originalRequest('## Asked\n````\nTitle\n\nsee ```this```\n```\nstill his\n````\n').words, 'see ```this```\n```\nstill his');
  // A one-line request is both the title and the words.
  assert.deepEqual(originalRequest('## Asked\n```\nmake the board easier to read\n```\n'), { title: 'make the board easier to read', words: 'make the board easier to read', slicedFrom: null });
  // Windows line ends read the same.
  assert.equal(originalRequest('## Asked\r\n```\r\nT\r\n\r\nw\r\n```\r\n').words, 'w');
  // No block, an unclosed fence, no fence, an empty fence, or "## Asked" inside another fence: null.
  for (const d of ['', '## Goal\nx', '## Asked\n```\nTitle\n\nnever closed', '## Asked\nplain text\n', '## Asked\n```\n```\n', '```\n## Asked\n~~~\nx\n~~~\n```\n', null, undefined]) {
    assert.equal(originalRequest(d), null, JSON.stringify(d));
  }
  // A slice names the ticket it was cut from.
  const slice = '## Asked\n```\nT\n\nw\n```\n\n## Order\nSliced from SP-217 ("The bell"), slice 2 of 2.\nWaits on: SP-217\n\n## Goal\ng';
  assert.equal(originalRequest(slice).slicedFrom, 'SP-217');
  // "Sliced from" in another section is not a slice.
  assert.equal(originalRequest('## Asked\n```\nT\n```\n\n## Goal\nSliced from SP-9').slicedFrom, null);
});

test('Quick Action puts his title and words first, the loop\'s reading after, and a slice links back (SP-213)', () => {
  const sixty = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
  const card = machineComment.stripMachineMarker(machineComment.stampMachineComment(operatorCard.buildCard(
    `@@ASKED\nx\n@@CONTEXT\n${sixty}\n@@NEEDED\nReply "go".\nYour move: Reply — "go".`).rendered));
  const description = '## Asked\n```\nTask Details needs the prompt\n\nLine one <b>\n> quoted\n`tick` *star*\n```\n\n## Order\nSliced from SP-196 ("x"), slice 1 of 2.\n\n## Goal\nThe goal.';
  const html = renderQuickAction({ name: 'Show the original request on Task Details', description, status: 'needs your input', comments: [{ body: card }] });
  const order = ['<h1>Task Details needs the prompt</h1>', 'Ticket name: Show the original request on Task Details',
    'Original Request', 'class="original-request"', 'Sliced from <a href="/t/SP-196">SP-196</a>', 'How the Loop Understood It',
    'class="summary">w0', 'class="needed"'];
  let at = -1;
  for (const part of order) { const next = html.indexOf(part); assert.ok(next > at, `${part} comes next`); at = next; }
  // His words drawn as typed: escaped, never Markdown.
  assert.match(html, /<p class="original-request">Line one &lt;b&gt;\n&gt; quoted\n`tick` \*star\*<\/p>/);
  assert.doesNotMatch(html, /<code>|<em>|<blockquote>|<b>/);
  // The same name as his title: no Ticket name line, and no slice line without ## Order.
  const same = renderQuickAction({ name: 'Fix it', description: '## Asked\n```\nFix it\n\nplease\n```\n', status: 'queued' });
  assert.doesNotMatch(same, /Ticket name:|Sliced from|How the Loop/);
  assert.match(same, /^<h1>Fix it<\/h1>\n<h2 class="request-heading">Original Request<\/h2>\n<p class="original-request">please<\/p>\n<p class="where quiet">/);
  // His words keep their line breaks on the page.
  assert.match(readFileSync(WEB('app.css'), 'utf8'), /\.quick \.original-request \{[^}]*white-space: pre-wrap/);
  // The tab title is still the ticket's current name.
  assert.match(readFileSync(WEB('app.mjs'), 'utf8'), /tabTitle\(/);
});

test('every word of his original request in Quick Action is escaped', () => {
  const nasty = '<script>alert(1)</script>';
  const html = renderQuickAction({ name: nasty, description: `## Asked\n\`\`\`\n${nasty}\n\n${nasty}\n\`\`\`\n\n## Order\nSliced from SP-1\n` });
  assert.doesNotMatch(html, /<script/);
  assert.equal(html.match(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/g).length, 2, 'title and words; the name matches the title so is not repeated');
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
  assert.match(quick, /\$\{renderCommands\(t\)\}[\s\S]*\$\{renderReplyForm\(t, me\?\.name\)\}/, 'the commands sit on the right, above the reply box');
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

// ── SP-169: commands written mid-sentence, and an ask laid out in steps ──────

/** SP-23's card as the tracker holds it (comment 1716), word for word. */
const SP23_CARD = [
  "**DANE'S WORDS — the instruction behind this ticket**",
  '',
  '```',
  'a wizard copy now is fine for now',
  '```',
  "*(2026-11-08, quoted in this ticket's Goal)*",
  '',
  "**WHAT'S GOING ON**",
  '',
  'Everything this move waits on is finished, so WaveCenter can now leave ClickUp for the tracker. The ticket itself says a loop must not do it: the setup wizard\'s first step stops WaveCenter\'s lanes and the move runs on the Mini, so an unattended pass would cut itself off halfway. It needs a session started by hand on the Mini, which runs `npm run onboard -- --product wavecenter` and answers that WaveCenter is already on ClickUp. Nothing was built and nothing in ClickUp changed.',
  '',
  '**#############################**',
  '**NEEDED FROM DANE: A decision that is genuinely yours: when to switch WaveCenter\'s pipeline over (the risk is high; switching back is documented in docs/TRACKER_MVP.md). Options:**',
  '**A) "go now": you start a Claude session by hand on the Mini, in Spirality\'s folder, and ask it to run SP-23. The session runs every command; you merge the wizard\'s pull request in WaveCenter afterwards, as always.**',
  '**B) "later": name a time and it waits here.**',
  '**Your move: Reply "go now" or a time, because only a session you start by hand can make this move.**',
  '**#############################**',
].join('\n');

test('SP-23\'s card: the command in its WHAT\'S GOING ON gets a Copy box, and stays in the sentence', () => {
  assert.deepEqual(cardCommands(SP23_CARD), ['npm run onboard -- --product wavecenter']);
  const html = renderCommands({ comments: [{ body: SP23_CARD }] });
  assert.deepEqual(codes(html), ['npm run onboard -- --product wavecenter'], 'Copy copies exactly that text');
  assert.equal(html.match(/class="copy-command">Copy</g).length, 1);
  const quick = renderQuickAction({ name: 'SP-23', description: '', status: 'needs your input', comments: [{ body: SP23_CARD }] });
  assert.match(quick, /<p class="summary">[^]*which runs <code>npm run onboard -- --product wavecenter<\/code> and answers/);
});

test('SP-23\'s red ask: Options: starts a new paragraph, each option and Your move on a line of its own', () => {
  const quick = renderQuickAction({ name: 'SP-23', description: '', status: 'needs your input', comments: [{ body: SP23_CARD }] });
  const needed = [...quick.matchAll(/<p class="needed">([\s\S]*?)<\/p>/g)].map((m) => m[1].split('<br>'));
  assert.equal(needed.length, 2);
  assert.deepEqual(needed[0], ['A decision that is genuinely yours: when to switch WaveCenter&#39;s pipeline over (the risk is high; switching back is documented in docs/TRACKER_MVP.md).']);
  assert.equal(needed[1].length, 4);
  assert.equal(needed[1][0], 'Options:');
  assert.match(needed[1][1], /^A\) &quot;go now&quot;/);
  assert.match(needed[1][2], /^B\) &quot;later&quot;/);
  assert.match(needed[1][3], /^Your move: Reply/);
});

test('an ask with its options run together on one line reads one option per line', () => {
  assert.deepEqual(askParagraphs('Pick where it runs. Options: A) the Mini. B) a hosted server. C) wait. Your move: Reply — A, B or C.'), [
    ['Pick where it runs.'],
    ['Options:', 'A) the Mini.', 'B) a hosted server.', 'C) wait.', 'Your move: Reply — A, B or C.'],
  ]);
  // Without the word Options:, a run of two or more still splits.
  assert.deepEqual(askParagraphs('Reply A) yes or B) no.'), [['Reply', 'A) yes or', 'B) no.']]);
  // Lines already split stay as written; a lone "plan B)" in a sentence is no list.
  assert.deepEqual(askParagraphs('Reply A or B.\nA is cheaper.\nYour move: Reply — new.'), [['Reply A or B.', 'A is cheaper.', 'Your move: Reply — new.']]);
  assert.deepEqual(askParagraphs('Keep plan B) in mind.\nYour move: Reply — ok.'), [['Keep plan B) in mind.', 'Your move: Reply — ok.']]);
  // Nothing inside inline code or a fenced block is cut.
  assert.deepEqual(askParagraphs('Run `echo "Options: A) x B) y"` now. Your move: Reply — done.'), [['Run `echo "Options: A) x B) y"` now.', 'Your move: Reply — done.']]);
  assert.deepEqual(askParagraphs('Run:\n```\necho A) x B) y Options: z\n```\nYour move: Reply — done.'), [['Run:', '```', 'echo A) x B) y Options: z', '```', 'Your move: Reply — done.']]);
});

test('inline code that is not a command gets no Copy box; a command fenced and inline gets one', () => {
  for (const text of ['docs/TRACKER_MVP.md', 'Waits on:', 'git', 'npm', 'Building', 'scripts/']) assert.equal(isCommand(text), false, text);
  for (const text of ['npm run verify', 'git status', 'gh pr view 7', 'scripts/install_loop_runner.sh --status', 'scripts/foo.sh', 'launchctl list']) assert.equal(isCommand(text), true, text);
  const needed = 'See `docs/TRACKER_MVP.md` and the `Waits on:` line, then run `npm run verify`:\n```\nnpm run verify\n```\nthen `git status`.';
  for (const body of Object.values(commandCards(needed))) {
    assert.deepEqual(cardCommands(body), ['npm run verify', 'git status'], 'the fenced one first, each once');
    assert.equal(renderCommands({ comments: [{ body }] }).match(/class="copy-command"/g).length, 2);
  }
  // A context command and the same command in the ask: one box.
  const sixty = Array.from({ length: 58 }, (_, i) => `w${i}`).join(' ');
  const body = machineComment.stripMachineMarker(operatorCard.buildCard(
    `@@ASKED\nbuild it\n@@CONTEXT\n${sixty} run \`npm run doctor\`\n@@NEEDED\nRun \`npm run doctor\` then reply.\nYour move: Reply — done.`).rendered);
  assert.deepEqual(cardCommands(body), ['npm run doctor']);
});

test('an inline command reaches the Copy box escaped', () => {
  const nasty = 'npm run x -- "<script>alert(1)</script>" & <img src=x onerror=y>';
  const body = commandCards(`Run \`${nasty}\` then reply.`).plain;
  const html = renderCommands({ comments: [{ body }] });
  assert.doesNotMatch(html, /<script|<img/);
  assert.deepEqual(codes(html), [nasty]);
  const quick = renderQuickAction({ name: 'x', description: '', status: 'needs your input', comments: [{ body }] });
  assert.doesNotMatch(quick, /<script|<img/);
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
      operator: null, members: [{ id: f.operator.id, name: 'Dane' }],
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
  // SP-127: the Projects page's button is Set up a project; the bare form is a link on its page.
  assert.match(app, /me\?\.kind === 'human' \? '<div class="toolbar"><a class="button" href="\/setup\/new">Set Up a Project<\/a><\/div>' : ''/);
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
      operator: null, members: [{ id: f.operator.id, name: 'Dane' }],
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
  assert.match(app, /\$\{renderCloseAction\(t\)\}\s*\$\{renderGoAction\(t\)\}\s*\$\{renderReplyForm\(t, me\?\.name\)\}/, 'Go sits between Close and the reply box');
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
  assert.match(app, /<div class="act">\s*(?:\$\{renderCommands\(t\)\}\s*)?\$\{renderAnswerIn\(t\)\}\s*\$\{renderMergeAction\(t\)\}\s*\$\{renderCloseAction\(t\)\}\s*\$\{renderGoAction\(t\)\}\s*\$\{renderReplyForm\(t, me\?\.name\)\}/, 'the answer-is-in line, then Merge, Close and Go, sit above the reply box on the right');
});

test('after a reply, Merge, Close or Go posts, the page stays at the top with no confirmation box', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const html = readFileSync(WEB('index.html'), 'utf8');
  const css = readFileSync(WEB('app.css'), 'utf8');
  // No posted box: the redrawn page is the confirmation. (Other boxes, such
  // as the Add Task "right project?" question, are separate and stay.)
  assert.doesNotMatch(html, /id="posted"|posted-text/);
  assert.doesNotMatch(css, /dialog#posted/);
  assert.doesNotMatch(app, /getElementById\('posted'\)|posted\.showModal/);
  // One helper: Details open, the page at the top.
  const helper = /const afterPost = \(\) => \{([\s\S]*?)\n  \};/.exec(app)?.[1];
  assert.ok(helper, 'one shared helper');
  assert.match(helper, /details\.details'\)\.open = true;\s*window\.scrollTo\(0, 0\);\s*$/);
  assert.doesNotMatch(helper, /showModal/, 'the helper opens no box');
  // Nothing scrolls to the last comment any more.
  assert.doesNotMatch(app, /\.comment:last-of-type/);
  // The reply box and the word buttons both call it after the redraw, inside the try, so a failure never does.
  const word = /const wordButton = \(selector, question, word, signedOut\) => \{([\s\S]*?)\n  \};/.exec(app)?.[1];
  const reply = /\{ body: box\.value \}\);([\s\S]*?)\n  \}\);\n\}/.exec(app)?.[1];
  for (const [name, body] of [['word buttons', word], ['reply box', reply]]) {
    assert.ok(body, name);
    assert.match(body, /await drawAgain\(\(\) => drawTicket\(t\.id\)\);\s*afterPost\(\);\s*\} catch \(err\) \{/, name);
    assert.doesNotMatch(body.split('catch (err)')[1], /afterPost/, `${name}: the page does not jump on failure`);
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

// ── Changing a ticket's priority from the List view (SP-208) ───────────────

test('a List row\'s priority is a dropdown of Urgent, High, Normal, Low with the ticket\'s own selected; "None" only while it has none', () => {
  const set = renderListPriority({ id: 'SP-12', priority: 'normal' });
  assert.match(set, /^<select class="list-priority" data-priority-of="SP-12" aria-label="Priority of SP-12">/);
  const options = [...set.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)].map((m) => [m[1], m[3], Boolean(m[2])]);
  assert.deepEqual(options, [['urgent', 'Urgent', false], ['high', 'High', false], ['normal', 'Normal', true], ['low', 'Low', false]]);
  assert.match(set, /<span class="note" data-priority-note="SP-12" role="status"><\/span>$/, 'a note beside it for Saving…, Saved or a refusal');
  const none = renderListPriority({ id: 'SP-13', priority: null });
  assert.match(none, /<select[^>]*><option value="" selected>None<\/option><option value="urgent">Urgent<\/option>/);
  assert.equal((none.match(/selected/g) || []).length, 1);
  assert.deepEqual(PRIORITY_ORDER, [...PRIORITIES], 'the same choices the Change panel offers');
  assert.match(renderListPriority({ id: '<b>', priority: 'low' }), /data-priority-of="&lt;b&gt;"/);
});

test('the List view draws the dropdown in every row; the Board view\'s Live rows and cards stay as text', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('async function drawProject('), app.indexOf('async function copyText'));
  assert.match(draw, /<td class="priority">\$\{view === 'list' \? renderListPriority\(t\) : t\.priority \? escapeHtml\(statusName\(t\.priority\)\)/);
  const card = /const card = \(t\) => `([\s\S]*?)`;/.exec(app)[1];
  assert.doesNotMatch(card, /select|renderListPriority/);
  assert.match(draw, /wireListPriorities\(slug, view, board, said\);/);
});

test('picking a priority sends only it with the board\'s version, holds the dropdowns, and says Saved, moved or the server\'s words', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const wire = /function wireListPriorities\(slug, view, board, said\) \{([\s\S]*?)\n\}/.exec(app)?.[1];
  assert.ok(wire, 'the dropdowns are wired');
  assert.match(wire, /api\('PATCH', `\/tickets\/\$\{encodeURIComponent\(id\)\}`, \{ priority: select\.value, ifVersion: t\.version \}\)/);
  assert.match(wire, /for \(const c of held\) c\.disabled = true;\s*note\.className = 'note quiet';\s*note\.textContent = 'Saving…';/);
  assert.match(wire, /after = \{ id, text: 'Saved' \};/);
  assert.match(wire, /err instanceof Refused && err\.status === 409\) \{\s*after = \{ id, text: MOVED_MESSAGE, error: true \};/, 'a 409 redraws as stored, with the moved message');
  assert.match(wire, /note\.textContent = `Not saved: \$\{err\.message\}`;\s*select\.value = before;\s*for \(const c of held\) c\.disabled = false;/, 'any other refusal puts the old value back');
  assert.match(wire, /await drawAgain\(\(\) => drawProject\(slug, view, \{ said: after \}\)\);/);
});

test('a priority picked through the page\'s save shows on the board and on the ticket; an old version is refused and changes nothing', async () => {
  const f = await fixture();
  try {
    const rows = () => f.call('GET', '/projects/alpha/board').then((r) => r.body.columns.flatMap((c) => c.tickets));
    const t = (await rows()).find((r) => r.priority !== 'high');
    assert.ok(t, 'the test data has a ticket that is not High');
    const saved = await f.call('PATCH', `/tickets/${t.id}`, { body: { priority: 'high', ifVersion: t.version } });
    assert.equal(saved.status, 200);
    const after = (await rows()).find((r) => r.id === t.id);
    assert.equal(after.priority, 'high');
    assert.ok(after.version > t.version, 'the redrawn row carries the new version');
    assert.equal(f.store.getTicket(t.id).priority, 'high', 'the ticket page reads the same priority');
    const stale = await f.call('PATCH', `/tickets/${t.id}`, { body: { priority: 'low', ifVersion: t.version } });
    assert.equal(stale.status, 409);
    assert.equal(f.store.getTicket(t.id).priority, 'high');
  } finally { await f.cleanup(); }
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
  assert.match(draw, /const panel = wireEditPanel\(t\);\s*if \(kept\) \{[^}]*const keptBox = main\.querySelector\('form\.reply textarea'\);\s*if \(keptBox\) keptBox\.value = kept\.reply;\s*panel\?\.restore\(kept\);/);
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

test('Reporting: the first table is Task Productivity, Tasks started above Tasks finished, and its note names Started first (SP-230)', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const fn = app.slice(app.indexOf('async function drawReporting('));
  const page = fn.slice(fn.indexOf('<h1>Reporting</h1>'));
  const firstHeading = page.match(/<h2>([^<]*)<\/h2>/);
  assert.equal(firstHeading[1], 'Task Productivity');
  assert.doesNotMatch(app, /Tasks Finished and Started/);
  assert.match(page, /<p class="quiet">Started: filed in that time\. Finished: moved to Live in that time and still Live\.<\/p>/);
  assert.match(page, /<tbody>\$\{line\('Tasks started', r\.started\)\}\$\{line\('Tasks finished', r\.finished\)\}<\/tbody>/);
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

// ── Where the Time Goes (SP-220) ────────────────────────────────────────────

const HOUR = 60 * 60_000;
/** Each bucket's total ms in some stretches. */
const sumBuckets = (stretches) => Object.fromEntries(TIME_BUCKETS.map((b) => [b, stretches.filter((s) => s.bucket === b).reduce((n, s) => n + s.to - s.from, 0)]));

test('Time split: Queued, 1h Building, 2h In review, 3h Ready to launch, his "merge", 30 minutes, Live', () => {
  const t0 = Date.parse('2026-11-01T15:00:00Z');
  const at = (h) => t0 + h * HOUR;
  const steps = [[at(0), 'queued'], [at(5), 'building'], [at(6), 'in review'], [at(8), 'ready to launch'], [at(11.5), 'live']];
  const comments = [
    { at: at(8), byMachine: true, byOperator: false, failure: false }, // the card
    { at: at(11), byMachine: false, byOperator: true, failure: false }, // "merge"
  ];
  const stretches = timeSplitOf(steps, comments, { now: at(30) });
  assert.deepEqual(sumBuckets(stretches), { working: 1 * HOUR, lane: 5 * HOUR + 2 * HOUR + 0.5 * HOUR, operator: 3 * HOUR, broken: 0 });
  // Every second of its life before Live is in exactly one bucket, end to end.
  for (let i = 1; i < stretches.length; i += 1) assert.equal(stretches[i].from, stretches[i - 1].to);
  assert.equal(stretches[0].from, at(0));
  assert.equal(stretches[stretches.length - 1].to, at(11.5), 'Live time is not counted');
});

test('Time split (SP-285): after his "merge", a relay conflict note does not put the time back on him; a new review round does', () => {
  const t0 = Date.parse('2026-11-13T14:00:00Z');
  const at = (h) => t0 + h * HOUR;
  const pass = (h) => ({ at: at(h), byMachine: true, byOperator: false, failure: false, verdict: 'pass' });
  const note = (h) => ({ at: at(h), byMachine: true, byOperator: false, failure: false });
  const merge = (h) => ({ at: at(h), byMachine: false, byOperator: true, failure: false, mergeWord: true });
  // SP-237's day: PASS and card, 1h for him, "merge", relay note 1h later, 3h of catch-up, Live.
  const a = timeSplitOf([[at(0), 'ready to launch'], [at(5), 'live']], [pass(0), note(0), merge(1), note(2)], { now: at(6) });
  assert.deepEqual(sumBuckets(a), { working: 0, lane: 4 * HOUR, operator: HOUR, broken: 0 });
  // A new PASS after his merge (a rebuilt round) is his again until he answers it.
  const b = timeSplitOf([[at(0), 'ready to launch']], [pass(0), merge(1), note(2), pass(3)], { now: at(4) });
  assert.deepEqual(sumBuckets(b), { working: 0, lane: 2 * HOUR, operator: 2 * HOUR, broken: 0 });
  // A merge said before any PASS does not stand.
  const c = timeSplitOf([[at(0), 'ready to launch']], [merge(0), note(1)], { now: at(2) });
  assert.deepEqual(sumBuckets(c), { working: 0, lane: HOUR, operator: HOUR, broken: 0 });
});

test('Time split: a loop\'s failure note with no move for 4 hours is broken, until the next move or his next comment', () => {
  const t0 = Date.parse('2026-11-01T15:00:00Z');
  const at = (h) => t0 + h * HOUR;
  const failed = (h) => ({ at: at(h), byMachine: true, byOperator: false, failure: true });
  // Building for an hour, then loop-build FAILED: and nothing moves for 4 hours, then back to Queued.
  const a = timeSplitOf([[at(0), 'building'], [at(5), 'queued']], [failed(1)], { now: at(6) });
  assert.deepEqual(sumBuckets(a), { working: HOUR, lane: HOUR, operator: 0, broken: 4 * HOUR });
  // In Ready to launch: a failure note, then his reply 2 hours later ends it; his reply is the newest word, so a lane owes the move.
  const b = timeSplitOf([[at(0), 'ready to launch']], [failed(1), { at: at(3), byMachine: false, byOperator: true }], { now: at(4) });
  assert.deepEqual(sumBuckets(b), { working: 0, lane: HOUR, operator: HOUR, broken: 2 * HOUR });
  // A machine's ordinary note does not end it; an open ticket counts up to now.
  const c = timeSplitOf([[at(0), 'in review']], [failed(0), { at: at(1), byMachine: true, byOperator: false }], { now: at(2) });
  assert.deepEqual(sumBuckets(c), { working: 0, lane: 0, operator: 0, broken: 2 * HOUR });
  // A person who is not the operator saying something does not clear his stage's wait.
  const d = timeSplitOf([[at(0), 'needs your input']], [{ at: at(1), byMachine: false, byOperator: false }], { now: at(2) });
  assert.deepEqual(sumBuckets(d), { working: 0, lane: 0, operator: 2 * HOUR, broken: 0 });
});

test('Time split: what counts as a failure note is a line that starts with one', () => {
  for (const text of ['loop-build FAILED: verify exited 1', 'FAILED: step 3', 'relay GAVE UP: after 3 tries', 'Round 2\n**loop-review FAILED:** gh down']) {
    assert.ok(isFailureNote(text), text);
  }
  for (const text of ['The relay logged FAILED: twice', 'nothing failed', '', null, 'GAVE UP: no lane named']) {
    assert.ok(!isFailureNote(text), String(text));
  }
});

test('Reporting time split: every ticket\'s open time in exactly one bucket, a stretch over the range start cut at it, the most time first', () => {
  const r = reportingStore();
  try {
    const dane = r.store.createActor({ kind: 'human', name: 'Dane' });
    r.store.createProject({ slug: 'gamma', name: 'Gamma', prefix: 'GA', operator: dane.id });
    // Queued 10 days ago, Building from 9 to 1 day ago (crosses the 7-day start), Live 1 day ago.
    const long = r.ticket('gamma', 10, [9, 'building'], [1, 'live']);
    // Filed 2 days ago, Ready to launch since 1 day ago, open now: waiting on him.
    const open = r.ticket('gamma', 2, [1, 'ready to launch']);
    // Filed into review 3 days ago, a loop's failure note on it a minute later, still there: broken since.
    const failing = r.filedAs('in review', 'gamma', 3);
    r.store.postComment({ ticket: failing, author: r.loop.id, body: 'loop-review FAILED: gh could not be reached' });
    const { timeSplit } = reportsOf(r.store, { project: 'gamma', now: r.now });
    const week = timeSplit.week;
    const row = (id) => week.tickets.find((t) => t.id === id);
    assert.ok(near(row(long).working, 6), `working cut at the range start: ${row(long).working / DAY}`);
    assert.ok(near(row(long).lane, 0));
    assert.ok(near(timeSplit.all.tickets.find((t) => t.id === long).working, 8));
    assert.ok(near(timeSplit.all.tickets.find((t) => t.id === long).lane, 1), 'its day in Queued');
    assert.ok(near(row(open).operator, 1) && near(row(open).lane, 1));
    assert.ok(row(failing).broken > 0 && near(row(failing).broken + row(failing).lane, 3));
    for (const key of ['week', 'month', 'all']) {
      const t = timeSplit[key];
      for (const x of t.tickets) assert.equal(TIME_BUCKETS.reduce((n, b) => n + x[b], 0), x.total, `${key} ${x.id} adds up`);
      assert.equal(TIME_BUCKETS.reduce((n, b) => n + t.buckets[b].ms, 0), t.total, key);
      assert.ok(Math.abs(TIME_BUCKETS.reduce((n, b) => n + t.buckets[b].share, 0) - 1) < 1e-9, `${key} shares`);
      assert.deepEqual(t.tickets.map((x) => x.total), t.tickets.map((x) => x.total).sort((a, b) => b - a), 'most time first');
    }
    assert.equal(row(long).name, r.store.getTicket(long).name, 'its exact name');
  } finally { r.done(); }
});

test('Reporting time split: a range with nothing open has a zero total and no shares, and lists no tasks', () => {
  const r = reportingStore();
  try {
    r.ticket('alpha', 70, [65, 'live']);
    const { timeSplit } = reportsOf(r.store, { now: r.now });
    assert.equal(timeSplit.week.total, 0);
    assert.deepEqual(timeSplit.week.tickets, []);
    for (const b of TIME_BUCKETS) assert.deepEqual(timeSplit.week.buckets[b], { ms: 0, share: null });
    assert.ok(near(timeSplit.all.buckets.lane.ms, 5));
  } finally { r.done(); }
});

test('the Reporting page draws Where the Time Goes from the server: four buckets by range, its note, a range picker, task links', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('async function drawReporting'), app.indexOf('/**\n * The Settings page'));
  assert.match(draw, /<h2>Where the Time Goes<\/h2>\s*<p class="quiet">[^<]*Working: in Building\.[^<]*Waiting on You:[^<]*Broken:[^<]*Waiting for a Lane:[^<]*In review[^<]*waiting, not broken\.<\/p>/);
  for (const label of ['Working', 'Waiting for a Lane', 'Waiting on You', 'Broken']) assert.match(draw, new RegExp(`'${label}'\\]`), label);
  assert.match(draw, /r\.timeSplit\[g\.key\]/, 'figures per range, from the server');
  assert.match(draw, /<span class="quiet">none in this range<\/span>/, 'nothing open is said in words, never 0 hours');
  assert.match(draw, /<label for="time-split-range">Tasks with the Most Time In<\/label>/);
  assert.match(draw, /<a href="\/t\/\$\{encodeURIComponent\(x\.id\)\}">/, 'each task id links to its page');
  assert.match(draw, /escapeHtml\(x\.name\)/);
  assert.match(draw, /spanOf\(Number\(ms\)\)/, 'durations in the page\'s own wording');
  for (const heading of ['Task', 'Name', 'Total']) assert.match(draw, new RegExp(`<th(?: class="count")?>${heading}</th>`), heading);
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

test('Users is in the header before Docs, served at /users to a browser, and its data needs a sign-in', async () => {
  const html = readFileSync(WEB('index.html'), 'utf8');
  assert.match(html, /<a href="\/users" data-nav="users">Users<\/a>\s*<a href="\/docs" data-nav="docs">Docs<\/a>/);
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

// ── Docs (SP-171) ───────────────────────────────────────────────────────────

test('Docs is in the header between Users and Settings, served at /docs to a browser, and lists the picked project\'s task files', async () => {
  const html = readFileSync(WEB('index.html'), 'utf8');
  assert.match(html, /<a href="\/users" data-nav="users">Users<\/a>\s*<a href="\/docs" data-nav="docs">Docs<\/a>\s*<a href="\/settings" data-nav="settings">Settings<\/a>/);
  const f = await fixture();
  try {
    const page = await fetch(`${f.url}/docs`, { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), html, 'opening /docs directly shows the page, never data or a 404');
    assert.equal((await f.call('GET', '/projects/alpha/attachments', { token: null })).status, 401);
  } finally { await f.cleanup(); }
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(app, /docsPage(?: \|\| docAny)? \? 'docs' :/);
  assert.match(app, /\} else if \(docsPage\) \{\s*await drawDocs\(\);/);
  const draw = app.slice(app.indexOf('async function drawDocs'), app.indexOf('/** Underline the header link'));
  assert.match(draw, /projects\.find\(\(p\) => p\.slug === savedProject\(\)\) \?\? projects\[0\]/, 'the project picked in the header, else the first');
  assert.match(draw, /const listPath = `\/projects\/\$\{encodeURIComponent\(project\.slug\)\}\/attachments`;/);
  assert.match(draw, /api\('GET', listPath\)/);
  assert.match(draw, /`\/tickets\/\$\{encodeURIComponent\(a\.ticket\)\}\/attachments\/\$\{encodeURIComponent\(a\.id\)\}`/, 'downloads use the task\'s own download address');
  assert.match(draw, /download="\$\{escapeHtml\(a\.name\)\}"/);
  assert.match(draw, /<a href="\/t\/\$\{encodeURIComponent\(a\.ticket\)\}">/);
  assert.match(draw, /<h2>Task Files<\/h2>/);
  for (const heading of ['File', 'Task', 'Type', 'Size', 'Added By', 'Added On']) assert.match(draw, new RegExp(`<th>${heading}</th>`), heading);
  assert.match(draw, /No task in .* has a file yet\./, 'an empty project says so in a line');
  assert.doesNotMatch(draw, /\$\{a\.(name|ticketName|addedByName|type)\}/, 'every name is escaped');
});

test('the Docs table adds, renames and removes task files, each read back, a removal confirmed by file and task (SP-177)', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('async function drawDocs'), app.indexOf('/** Underline the header link'));
  // Add File: pick one of the project's tasks and a file; the same upload the New Task form uses.
  assert.match(draw, /\{ tickets \}\] = await Promise\.all\(\[[\s\S]*?api\('GET', `\/projects\/\$\{encodeURIComponent\(project\.slug\)\}\/tickets`\),\s*\]\);/);
  assert.match(draw, /<button type="submit">Add File<\/button>/);
  assert.match(draw, /made = await uploadFile\(ticket, file\)/);
  assert.match(draw, /file\.size > MAX_FILE/, 'too large is said before sending');
  // Rename: the file's name only, an empty one refused on the page before any call.
  assert.match(draw, />Rename<\/button>/);
  assert.match(draw, /if \(!typed\.trim\(\)\) return refused\(null, `Not renamed: a file needs a name/);
  assert.match(draw, /api\('PATCH', `\/tickets\/\$\{encodeURIComponent\(ticket\)\}\/attachments\/\$\{encodeURIComponent\(file\)\}`, \{ name: typed \}\)/);
  // Remove: a confirmation naming the file and its task; cancelled, no call.
  assert.match(draw, />Remove<\/button>/);
  assert.match(draw, /if \(!confirm\(`Remove \$\{name\} from \$\{ticket\} \$\{taskName\}\?[^`]*`\)\) return;\s*button\.disabled = true;/);
  assert.match(draw, /api\('DELETE', `\/tickets\/\$\{encodeURIComponent\(ticket\)\}\/attachments\/\$\{encodeURIComponent\(file\)\}`\)/);
  // Every change is read back from the table's own list before the page says it worked, and a failure is said.
  assert.equal((draw.match(/await listedNow\(\)/g) ?? []).length, 3);
  for (const word of ['Not added', 'Not renamed', 'Not removed']) assert.match(draw, new RegExp(`${word}: \\$\\{err\\.message\\}`), word);
  assert.match(draw, /but it is not in the table when read back/);
  assert.match(draw, /but it reads back as/);
  assert.match(draw, /but it is still listed when read back/);
  assert.doesNotMatch(draw, /\$\{(a|t)\.(name|ticketName|id)\}/, 'every name is escaped');
  // Task Files and Context Documents each have their own line; a change's outcome shows only in the section it came from.
  assert.match(draw, /async function drawDocs\(done = '', problem = '', section = 'files'\)/);
  assert.match(draw, /const fileLine = section === 'files' \? \{ done, problem \} : \{ done: '', problem: '' \};/);
  assert.match(draw, /<p class="note file-note\$\{fileLine\.problem \? ' error' : ' quiet'\}" role="status">\$\{escapeHtml\(fileLine\.problem \|\| fileLine\.done\)\}<\/p>/);
  assert.match(draw, /const note = main\.querySelector\('\.file-note'\);/, 'never the Context Documents line above it');
  assert.match(draw, /drawAgain\(\(\) => drawDocs\(failed \? '' : text, failed \? text : '', 'files'\)\)/);
  assert.match(draw, /wireContextDocs\(project, docsPath, section === 'docs' \? done : '', section === 'docs' \? problem : ''\);/);
  assert.match(draw, /const again = \(text, failed\) => drawDocs\(failed \? '' : text, failed \? text : '', 'docs'\)/);
});

test('the Docs page\'s Context Documents list the project\'s own files, each a download and a Remove button, every name escaped; an empty one says so (SP-176)', () => {
  const words = { size: (n) => `${n} B`, timeOf: (iso) => `at ${iso}` };
  const project = { slug: 'al pha', name: 'Alpha <One>' };
  const html = renderContextDocs({ project, docs: [
    { id: 7, project: 'al pha', name: 'brief "<b>".pdf', type: 'application/pdf', size: 1234, addedByName: 'Dane <D>', createdAt: '2026-11-10T12:00:00Z' },
    { id: 8, project: 'al pha', name: 'notes.txt', type: 'text/plain', size: 2, addedByName: null, createdAt: '2026-11-09T12:00:00Z' },
  ] }, words);
  assert.match(html, /<h2>Context Documents<\/h2>/);
  assert.match(html, /<button type="button" class="upload-doc">Upload Document<\/button><input type="file" class="doc-file" hidden>/, 'one file at a time');
  for (const heading of ['File', 'Type', 'Size', 'Added By', 'Added On']) assert.match(html, new RegExp(`<th>${heading}</th>`), heading);
  assert.match(html, /<a href="\/projects\/al%20pha\/docs\/7" download="brief &quot;&lt;b&gt;&quot;\.pdf">Download<\/a>/, 'always saved, through the project\'s own address');
  assert.match(html, /data-remove-doc="7" data-name="brief &quot;&lt;b&gt;&quot;\.pdf" aria-label="Remove brief &quot;&lt;b&gt;&quot;\.pdf">Remove<\/button>/);
  assert.match(html, /<td class="size">1234 B<\/td>/);
  assert.match(html, /<td class="by">Dane &lt;D&gt;<\/td>/);
  assert.match(html, /<td class="by"><span class="quiet">unknown<\/span><\/td>/);
  assert.match(html, /<td class="when">at 2026-11-10T12:00:00Z<\/td>/);
  assert.ok(html.indexOf('data-doc="7"') < html.indexOf('data-doc="8"'), 'in the order the server lists them (newest first)');
  assert.doesNotMatch(html, /<b>|<One>|<D>/, 'nothing unescaped');
  const empty = renderContextDocs({ project, docs: [] }, words);
  assert.match(empty, /Alpha &lt;One&gt; has no context documents yet\./);
  assert.doesNotMatch(empty, /<table/);
  assert.match(empty, /Upload Document/, 'an empty project can still upload');
});

test('the Docs page uploads one context document as the file itself, asks before removing one, reads the list back, and says when either did not happen (SP-176)', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('async function drawDocs'), app.indexOf('/** Underline the header link'));
  assert.match(draw, /const docsPath = `\/projects\/\$\{encodeURIComponent\(project\.slug\)\}\/docs`;/);
  assert.match(draw, /api\('GET', docsPath\)/);
  assert.ok(draw.indexOf('<h1>Docs</h1>\n    ${docsColumns(`\n    ${renderContextDocs({ project, docs }') > 0 && draw.indexOf('renderContextDocs({ project, docs }') < draw.lastIndexOf('<h2>Task Files</h2>'), 'Context Documents come first, before Task Files (SP-195 moved the docs folder\'s list to the bottom)');
  const wire = draw.slice(draw.indexOf('function wireContextDocs'));
  assert.match(wire, /picker\.files\?\.\[0\]/, 'one file at a time');
  assert.match(wire, /file\.size > MAX_FILE/, 'an 11 MB file is refused before it is sent');
  assert.match(wire, /is over 10 MB\. Upload a smaller file; nothing was saved\./);
  assert.match(wire, /await uploadFile\(null, file, docsPath\);/, 'the same raw-file upload a ticket\'s attachment uses');
  assert.match(wire, /Not uploaded: \$\{err\.message\}/);
  assert.match(wire, /if \(!confirm\(`Remove \$\{name\} from \$\{project\.name\}\? It cannot be brought back\.`\)\) return;/, 'asks first, naming the file; cancelled, nothing is sent');
  assert.ok(wire.indexOf('confirm(') < wire.indexOf("api('DELETE'"), 'asks before it removes');
  assert.match(wire, /await api\('DELETE', `\$\{docsPath\}\/\$\{encodeURIComponent\(id\)\}`\);/);
  assert.match(wire, /Not removed: \$\{err\.message\}/);
  assert.match(wire, /const back = await api\('GET', docsPath\)\.catch\(\(\) => null\);/, 'the removal is read back');
  assert.match(wire, /but \$\{back \? 'it is still listed when read back' : 'the list could not be read back'\}/);
  assert.match(wire, /note\.textContent = text;/, 'the note is text, never HTML');
  const up = /async function uploadFile[\s\S]*?\n\}/.exec(app)[0];
  assert.match(up, /to = `\/tickets\/\$\{encodeURIComponent\(ticketId\)\}\/attachments`/, 'a ticket\'s upload still goes to its own address');
  assert.match(up, /res = await fetch\(to, \{/);
});

test('the Docs page lists Spirality\'s documentation by title above Task Files, and a file opens at /docs/spirality/<path> drawn as Markdown (SP-175)', async () => {
  const f = await fixture();
  try {
    const html = readFileSync(WEB('index.html'), 'utf8');
    const page = await fetch(`${f.url}/docs/spirality/LOOP_CONTRACT.md`, { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), html, 'opening a documentation file directly shows the page');
    const list = await f.call('GET', '/documentation');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.files.find((d) => d.path === 'LOOP_CONTRACT.md'), { path: 'LOOP_CONTRACT.md', title: 'The loop contract' }, 'its first heading, as written');
    assert.equal((await f.call('GET', '/documentation', { token: null })).status, 401);
  } finally { await f.cleanup(); }
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('async function drawDocs'), app.indexOf('/** The page address of a documentation file'));
  assert.match(draw, /api\('GET', '\/documentation'\)/);
  assert.match(draw, /const documentation = renderDocumentation\(files, docAddress\);/, 'each file by its title, linking to its page (SP-195 draws the list in render.mjs)');
  assert.match(app, /const docAddress = \(path\) => `\/docs\/spirality\/\$\{String\(path\)\.split\('\/'\)\.map\(encodeURIComponent\)\.join\('\/'\)\}`/);
  assert.match(app, /\} else if \(docAny\) \{\s*await drawDoc\(docPath\);/, 'any /docs/<name>/<path> draws through drawDoc');
  assert.match(app, /const underDocs = \(\) => \/\^\\\/docs\\\/\[\^\/\]\+\\\/\.\+\$\/\.test\(location\.pathname\);/, 'the same addresses the server serves as the page');
  assert.match(app, /docsPage \|\| docAny \? 'docs' :/, 'a documentation file keeps Docs underlined in the header');
  assert.match(draw, /api\('GET', '\/documentation'\)\.then\(\(r\) => r\.files, \(\) => null\)/, 'a failed documentation call is caught on its own, so Task Files still draws');
  assert.match(renderDocumentation(null, (p) => p), /The reference docs and work log could not be read\./);
  const one = app.slice(app.indexOf('async function drawDoc('), app.indexOf('/** Underline the header link'));
  assert.match(one, /renderMarkdown\(unwrapDoc\(body\)\)/, 'drawn with the ticket page\'s Markdown drawing, never as raw text');
  assert.match(one, /<a href="\/docs">Back to Docs<\/a>/);
  assert.match(one, /<h1>\$\{escapeHtml\(doc\.title\)\}<\/h1>/);
  assert.match(one, /There is no documentation file at/, 'a missing file says so');
  assert.match(one, /if \(!path\) return missing\(location\.pathname\);/, 'an address under /docs the page does not know says the same, never another page');
  // What a contract-like file looks like once drawn: headings, lists and code, not raw text.
  const drawn = renderMarkdown('## Statuses\n\n- Queued\n- Building\n\n```\nnpm run verify\n```\n');
  assert.match(drawn, /<h4>Statuses<\/h4>/);
  assert.match(drawn, /<ul><li>Queued<\/li><li>Building<\/li><\/ul>/);
  assert.match(drawn, /<pre><code>npm run verify<\/code><\/pre>/);
});

test('unwrapDoc joins a documentation file\'s hard-wrapped lines, keeps list items, headings, tables and code as written (SP-175)', () => {
  const text = '# Title\nintro line one\nline two\n\n- **Code rules**: the script\n  does it.\n- Next item\n1. first\n   still first\n\n| a | b |\n| - | - |\n\n```\nkeep\nthese apart\n```\nafter\n---\nend';
  assert.equal(unwrapDoc(text), '# Title\nintro line one line two\n\n- **Code rules**: the script does it.\n- Next item\n1. first still first\n\n| a | b |\n| - | - |\n\n```\nkeep\nthese apart\n```\nafter\n---\nend');
  const drawn = renderMarkdown(unwrapDoc('- **Code rules**: the script\n  does it.\n'));
  assert.equal(drawn, '<ul><li><strong>Code rules</strong>: the script does it.</li></ul>');
  assert.equal(unwrapDoc(''), '');
});

test('unwrapDoc joins a quote\'s lines with their ">" taken off, and never joins a quote onto the text around it (SP-175)', () => {
  const text = 'still the rule:\n> StarCaster still describes a two-account\n> model, where the machine posts. The\n> code does not do that.\nSo every comment\nends here.\n>\n> - a quoted item\n> second para';
  assert.equal(unwrapDoc(text), 'still the rule:\n> StarCaster still describes a two-account model, where the machine posts. The code does not do that.\nSo every comment ends here.\n>\n> - a quoted item second para');
  // The real file: no ">" left in the middle of a sentence once drawn.
  const contract = readFileSync(new URL('../docs/LOOP_CONTRACT.md', import.meta.url), 'utf8');
  for (const line of unwrapDoc(contract).split('\n')) assert.doesNotMatch(line, /\S\s+>\s/, line);
});

// ── Docs: Commands (SP-179) ─────────────────────────────────────────────────

const COMMANDS = [
  { name: 'why-stuck', source: 'Your command', description: 'Find out why a ticket is stuck.', steps: '# Why Stuck\n\n1. Read the ticket.\n2. Say why.\n\n```\nnpm run clickup -- waiting\n```\n' },
  { name: 'loop-review', source: 'Loop skill', description: 'Review the next pull request.', steps: '# Loop: Review\n\n- one\n' },
  { name: 'loop-spec', source: 'Loop skill', description: 'Turn an idea into tickets.', steps: 'x' },
];

test('the Commands search keeps a command whose name or description holds the words typed, case set aside', () => {
  assert.deepEqual(matchCommands(COMMANDS, 'stuck').map((c) => c.name), ['why-stuck']);
  assert.deepEqual(matchCommands(COMMANDS, 'REVIEW').map((c) => c.name), ['loop-review']);
  assert.deepEqual(matchCommands(COMMANDS, 'tickets').map((c) => c.name), ['loop-spec'], 'by what it does, too');
  assert.deepEqual(matchCommands(COMMANDS, '  ').map((c) => c.name), ['why-stuck', 'loop-review', 'loop-spec']);
  const mentions = [{ name: 'loop-build', description: 'then move it to In review' }, { name: 'loop-review', description: 'Check a pull request.' }];
  assert.deepEqual(matchCommands(mentions, 'review').map((c) => c.name), ['loop-review', 'loop-build'], 'a name match comes before a description match');
});

test('the search also matches a command\'s summary and plain explanation (SP-212)', () => {
  const withWords = [
    { name: 'loop-build', source: 'Loop skill', description: 'For Claude Code.', summary: 'Builds the next ticket', about: 'Opens a pull request for approval.' },
    { name: 'loop-spec', source: 'Loop skill', description: 'For Claude Code.', summary: null, about: null },
  ];
  assert.deepEqual(matchCommands(withWords, 'NEXT TICKET').map((c) => c.name), ['loop-build'], 'by the summary');
  assert.deepEqual(matchCommands(withWords, 'approval').map((c) => c.name), ['loop-build'], 'by the explanation');
});

test('a command shows its summary, or the first seven words of its description and "…"; its pop-up its about, or its description (SP-212)', () => {
  assert.equal(commandSummary({ summary: 'Builds the next ticket', description: 'x' }), 'Builds the next ticket');
  assert.equal(commandSummary({ description: 'one two three four five six seven eight nine' }), 'one two three four five six seven…');
  assert.equal(commandSummary({ description: 'Find out why a ticket is stuck.' }), 'Find out why a ticket is stuck.', 'seven words or fewer: as written, no "…"');
  assert.equal(commandAbout({ about: 'Plain words.', description: 'x' }), 'Plain words.');
  assert.equal(commandAbout({ about: null, description: 'The description.' }), 'The description.');
});

test('the Quick Claude Commands list shows only /<name> and its short line, each opening its pop-up; no match and nothing copied yet each say so', () => {
  const html = renderCommandList(COMMANDS, 'review');
  assert.match(html, /<li><a class="command-open" href="\/docs\/commands\/loop-review" data-command="loop-review"><code>\/loop-review<\/code> <span class="command-summary">Review the next pull request\.<\/span><\/a><\/li>/);
  assert.doesNotMatch(html, /Loop skill|Your command/, 'where it comes from waits for the pop-up');
  assert.doesNotMatch(html, /why-stuck|loop-spec/);
  assert.doesNotMatch(html, /not been copied/, 'a copied command is listed, so no such line');
  const long = renderCommandList([{ name: 'x', source: 'Loop skill', description: 'Pick the next claimable task from the queue and build it.', steps: '' }]);
  assert.match(long, /<span class="command-summary">Pick the next claimable task from the…<\/span>/);
  assert.doesNotMatch(long, /and build it/, 'the long description leaves the row');
  assert.match(renderCommandList(COMMANDS, 'zebra'), /No command matches “zebra”\./);
  const skillsOnly = renderCommandList(COMMANDS.filter((c) => c.source === 'Loop skill'));
  assert.match(skillsOnly, /\/loop-review[\s\S]*\/loop-spec/);
  assert.match(skillsOnly, /Your own commands have not been copied here yet: run <code>npm run commands:copy<\/code>/);
  const evil = renderCommandList([{ name: 'x', source: 'Your command', description: '<img src=x onerror=alert(1)>', steps: '' }], '<b>');
  assert.doesNotMatch(evil, /<img|<b>/);
  assert.equal(commandHref('a b'), '/docs/commands/a%20b');
  assert.match(renderCommandList([{ name: 'x', source: 'Loop skill', description: 'Runs `npm run verify` first.', steps: '' }]), /Runs <code>npm run verify<\/code> first\./, 'code in a summary is drawn as code');
});

test('a command\'s pop-up shows its name, source, plain explanation and a link to its steps, escaped (SP-212)', () => {
  const html = renderCommandDetails({ name: 'loop-review', source: 'Loop skill', description: 'For Claude Code.', about: 'Checks the work again.' });
  assert.match(html, /<h2 id="command-details-title"><code>\/loop-review<\/code><\/h2>/);
  assert.match(html, /<p class="quiet">Loop skill<\/p>/);
  assert.match(html, /<p>Checks the work again\.<\/p>/);
  assert.doesNotMatch(html, /For Claude Code/, 'the about line, not the description');
  assert.match(html, /<a href="\/docs\/commands\/loop-review">See All the Steps<\/a>/);
  assert.match(renderCommandDetails({ name: 'mine', source: 'Your command', description: 'My own words.' }), /<p>My own words\.<\/p>/, 'no about line: the description');
  assert.doesNotMatch(renderCommandDetails({ name: '<x>', source: '<s>', description: '<y>' }), /<x>|<s>|<y>/);
});

test('a command\'s own page draws its steps formatted (headings, lists, code) with a Back to Docs link, and escapes its words', () => {
  const html = renderCommandView(COMMANDS[0]);
  assert.match(html, /<h1><code>\/why-stuck<\/code><\/h1>/);
  assert.match(html, /Your command/);
  assert.match(html, /<h\d[^>]*>Why Stuck<\/h\d>/, 'a heading, not "# Why Stuck"');
  assert.match(html, /<ol>[\s\S]*<li>Read the ticket\.<\/li>/);
  assert.match(html, /<pre[^>]*>[\s\S]*npm run clickup -- waiting/);
  assert.doesNotMatch(html, /# Why Stuck/);
  assert.match(html, /<a href="\/docs">Back to Docs<\/a>/);
  assert.doesNotMatch(renderCommandView({ ...COMMANDS[0], name: '<x>', description: '<y>' }), /<x>|<y>/);
});

test('the Docs page carries the Commands section; /docs/commands/<name> opens one command, served as the page to a browser', async () => {
  const html = readFileSync(WEB('index.html'), 'utf8');
  const f = await fixture();
  try {
    const page = await fetch(`${f.url}/docs/commands/loop-review`, { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), html);
    const list = await f.call('GET', '/commands');
    assert.equal(list.status, 200);
    for (const name of ['loop-build', 'loop-intake', 'loop-review', 'loop-spec']) {
      assert.ok(list.body.commands.some((c) => c.name === name && c.source === 'Loop skill'), name);
    }
    // Other loop skills mention review in their descriptions; the one named for it comes first.
    assert.equal(matchCommands(list.body.commands, 'review')[0].name, 'loop-review');
  } finally { await f.cleanup(); }
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('async function drawDocs'), app.indexOf('/** Underline the header link'));
  assert.match(draw, /await api\('GET', '\/commands'\)/);
  assert.match(draw, /<h2 id="commands-pod-title">Quick Claude Commands<\/h2>/);
  assert.match(draw, /<div class="docs-columns">\$\{commandsSection\(\)\}<div class="docs-main">\$\{rest\}<\/div><\/div>/, 'the pod on the left, the rest on the right');
  assert.equal((draw.match(/\$\{docsColumns\(`/g) ?? []).length, 2, 'with projects and without, the page is drawn in the two columns');
  assert.doesNotMatch(draw, /\$\{commandsSection\(\)\}\s*\$\{documentation\}/, 'the pod is no longer a section between the others');
  assert.match(draw, /<dialog class="command-details" aria-labelledby="command-details-title">[\s\S]*<button type="submit">Close<\/button>[\s\S]*<\/dialog>/);
  assert.match(draw, /renderCommandDetails\(command\);\s*dialog\.showModal\(\);/);
  assert.match(draw, /e\.preventDefault\(\);\s*e\.stopPropagation\(\);/, 'a click opens the pop-up, not the steps page');
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /section\.commands-pod \{ background: #cceeff; border: 1px solid #003377; border-radius: 20px;/);
  assert.match(css, /\.docs-columns \{ display: grid; grid-template-columns: minmax\(0, 1fr\) minmax\(0, 2fr\);/, 'the pod takes a third');
  assert.match(css, /@media \(max-width: 800px\) \{ \.docs-columns \{ grid-template-columns: minmax\(0, 1fr\); \} \}/, 'stacked on a narrow screen');
  assert.match(draw, /<input type="search" id="command-search"/);
  assert.match(draw, /box\.addEventListener\('input', show\)/);
  assert.match(draw, /renderCommandList\(commands, box\.value\)/);
  assert.match(draw, /api\('GET', '\/commands'\)\.then\(\(r\) => r\.commands, \(\) => null\)/, 'a failed commands call is caught on its own, so the rest still draws');
  assert.match(draw, /The commands could not be read\./);
  assert.match(draw, /renderCommandView\(\{ \.\.\.command, steps: unwrapDoc\(command\.steps\) \}\)/, 'wrapped lines joined, as a documentation file\'s are');
  assert.match(app, /const m = \/\^\\\/docs\\\/commands\\\/\(\[\^\/\]\+\)\$\/\.exec\(location\.pathname\);/);
  // Before the documentation pages' catch-all, which would otherwise say "no documentation file" for a command.
  assert.match(app, /\} else if \(docsCommand != null\) \{\s*await drawCommand\(docsCommand\);\s*\} else if \(docAny\) \{/);
  assert.match(app, /docsPage \|\| docAny \? 'docs' :/, 'Docs stays underlined in the header (docAny covers /docs/commands/<name>)');
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
  for (const field of ['p.name', 'p.email', 'i.email', 'i.invitedBy.name', 'x.id', 'x.name']) assert.match(draw, new RegExp(`escapeHtml\\(${field.replace('.', '\\.')}\\)`), field);
  assert.match(draw, /\$\{person \? `<form class="invite">/);
  assert.match(draw, /\$\{person \? `<button type="button" data-cancel=/);
  // "Send the link to": only when the tracker knows an outside site, the tracker page first and chosen by default.
  assert.match(draw, /\$\{sites\.length \? `<label for="invite-site">Send the link to<\/label>/);
  assert.match(draw, /<select id="invite-site"><option value="">the tracker page<\/option>\$\{sites\.map/);
  assert.match(draw, /api\('POST', '\/invites', site \? \{ email, site: Number\(site\) \} : \{ email \}\)/);
  assert.match(draw, /api\('DELETE', `\/invites\/\$\{encodeURIComponent\(id\)\}`\)/);
  // Each write (invite, cancel, role change) is read back with GET /people before the page says it worked.
  assert.equal(draw.match(/await api\('GET', '\/people'\)\.catch/g).length, 3);
  assert.match(draw, /putTrail\(\[\{ label: 'Users' \}\]\)/);
  assert.match(draw, /setTitle\('Users · Tracker'\)/);
  assert.match(draw, /<h1>Users<\/h1>/);
  assert.match(draw, /<h2>Users with an Account<\/h2>/);
});

test('the Users page shows each role, gives an admin a picker that reads back, shows a refusal\'s reason, and lists which role has which permission', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('async function drawUsers'), app.indexOf('/** Underline the header link'));
  assert.match(draw, /<th class="role">Role<\/th>/);
  // The picker is an admin's only; everyone else sees the role as text.
  assert.match(draw, /const picker = person && canEditRoles;/);
  assert.match(draw, /: escapeHtml\(p\.role \?\? ''\)\)/);
  for (const field of ['p.id', 'p.name', 'r.name', 'r.description', 'x.description']) assert.match(draw, new RegExp(`escapeHtml\\(${field.replace('.', '\\.')}\\)`), field);
  // A change is sent, then read back with GET /people before the page says it worked.
  assert.match(draw, /api\('PUT', `\/people\/\$\{encodeURIComponent\(id\)\}\/role`, \{ role \}\)/);
  assert.match(draw, /const now = back\?\.people\?\.find\(\(p\) => String\(p\.id\) === id\)\?\.role;/);
  assert.match(draw, /again\(now === role \? `\$\{name\} is now \$\{role\}\.` :/);
  // A refusal puts the picker back and shows the server's own reason.
  assert.match(draw, /select\.value = was;[\s\S]*?note\.textContent = `Not changed: \$\{err\.message\}`;/);
  assert.match(draw, /<h2>Roles and Permissions<\/h2>/);
  assert.match(draw, /recorded, not yet enforced/);
});

test('a project\'s details page lists its members, gives an admin Add Member and Remove (never on the owner or operator), reads each change back, and shows a refusal\'s reason', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('async function drawProjectDetails'), app.indexOf('/** One labelled text box'));
  assert.match(draw, /<h2>Members<\/h2>/);
  for (const field of ['m.name', 'm.addedBy.name', 'x.name', 'x.id', 'm.id', 't']) assert.match(draw, new RegExp(`escapeHtml\\(${field.replace('.', '\\.')}\\)`), field);
  // Only an admin signed in as a person gets the controls; the owner and operator get a tag, no Remove.
  assert.match(draw, /const editing = me\?\.kind === 'human' && p\.canEditMembers === true;/);
  assert.match(draw, /fixedAs\(m\)\.length \? '' : `<button type="button" data-remove=/);
  assert.match(draw, /<button type="submit">Add Member<\/button>/);
  assert.match(draw, />Remove<\/button>/);
  // The picker offers only people not on the project yet.
  assert.match(draw, /const addable = people\.filter\(\(x\) => !members\.some\(\(m\) => m\.id === x\.id\)\);/);
  assert.match(draw, /api\('POST', `\/projects\/\$\{encodeURIComponent\(slug\)\}\/members`, \{ person: id \}\)/);
  assert.match(draw, /api\('DELETE', `\/projects\/\$\{encodeURIComponent\(slug\)\}\/members\/\$\{encodeURIComponent\(id\)\}`\)/);
  // Each change is read back before the page says it worked; a refusal shows the server's reason.
  assert.match(draw, /const back = await api\('GET', `\/projects\/\$\{encodeURIComponent\(slug\)\}`\)\.catch\(\(\) => null\);/);
  assert.match(draw, /const ok = back != null && listed === wanted\.listed;/);
  assert.match(draw, /note\.textContent = `Not \$\{verb === 'add' \? 'added' : 'removed'\}: \$\{err\.message\}`;/);
  assert.match(draw, /Only its members \(and admins\) see this project/);
});

test('the Users page lists each user\'s projects, each a link to its details page', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('async function drawUsers'), app.indexOf('/** Underline the header link'));
  assert.match(draw, /<th class="projects">Projects<\/th>/);
  // Anyone but an admin sees the cell as before: links, or "none" (left out under an admin's "All projects (admin)").
  assert.match(draw, /if \(!editing\) return mine\.length \? mine\.map\(\(x\) => `<a href="\/projects\/\$\{encodeURIComponent\(x\.slug\)\}">\$\{escapeHtml\(x\.name\)\}<\/a>`\)\.join\(', '\) : none;/);
});

test('the Users page says "All projects (admin)" first in an admin\'s Projects cell, from the server\'s seesEveryProject, and leaves out "none" under it (SP-197)', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('async function drawUsers'), app.indexOf('/** Underline the header link'));
  assert.match(draw, /const every = p\.seesEveryProject === true;/);
  assert.match(draw, /<span class="every"[^>]*>All projects \(admin\)<\/span>/);
  assert.match(draw, /return `\$\{label\}\$\{memberCell\(p, every \? '' : '<span class="quiet">none<\/span>'\)\}`;/);
  // Both forms of the cell (a viewer's links, an admin's editing list) use the same "none".
  assert.match(draw, /\.join\(', '\) : none;/);
  assert.match(draw, /<\/span>`\)\.join\(''\) : none\}/);
  assert.match(readFileSync(WEB('app.css'), 'utf8'), /table\.people td span\.every \{/);
});

test('the Users page gives an admin Remove on each of a user\'s projects (never where they are its owner or operator) and an Add to Project picker, each change read back', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('async function drawUsers'), app.indexOf('/** Underline the header link'));
  // Only an admin signed in as a person: the flag comes from GET /projects, which a loop's sign-in never asks for here.
  assert.match(draw, /const \{ projects: all = \[\], canEditMembers = false \} = person \? await api\('GET', '\/projects'\) : \{\};/);
  assert.match(draw, /const editing = person && canEditMembers === true;/);
  // The owner and operator get a tag and no Remove.
  assert.match(draw, /pr\?\.owner\?\.id === p\.id \? 'Owner' : null, pr\?\.operator\?\.id === p\.id \? 'Operator' : null/);
  assert.match(draw, /\$\{fixedAs\(p, x\)\.length\s*\? ''\s*: `<button type="button" class="remove-member"/);
  // The picker offers only the projects they are not on yet.
  assert.match(draw, /const addable = all\.filter\(\(x\) => !mine\.some\(\(m\) => m\.slug === x\.slug\)\);/);
  assert.match(draw, /<option value="">Add to Project…<\/option>/);
  for (const field of ['x.slug', 'x.name', 'p.id', 'p.name', 't']) assert.match(draw, new RegExp(`escapeHtml\\(${field.replace('.', '\\.')}\\)`), field);
  // Each change goes through changeMember and is read back from GET /people.
  assert.equal(draw.match(/changeMember\(\{ control: /g).length, 2);
  assert.match(draw, /const back = \(await api\('GET', '\/people'\)\)\.people\?\.find\(\(x\) => String\(x\.id\) === String\(id\)\);/);
  assert.match(draw, /return back \? \(back\.projects \?\? \[\]\)\.some\(\(x\) => x\.slug === slug\) : null;/);
});

test('the Projects page has a Members column; an admin gets Remove on each member (never the owner or operator) and an Add Member picker, each change read back', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = /async function drawProjects\(done = '', problem = ''\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(draw, /<th class="members">Members<\/th>/);
  assert.match(draw, /<td class="members">\$\{membersCell\(p\)\}<\/td>/);
  assert.match(draw, /const editing = people && canEditMembers === true;/);
  assert.match(draw, /const everyone = editing \? \(await api\('GET', '\/people'\)\)\.people \?\? \[\] : \[\];/);
  assert.match(draw, /m\.id === p\.owner\?\.id \? 'Owner' : null, m\.id === p\.operator\?\.id \? 'Operator' : null/);
  assert.match(draw, /\$\{editing && !fixedAs\(p, m\)\.length\s*\? `<button type="button" class="remove-member"/);
  assert.match(draw, /const addable = everyone\.filter\(\(x\) => !members\.some\(\(m\) => m\.id === x\.id\)\);/);
  assert.match(draw, /<option value="">Add Member…<\/option>/);
  for (const field of ['m.name', 'm.id', 'p.slug', 'p.name', 'x.id', 'x.name', 't']) assert.match(draw, new RegExp(`escapeHtml\\(${field.replace('.', '\\.')}\\)`), field);
  assert.equal(draw.match(/changeMember\(\{ control: /g).length, 2);
  assert.match(draw, /const back = \(await api\('GET', '\/projects'\)\)\.projects\?\.find\(\(x\) => x\.slug === slug\);/);
  // A refusal shows above the table, as an error.
  assert.match(draw, /<p class="note\$\{problem \? ' error' : \(done \? ' quiet' : ''\)\}" role="status">\$\{escapeHtml\(problem \|\| done\)\}<\/p>/);
});

test('changeMember sends the project page\'s own calls, shows a refusal\'s reason, and says it worked only when the list read back agrees', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const fn = /async function changeMember\(\{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(fn, /api\('POST', `\/projects\/\$\{encodeURIComponent\(slug\)\}\/members`, \{ person: Number\(person\) \}\)/);
  assert.match(fn, /api\('DELETE', `\/projects\/\$\{encodeURIComponent\(slug\)\}\/members\/\$\{encodeURIComponent\(person\)\}`\)/);
  assert.match(fn, /note\.textContent = `Not \$\{done\}: \$\{err\.message\}`;/);
  assert.match(fn, /const listed = await listedNow\(\)\.catch\(\(\) => null\);/);
  assert.match(fn, /const ok = listed === adding;/);
  assert.match(fn, /again\(ok\s*\? `\$\{adding \? 'Added' : 'Removed'\} \$\{name\} \$\{where\}\.`/);
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
  assert.match(draw, /<div class="toolbar">\s*\$\{renderProjectPicker\(projects, board\.project\)\}\s*\$\{searchForm\(''\)\}\s*<button type="button" class="pipeline-pod"[^>]*><\/button>\s*\$\{viewSwitch\(board\.project, view\)\}/);
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

test('the Ticket number field sits beside the Project filter and offers each ticket as "SP-12 · <title>", escaped', () => {
  const project = { key: 'project', label: 'Project', value: null, options: [{ value: 'spirality', label: 'Spirality' }] };
  const html = renderSearchFilters([project, ...FILTERS], { tickets: [{ id: 'SP-12', name: 'Fix <b>it</b> & more' }, { id: 'SP-13', name: 'Next' }] });
  assert.ok(html.indexOf('name="project"') < html.indexOf('Ticket number') && html.indexOf('Ticket number') < html.indexOf('name="status"'), 'right after Project');
  assert.match(html, /<form class="ticket-lookup">\s*<label>Ticket number\s*<input type="text" name="ticket" list="ticket-numbers"/);
  assert.match(html, /<option value="SP-12">SP-12 · Fix &lt;b&gt;it&lt;\/b&gt; &amp; more<\/option><option value="SP-13">SP-13 · Next<\/option>/);
  assert.ok(!renderSearchFilters([project, ...FILTERS]).includes('Ticket number'), 'only where the page asks for it');
  assert.match(html, /placeholder="SP-13"/, 'an example from the tickets offered, never a typed-out prefix');
  assert.match(renderTicketLookup([]), /<datalist id="ticket-numbers"><\/datalist>/);
  assert.ok(!renderTicketLookup([]).includes('placeholder'));
});

test('a ticket number opens its page in any case, and one that is not offered says so in one plain line', () => {
  const tickets = [{ id: 'SP-12', name: 'A' }, { id: 'WC-3', name: 'B' }];
  assert.deepEqual(lookupTicket('sp-12', tickets, 'Spirality'), { href: '/t/SP-12' });
  assert.deepEqual(lookupTicket('  SP-12 ', tickets), { href: '/t/SP-12' });
  assert.deepEqual(lookupTicket('sp-999', tickets, 'Spirality'), { note: 'No ticket SP-999 in Spirality' });
  assert.deepEqual(lookupTicket('zz-999', tickets), { note: 'No ticket ZZ-999 in any project' });
  assert.equal(lookupTicket('  ', tickets), null);
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(app, /renderSearchFilters\(answer\.filters, \{ tickets: answer\.tickets \?\? \[\] \}\)/);
  assert.match(app, /wireTicketLookup\(/);
  assert.match(app, /main\.querySelector\('\.search-answer'\)\.innerHTML = `<p class="quiet search-note">\$\{escapeHtml\(found\.note\)\}<\/p>`/);
});

test('the search results page draws the filters from the server\'s answer, keeps them in the address, and shows a refusal', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('function searchAddress('), app.indexOf('/**\n * Put `text` on the clipboard'));
  assert.match(draw, /renderSearchFilters\(answer\.filters, /);
  assert.match(draw, /api\('GET', `\/search\?\$\{params\}`\)/);
  assert.match(draw, /for \(const select of main\.querySelectorAll\('\.search-filters select'\)\) select\.addEventListener\('change', go\)/);
  assert.match(draw, /<p class="error">\$\{escapeHtml\(refusal\)\}<\/p>/);
  // No status, priority or person is typed out: every choice comes from the server.
  for (const word of [...loopStatuses.STAGE_ORDER, 'urgent', 'Urgent', 'Nobody', 'nobody']) {
    assert.ok(!draw.includes(`'${word}'`), word);
  }
  assert.match(app, /await drawSearch\(new URLSearchParams\(location\.search\)\)/);
});

test('searching from the Tasks page carries the project chosen in its picker into the address as the Project filter (SP-191)', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const address = app.slice(app.indexOf('function searchAddress('), app.indexOf('/** Enter in the Search field'));
  assert.match(address, /main\.querySelectorAll\('\.project-picker select, \.search-filters select'\)/);
  assert.match(address, /params\.set\(select\.name, select\.value\)/);
  // The picker's field is named what the server's Project filter reads, and the results page's row draws it.
  assert.match(renderProjectPicker([{ slug: 'alpha', name: 'Alpha' }, { slug: 'beta', name: 'Beta' }], 'beta'),
    /<select name="project"><option value="alpha">Alpha<\/option><option value="beta" selected>Beta<\/option><\/select>/);
  assert.match(renderSearchFilters([{ key: 'project', label: 'Project', value: 'beta', options: [{ value: 'alpha', label: 'Alpha' }, { value: 'beta', label: 'Beta' }] }]),
    /<label>Project\s*<select name="project"><option value="">Any<\/option><option value="alpha">Alpha<\/option><option value="beta" selected>Beta<\/option><\/select>/);
  assert.deepEqual(activeFilters([{ key: 'project', label: 'Project', value: 'beta', options: [{ value: 'beta', label: 'Beta' }] }]), ['Project: Beta']);
});

// ── Set up a project (SP-127) ────────────────────────────────────────────────

/**
 * A tracker home for the setup page, as tracker/server.test.mjs's: this
 * repository's settings file with its own log folder, read the way the
 * server reads it. `state(slug, ...)` writes a state file as the wizard
 * leaves it; `of(slug)` is the server's answer for that project.
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
    writeFileSync(join(onboard, `${slug}.state.json`), JSON.stringify({ project: slug, updatedAt: '2026-11-05T08:15:00.000Z', steps, stop, finished }));
  };
  return { dir, setup, state, of: (slug) => setupOf(setup, slug), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The `<code>` texts in a box, and how many Copy buttons sit beside them. */
const copies = (html) => ({ codes: codes(html), buttons: (html.match(/<button type="button" class="copy-command">Copy<\/button>/g) ?? []).length });

test('the setup page\'s next-step box, for a state file of each kind: every command with a Copy button whose text is exactly it', () => {
  const h = setupHome();
  try {
    saveAnswers(h.setup, 'press-play', { projectName: 'Press Play', githubRepo: 'example-owner/press-play', description: 'A test project.', trackerPrefix: '', mergePhrases: '', autoMergeLanes: 'none', extraGovernancePaths: 'none' });
    const command = h.of('press-play').commands.resume;
    assert.match(command, /npm run onboard -- --project press-play --no-prompt$/);
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
    Object.assign(values, { projectName: 'Press Play', githubRepo: 'example-owner/press-play', description: 'A test project.', autoMergeLanes: 'relay' });
    const body = setupBody(fields, values);
    assert.equal(body.trackerPrefix, null);
    assert.equal(body.mergePhrases, null);
    assert.equal(body.autoMergeLanes, 'relay');
    assert.equal(body.projectName, 'Press Play');
    const saved = saveAnswers(h.setup, setupSlug('Press Play'), body);
    assert.equal(saved.project, 'press-play');
    assert.equal(saved.resolved.trackerPrefix, 'PR');
    assert.deepEqual(saved.resolved.autoMergeLanes, ['relay']);
  } finally { h.cleanup(); }
});

test('the setup form asks the ClickUp questions only for a project whose checkout runs a loop of its own, and saves them through the wizard\'s checker', () => {
  const h = setupHome();
  try {
    const dane = { projectName: 'Wave Thing', githubRepo: 'example-owner/wave-thing', description: 'A test project.' };
    const keys = (slug) => setupFields(h.setup, slug).map((f) => f.key);
    const clickupKeys = ['clickupListId', 'clickupOperatorId', 'clickupMachineUserId', 'clickupExtraLists'];
    // A new project: Dane's questions only, and a ClickUp answer is refused.
    saveAnswers(h.setup, 'wave-thing', dane);
    assert.deepEqual(keys('wave-thing'), SETUP_FIELDS.map((f) => f.key));
    assert.throws(() => saveAnswers(h.setup, 'wave-thing', { clickupListId: '7' }), /unknown field\(s\): clickupListId/);

    // Its checkout (the default, beside the tracker home) has an old loop's installer: the four ClickUp questions follow.
    const checkout = join(h.dir, 'wave-thing');
    mkdirSync(join(checkout, 'scripts'), { recursive: true });
    writeFileSync(join(checkout, 'scripts', 'install_loop_runner.sh'), '#!/bin/bash\n');
    assert.deepEqual(keys('wave-thing'), [...SETUP_FIELDS.map((f) => f.key), ...clickupKeys]);
    const fields = setupFields(h.setup, 'wave-thing');
    const html = renderSetupForm(fields);
    assert.match(html, /<label for="setup-clickupListId">Does this project already run a loop on ClickUp\?/);
    assert.ok(!/name="clickupOperatorId"[^>]*required/.test(html), 'needed only with a list, which the checker says by name');

    // A list without the seats: refused, naming the field, nothing written.
    assert.throws(() => saveAnswers(h.setup, 'wave-thing', { clickupListId: '4242' }), (err) => err.status === 400 && err.field === 'clickupOperatorId');
    assert.equal(h.of('wave-thing').answers.clickupListId, undefined);

    // All of them: saved, and the wizard's checker reads them back.
    const values = { ...Object.fromEntries(fields.map((f) => [f.key, f.default ?? ''])), ...dane, clickupListId: '4242', clickupOperatorId: '700', clickupMachineUserId: '800', clickupExtraLists: '4343' };
    const saved = saveAnswers(h.setup, 'wave-thing', setupBody(fields, values));
    assert.deepEqual([saved.resolved.clickupListId, saved.resolved.clickupOperatorId, saved.resolved.clickupMachineUserId, [...saved.resolved.clickupExtraLists]], ['4242', '700', '800', ['4343']]);
    assert.match(renderSetupForm(setupFields(h.setup, 'wave-thing'), saved.answers), /name="clickupListId"[^>]*value="4242"/);

    // Blank is "not on ClickUp": kept, so the questions stay on the form and the wizard does not stop for them again.
    const no = saveAnswers(h.setup, 'wave-thing', { clickupListId: null, clickupOperatorId: null, clickupMachineUserId: null, clickupExtraLists: null });
    assert.equal(no.answers.clickupListId, null);
    assert.equal(no.resolved.clickupListId, null);
    assert.deepEqual(keys('wave-thing'), [...SETUP_FIELDS.map((f) => f.key), ...clickupKeys]);

    // Already on Spirality (its settings file is there): a new project's form again.
    rmSync(join(h.dir, 'logs', 'onboard', 'wave-thing.answers.json'));
    saveAnswers(h.setup, 'wave-thing', dane);
    writeFileSync(join(checkout, 'spirality.project.json'), '{}');
    assert.deepEqual(keys('wave-thing'), SETUP_FIELDS.map((f) => f.key));
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

test('the Projects page has Set up a project, lists the projects mid-setup, and keeps New project a link away', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const projects = /async function drawProjects\(done = '', problem = ''\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(projects, /<a class="button" href="\/setup\/new">Set Up a Project<\/a>/);
  assert.doesNotMatch(projects, /href="\/projects\/new">New project/);
  assert.match(projects, /api\('GET', '\/setup'\)/);
  assert.match(projects, /\$\{renderSetupList\(setups\)\}/);
  const setupNew = /async function drawSetupNew\(project\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(setupNew, /<a href="\/projects\/new">New project<\/a>/);
  assert.match(setupNew, /api\('PUT', `\/setup\/\$\{encodeURIComponent\(slug\)\}`, setupBody\(fields, values\)\)/);
  assert.match(setupNew, /history\.pushState\(null, '', `\/setup\/\$\{encodeURIComponent\(slug\)\}`\)/, 'Save opens its setup page');
  assert.match(setupNew, /err\.field \? form\.querySelector\(`\.field-note\[data-for="\$\{err\.field\}"\]`\)/, 'a refusal naming a field shows beside it');
  // The setup page wires the same Copy buttons as a ticket's, and follows the setup every few seconds.
  assert.match(/async function drawSetup\(slug\) \{[\s\S]*?\n\}/.exec(app)[0], /wireCopyButtons\(\);\s*return setupFollows\(setup\);/);
  assert.match(app, /const SETUP_REFRESH_EVERY_MS = 4_000;/);
  assert.match(app, /if \(lastDrawn\?\.fast\) refreshPage\(\);\s*\}, SETUP_REFRESH_EVERY_MS\);/);
  assert.match(app, /if \(kept && following\) lastDrawn = \{ address: here\(\), reads, fast: true \};/);

  // The list: each project not finished, linking its setup page; nothing when there are none.
  const list = renderSetupList({ setups: [
    { project: 'press-play', step: 'signins', finished: false, started: true, stateError: null },
    { project: 'done-one', step: null, finished: true, started: true, stateError: null },
    { project: 'fresh', step: null, finished: false, started: false, stateError: null },
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

test('a ticket or project on a project the person is not on draws a plain You Are Not on This Project page, never the ticket; a 404 to someone who sees everything still says there is none', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  // The flag comes only from the server's own answer.
  assert.match(app, /json\?\.yourProjectsOnly === true\);/);
  assert.match(app, /const notOnProject = \(err\) => err instanceof Refused && err\.status === 404 && err\.yourProjectsOnly === true;/);
  const draw = app.slice(app.indexOf('function drawNotOnProject'), app.indexOf('/** Call the tracker as the signed-in person.'));
  assert.match(draw, /<h1>You Are Not on This Project<\/h1>/);
  assert.match(draw, /escapeHtml\(line\)/);
  assert.match(draw, /`Ticket \$\{ticket\} is on a project you are not a member of, or there is no such ticket\.`/);
  assert.match(draw, /`You are not a member of the project \$\{project\}, or there is no such project\.`/);
  assert.match(draw, /<a href="\/projects">Back to Projects<\/a>/);
  // The ticket page and a board or list fall to it from the page's one error path; the details and edit pages check first.
  assert.match(app, /else if \(notOnProject\(err\) && ticketAt\(\)\) drawNotOnProject\(\{ ticket: ticketAt\(\) \}\);/);
  assert.match(app, /else if \(notOnProject\(err\) && boardAt\(\)\) drawNotOnProject\(\{ project: boardAt\(\) \}\);/);
  const details = app.slice(app.indexOf('async function drawProjectDetails'), app.indexOf('/** One labelled text box'));
  assert.ok(details.indexOf('if (notOnProject(err))') < details.indexOf("setTitle('No Such Project"), 'details: not-on-project before no-such-project');
  const edit = app.slice(app.indexOf('async function drawEditProject'), app.indexOf('const { people } = await api(\'GET\', \'/people\');', app.indexOf('async function drawEditProject')));
  assert.match(edit, /if \(notOnProject\(err\)\) return drawNotOnProject/);
  // The members note no longer says everyone sees every project.
  assert.doesNotMatch(app, /everyone still sees every project/);
  assert.match(app, /Only its members \(and admins\) see this project and its tickets\./);
});

test('busLink: the header count of unseen bus posts, opening the Team chat with the most; nothing unseen, no link (SP-163)', () => {
  assert.equal(busLink(null), null);
  assert.equal(busLink({ total: 0, unseen: [] }), null);
  const link = busLink({ total: 4, unseen: [
    { id: 'SB-1', name: 'Team chat', projectName: 'StarCaster Bus', count: 3 },
    { id: 'WB-2', name: 'Team chat', projectName: 'WaveCenter Bus', count: 1 },
  ] });
  assert.equal(link.text, '4 New on the Bus');
  assert.equal(link.href, '/t/SB-1#comments', 'the posts are in the Details fold: #comments opens it');
  assert.equal(link.title, 'StarCaster Bus: 3 new posts on Team chat; WaveCenter Bus: 1 new post on Team chat');
});

test('the Pipeline Status pod: each stage\'s next time or "running", a dash for none yet, and "Pipeline Status unavailable" when the read failed (SP-168)', () => {
  const timeOf = (iso) => `[${iso.slice(11, 16)}]`;
  const html = renderPipelinePod({ stages: [
    { name: 'Relay', logged: true, running: false, nextDue: '2026-11-09T17:45:00.000Z' },
    { name: 'Build', logged: true, running: true, nextDue: null },
    { name: 'Review', logged: true, running: false, nextDue: null },
    { name: 'Intake', logged: false, running: false, nextDue: null },
  ] }, timeOf, Date.parse('2026-11-09T17:00:00.000Z'));
  // Cells joined with a bar, so the order and the name/time pairing both show.
  const cells = [...html.matchAll(/<span class="([^"]*)"[^>]*>([^<]*)<\/span>/g)].map((m) => m[2]);
  assert.equal(cells.join('|'), 'Pipeline Stages|Relay|[17:45]|Build|running|Review|–|Intake|–');
  assert.match(html, /title="Intake: no passes logged yet"/);
  assert.match(html, /title="Review: the next pass&#39;s time is not known yet"/);
  assert.match(html, /class="stage running"/);
  for (const failed of [null, undefined, {}, { stages: [] }, { error: 'no-pipeline' }]) {
    assert.equal(renderPipelinePod(failed, timeOf).replace(/<[^>]*>/g, ''), PIPELINE_UNAVAILABLE);
  }
  assert.equal(PIPELINE_UNAVAILABLE, 'Pipeline Status unavailable');
  // A stage's name is escaped like every other text the page draws.
  assert.doesNotMatch(renderPipelinePod({ stages: [{ name: '<b>x', logged: false }] }, timeOf), /<b>x/);
});

test('the pod reads as a small table (SP-194): a "Pipeline Stages" heading, one stage per row in two columns, bold names, a running stage green, on light blue', () => {
  const timeOf = (iso) => `[${iso.slice(11, 16)}]`;
  const html = renderPipelinePod({ stages: [
    { name: 'Relay', logged: true, running: false, nextDue: '2026-11-09T17:45:00.000Z' },
    { name: 'Build', logged: true, running: true, nextDue: null },
    { name: 'Review', logged: true, running: false, nextDue: '2026-11-09T18:10:00.000Z' },
    { name: 'Intake', logged: true, running: false, nextDue: '2026-11-09T18:04:00.000Z' },
  ] }, timeOf, Date.parse('2026-11-09T17:00:00.000Z'));
  // The heading comes first, then the grid holding every cell.
  assert.match(html, /^<span class="heading">Pipeline Stages<\/span><span class="stages">/);
  // No table inside the button: HTML does not allow one there.
  assert.doesNotMatch(html, /<(table|tr|td|th|div|h[1-6]|p)\b/);
  // Two cells per stage, name then time, in Relay, Build, Review, Intake order.
  const grid = html.slice(html.indexOf('<span class="stages">') + '<span class="stages">'.length, -'</span>'.length);
  const cells = [...grid.matchAll(/<span class="([^"]*)"[^>]*>([^<]*)<\/span>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(cells, [
    ['stage', 'Relay'], ['time', '[17:45]'],
    ['stage running', 'Build'], ['time running', 'running'],
    ['stage', 'Review'], ['time', '[18:10]'],
    ['stage', 'Intake'], ['time', '[18:04]'],
  ]);
  // Only the running stage carries `running`.
  assert.equal((html.match(/ running"/g) || []).length, 2);
  const css = readFileSync(WEB('app.css'), 'utf8');
  const rule = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.notEqual(at, -1, `app.css has a ${selector} rule`);
    return css.slice(at, css.indexOf('}', at));
  };
  const pod = rule('.toolbar .pipeline-pod');
  assert.match(pod, /background: #cceeff;/, 'Dane\'s light blue (SP-222)');
  assert.match(pod, /flex-direction: column;/, 'the heading sits above the stages');
  assert.match(rule('.toolbar .pipeline-pod .stages'), /display: grid; grid-template-columns: auto auto;/, 'two lined-up columns');
  assert.match(rule('.toolbar .pipeline-pod .stage'), /font-weight: 700;/, 'stage names are bold');
  const green = rule('.toolbar .pipeline-pod .running').match(/color: (#[0-9a-fA-F]{6});/);
  assert.ok(green, 'a running stage has its own colour');
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(green[1].slice(i, i + 2), 16));
  assert.ok(g > r * 2 && g > b * 2, `${green[1]} is a green`);
  // SP-222: Dane chose #00AA00. It is fainter on #cceeff than the 4.5:1
  // small-text bar, so the test checks his colour, not its contrast.
  assert.equal(green[1], '#00AA00', 'the brighter green Dane chose (SP-222)');
  // The button is unchanged: same class, still opens the dialog.
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(app, /<button type="button" class="pipeline-pod" aria-haspopup="dialog" title="Open Pipeline Status"><\/button>/);
});

test('the pod restyled (SP-222): a larger heading, #cceeff with a #000077 border, 10px/20px margins, a stage due within 3 minutes gold, am/pm lowercase', () => {
  const timeOf = (iso) => `[${iso.slice(11, 16)}]`;
  const now = Date.parse('2026-11-09T18:00:00.000Z');
  const html = renderPipelinePod({ stages: [
    { name: 'Relay', logged: true, running: false, nextDue: '2026-11-09T18:02:59.000Z' }, // under 3 minutes
    { name: 'Build', logged: true, running: true, nextDue: '2026-11-09T18:01:00.000Z' }, // running wins
    { name: 'Review', logged: true, running: false, nextDue: '2026-11-09T18:03:00.000Z' }, // exactly 3 minutes: not soon
    { name: 'Intake', logged: true, running: false, nextDue: '2026-11-09T17:55:00.000Z' }, // already past: due
  ] }, timeOf, now);
  const grid = html.slice(html.indexOf('<span class="stages">') + '<span class="stages">'.length, -'</span>'.length);
  const cells = [...grid.matchAll(/<span class="([^"]*)"[^>]*>([^<]*)<\/span>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(cells, [
    ['stage soon', 'Relay'], ['time soon', '[18:02]'],
    ['stage running', 'Build'], ['time running', 'running'],
    ['stage', 'Review'], ['time', '[18:03]'],
    ['stage soon', 'Intake'], ['time soon', '[17:55]'],
  ]);
  assert.match(html, /title="Relay: next pass due \[18:02\] \(due within 3 minutes\)"/);
  assert.match(html, /title="Review: next pass due \[18:03\]"/);
  assert.match(html, /title="Intake: next pass due \[17:55\] \(due now\)"/);
  assert.equal(PIPELINE_SOON_MS, 3 * 60 * 1000);
  const css = readFileSync(WEB('app.css'), 'utf8');
  const rule = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.notEqual(at, -1, `app.css has a ${selector} rule`);
    return css.slice(at, css.indexOf('}', at));
  };
  const pod = rule('.toolbar .pipeline-pod');
  assert.match(pod, /margin: 10px 20px;/, '10px top and bottom, 20px left and right');
  assert.match(pod, /border: 1px solid #000077;/);
  assert.match(pod, /background: #cceeff;/);
  assert.match(rule('.toolbar .pipeline-pod:hover'), /background: #b8e4ff;/, 'hover still shows on the new blue');
  assert.match(rule('.toolbar .pipeline-pod .heading'), /font-size: 1\.5em;/, 'the heading 50% larger');
  assert.match(rule('.toolbar .pipeline-pod .soon'), /color: #B8860B;/, 'gold that reads on light blue');
  // The Files Made box keeps its light blue (non-goal).
  assert.match(rule('.files-made'), /background: #eaf5fe;/);
  // Lowercase am/pm, for the pod's times only.
  assert.equal(lowerMeridiem('10:45 AM'), '10:45 am');
  assert.equal(lowerMeridiem('2:05\u202fPM'), '2:05\u202fpm');
  assert.equal(lowerMeridiem('14:05'), '14:05');
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(app, /const clockTime = \(iso\) => lowerMeridiem\(/);
  assert.match(app, /renderPipelinePod\(pipelineState, clockTime, Date\.now\(\)\)/);
  // The dialog keeps its own times.
  assert.match(app, /renderPipelineDetails\(pipelineState, when\)/);
});

test('the Tasks page puts the pod between the search field and Board/List, fills it on draw and once a minute, and a failed read touches only the pod (SP-168)', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const tasks = app.indexOf('<h1>Tasks</h1>', app.indexOf('async function drawProject('));
  const toolbar = app.slice(app.indexOf('<div class="toolbar">', tasks), app.indexOf('</div>', app.indexOf('<div class="toolbar">', tasks)));
  const search = toolbar.indexOf("${searchForm('')}");
  const pod = toolbar.indexOf('class="pipeline-pod"');
  const views = toolbar.indexOf('${viewSwitch(board.project, view)}');
  assert.ok(search !== -1 && search < pod && pod < views, 'search field, then the pod, then the Board/List toggle');
  const draw = app.slice(app.indexOf('async function drawProject('), app.indexOf('async function drawProject(') + 12000);
  assert.match(draw, /refreshPipeline\(\);/);
  assert.match(app, /const PIPELINE_REFRESH_EVERY_MS = 60_000;/);
  assert.match(app, /setInterval\(refreshPipeline, PIPELINE_REFRESH_EVERY_MS\);/);
  const refresh = app.slice(app.indexOf('async function refreshPipeline'), app.indexOf('/** Draw the pod from the last answer'));
  // A failure is caught inside: it empties the answer (so the pod says unavailable) and throws nothing to the page.
  assert.match(refresh, /catch \(err\) \{\n\s+if \(err instanceof SignedOut\) return;\n\s+pipelineState = null;\n\s+\}/);
  // The pod is not part of the page's own reads, so a new time never redraws the page under him.
  assert.match(refresh, /api\('GET', '\/pipeline', undefined, \{ unrecorded: true \}\)/);
  assert.match(app, /const reads = unrecorded \? null : recording;/);
  assert.doesNotMatch(draw.slice(0, draw.indexOf(']);')), /\/pipeline/);
});

test('each END exit code the runners write reads as its plain-words outcome (SP-173)', () => {
  assert.equal(passOutcome(0), 'Finished');
  assert.equal(passOutcome(1), 'A step failed and said so');
  assert.equal(passOutcome(124), 'Hit its time limit and was stopped');
  assert.equal(passOutcome(127), 'Could not run (exit 127)');
  assert.equal(passOutcome(2), 'Could not run (exit 2)');
  assert.equal(passOutcome(null), 'Ended');
  assert.equal(wakesEvery(1800), 'Every 30 minutes');
  assert.equal(wakesEvery(600), 'Every 10 minutes');
  assert.equal(wakesEvery(3600), 'Every hour');
  assert.equal(wakesEvery(7200), 'Every 2 hours');
  assert.equal(wakesEvery(90), 'Every 90 seconds');
  assert.equal(wakesEvery(null), '–');
});

test('the Pipeline Status dialog: one row per stage with next time or running, last start, last end and outcome, how often it wakes (SP-173)', () => {
  const timeOf = (iso) => `[${iso.slice(11, 16)}]`;
  const html = renderPipelineDetails({ stages: [
    { name: 'Relay', logged: true, running: false, lastStart: '2026-11-09T17:35:00.000Z', lastEnd: '2026-11-09T17:35:20.000Z', lastExit: 0, interval: 600, nextDue: '2026-11-09T17:45:00.000Z' },
    { name: 'Build', logged: true, running: true, lastStart: '2026-11-09T17:40:00.000Z', lastEnd: '2026-11-09T17:10:00.000Z', lastExit: 124, interval: 1800, nextDue: null },
    { name: 'Review', logged: true, running: false, lastStart: '2026-11-09T17:00:00.000Z', lastEnd: '2026-11-09T17:05:00.000Z', lastExit: 1, interval: 1800, nextDue: null },
    { name: 'Intake', logged: false, running: false, lastStart: null, lastEnd: null, lastExit: null, interval: 1800, nextDue: null },
  ] }, timeOf);
  const rows = [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map((m) => [...m[1].matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/g)].map((c) => c[1]));
  assert.deepEqual(rows, [
    ['Stage', 'Next Pass', 'Last Started', 'Last Ended', 'Wakes'],
    ['Relay', '[17:45]', '[17:35]', '[17:35]: Finished', 'Every 10 minutes'],
    ['Build', 'Running now, since [17:40]', '[17:40]', 'Previous pass: [17:10]: Hit its time limit and was stopped', 'Every 30 minutes'],
    ['Review', 'Not known yet', '[17:00]', '[17:05]: A step failed and said so', 'Every 30 minutes'],
    ['Intake', 'No passes logged yet', 'Every 30 minutes'],
  ]);
  assert.match(html, /<td class="failed">\[17:05\]: A step failed/);
  for (const failed of [null, undefined, {}, { stages: [] }]) {
    assert.match(renderPipelineDetails(failed, timeOf), new RegExp(PIPELINE_UNAVAILABLE));
  }
  assert.doesNotMatch(renderPipelineDetails({ stages: [{ name: '<b>x', logged: false }] }, timeOf), /<b>x/);
});

test('the pod is a button that opens the Pipeline Status dialog; Escape or Close shut it and focus goes back to the pod (SP-173)', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('async function drawProject('), app.indexOf('async function drawProject(') + 14000);
  assert.match(draw, /<button type="button" class="pipeline-pod" aria-haspopup="dialog"/);
  // A <dialog> with a form of method="dialog": Escape and both close buttons shut it natively.
  assert.match(draw, /<dialog class="pipeline-status" aria-labelledby="pipeline-status-title">\s*<form method="dialog">/);
  assert.match(draw, /<h2 id="pipeline-status-title">Pipeline Status<\/h2>/);
  assert.match(draw, /<button type="submit">Close<\/button>/);
  assert.match(draw, /wirePipeline\(\);/);
  const wire = app.slice(app.indexOf('function wirePipeline'), app.indexOf('function wirePipeline') + 800);
  assert.match(wire, /pod\.addEventListener\('click'/);
  assert.match(wire, /fillPipelineDialog\(dialog\);\n\s+dialog\.showModal\(\)/);
  assert.match(wire, /dialog\.showModal\(\)/);
  assert.match(wire, /dialog\.addEventListener\('close', \(\) => pod\.focus\(\)\)/);
  // An open dialog redraws with each fresh read, from the same answer, and reads no log of its own.
  assert.match(app, /if \(dialog\?\.open\) fillPipelineDialog\(dialog\);/);
  assert.match(app, /function fillPipelineDialog\(dialog\) \{\n\s+dialog\.querySelector\('\.pipeline-details'\)\.innerHTML = renderPipelineDetails\(pipelineState, when\);/);
});

test('an open dialog holds the once-a-minute redraw, so a board change never drops the Pipeline Status dialog from under him (SP-173 rework)', () => {
  assert.equal(redrawHold({ dialog: true }), 'dialog', 'a dialog of buttons only still holds the redraw');
  assert.equal(redrawHold({ dialog: false }), null);
  assert.equal(redrawHold({ hidden: true, dialog: true }), 'hidden', 'hidden still wins: nothing is read');
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  // The page's hold asks whether any dialog in main is open, and both refresh checks use it.
  assert.match(app, /const hold = \(\) => redrawHold\(\{[^}]*dialog: Boolean\(main\.querySelector\('dialog\[open\]'\)\)/);
  const refresh = app.slice(app.indexOf('async function refreshPage'), app.indexOf('async function refreshPage') + 900);
  assert.equal(refresh.match(/hold\(\)/g).length, 2, 'checked before the read and again before the redraw');
});

test('the pod button is named for what it opens and still reads each stage (SP-173 rework)', () => {
  const timeOf = (iso) => `[${iso.slice(11, 16)}]`;
  assert.equal(pipelinePodLabel({ stages: [
    { name: 'Relay', logged: true, running: false, nextDue: '2026-11-09T17:45:00.000Z' },
    { name: 'Build', logged: true, running: true, nextDue: null },
    { name: 'Review', logged: true, running: false, nextDue: null },
    { name: 'Intake', logged: false, running: false, nextDue: null },
  ] }, timeOf), 'Pipeline Status: Relay [17:45], Build running, Review –, Intake –');
  for (const failed of [null, undefined, {}, { stages: [] }]) assert.equal(pipelinePodLabel(failed, timeOf), PIPELINE_UNAVAILABLE);
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const show = app.slice(app.indexOf('function showPipeline'), app.indexOf('function showPipeline') + 600);
  assert.match(show, /pod\.setAttribute\('aria-label', pipelinePodLabel\(pipelineState, clockTime\)\);/);
});

// ── SP-218: the header's health line when a lane keeps failing ───────────────
test('the header says each failing stage in one plain line with when it began, and nothing when every stage passes (SP-218)', () => {
  const timeOf = (iso) => `[${iso.slice(11, 16)}]`;
  const stage = (name, extra = {}) => ({ name, logged: true, running: false, failing: false, failedPasses: 0, failingSince: null, failingReason: null, ...extra });
  const answer = { stages: [
    stage('Relay', { failing: true, failedPasses: 3, failingSince: '2026-11-11T04:00:00.000Z', failingReason: "can't reach the internet" }),
    stage('Build', { failedPasses: 2 }),
    stage('Review', { failing: true, failedPasses: 5, failingSince: '2026-11-10T21:30:00.000Z', failingReason: 'keeps failing' }),
    stage('Intake'),
  ] };
  assert.deepEqual(healthLines(answer, timeOf), [
    "Relay can't reach the internet since [04:00]",
    'Review keeps failing since [21:30]',
  ]);
  assert.equal(renderHealth(answer, timeOf), "<span>Relay can&#39;t reach the internet since [04:00]</span><span>Review keeps failing since [21:30]</span>");
  // Two failures in a row, or the first passing pass after them: no line.
  assert.deepEqual(healthLines({ stages: [stage('Relay', { failedPasses: 2 }), stage('Build')] }, timeOf), []);
  assert.equal(renderHealth({ stages: [stage('Relay')] }, timeOf), '');
  for (const failed of [null, undefined, {}, { stages: [] }, { error: 'no-pipeline' }]) assert.deepEqual(healthLines(failed, timeOf), []);
  // A reason missing from the answer says "keeps failing"; names are escaped like every other text.
  assert.deepEqual(healthLines({ stages: [stage('Relay', { failing: true, failingSince: null })] }, timeOf), ['Relay keeps failing']);
  assert.doesNotMatch(renderHealth({ stages: [stage('<b>x', { failing: true })] }, timeOf), /<b>x/);
});

test('every page carries the health line in its header, in the bell\'s warning yellow on the black header, hidden until a stage is failing (SP-218)', () => {
  const html = readFileSync(WEB('index.html'), 'utf8');
  const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
  assert.match(header, /<span id="health" class="health" role="status" hidden><\/span>\s*<span class="me">/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  const rule = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.notEqual(at, -1, `app.css has a ${selector} rule`);
    return css.slice(at, css.indexOf('}', at));
  };
  const yellow = rule('header .health').match(/color: (#[0-9a-fA-F]{6});/)[1];
  assert.equal(yellow, css.match(/header #bell\[data-colour="yellow"\] \{ color: (#[0-9a-fA-F]{6}); \}/)[1], 'the same warning colour as the bell');
  assert.ok(contrast(yellow, '#000000') >= 4.5, 'it reads on the black header');
  assert.match(rule('header .health[hidden]'), /display: none;/);
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  // Read on every page while signed in, not only where the pod is, on the pod's own timer.
  const refresh = app.slice(app.indexOf('async function refreshPipeline'), app.indexOf('/** The header\'s health lines from the last answer'));
  assert.match(refresh, /if \(!me\) return;/);
  assert.doesNotMatch(refresh, /querySelector\('\.pipeline-pod'\)/);
  assert.match(app, /setInterval\(refreshPipeline, PIPELINE_REFRESH_EVERY_MS\);/);
  const show = app.slice(app.indexOf('function showPipeline'), app.indexOf('function showPipeline') + 300);
  assert.match(show, /^function showPipeline\(read = false\) \{\n\s+showHealth\(\);/);
  assert.match(app, /function showHealth\(\) \{\n\s+const lines = me \? healthLines\(pipelineState, sinceTime\) : \[\];\n\s+health\.hidden = !lines\.length;/);
  const route = app.slice(app.indexOf('async function route('), app.indexOf('async function route(') + 1500);
  assert.match(route, /if \(pipelineState\) showHealth\(\);\n\s+else refreshPipeline\(\);/);
  // Signed out, it goes with the bell.
  assert.equal((app.match(/bell\.hidden = true;\n\s+busCount\.hidden = true;\n\s+health\.hidden = true;/g) || []).length, 2);
});

// ── SP-170: the Files Made box, drawn from the relay's merge note (SP-166) ───
test.describe('Files Made: the files a ticket made, from its newest merge note', () => {
  const { filesMadeLines } = mergeOnComment;
  const { stampMachineComment } = machineComment;
  const REPO = 'some-owner/some-repo';
  // The note exactly as the relay writes it: its own list builder, then the stamp.
  const note = (paths, { number = 7, limit } = {}) => stampMachineComment([
    `Merged: PR #${number} (https://github.com/${REPO}/pull/${number}) squash-merged into main at 2026-11-09T12:00:00Z, on your comment 1.`,
    'Checks were green and the branch was up to date at merge time; the branch has been deleted.',
    '',
    'This ticket is now Live (its PR merged).',
    '',
    ...filesMadeLines({ repo: REPO, branch: 'main', files: paths.map((filename) => ({ filename, status: 'added' })), limit }).lines,
    '',
    '(Automatic — relay merge step.)',
  ].join('\n'));
  const loop = (body) => ({ body, machine: true });
  const hrefs = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

  test('a merge note that lists files gives one link per file, to the address in the note', () => {
    const comments = [loop('PR opened: https://github.com/x/y/pull/7'), loop(note(['docs/OVERVIEW.md', 'lib/new.js']))];
    assert.deepEqual(filesMade(comments), [
      { path: 'docs/OVERVIEW.md', href: `https://github.com/${REPO}/blob/main/docs/OVERVIEW.md` },
      { path: 'lib/new.js', href: `https://github.com/${REPO}/blob/main/lib/new.js` },
    ]);
    const html = renderFilesMade({ comments });
    assert.match(html, /<h2>Files Made<\/h2>/);
    assert.deepEqual(hrefs(html), filesMade(comments).map((f) => f.href));
    assert.match(html, />docs\/OVERVIEW\.md<\/a>/, 'the path is the link text');
    assert.equal((html.match(/target="_blank"/g) || []).length, 2, 'each opens in a new tab');
  });

  test('no merge note, or one with no list, draws nothing: no box, no empty heading', () => {
    assert.deepEqual(filesMade([]), []);
    assert.equal(renderFilesMade({ comments: [] }), '');
    const noFiles = loop(note([]));
    assert.equal(renderFilesMade({ comments: [loop('PR opened: https://github.com/x/y/pull/7'), noFiles] }), '');
    const unreadable = loop(`Merged: PR #7 (https://x) squash-merged.\n\n${mergeOnComment.FILES_MADE_UNREADABLE}`);
    assert.equal(renderFilesMade({ comments: [unreadable] }), '');
  });

  test('with two merge notes (a ticket built in slices), the newest list is shown', () => {
    const comments = [loop(note(['old/first.md'], { number: 7 })), loop('later talk'), loop(note(['new/second.md'], { number: 9 }))];
    assert.deepEqual(filesMade(comments).map((f) => f.path), ['new/second.md']);
    // A newer merge with no new files does not hide the list an older one made.
    const thenNone = [...comments, loop(note([], { number: 11 }))];
    assert.deepEqual(filesMade(thenNone).map((f) => f.path), ['new/second.md']);
  });

  test('a line whose link is not http(s) is left out, never drawn as a link', () => {
    const body = [
      'Merged: PR #7 (https://github.com/x/y/pull/7) squash-merged into main.',
      '',
      'Files made by this ticket:',
      '- good.md: https://github.com/x/y/blob/main/good.md',
      '- bad.md: javascript:alert(1)',
      '- worse.md: data:text/html,<script>alert(1)</script>',
      '- nolink.md',
    ].join('\n');
    const html = renderFilesMade({ comments: [loop(body)] });
    assert.deepEqual(filesMade([loop(body)]).map((f) => f.path), ['good.md']);
    assert.deepEqual(hrefs(html), ['https://github.com/x/y/blob/main/good.md']);
    assert.doesNotMatch(html, /javascript:|data:|bad\.md|worse\.md/);
  });

  test('paths and links are escaped: < and " show as text, never as markup', () => {
    const body = 'Merged: PR #7 (https://x) squash-merged.\n\nFiles made by this ticket:\n'
      + '- docs/<img src=x onerror=alert(1)>"q".md: https://github.com/x/y/blob/main/a"onmouseover="alert(1)';
    const html = renderFilesMade({ comments: [loop(body)] });
    assert.doesNotMatch(html, /<img|"q"|"onmouseover/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;q&quot;\.md/);
    assert.match(html, /href="https:\/\/github\.com\/x\/y\/blob\/main\/a&quot;onmouseover=&quot;alert\(1\)"/);
  });

  test('only a loop\'s merge note counts: a person quoting one draws nothing', () => {
    assert.deepEqual(filesMade([{ body: note(['docs/a.md']), machine: false }]), []);
  });

  test('a list cut short says how many more, without inventing links for them', () => {
    const html = renderFilesMade({ comments: [loop(note(['a.md', 'b.md', 'c.md'], { limit: 2 }))] });
    assert.equal(hrefs(html).length, 2);
    assert.match(html, /And 1 more: see the pull request's Files changed tab\./);
  });

  test('the ticket page draws the box between the Quick Action section and the Details fold', () => {
    const app = readFileSync(WEB('app.mjs'), 'utf8');
    assert.match(app, /<\/section>\s*\$\{renderFilesMade\(t\)\}\s*<details class="details">/);
    assert.match(readFileSync(WEB('app.css'), 'utf8'), /\.files-made \{[^}]*background:[^}]*border:/);
  });
});

// SP-174: the Tasks tables' headings sort each stage's rows.
{
  const T = (id, name, priority, tags, assignee, updatedAt) => ({ id, name, priority, tags, assignee, updatedAt });
  const tickets = [
    T('A-1', 'banana', 'low', ['web'], 'Dane', '2026-11-03T10:00:00.000Z'),
    T('A-2', 'Apple', null, [], null, '2026-11-01T10:00:00.000Z'),
    T('A-3', 'cherry', 'urgent', ['api', 'web'], 'hand-run', '2026-11-09T10:00:00.000Z'),
    T('A-4', 'apple', 'high', ['Docs'], 'Dane', '2026-11-02T10:00:00.000Z'),
    T('A-5', 'date', 'normal', [], null, '2026-11-02T09:00:00.000Z'),
  ];
  const ids = (list) => list.map((t) => t.id);
  const sorted = (column, direction = 'ascending') => ids(sortTickets(tickets, { column, direction }));

  test('the page\'s priority order is the one lib/loopStatuses.js PRIORITY_RANK gives', () => {
    assert.deepEqual([...PRIORITY_ORDER], [...PRIORITIES]);
  });

  test('a stage sorts by each column, ties keeping the order the page had, and descending is the reverse', () => {
    assert.deepEqual(sorted('name'), ['A-2', 'A-4', 'A-1', 'A-3', 'A-5'], 'A to Z, case ignored, ties in page order');
    assert.deepEqual(sorted('priority'), ['A-3', 'A-4', 'A-5', 'A-1', 'A-2'], 'Urgent, High, Normal, Low, none');
    assert.deepEqual(sorted('priority', 'descending'), ['A-2', 'A-1', 'A-5', 'A-4', 'A-3']);
    assert.deepEqual(sorted('tags'), ['A-3', 'A-4', 'A-1', 'A-2', 'A-5'], 'by first tag, case ignored, no tags last');
    assert.deepEqual(sorted('assignee'), ['A-1', 'A-4', 'A-3', 'A-2', 'A-5'], 'A to Z, nobody last');
    assert.deepEqual(sorted('when'), ['A-2', 'A-5', 'A-4', 'A-1', 'A-3'], 'oldest first, by the real time');
    assert.deepEqual(sorted('when', 'descending'), ['A-3', 'A-1', 'A-4', 'A-5', 'A-2'], 'newest first');
  });

  test('Ticket # sorts by the ticket\'s number, not as text: SP-9 before SP-10 (SP-193)', () => {
    const list = [T('SP-10'), T('SP-9'), T('SP-193'), T('SP-2'), T('SP-9')];
    list[4].name = 'second SP-9';
    const by = (direction) => sortTickets(list, { column: 'id', direction });
    assert.deepEqual(ids(by('ascending')), ['SP-2', 'SP-9', 'SP-9', 'SP-10', 'SP-193']);
    assert.equal(by('ascending')[2].name, 'second SP-9', 'ties keep the page\'s order');
    assert.deepEqual(ids(by('descending')), ['SP-193', 'SP-10', 'SP-9', 'SP-9', 'SP-2']);
    assert.deepEqual(nextSort(nextSort(null, 'id'), 'id'), { column: 'id', direction: 'descending' });
    const up = renderSortHeadings({ column: 'id', direction: 'ascending' });
    assert.match(up, /<th class="id" aria-sort="ascending"><button[^>]*data-sort="id">Ticket # <span class="arrow" aria-hidden="true">▲/);
  });

  test('no sort, or a column it does not know, keeps the page\'s order, and the tickets are never changed', () => {
    const before = ids(tickets);
    assert.deepEqual(ids(sortTickets(tickets, null)), before);
    assert.deepEqual(ids(sortTickets(tickets, { column: 'actions', direction: 'ascending' })), before);
    sortTickets(tickets, { column: 'name', direction: 'descending' });
    assert.deepEqual(ids(tickets), before);
  });

  test('a first click sorts ascending, a second flips it, another heading starts ascending again', () => {
    const one = nextSort(null, 'priority');
    assert.deepEqual(one, { column: 'priority', direction: 'ascending' });
    const two = nextSort(one, 'priority');
    assert.deepEqual(two, { column: 'priority', direction: 'descending' });
    assert.deepEqual(nextSort(two, 'priority'), { column: 'priority', direction: 'ascending' });
    assert.deepEqual(nextSort(two, 'when'), { column: 'when', direction: 'ascending' });
  });

  test('the headings are buttons; only the sorted one has an arrow and aria-sort; Actions is plain', () => {
    const none = renderSortHeadings(null);
    assert.equal((none.match(/<button type="button" class="sort"/g) || []).length, SORT_COLUMNS.length);
    assert.deepEqual(SORT_COLUMNS.map((c) => c.label), ['Ticket #', 'Ticket', 'Priority', 'Tags', 'Assigned To', 'Last Change']);
    assert.match(none, /^<tr><th class="id"><button type="button" class="sort" data-sort="id">Ticket #<\/button><\/th><th class="name">/, 'Ticket # is the left-most heading (SP-193)');
    assert.doesNotMatch(none, /aria-sort|▲|▼/);
    assert.match(none, /<th class="actions">Actions<\/th>/);
    const up = renderSortHeadings({ column: 'priority', direction: 'ascending' });
    assert.match(up, /<th class="priority" aria-sort="ascending"><button[^>]*data-sort="priority">Priority <span class="arrow" aria-hidden="true">▲<\/span><\/button><\/th>/);
    assert.equal((up.match(/aria-sort/g) || []).length, 1);
    assert.equal((up.match(/[▲▼]/g) || []).length, 1);
    const down = renderSortHeadings({ column: 'when', direction: 'descending' });
    assert.match(down, /<th class="when" aria-sort="descending">.*Last Change <span class="arrow" aria-hidden="true">▼/);
  });

  test('the minute\'s redraw keeps each stage\'s sort; a reload does not', () => {
    const app = readFileSync(WEB('app.mjs'), 'utf8');
    const place = /function keepPlace\(\) \{[\s\S]*?\n\}/.exec(app)[0];
    // Read by stage before the redraw, put back on that stage's new table after it.
    assert.match(place, /const sorts = new Map\(sortableTables\(\)\.filter\(\(\{ table \}\) => sorted\.get\(table\)\?\.sort\)\.map\(\(\{ table, stage \}\) => \[stage, sorted\.get\(table\)\.sort\]\)\);/);
    assert.match(place, /restore\(\) \{[\s\S]*for \(const \{ table, stage \} of sortableTables\(\)\) if \(sorts\.has\(stage\)\) sorted\.get\(table\)\?\.apply\(sorts\.get\(stage\)\);[\s\S]*window\.scrollTo/);
    assert.match(app, /const sortableTables = \(\) => \[\.\.\.main\.querySelectorAll\('\[data-stage\] table\.sortable'\)\]\s*\.map\(\(table\) => \(\{ table, stage: table\.closest\('\[data-stage\]'\)\.dataset\.stage \}\)\);/);
    const wire = /function wireSortHeadings\(stages\) \{[\s\S]*?\n\}/.exec(app)[0];
    // Every new table can take a sort back before he clicks it, and a click starts from what it shows.
    assert.match(wire, /sorted\.set\(table, \{ sort: null, apply \}\);/);
    assert.match(wire, /sorted\.set\(table, \{ sort, apply \}\);/);
    assert.match(wire, /nextSort\(sorted\.get\(table\)\?\.sort \?\? null, button\.dataset\.sort\)/);
    // Only a beat's redraw passes a place; a fresh visit or reload draws with none, so no sort.
    assert.match(app, /const sorted = new WeakMap\(\);/);
    assert.equal((app.match(/keepPlace\(\)/g) ?? []).length, 2, 'defined once, called only by refreshPage');
  });

  test('the List view\'s tables use the sortable headings, and only they are bold and black', () => {
    const app = readFileSync(WEB('app.mjs'), 'utf8');
    assert.match(app, /<table class="sortable"><thead>\$\{renderSortHeadings\(null\)\}<\/thead>/);
    assert.match(app, /<tr data-id="\$\{escapeHtml\(t\.id\)\}">/);
    // SP-193: the id is the first cell, a link to the ticket, and the name cell no longer repeats it.
    const row = /const row = \(status\) => \(t\) => `[\s\S]*?<\/tr>`;/.exec(app)[0];
    assert.match(row, /<tr data-id="[^\n]*">\s*<td class="id"><a href="\/t\/\$\{encodeURIComponent\(t\.id\)\}">\$\{escapeHtml\(t\.id\)\}<\/a><\/td>\s*<td class="name">/);
    const nameCell = /<td class="name">.*<\/td>/.exec(row)[0];
    assert.doesNotMatch(nameCell, /escapeHtml\(t\.id\)/, 'the name cell shows only the name');
    assert.doesNotMatch(nameCell, /ANSWER_IN_NOTE|answer-in/, 'the answer-in words are gone from the name cell (SP-201)');
    assert.equal((row.match(/<td class="/g) || []).length, SORT_COLUMNS.length + 1, 'one cell per heading, plus Actions');
    const css = readFileSync(WEB('app.css'), 'utf8');
    assert.match(css, /\.group table\.sortable th \{ color: #000; font-weight: 700; \}/);
    // SP-193: Ticket # is narrow; the name keeps most of the width, and the set widths leave Last Change room.
    const width = (key) => Number(new RegExp(`\\.group th\\.${key} \\{ width: (\\d+)%; \\}`).exec(css)?.[1]);
    assert.ok(width('id') > 0 && width('id') < width('name'), 'Ticket # narrower than Ticket');
    const set = ['id', 'name', 'priority', 'tags', 'assignee', 'actions'].reduce((sum, k) => sum + width(k), 0);
    assert.ok(set <= 76, `the set widths (${set}%) leave Last Change room for its date`);
    assert.match(css, /^th \{ color: var\(--quiet\); font-weight: 500;/m, 'every other table keeps the grey heading');
  });
}

test('every page has one body width: main is capped at 1440px, padding included, and no page widens it (SP-184)', () => {
  const css = readFileSync(WEB('app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = css.split('}').map((r) => r.split('{')).filter((r) => r.length === 2)
    .map(([sel, body]) => ({ sel: sel.split(',').map((x) => x.trim()), body }));
  const plain = rules.filter((r) => r.sel.includes('main'));
  assert.equal(plain.length, 1, 'one rule for the page body');
  assert.match(plain[0].body, /max-width: 1440px/);
  assert.match(plain[0].body, /box-sizing: border-box/, 'the 1440px includes the side padding');
  assert.match(plain[0].body, /margin: 0 auto/, 'centred');
  const perPage = rules.filter((r) => r.sel.some((s) => /^main[.#:\[]/.test(s) && !/\s/.test(s) && /(?:max-|min-)?width/.test(r.body)));
  assert.deepEqual(perPage.map((r) => r.sel.join(', ')), [], 'no page gives the body a width of its own');
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.doesNotMatch(app, /main\.classList\.(?:add|remove|toggle)\(\s*['"]wide['"]/, 'no wide class on the page body');
});

test('Reference Docs and Work Log: each docs/ file\'s kind comes from its folder and its date from its name (SP-195)', () => {
  assert.deepEqual(docInfo('work-log/2026-11-10-docs-page-spirality-docs.md'), { kind: 'Work Log', date: '2026-11-10' });
  assert.deepEqual(docInfo('PLAN.md'), { kind: 'Reference', date: null });
  assert.deepEqual(docInfo('onboarding/WIZARD.md'), { kind: 'Onboarding', date: null });
  assert.deepEqual(docInfo('drafts/2026-01-02-idea.md'), { kind: 'drafts', date: '2026-01-02' }, 'any other folder is its own kind');
  assert.deepEqual(docInfo('work-log/2026-13-01-x.md'), { kind: 'Work Log', date: null }, 'not a real month, no date');
  assert.deepEqual(docInfo('work-log/20261110-x.md'), { kind: 'Work Log', date: null });
  assert.equal(docDay('2026-11-10'), 'Nov 10, 2026', 'a calendar day, never shifted by time zone');
  assert.equal(docDay(null), '');
  assert.deepEqual(DOC_KINDS, ['Reference', 'Onboarding', 'Work Log']);
});

const DOCS = [
  { path: 'work-log/2026-10-12-first.md', title: 'First entry' },
  { path: 'PLAN.md', title: 'The plan' },
  { path: 'work-log/2026-11-10-docs-page-spirality-docs.md', title: 'Docs page' },
  { path: 'onboarding/WIZARD.md', title: 'WIZARD' },
  { path: 'LOOP_CONTRACT.md', title: 'The loop contract' },
  { path: 'work-log/2026-11-01-middle.md', title: 'Middle entry' },
];

test('Reference Docs and Work Log opens Reference, then Onboarding, then Work Log newest first; Title, Kind and Date sort both ways (SP-195)', () => {
  const rows = docRows(DOCS);
  assert.deepEqual(rows.map((r) => r.path), ['LOOP_CONTRACT.md', 'PLAN.md', 'onboarding/WIZARD.md',
    'work-log/2026-11-10-docs-page-spirality-docs.md', 'work-log/2026-11-01-middle.md', 'work-log/2026-10-12-first.md']);
  const up = sortDocs(rows, { column: 'date', direction: 'ascending' }).map((r) => r.path);
  assert.deepEqual(up.slice(0, 3), ['work-log/2026-10-12-first.md', 'work-log/2026-11-01-middle.md', 'work-log/2026-11-10-docs-page-spirality-docs.md'], 'oldest first');
  assert.deepEqual(up.slice(3), ['LOOP_CONTRACT.md', 'PLAN.md', 'onboarding/WIZARD.md'], 'no date goes last, in the opening order');
  const down = sortDocs(rows, { column: 'date', direction: 'descending' }).map((r) => r.path);
  assert.equal(down[3], 'work-log/2026-11-10-docs-page-spirality-docs.md', 'newest first after the undated ones');
  assert.deepEqual(sortDocs(rows, { column: 'title', direction: 'ascending' }).map((r) => r.title), ['Docs page', 'First entry', 'Middle entry', 'The loop contract', 'The plan', 'WIZARD']);
  assert.deepEqual(sortDocs(rows, { column: 'title', direction: 'descending' }).map((r) => r.title)[0], 'WIZARD');
  assert.deepEqual(sortDocs(rows, { column: 'kind', direction: 'descending' }).map((r) => r.kind), ['Work Log', 'Work Log', 'Work Log', 'Onboarding', 'Reference', 'Reference']);
  assert.deepEqual(sortDocs(rows, null), rows, 'no sort, the opening order');
  assert.equal(rows.length, DOCS.length);
  assert.equal(DOCS[0].path, 'work-log/2026-10-12-first.md', 'the list is never changed');
});

test('Reference Docs and Work Log: the Kind drop-down and the search box narrow the rows together, and the count line agrees (SP-195)', () => {
  const rows = docRows(DOCS);
  assert.equal(filterDocs(rows, {}).length, 6);
  assert.deepEqual(filterDocs(rows, { kind: 'Work Log' }).map((r) => r.title), ['Docs page', 'Middle entry', 'First entry']);
  assert.deepEqual(filterDocs(rows, { kind: 'Work Log', text: 'DOCS' }).map((r) => r.title), ['Docs page'], 'title or path, any case');
  assert.deepEqual(filterDocs(rows, { text: 'plan.md' }).map((r) => r.path), ['PLAN.md'], 'the path');
  assert.deepEqual(filterDocs(rows, { text: 'spirality-docs' }).map((r) => r.title), ['Docs page'], 'a path word not in the title');
  assert.deepEqual(filterDocs(rows, { text: '  ' }).length, 6, 'blank matches all');
  assert.deepEqual(filterDocs(rows, { kind: 'Onboarding', text: 'plan' }), []);
  assert.equal(docCountLine(1, 6), 'Showing 1 of 6');
  assert.equal(docCountLine(0, 6), 'No document matches.');
});

test('Reference Docs and Work Log is folded, counted, sortable by Title, Kind and Date, every word escaped (SP-195)', () => {
  const html = renderDocumentation([...DOCS, { path: 'x/<b>.md', title: 'Bad <i>' }], (p) => `/docs/spirality/${p}`);
  assert.match(html, /^<details class="spirality-docs"><summary><h2>Reference Docs and Work Log \(7\)<\/h2><\/summary>/, 'closed when the page opens: no open attribute');
  assert.doesNotMatch(html, /<details[^>]*\sopen/);
  for (const k of ['All', 'Reference', 'Onboarding', 'Work Log', 'x']) assert.match(html, new RegExp(`<option value="${k === 'All' ? '' : k}">${k}</option>`), k);
  assert.match(html, /<input type="search" id="doc-search"/);
  assert.match(html, /Showing 7 of 7/);
  assert.match(html, /<th class="title"><button type="button" class="sort" data-sort="title">Title<\/button><\/th><th class="kind">.*data-sort="kind">Kind<\/button><\/th><th class="date">.*data-sort="date">Date<\/button><\/th><th class="path">Path<\/th>/);
  assert.match(html, /<a href="\/docs\/spirality\/work-log\/2026-11-10-docs-page-spirality-docs\.md">Docs page<\/a><\/td>\s*<td class="kind">Work Log<\/td>\s*<td class="date">Nov 10, 2026<\/td>/);
  assert.match(html, /<a href="\/docs\/spirality\/PLAN\.md">The plan<\/a><\/td>\s*<td class="kind">Reference<\/td>\s*<td class="date"><\/td>/);
  assert.doesNotMatch(html, /<b>|<i>/, 'nothing unescaped');
  assert.match(renderDocHeadings({ column: 'date', direction: 'descending' }), /<th class="date" aria-sort="descending"><button type="button" class="sort" data-sort="date">Date <span class="arrow" aria-hidden="true">▼<\/span>/);
  assert.match(renderDocHeadings({ column: 'title', direction: 'ascending' }), /<th class="title" aria-sort="ascending">.*▲/);
  assert.doesNotMatch(renderDocHeadings(null), /aria-sort/);
  assert.match(renderDocBody([{ path: 'a b.md', title: 'T', kind: 'Reference', date: null }], (p) => `/x/${encodeURIComponent(p)}`), /href="\/x\/a%20b\.md"/);
  assert.match(renderDocumentation(null, String), /Reference Docs and Work Log<\/h2>.*could not be read/s);
  assert.match(renderDocumentation([], String), /Reference Docs and Work Log \(0\)<\/h2>.*no Markdown files/s);
});

test('the Docs page puts Reference Docs and Work Log last in the right column, with or without projects, and wires its controls (SP-195, SP-212)', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = app.slice(app.indexOf('async function drawDocs'), app.indexOf('/** The command a `/docs/commands/<name>` address opens'));
  assert.match(draw, /\$\{docsColumns\(`<h2>Task Files<\/h2><p class="quiet">There are no projects yet\.<\/p>\$\{documentation\}`\)\}`;\s*showCommands\(commands\);\s*wireDocumentation\(files\);/, 'no projects: last too');
  assert.match(draw, /has a file yet\.<\/p>`\}\n    \$\{documentation\}`\)\}`;/, 'below Task Files, last on the right');
  assert.equal((draw.match(/\$\{documentation\}/g) ?? []).length, 2, 'drawn once in each case, never above');
  assert.equal((draw.match(/wireDocumentation\(files\);/g) ?? []).length, 2);
  const wire = draw.slice(draw.indexOf('function wireDocumentation'));
  assert.match(wire, /kind\.addEventListener\('change', show\);/);
  assert.match(wire, /search\.addEventListener\('input', show\);/);
  assert.match(wire, /sortDocs\(filterDocs\(rows, \{ kind: kind\.value, text: search\.value \}\), sort\)/, 'both filters together, then the sort');
  assert.match(wire, /sort = nextSort\(sort, button\.dataset\.sort\);/, 'a second click reverses it');
  assert.match(wire, /count\.textContent = docCountLine\(shown\.length, rows\.length\);/, 'the count line is text, matching the rows shown');
});

test('npm run clickup -- pause-check: exit 0 running, 3 paused naming who and when, 3 on a failed read or a lane with no switch, 2 with no lane (SP-237)', async () => {
  const f = await fixture();
  try {
    const running = await f.door('alpha', 'pause-check', '--lane', 'loop-build');
    assert.equal(running.code, 0, running.err);
    assert.equal(running.out.trim(), 'running — neither the whole pipeline nor loop-build is paused');

    f.store.setPipelineSetting({ project: 'alpha', setting: 'paused.loop-build', value: 'on', actor: f.operator.id });
    const lane = await f.door('alpha', 'pause-check', '--lane', 'loop-build');
    assert.equal(lane.code, 3, lane.err);
    assert.match(lane.out.trim(), /^paused by Dane at [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d\d [AP]M M[SD]T — not starting \/loop-build \(loop-build is paused/);
    const other = await f.door('alpha', 'pause-check', '--lane', 'loop-review');
    assert.equal(other.code, 0, 'the other lanes run as normal');

    f.store.setPipelineSetting({ project: 'alpha', setting: 'paused', value: 'on', actor: f.operator.id });
    for (const l of ['loop-intake', 'loop-review', 'relay']) {
      const r = await f.door('alpha', 'pause-check', '--lane', l);
      assert.equal(r.code, 3, l);
      assert.match(r.out, /the whole pipeline is paused/);
    }

    // Resume: the lane may start again.
    f.store.setPipelineSetting({ project: 'alpha', setting: 'paused', value: 'off', actor: f.operator.id });
    f.store.setPipelineSetting({ project: 'alpha', setting: 'paused.loop-build', value: 'off', actor: f.operator.id });
    assert.equal((await f.door('alpha', 'pause-check', '--lane', 'loop-build')).code, 0);

    const unreadable = await f.door('nope', 'pause-check', '--lane', 'loop-build');
    assert.equal(unreadable.code, 3, 'settings that cannot be read count as paused');
    assert.match(unreadable.out, /^could not read the pipeline settings, so \/loop-build is treated as PAUSED and not starting \(it fails safe[^)]*\)\. Reason: HTTP 404/);

    // A lane with no switch of its own fails safe, naming the missing setting; no lane at all is refused.
    const unknown = await f.door('alpha', 'pause-check', '--lane', 'loop-nonsense');
    assert.equal(unknown.code, 3);
    assert.match(unknown.out, /has no "paused\.loop-nonsense" setting/);
    const bad = await f.door('alpha', 'pause-check');
    assert.equal(bad.code, 2);
    assert.match(bad.err, /--lane names the lane asking/);
  } finally { await f.cleanup(); }
});

test('the Pipeline Status pod, its label and its dialog show a paused stage as Paused, never due, and a running one as finishing (SP-237)', () => {
  const timeOf = (iso) => iso.slice(11, 16);
  const now = Date.parse('2026-11-13T15:00:00Z');
  const answer = { stages: [
    { name: 'Relay', job: 'relay', logged: true, running: false, nextDue: '2026-11-13T14:00:00Z', paused: 'pipeline' },
    { name: 'Build', job: 'loop-build', logged: true, running: true, lastStart: '2026-11-13T14:50:00Z', nextDue: null, paused: 'lane' },
    { name: 'Review', job: 'loop-review', logged: true, running: false, nextDue: '2026-11-13T15:01:00Z', paused: null },
  ] };
  const pod = renderPipelinePod(answer, timeOf, now);
  assert.match(pod, /<span class="stage paused" title="Relay: the whole pipeline is paused on the Settings page">Relay<\/span><span class="time paused"[^>]*>Paused<\/span>/);
  assert.doesNotMatch(pod, /Relay: next pass due/, 'a paused stage is never due');
  assert.match(pod, /<span class="time running" title="Build: a pass is running now; Build is paused, so it finishes and no new one starts">running<\/span>/);
  assert.match(pod, /<span class="time soon"[^>]*>15:01<\/span>/, 'an unpaused stage is unchanged');
  assert.equal(pipelinePodLabel(answer, timeOf), 'Pipeline Status: Relay paused, Build running, Review 15:01');
  const details = renderPipelineDetails(answer, timeOf);
  assert.match(details, /<th scope="row">Relay<\/th><td>Paused \(the whole pipeline is paused\)<\/td>/);
  assert.match(details, /Running now, since 14:50 \(paused: this pass finishes, no new one starts\)/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /\.toolbar \.pipeline-pod \.time\.paused \{/);
});

test('GET /pipeline-controls lists the tickets in flight, and the Settings page says Draining while a pause waits on them, then Paused: nothing in flight (SP-237)', async () => {
  const f = await fixture();
  try {
    const { body } = await f.call('GET', '/pipeline-controls/alpha');
    const building = f.store.listTickets('alpha').filter((t) => t.status === 'building').map((t) => t.id);
    assert.deepEqual(body.inFlight.filter((t) => t.kind === 'a build').map((t) => t.id), building);
    assert.ok(body.inFlight.every((t) => ['a build', 'a review'].includes(t.kind)));

    const view = (on, inFlight) => ({
      controls: ['paused', 'paused.loop-build', 'paused.loop-review', 'paused.loop-intake'].map((key) => ({ key, group: 'pause', value: on.includes(key) ? 'on' : 'off' })),
      inFlight,
    });
    const build = { id: 'AL-7', name: 'Build <it>', status: 'building', kind: 'a build' };
    const review = { id: 'AL-9', name: 'Check it', status: 'in review', kind: 'a review' };
    assert.equal(drainLine(view([], [build])), '', 'nothing paused, nothing said');
    const whole = drainLine(view(['paused'], [build, review]));
    assert.match(whole, /<div class="drain draining"><p>Draining: 2 ticket\(s\) still finishing\.<\/p>/);
    assert.match(whole, /<a href="\/t\/AL-7">AL-7<\/a> Build &lt;it&gt; <span class="quiet">\(a build\)<\/span>/);
    // One lane waits only on its own kind of pass; intake has none to wait on.
    assert.match(drainLine(view(['paused.loop-review'], [build, review])), /Draining: 1 ticket\(s\)[\s\S]*AL-9/);
    assert.equal(drainLine(view(['paused.loop-intake'], [build, review])), '<p class="drain paused">Paused: nothing in flight.</p>');
    assert.equal(drainLine(view(['paused'], [])), '<p class="drain paused">Paused: nothing in flight.</p>');

    // On the page, under the pause switches, once a switch is on.
    const saved = await f.call('PUT', '/pipeline-controls/alpha', { body: { setting: 'paused', value: 'on' } });
    assert.equal(saved.status, 200);
    const html = renderPipelineControls(saved.body);
    assert.match(html, /<h4>Pause and Resume<\/h4>[\s\S]*?<div class="drain-box">(<div class="drain draining">|<p class="drain paused">)[\s\S]*?<h4>Work-in-Progress Cap<\/h4>/);
    // The page reads the drain line again while it drains, redrawing only that line.
    const app = readFileSync(WEB('app.mjs'), 'utf8');
    assert.match(app, /if \(!box\.querySelector\('\.drain\.draining'\)\) return;/);
    assert.match(app, /if \(slot\) slot\.innerHTML = drainLine\(v\);/);
  } finally { await f.cleanup(); }
});

test('GET /pipeline marks the stages paused from the project\'s controls (SP-237)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-pipeline-paused-'));
  const store = openStore(join(dir, 'tracker.db'), { now: tickingClock() });
  const seed = seedDemo(store, { operatorName: 'Dane', clock: tickingClock() });
  const server = await startServer({ store, port: 0, pipeline: { logDir: dir, slug: 'alpha' } });
  try {
    store.setPipelineSetting({ project: 'alpha', setting: 'paused.relay', value: 'on', actor: seed.operator.id });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/pipeline`, { headers: { authorization: `Bearer ${seed.token}` } });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(Object.fromEntries(body.stages.map((s) => [s.job, s.paused])), { relay: 'lane', 'loop-build': null, 'loop-review': null, 'loop-intake': null });
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── The Console view (SP-233) ────────────────────────────────────────────────

const CONSOLE_NOW = Date.parse('2026-11-12T18:00:00.000Z');
const consoleTicket = (over = {}) => ({
  id: 'AL-7', project: 'alpha', name: 'Fix the thing', status: 'Queued', tags: [], priority: null, assignee: null,
  updatedAt: '2026-11-12T15:00:00.000Z', stageSince: '2026-11-12T15:00:00.000Z',
  waitingOnOperator: false, answerIn: false, pullRequest: null,
  nextChange: { kind: 'lane', lane: 'Build', job: 'loop-build', running: false, due: '2026-11-12T18:12:00.000Z' },
  ...over,
});
const ALPHA = { slug: 'alpha', name: 'Alpha', prefix: 'AL', logo: 'https://alpha.example/logo.png' };
const BETA = { slug: 'beta', name: 'Beta', prefix: 'BE', logo: null };

test('a Console tile for a project with a logo: the logo, the number over it, stage, next change and time in stage, a link to the ticket', () => {
  const html = renderConsoleTile(consoleTicket(), ALPHA, CONSOLE_NOW);
  assert.match(html, /^<a class="tile" href="\/t\/AL-7" title="AL-7: Fix the thing"/);
  assert.match(html, /<img class="tile-logo" src="https:\/\/alpha\.example\/logo\.png" alt="" referrerpolicy="no-referrer">/);
  assert.doesNotMatch(html, /tile-prefix/);
  assert.match(html, /<span class="tile-number">AL-7<\/span>/);
  assert.match(html, /<span class="fact stage" data-stage="Queued">Queued<\/span>/);
  assert.match(html, /<span class="fact next" title="Build&#39;s next pass is due Nov 12, 2026, 11:12 AM MST">in 12 min<\/span>/);
  assert.match(html, /<span class="fact age" title="In Queued for 3h">3h<\/span>/);
});

test('a Console tile for a project with no logo shows its ticket prefix in large letters; a logo that is not a web address is not drawn', () => {
  const html = renderConsoleTile(consoleTicket({ id: 'BE-2', project: 'beta' }), BETA, CONSOLE_NOW);
  assert.match(html, /<span class="tile-prefix" aria-hidden="true">BE<\/span>/);
  assert.doesNotMatch(html, /<img/);
  const odd = renderConsoleTile(consoleTicket(), { ...ALPHA, logo: 'javascript:alert(1)' }, CONSOLE_NOW);
  assert.doesNotMatch(odd, /<img|javascript:/);
  assert.match(odd, /<span class="tile-prefix" aria-hidden="true">AL<\/span>/);
  // No project in the answer: the prefix is read off the ticket number.
  assert.match(renderConsoleTile(consoleTicket({ id: 'ZZ-1' }), null, CONSOLE_NOW), /<span class="tile-prefix" aria-hidden="true">ZZ<\/span>/);
});

test('a Console tile waiting on the operator is ringed, and its next change is "You"', () => {
  const his = renderConsoleTile(consoleTicket({ status: 'Needs your input', waitingOnOperator: true, nextChange: { kind: 'operator' } }), ALPHA, CONSOLE_NOW);
  assert.match(his, /^<a class="tile waiting"/);
  assert.match(his, /<span class="fact next" title="Your move: no lane acts on it until you do">You<\/span>/);
  assert.match(his, /waiting on you\.">/);
  assert.equal(consoleWaiting(consoleTicket({ answerIn: true })), true, 'an answer of his that is in');
  assert.equal(consoleWaiting(consoleTicket({ nextChange: { kind: 'operator' } })), true, 'one of his statuses');
  assert.equal(consoleWaiting(consoleTicket()), false);
  assert.match(renderConsoleTile(consoleTicket(), ALPHA, CONSOLE_NOW), /^<a class="tile" /);
});

test('a Console tile whose next change is unknown shows a dash; Building and a running lane show "Now"', () => {
  for (const nextChange of [null, undefined, { kind: 'lane', due: null }, { kind: 'lane', due: 'not a time' }, { kind: 'odd' }]) {
    assert.deepEqual(consoleNextChange(nextChange, CONSOLE_NOW), { text: CONSOLE_UNKNOWN, title: 'When the next pass picks it up is not known' });
  }
  assert.match(renderConsoleTile(consoleTicket({ nextChange: null }), ALPHA, CONSOLE_NOW), /<span class="fact next" title="When the next pass picks it up is not known">—<\/span>/);
  assert.equal(consoleNextChange({ kind: 'running', lane: 'Build', job: 'loop-build' }, CONSOLE_NOW).text, 'Now');
  assert.equal(consoleNextChange({ kind: 'lane', lane: 'Review', running: true, due: null }, CONSOLE_NOW).text, 'Now');
  assert.equal(consoleNextChange({ kind: 'lane', lane: 'Review', running: false, due: '2026-11-12T17:59:00.000Z' }, CONSOLE_NOW).text, 'Now', 'a pass already due');
  assert.equal(consoleNextChange({ kind: 'lane', lane: 'Review', running: false, due: '2026-11-12T20:10:00.000Z' }, CONSOLE_NOW).text, 'in 2 h');
});

test('a Console next change counts whole hours down the way it counts minutes, never rounding up', () => {
  const at = (minutes) => consoleNextChange({ kind: 'lane', lane: 'Review', running: false, due: new Date(CONSOLE_NOW + minutes * 60_000).toISOString() }, CONSOLE_NOW).text;
  assert.equal(at(59), 'in 59 min');
  assert.equal(at(60), 'in 1 h');
  assert.equal(at(89), 'in 1 h', 'not "in 1 h" at 89 and "in 2 h" at 90');
  assert.equal(at(90), 'in 1 h');
  assert.equal(at(119), 'in 1 h');
  assert.equal(at(120), 'in 2 h');
});

test('time in stage reads short: minutes, hours under two days, then days; an unreadable time is a dash', () => {
  assert.equal(consoleAge('2026-11-12T17:59:30.000Z', CONSOLE_NOW), '0m');
  assert.equal(consoleAge('2026-11-12T17:15:00.000Z', CONSOLE_NOW), '45m');
  assert.equal(consoleAge('2026-11-11T18:00:00.000Z', CONSOLE_NOW), '24h');
  assert.equal(consoleAge('2026-11-09T18:00:00.000Z', CONSOLE_NOW), '3d');
  assert.equal(consoleAge(null, CONSOLE_NOW), CONSOLE_UNKNOWN);
});

test('a Console tile escapes every piece of ticket and project text', () => {
  const html = renderConsoleTile(consoleTicket({ id: 'AL-<b>', name: '<script>alert(1)</script> "x"', status: '<i>Queued</i>' }), { ...ALPHA, prefix: '<u>', logo: 'https://a.example/x.png?"><script>' }, CONSOLE_NOW);
  assert.doesNotMatch(html, /<script>|<b>|<i>|<u>|"><script/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &quot;x&quot;/);
  assert.match(html, /href="\/t\/AL-%3Cb%3E"/);
});

test('the Console groups tiles by stage in the order given, shows an empty stage\'s heading, never draws Live, and never drops a ticket', () => {
  const stages = ['Requested', 'Rework', 'Queued', 'Building', 'In review', 'Needs your input', 'Ready to launch', 'Live'];
  const answer = {
    projects: [ALPHA, BETA],
    tickets: [
      consoleTicket({ id: 'AL-1', status: 'Queued' }),
      consoleTicket({ id: 'BE-1', project: 'beta', status: 'Needs your input', nextChange: { kind: 'operator' } }),
      consoleTicket({ id: 'AL-2', status: 'Odd' }),
    ],
  };
  const html = renderConsole(answer, stages, CONSOLE_NOW);
  const order = [...html.matchAll(/<section class="console-stage" data-stage="([^"]+)">/g)].map((m) => m[1]);
  assert.deepEqual(order, ['Requested', 'Rework', 'Queued', 'Building', 'In review', 'Needs your input', 'Ready to launch', 'Odd']);
  assert.match(html, /data-stage="Requested"><h2><span class="stage-name">Requested<\/span><span class="count quiet">0<\/span><\/h2><div class="tiles"><\/div>/);
  const queued = html.slice(html.indexOf('data-stage="Queued">'), html.indexOf('data-stage="Building">'));
  assert.match(queued, /href="\/t\/AL-1"/);
  assert.match(queued, /tile-logo/);
  const his = html.slice(html.indexOf('<section class="console-stage" data-stage="Needs your input">'), html.indexOf('<section class="console-stage" data-stage="Ready to launch">'));
  assert.match(his, /<a class="tile waiting" href="\/t\/BE-1"/);
  assert.match(his, /tile-prefix" aria-hidden="true">BE</);
  // No stage list (it could not be read): the tickets' own stages, in the answer's order.
  const bare = renderConsole(answer, [], CONSOLE_NOW);
  assert.deepEqual([...bare.matchAll(/<section class="console-stage" data-stage="([^"]+)">/g)].map((m) => m[1]), ['Queued', 'Needs your input', 'Odd']);
  assert.equal(renderConsole(null, [], CONSOLE_NOW), '<div class="console"></div>');
});

test('the Console page: /in-flight and the stage colours drawn, a Console link beside Board and List, remembered for "Tasks", redrawn every beat', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = /async function drawConsole\(\) \{([\s\S]*?)\n\}/.exec(app)[1];
  assert.match(draw, /api\('GET', '\/in-flight'\)/);
  assert.match(draw, /api\('GET', '\/stage-colours'\)/);
  assert.match(draw, /localStorage\.setItem\(VIEW_KEY, 'console'\)/);
  assert.match(draw, /renderConsole\(answer, stages\)/);
  assert.match(draw, /viewSwitch\(slug, 'console'\)/);
  // The view switch names all three in Title Case, the current one marked.
  const sw = /function viewSwitch\(slug, current\) \{([\s\S]*?)\n\}/.exec(app)[1];
  assert.match(sw, /\['board', 'Board', [^\]]+\], \['list', 'List', [^\]]+\], \['console', 'Console', '\/console'\]/);
  assert.match(sw, /v === current \? ' class="current" aria-current="page"' : ''/);
  assert.match(/async function drawProject\(([^)]*)\) \{([\s\S]*?)\n\}/.exec(app)[2], /\$\{viewSwitch\(board\.project, view\)\}/);
  // "Tasks" in the header reopens the Console when it was chosen last.
  assert.match(app, /await drawTasks\(tasks \? savedTasksView\(\) : project\[1\]\);/);
  assert.match(/async function drawTasks\(view, opts = \{\}\) \{([\s\S]*?)\n\}/.exec(app)[1], /if \(view === 'console'\) \{\s*history\.replaceState\(null, '', '\/console'\);\s*return drawConsole\(\);/);
  // The minute's beat draws it again whether or not the answer changed, so "in 12 min" counts down.
  assert.match(app, /lastDrawn = \{ address: here\(\), reads, ticking: true \}/);
  assert.match(app, /const changed = drawn\.ticking \|\|/);
  // That beat does not read every answer first only to throw it away: one read of /in-flight a minute, not two.
  const refresh = /async function refreshPage\(\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(refresh, /const now = drawn\.ticking \? \[\] : await Promise\.all\(/);
});

test('the Console\'s minute redraw keeps how far across he has scrolled', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  assert.match(app, /const SIDEWAYS = '\.console';/);
  const place = /function keepPlace\(\) \{[\s\S]*?\n\}/.exec(app)[0];
  // Read before the redraw, put back on the new columns before the page is shown.
  assert.match(place, /const across = \[\.\.\.main\.querySelectorAll\(SIDEWAYS\)\]\.map\(\(el\) => el\.scrollLeft\);/);
  assert.match(place, /restore\(\) \{[\s\S]*\[\.\.\.main\.querySelectorAll\(SIDEWAYS\)\]\.forEach\(\(el, i\) => \{ if \(i < across\.length\) el\.scrollLeft = across\[i\]; \}\);[\s\S]*window\.scrollTo\(0, y\);/);
  // The Console's columns are the area that scrolls sideways.
  assert.match(renderConsole({ tickets: [], projects: [] }, ['Queued']), /^<div class="console">/);
  assert.match(readFileSync(WEB('app.css'), 'utf8'), /\.console \{[^}]*overflow-x: auto/);
});

test('beside the work-in-progress cap: the count in flight now, marked full at the cap, nothing when unknown (SP-238)', () => {
  const cap = { key: 'wip-cap', value: '3' };
  assert.equal(capInFlightText(cap, { count: 2, ids: ['SP-1', 'SP-2'] }), '<span class="in-flight">2 in flight now.</span>');
  assert.equal(capInFlightText(cap, { count: 3, ids: ['SP-1', 'SP-2', 'SP-3'] }),
    '<span class="in-flight full">3 in flight now: full, loop-build is not claiming new tickets.</span>');
  assert.equal(capInFlightText(cap, undefined), '');
  assert.equal(capInFlightText(cap, { count: null }), '');
});

// ── The Console's feature colours (SP-234) ──────────────────────────────────

test('a ticket\'s feature is its first tag, passing over request-form; no tag, or only request-form, is no feature', () => {
  assert.equal(consoleFeature(consoleTicket({ tags: ['tracker', 'tracker-5'] })), 'tracker');
  assert.equal(consoleFeature(consoleTicket({ tags: ['request-form', 'console'] })), 'console');
  assert.equal(consoleFeature(consoleTicket({ tags: ['request-form'] })), null);
  assert.equal(consoleFeature(consoleTicket({ tags: [] })), null);
  assert.equal(consoleFeature(consoleTicket({ tags: null })), null);
  assert.equal(consoleFeature(consoleTicket({ tags: ['', '  '] })), null);
});

test('a feature\'s colour is a pure function of its tag: the same on every call, always a palette colour, and different tags usually differ', () => {
  for (const tag of ['tracker', 'console', 'onboarding', 'ünïcode', '']) {
    const i = featureColourIndex(tag);
    assert.ok(Number.isInteger(i) && i >= 0 && i < FEATURE_PALETTE.length, tag);
    assert.equal(featureColourIndex(tag), i, `${tag} keeps its colour`);
  }
  // Fixed values, so a change to the rule (which would recolour every feature) is a decision, not an accident.
  assert.deepEqual(['tracker', 'console', 'onboarding'].map(featureColourIndex), [5, 8, 6]);
  const many = Array.from({ length: 200 }, (_, i) => featureColourIndex(`feature-${i}`));
  assert.equal(new Set(many).size, FEATURE_PALETTE.length, 'the rule uses every colour');
});

test('two tiles with the same feature share a colour class; a tile with no feature keeps the plain tile', () => {
  const a = renderConsoleTile(consoleTicket({ id: 'AL-1', tags: ['tracker'] }), ALPHA, CONSOLE_NOW);
  const b = renderConsoleTile(consoleTicket({ id: 'BE-1', project: 'beta', tags: ['tracker', 'other'] }), BETA, CONSOLE_NOW);
  const n = featureColourIndex('tracker');
  for (const html of [a, b]) {
    assert.match(html, new RegExp(`^<a class="tile feature feature-${n}" data-feature="tracker" `));
    assert.match(html, /aria-label="[^"]*; feature tracker\."/);
  }
  assert.match(renderConsoleTile(consoleTicket({ tags: ['request-form'] }), ALPHA, CONSOLE_NOW), /^<a class="tile" href=/);
  assert.match(renderConsoleTile(consoleTicket({ tags: ['x'], waitingOnOperator: true }), ALPHA, CONSOLE_NOW), /^<a class="tile feature feature-\d+ waiting" data-feature="x" /);
  assert.match(renderConsoleTile(consoleTicket({ tags: ['<b>"'] }), ALPHA, CONSOLE_NOW), /data-feature="&lt;b&gt;&quot;"/);
});

test('every feature colour has its rule in app.css, in palette order, and the tile\'s text reads on it', () => {
  const css = readFileSync(WEB('app.css'), 'utf8');
  const rules = [...css.matchAll(/^\.feature-(\d+) \{ --feature: (#[0-9a-f]{6}); \}$/gm)].map((m) => [Number(m[1]), m[2]]);
  assert.deepEqual(rules, FEATURE_PALETTE.map((c, i) => [i, c]));
  assert.match(css, /\.tile\.feature \{ background: var\(--feature\); \}/);
  assert.match(css, /\.tile\.dimmed \{ opacity: [0-9.]+; \}/);
  const ink = /--ink: (#[0-9a-f]{6})/.exec(css)[1];
  for (const colour of FEATURE_PALETTE) assert.ok(contrast(ink, colour) >= 4.5, `${ink} reads on ${colour}`);
  // The facts strip stays white, so the stage colours and the quiet age read as before.
  assert.match(css, /\.tile\.feature \.tile-facts \{ background: #fff; \}/);
});

test('the Features key lists each feature on screen with its count, most first, and nothing when there is none', () => {
  const tickets = [
    consoleTicket({ id: 'AL-1', tags: ['console'] }),
    consoleTicket({ id: 'AL-2', tags: ['tracker'] }),
    consoleTicket({ id: 'AL-3', tags: ['tracker'] }),
    consoleTicket({ id: 'AL-4', tags: ['request-form'] }),
    consoleTicket({ id: 'AL-5', tags: ['alpha'] }),
  ];
  const key = renderFeatureKey(tickets);
  assert.match(key, /^<div class="feature-key" role="group" aria-label="Features"><span class="key-title">Features<\/span>/);
  const listed = [...key.matchAll(/data-feature="([^"]+)" aria-pressed="false"[^>]*><span class="swatch" aria-hidden="true"><\/span>[^<]+<span class="count">(\d+)<\/span>/g)].map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(listed, [['tracker', 2], ['alpha', 1], ['console', 1]]);
  assert.match(key, new RegExp(`class="feature-pick feature-${featureColourIndex('tracker')}" data-feature="tracker"`));
  assert.match(renderFeatureKey(tickets, 'tracker'), /data-feature="tracker" aria-pressed="true"/);
  assert.equal(renderFeatureKey([consoleTicket({ tags: ['request-form'] })]), '');
  assert.equal(renderFeatureKey(null), '');
  assert.match(renderFeatureKey([consoleTicket({ tags: ['<i>'] })]), /data-feature="&lt;i&gt;"[^>]*>.*&lt;i&gt;<span class="count">1/);
  // The Console draws the key above its stages.
  assert.match(renderConsole({ tickets, projects: [ALPHA] }, ['Queued'], CONSOLE_NOW), /^<div class="feature-key"[\s\S]*<\/div><div class="console">/);
});

test('a click on a feature in the key dims every other tile, a second click shows them all, and the minute redraw keeps the pick', () => {
  const app = readFileSync(WEB('app.mjs'), 'utf8');
  const draw = /async function drawConsole\(\) \{([\s\S]*?)\n\}/.exec(app)[1];
  assert.match(draw, /pickedFeature = pickedFeature === b\.dataset\.feature \? null : b\.dataset\.feature;/);
  assert.match(draw, /showFeaturePick\(\);\s*putTrail/, 'the pick is put back after every draw');
  const show = /function showFeaturePick\(\) \{([\s\S]*?)\n\}/.exec(app)[1];
  assert.match(show, /tile\.classList\.toggle\('dimmed', pickedFeature !== null && tile\.dataset\.feature !== pickedFeature\)/);
  assert.match(show, /b\.setAttribute\('aria-pressed', String\(b\.dataset\.feature === pickedFeature\)\)/);
  assert.match(show, /if \(!picks\.some\(\(b\) => b\.dataset\.feature === pickedFeature\)\) pickedFeature = null;/);
});
