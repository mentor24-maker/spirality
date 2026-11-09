// The tracker page's words follow docs/DOCTRINE.md (SP-138): every button,
// heading, table column heading, tab title and page trail step is in Title
// Case. This reads the page's own source and names every label that is not,
// so a new "Add thing" button fails `npm run verify` instead of reaching Dane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

/** Words that stay lower case inside a title (docs/DOCTRINE.md lists the same ones). */
const SMALL_WORDS = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'as', 'at', 'by', 'in', 'of', 'on', 'to', 'up', 'via', 'per', 'vs', 'with', 'from', 'into', 'onto']);

/**
 * Why `text` is not in Title Case, or null when it is. `${...}` parts are
 * filled in at run time (a project's name, a status) and are not checked;
 * tags and entities are skipped. The first word, and the first after a colon
 * or an opening bracket, is always capitalised; a small word elsewhere may be
 * either ("Carry On with the Setup", "Set Up a Project").
 */
function titleCaseProblem(text) {
  const words = fillIns(text).replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').split(/\s+/).filter(Boolean);
  let start = true;
  for (const word of words) {
    const letters = word.replace(/^[^\p{L}\p{N}]+/u, '');
    const first = letters[0];
    const bare = letters.replace(/[^\p{L}'-]+$/u, '').toLowerCase();
    const opensClause = word.startsWith('(');
    if (first && /\p{Ll}/u.test(first) && (start || opensClause || !SMALL_WORDS.has(bare))) {
      return `"${word}" should start with a capital letter`;
    }
    if (letters || word === '\u0000') start = /:$/.test(word);
  }
  return null;
}

/** `text` with every `${...}` (nested braces too) replaced by a run-time placeholder. */
function fillIns(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '$' && text[i + 1] === '{') {
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j += 1) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}' && (depth -= 1) === 0) break;
      }
      out += ' \u0000 ';
      i = j;
    } else {
      out += text[i];
    }
  }
  return out;
}

/** Every label on the page's source that the doctrine covers, as { kind, text }. */
function labelsOf(source) {
  const found = [];
  const add = (kind, re) => { for (const m of source.matchAll(re)) found.push({ kind, text: m[1].trim() }); };
  add('button', /<button\b[^>]*>([\s\S]*?)<\/button>/g);
  add('heading', /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/g);
  add('toggle', /<summary\b[^>]*>((?:(?!<h[1-6])[\s\S])*?)<\/summary>/g);
  add('column heading', /<th\b[^>]*>([\s\S]*?)<\/th>/g);
  add('button link', /<a class="button"[^>]*>([\s\S]*?)<\/a>/g);
  add('icon button', /actionButton\('([^']+)'/g);
  add('icon link', /action\([^\n]*?, '([^']+)', ICONS\./g);
  add('tab title', /setTitle\(['`]([^'`]+?) · Tracker['`]\)/g);
  add('trail step', /label: ['`]([^'`]+)['`] \}/g);
  add('report heading', /flow\('([^']+)',/g);
  add('button', /textContent = \([^)]*\) \? '([^']+)'/g);
  add('button', /textContent = \([^)]*\) \? '[^']+' : '([^']+)'/g);
  add('range column', /label: '([^']+)', days:/g);
  return found.filter((l) => l.text && !/^\$\{[^}]*\}$/.test(l.text));
}

const SOURCES = ['./web/app.mjs', './web/render.mjs', './web/index.html', './pageData.mjs'];

test('every button, heading, column heading, tab title and trail step on the page is in Title Case (docs/DOCTRINE.md)', () => {
  const problems = [];
  let seen = 0;
  for (const path of SOURCES) {
    for (const { kind, text } of labelsOf(read(path))) {
      seen += 1;
      const why = titleCaseProblem(text);
      if (why) problems.push(`${path}: ${kind} "${text}": ${why}`);
    }
  }
  // A pattern that stopped matching would pass silently; the page has well over a hundred.
  assert.ok(seen > 100, `only ${seen} labels found: a pattern in labelsOf no longer matches the page's source`);
  assert.deepEqual(problems, [], 'see docs/DOCTRINE.md, "Capital letters on the page"');
});

test('the Title Case rule: big words capitalised, small words free inside, the first word and the word after a colon always capitalised', () => {
  for (const ok of ['Add Task', 'Submit Task', 'Set Up a Project', 'Carry On with the Setup', 'Your Move (A Decision): Merge the Setup',
    'Waiting on You', 'Forgot Password?', '${escapeHtml(name)} Is Set Up', 'Running: ${escapeHtml(running)}', 'GitHub Repository', '×', 'Last 7 Days', 'OK', 'Sign In']) {
    assert.equal(titleCaseProblem(ok), null, ok);
  }
  for (const [bad, word] of [['Add task', 'task'], ['add Task', 'add'], ['Post reply', 'reply'], ['Your Move: a Decision', 'a'], ['Move (a Decision)', '(a'],
    ['File request', 'request'], ['Set ${x} up later', 'later']]) {
    assert.match(titleCaseProblem(bad) ?? '', new RegExp(`"${word.replace(/[()]/g, '\\$&')}"`), bad);
  }
});

test('the label finder sees buttons, headings, toggles, column headings, tab titles and trail steps, and skips labels filled in at run time', () => {
  const labels = labelsOf(`<button type="submit">Post reply</button><h2>${'${head(c)}'}</h2><summary>Add Task</summary>
    <th class="x">Last change</th>setTitle('New project · Tracker'); putTrail([{ label: 'Set up a project' }]); actionButton('Delete ticket', ICONS.delete)`);
  assert.deepEqual(labels.map((l) => `${l.kind}: ${l.text}`), [
    'button: Post reply', 'toggle: Add Task', 'column heading: Last change', 'icon button: Delete ticket', 'tab title: New project', 'trail step: Set up a project',
  ]);
});
