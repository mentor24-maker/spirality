/**
 * Tests for the ticket page (/t/<id>). One file per page (SP-352),
 * so two tickets changing two pages no longer edit one test file; what they
 * share is tracker/webTestKit.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.mjs';
import { seedDemo } from './demoData.mjs';
import { escapeHtml, renderStatusLine, renderComment, renderInline, renderMarkdown, renderQuickAction, CLOSE_LINE, REPLY_LINE, offersMerge, offersClose, bugReport, BUG_REPORT_TAG, renderCommands, renderFilesMade, filesMade, cardCommands, isCommand, askParagraphs, cardAsk, renderMergeAction, renderAnswerIn, renderHeldUp, heldUpLine, renderReplyForm, statusLabel, ANSWER_IN_NOTE, MERGE_STANDS_NOTE, mergeQuestion, renderCloseAction, closeQuestion, renderGoAction, goQuestion, heldBugReport, renderBugReportActions, approveQuestion, rejectQuestion, changeProblem, REJECT_COMMENT, WONT_DO_TAG, HELD_REPORT_LINE, HELD_REPORT_STATUS_LINE, cardMove, cardContext, firstParagraph, originalRequest, canDelete, deleteQuestion, deleteRefusal, renderDeleteAction, renderEditPanel, uploadEach, loopHasIt, renderCommentForm, LOOP_HAS_STATUSES, MOVED_MESSAGE, contrast } from './web/render.mjs';
import { loadProjectConfig } from '../lib/projectConfig.mjs';
import operatorCard from '../lib/operatorCard.js';
import machineComment from '../lib/machineComment.js';
import loopStatuses from '../lib/loopStatuses.js';
import mergeOnComment from '../lib/mergeOnComment.js';
import busRelayPlan from '../lib/busRelayPlan.js';
import { RENDER_SCRIPTS, pageScript, renderScript } from './pageScripts.mjs';
import { WEB, drawnCss, fixture, boardTickets, codes } from './webTestKit.mjs';

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

test('a loop\'s comment with no machine stamp does not count as his answer (SP-26)', async () => {
  const f = await fixture();
  try {
    const tickets = await boardTickets(f, 'beta');
    const unstamped = [...tickets.values()].find((t) => t.name === 'A question a loop asked, with no machine stamp');
    assert.equal(unstamped.answerIn, false);
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
    // The rule is the waiting module's own, not a second copy of it
    // (answeredLast since SP-302: a teammate's answer counts in Needs your input).
    const source = readFileSync(fileURLToPath(new URL('./pageData.mjs', import.meta.url)), 'utf8');
    assert.match(source, /answeredLast\(/);
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
  const app = pageScript();
  assert.match(app, /\$\{renderAnswerIn\(t\)\}/, 'the ticket page draws the line');
  assert.match(app, /statusLabel\(t\)/, 'the ticket page writes the status with the note');
  assert.equal(app.match(/t\.answerIn \? /g)?.length, 1, 'the board card draws the note; the list row draws a check instead (SP-201)');
});

test('with his answer in, the ticket page draws no reply box and copes with it missing, and the notice is boxed (SP-160)', () => {
  const app = pageScript();
  const draw = /\nasync function drawTicket\(id(?:, said = null(?:, kept = null)?)?\) \{[\s\S]*?\n\}\n/.exec(app)?.[0] ?? '';
  assert.ok(draw, 'drawTicket found');
  assert.doesNotMatch(draw, /<form class="reply">/, 'the box comes only from renderReplyForm');
  // Every reach for the box survives its absence: the kept text, the #reply jump, the submit wiring.
  assert.doesNotMatch(draw, /querySelector\('form\.reply textarea'\)\.value =/);
  assert.match(draw, /const form = main\.querySelector\('form\.reply'\);\s*if \(!form\) return;\s*const box = form\.querySelector\('textarea'\);/);
  assert.match(draw, /if \(!form\) return;[\s\S]*location\.hash === '#reply'[\s\S]*form\.addEventListener\('submit'/);
  assert.match(app, /reply: main\.querySelector\('form\.reply textarea, form\.add-comment textarea'\)\?\.value \?\? ''/);
  // The ticket page's notice: tinted, a blue bar on the left, ink, upright. The board and list note unchanged.
  const css = readFileSync(WEB('app.css'), 'utf8');
  const notice = /\np\.answer-in \{([^}]*)\}/.exec(css)?.[1] ?? '';
  for (const rule of [/font-style: normal/, /color: var\(--ink-primary\)/, /background: var\(--brand-blue-tint\)/, /border-left: \d+px solid var\(--brand-blue\)/, /padding: /]) assert.match(notice, rule);
  assert.match(css, /\n\.answer-in \{ font-size: var\(--text-sm\); font-style: italic; color: var\(--ink-secondary\); \}/);
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

  const app = pageScript();
  const draw = /\nasync function drawTicket\(id[^)]*\) \{[\s\S]*?\n\}\n/.exec(app)?.[0] ?? '';
  const line = draw.indexOf('${renderHeldUp(t, sinceTime)}');
  assert.ok(line > 0, 'the ticket page draws the line, with the header health line\'s times');
  assert.ok(line < draw.indexOf('${renderQuickAction(t)}'), 'above the card, so it is read first');
  const css = drawnCss();
  const rule = /\n\.quick \.held-up \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(rule, /grid-column: 1 \/ -1/, 'across the whole top, not in one column');
  const ink = /(?:^|;)\s*color: (#[0-9a-f]{6})/.exec(rule)?.[1];
  const paper = /background: (#[0-9a-f]{6})/.exec(rule)?.[1];
  assert.ok(contrast(ink, paper) >= 4.5, `readable: ${ink} on ${paper}`);
});

// ── A ticket's thread ────────────────────────────────────────────────────────

test('a ticket\'s thread is oldest first, names each author, and marks machine comments by their author', async () => {
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
    // A loop's comment with no stamp is marked by its author (SP-26).
    const unstamped = (await f.call('GET', '/tickets/BE-3/thread')).body.comments[0];
    assert.equal(unstamped.author.name, 'Loop (build)');
    assert.equal(unstamped.machine, true);
    assert.equal(unstamped.body, 'Which name should the tab show?');
    // And his own comment ending in a pasted [machine] line is his: the stamp
    // decides nothing, and is only taken off for display.
    assert.equal((await f.call('POST', '/tickets/BE-3/comments', { body: { body: 'Call it Board.\n\n[machine] posted by a loop under Dane\'s token — not his word' } })).status, 201);
    const his = (await f.call('GET', '/tickets/BE-3/thread')).body;
    assert.deepEqual([his.comments.at(-1).author.name, his.comments.at(-1).machine], ['Dane', false]);
    assert.equal(his.answerIn, true, 'his comment is his answer, pasted stamp and all');
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
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawTicket'), app.indexOf('/** The draft kept'));
  assert.match(draw, /const others = projects\.filter\(\(p\) => p\.slug !== t\.project\);/);
  assert.match(draw, /api\('POST', `\/tickets\/\$\{encodeURIComponent\(t\.id\)\}\/clone`, \{ project: copyForm\.querySelector\('#copy-to'\)\.value \}\)/);
  assert.match(draw, /history\.pushState\(null, '', `\/t\/\$\{encodeURIComponent\(copy\.id\)\}`\)/);
  assert.match(draw, /copyNote\.textContent = `Not copied: \$\{err\.message\}`;/);
  assert.match(draw, /There is no other project to copy into yet\./);
  assert.match(draw, /escapeHtml\(p\.name\)/, 'project names are escaped');
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

test('the ticket page opens on the Quick Action section: in his two statuses one pod on the left to act from, the ticket open on the right (SP-416)', () => {
  const app = pageScript();
  const page = /const actions = `([\s\S]*?)`;\n  main\.innerHTML = `\s*<section class="quick\$\{inline \? ' loop-has' : ' his-move'\}">([\s\S]*?)<\/section>\s*\$\{inline \? renderFilesMade\(t\) : ''\}`;/.exec(app);
  assert.ok(page, 'Quick Action is the whole page: no Details fold after it');
  const [, actions, quick] = page;
  // His move, in order: the answer-is-in line, Merge, Close, Go, a held bug report's Approve and Reject, the reply box.
  assert.match(actions, /^\s*\$\{renderAnswerIn\(t\)\}\s*\$\{renderMergeAction\(t\)\}\s*\$\{renderCloseAction\(t\)\}\s*\$\{renderGoAction\(t\)\}\s*\$\{renderBugReportActions\(t\)\}\s*\$\{renderReplyForm\(t, me\?\.name\)\}\s*$/);
  // Left: the pod, his title, words and brief (renderQuickAction), then the actions; right: commands, files made, the ticket open, Delete.
  assert.match(quick, /<div class="ask\$\{inline \? '' : ' action-pod'\}">\$\{renderQuickAction\(t\)\}\$\{inline \? '' : actions\}<\/div>/);
  assert.match(quick, /<div class="act">\s*\$\{renderCommands\(t\)\}\s*\$\{inline \? actions : renderFilesMade\(t\)\}\s*<div class="details">\$\{ticketBody\}<\/div>\s*\$\{renderDeleteAction\(t\)\}\s*<\/div>\s*$/);
  // The status line, the description and the comments are all in the open block.
  const details = /const ticketBody = `([\s\S]*?)`;\n  const actions/.exec(app)?.[1] ?? '';
  for (const part of [/statusLabel\(t\)/, /renderMarkdown\(t\.description\)/, /\$\{comments \|\|/]) assert.match(details, part);
  assert.doesNotMatch(app, /<details class="details"|<summary>Details<\/summary>/, 'no Details fold to open');
  assert.match(renderReplyForm({}, 'Dane'), /<form class="reply">[\s\S]*<label for="reply">Reply as Dane<\/label>[\s\S]*<textarea id="reply" required>/);
  // The reply posts exactly as typed, and #reply still lands in the box.
  assert.match(app, /\/comments`, \{ body: box\.value \}\)/);
  assert.match(app, /location\.hash === '#reply'[\s\S]{0,120}box\.focus\(\)/);
  // The pod: his numbers, a class (the page's policy drops inline styles), and the columns stack, pod first, under 800px.
  const css = readFileSync(WEB('app.css'), 'utf8');
  const pod = /^\.quick \.action-pod \{([^}]*)\}/m.exec(css)?.[1] ?? '';
  assert.match(pod, /padding: 40px;/);
  assert.match(pod, /border: 1px solid var\(--navy\);/);
  assert.match(pod, /border-radius: var\(--radius-container\);/);
  assert.match(pod, /background: var\(--pod-bg\);/);
  assert.match(css, /--navy: #000077;/);
  assert.match(css, /--radius-container: 20px;/);
  assert.match(css, /--pod-bg: #cceeff;/, 'light blue');
  assert.match(css, /^\.quick\.his-move \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\); \}/m);
  assert.match(css, /@media \(max-width: 800px\) \{ \.quick\.his-move \{ grid-template-columns: minmax\(0, 1fr\); \} \}/);
  assert.doesNotMatch(app, /style="/);
});

test('every action in the pod that does his move is the green action colour; Reject and Delete are not (SP-416)', () => {
  const green = /<button type="submit" class="btn btn-save">/;
  assert.match(renderReplyForm({ status: 'needs your input' }, 'Dane'), /<button type="submit" class="btn btn-save">Post Reply<\/button>/);
  const ready = { status: 'ready to launch', mergePhrase: 'ship it', pullRequest: 'https://github.com/x/y/pull/3', comments: [] };
  assert.match(renderMergeAction(ready), /class="btn btn-save">Merge</);
  assert.match(renderCloseAction({ status: 'needs your input', closePhrase: 'close', comments: [{ body: moveCard('Close') }] }), green);
  assert.match(renderGoAction({ status: 'needs your input', goPhrase: 'go', comments: [{ body: intakeCard() }] }), green);
  const held = { name: 'x', tags: ['bug-report'], status: 'needs your input', comments: [], description: bugDescription() };
  assert.match(renderBugReportActions(held), /class="btn btn-save">Approve</);
  assert.match(renderBugReportActions(held), /class="btn btn-danger">Reject</);
  assert.match(renderDeleteAction({ status: 'queued' }), /class="btn btn-danger">Delete</);
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
  assert.match(css, /\.quick \.needed \{ color: var\(--ink-error\); font-weight: 700;/, 'the same red as the banner, bold');
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

// ── Quick Action: a website visitor's bug report (SP-286) ───────────────────

/** A description shaped like StarCaster's composeBugReportTask (SC-804). */
const bugDescription = ({ words = 'The module needs a site-wide option.\nAs it is, one page at a time.', shots = '(none attached)' } = {}) => [
  '## What the reporter said', '', '```', words, '```', '',
  '## Where and who', '',
  '- **Page:** https://example.com/pricing',
  '- **Project:** Demo Site (proj_1)',
  '- **Viewer tier:** public',
  '- **Browser:** `Mozilla/5.0 (Macintosh)`',
  '- **Submitted:** 2026-11-13T21:04:00.000Z',
  '- **Report id:** `br_1`', '',
  '## Screenshots', '', shots, '',
  '---',
  '_Filed automatically from a public bug report. Held for the operator: nothing in the build loops will touch this until you move it._',
].join('\n');

test('bugReport reads the visitor\'s words, the where-and-who facts and whether screenshots came', () => {
  assert.equal(BUG_REPORT_TAG, 'bug-report');
  const r = bugReport({ tags: ['bug-report', 'demo'], description: bugDescription() });
  assert.equal(r.words, 'The module needs a site-wide option.\nAs it is, one page at a time.');
  assert.deepEqual(r.facts, [
    { label: 'Page', value: 'https://example.com/pricing' },
    { label: 'Project', value: 'Demo Site (proj_1)' },
    { label: 'Viewer tier', value: 'public' },
    { label: 'Browser', value: 'Mozilla/5.0 (Macintosh)' },
    { label: 'Submitted', value: '2026-11-13T21:04:00.000Z' },
    { label: 'Report id', value: 'br_1' },
  ]);
  assert.equal(r.screenshots, false, '"(none attached)" is no screenshot');
  assert.equal(bugReport({ tags: ['bug-report'], description: bugDescription({ shots: '- [Screenshot 1](https://x.test/1.png)' }) }).screenshots, true);
  // A "## Where and who" the visitor typed inside the fence is their words, not a section.
  assert.equal(bugReport({ tags: ['bug-report'], description: bugDescription({ words: 'see\n## Where and who\n- **Page:** fake' }) }).words, 'see\n## Where and who\n- **Page:** fake');
  // Not a bug report: no tag, no section, an unclosed fence, or rewritten by intake (## Asked).
  assert.equal(bugReport({ tags: [], description: bugDescription() }), null);
  assert.equal(bugReport({ tags: ['bug-report'], description: '## Goal\nx' }), null);
  assert.equal(bugReport({ tags: ['bug-report'], description: '## What the reporter said\n```\nnever closed' }), null);
  assert.equal(bugReport({ tags: ['bug-report'], description: `## Asked\n\`\`\`\nhis words\n\`\`\`\n\n${bugDescription()}` }), null);
  assert.equal(bugReport({ tags: null, description: null }), null);
});

test('Quick Action on a bug report: "Bug Report:", the visitor\'s words in bold, then where and who in Mountain time', () => {
  const html = renderQuickAction({
    name: 'Bug report: The module needs a site-wide option. As it is, o… — Demo Site',
    tags: ['bug-report'], status: 'needs your input', comments: [],
    description: bugDescription({ words: 'I typed <script>alert(1)</script> and **stars**\nline two' }),
  });
  assert.match(html, /^<h1>Bug Report:<\/h1>\n<p class="status-line">Status: [^\n]*<\/p>\n<p class="bug-words">I typed &lt;script&gt;alert\(1\)&lt;\/script&gt; and \*\*stars\*\*\nline two<\/p>/, 'escaped, never markup, line breaks kept');
  assert.doesNotMatch(html, /<script|<strong>stars/);
  assert.doesNotMatch(html, /Bug report: The module|none attached|Filed automatically/, 'not the cut-off name, nor "(none attached)" at the top');
  assert.match(html, /<ul class="bug-facts"><li><span class="fact-label">Page:<\/span> <a href="https:\/\/example\.com\/pricing"[^>]*>https:\/\/example\.com\/pricing<\/a><\/li>/);
  assert.match(html, /<li><span class="fact-label">Project:<\/span> Demo Site \(proj_1\)<\/li><li><span class="fact-label">Viewer tier:<\/span> public<\/li><li><span class="fact-label">Browser:<\/span> Mozilla\/5\.0 \(Macintosh\)<\/li>/);
  assert.match(html, /<li><span class="fact-label">Submitted:<\/span> Nov 13, 2026, 2:04 PM MST<\/li>/, 'Mountain time, not UTC');
  assert.match(html, /<li><span class="fact-label">Report id:<\/span> br_1<\/li><\/ul>/);
  assert.doesNotMatch(html, /bug-shots/);
  // Screenshots that did come get one line pointing at the description on the right, at any status.
  const shots = renderQuickAction({ name: 'x', tags: ['bug-report'], status: 'live', description: bugDescription({ shots: '- [Screenshot 1](https://x.test/1.png)' }) });
  assert.match(shots, /<p class="bug-shots quiet">Screenshots are attached: see the description on the right\.<\/p>/);
  assert.match(shots, /^<h1>Bug Report:<\/h1>/);
  assert.match(shots, /^<h1>Bug Report:<\/h1>\n<p class="status-line">Status: <span class="status-name">Live<\/span>/, 'the status line sits under "Bug Report:" too (SP-290)');
  // A page that is not a web address is shown as text, not a link.
  assert.match(renderQuickAction({ name: 'x', tags: ['bug-report'], description: bugDescription().replace('https://example.com/pricing', '(not recorded)') }), /Page:<\/span> \(not recorded\)<\/li>/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /\.quick \.bug-words \{[^}]*font-size: var\(--text-md\); font-weight: 700;/, 'bold at body size');
});

test('Quick Action without the tag, the section, or with ## Asked looks exactly as before', () => {
  const plain = { name: 'Fix it', status: 'queued', comments: [], description: bugDescription() };
  assert.equal(renderQuickAction({ ...plain, tags: ['tracker'] }), renderQuickAction({ name: 'Fix it', status: 'queued', comments: [], description: bugDescription() }));
  assert.match(renderQuickAction({ ...plain, tags: [] }), /^<h1>Fix it<\/h1>/);
  assert.match(renderQuickAction({ ...plain, tags: ['bug-report'], description: '## Goal\nThe goal.' }), /^<h1>Fix it<\/h1>\n<p class="status-line">Status: [^\n]*<\/p>\n<p class="summary">The goal\.<\/p>/);
  const asked = `## Asked\n\`\`\`\nhis words\n\`\`\`\n\n${bugDescription()}`;
  assert.equal(renderQuickAction({ ...plain, tags: ['bug-report'], description: asked }), renderQuickAction({ ...plain, description: asked }));
});

test('the demo has a bug report shaped like SC-804, held in Needs your input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bug-demo-'));
  try {
    const store = openStore(join(dir, 'db.sqlite'));
    seedDemo(store, { operatorName: 'Op' });
    const t = store.listTickets('beta').find((x) => x.tags.includes('bug-report'));
    assert.ok(t, 'a demo ticket tagged bug-report');
    assert.equal(t.status, 'needs your input');
    const html = renderQuickAction(t);
    assert.match(html, /^<h1>Bug Report:<\/h1>\n<p class="status-line">Status: [^\n]*<\/p>\n<p class="bug-words">/);
    assert.match(html, /Submitted:<\/span> Nov 13, 2026, 2:04 PM MST/);
    assert.doesNotMatch(html, /none attached/);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Older ClickUp-imported bug reports (SP-314) ─────────────────────────────

/** SC-111 / SC-446..479's shape: a markdown-link page and a spaced `* * *` divider. */
const olderBugDescription = ({ page = '[https://example.com/a](https://example.com/a)' } = {}) => bugDescription()
  .replace('https://example.com/pricing', page)
  .replace('\n---\n', '\n* * *\n\n');

test('an older bug report: a spaced "* * *" is a rule, so "(none attached)" means no screenshots', () => {
  const r = bugReport({ tags: ['bug-report'], description: olderBugDescription() });
  assert.equal(r.screenshots, false);
  assert.equal(r.facts[0].value, '[https://example.com/a](https://example.com/a)', 'read as text; the link is made at render');
  for (const divider of ['- - -', '_ _ _', ' *  *  * ', '* * * *']) {
    assert.equal(bugReport({ tags: ['bug-report'], description: bugDescription().replace('\n---\n', `\n${divider}\n`) }).screenshots, false, divider);
  }
  const html = renderQuickAction({ name: 'x', tags: ['bug-report'], status: 'needs your input', description: olderBugDescription() });
  assert.doesNotMatch(html, /bug-shots|Screenshots are attached/);
});

test('an older bug report\'s markdown-link Page is one link showing the address, every character escaped', () => {
  const html = renderQuickAction({ name: 'x', tags: ['bug-report'], description: olderBugDescription() });
  assert.match(html, /<li><span class="fact-label">Page:<\/span> <a href="https:\/\/example\.com\/a" rel="noopener noreferrer" target="_blank">https:\/\/example\.com\/a<\/a><\/li>/);
  assert.equal((html.match(/<a /g) ?? []).length, 1);
  const nasty = renderQuickAction({ name: 'x', tags: ['bug-report'], description: olderBugDescription({ page: '[<b>"x"&y</b>](https://x.test/?a=1&b="2"<i>)' }) });
  assert.match(nasty, /Page:<\/span> <a href="https:\/\/x\.test\/\?a=1&amp;b=&quot;2&quot;&lt;i&gt;" [^>]*>&lt;b&gt;&quot;x&quot;&amp;y&lt;\/b&gt;<\/a><\/li>/);
  assert.doesNotMatch(nasty, /<b>|<i>|"x"/);
  // Not a link: a javascript: address, or anything around the link.
  for (const page of ['[click](javascript:alert(1))', '[click](javascript:alert)', 'see [a](https://x.test/a) here', '[a](https://x.test/a) [b](https://x.test/b)']) {
    const out = renderQuickAction({ name: 'x', tags: ['bug-report'], description: olderBugDescription({ page }) });
    const row = /<li><span class="fact-label">Page:<\/span> (.*?)<\/li>/.exec(out)[1];
    assert.doesNotMatch(row, /<a /, page);
    assert.equal(row, escapeHtml(page), page);
  }
});

test('renderMarkdown: "* * *", "- - -" and "_ _ _" are rules; "* item" and "* * text" are not', () => {
  for (const line of ['* * *', '- - -', '_ _ _', '***', '---', '  * * * *  ']) {
    assert.equal(renderMarkdown(`a\n\n${line}\n\nb`).match(/<hr>/g)?.length, 1, line);
  }
  for (const line of ['* item', '* * text', '- - x', '* *', '*-*']) {
    assert.doesNotMatch(renderMarkdown(line), /<hr>/, line);
  }
});

test('the demo has an older-shape bug report, held, with a linked page and no screenshot line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bug-demo-old-'));
  try {
    const store = openStore(join(dir, 'db.sqlite'));
    seedDemo(store, { operatorName: 'Op' });
    const t = store.listTickets('beta').find((x) => x.tags.includes('bug-report') && x.description.includes('* * *'));
    assert.ok(t, 'a demo bug report with a spaced divider');
    assert.equal(t.status, 'needs your input');
    const html = renderQuickAction(t);
    assert.match(html, /^<h1>Bug Report:<\/h1>/);
    assert.match(html, /Page:<\/span> <a href="https:\/\/example\.com\/blog"[^>]*>https:\/\/example\.com\/blog<\/a>/);
    assert.doesNotMatch(html, /bug-shots|none attached/);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── A held bug report's Approve and Reject (SP-287) ─────────────────────────

test('a held bug report is tagged bug-report, in Needs your input, with no card in its thread', () => {
  const held = { tags: ['bug-report'], status: 'needs your input', comments: [{ body: 'A plain note.' }] };
  assert.equal(heldBugReport(held), true);
  assert.equal(heldBugReport({ ...held, status: 'Needs your input' }), true, 'either spelling');
  assert.equal(heldBugReport({ ...held, comments: [...held.comments, { body: intakeCard() }] }), false, 'a loop asked about it: not held');
  assert.equal(heldBugReport({ ...held, tags: ['tracker'] }), false);
  assert.equal(heldBugReport({ ...held, status: 'requested' }), false);
  assert.equal(heldBugReport({ ...held, status: 'ready to launch' }), false);
  assert.equal(heldBugReport({}), false);
  assert.equal(heldBugReport({ tags: null, status: null, comments: null }), false);
});

// ── While a loop has the ticket (SP-291) ─────────────────────────────────────

test('while a loop has the ticket there is no reply box, and an Add Comment box stands in; his two statuses keep the reply box', () => {
  assert.deepEqual([...LOOP_HAS_STATUSES], ['requested', 'queued', 'building', 'in review', 'rework', 'live']);
  for (const status of LOOP_HAS_STATUSES) {
    const t = { status, comments: [] };
    assert.equal(loopHasIt(t), true, status);
    assert.equal(loopHasIt({ status: status.toUpperCase() }), true, `${status}, any case`);
    assert.equal(renderReplyForm(t, 'Dane'), '', `no Reply box in ${status}`);
    const box = renderCommentForm(t);
    assert.match(box, /^<form class="add-comment">/, status);
    assert.match(box, /<label for="add-comment">Add a Note for the Loop<\/label>/);
    assert.match(box, /<textarea id="add-comment" required><\/textarea>/);
    assert.match(box, /<button type="submit" class="btn">Add Comment<\/button><span class="note"><\/span>/);
  }
  for (const status of ['needs your input', 'ready to launch', undefined, 'something new']) {
    const t = { status, comments: [] };
    assert.equal(loopHasIt(t), false, String(status));
    assert.equal(renderCommentForm(t), '', `no Add Comment box in ${status}`);
    assert.match(renderReplyForm(t, 'Dane'), /<form class="reply">[\s\S]*Reply as Dane[\s\S]*Post Reply/, `the reply box as before in ${status}`);
  }
});

test('the demo data: a Queued ticket gets the comment box and a Needs your input ticket the reply box; a comment added there is on the ticket as typed', async () => {
  const f = await fixture();
  try {
    const tickets = (await f.call('GET', '/projects/alpha/tickets')).body.tickets ?? [];
    const queued = tickets.find((t) => t.name === 'The board is missing: draw the seven columns');
    const asked = tickets.find((t) => t.name === 'The tracker has nowhere to run: choose where it lives');
    assert.ok(queued && asked, 'both demo tickets found');
    let thread = (await f.call('GET', `/tickets/${queued.id}/thread`)).body;
    assert.equal(renderReplyForm(thread, 'Dane'), '');
    assert.match(renderCommentForm(thread), /Add Comment/);
    const words = '  Try this on a phone first\n';
    assert.equal((await f.call('POST', `/tickets/${queued.id}/comments`, { body: { body: words } })).status, 201);
    thread = (await f.call('GET', `/tickets/${queued.id}/thread`)).body;
    assert.equal(thread.comments.at(-1).body, words, 'the newest comment, exactly as typed');
    assert.equal(thread.status, 'queued', 'a comment moves nothing');
    const his = (await f.call('GET', `/tickets/${asked.id}/thread`)).body;
    assert.match(renderReplyForm(his, 'Dane'), /<form class="reply">/);
    assert.equal(renderCommentForm(his), '');
  } finally { await f.cleanup(); }
});

test('the ticket page puts the details in the right column, open, while a loop has it, and posts Add Comment exactly as typed', () => {
  const app = pageScript();
  const draw = /\nasync function drawTicket\(id, said = null, kept = null\) \{[\s\S]*?\n\}\n/.exec(app)?.[0] ?? '';
  assert.ok(draw, 'drawTicket found');
  assert.match(draw, /const inline = loopHasIt\(t\);/);
  const body = /const ticketBody = `([\s\S]*?)`;\n  const actions/.exec(draw)?.[1] ?? '';
  // Everything Details held, the Add Comment box under the comments, Copy at the end.
  const order = ['<p class="meta">', 'renderEditPanel(t)', '<section class="description">', 'renderAttachments(t)', '<h2 id="comments">Comments</h2>', '${comments ||', '${renderCommentForm(t)}', '<h2>Copy to Another Project</h2>'];
  const at = order.map((part) => body.indexOf(part));
  assert.ok(at.every((i) => i >= 0), `all in the one block: ${order.filter((_, i) => at[i] < 0)}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in that order');
  // In the right column, open, under any actions, on a loop ticket; on his, open on the right too (SP-416).
  assert.match(draw, /\$\{inline \? actions : renderFilesMade\(t\)\}\s*<div class="details">\$\{ticketBody\}<\/div>\s*\$\{renderDeleteAction\(t\)\}\s*<\/div>/);
  assert.doesNotMatch(draw, /<details class="details">/);
  // The box posts its words untouched; a failed post says so and keeps them; a post that landed never says it did not.
  const wire = draw.slice(draw.indexOf("const commentForm = main.querySelector('form.add-comment');"), draw.indexOf("const form = main.querySelector('form.reply');"));
  assert.match(wire, /api\('POST', `\/tickets\/\$\{encodeURIComponent\(t\.id\)\}\/comments`, \{ body: commentBox\.value \}\)/);
  assert.match(wire, /commentNote\.textContent = `Not posted: \$\{err\.message\}`;\s*button\.disabled = false;\s*return;/);
  assert.doesNotMatch(wire, /commentBox\.value = ''/, 'the words are never cleared by hand: the redraw draws a fresh box');
  assert.match(wire, /await drawAgain\(\(\) => drawTicket\(t\.id\)\);[\s\S]*Posted, but the page could not refresh/);
  assert.match(wire, /location\.hash === '#reply' && !refreshing\) \{\s*commentForm\.scrollIntoView\(\{ block: 'center' \}\);\s*commentBox\.focus\(\);/, "the list's Reply icon lands in the box");
  assert.ok(draw.indexOf('const commentForm') < draw.indexOf('if (!form) return;'), 'wired before the reply box\'s early return');
  // Two columns that stack under 800px, as the docs page's do; his two statuses' layout untouched.
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /@media \(max-width: 800px\) \{ \.quick\.loop-has \{ grid-template-columns: minmax\(0, 1fr\); \} \}/);
  assert.match(css, /^\.quick \{ display: grid; grid-template-columns: 1fr 1fr;/m);
  assert.match(css, /form\.add-comment textarea \{ min-height: 5rem; \}/, 'the long width token, as every text box (SP-325)');
});

test('a held bug report shows Approve and Reject and a quiet line in place of the reply box; anything else is unchanged', () => {
  const held = { name: 'Bug report: x', tags: ['bug-report'], status: 'needs your input', comments: [], description: bugDescription() };
  const html = renderBugReportActions(held);
  assert.match(html, /<form class="approve-action">\s*<button type="submit" class="btn btn-save">Approve<\/button><span class="note"><\/span>/);
  assert.match(html, /<form class="reject-action">\s*<button type="submit" class="btn btn-danger">Reject<\/button><span class="note"><\/span>/);
  assert.ok(html.indexOf('approve-action') < html.indexOf('reject-action'), 'Approve first');
  assert.match(html, /Moves it to Requested; the intake lane writes it up/);
  assert.match(html, /Moves it to Live with the wont-do tag and a note that nothing shipped/);
  assert.ok(html.includes(`<p class="held-report quiet">${escapeHtml(HELD_REPORT_LINE)}</p>`));
  assert.match(HELD_REPORT_LINE, /No loop reads a reply[\s\S]*Approve or Reject[\s\S]*Change panel on the right/);
  assert.equal(renderReplyForm(held, 'Dane'), '', 'no reply box on a held bug report');
  // Nothing else on it offers a move: no card, so no Go, Close or Merge.
  assert.equal(renderGoAction({ ...held, goPhrase: 'go' }), '');
  assert.equal(renderCloseAction({ ...held, closePhrase: 'close' }), '');
  // The status line's "i" names the buttons, not "your answer below".
  assert.ok(renderStatusLine(held).includes(escapeHtml(HELD_REPORT_STATUS_LINE)));
  // A carded bug report and any other ticket: no buttons, the reply box as before.
  const carded = { ...held, comments: [{ body: intakeCard() }] };
  for (const other of [carded, { ...held, tags: [] }, { ...held, status: 'ready to launch' }, { name: 'x', status: 'needs your input', comments: [] }]) {
    assert.equal(renderBugReportActions(other), '');
    assert.match(renderReplyForm(other, 'Dane'), /<form class="reply">/);
    assert.ok(!renderStatusLine(other).includes(escapeHtml(HELD_REPORT_STATUS_LINE)));
  }
  assert.match(renderGoAction({ ...carded, goPhrase: 'go' }), /go-action/, 'Go is back once intake has asked');
});

test('Approve and Reject ask first, naming the ticket, and changeProblem says what did not stick', () => {
  assert.equal(approveQuestion({ name: 'Bug report: x' }), 'Approve Bug report: x and send it to intake?');
  assert.equal(rejectQuestion({ name: 'Bug report: x' }), 'Reject Bug report: x? It moves to Live with the wont-do tag, and nothing is built.');
  assert.equal(WONT_DO_TAG, 'wont-do');
  assert.match(REJECT_COMMENT, /^Rejected from the ticket page:[\s\S]*nothing shipped/);
  assert.equal(changeProblem({ ticket: { status: 'requested', tags: [] } }, { status: 'requested' }), '');
  assert.equal(changeProblem({ ticket: { status: 'live', tags: ['bug-report', 'wont-do'] } }, { status: 'live', tags: ['wont-do'] }), '');
  assert.equal(changeProblem({ ticket: { status: 'needs your input', tags: [] } }, { status: 'requested' }), 'the status reads "needs your input", not "requested".');
  assert.equal(changeProblem({ ticket: { status: 'live', tags: [] } }, { status: 'live', tags: ['wont-do'] }), 'the wont-do tag is not on it.');
  assert.equal(changeProblem({}, { status: 'live' }), 'the tracker did not answer with the ticket.');
  assert.equal(changeProblem(null), 'the tracker did not answer with the ticket.');
});

test('the page wires Approve and Reject to guarded changes it reads back, and never says done over a failed write', () => {
  const app = pageScript();
  assert.match(app, /\$\{renderGoAction\(t\)\}\s*\$\{renderBugReportActions\(t\)\}\s*\$\{renderReplyForm\(t, me\?\.name\)\}/, 'in the Quick Action column, where the reply box was');
  assert.match(app, /api\('PATCH', `\/tickets\/\$\{encodeURIComponent\(t\.id\)\}`, \{ \.\.\.fields, ifStatus: t\.status, ifVersion: t\.version \}\)/, 'guarded on what the page was drawn with');
  assert.match(app, /bugButton\('form\.approve-action', approveQuestion\(t\), \[\s*\{ what: 'the move to Requested', write: async \(\) => changeProblem\(await patch\(\{ status: 'requested' \}\), \{ status: 'requested' \}\) \}/);
  assert.match(app, /bugButton\('form\.reject-action', rejectQuestion\(t\), \[[\s\S]*patch\(\{ status: 'live', tags: \[\.\.\.new Set\(\[\.\.\.t\.tags, WONT_DO_TAG\]\)\] \}\)[\s\S]*body: REJECT_COMMENT[\s\S]*posted\?\.body === REJECT_COMMENT/);
  const wire = /const bugButton = [\s\S]*?\n {2}\};\n/.exec(app)?.[0] ?? '';
  assert.ok(wire, 'bugButton found');
  assert.match(wire, /if \(!confirm\(question\)\) return;/, 'asks first');
  assert.match(wire, /if \(problem\) \{[\s\S]*return fail\(`Not saved: \$\{step\.what\}/, 'a write that did not stick stops there and says which');
  assert.ok(wire.indexOf('return fail(`Not saved') < wire.indexOf('drawAgain'), 'the page redraws only once every write stuck');
});

test('on the server, Approve leaves a held bug report in Requested and Reject in Live with wont-do and the note; a stale page is refused', async () => {
  const f = await fixture({ goPhrase: 'go' });
  try {
    const threads = await Promise.all(f.store.listTickets('beta').map(async (t) => (await f.call('GET', `/tickets/${t.id}/thread`)).body));
    const held = threads.filter((t) => heldBugReport(t));
    assert.equal(held.length, 3, 'the demo holds three bug reports: one to approve, one to reject, and the older shape (SP-314)');
    for (const t of threads.filter((x) => !heldBugReport(x))) assert.equal(renderBugReportActions(t), '', t.name);
    const [a, r] = held;
    // Approve: the page's one change, as the page sends it.
    const approved = await f.call('PATCH', `/tickets/${a.id}`, { body: { status: 'requested', ifStatus: a.status, ifVersion: a.version } });
    assert.equal(approved.status, 200);
    assert.equal(changeProblem(approved.body, { status: 'requested' }), '');
    assert.equal((await f.call('GET', `/tickets/${a.id}/thread`)).body.status, 'requested');
    // Reject: the status and tag together, then the note.
    const rejected = await f.call('PATCH', `/tickets/${r.id}`, { body: { status: 'live', tags: [...new Set([...r.tags, WONT_DO_TAG])], ifStatus: r.status, ifVersion: r.version } });
    assert.equal(rejected.status, 200);
    assert.equal(changeProblem(rejected.body, { status: 'live', tags: [WONT_DO_TAG] }), '');
    const posted = await f.call('POST', `/tickets/${r.id}/comments`, { body: { body: REJECT_COMMENT } });
    assert.equal(posted.status, 201);
    assert.equal(posted.body.body, REJECT_COMMENT);
    const after = (await f.call('GET', `/tickets/${r.id}/thread`)).body;
    assert.equal(after.status, 'live');
    assert.deepEqual(after.tags.sort(), ['bug-report', 'demo-site', 'wont-do']);
    assert.deepEqual([after.comments.at(-1).body, after.comments.at(-1).author.id], [REJECT_COMMENT, f.operator.id]);
    // A page drawn before the ticket moved is refused, and nothing is written.
    const stale = await f.call('PATCH', `/tickets/${r.id}`, { body: { status: 'requested', ifStatus: r.status, ifVersion: r.version } });
    assert.equal(stale.status, 409);
    assert.equal((await f.call('GET', `/tickets/${r.id}/thread`)).body.status, 'live');
  } finally { await f.cleanup(); }
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
  assert.match(same, /^<h1>Fix it<\/h1>\n<p class="status-line">Status: <span class="status-name">Queued<\/span>[\s\S]*<\/p>\n<h2 class="request-heading">Original Request<\/h2>\n<p class="original-request">please<\/p>$/);
  // His words keep their line breaks on the page.
  assert.match(readFileSync(WEB('app.css'), 'utf8'), /\.quick \.original-request \{[^}]*white-space: pre-wrap/);
  // The tab title is still the ticket's current name.
  assert.match(pageScript(), /tabTitle\(/);
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
  assert.match(rework, /<span class="status-tip" id="status-tip" role="tooltip">The build loop is fixing what review found\. Nothing is needed from you\.<\/span>/);
  assert.equal(renderGoAction({ ...ticket, status: 'rework' }), '', 'and no Go button');
  // The same card on Needs your input: the ask and the Go button, and his own line.
  const nyi = renderQuickAction({ ...ticket, status: 'needs your input' });
  assert.match(nyi, /<p class="needed">[^<]*go[\s\S]*Your move: Reply/);
  assert.match(nyi, /role="tooltip">The loop is waiting on your answer below\.<\/span>/);
  assert.match(renderGoAction({ ...ticket, status: 'needs your input' }), /go-action/);
  // His answer is in: no ask, even in his status.
  assert.doesNotMatch(renderQuickAction({ ...ticket, status: 'needs your input', answerIn: true }), /Your move|class="needed"/);
  assert.doesNotMatch(renderQuickAction({ ...ticket, status: 'Ready to launch', answerIn: true }), /Your move|class="needed"/);
  // Every machine status has its line and never an ask.
  for (const status of ['requested', 'queued', 'building', 'in review', 'rework', 'live']) {
    const html = renderQuickAction({ ...ticket, status });
    assert.doesNotMatch(html, /Your move|class="needed"/, status);
    assert.match(html, /role="tooltip">[^<]*Nothing is needed from you\.<\/span>/, status);
  }
  // The page hands the function the ticket's status and answerIn (the whole thread).
  assert.match(pageScript(), /renderQuickAction\(t\)/);
});

test('the status is first under the heading, with its line behind an information icon (SP-290)', () => {
  const contract = readFileSync(new URL('../docs/LOOP_CONTRACT.md', import.meta.url), 'utf8');
  const spelled = ['Requested', 'Rework', 'Queued', 'Building', 'In review', 'Needs your input', 'Ready to launch', 'Live'];
  for (const name of spelled) {
    assert.match(contract, new RegExp(`\\| \\*{0,2}\`${name}\`\\*{0,2} \\|`), `${name} is spelled as LOOP_CONTRACT.md spells it`);
    const html = renderQuickAction({ name: 'Fix it', description: '', status: name.toLowerCase() });
    const lines = html.split('\n');
    assert.equal(lines[0], '<h1>Fix it</h1>');
    assert.ok(lines[1].startsWith(`<p class="status-line">Status: <span class="status-name">${name}</span>`), `${name}: right under the heading`);
    assert.match(lines[1], /<button type="button" class="status-info" title="Status Information" aria-label="Status Information" aria-expanded="false" aria-describedby="status-tip"><svg[^>]*aria-hidden="true">/, name);
    assert.match(lines[1], /<span class="status-tip" id="status-tip" role="tooltip">[^<]+<\/span><\/p>$/, name);
    assert.doesNotMatch(html, /class="where/, `${name}: the old grey line is gone`);
  }
  assert.match(renderStatusLine({ status: 'queued' }), /role="tooltip">It waits for the build loop to pick it up\. Nothing is needed from you\.</);
  // Ready to launch names the Merge only when the page offers the Merge button (third send-back).
  const pr = 'https://github.com/o/r/pull/14';
  const ready = { status: 'Ready to launch', mergePhrase: 'merge', pullRequest: pr };
  assert.match(renderStatusLine(ready), /role="tooltip">The work is built and checked, and waits on your Merge\.</);
  assert.ok(offersMerge(ready));
  assert.match(renderStatusLine({ status: 'ready to launch' }), new RegExp(`role="tooltip">${REPLY_LINE.replace('.', '\\.')}<`), 'no pull request: no Merge to name');
  assert.match(renderStatusLine({ ...ready, mergePhrase: null }), /role="tooltip">It waits on your reply below\.</, 'no merge word: no Merge button');
  // A card whose move is Close: the "i" names Close, as the button does (BE-7).
  const closeCard = { body: '@@ASKED\nx\n**NEEDED FROM DANE: Nothing to merge.**\n**Your move: Close — its work is live.**', machine: true };
  for (const status of ['ready to launch', 'needs your input']) {
    const closing = { ...ready, status, closePhrase: 'close', comments: [closeCard] };
    assert.ok(offersClose(closing), `${status}: the card's move is Close`);
    assert.match(renderStatusLine(closing), new RegExp(`role="tooltip">${CLOSE_LINE.replace(/[.;]/g, '\\$&')}<`), status);
    assert.doesNotMatch(renderStatusLine(closing), /waits on your Merge|answer below/, status);
    assert.match(renderCloseAction(closing), /close-action/, `${status}: and the page draws Close`);
    assert.doesNotMatch(renderMergeAction(closing), /merge-action/, `${status}: and no Merge`);
  }
  // His answer is in: the status says so, as the Details line does.
  assert.match(renderStatusLine({ status: 'needs your input', answerIn: true }), new RegExp(`status-name">Needs your input · ${ANSWER_IN_NOTE}<`));
  // ...and the "i" no longer asks for his move once it is made (review send-back).
  for (const status of ['needs your input', 'ready to launch']) {
    const answered = renderStatusLine({ status, answerIn: true });
    assert.match(answered, /role="tooltip">Your answer is in; the loop takes it from here\. Nothing is needed from you\.</, status);
    assert.doesNotMatch(answered, /answer below|waits on your Merge/, status);
  }
  const merging = renderStatusLine({ status: 'ready to launch', mergeStands: true });
  assert.match(merging, new RegExp(`status-name">Ready to launch · ${MERGE_STANDS_NOTE}<`));
  assert.match(merging, /role="tooltip">Your merge word is in; the relay merges it on its next pass\. Nothing is needed from you\.</);
  assert.doesNotMatch(merging, /waits on your Merge/);
  // A pull request past the merge (SP-226) asks nothing of him either (second send-back).
  const merged = renderStatusLine({ status: 'ready to launch', pullRequestState: { number: 14, state: 'MERGED' } });
  assert.match(merged, /role="tooltip">The pull request is merged; the relay moves this to Live on its next pass\. Nothing is needed from you\.</);
  assert.doesNotMatch(merged, /waits on your Merge/);
  const closed = renderStatusLine({ status: 'ready to launch', pullRequestState: { number: 14, state: 'CLOSED' } });
  assert.match(closed, /role="tooltip">The pull request was closed without merging; see the note below\.</);
  assert.doesNotMatch(closed, /waits on your Merge/);
  // Merged wins over a merge word still standing; a failed read (state null) is not settled.
  assert.match(renderStatusLine({ status: 'ready to launch', mergeStands: true, pullRequestState: { number: 14, state: 'MERGED' } }), /role="tooltip">The pull request is merged;/);
  assert.match(renderStatusLine({ ...ready, pullRequestState: { number: 14, state: null } }), /waits on your Merge/);
  assert.match(renderStatusLine({ ...ready, pullRequestState: { number: 14, state: 'OPEN' } }), /waits on your Merge/);
  // The same through the whole page, as BE-8 ("Merged on GitHub but not yet Live") shows it.
  const be8 = renderQuickAction({ name: 'Merged on GitHub but not yet Live', description: '', status: 'ready to launch', pullRequestState: { number: 14, state: 'MERGED' } });
  assert.match(be8, /role="tooltip">The pull request is merged; the relay moves this to Live/);
  assert.doesNotMatch(be8, /waits on your Merge/);
  // The same through the whole page, as AL-2 in the demo shows it.
  const al2 = renderQuickAction({ name: 'Ship it', description: '', status: 'ready to launch', answerIn: true });
  assert.match(al2, /role="tooltip">Your answer is in; the loop takes it from here/);
  // Under the Ticket name line when his title differs.
  const renamed = renderQuickAction({ name: 'Loop name', description: '## Asked\n```\nHis title\n\nwords\n```\n', status: 'building' }).split('\n');
  assert.match(renamed[1], /class="ticket-name/);
  assert.match(renamed[2], /^<p class="status-line">Status: <span class="status-name">Building</);
  // No status, no line; an unknown status is named but has no icon.
  assert.equal(renderStatusLine({ status: '' }), '');
  assert.doesNotMatch(renderStatusLine({ status: 'odd' }), /status-info/);
  // Hover, keyboard focus and a tap (aria-expanded, toggled by the page) all show the line.
  const css = readFileSync(WEB('app.css'), 'utf8');
  for (const show of [':hover', ':focus-visible', '[aria-expanded="true"]']) assert.ok(css.includes(`.quick .status-info${show} + .status-tip`), show);
  assert.match(pageScript(), /statusInfo\?\.addEventListener\('click'/);
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

test('a card whose ask has command blocks shows each one on the right with its own Copy button', () => {
  const needed = 'Run these in Terminal:\n```bash\nnpm run clickup -- get --task SP-1\n```\nthen\n~~~\ncd ~/WebApps && ls\n~~~\nReply done.';
  for (const body of Object.values(commandCards(needed))) {
    const html = renderCommands({ comments: [{ body }, { body: 'go' }] });
    assert.equal(codes(html).length, 2);
    assert.equal(html.match(/<button type="button" class="btn copy-command">Copy<\/button>/g).length, 2);
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
  const app = pageScript();
  assert.match(app, /button\.parentElement\.querySelector\('code'\)\.textContent/);
  assert.match(app, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(app, /document\.execCommand\('copy'\)/);
  assert.match(app, /'Copied'/);
  const quick = /<section class="quick[^"]*">([\s\S]*?)<\/section>/.exec(app)[1];
  assert.match(quick, /<div class="act">\s*\$\{renderCommands\(t\)\}/, 'the commands sit first on the right');
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
  const app = pageScript();
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
  assert.equal(html.match(/class="btn copy-command">Copy</g).length, 1);
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
    assert.equal(renderCommands({ comments: [{ body }] }).match(/class="btn copy-command"/g).length, 2);
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
  const app = pageScript();
  const copy = /async function copyText[\s\S]*?\n}\n/.exec(app)[0];
  // The hidden box is focused before its text is selected, and the button gets focus back.
  assert.match(copy, /area\.focus\(\);\s*area\.setSelectionRange\(0, area\.value\.length\);[\s\S]*execCommand\('copy'\)/);
  assert.match(copy, /button\?\.focus\(\)/);
  assert.match(app, /clearTimeout\(reset\);\s*reset = setTimeout/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /\.quick \.act \{[^}]*min-width: 0/);
  assert.match(css, /\.quick \.command pre \{[^}]*min-width: 0/);
});

// ── Quick Action's Merge button ──────────────────────────────────────────────

const PR = 'https://github.com/o/r/pull/41';

test('only a Ready to launch ticket gets the Merge button, and only when the server named a merge phrase', () => {
  for (const name of loopStatuses.STAGE_ORDER) {
    const html = renderMergeAction({ status: loopStatuses.statusOf(name), mergePhrase: 'merge', pullRequest: PR });
    if (loopStatuses.statusOf(name) === loopStatuses.READY_TO_LAUNCH) assert.match(html, /<form class="merge-action">\s*<button type="submit" class="btn btn-save">Merge<\/button>/, name);
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
    if (loopStatuses.OPERATOR_HELD_STATUSES.includes(status)) assert.match(html, /<form class="close-action">\s*<button type="submit" class="btn btn-save">Close<\/button>/, name);
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
    if (status === loopStatuses.NEEDS_YOUR_INPUT) assert.match(html, /<form class="go-action">\s*<button type="submit" class="btn btn-save">Go<\/button>/, name);
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
    assert.equal(renderGoAction(threads.find((t) => t.name === 'A question a loop asked, with no machine stamp')), '');
    const posted = await f.call('POST', `/tickets/${shown[0].id}/comments`, { body: { body: GO_PHRASE } });
    assert.equal(posted.status, 201);
    const stored = f.store.listComments(shown[0].id).at(-1);
    assert.deepEqual([stored.body, stored.author], [GO_PHRASE, f.operator.id]);
  } finally { await f.cleanup(); }
  const none = await fixture();
  try {
    assert.equal((await none.call('GET', '/tickets/AL-1/thread')).body.goPhrase, null, 'no word: no button');
  } finally { await none.cleanup(); }
  const app = pageScript();
  assert.match(app, /wordButton\('form\.go-action', goQuestion\(t\), t\.goPhrase,/);
  assert.match(app, /\$\{renderCloseAction\(t\)\}\s*\$\{renderGoAction\(t\)\}\s*(?:\$\{renderBugReportActions\(t\)\}\s*)?\$\{renderReplyForm\(t, me\?\.name\)\}/, 'Go sits between Close and the reply box');
});

test('no go word is written into the page\'s code, and the Go button is the same Save-green kind as Merge (UI_DOCTRINE 3, SP-415)', () => {
  const code = (name) => readFileSync(WEB(name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const name of ['app.mjs', ...RENDER_SCRIPTS, 'index.html']) {
    assert.doesNotMatch(code(name), new RegExp(`['"\`]${busRelayPlan.GO_PHRASE}['"\`]`, 'i'), name);
  }
  // Both are answers, the Save green (SP-415); neither sets its own size or corners (SP-86's 10px are every button's now).
  const render = renderScript();
  assert.match(render, /<form class="merge-action">\s*<button type="submit" class="btn btn-save">Merge<\/button>/);
  assert.match(render, /<form class="go-action">\s*<button type="submit" class="btn btn-save">Go<\/button>/);
  assert.doesNotMatch(code('app.css'), /form\.(?:merge|go)-action button/);
  assert.match(code('app.css'), /^\.btn \{[^}]*border-radius: var\(--radius-btn\);/m);
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
  const app = pageScript();
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
  assert.match(app, /const actions = `\s*\$\{renderAnswerIn\(t\)\}\s*\$\{renderMergeAction\(t\)\}\s*\$\{renderCloseAction\(t\)\}\s*\$\{renderGoAction\(t\)\}\s*(?:\$\{renderBugReportActions\(t\)\}\s*)?\$\{renderReplyForm\(t, me\?\.name\)\}`;/, 'the answer-is-in line, then Merge, Close and Go, sit above the reply box (in the pod, SP-416)');
});

test('after a reply, Merge, Close or Go posts, the page stays at the top with no confirmation box', () => {
  const app = pageScript();
  const html = readFileSync(WEB('index.html'), 'utf8');
  const css = readFileSync(WEB('app.css'), 'utf8');
  // No posted box: the redrawn page is the confirmation. (Other boxes, such
  // as the Add Task "right project?" question, are separate and stay.)
  assert.doesNotMatch(html, /id="posted"|posted-text/);
  assert.doesNotMatch(css, /dialog#posted/);
  assert.doesNotMatch(app, /getElementById\('posted'\)|posted\.showModal/);
  // One helper: the page at the top. The comments are already open on the right (SP-416), so there is no fold to open.
  const helper = /const afterPost = \(\) => \{([\s\S]*?)\n  \};/.exec(app)?.[1];
  assert.ok(helper, 'one shared helper');
  assert.match(helper, /^\s*window\.scrollTo\(0, 0\);\s*$/);
  assert.doesNotMatch(app, /openDetails/);
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
  for (const name of ['app.mjs', ...RENDER_SCRIPTS, 'index.html']) {
    for (const phrase of loadProjectConfig().mergePhrases) {
      const quoted = new RegExp(`['"\`]${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`, 'i');
      assert.doesNotMatch(code(name), quoted, `${name} spells "${phrase}"`);
    }
  }
});

// ── Deleting a ticket nobody has started ─────────────────────────────────────

test('Delete is offered only for Requested and Queued, in either spelling of the status', () => {
  for (const name of loopStatuses.STAGE_ORDER) {
    const unstarted = name === 'Requested' || name === 'Queued';
    for (const status of [name, loopStatuses.statusOf(name)]) {
      assert.equal(canDelete(status), unstarted, status);
      if (unstarted) assert.match(renderDeleteAction({ status }), /<form class="delete-action">\s*<button type="submit" class="btn btn-danger">Delete<\/button>/, status);
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

test('both Deletes confirm before any request, show a refusal on the page, and keep the ticket in view', () => {
  const app = pageScript();
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

test('SP-373: the Change panel has a Files row: a multi-file picker, the Add Task hint and an Upload button, with no inline style', () => {
  for (const status of ['queued', 'live']) {
    const html = renderEditPanel({ name: 'n', status });
    assert.match(html, /<label for="edit-files">Files<\/label>/);
    assert.match(html, /<input id="edit-files" type="file" multiple aria-describedby="edit-files-hint"><button type="button" class="btn edit-upload">Upload<\/button>/);
    assert.match(html, /<span class="hint" id="edit-files-hint">Screenshots, PDFs or notes, up to 10 MB each\.<\/span>/);
    // Below How It Ended, inside the fields form; a plain button, so it never submits the form.
    assert.ok(html.indexOf('edit-outcome') < html.indexOf('edit-files'));
    assert.ok(html.indexOf('edit-files') < html.indexOf('<form class="edit-name">'));
    assert.doesNotMatch(html, /style=/);
  }
});

test('SP-373: uploadEach sends each file on its own, skips one over the limit, names every failure with why, and never calls a failure success', async () => {
  const file = (name, size) => ({ name, size });
  const sent = [];
  const seen = [];
  const send = async (f) => {
    sent.push(f.name);
    if (f.name === 'bad.png') throw new Error('that file type is not kept.');
  };
  const all = await uploadEach([file('a.png', 10), file('big.mov', 11), file('bad.png', 5), file('b.pdf', 3)], send, { max: 10, onEach: (f) => seen.push(f.name) });
  assert.deepEqual(sent, ['a.png', 'bad.png', 'b.pdf'], 'the big one is never sent; the rest still go after a failure');
  assert.deepEqual(seen, sent);
  assert.deepEqual(all.uploaded, ['a.png', 'b.pdf']);
  assert.deepEqual(all.notUploaded, [{ name: 'big.mov', why: 'over 10 MB' }, { name: 'bad.png', why: 'that file type is not kept' }]);
  assert.deepEqual(all.message, { kind: 'error', text: 'Uploaded a.png, b.pdf. Not uploaded: big.mov (over 10 MB), bad.png (that file type is not kept).' });
  assert.equal(all.signedOut, false);
  // All went up: success, naming them.
  const ok = await uploadEach([file('a.png', 1), file('b.png', 1)], async () => {}, { max: 10 });
  assert.deepEqual(ok.message, { kind: 'success', text: 'Uploaded a.png, b.png.' });
  // None went up: an error that says nothing was uploaded.
  const none = await uploadEach([file('x.png', 1)], async () => { throw new Error('the tracker answered 500.'); }, { max: 10 });
  assert.deepEqual(none.message, { kind: 'error', text: 'Not uploaded: x.png (the tracker answered 500).' });
  assert.doesNotMatch(none.message.text, /Uploaded/);
  // Signed out mid-way: stop, and name that file and every one after it.
  class Out extends Error {}
  const tried = [];
  const out = await uploadEach([file('a.png', 1), file('b.png', 1), file('c.png', 1)], async (f) => { tried.push(f.name); if (f.name === 'b.png') throw new Out('x'); }, { max: 10, isSignedOut: (e) => e instanceof Out });
  assert.deepEqual(tried, ['a.png', 'b.png']);
  assert.equal(out.signedOut, true);
  assert.equal(out.message.text, 'Uploaded a.png. Not uploaded: b.png (signed out), c.png (signed out).');
});

test('SP-373: Upload sends through uploadFile to this ticket, holds the panel, reports in the message strip after the redraw, and asks for a file when none is picked', () => {
  const app = pageScript();
  const wire = app.slice(app.indexOf('function wireEditPanel'), app.indexOf('return {', app.indexOf('function wireEditPanel')));
  const up = wire.slice(wire.indexOf("panel.querySelector('.edit-upload')"));
  assert.match(up, /if \(!files\.length\) return showMessage\(\{ kind: 'error', text: 'Pick a file first: nothing was uploaded\.' \}\);/);
  assert.match(up, /uploadEach\(files, \(file\) => uploadFile\(t\.id, file\), \{\s*max: MAX_FILE,\s*isSignedOut: \(err\) => err instanceof SignedOut,/);
  assert.match(up, /if \(saving\) return;[\s\S]*saving = true;[\s\S]*c\.disabled = true;/, 'one write at a time, the panel held');
  assert.match(up, /if \(signedOut\) return drawSignIn\(`You were signed out\. \$\{message\.text\}`\);/);
  assert.match(up, /drawAgain\(\(\) => drawTicket\(t\.id, \{ message \}, typed\('files'\)\)\)/, 'drawn again so the files show, keeping what was typed');
  assert.doesNotMatch(up, /note\.(?:className|textContent)/, 'nothing beside the button');
  const draw = app.slice(app.indexOf('async function drawTicket'), app.indexOf('function stripNote'));
  assert.match(draw, /if \(said\.message\) \{\s*showMessage\(said\.message\);/);
});

test('the name is locked, with the reason, once a pull request is recorded', () => {
  const open = renderEditPanel({ name: 'n', status: 'queued', pullRequest: null });
  assert.match(open, /<input id="edit-name" class="field-long" type="text" value="n" required>/);
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
  const app = pageScript();
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
  const app = pageScript();
  const wire = /function wireEditPanel\(t\) \{([\s\S]*?)\n\}/.exec(app)?.[1];
  const save = wire.slice(wire.indexOf('const save = async'), wire.indexOf("for (const select of"));
  assert.match(save, /if \(saving\) return;\s*saving = true;/, 'a second save while one is in flight does nothing');
  assert.match(save, /panel\.querySelectorAll\('input, select, textarea, button'\)/, 'every control in the panel is held, not just the one changed');
  // The flag only comes back down on a refusal; after a save the panel is drawn anew.
  assert.equal(save.match(/saving = false/g).length, 1);
});

test('a save carries over what is typed elsewhere on the page: the reply box, an open description edit, an unsaved name or tag', () => {
  const app = pageScript();
  const wire = /function wireEditPanel\(t\) \{([\s\S]*?)\n\}/.exec(app)?.[1];
  const typed = wire.slice(wire.indexOf('const typed ='), wire.indexOf('const redraw ='));
  assert.match(typed, /reply: main\.querySelector\('form\.reply textarea, form\.add-comment textarea'\)\?\.value/, 'the reply box, or the Add Comment box on a loop ticket');
  assert.match(typed, /description: field !== 'description' && !editor\.hidden \? area\.value : null/, 'an open edit is kept unless it is what was saved');
  assert.match(typed, /name: field !== 'name' && nameBox && nameBox\.value !== t\.name \? nameBox\.value : null/);
  assert.match(typed, /tag: field === 'tags' \? '' : tagBox\.value/);
  const draw = /\nasync function drawTicket\(id, said = null, kept = null\) \{[\s\S]*?\n\}\n/.exec(app)?.[0] ?? '';
  assert.match(draw, /const panel = wireEditPanel\(t\);\s*if \(kept\) \{[^}]*const keptBox = main\.querySelector\('form\.reply textarea, form\.add-comment textarea'\);\s*if \(keptBox\) keptBox\.value = kept\.reply;\s*panel\?\.restore\(kept\);/);
  assert.match(wire, /restore\(kept\) \{[\s\S]*area\.value = kept\.description;\s*openEditor\(\);/, 'the description edit opens again with its text');
});

test('a save whose redraw fails says what happened instead of sitting on "Saving…"', () => {
  const app = pageScript();
  const wire = /function wireEditPanel\(t\) \{([\s\S]*?)\n\}/.exec(app)?.[1];
  const redraw = wire.slice(wire.indexOf('const redraw ='), wire.indexOf('let saving'));
  assert.match(redraw, /try \{\s*await drawAgain\(\(\) => drawTicket\(t\.id, said, kept\)\);\s*\} catch \(err\) \{/);
  assert.match(redraw, /if \(err instanceof SignedOut\) return drawSignIn\(/);
  assert.match(redraw, /note\.textContent = `The page could not refresh \(\$\{err\.message\}\): \$\{outcome\}\. Reload to see the ticket as stored\.`/);
  assert.match(wire, /`the \$\{field\} was saved`/);
  assert.match(wire, /`the \$\{field\} was not saved`/);
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
    const app = pageScript();
    // Below the section while a loop has it; in his two statuses, in the right column above the ticket (SP-416).
    assert.match(app, /<\/section>\s*\$\{inline \? renderFilesMade\(t\) : ''\}`;/);
    assert.match(app, /\$\{inline \? actions : renderFilesMade\(t\)\}\s*<div class="details">/);
    assert.match(readFileSync(WEB('app.css'), 'utf8'), /\.files-made \{[^}]*background:[^}]*border:/);
  });
});
