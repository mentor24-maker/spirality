// The tracker page's tables and dialogs follow StarCaster's look (docs/UI_DOCTRINE.md
// sections 8 and 9, SP-324). Tables: one heading look, black with bold white
// text, and every table with headings in a .table-wrap that keeps its heading
// row in sight while the rows scroll. Dialogs: as wide as what is in them,
// above a floor and below three quarters of the screen, never a bare width
// (StarCaster's UI_RULES D7, its checkDialogWidths). This reads the stylesheet
// and the page's source and names each place that breaks it, so a dialog
// given `max-width: 28rem` again fails `npm run verify`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { declarationsOf, resolveColour } from './cssTokens.mjs';

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const CSS = read('./web/app.css');
const SOURCES = { 'tracker/web/app.mjs': read('./web/app.mjs'), 'tracker/web/render.mjs': read('./web/render.mjs') };
const DECLS = declarationsOf(CSS).filter((d) => d.selector !== ':root');

/** The value of `property` in the one rule whose selector is exactly `selector`, or undefined. */
const valueOf = (selector, property) => DECLS.find((d) => d.selector === selector && d.property === property)?.value;

/** Each `<table ...>` in the page's source with what sits just before it and what it holds. */
function tables() {
  const found = [];
  for (const [file, src] of Object.entries(SOURCES)) {
    for (const m of src.matchAll(/<table\b[^>]*>/g)) {
      const end = src.indexOf('</table>', m.index);
      found.push({ file, tag: m[0], before: src.slice(Math.max(0, m.index - 40), m.index), inner: src.slice(m.index, end), after: src.slice(end, end + 20) });
    }
  }
  return found;
}

test('the page source was read: a broken search must not pass the checks by finding nothing', () => {
  assert.ok(tables().length >= 20, `found only ${tables().length} tables`);
  assert.ok(DECLS.some((d) => d.selector.startsWith('dialog')), 'no dialog rules found');
});

test('every table with a heading row sits directly inside a .table-wrap (UI_DOCTRINE 8)', () => {
  const bare = tables().filter((t) => t.inner.includes('<thead'))
    .filter((t) => !t.before.endsWith('<div class="table-wrap">') || !t.after.startsWith('</table></div>'));
  assert.deepEqual(bare.map((t) => `${t.file}: ${t.tag}`), [], 'wrap each in <div class="table-wrap">…</div>');
});

test('the heading row is black with bold white text, the filter row light blue, and both from tokens (UI_DOCTRINE 8)', () => {
  const head = 'thead tr:not(.table-filter-row) th';
  assert.equal(resolveColour(CSS, valueOf(head, 'background')), '#000000');
  assert.equal(resolveColour(CSS, valueOf(head, 'color')), '#ffffff');
  assert.equal(valueOf(head, 'font-weight'), '700');
  const filter = 'thead tr.table-filter-row th';
  assert.equal(resolveColour(CSS, valueOf(filter, 'background')), '#b8e0ff');
  assert.equal(resolveColour(CSS, valueOf(filter, 'color')), '#0b3d7a');
  assert.equal(valueOf('thead th', 'padding-top'), 'calc(0.65rem - 2px)');
  assert.match(valueOf('th, td', 'padding') ?? '', /^0\.5rem 0\.85rem$/, 'body rows are 0.5rem top and bottom');
  // No later rule paints a heading cell another colour: the black row is every table's.
  const repainted = DECLS.filter((d) => /\bth\b/.test(d.selector) && !d.selector.startsWith('thead') && /^(?:color|background(?:-color)?)$/.test(d.property))
    .filter((d) => !/th\[scope="row"\]/.test(d.selector));
  assert.deepEqual(repainted.map((d) => `${d.selector} { ${d.property}: ${d.value} }`), []);
});

test('the wrap scrolls both ways, stops short of the screen, and keeps the heading row fixed at its top (UI_DOCTRINE 8)', () => {
  assert.equal(valueOf('.table-wrap', 'overflow'), 'auto');
  assert.equal(valueOf('.table-wrap', 'max-height'), 'max(20rem, calc(100vh - 10rem))');
  assert.equal(valueOf('.table-wrap', 'border-radius'), 'var(--radius-input)');
  const sticky = '.table-wrap > table thead tr:not(.table-filter-row) th';
  assert.equal(valueOf(sticky, 'position'), 'sticky');
  assert.equal(valueOf(sticky, 'top'), '0');
  // A clipping ancestor between the wrap and its heading would become the heading's scroll box and unstick it.
  const clipped = DECLS.filter((d) => /^table(?:[.\s]|$)/.test(d.selector) && d.property === 'overflow');
  assert.deepEqual(clipped.map((d) => d.selector), []);
});

test('sorting stays a button in the heading cell, with aria-sort: the one recorded exception (UI_DOCTRINE 8)', () => {
  const render = SOURCES['tracker/web/render.mjs'];
  assert.match(render, /return `<th class="\$\{key\}"\$\{on \? ` aria-sort=/, 'the sorted heading cell carries aria-sort');
  assert.match(render, /<button type="button" class="sort"/);
  assert.equal(valueOf('thead th button.sort', 'color'), 'inherit', 'the button takes the heading\'s white');
});

const D7_WIDTH = /^min\(75vw, 100%\)$/;
const D7_FLOOR = /^min\(\d+px, 100%\)$/;

test('a dialog is as wide as what is in it, above a floor and below 75% of the screen (UI_DOCTRINE 9)', () => {
  assert.equal(valueOf('dialog', 'width'), 'max-content');
  assert.match(valueOf('dialog', 'max-width') ?? '', D7_WIDTH);
  assert.match(valueOf('dialog', 'min-width') ?? '', D7_FLOOR);
  const shells = DECLS.filter((d) => /^dialog(?:\.[\w-]+)*$/.test(d.selector));
  const capped = shells.filter((d) => d.selector !== 'dialog')
    .filter((d) => d.property === 'width' || d.property === 'max-width' || (d.property === 'min-width' && !D7_FLOOR.test(d.value)));
  assert.deepEqual(capped.map((d) => `${d.selector} { ${d.property}: ${d.value} }`), [],
    'a dialog may set only a floor, min-width: min(<n>px, 100%); the shared dialog rule owns its width');
});

test('text inside a dialog is no wider than 56ch (UI_DOCTRINE 9)', () => {
  assert.equal(valueOf('dialog p, dialog li', 'max-width'), '56ch');
});

test('every dialog on the page has a rule of its own with a floor (UI_DOCTRINE 9)', () => {
  const classes = Object.values(SOURCES).flatMap((src) => [...src.matchAll(/<dialog class="([\w-]+)"/g)].map((m) => m[1]));
  assert.ok(classes.length >= 4, `found only ${classes.length} dialogs`);
  const floorless = classes.filter((c) => !D7_FLOOR.test(valueOf(`dialog.${c}`, 'min-width') ?? ''));
  assert.deepEqual(floorless, [], 'give each dialog a min-width: min(<n>px, 100%) floor that fits what it holds');
});
