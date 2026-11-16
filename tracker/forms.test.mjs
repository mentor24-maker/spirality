// The tracker page's forms follow docs/UI_DOCTRINE.md section 6 (SP-325):
// every box has a permanent label, the text inside an empty box is an
// example and never the instruction, and the box style and widths come from
// the tokens. This reads the page's own source, so a new unlabelled box, or
// a box that is full width because the form is wide, fails `npm run verify`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const SOURCES = ['./web/app.mjs', './web/render.mjs', './web/index.html'];

/** Every box in `source`: its tag, its attributes and where it starts. Hidden fields are not boxes. */
function boxesOf(source) {
  return [...source.matchAll(/<(input|select|textarea)\b([^>]*)>/g)]
    .map((m) => ({ tag: m[1], attrs: m[2], at: m.index }))
    .filter((b) => !/\btype="hidden"/.test(b.attrs));
}

/**
 * Why the box has no label, or null when it has one: a `<label for>` naming
 * its id, a `<label>` wrapped round it, or an aria-label / aria-labelledby.
 * A box inside a table row may lean on aria-label, its column heading
 * naming it to the eye.
 */
function labelProblem(source, box) {
  if (/\baria-label(?:ledby)?="/.test(box.attrs)) return null;
  const before = source.slice(0, box.at);
  if (before.lastIndexOf('<label') > before.lastIndexOf('</label>')) return null;
  const id = box.attrs.match(/\bid="([^"]+)"/)?.[1];
  if (id && source.includes(`for="${id}"`)) return null;
  return id ? `no <label for="${id}">` : 'no id, no wrapping <label> and no aria-label';
}

/** Words that make an empty box's text an instruction ("Add a tag, then Enter", "Search every task"). */
const INSTRUCTION = /^(?:add|type|search|find|enter|pick|choose|write|new|select)\b|\bthen enter\b/i;

test('every box on the page has a permanent label (docs/UI_DOCTRINE.md section 6)', () => {
  const problems = [];
  let seen = 0;
  for (const path of SOURCES) {
    const source = read(path);
    for (const box of boxesOf(source)) {
      seen += 1;
      const why = labelProblem(source, box);
      if (why) problems.push(`${path}: <${box.tag}${box.attrs.slice(0, 80)}…>: ${why}`);
    }
  }
  assert.ok(seen > 30, `only ${seen} boxes found: the pattern in boxesOf no longer matches the page's source`);
  assert.deepEqual(problems, [], 'see docs/UI_DOCTRINE.md, "Forms"');
});

test('the text inside an empty box is an example, never the instruction (docs/UI_DOCTRINE.md section 6)', () => {
  const problems = [];
  for (const path of SOURCES) {
    for (const m of read(path).matchAll(/\bplaceholder="([^"$]+)"/g)) {
      if (INSTRUCTION.test(m[1])) problems.push(`${path}: placeholder "${m[1]}" tells the reader what to do; say it in the label or a hint, and show an example`);
    }
  }
  assert.deepEqual(problems, []);
});

test('no box is full width because the form is wide: boxes take the width tokens (docs/UI_DOCTRINE.md section 6)', () => {
  const css = read('./web/app.css');
  for (const token of ['--field-w-number', '--field-w-short', '--field-w-long', '--field-pad-y']) {
    assert.match(css.slice(0, css.indexOf('}')), new RegExp(`${token}:`), `${token} is defined in :root`);
  }
  // A rule whose selector ends at a box and sets width: 100% is the old full-width form. A box in a table cell
  // fills its column, which the table's own widths size, so td rules are allowed.
  const problems = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (!/(?:^|;)\s*width:\s*100%/.test(m[2])) continue;
    for (const sel of selectors) {
      if (/(?:^|[\s>])(?:input|select|textarea)\b[^\s>]*$|#[\w-]*search$/.test(sel) && !/\btd\b/.test(sel)) problems.push(sel);
    }
  }
  assert.deepEqual(problems, [], 'size a box with --field-w-number, --field-w-short or --field-w-long');
});

test('the label check: a box needs a label for it, a label round it or an aria-label', () => {
  const src = '<label for="a">A</label><input id="a"><label>B <select></select></label><input aria-label="C"><textarea id="d"></textarea><input>';
  const why = boxesOf(src).map((b) => labelProblem(src, b));
  assert.deepEqual(why, [null, null, null, 'no <label for="d">', 'no id, no wrapping <label> and no aria-label']);
  assert.ok(INSTRUCTION.test('Add a tag, then Enter'));
  assert.ok(INSTRUCTION.test('Search every task'));
  assert.ok(!INSTRUCTION.test('their@email.com'));
  assert.ok(!INSTRUCTION.test('docs'));
});

test('forms whose own layout rules were removed are .fields forms, and a locked box looks locked (SP-325 review)', () => {
  const page = SOURCES.map(read).join('\n');
  // Add Topic and Add a Member lost their own label and row rules in SP-325, so the .fields grid lays them out.
  assert.match(page, /<form class="create-topic fields">/);
  assert.match(page, /<form class="invite members fields">/);
  const css = read('./web/app.css');
  // Slug and Ticket Prefix on Edit Project are disabled: muted like a read-only box, never the white typing box.
  assert.match(css, /:is\(input, select, textarea\):is\(\[readonly\], :disabled\) \{[^}]*background: var\(--bg-hover\)/);
  // Keyboard focus shows the focus ring, not only the border a click gives.
  assert.match(css, /:is\(input, select, textarea\):focus-visible \{[^}]*var\(--focus-ring-color\)/);
  // The Reporting custom range's date boxes keep their own width, so the counts table does not widen.
  assert.match(css, /table\.counts th\.custom-range :is\(input, select\) \{[^}]*width: auto;/);
});
