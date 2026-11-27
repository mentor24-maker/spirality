/**
 * Tests for the phone page (/mlist, SP-408): Waiting on You and Tasks one
 * tap apart, and a ticket's ask on the same page. One file per page
 * (SP-352); what pages share is tracker/webTestKit.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, WEB } from './webTestKit.mjs';
import { mlistPlace, mlistHref, openTasks, renderMlist, renderMlistRow, renderMlistTicket, renderQuickAction } from './web/render.mjs';
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
