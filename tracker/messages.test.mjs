// The message strip (docs/UI_DOCTRINE.md section 7, SP-323): every outcome
// the page reports appears once, in one strip between the header and the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { messageOf, renderMessage, renderSavedCard, MESSAGE_SOURCES, MESSAGE_CLOSES_MS, SAVED_CARD_MS } from './web/render.mjs';
import { withTokensResolved } from './cssTokens.mjs';

const WEB = (name) => readFileSync(fileURLToPath(new URL(`./web/${name}`, import.meta.url)), 'utf8');

test('a note says one message: error by its class, information while work is under way, success otherwise', () => {
  assert.deepEqual(messageOf({ className: 'note error', text: 'Not saved: no' }), { kind: 'error', text: 'Not saved: no' });
  assert.deepEqual(messageOf({ className: 'note quiet', text: 'Saving…' }), { kind: 'info', text: 'Saving…' });
  assert.deepEqual(messageOf({ className: 'note quiet info', text: 'urgent is already a tag.' }), { kind: 'info', text: 'urgent is already a tag.' });
  assert.deepEqual(messageOf({ className: 'note quiet', text: 'Saved' }), { kind: 'success', text: 'Saved' });
  assert.deepEqual(messageOf({ className: 'note', text: '  Added SP-12  ' }), { kind: 'success', text: 'Added SP-12' });
  assert.equal(messageOf({ className: 'note error', text: '' }), null, 'an empty note says nothing');
  assert.equal(messageOf({ className: 'list-note error', text: 'Not deleted', hidden: true }), null, 'a hidden note says nothing');
  assert.equal(messageOf(), null);
});

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

test('a button\'s note is not shown beside it, so a message appears once; a setup field\'s note stays beside its box', () => {
  const css = WEB('app.css');
  assert.match(css, /\nmain#main \.note:not\(\.field-note\), main#main \.list-note \{ display: none; \}/);
  assert.equal(MESSAGE_SOURCES, '.note:not(.field-note), .list-note');
});

test('the page watches every note and shows the newest in the strip; a redraw repeating the message shown is not news', () => {
  const app = WEB('app.mjs');
  const watch = /new MutationObserver\(\(records\) => \{([\s\S]*?)\n\}\)\.observe\(main, ([^)]*)\);/.exec(app);
  assert.ok(watch, 'one observer on the page');
  assert.match(watch[2], /subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: \['class', 'hidden'\]/);
  assert.match(watch[1], /messageOf\(\{ className: note\.className, text: note\.textContent, hidden: note\.hidden \}\)/);
  assert.match(watch[1], /if \(!live && shownMessage && shownMessage\.kind === said\.kind && shownMessage\.text === said\.text\) return;/);
  assert.match(watch[1], /showMessage\(said, \{ afterSave: reportsSave\(note\) \}\);/);
  assert.match(app, /function newPageMessages\(\) \{\s*if \(shownMessage && !shownMessage\.closed\) clearMessage\(\);\s*shownMessage = null;\s*\}/, 'a message about the last page goes on a new page');
  assert.match(app, /async function route\(\{ place = null \} = \{\}\) \{\s*const reads = new Map\(\);\s*drawing \+= 1;\s*newPageMessages\(\);/, 'every page route draws starts with nothing said');
  const show = /function showMessage\(said, \{ afterSave = false \} = \{\}\) \{([\s\S]*?)\n\}/.exec(app)?.[1] ?? '';
  assert.match(show, /window\.scrollTo\(\{ top: 0 \}\);\s*messageTimer = setTimeout\(clearMessage, SAVED_CARD_MS\);/, 'after a Save: the top, the card, three seconds');
  assert.match(show, /messages\.scrollIntoView\(\{ block: 'nearest' \}\);\s*if \(said\.kind !== 'error'\) messageTimer = setTimeout\(clearMessage, MESSAGE_CLOSES_MS\);/, 'an error waits for its ×');
  assert.match(app, /if \(e\.target\.closest\('\.message-close'\)\) clearMessage\(\);/);
});

test('an empty board column names what it would hold, never a bare "None."', () => {
  const app = WEB('app.mjs');
  assert.doesNotMatch(app, /None\.</);
  assert.match(app, /`<p class="quiet">No tickets are in \$\{escapeHtml\(c\.status\)\} right now\.<\/p>`/);
});

test('a ticket with no tags says so in words in its edit panel, never a bare "none"', () => {
  const render = WEB('render.mjs');
  assert.match(render, /\$\{chips \|\| '<span class="quiet">No tags yet<\/span>'\}<\/span><input id="edit-tag"/);
});
