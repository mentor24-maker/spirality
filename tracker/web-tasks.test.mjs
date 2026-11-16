/**
 * Tests for the Tasks page: the board, the list, Search and the Pipeline Status pod. One file per page (SP-352),
 * so two tickets changing two pages no longer edit one test file; what they
 * share is tracker/webTestKit.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { seedDemo, tickingClock } from './demoData.mjs';
import { searchTickets, PRIORITIES } from './pageData.mjs';
import { renderProjectPicker, renderTopicPicker, canDelete, renderEditPanel, stageLook, stageLooks, contrast, boldMatches, searchPattern, renderSearchResults, renderSearchFilters, renderTicketLookup, lookupTicket, activeFilters, redrawHold, renderPipelinePod, PIPELINE_UNAVAILABLE, renderPipelineDetails, pipelinePodLabel, PRIORITY_ORDER, SORT_COLUMNS, sortTickets, nextSort, renderSortHeadings, renderListPriority, renderListAssignee, renderListTags, renderListTopics, projectTags, PIPELINE_SOON_MS, lowerMeridiem } from './web/render.mjs';
import loopStatuses from '../lib/loopStatuses.js';
import mergeOnComment from '../lib/mergeOnComment.js';
import { pageScript } from './pageScripts.mjs';
import { WEB, drawnCss, fixture, boardTickets } from './webTestKit.mjs';

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
  const app = pageScript();
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
  const css = drawnCss();
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

test('every stage on the board and the list folds, Live starts folded and the rest open, and every card and row opens its ticket page (SP-196)', () => {
  const app = pageScript();
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
  const app = pageScript();
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
  const app = pageScript();
  const place = /function keepPlace\(\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(place, /const key = \(d\) => \(d\.dataset\.stage \? `stage\|\$\{d\.dataset\.stage\}` : d\.dataset\.project \? `project\|\$\{d\.dataset\.project\}` : d\.className\);/, 'a stage is known by its name, not its classes (and a Settings project box by its project, SP-289)');
  assert.match(place, /const open = new Map\(\[\.\.\.main\.querySelectorAll\('details'\)\]\.map\(\(d\) => \[key\(d\), d\.open\]\)\);/, 'every stage is a details, so every stage is kept');
  assert.match(place, /for \(const d of main\.querySelectorAll\('details'\)\) if \(open\.has\(key\(d\)\)\) d\.open = open\.get\(key\(d\)\);/);
});

test('the board has no Live column: Live is a list section below the columns, newest change first, with its count (SP-165)', () => {
  const app = pageScript();
  const draw = /async function drawProject\(([^)]*)\) \{([\s\S]*?)\n\}/.exec(app)[2];
  // SP-345: the columns as the class filters leave them; with none chosen, the board's own.
  assert.match(draw, /const columns = filterByClass\(board\.columns, pickedClass\);/);
  assert.match(draw, /const working = columns\.filter\(\(c\) => c\.status !== 'Live'\);/);
  assert.match(draw, /<div class="board">\$\{working\.map\(column\)\.join\(''\)\}<\/div>\$\{live \? `<div class="list board-live">\$\{group\(live\)\}<\/div>` : ''\}/);
  assert.doesNotMatch(draw, /board\.columns\.map\(column\)/, 'no column is drawn for Live');
  // Newest change first, without reordering the List view's Live.
  assert.match(draw, /liveColumn\.tickets\.slice\(\)\.sort\(\(a, b\) => \(a\.updatedAt < b\.updatedAt \? 1 : a\.updatedAt > b\.updatedAt \? -1 : 0\)\)/);
  assert.match(draw, /<div class="list">\$\{columns\.map\(group\)\.join\(''\)\}<\/div>/, 'the List view is unchanged');
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
  const app = pageScript();
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
  const app = pageScript();
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
  const app = pageScript();
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
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawProject('), app.indexOf('async function copyText'));
  assert.match(draw, /<td class="priority">\$\{view === 'list' \? renderListPriority\(t\) : t\.priority \? escapeHtml\(statusName\(t\.priority\)\)/);
  const card = /const card = \(t\) => `([\s\S]*?)`;/.exec(app)[1];
  assert.doesNotMatch(card, /select|renderListPriority/);
  assert.match(draw, /wireListPickers\(slug, view, board, said\);/);
});

test('picking a priority or assignee sends only that field with the board\'s version, holds every dropdown, and says Saved, moved or the server\'s words', () => {
  const app = pageScript();
  const wire = /function wireListPickers\(slug, view, board, said\) \{([\s\S]*?)\n\}/.exec(app)?.[1];
  assert.ok(wire, 'the dropdowns are wired');
  assert.match(app, /priority: \{ value: \(select\) => select\.value, before: \(t\) => t\.priority \?\? '' \}/, 'priority goes as picked');
  assert.match(app, /assignee: \{ value: \(select\) => \(select\.value \? Number\(select\.value\) : null\), before: \(t\) => String\(t\.assigneeId \?\? ''\) \}/, 'assignee goes as an id, or null for Nobody, as the Change panel sends it');
  assert.match(wire, /api\('PATCH', `\/tickets\/\$\{encodeURIComponent\(id\)\}`, \{ \[field\]: value, ifVersion: t\.version \}\)/);
  assert.match(wire, /save\(t\.id, field, picker\.value\(select\), \(\) => \{ select\.value = before; \}\);/, 'a dropdown sends its value and puts the old one back on a refusal');
  assert.match(wire, /const selects = \[\.\.\.main\.querySelectorAll\(fields\.map/, 'one save at a time across both kinds of dropdown');
  assert.match(wire, /const controls = \[\.\.\.selects, \.\.\.main\.querySelectorAll\('select\[data-tags-of\], button\[data-untag-of\], input\[data-new-tag-of\], select\[data-topics-of\], button\[data-untopic-of\]'\)\];/, 'the tag and topic controls are held with the dropdowns');
  assert.match(wire, /const held = controls\.filter/);
  assert.match(wire, /for \(const c of held\) c\.disabled = true;\s*note\.className = 'note quiet';\s*note\.textContent = 'Saving…';/);
  assert.match(wire, /after = \{ id, field, text: 'Saved' \};/);
  assert.match(wire, /err instanceof Refused && err\.status === 409\) \{\s*after = \{ id, field, text: MOVED_MESSAGE, error: true \};/, 'a 409 redraws as stored, with the moved message');
  assert.match(wire, /note\.textContent = `Not saved: \$\{err\.message\}`;\s*undo\(\);\s*for \(const c of held\) c\.disabled = false;/, 'any other refusal puts the old value back');
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

// ── Changing a ticket's assignee from the List view (SP-244) ───────────────

const optionsOf = (html) => [...html.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)].map((m) => [m[1], m[3], Boolean(m[2])]);

test('a List row\'s Assigned To is a dropdown with the Change panel\'s choices: the operator, the current assignee "(now)" when someone else, and Nobody', () => {
  const operator = { id: 1, name: 'Dane' };
  const nobody = renderListAssignee({ id: 'SP-12', assignee: null, assigneeId: null }, operator);
  assert.match(nobody, /^<select class="list-assignee" data-assignee-of="SP-12" aria-label="Assignee of SP-12">/);
  assert.deepEqual(optionsOf(nobody), [['1', 'Dane', false], ['', 'Nobody', true]]);
  assert.match(nobody, /<span class="note" data-assignee-note="SP-12" role="status"><\/span>$/, 'a note beside it for Saving…, Saved or a refusal');
  assert.deepEqual(optionsOf(renderListAssignee({ id: 'SP-12', assignee: 'Dane', assigneeId: 1 }, operator)), [['1', 'Dane', true], ['', 'Nobody', false]]);
  assert.deepEqual(optionsOf(renderListAssignee({ id: 'SP-12', assignee: 'Tess', assigneeId: 7 }, operator)), [['1', 'Dane', false], ['7', 'Tess (now)', true], ['', 'Nobody', false]]);
  assert.deepEqual(optionsOf(renderListAssignee({ id: 'SP-12', assignee: null, assigneeId: null }, null)), [['', 'Nobody', true]], 'a project with no operator offers only Nobody');
  assert.match(renderListAssignee({ id: '<b>', assignee: null, assigneeId: null }, operator), /data-assignee-of="&lt;b&gt;"/);
  // The same choices, in the same order, as the ticket page's Change panel.
  for (const [assignee, assigneeId] of [[null, null], ['Dane', 1], ['Tess', 7]]) {
    const panel = renderEditPanel({ name: 'x', status: 'queued', operator, assignee: assigneeId == null ? null : { id: assigneeId, name: assignee } });
    const who = /<select id="edit-assignee"[^>]*>([\s\S]*?)<\/select>/.exec(panel)[1];
    assert.deepEqual(optionsOf(renderListAssignee({ id: 'SP-1', assignee, assigneeId }, operator)), optionsOf(who), String(assignee));
  }
});

test('the List view draws the assignee dropdown in every row; the Board view\'s Live rows and cards stay as text', () => {
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawProject('), app.indexOf('async function copyText'));
  assert.match(draw, /<td class="assignee">\$\{view === 'list' \? renderListAssignee\(t, board\.operator\) : t\.assignee \? escapeHtml\(t\.assignee\)/);
  const card = /const card = \(t\) => `([\s\S]*?)`;/.exec(app)[1];
  assert.doesNotMatch(card, /select|renderListAssignee/);
});

test('an assignee picked through the page\'s save shows on the board and on the ticket; Nobody undoes it; an old version is refused and changes nothing', async () => {
  const f = await fixture();
  try {
    const board = () => f.call('GET', '/projects/alpha/board').then((r) => r.body);
    const first = await board();
    assert.ok(first.operator, 'the board names the operator');
    const t = first.columns.flatMap((c) => c.tickets).find((r) => r.assigneeId == null);
    assert.ok(t, 'the test data has an unassigned ticket');
    assert.equal(t.assignee, null);
    const saved = await f.call('PATCH', `/tickets/${t.id}`, { body: { assignee: first.operator.id, ifVersion: t.version } });
    assert.equal(saved.status, 200);
    const after = (await board()).columns.flatMap((c) => c.tickets).find((r) => r.id === t.id);
    assert.deepEqual([after.assigneeId, after.assignee], [first.operator.id, first.operator.name]);
    assert.equal((await f.call('GET', `/tickets/${t.id}/thread`)).body.assignee.id, first.operator.id, 'the ticket page reads the same assignee');
    const stale = await f.call('PATCH', `/tickets/${t.id}`, { body: { assignee: null, ifVersion: t.version } });
    assert.equal(stale.status, 409);
    assert.equal(f.store.getTicket(t.id).assignee, first.operator.id, 'nothing overwritten');
    const undone = await f.call('PATCH', `/tickets/${t.id}`, { body: { assignee: null, ifVersion: after.version } });
    assert.equal(undone.status, 200);
    assert.equal(f.store.getTicket(t.id).assignee, null);
  } finally { await f.cleanup(); }
});

// ── Changing a ticket's tags from the List view (SP-246) ───────────────────

test('the project\'s tags are every tag on its board once, alphabetical, skipping anything unreadable', () => {
  const board = { columns: [
    { status: 'Queued', tickets: [{ tags: ['tracker', 'Beta'] }, { tags: ['alpha', 'tracker'] }] },
    { status: 'Live', tickets: [{ tags: ['zeta', 7, ''] }, { tags: null }, {}] },
  ] };
  assert.deepEqual(projectTags(board), ['alpha', 'Beta', 'tracker', 'zeta']);
  for (const bad of [null, undefined, {}, { columns: 'x' }, { columns: [null] }]) assert.deepEqual(projectTags(bad), []);
});

test('a List row\'s tags are chips with a × each, then Add Tag offering the project\'s other tags and New Tag… last, a hidden box and a note', () => {
  const html = renderListTags({ id: 'SP-12', tags: ['tracker', 'b"ad'] }, ['alpha', 'b"ad', 'tracker', 'zeta']);
  const chips = [...html.matchAll(/<span class="tag">([^<]*)<button type="button" class="remove-tag" data-untag-of="SP-12" data-tag="([^"]*)"[^>]*aria-label="Remove tag [^"]* from SP-12">×<\/button><\/span>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(chips, [['tracker', 'tracker'], ['b&quot;ad', 'b&quot;ad']]);
  const select = /<select class="list-tags" data-tags-of="SP-12" aria-label="Add a tag to SP-12">([\s\S]*?)<\/select>/.exec(html)?.[1];
  assert.ok(select, 'an Add Tag dropdown');
  const options = [...select.matchAll(/<option value="([^"]*)"( selected)?( data-new-tag)?>([^<]*)<\/option>/g)].map((m) => [m[1], m[4], Boolean(m[2]), Boolean(m[3])]);
  assert.deepEqual(options, [['', 'Add Tag', true, false], ['alpha', 'alpha', false, false], ['zeta', 'zeta', false, false], ['', 'New Tag…', false, true]], 'never a tag the ticket has; New Tag… last');
  assert.match(html, /<input type="text" class="new-tag" data-new-tag-of="SP-12" aria-label="New tag for SP-12: type it and press Enter" placeholder="docs" hidden>/);
  assert.match(html, /<span class="note" data-tags-note="SP-12" role="status"><\/span>$/);
  const none = renderListTags({ id: 'SP-13', tags: [] }, []);
  assert.doesNotMatch(none, /class="tag"/);
  assert.match(none, /<option value="" selected>Add Tag<\/option><option value="" data-new-tag>New Tag…<\/option>/);
  assert.match(renderListTags({ id: '<b>', tags: ['x'] }, []), /data-tags-of="&lt;b&gt;"[\s\S]*data-tags-note="&lt;b&gt;"/);
});

test('the List view draws the tag controls in every row from the project\'s tags; the Board view\'s cards and Live rows stay as chips', () => {
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawProject('), app.indexOf('async function copyText'));
  assert.match(draw, /const known = projectTags\(board\);/);
  assert.match(draw, /<td class="tags">\$\{view === 'list' \? renderListTags\(t, known\) : t\.tags\.map/);
  const card = /const card = \(t\) => `([\s\S]*?)`;/.exec(app)[1];
  assert.doesNotMatch(card, /select|renderListTags|remove-tag/);
  assert.match(app, /wireListTags\(tickets, save, noteOf\);/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /\.group td\.tags input\.new-tag\[hidden\] \{ display: none; \}/, 'the box stays hidden until New Tag… opens it');
});

test('a tag picked, typed or removed sends the whole new list through the shared save; a blank entry or a tag already there sends nothing', () => {
  const app = pageScript();
  const wire = /function wireListTags\(tickets, save, noteOf\) \{([\s\S]*?)\n\}/.exec(app)?.[1];
  assert.ok(wire, 'the tag controls are wired');
  assert.match(wire, /save\(t\.id, 'tags', \[\.\.\.t\.tags, tag\], undo\);/, 'adding sends the old tags plus the new one');
  assert.match(wire, /if \(t\.tags\.includes\(tag\)\) \{[\s\S]*?is already a tag\.`;\s*undo\(\);\s*return;/, 'a tag already there is said, not sent');
  assert.match(wire, /if \(select\.selectedOptions\[0\]\?\.hasAttribute\('data-new-tag'\)\) \{\s*reset\(\);\s*const box = boxOf\(t\.id\);\s*box\.hidden = false;\s*box\.focus\(\);/, 'New Tag… opens the box');
  assert.match(wire, /const tag = box\.value\.trim\(\);\s*if \(!tag\) return close\(\);/, 'a blank entry adds nothing');
  assert.match(wire, /if \(e\.key === 'Escape'\) \{\s*e\.preventDefault\(\);\s*close\(\);/, 'Escape cancels');
  assert.match(wire, /save\(t\.id, 'tags', t\.tags\.filter\(\(tag\) => tag !== button\.dataset\.tag\), \(\) => \{\}\);/, '× sends the tags without that one');
});

test('tags changed through the page\'s save show on the board and on the ticket; removing one works the same; an old version is refused and changes nothing', async () => {
  const f = await fixture();
  try {
    const rows = () => f.call('GET', '/projects/alpha/board').then((r) => r.body.columns.flatMap((c) => c.tickets));
    const t = (await rows())[0];
    assert.ok(t, 'the test data has a ticket');
    const added = await f.call('PATCH', `/tickets/${t.id}`, { body: { tags: [...t.tags, 'urgent-fix'], ifVersion: t.version } });
    assert.equal(added.status, 200);
    const after = (await rows()).find((r) => r.id === t.id);
    assert.deepEqual(after.tags, [...t.tags, 'urgent-fix']);
    assert.deepEqual(f.store.getTicket(t.id).tags, [...t.tags, 'urgent-fix'], 'the ticket page reads the same tags');
    assert.ok(projectTags({ columns: [{ tickets: await rows() }] }).includes('urgent-fix'), 'and every row\'s Add Tag now offers it');
    const stale = await f.call('PATCH', `/tickets/${t.id}`, { body: { tags: [], ifVersion: t.version } });
    assert.equal(stale.status, 409);
    assert.deepEqual(f.store.getTicket(t.id).tags, [...t.tags, 'urgent-fix'], 'nothing overwritten');
    const removed = await f.call('PATCH', `/tickets/${t.id}`, { body: { tags: after.tags.filter((x) => x !== 'urgent-fix'), ifVersion: after.version } });
    assert.equal(removed.status, 200);
    assert.deepEqual(f.store.getTicket(t.id).tags, t.tags);
  } finally { await f.cleanup(); }
});

// ── Changing a ticket's topics from the List view (SP-247) ─────────────────

test('a List row\'s topics are chips with a × each (a quiet dash when none), then Add Topic offering the project\'s other topics, and a note', () => {
  const known = [{ id: 3, name: 'Billing' }, { id: 1, name: 'Lo"gin' }, { id: 2, name: 'Search' }];
  const html = renderListTopics({ id: 'SP-12', topics: [{ id: 1, name: 'Lo"gin' }] }, known);
  const chips = [...html.matchAll(/<span class="tag topic">([^<]*)<button type="button" class="remove-tag" data-untopic-of="SP-12" data-topic="(\d+)"[^>]*aria-label="Remove topic [^"]* from SP-12">×<\/button><\/span>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(chips, [['Lo&quot;gin', '1']]);
  assert.doesNotMatch(html, /class="quiet">–/, 'no dash beside a chip');
  const select = /<select class="list-topics" data-topics-of="SP-12" aria-label="Add a topic to SP-12">([\s\S]*?)<\/select>/.exec(html)?.[1];
  assert.ok(select, 'an Add Topic dropdown');
  const options = [...select.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)].map((m) => [m[1], m[3], Boolean(m[2])]);
  assert.deepEqual(options, [['', 'Add Topic', true], ['3', 'Billing', false], ['2', 'Search', false]], 'never a topic the ticket has');
  assert.match(html, /<span class="note" data-topics-note="SP-12" role="status"><\/span>$/);

  const none = renderListTopics({ id: 'SP-13', topics: [] }, known);
  assert.match(none, /^<span class="quiet">–<\/span><select/, 'a ticket with none shows a quiet dash and the dropdown');
  const empty = renderListTopics({ id: 'SP-14' }, []);
  assert.match(empty, /<option value="" selected>Add Topic<\/option><option value="" disabled>No topics yet: make one on the Topics page<\/option>/);
  assert.match(renderListTopics({ id: '<b>', topics: [] }, []), /data-topics-of="&lt;b&gt;"[\s\S]*data-topics-note="&lt;b&gt;"/);
});

test('the List view draws a Topics cell after Tags from the board\'s topics; picking or × sends the whole new id list through the shared save', () => {
  const app = pageScript();
  const row = /const row = \(status\) => \(t\) => `[\s\S]*?<\/tr>`;/.exec(app)[0];
  assert.match(row, /<td class="tags">[^\n]*<\/td>\s*<td class="topics">\$\{view === 'list' \? renderListTopics\(t, board\.topics\) :/);
  const card = /const card = \(t\) => `([\s\S]*?)`;/.exec(app)[1];
  assert.doesNotMatch(card, /topic/i, 'the Board view\'s cards show no topics');
  assert.match(app, /wireListTopics\(tickets, save\);/);
  assert.match(app, /select\[data-topics-of\], button\[data-untopic-of\]'\)\]/, 'held while a save is in flight');
  const wire = /function wireListTopics\(tickets, save\) \{([\s\S]*?)\n\}/.exec(app)?.[1];
  assert.ok(wire, 'the topic controls are wired');
  assert.match(wire, /save\(t\.id, 'topics', \[\.\.\.idsOf\(t\), topic\], \(\) => \{ select\.value = ''; \}\);/);
  assert.match(wire, /save\(t\.id, 'topics', idsOf\(t\)\.filter\(\(id\) => id !== topic\), \(\) => \{\}\);/);
});

test('sorting by Topics goes by each ticket\'s first topic, tickets with none last', () => {
  const tickets = [{ id: 'A', topics: [] }, { id: 'B', topics: [{ id: 1, name: 'zeta' }] }, { id: 'C', topics: [{ id: 2, name: 'Alpha' }] }];
  assert.deepEqual(sortTickets(tickets, { column: 'topics', direction: 'ascending' }).map((t) => t.id), ['C', 'B', 'A']);
});

test('topics added through the page\'s save show on the board after a reload; one topic sits on two tickets; × removes it; a moved ticket is refused', async () => {
  const f = await fixture();
  try {
    const login = f.store.addTopic({ project: 'alpha', name: 'Login', actor: f.operator.id });
    const rows = () => f.call('GET', '/projects/alpha/board').then((r) => r.body.columns.flatMap((c) => c.tickets));
    const [one, two] = await rows();
    assert.ok(one && two, 'the test data has two tickets');
    assert.deepEqual((await f.call('GET', '/projects/alpha/board')).body.topics, [{ id: login.id, name: 'Login' }]);
    assert.equal((await f.call('PATCH', `/tickets/${one.id}`, { body: { topics: [login.id], ifVersion: one.version } })).status, 200);
    assert.equal((await f.call('PATCH', `/tickets/${two.id}`, { body: { topics: [login.id], ifVersion: two.version } })).status, 200);
    let now = await rows();
    for (const id of [one.id, two.id]) assert.deepEqual(now.find((r) => r.id === id).topics, [{ id: login.id, name: 'Login' }], id);
    const stale = await f.call('PATCH', `/tickets/${one.id}`, { body: { topics: [], ifVersion: one.version } });
    assert.equal(stale.status, 409);
    const after = now.find((r) => r.id === one.id);
    assert.equal((await f.call('PATCH', `/tickets/${one.id}`, { body: { topics: [], ifVersion: after.version } })).status, 200);
    now = await rows();
    assert.deepEqual(now.find((r) => r.id === one.id).topics, []);
    assert.deepEqual(now.find((r) => r.id === two.id).topics, [{ id: login.id, name: 'Login' }]);
  } finally { await f.cleanup(); }
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
  const app = pageScript();
  assert.match(app, /canDelete\(status\) \? actionButton\('Delete Ticket', ICONS\.delete, \{ delete: t\.id \}\) : ''/);
  assert.match(app, /c\.tickets\.map\(row\(c\.status\)\)/);
  // No bin on the board's cards.
  const card = /const card = \(t\) => `([\s\S]*?)`;/.exec(app)[1];
  assert.doesNotMatch(card, /delete/i);
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
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawProject'), app.indexOf('async function copyText'));
  assert.match(draw, /api\('GET', '\/projects'\),\n  \]\);/);
  assert.match(draw, /<div class="toolbar">\s*\$\{renderProjectPicker\(projects, board\.project\)\}\s*\$\{renderTopicPicker\(board\.topics \?\? \[\]\)\}\s*\$\{searchForm\(''\)\}\s*<button type="button" class="pipeline-pod"[^>]*><\/button>\s*<\/div>\s*\$\{viewSwitch\(board\.project, view\)\}\s*<\/div>/, 'the tabs close the title row, after the toolbar (SP-326)');
  assert.doesNotMatch(app, /Change project/);
  assert.match(draw, /querySelector\('\.project-picker select'\)\.addEventListener\('change', \(e\) => \{\s*history\.pushState\(null, '', at\(view, e\.target\.value\)\);\s*route\(\);/);
  assert.match(readFileSync(WEB('app.css'), 'utf8'), /\.toolbar \.project-picker(, \.toolbar \.topic-picker)? \{[^}]*display: flex;/);
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
  const app = pageScript();
  assert.match(app, /\$\{renderProjectPicker\(projects, board\.project\)\}\s*\$\{renderTopicPicker\(board\.topics \?\? \[\]\)\}\s*\$\{searchForm\(''\)\}/);
  assert.match(app, /history\.pushState\(null, '', searchAddress\(form\.elements\.q\.value\.trim\(\)\)\)/);
  assert.match(app, /renderSearchResults\(answer\)/);
});

/** The filters as the server answers them, Status set to Queued and Assigned to to Nobody. */
const FILTERS = [
  { key: 'status', label: 'Status', value: 'Queued', options: [{ value: 'Rework', label: 'Rework' }, { value: 'Queued', label: 'Queued' }] },
  { key: 'priority', label: 'Priority', value: null, options: [{ value: 'urgent', label: 'Urgent' }, { value: 'none', label: 'None' }] },
  { key: 'createdBy', label: 'Created By', value: null, options: [{ value: '3', label: 'Tom & <Jerry>' }] },
  { key: 'assignee', label: 'Assigned To', value: 'nobody', options: [{ value: 'nobody', label: 'Nobody' }, { value: '3', label: 'Tom & <Jerry>' }] },
];

test('the search filters are one picker each, "Any" first, the server\'s choices in its order, the chosen one selected', () => {
  const html = renderSearchFilters(FILTERS);
  assert.match(html, /^<div class="search-filters">/);
  assert.equal((html.match(/<select /g) ?? []).length, 4);
  assert.match(html, /<label>Status\s*<select name="status"><option value="">Any<\/option><option value="Rework">Rework<\/option><option value="Queued" selected>Queued<\/option><\/select>/);
  assert.match(html, /<select name="priority"><option value="" selected>Any<\/option><option value="urgent">Urgent<\/option><option value="none">None<\/option>/);
  assert.match(html, /<select name="createdBy"><option value="" selected>Any<\/option><option value="3">Tom &amp; &lt;Jerry&gt;<\/option>/);
  assert.match(html, /<select name="assignee"><option value="">Any<\/option><option value="nobody" selected>Nobody<\/option>/);
  assert.deepEqual(activeFilters(FILTERS), ['Status: Queued', 'Assigned To: Nobody']);
  assert.match(renderSearchResults({ query: 'widget', filters: FILTERS, results: [] }),
    /<p class="quiet search-note">No tickets match widget with Status: Queued, Assigned To: Nobody<\/p>/);
  assert.match(renderSearchResults({ query: 'widget', filters: FILTERS.map((f) => ({ ...f, value: null })), results: [] }),
    /<p class="quiet search-note">No tickets match widget<\/p>/);
});

test('the Ticket number field sits beside the Project filter and offers each ticket as "SP-12 · <title>", escaped', () => {
  const project = { key: 'project', label: 'Project', value: null, options: [{ value: 'spirality', label: 'Spirality' }] };
  const html = renderSearchFilters([project, ...FILTERS], { tickets: [{ id: 'SP-12', name: 'Fix <b>it</b> & more' }, { id: 'SP-13', name: 'Next' }] });
  assert.ok(html.indexOf('name="project"') < html.indexOf('Ticket Number') && html.indexOf('Ticket Number') < html.indexOf('name="status"'), 'right after Project');
  assert.match(html, /<form class="ticket-lookup">\s*<label>Ticket Number\s*<input type="text" name="ticket" list="ticket-numbers"/);
  assert.match(html, /<option value="SP-12">SP-12 · Fix &lt;b&gt;it&lt;\/b&gt; &amp; more<\/option><option value="SP-13">SP-13 · Next<\/option>/);
  assert.ok(!renderSearchFilters([project, ...FILTERS]).includes('Ticket Number'), 'only where the page asks for it');
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
  const app = pageScript();
  assert.match(app, /renderSearchFilters\(answer\.filters, \{ tickets: answer\.tickets \?\? \[\] \}\)/);
  assert.match(app, /wireTicketLookup\(/);
  assert.match(app, /main\.querySelector\('\.search-answer'\)\.innerHTML = `<p class="quiet search-note">\$\{escapeHtml\(found\.note\)\}<\/p>`/);
});

test('the search results page draws the filters from the server\'s answer, keeps them in the address, and shows a refusal', () => {
  const app = pageScript();
  const draw = app.slice(app.indexOf('function searchAddress('), app.indexOf('/**\n * Put `text` on the clipboard'));
  assert.match(draw, /renderSearchFilters\(answer\.filters, /);
  assert.match(draw, /api\('GET', `\/search\?\$\{params\}`\)/);
  assert.match(draw, /for \(const select of main\.querySelectorAll\('\.search-filters select'\)\) \{\s*select\.addEventListener\('change', \(\) => \{/);
  assert.match(draw, /<p class="error">\$\{escapeHtml\(refusal\)\}<\/p>/);
  // No status, priority or person is typed out: every choice comes from the server.
  for (const word of [...loopStatuses.STAGE_ORDER, 'urgent', 'Urgent', 'Nobody', 'nobody']) {
    assert.ok(!draw.includes(`'${word}'`), word);
  }
  assert.match(app, /await drawSearch\(new URLSearchParams\(location\.search\)\)/);
});

test('the Tasks toolbar\'s Topic picker offers "Any" then the project\'s topics, and the Search page\'s Topic filter waits for a project', () => {
  assert.equal(renderTopicPicker([{ id: 4, name: 'Board' }, { id: 2, name: 'R&D <b>' }]),
    '<label class="topic-picker">Topic: <select name="topic"><option value="" selected>Any</option>'
    + '<option value="4">Board</option><option value="2">R&amp;D &lt;b&gt;</option></select></label>');
  assert.equal(renderTopicPicker([]), '<label class="topic-picker">Topic: <select name="topic"><option value="" selected>Any</option></select></label>', 'a project with no topics: "Any" only');
  const app = pageScript();
  assert.match(readFileSync(WEB('app.css'), 'utf8'), /\.toolbar \.project-picker, \.toolbar \.topic-picker \{[^}]*display: flex;/);
  // Changing Project on the Search page drops the topic before searching again.
  const wire = app.slice(app.indexOf('function wireSearch('), app.indexOf('function wireTicketLookup('));
  assert.match(wire, /if \(select\.name === 'project' && topic\) topic\.value = '';\s*go\(\);/);

  const topic = { key: 'topic', label: 'Topic', value: null, options: [{ value: '4', label: 'Board' }] };
  const project = { key: 'project', label: 'Project', value: null, options: [{ value: 'alpha', label: 'Alpha' }] };
  const idle = renderSearchFilters([project, topic]);
  assert.match(idle, /<label>Topic\s*<select name="topic" disabled title="Pick a project first"><option value="" selected>Any<\/option><\/select><span class="quiet hint">Pick a project first<\/span>/);
  const chosen = renderSearchFilters([{ ...project, value: 'alpha' }, { ...topic, value: '4' }]);
  assert.match(chosen, /<label>Topic\s*<select name="topic"><option value="">Any<\/option><option value="4" selected>Board<\/option><\/select>\s*<\/label>/);
  assert.ok(chosen.indexOf('name="project"') < chosen.indexOf('name="topic"'));
  assert.deepEqual(activeFilters([{ ...project, value: 'alpha' }, { ...topic, value: '4' }]), ['Project: Alpha', 'Topic: Board']);
});

test('searching from the Tasks page carries the project chosen in its picker into the address as the Project filter (SP-191)', () => {
  const app = pageScript();
  const address = app.slice(app.indexOf('function searchAddress('), app.indexOf('/** Enter in the Search field'));
  assert.match(address, /main\.querySelectorAll\('\.project-picker select, \.topic-picker select, \.search-filters select'\)/);
  assert.match(address, /params\.set\(select\.name, select\.value\)/);
  // The picker's field is named what the server's Project filter reads, and the results page's row draws it.
  assert.match(renderProjectPicker([{ slug: 'alpha', name: 'Alpha' }, { slug: 'beta', name: 'Beta' }], 'beta'),
    /<select name="project"><option value="alpha">Alpha<\/option><option value="beta" selected>Beta<\/option><\/select>/);
  assert.match(renderSearchFilters([{ key: 'project', label: 'Project', value: 'beta', options: [{ value: 'alpha', label: 'Alpha' }, { value: 'beta', label: 'Beta' }] }]),
    /<label>Project\s*<select name="project"><option value="">Any<\/option><option value="alpha">Alpha<\/option><option value="beta" selected>Beta<\/option><\/select>/);
  assert.deepEqual(activeFilters([{ key: 'project', label: 'Project', value: 'beta', options: [{ value: 'beta', label: 'Beta' }] }]), ['Project: Beta']);
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

test('the pod reads as a small table (SP-194, SP-326): a "Pipeline Stages" heading, one column per stage with its name above its time, bold names, a running stage green, on light blue', () => {
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
  // Two cells per stage, name then time, in Relay, Build, Review, Intake order; the grid turns them into columns.
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
  const css = drawnCss();
  const rule = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.notEqual(at, -1, `app.css has a ${selector} rule`);
    return css.slice(at, css.indexOf('}', at));
  };
  const pod = rule('.toolbar .pipeline-pod');
  assert.match(pod, /background: #cceeff;/, 'Dane\'s light blue (SP-222)');
  assert.match(pod, /flex-direction: column;/, 'the heading sits above the stages');
  const stages = rule('.toolbar .pipeline-pod .stages');
  assert.match(stages, /display: grid; grid-template-rows: auto auto; grid-auto-flow: column;/, 'one column per stage, name above time (SP-326)');
  assert.doesNotMatch(stages, /grid-template-columns/, 'no fixed column count: however many stages there are');
  assert.match(pod, /flex-grow: 1;/, 'the pod widens into the free space of the title row (SP-326)');
  assert.match(css, /\.tasks-head > \.toolbar \{ flex-grow: 1;/, 'the toolbar grows with it, so the tabs still end at the right edge');
  assert.match(rule('.toolbar .pipeline-pod .stage'), /font-weight: 700;/, 'stage names are bold');
  const green = rule('.toolbar .pipeline-pod .running').match(/color: (#[0-9a-fA-F]{6});/);
  assert.ok(green, 'a running stage has its own colour');
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(green[1].slice(i, i + 2), 16));
  assert.ok(g > r * 2 && g > b * 2, `${green[1]} is a green`);
  // SP-222: Dane chose #00AA00. It is fainter on #cceeff than the 4.5:1
  // small-text bar, so the test checks his colour, not its contrast.
  assert.equal(green[1], '#00AA00', 'the brighter green Dane chose (SP-222)');
  // The button is unchanged: same class, still opens the dialog.
  const app = pageScript();
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
  const css = drawnCss();
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
  assert.match(rule('.toolbar .pipeline-pod .heading'), /font-size: 1\.25rem;/, 'the heading larger (--text-xl, SP-320)');
  assert.match(rule('.toolbar .pipeline-pod .soon'), /color: #B8860B;/, 'gold that reads on light blue');
  // The Files Made box keeps its light blue (non-goal).
  assert.match(rule('.files-made'), /background: #eaf5fe;/);
  // Lowercase am/pm, for the pod's times only.
  assert.equal(lowerMeridiem('10:45 AM'), '10:45 am');
  assert.equal(lowerMeridiem('2:05\u202fPM'), '2:05\u202fpm');
  assert.equal(lowerMeridiem('14:05'), '14:05');
  const app = pageScript();
  assert.match(app, /const clockTime = \(iso\) => lowerMeridiem\(/);
  assert.match(app, /renderPipelinePod\(pipelineState, clockTime, Date\.now\(\)\)/);
  // The dialog keeps its own times.
  assert.match(app, /renderPipelineDetails\(pipelineState, when\)/);
});

test('the Tasks page puts the pod between the search field and Board/List, fills it on draw and once a minute, and a failed read touches only the pod (SP-168)', () => {
  const app = pageScript();
  const tasks = app.indexOf('<h1>Tasks</h1>', app.indexOf('async function drawProject('));
  const head = app.slice(tasks, app.indexOf('<details class="add-task">', tasks));
  const search = head.indexOf("${searchForm('')}");
  const pod = head.indexOf('class="pipeline-pod"');
  const views = head.indexOf('${viewSwitch(board.project, view)}');
  // SP-322: Board/List left the toolbar for a tab bar; SP-326 put it at the right end of the title row the pod sits in.
  assert.ok(search !== -1 && search < pod && pod < views, 'search field, then the pod, then the Board/List tabs');
  assert.match(head, /<\/div>\s*\$\{viewSwitch\(board\.project, view\)\}\s*<\/div>/, 'the tabs are the title row\'s last item, after the toolbar (SP-326)');
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
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawProject('), app.indexOf('async function drawProject(') + 14000);
  assert.match(draw, /<button type="button" class="pipeline-pod" aria-haspopup="dialog"/);
  // A <dialog> with a form of method="dialog": Escape and both close buttons shut it natively.
  assert.match(draw, /<dialog class="pipeline-status" aria-labelledby="pipeline-status-title">\s*<form method="dialog">/);
  assert.match(draw, /<h2 id="pipeline-status-title">Pipeline Status<\/h2>/);
  assert.match(draw, /<button type="submit" class="btn">Close<\/button>/);
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
  const app = pageScript();
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
  const app = pageScript();
  const show = app.slice(app.indexOf('function showPipeline'), app.indexOf('function showPipeline') + 600);
  assert.match(show, /pod\.setAttribute\('aria-label', pipelinePodLabel\(pipelineState, clockTime\)\);/);
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
    assert.deepEqual(SORT_COLUMNS.map((c) => c.label), ['Ticket #', 'Ticket', 'Priority', 'Tags', 'Topics', 'Assigned To', 'Last Change']);
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
    const app = pageScript();
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

  test('the List view\'s tables use the sortable headings, in a table wrap with every table\'s heading look', () => {
    const app = pageScript();
    assert.match(app, /<div class="table-wrap"><table class="sortable"><thead>\$\{renderSortHeadings\(null\)\}<\/thead>/);
    assert.match(app, /<tr data-id="\$\{escapeHtml\(t\.id\)\}">/);
    // SP-193: the id is the first cell, a link to the ticket, and the name cell no longer repeats it.
    const row = /const row = \(status\) => \(t\) => `[\s\S]*?<\/tr>`;/.exec(app)[0];
    assert.match(row, /<tr data-id="[^\n]*">\s*<td class="id"><a href="\/t\/\$\{encodeURIComponent\(t\.id\)\}">\$\{escapeHtml\(t\.id\)\}<\/a><\/td>\s*<td class="name">/);
    const nameCell = /<td class="name">.*<\/td>/.exec(row)[0];
    assert.doesNotMatch(nameCell, /escapeHtml\(t\.id\)/, 'the name cell shows only the name');
    assert.doesNotMatch(nameCell, /ANSWER_IN_NOTE|answer-in/, 'the answer-in words are gone from the name cell (SP-201)');
    assert.equal((row.match(/<td class="/g) || []).length, SORT_COLUMNS.length + 1, 'one cell per heading, plus Actions');
    const css = readFileSync(WEB('app.css'), 'utf8');
    // SP-324: the black heading row is every table's now (UI_DOCTRINE 8), so the List view sets no heading colour of its own.
    assert.doesNotMatch(css, /\.group table\.sortable th \{/);
    // SP-193: Ticket # is narrow; the name keeps most of the width, and the set widths leave Last Change room.
    const width = (key) => Number(new RegExp(`\\.group th\\.${key} \\{ width: (\\d+)%; \\}`).exec(css)?.[1]);
    assert.ok(width('id') > 0 && width('id') < width('name'), 'Ticket # narrower than Ticket');
    const set = ['id', 'name', 'priority', 'tags', 'topics', 'assignee', 'actions'].reduce((sum, k) => sum + width(k), 0);
    assert.ok(set <= 76, `the set widths (${set}%) leave Last Change room for its date`);
  });
}

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

test('the List view\'s Add Tag dropdown also offers the project\'s saved tags, the board\'s `tags` (SP-309)', () => {
  const board = { tags: ['design', 'tracker', 7, ''], columns: [{ tickets: [{ tags: ['tracker', 'Beta'] }] }] };
  assert.deepEqual(projectTags(board), ['Beta', 'design', 'tracker']);
  assert.match(renderListTags({ id: 'SP-1', tags: [] }, projectTags(board)), /<option value="design">design<\/option>/);
});
