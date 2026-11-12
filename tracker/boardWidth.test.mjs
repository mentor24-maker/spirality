// SP-214: a project's Board shows all seven working stages side by side,
// with no sideways scrolling at the page's full width. This reads the page's
// own stylesheet and works out the narrowest a board column can be; if seven
// of them and their gaps no longer fit inside the page body, `npm run verify`
// fails instead of the board quietly cutting off its last columns again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS = readFileSync(fileURLToPath(new URL('./web/app.css', import.meta.url)), 'utf8');

/** The working stages that are board columns (Live is the list under the board). */
const WORKING_STAGES = 7;
const REM = 16;

/** The declarations of the one rule whose selector is exactly `selector`, as a Map. */
function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  assert.equal(matches.length, 1, `expected one "${selector} { ... }" rule in tracker/web/app.css, found ${matches.length}`);
  return new Map(matches[0][1].split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const at = d.indexOf(':');
    return [d.slice(0, at).trim(), d.slice(at + 1).trim()];
  }));
}

/** A CSS length in pixels; 0 for an unset or unitless zero. Throws on a unit this test does not know. */
function px(value) {
  if (value === undefined || value === '0' || value === 'auto') return 0;
  const m = /^(-?[\d.]+)(px|rem)$/.exec(value);
  if (!m) throw new Error(`cannot read the length "${value}"`);
  return Number(m[1]) * (m[2] === 'rem' ? REM : 1);
}

/** The four sides of a padding shorthand, as [top, right, bottom, left] in pixels. */
function sides(value) {
  const v = (value ?? '0').split(/\s+/).map(px);
  return [v[0], v[1] ?? v[0], v[2] ?? v[0], v[3] ?? v[1] ?? v[0]];
}

/**
 * The narrowest a column's outer box can be: a column that cannot shrink
 * (flex-shrink 0) is its basis; one that can is its min-width. Padding and the
 * hairline border are added on (the column is content-box sized).
 */
function narrowestColumn(column) {
  const [, shrink = '1', basis = 'auto'] = (column.get('flex') ?? '').split(/\s+/);
  const content = Number(shrink) === 0
    ? Math.max(px(basis === 'auto' ? column.get('width') : basis), px(column.get('min-width')))
    : px(column.get('min-width'));
  const [, right, , left] = sides(column.get('padding'));
  return content + left + right + 2; // --hairline is 1px each side
}

/** The width inside the page body's padding, where the board sits. */
function bodyInnerWidth(main) {
  const [, right, , left] = sides(main.get('padding'));
  return px(main.get('max-width')) - left - right;
}

test('seven board columns and their gaps fit inside the page body at its full width (SP-214)', () => {
  const inner = bodyInnerWidth(rule(CSS, 'main'));
  assert.equal(inner, 1376, 'the page body is 1440px less 2rem padding each side (SP-184)');
  const column = narrowestColumn(rule(CSS, '.column'));
  const gap = px(rule(CSS, '.board').get('gap'));
  const needed = WORKING_STAGES * column + (WORKING_STAGES - 1) * gap;
  assert.ok(needed <= inner,
    `seven board columns need ${needed}px (each at least ${column}px, gaps ${gap}px) but the page body is ${inner}px inside: the board would scroll sideways`);
});

test('board columns share the width equally and still scroll sideways below their floor', () => {
  const column = rule(CSS, '.column');
  const [grow, shrink, basis] = (column.get('flex') ?? '').split(/\s+/);
  assert.ok(Number(grow) > 0 && Number(shrink) > 0, `a column grows and shrinks with the page (flex: ${column.get('flex')})`);
  assert.equal(px(basis), 0, 'every column starts from zero width, so all seven come out the same width');
  assert.ok(px(column.get('min-width')) >= 8 * REM, 'a floor keeps a card readable on a narrow window');
  assert.equal(rule(CSS, '.board').get('overflow-x'), 'auto', 'below the floor the board scrolls sideways, as before');
});

test('the width check reads a fixed-width column as too wide (the board before SP-214)', () => {
  const before = new Map([['flex', '0 0 15rem'], ['padding', '0.5rem']]);
  assert.equal(narrowestColumn(before), 15 * REM + 16 + 2);
  assert.ok(WORKING_STAGES * narrowestColumn(before) + 6 * 12 > 1376);
});
