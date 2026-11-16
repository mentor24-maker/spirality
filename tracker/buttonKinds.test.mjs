// Every button on the tracker page is one of StarCaster's four kinds, in one
// of two sizes (docs/UI_DOCTRINE.md section 3, SP-321): `btn` (secondary),
// `btn btn-primary` (the main action), `btn btn-save` (every Save) or
// `btn btn-danger` (anything that removes), `btn-sm` inside a table row. A
// button never sets its own height, padding or colour. This reads the page's
// source and its stylesheet and names each button or rule that breaks it, so
// a new bare `<button>` fails `npm run verify` instead of reaching the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { declarationsOf, rootTokens } from './cssTokens.mjs';

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const SOURCES = ['./web/app.mjs', './web/render.mjs', './web/index.html'];
const CSS = read('./web/app.css');

/**
 * The buttons that are not one of the four kinds, by their class, and why
 * (UI_DOCTRINE section 3, "Not a kind"). Each draws itself in its own rule.
 */
export const EXCEPTIONS = Object.freeze({
  action: 'an icon button in a table row (Edit, Delete, …)',
  'status-info': 'the "i" icon beside a ticket\'s status',
  'suggestion-info-open': 'the "i" icon beside a suggested task',
  'drag-handle': 'the grip that drags a suggested task into order',
  'remove-tag': 'the small × on a tag or topic chip',
  close: 'the × in a dialog\'s corner',
  sort: 'a table heading that sorts its column',
  link: 'a button written as a link in a sentence ("Forgot Password?")',
  'feature-pick': 'a Console tile\'s feature chip, a filter that toggles',
  'pipeline-pod': 'the Pipeline Status pod in the Tasks toolbar, a card that opens a dialog',
});

const KINDS = ['btn-primary', 'btn-save', 'btn-danger'];
const SIZES = ['btn-sm'];

/** The classes of an opening tag, or [] when it has none. */
const classesOf = (tag) => (/\bclass="([^"]*)"/.exec(tag)?.[1] ?? '').split(/\s+/).filter(Boolean);

/** What is wrong with one opening `<button …>` tag, or null when it is a kind or a listed exception. */
export function buttonProblem(tag) {
  const classes = classesOf(tag);
  if (classes.some((c) => c in EXCEPTIONS)) {
    return classes.includes('btn') ? 'is a listed exception and a kind at once' : null;
  }
  if (!classes.includes('btn')) return 'has no kind: add class="btn" (and btn-primary, btn-save or btn-danger for a filled one)';
  const kinds = classes.filter((c) => KINDS.includes(c));
  if (kinds.length > 1) return `has two kinds (${kinds.join(', ')})`;
  const unknown = classes.filter((c) => c.startsWith('btn-') && !KINDS.includes(c) && !SIZES.includes(c));
  if (unknown.length) return `has a kind UI_DOCTRINE section 3 does not list (${unknown.join(', ')})`;
  if (/\bstyle="/.test(tag)) return 'sets its own style';
  return null;
}

/** Every opening button tag in the page's source, as { file, line, tag }. */
function buttonsInSource() {
  const found = [];
  for (const file of SOURCES) {
    const text = read(file);
    for (const m of text.matchAll(/<button\b[^>]*>/g)) {
      found.push({ file, line: text.slice(0, m.index).split('\n').length, tag: m[0] });
    }
  }
  return found;
}

test('the button finder sees the page: a broken pattern must not pass by finding nothing', () => {
  const buttons = buttonsInSource();
  assert.ok(buttons.length > 50, `only ${buttons.length} buttons found in ${SOURCES.join(', ')}`);
  for (const file of SOURCES) assert.doesNotMatch(read(file), /createElement\(['"]button['"]\)/, `${file} builds a button the finder cannot read`);
});

test('every button on the page carries a kind, or is a listed exception (UI_DOCTRINE 3)', () => {
  const wrong = buttonsInSource()
    .map((b) => ({ ...b, problem: buttonProblem(b.tag) }))
    .filter((b) => b.problem)
    .map((b) => `${b.file}:${b.line} ${b.tag} ${b.problem}`);
  assert.deepEqual(wrong, []);
});

test('every link drawn as a button carries a kind too', () => {
  const wrong = [];
  for (const file of SOURCES) {
    for (const m of read(file).matchAll(/<a\b[^>]*\bclass="([^"]*)"[^>]*>/g)) {
      const classes = m[1].split(/\s+/);
      if ((classes.includes('button') || classes.some((c) => c.startsWith('btn'))) && !classes.includes('btn')) wrong.push(`${file}: ${m[0]}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('the check itself: a bare button, two kinds, an unknown kind and an exception with a kind are refused', () => {
  assert.match(buttonProblem('<button type="submit">'), /no kind/);
  assert.match(buttonProblem('<button type="submit" class="note">'), /no kind/);
  assert.match(buttonProblem('<button class="btn btn-save btn-danger">'), /two kinds/);
  assert.match(buttonProblem('<button class="btn btn-green">'), /does not list/);
  assert.match(buttonProblem('<button class="btn close">'), /exception and a kind/);
  assert.match(buttonProblem('<button class="btn" style="color: red">'), /own style/);
  for (const ok of ['<button class="btn">', '<button class="btn btn-primary">', '<button class="btn btn-save btn-sm">', '<button class="btn btn-danger remove-doc" data-x="1">', '<button type="submit" class="close" aria-label="Close">']) {
    assert.equal(buttonProblem(ok), null, ok);
  }
});

/** The declarations of the rule whose selector is exactly `selector`, as a property → value map. */
function rule(selector) {
  const found = declarationsOf(CSS).filter((d) => d.selector === selector);
  assert.ok(found.length, `no rule for ${selector}`);
  return Object.fromEntries(found.map((d) => [d.property, d.value]));
}

test('the four kinds and two sizes are drawn as UI_DOCTRINE section 3 lists them', () => {
  const tokens = rootTokens(CSS);
  assert.equal(tokens.get('--btn-height'), '32px');
  assert.equal(tokens.get('--btn-height-sm'), '24px');
  const fills = {
    '--btn-blue': '#0000cc', '--btn-blue-hover': '#0000a3', '--btn-blue-disabled': '#aaaacc',
    '--btn-green': '#00cc00', '--btn-green-hover': '#00a300', '--btn-green-disabled': '#aaccaa',
    '--btn-danger-flat': '#cc0000', '--btn-danger-flat-hover': '#a30000', '--btn-danger-flat-disabled': '#ccaaaa',
    '--btn-flat-ink': '#ffffff',
  };
  for (const [name, value] of Object.entries(fills)) assert.equal(tokens.get(name), value, name);

  const base = rule('.btn');
  for (const [p, v] of Object.entries({
    height: 'var(--btn-height)', padding: '0 0.875rem', border: '1px solid var(--border-strong)',
    'border-radius': 'var(--radius-btn)', background: 'var(--bg-surface)', color: 'var(--ink-primary)',
    'font-size': 'var(--text-sm)', 'font-weight': '600', 'line-height': '1.2', 'white-space': 'nowrap',
    width: 'fit-content', 'min-width': 'fit-content', flex: '0 0 auto',
  })) assert.equal(base[p], v, `.btn ${p}`);
  assert.equal(rule('.btn:hover:not(:disabled)').background, 'var(--bg-hover)');
  assert.equal(rule('.btn:hover:not(:disabled)')['border-color'], 'var(--ink-secondary)');
  assert.equal(rule('.btn:disabled, .btn[aria-disabled="true"]').color, 'var(--ink-muted)');
  assert.equal(rule('.btn:disabled, .btn[aria-disabled="true"]')['border-color'], 'var(--border-light)');

  for (const [kind, fill] of [['btn-primary', '--btn-blue'], ['btn-save', '--btn-green'], ['btn-danger', '--btn-danger-flat']]) {
    assert.equal(rule(`.${kind}`).background, `var(${fill})`, kind);
    assert.equal(rule(`.${kind}`).color, 'var(--btn-flat-ink)', `${kind}: white text`);
    assert.equal(rule(`.${kind}:hover:not(:disabled)`).background, `var(${fill}-hover)`, `${kind} hover`);
    assert.equal(rule(`.${kind}:disabled, .${kind}[aria-disabled="true"]`).background, `var(${fill}-disabled)`, `${kind} disabled`);
  }
  const small = rule('.btn-sm');
  assert.equal(small.height, 'var(--btn-height-sm)');
  assert.equal(small.padding, '0 0.625rem');
  assert.equal(small['font-size'], 'var(--text-xs)');

  const focus = rule('.btn:focus-visible');
  assert.equal(focus.outline, '2px solid var(--focus-ring-color)');
  assert.equal(focus['outline-offset'], '2px');
});

test('disabled is a colour, never a fade, and no other rule paints a kind\'s button', () => {
  const declarations = declarationsOf(CSS);
  const faded = declarations.filter((d) => /:disabled|aria-disabled/.test(d.selector) && d.property === 'opacity');
  assert.deepEqual(faded.map((d) => d.selector), []);
  // A rule reaching a button that is not a listed exception may place it (margins), never draw it.
  const exception = new RegExp(`button(?:\\.[\\w-]+)*\\.(?:${Object.keys(EXCEPTIONS).join('|')})\\b|\\.(?:${Object.keys(EXCEPTIONS).join('|')})\\b`);
  const draws = /^(?:background(?:-color)?|color|border(?:-[\w-]+)?|height|padding|font-size|font-weight|opacity)$/;
  const wrong = declarations.filter((d) => d.selector.split(',').some((s) => /\bbutton\b/.test(s) && !exception.test(s) && s.trim() !== 'button')
    && draws.test(d.property));
  assert.deepEqual(wrong.map((d) => `${d.selector} { ${d.property}: ${d.value} }`), []);
});
