// The tracker page's words follow docs/UI_DOCTRINE.md (SP-138): every button,
// heading, table column heading, tab, field label, tab title and page trail
// step is in Title Case (field labels and tabs since SP-325). This reads the page's own source and names every label that is not,
// so a new "Add thing" button fails `npm run verify` instead of reaching Dane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PAGE_SCRIPTS } from './pageScripts.mjs';

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

/** Words that stay lower case inside a title (docs/UI_DOCTRINE.md lists the same ones). */
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
  add('button link', /<a class="(?:button|btn)\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g);
  add('icon button', /actionButton\('([^']+)'/g);
  add('icon link', /action\([^\n]*?, '([^']+)', ICONS\./g);
  add('tab title', /setTitle\(['`]([^'`]+?) · Tracker['`]\)/g);
  add('trail step', /label: ['`]([^'`]+)['`] \}/g);
  add('report heading', /flow\('([^']+)',/g);
  add('button', /textContent = \([^)]*\) \? '([^']+)'/g);
  add('button', /textContent = \([^)]*\) \? '[^']+' : '([^']+)'/g);
  add('range column', /label: '([^']+)', days:/g);
  // SP-325: field labels. A <label> may wrap its control; only its own words are read, not the list's choices or a hint.
  for (const m of source.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)) {
    const own = m[1].replace(/<(select|textarea|datalist)\b[\s\S]*?<\/\1>/g, ' ').replace(/<span class="(?:hint|note)[^"]*"[^>]*>[\s\S]*?<\/span>/g, ' ').replace(/<input\b[^>]*>/g, ' ');
    found.push({ kind: 'field label', text: own.trim() });
  }
  add('field label', /\bfield\('[^']+', '([^']+)'/g);
  // A setup answer's label may hold an escaped apostrophe ("Old Loop\'s ClickUp User Id"): read past it, then unescape it.
  for (const m of source.matchAll(/\blabel: '((?:[^'\\]|\\.)+)', question:/g)) found.push({ kind: 'field label', text: m[1].replace(/\\'/g, "'").trim() });
  add('field label', /\{ key: '[^']+', label: '([^']+)', options:/g);
  add('field label', /\btitle: [`']([^`']+)[`'],/g);
  // SP-325: tabs, the Tasks page's view switch and the Settings tabs.
  add('tab', /\['[a-z]+', '([^']+)', `\//g);
  add('tab', /\{ id: '[^']+', title: '([^']+)' \}/g);
  return found.filter((l) => l.text && !/^\$\{[^}]*\}$/.test(l.text));
}

const SOURCES = [...PAGE_SCRIPTS.map((name) => `./web/${name}`), './web/render.mjs', './web/index.html', './pageData.mjs', './pipelineControls.mjs', '../scripts/onboard/onboard.mjs', '../scripts/onboard/fromClickup.mjs'];

test('every button, heading, column heading, tab, field label, tab title and trail step on the page is in Title Case (docs/UI_DOCTRINE.md)', () => {
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
  assert.deepEqual(problems, [], 'see docs/UI_DOCTRINE.md, "Capital letters on the page"');
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

test('the label finder sees buttons, headings, toggles, column headings, field labels, tabs, tab titles and trail steps, and skips labels filled in at run time', () => {
  const labels = labelsOf(`<button type="submit">Post reply</button><h2>${'${head(c)}'}</h2><summary>Add Task</summary>
    <th class="x">Last change</th>setTitle('New project · Tracker'); putTrail([{ label: 'Set up a project' }]); actionButton('Delete ticket', ICONS.delete)
    <label for="a">Invite someone</label><label for="b">${'${escapeHtml(f.label)}'}</label><label class="p">Project: <select><option>all projects</option></select></label>
    <label><input type="radio" value="x"> Write my own title</label>\${field('url', 'Web address', '')}{ key: 'k', label: 'Ticket prefix', question: 'q' }
    { key: 'o', label: 'Old loop\\'s user id', question: 'q' } control({ key: 'c', title: 'Work cap', default: '0' }) ['board', 'Board view', \`/board\`] { id: 'styles', title: 'Page styles' }`);
  assert.deepEqual(labels.map((l) => `${l.kind}: ${l.text}`), [
    'button: Post reply', 'toggle: Add Task', 'column heading: Last change', 'icon button: Delete ticket', 'tab title: New project', 'trail step: Set up a project',
    'field label: Invite someone', 'field label: Project:', 'field label: Write my own title', 'field label: Web address', 'field label: Ticket prefix',
    "field label: Old loop's user id", 'field label: Work cap', 'tab: Board view', 'tab: Page styles',
  ]);
});

// The top banner stays put while the page scrolls under it (SP-327): sticky at the top, above every other
// layer the page draws, and every "scroll to this" jump lands below it rather than under it.
test('the top banner is sticky at the top of the window, above every other layer, and page jumps land below it', () => {
  const css = read('./web/app.css');
  const rule = css.match(/^header \{([^}]*)\}/m);
  assert.ok(rule, 'app.css has no top-level header rule');
  const body = rule[1];
  assert.match(body, /position:\s*sticky/, 'the header rule must keep position: sticky');
  assert.match(body, /(^|;)\s*top:\s*0\b/, 'the header rule must keep top: 0');
  const z = body.match(/z-index:\s*(\d+)/);
  assert.ok(z, 'the header rule must keep a z-index');
  const others = [...css.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.equal(Number(z[1]), Math.max(...others), 'the header must sit above every other z-index on the page');
  const height = body.match(/height:\s*([\d.]+rem)/)?.[1];
  assert.ok(height, 'the header rule names its height');
  assert.match(css, new RegExp(`^html \\{[^}]*scroll-padding-top:\\s*${height.replace('.', '\\.')}`, 'm'), 'html must pad page jumps by the banner\'s height');
});
