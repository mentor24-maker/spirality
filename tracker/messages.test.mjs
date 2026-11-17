// The message strip (docs/UI_DOCTRINE.md section 7, SP-323): what a button
// reports appears once, in one strip between the header and the page. The
// Settings page's Stage Colours Save is its first user; every other page
// still writes a note beside its button until its own ticket moves it, and
// the last test here stops a new one being added meanwhile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderMessage, renderSavedCard, MESSAGE_CLOSES_MS, SAVED_CARD_MS } from './web/render.mjs';
import { withTokensResolved } from './cssTokens.mjs';
import { PAGE_SCRIPTS, RENDER_SCRIPTS, pageScript } from './pageScripts.mjs';

const WEB = (name) => readFileSync(fileURLToPath(new URL(`./web/${name}`, import.meta.url)), 'utf8');

test('an error carries a × to close it and is an alert; success and information close by themselves', () => {
  const error = renderMessage({ kind: 'error', text: 'Not saved: <b>x</b>' });
  assert.match(error, /^<p class="message message-error" role="alert"><span class="message-text">Not saved: &lt;b&gt;x&lt;\/b&gt;<\/span><button type="button" class="message-close" aria-label="Close Message">×<\/button><\/p>$/);
  for (const kind of ['success', 'info']) {
    const html = renderMessage({ kind, text: 'Saved' });
    assert.match(html, new RegExp(`class="message message-${kind}" role="status"`));
    assert.doesNotMatch(html, /message-close/);
  }
  assert.equal(MESSAGE_CLOSES_MS, 4000);
  assert.equal(SAVED_CARD_MS, 3000);
});

test('the card after a Save says what saved, with a check drawn at stroke 1, and nothing to close', () => {
  const card = renderSavedCard('Saved <Alpha>');
  assert.match(card, /^<p class="saved-card" role="status"><svg [^>]*stroke-width="1"[^>]*aria-hidden="true">/);
  assert.match(card, /<span>Saved &lt;Alpha&gt;<\/span><\/p>$/);
  assert.doesNotMatch(card, /<button/);
});

test('the strip sits between the header and the page, in normal flow, and starts empty', () => {
  const html = WEB('index.html');
  assert.match(html, /<\/header>\s*<div id="messages" class="messages" hidden><\/div>\s*<main id="main">/);
  const css = withTokensResolved(WEB('app.css'));
  const rule = (sel) => new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  const message = rule('.message');
  assert.match(message, /padding: 8px 16px;/);
  assert.match(message, /font-size: 0\.82rem;/);
  assert.match(message, /font-weight: 500;/);
  assert.match(message, /color: #ffffff;/);
  assert.doesNotMatch(message, /position:/, 'never floating over the work');
  assert.match(rule('.message-success'), /background: #38a169;/);
  assert.match(rule('.message-error'), /background: #e53e3e;/);
  assert.match(rule('.message-info'), /background: #1a73e8;/);
  assert.match(rule('.saved-card'), /animation: saved-card-fade 3s/);
  assert.doesNotMatch(rule('.saved-card'), /position:/);
});

test('showMessage shows one message at a time: an error until its ×, others for four seconds, a Save\'s success as the card', () => {
  const app = pageScript();
  const show = /function showMessage\(said, \{ afterSave = false \} = \{\}\) \{([\s\S]*?)\n\}/.exec(app)?.[1] ?? '';
  assert.match(show, /window\.scrollTo\(\{ top: 0 \}\);\s*messageTimer = setTimeout\(clearMessage, SAVED_CARD_MS\);/, 'after a Save: the top, the card, three seconds');
  assert.match(show, /messages\.scrollIntoView\(\{ block: 'nearest' \}\);\s*if \(said\.kind !== 'error'\) messageTimer = setTimeout\(clearMessage, MESSAGE_CLOSES_MS\);/, 'an error waits for its ×');
  assert.match(app, /if \(e\.target\.closest\('\.message-close'\)\) clearMessage\(\);/);
  assert.match(app, /async function route\(\{ place = null \} = \{\}\) \{\s*const reads = new Map\(\);\s*drawing \+= 1;\s*\/\/[^\n]*\n\s*if \(!refreshing\) clearMessage\(\);/,
    'a page opened anew starts with nothing said; the half-minute re-read of the same page keeps an error showing');
  assert.doesNotMatch(app, /MutationObserver\([^)]*\)[\s\S]{0,400}messageOf/, 'notes are not copied into the strip behind the page\'s back: a button calls showMessage');
});

test('the Settings page\'s Stage Colours Save reports in the strip, not beside its button', () => {
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawSettings'), app.indexOf('/** The Settings page\'s tabs'));
  assert.match(draw, /<div class="row"><button type="submit" class="btn btn-save">Save<\/button><\/div>/, 'no note beside the Save');
  assert.match(draw, /showMessage\(\{ kind: 'info', text: 'Saving…' \}\);/);
  assert.match(draw, /showMessage\(\{ kind: 'success', text: 'Saved: the colours are stored on the tracker\.' \}, \{ afterSave: true \}\);/);
  assert.match(draw, /showMessage\(\{ kind: 'error', text: `Not saved: \$\{err\.message\}` \}\);/);
  const save = draw.slice(draw.indexOf("form.addEventListener('submit'"));
  assert.doesNotMatch(save, /note\.(?:className|textContent)/);
});

test('an empty board column names what it would hold, never a bare "None."', () => {
  const app = pageScript();
  assert.doesNotMatch(app, /None\.</);
  assert.match(app, /`<p class="quiet">No tickets are in \$\{escapeHtml\(c\.status\)\} right now\.<\/p>`/);
});

/**
 * Every place the page's code gives an element the `note` or `list-note`
 * class: a note beside a button, which UI_DOCTRINE 7 retires in favour of the
 * strip. Counted on lines that set a class, as a whole class name (so
 * `filed-note` and `.note` selectors do not count).
 */
function noteSites(source) {
  let n = 0;
  for (const line of source.split('\n')) {
    if (!/\bclass(?:Name)?\b/.test(line)) continue;
    n += (line.match(/(?<=["'`\s])(?:list-)?note(?=["'`\s])/g) ?? []).length;
  }
  return n;
}

/**
 * How many there are today, per file. Only ever lowered: a ticket that moves
 * a page onto the strip lowers its number in the same pull request; a new
 * note beside a button fails here and should call showMessage instead.
 */
const NOTE_SITES = {
  'app.mjs': 7,
  'page-projects.mjs': 19,
  'page-tasks.mjs': 8,
  'page-console.mjs': 0,
  'page-ticket.mjs': 18,
  'page-add-task.mjs': 2,
  'page-reporting.mjs': 4,
  'page-settings.mjs': 2,
  'page-users.mjs': 4,
  'page-docs.mjs': 5,
  'page-topics.mjs': 1,
  'render.mjs': 0,
  'render-common.mjs': 0,
  'render-shell.mjs': 2,
  'render-ticket.mjs': 16,
  'render-tasks.mjs': 4,
  'render-console.mjs': 0,
  'render-add-task.mjs': 0,
  'render-settings.mjs': 0,
  'render-projects.mjs': 1,
  'render-docs.mjs': 1,
  'render-topics.mjs': 2,
};

test('no new note is added beside a button: a button reports in the message strip', () => {
  assert.equal(noteSites('<span class="note"></span> note.className = \'note error\'; <p class="filed-note"> querySelector(\'.note\')'), 2, 'the counter counts the class, not the word');
  for (const [file, allowed] of Object.entries(NOTE_SITES)) {
    const found = noteSites(WEB(file));
    assert.ok(found <= allowed, `tracker/web/${file} gives ${found} elements the note class, more than the ${allowed} it had: report through showMessage (the message strip, UI_DOCTRINE 7), not a note beside the button`);
    assert.equal(found, allowed, `tracker/web/${file} now has ${found} note sites, fewer than ${allowed}: lower NOTE_SITES in tracker/messages.test.mjs to ${found} so none comes back`);
  }
});
