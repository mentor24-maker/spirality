// The tracker page's sizes and colours come from tokens (docs/UI_DOCTRINE.md
// section 2, SP-320): every colour, font size, corner and gap in
// tracker/web/app.css is a named value defined once in :root, with
// StarCaster's names and values, and every icon is drawn at stroke 1
// (section 10). This reads the stylesheet and the page's own source and names
// each rule that breaks it, so a new `color: #333` fails `npm run verify`
// instead of reaching the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { declarationsOf, rootTokens, resolveColour } from './cssTokens.mjs';

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const CSS = read('./web/app.css');

/** UI_DOCTRINE section 2's tokens, named and valued as it lists them. */
const DOCTRINE_TOKENS = {
  '--text-xs': '0.75rem', '--text-sm': '0.82rem', '--text-base': '0.9rem', '--text-md': '1rem',
  '--text-lg': '1.1rem', '--text-xl': '1.25rem', '--text-2xl': '1.5rem', '--text-3xl': '2rem',
  '--page-title-size': 'var(--text-2xl)', '--page-desc-size': 'var(--text-sm)',
  '--leading-tight': '1.25', '--leading-normal': '1.5',
  '--ink-primary': '#000000', '--ink-secondary': '#475569', '--ink-muted': '#94a3b8', '--ink-warning': '#b45309',
  '--border-light': '#e2e8f0', '--border-strong': '#cbd5e1', '--border-black': '#000000',
  '--bg-page': '#ffffff', '--bg-surface': '#ffffff', '--bg-input': '#f7f9fc', '--bg-hover': '#f1f5f9',
  '--status-ok': '#16a34a', '--status-ok-bg': '#dcfce7', '--status-ok-ink': '#15803d',
  '--status-warn': '#d97706', '--status-warn-bg': '#fef3c7', '--status-warn-ink': '#b45309',
  '--focus-ring-color': '#2563eb', '--mark-bg': '#fff3b0',
  '--space-1': '4px', '--space-2': '6px', '--space-3': '8px', '--space-4': '12px',
  '--space-5': '16px', '--space-6': '24px', '--space-7': '32px', '--space-8': '48px',
  '--radius-btn': '10px', '--radius-input': '8px', '--radius-container': '20px',
};

/** A value with every `var(--x, fallback)` fallback removed: a literal there is allowed (UI_DOCTRINE 2). */
function withoutFallbacks(value) {
  let out = value;
  for (let before; before !== out;) {
    before = out;
    out = out.replace(/var\((--[\w-]+)\s*,[^()]*(?:\([^()]*\)[^()]*)*\)/g, 'var($1)');
  }
  return out;
}

const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|\b(?:white|black|red|green|blue|yellow|orange|purple|grey|gray|silver|navy|maroon|olive|teal|aqua|fuchsia|lime|pink|gold|brown)\b/i;
const COLOUR_PROPS = /^(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left|block|inline))?(?:-color)?|outline(?:-color)?|box-shadow|text-shadow|text-decoration(?:-color)?|caret-color|accent-color|fill|stroke|column-rule(?:-color)?)$/;
const TOKEN_ONLY = (value) => /^(?:var\(--[\w-]+\)|calc\([^;]*var\(--[\w-]+\)[^;]*\)|0|inherit|initial|unset)$/.test(value.trim());

const outsideRoot = declarationsOf(CSS).filter((d) => d.selector !== ':root');

test('the stylesheet was read: a broken parser must not pass the check by finding nothing', () => {
  assert.ok(outsideRoot.length > 500, `only ${outsideRoot.length} declarations found outside :root`);
  assert.ok(outsideRoot.some((d) => d.property === 'font-size'), 'font sizes found');
});

test(':root defines every token UI_DOCTRINE section 2 lists, with its value', () => {
  const tokens = rootTokens(CSS);
  const wrong = Object.entries(DOCTRINE_TOKENS)
    .filter(([name, value]) => tokens.get(name) !== value)
    .map(([name, value]) => `${name}: wanted ${value}, found ${tokens.get(name) ?? '(missing)'}`);
  assert.deepEqual(wrong, []);
});

test('no literal colour outside :root (a var() fallback is allowed)', () => {
  const found = outsideRoot
    .filter((d) => (COLOUR_PROPS.test(d.property) || d.property.startsWith('--')) && COLOUR_LITERAL.test(withoutFallbacks(d.value).replace(/var\(--[\w-]+\)/g, "var()")))
    .map((d) => `${d.selector} { ${d.property}: ${d.value} }`);
  assert.deepEqual(found, [], 'give each colour a token in :root');
});

test('every font size, corner and gap outside :root is a token', () => {
  const found = outsideRoot
    .filter((d) => /^(?:font-size|border(?:-(?:top|bottom)-(?:left|right))?-radius|gap|row-gap|column-gap)$/.test(d.property))
    .filter((d) => !d.value.trim().split(/\s+(?![^(]*\))/).every(TOKEN_ONLY))
    .map((d) => `${d.selector} { ${d.property}: ${d.value} }`);
  assert.deepEqual(found, [], 'use --text-*, --radius-* or --space-*');
  const shorthand = outsideRoot.filter((d) => d.property === 'font' && !/^(?:inherit|var\(--[\w-]+\))$/.test(d.value.trim()));
  assert.deepEqual(shorthand.map((d) => `${d.selector} { font: ${d.value} }`), [], 'a font shorthand would carry a literal size');
});

test('every token used is defined in :root, or is one the page sets at run time', () => {
  const tokens = rootTokens(CSS);
  const runTime = new Set(['--stage-tint', '--stage-text', '--stage-border', '--feature']);
  const used = new Set([...CSS.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  assert.deepEqual([...used].filter((name) => !tokens.has(name) && !runTime.has(name)), []);
});

test('the token reader resolves a token to its colour, through another token', () => {
  assert.equal(resolveColour(CSS, 'var(--ink-error)'), '#cc0000');
  assert.equal(resolveColour(CSS, '#abc'), '#abc');
  assert.equal(resolveColour(CSS, 'var(--no-such-token)'), null);
});

test('every icon is drawn at stroke 1 (UI_DOCTRINE section 10)', () => {
  const found = [];
  for (const name of ['web/app.mjs', 'web/render.mjs', 'web/index.html']) {
    for (const m of read(`./${name}`).matchAll(/stroke-width="([^"]*)"/g)) if (m[1] !== '1') found.push(`${name}: stroke-width="${m[1]}"`);
  }
  assert.deepEqual(found, []);
  assert.ok(read('./web/app.mjs').includes('stroke-width="1"'), 'the icons were found');
});
