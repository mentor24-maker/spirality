/**
 * Tests for the phone page (/mlist, SP-408): Waiting on You and Tasks one
 * tap apart, and a ticket's ask on the same page, answered with buttons and
 * a dropdown (SP-409). One file per page
 * (SP-352); what pages share is tracker/webTestKit.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, WEB } from './webTestKit.mjs';
import { mlistPlace, mlistHref, openTasks, renderMlist, renderMlistRow, renderMlistTicket, renderQuickAction, mlistAnswer, renderMlistAnswer, askOptions, shownAsk, offersGo, renderGoAction } from './web/render.mjs';
import operatorCard from '../lib/operatorCard.js';
import { pageScript } from './pageScripts.mjs';
import { declarationsOf, rootTokens } from './cssTokens.mjs';

const CSS = readFileSync(WEB('app.css'), 'utf8');
const rule = (selector) => Object.fromEntries(declarationsOf(CSS).filter((d) => d.selector === selector).map((d) => [d.property, d.value]));

test('/mlist is served as the page and drawn by drawMlist, the phone layout on only there', async () => {
  const app = pageScript();
  assert.match(app, /phoneLayout\(location\.pathname === '\/mlist'\);\s*try \{\s*if \(location\.pathname === '\/set-password'\)/, 'every page sets the layout before anything draws, the sign-in form included, so leaving /mlist turns it off');
  assert.match(app, /const mlist = location\.pathname === '\/mlist';/);
  assert.match(app, /if \(mlist\) \{\s*await drawMlist\(\);/);
  assert.match(app, /const waiting = !\(mlist \|\|/, '/mlist is not the home page');
  assert.match(app, /isNew \|\| waiting \|\| mlist \? \{ address: here\(\), reads \}/, 'it keeps itself current like Waiting on You');
  assert.match(app, /history\.pushState\(null, '', a\.pathname \+ a\.search \+ a\.hash\);/, 'a link inside the page keeps its ?view=');
  const f = await fixture();
  try {
    for (const path of ['/mlist', '/mlist?view=tasks', '/mlist?view=tasks&ticket=AL-1']) {
      const page = await f.call('GET', path, { token: null });
      assert.equal(page.status, 200, path);
      assert.match(page.text, /<main id="main">/, path);
    }
  } finally { await f.cleanup(); }
});

test('the address holds where he is: Waiting on You by default, Tasks as ?view=tasks, a ticket as &ticket=', () => {
  assert.deepEqual(mlistPlace(''), { view: 'waiting', ticket: null });
  assert.deepEqual(mlistPlace('?view=tasks'), { view: 'tasks', ticket: null });
  assert.deepEqual(mlistPlace('?view=nonsense&ticket=%20'), { view: 'waiting', ticket: null });
  assert.deepEqual(mlistPlace('?view=tasks&ticket=SP-12'), { view: 'tasks', ticket: 'SP-12' });
  assert.equal(mlistHref({ view: 'waiting' }), '/mlist');
  assert.equal(mlistHref({ view: 'tasks' }), '/mlist?view=tasks');
  assert.equal(mlistHref({ view: 'waiting', ticket: 'AL-1' }), '/mlist?ticket=AL-1');
  assert.equal(mlistHref({ view: 'tasks', ticket: 'A&B' }), '/mlist?view=tasks&ticket=A%26B');
});

test('the toggle: two big buttons, the list showing marked as the main action, each a link that keeps its view', () => {
  const waiting = renderMlist({ view: 'waiting', waiting: [] });
  assert.match(waiting, /<a class="btn btn-primary" href="\/mlist" aria-current="page">Waiting on You<\/a><a class="btn" href="\/mlist\?view=tasks">Tasks<\/a>/);
  assert.match(waiting, /Nothing is waiting on you\./);
  const tasks = renderMlist({ view: 'tasks', tasks: [] });
  assert.match(tasks, /<a class="btn" href="\/mlist">Waiting on You<\/a><a class="btn btn-primary" href="\/mlist\?view=tasks" aria-current="page">Tasks<\/a>/);
  assert.match(tasks, /No tickets are open right now\./);
  assert.doesNotMatch(waiting + tasks, /style="/, 'no inline styles: the page\'s security rule drops them');
});

test('a row is one line: id, name and status, every word escaped, the whole row a link to its ask in the same list', () => {
  const html = renderMlistRow({ id: 'AL-1', name: 'Fix <b>this</b>', status: 'needs your input' }, 'tasks');
  assert.equal(html, '<li><a class="mlist-row" href="/mlist?view=tasks&amp;ticket=AL-1"><span class="mlist-id">AL-1</span>'
    + '<span class="mlist-name">Fix &lt;b&gt;this&lt;/b&gt;</span><span class="mlist-status">Needs your input</span></a></li>');
});

test('Waiting on You is the home page\'s list, and Tasks every open ticket on his boards, Live left out', async () => {
  const f = await fixture();
  try {
    const { waiting, unsure } = (await f.call('GET', '/waiting')).body;
    const html = renderMlist({ view: 'waiting', waiting, unsure });
    assert.ok(waiting.length > 0);
    for (const t of waiting) assert.ok(html.includes(`href="/mlist?ticket=${t.id}"`), t.id);

    const { projects } = (await f.call('GET', '/projects')).body;
    const boards = await Promise.all(projects.map(async (p) => (await f.call('GET', `/projects/${p.slug}/board`)).body));
    const open = openTasks(boards);
    const every = boards.flatMap((b) => b.columns.flatMap((c) => c.tickets.map((t) => ({ id: t.id, status: c.status }))));
    assert.ok(every.some((t) => t.status === 'Live'), 'the demo data has Live tickets to leave out');
    assert.deepEqual(open.map((t) => t.id), every.filter((t) => t.status !== 'Live').map((t) => t.id));
    const tasks = renderMlist({ view: 'tasks', tasks: open });
    for (const t of open) assert.ok(tasks.includes(`href="/mlist?view=tasks&amp;ticket=${t.id}"`), t.id);
  } finally { await f.cleanup(); }
});

test('a ticket opens on the page with Back to the same list, Open Full Page, and the ticket page\'s own ask', async () => {
  const f = await fixture();
  try {
    const t = (await f.call('GET', '/tickets/AL-1/thread')).body;
    const html = renderMlistTicket(t, 'tasks');
    assert.match(html, /<a class="btn" href="\/mlist\?view=tasks">Back<\/a><a class="btn" href="\/t\/AL-1">Open Full Page<\/a>/);
    assert.ok(html.includes(renderQuickAction(t)), 'the same title, status and ask as the ticket page');
    assert.match(html, /class="needed"/, 'his ask in red');
    assert.match(renderMlistTicket(t, 'waiting'), /<a class="btn" href="\/mlist">Back<\/a>/);
  } finally { await f.cleanup(); }
});

test('the phone layout: 44 px tap targets through the button height token, the header stripped down, nothing wider than the window', () => {
  assert.equal(rootTokens(CSS).get('--tap-target'), '44px');
  assert.equal(rule('body.mlist-page')['--btn-height'], 'var(--tap-target)', 'buttons keep their kind and grow');
  assert.equal(rule('body.mlist-page')['overflow-x'], 'hidden');
  assert.equal(rule('.mlist-row')['min-height'], 'var(--tap-target)');
  assert.equal(rule('.mlist-name')['text-overflow'], 'ellipsis', 'a long name ends in … rather than pushing the row wider');
  assert.equal(rule('body.mlist-page header nav.site, body.mlist-page header .health, body.mlist-page header #project, body.mlist-page header #bus').display, 'none');
  assert.equal(rule('.quick.mlist-ticket')['grid-template-columns'], 'minmax(0, 1fr)', 'one column, not the ticket page\'s two');
  // Only the phone page changes: no rule outside body.mlist-page sets the button height.
  const height = declarationsOf(CSS).filter((d) => d.property === '--btn-height').map((d) => d.selector);
  assert.deepEqual(height, [':root', 'body.mlist-page']);
});

// SP-409: answering from the phone page.
const PHRASES = { mergePhrase: 'merge', closePhrase: 'close', goPhrase: 'go' };
const CONTEXT = 'The phone page answers a card with a tap. This card is here to test it: its ask offers lettered options, '
  + 'and the page must draw them as one dropdown with a Send button and never ask for a typed letter by default. '
  + 'Nothing else about the card changes, and the reply goes through the same route the ticket page uses for every other answer.';
const cardOf = (needed) => operatorCard.buildCard(['@@ASKED', 'answer from my phone', '@@CONTEXT', CONTEXT, '@@NEEDED', ...needed].join('\n')).rendered;
const asking = (needed, extra = {}) => ({ id: 'AL-9', name: 'A question', status: 'Needs your input', ...PHRASES, comments: [{ body: cardOf(needed) }], ...extra });
/** The ticket of the demo data with this name, read through the server as the page reads it. */
const threadNamed = async (f, name) => {
  const { projects } = (await f.call('GET', '/projects')).body;
  for (const p of projects) {
    const board = (await f.call('GET', `/projects/${p.slug}/board`)).body;
    const t = board.columns.flatMap((c) => c.tickets).find((x) => x.name === name);
    if (t) return (await f.call('GET', `/tickets/${t.id}/thread`)).body;
  }
  throw new Error(`no demo ticket named ${name}`);
};
const newestComment = async (f, id) => (await f.call('GET', `/tickets/${id}/thread`)).body.comments.at(-1).body;

test('three lettered options: one dropdown listing each by letter and words, a Send button, and no text box until Something Else is opened', () => {
  const t = asking(['Options: A) keep it as it is. B) the smaller one. C) the bigger one.', 'Your move: Reply A, B or C.']);
  assert.deepEqual(askOptions(shownAsk(t)).map((o) => o.letter), ['A', 'B', 'C']);
  assert.equal(mlistAnswer(t).kind, 'pick');
  const html = renderMlistAnswer(t);
  assert.equal((html.match(/<select /g) ?? []).length, 1);
  assert.match(html, /<option value="A">A\) keep it as it is\.<\/option><option value="B">B\) the smaller one\.<\/option><option value="C">C\) the bigger one\.<\/option><\/select><button type="submit" class="btn btn-primary">Send<\/button>/);
  const [beforeFold] = html.split('<details');
  assert.doesNotMatch(beforeFold, /<input|<textarea/, 'buttons and a dropdown only, by default');
  assert.match(html, /<details class="mlist-other"><summary class="btn">Something Else<\/summary><form class="mlist-answer mlist-text"><label for="mlist-text">Your Reply<\/label><input id="mlist-text" type="text" required/);
  assert.doesNotMatch(html, /<details[^>]* open/, 'Something Else starts folded');
  assert.ok(renderMlistTicket(t, 'waiting').includes(html), 'drawn under the ask');
  assert.doesNotMatch(html, /style="|class="note/, 'no inline styles, and no note beside a button (UI_DOCTRINE 7)');
  // Options written one per line read the same; a lone "A)" is no list.
  assert.deepEqual(askOptions('A) one\nB) two').map((o) => o.words), ['one', 'two']);
  assert.deepEqual(askOptions('Pick plan A) now.'), []);
});

test('a Reply with no options is a Go button posting the go word; Merge and Close post the ticket page\'s words', () => {
  const go = asking(['Reply "go" to queue it as written, or reply with what to change.', 'Your move: Reply: "go", or what to change.']);
  assert.deepEqual(mlistAnswer(go), { kind: 'go-button', word: 'go', options: [] });
  assert.match(renderMlistAnswer(go), /^<div class="mlist-answers"><form class="mlist-answer mlist-go-button"><button type="submit" class="btn btn-primary">Go<\/button><\/form><details/);
  const close = asking(['Nothing to merge: PR #7 has already landed.', 'Your move: Close: its work is live.'], { status: 'Ready to launch' });
  assert.deepEqual(mlistAnswer(close), { kind: 'close-button', word: 'close', options: [] });
  assert.match(renderMlistAnswer(close), /<form class="mlist-answer mlist-close-button"><button type="submit" class="btn btn-primary">Close<\/button><\/form>/);
  const merge = asking(['Review passed.', 'Your move: Merge, once you have looked.'], { status: 'Ready to launch', pullRequest: 'https://github.com/o/r/pull/3' });
  assert.deepEqual(mlistAnswer(merge), { kind: 'merge-button', word: 'merge', options: [] });
  assert.match(renderMlistAnswer(merge), /<form class="mlist-answer mlist-merge-button"><button type="submit" class="btn btn-primary">Merge<\/button><\/form>/);
  // Nothing to answer: not his status, or his answer already in.
  assert.equal(renderMlistAnswer({ ...go, status: 'Queued' }), '');
  assert.equal(renderMlistAnswer({ ...go, answerIn: true }), '');
  assert.equal(renderMlistAnswer({ ...merge, mergeStands: true }), '');
});

test('a Reply that asks A or B inline is a dropdown, and Go is offered only where the ticket page offers it', () => {
  // The demo's AL-1 wording: an A-or-B question, never a one-tap "go".
  const inline = asking(['Reply A (the Mini) or B (a hosted server).', 'Your move: Reply — A or B.']);
  assert.deepEqual(mlistAnswer(inline), { kind: 'pick', word: null, options: [{ letter: 'A', words: 'the Mini' }, { letter: 'B', words: 'a hosted server' }] });
  const html = renderMlistAnswer(inline);
  assert.doesNotMatch(html, /mlist-go-button|>Go</, 'no Go button on an A-or-B question');
  assert.match(html, /<option value="A">A\) the Mini<\/option><option value="B">B\) a hosted server<\/option><\/select>/);
  // A Reply card whose ask quotes no go word: only the Something Else box, as the ticket page offers no Go.
  const open = asking(['Tell me which folder the logs should go in.', 'Your move: Reply with the folder.']);
  assert.equal(offersGo(open), false);
  assert.equal(renderGoAction(open), '');
  assert.deepEqual(mlistAnswer(open), { kind: 'other', word: null, options: [] });
  assert.doesNotMatch(renderMlistAnswer(open), /mlist-go-button/);
  // Go is the ticket page's own rule: Needs your input only, and the word quoted.
  const go = asking(['Reply "go" to queue it as written, or reply with what to change.', 'Your move: Reply: "go", or what to change.']);
  assert.equal(offersGo(go), true);
  assert.match(renderGoAction(go), /go-action/);
  assert.equal(mlistAnswer({ ...go, status: 'Ready to launch' }).kind, 'other', 'no Go in Ready to launch, as on the ticket page');
  // Inline choices must run A, B… in order; a lone one or code is no list.
  assert.deepEqual(askOptions('Plan A (the cheap one) only.'), []);
  assert.deepEqual(askOptions('Run `A (x) or B (y)` first.'), []);
  assert.deepEqual(askOptions('A (one), B (two) or C (three).').map((o) => o.letter), ['A', 'B', 'C']);
});

test('each control posts what he would have typed through the comments route, and the answered ticket leaves Waiting on You', async () => {
  const f = await fixture(PHRASES);
  try {
    const pick = await threadNamed(f, 'Move WaveCenter to the tracker: pick when');
    assert.deepEqual(mlistAnswer(pick).options.map((o) => o.letter), ['A', 'B']);
    assert.equal((await f.call('POST', `/tickets/${pick.id}/comments`, { body: { body: 'B' } })).status, 201);
    assert.equal(await newestComment(f, pick.id), 'B');
    const waiting = (await f.call('GET', '/waiting')).body.waiting.map((t) => t.id);
    assert.ok(!waiting.includes(pick.id), 'answered, so off Waiting on You');
    assert.equal(renderMlistAnswer((await f.call('GET', `/tickets/${pick.id}/thread`)).body), '', 'and nothing to answer again');

    const al1 = await threadNamed(f, 'The tracker has nowhere to run: choose where it lives');
    assert.equal(mlistAnswer(al1).kind, 'pick', 'the demo\'s A-or-B card is a dropdown, never a Go button');
    assert.deepEqual(mlistAnswer(al1).options.map((o) => o.letter), ['A', 'B']);

    const intake = await threadNamed(f, 'A request written up as a spec, waiting for your go');
    const go = mlistAnswer(intake);
    assert.equal(go.kind, 'go-button');
    await f.call('POST', `/tickets/${intake.id}/comments`, { body: { body: go.word } });
    assert.equal(await newestComment(f, intake.id), 'go');

    const review = await threadNamed(f, 'Descriptions with HTML break the page: show them as text');
    assert.equal(mlistAnswer(review).word, review.mergePhrase, 'the same word the ticket page\'s Merge posts');
    assert.match(renderMlistAnswer(review), /mlist-merge-button/);

    const unstuck = await threadNamed(f, 'Find out why PR #7 (conflict-fix) will not merge');
    assert.equal(mlistAnswer(unstuck).word, unstuck.closePhrase);
  } finally { await f.cleanup(); }
});

test('the page posts through the comments route, says a failed send in red in the strip and stays, and on success goes back to the list read again', () => {
  const page = readFileSync(WEB('page-mlist.mjs'), 'utf8');
  assert.match(page, /main\.innerHTML = renderMlistTicket\(thread, view\);\s*wireAnswers\(thread, view\);/);
  assert.match(page, /await api\('POST', `\/tickets\/\$\{encodeURIComponent\(ticket\.id\)\}\/comments`, \{ body \}\);/);
  assert.match(page, /catch \(err\) \{[\s\S]*?for \(const b of buttons\) b\.disabled = false;\s*return showMessage\(\{ kind: 'error', text: `Not posted: \$\{err\.message\}` \}\);\s*\}/, 'a failure is said in red and returns before the page moves');
  assert.match(page, /history\.pushState\(null, '', mlistHref\(\{ view \}\)\);\s*await route\(\);\s*showMessage\(\{ kind: 'success'/);
  assert.match(page, /questions = \{ 'merge-button': mergeQuestion\(ticket\), 'close-button': closeQuestion\(ticket\), 'go-button': goQuestion\(ticket\) \}/, 'the ticket page\'s own questions before a merge, close or go');
});

test('the answer controls are a thumb tall and one column', () => {
  assert.equal(rule('.mlist-answers')['flex-direction'], 'column');
  assert.equal(rule('.mlist-answer select, .mlist-answer input')['min-height'], 'var(--tap-target)');
});
