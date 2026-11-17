// The tracker page's title row, headings and tabs (docs/UI_DOCTRINE.md
// sections 4 and 5, SP-322): one 24px title per page with its buttons on the
// same row, at most three heading sizes under it, and every switch between
// views of the same thing a tab bar, never a segmented control. This reads
// the stylesheet and the page's own source and names what breaks it, so a
// toolbar drawn on a row of its own under the title fails `npm run verify`,
// on every page but Tasks (SP-362).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { declarationsOf, rootTokens } from './cssTokens.mjs';
import { PAGE_SCRIPTS, RENDER_SCRIPTS, pageScript } from './pageScripts.mjs';

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const CSS = read('./web/app.css');
const SOURCES = { ...Object.fromEntries(PAGE_SCRIPTS.map((name) => [name, read(`./web/${name}`)])), ...Object.fromEntries(RENDER_SCRIPTS.map((name) => [name, read(`./web/${name}`)])) };
const declarations = declarationsOf(CSS);

/** The declarations of the rule whose selector is exactly `selector`, as { property: value }. */
function rule(selector) {
  const found = declarations.filter((d) => d.selector === selector);
  assert.ok(found.length, `app.css has no rule for ${selector}`);
  return Object.fromEntries(found.map((d) => [d.property, d.value]));
}

test('the page title is 24px, weight 800, tight line height (UI_DOCTRINE 4)', () => {
  const h1 = rule('h1');
  assert.equal(h1['font-size'], 'var(--page-title-size)');
  assert.equal(h1['font-weight'], '800');
  assert.equal(h1['line-height'], 'var(--leading-tight)');
  assert.equal(rootTokens(CSS).get('--page-title-size'), 'var(--text-2xl)');
});

test('the title and the toolbar share one row, buttons at the right (UI_DOCTRINE 4)', () => {
  const row = rule('.title-row');
  assert.equal(row.display, 'flex');
  assert.equal(row['justify-content'], 'space-between');
  assert.equal(row['align-items'], 'center');
  assert.equal(rule('.title-row > h1').margin, '0');
  // Every toolbar sits in the title row of the page it is on: its page's
  // <h1> is the row's first child, the toolbar its last. One exception, at
  // Dane's word (SP-362): the Tasks page's toolbar is the row directly under
  // its title row, which holds only the title and the Board / List / Console
  // tabs. Any other toolbar, however it is classed, still counts.
  const loose = [];
  let tasksBars = 0;
  for (const [file, source] of Object.entries(SOURCES)) {
    for (const m of source.matchAll(/<div class="toolbar(?: [\w -]*)?">/g)) {
      if (m[0] === '<div class="toolbar tasks-bar">' && file === 'page-tasks.mjs') {
        const row = source.lastIndexOf('<div class="tasks-head title-row"><h1>Tasks</h1>', m.index);
        const between = source.slice(row, m.index);
        assert.ok(row !== -1 && /^<div class="tasks-head title-row"><h1>Tasks<\/h1>\$\{filed \? filedPod\(filed, uploaded\) : ''\}\$\{viewSwitch\(board\.project, view\)\}<\/div>\s*$/.test(between),
          'the Tasks toolbar sits directly under a title row holding only the title, the Filed pod and the tabs');
        tasksBars += 1;
        continue;
      }
      const h1 = source.lastIndexOf('<h1', m.index);
      const before = source.slice(Math.max(0, h1 - 40), h1);
      if (h1 === -1 || m.index - h1 > 300 || !/class="(?:[\w-]+ )*title-row"/.test(before)) {
        loose.push(`${file}:${source.slice(0, m.index).split('\n').length}`);
      }
    }
  }
  assert.deepEqual(loose, [], 'a toolbar outside a title row');
  assert.equal(tasksBars, 1, 'the Tasks page draws its second row once');
});

test('headings under the title use only the three sizes, none bigger than it (UI_DOCTRINE 4)', () => {
  const allowed = new Set(['var(--text-xl)', 'var(--text-lg)', 'var(--text-base)']);
  assert.equal(rule('h2')['font-size'], 'var(--text-lg)');
  assert.equal(rule('h3, h4, h5, h6')['font-size'], 'var(--text-base)');
  const wrong = declarations
    .filter((d) => d.property === 'font-size' && /(?:^|[\s>+~,])h[2-6](?:$|[\s.:,[])/.test(d.selector))
    .filter((d) => !allowed.has(d.value))
    .map((d) => `${d.selector} { font-size: ${d.value} }`);
  assert.deepEqual(wrong, []);
});

test('Board / List / Console and the Settings tabs are one tab bar (UI_DOCTRINE 5)', () => {
  const bar = rule('nav.tabs');
  assert.equal(bar['border-bottom'], '2px solid var(--border-strong)');
  assert.equal(bar.margin, '0 0 var(--space-5)');
  const tab = rule('nav.tabs a');
  assert.equal(tab.padding, 'var(--space-3) var(--space-5)');
  assert.equal(tab['font-size'], 'var(--text-base)');
  assert.equal(tab['font-weight'], '500');
  assert.equal(tab.color, 'var(--ink-secondary)');
  assert.equal(tab.background, 'transparent');
  const chosen = rule('nav.tabs a[aria-current]');
  assert.equal(chosen.color, 'var(--tab-selected)');
  assert.equal(chosen['font-weight'], '700');
  assert.equal(chosen['border-bottom-color'], 'var(--tab-selected)');
  assert.match(tab['border-bottom'], /^3px solid /, 'a 3px underline');
  assert.equal(rootTokens(CSS).get('--tab-selected'), '#0b82d4');
  // The segmented control is gone, and no page draws one again.
  assert.ok(!declarations.some((d) => /(?:^|[\s,])\.views\b/.test(d.selector)), 'no .views rule left in app.css');
  for (const [file, source] of Object.entries(SOURCES)) {
    assert.doesNotMatch(source, /class="views"/, `${file} draws the old segmented control`);
    for (const m of source.matchAll(/<nav class="tabs[^"]*"([^>]*)>/g)) assert.match(m[1], /aria-label="/, `${file}: a tab bar is named`);
  }
  assert.match(SOURCES['app.mjs'], /<nav class="tabs" aria-label="View">/);
  assert.match(SOURCES['page-settings.mjs'], /<nav class="tabs settings-tabs" aria-label="Settings">/);
  // SP-326: in a title row (the Tasks page's) the bar has no gap under it,
  // and as a flex item its line is only as wide as the tabs. Settings' tabs
  // stay a row of their own, outside any title row.
  assert.equal(rule('.title-row > nav.tabs').margin, '0');
  const page = pageScript();
  const settings = page.indexOf('<nav class="tabs settings-tabs"');
  const rowOpen = page.lastIndexOf('class="title-row"', settings);
  assert.ok(page.indexOf('</div>', rowOpen) < settings, 'the Settings tabs sit under the title row, not in it');
});
