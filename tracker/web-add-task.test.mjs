/**
 * Tests for the Tasks page's Add Task box and Suggest Next Tasks. One file per page (SP-352),
 * so two tickets changing two pages no longer edit one test file; what they
 * share is tracker/webTestKit.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { DEMO_SUGGESTIONS, DEMO_TOPICS, demoSuggest, seedDemo } from './demoData.mjs';
import { escapeHtml, redrawHold, renderTitleChoices, titleModeOf, TITLE_MODES, SUGGEST_POLL_MS, moveSuggestion, suggestState, filingPlan, orderPlan, andList, suggestRunLine, renderSuggestRows, renderSuggestionInfo, suggestionFileHref } from './web/render.mjs';
import { startServer } from './server.mjs';
import { pageScript } from './pageScripts.mjs';
import { WEB, fixture } from './webTestKit.mjs';

// ── A new request ────────────────────────────────────────────────────────────

test('a request filed from the page lands in Requested, unassigned, under Dane, exactly as typed, first on the board', async () => {
  const f = await fixture();
  try {
    const typed = '  Please add a thing.\n\n**not bold**\n> kept\n';
    const filed = await f.call('POST', '/projects/beta/tickets', {
      body: { name: 'Test request, please close', description: typed, status: 'Requested' },
    });
    assert.equal(filed.status, 201, filed.text);
    const back = await f.call('GET', `/tickets/${filed.body.id}`);
    assert.equal(back.status, 200);
    assert.deepEqual(
      [back.body.project, back.body.name, back.body.status, back.body.assignee, back.body.description],
      ['beta', 'Test request, please close', 'requested', null, typed],
    );
    const [created] = f.store.listEvents(filed.body.id);
    assert.deepEqual([created.field, created.to, created.actor], ['created', 'requested', f.operator.id]);
    const [first] = (await f.call('GET', '/projects/beta/board')).body.columns;
    assert.equal(first.status, 'Requested');
    assert.deepEqual(first.tickets.map((t) => t.id), [filed.body.id]);
  } finally { await f.cleanup(); }
});

test('the Add Task box on the Tasks page files into the project shown, in Requested as typed, keeps the text when refused or signed out, and is gone from the header', () => {
  const app = pageScript();
  const wire = app.slice(app.indexOf('function wireAddTask'), app.indexOf('/**', app.indexOf('function wireAddTask')));
  assert.match(wire, /api\('POST', `\/projects\/\$\{encodeURIComponent\(into\)\}\/tickets`, \{\s*name: picked, description: description\.value, status: 'Requested',\s*\}\)/);
  assert.ok(!/assignee/.test(wire), 'a request is filed unassigned');
  assert.match(wire, /say\(`Not filed: \$\{err\.message\}`, 'error'\);/);
  assert.match(wire, /localStorage\.setItem\(DRAFT_KEY,/);
  assert.match(wire, /title\.value = draft\.title;\s*description\.value = draft\.description;/);
  assert.match(wire, /if \(adding \|\| \(\(draft\.title \|\| draft\.description\) && !savedSuggestSwitch\(\)\)\) box\.open = true;/, 'kept text opens the box on its own, on the Add Task side only (SP-303)');
  assert.match(wire, /drawSignIn\('You were signed out; your request was not filed\. What you typed is kept/);
  // Filed: the draft is forgotten and the page redraws, box closed, naming the new id.
  assert.match(wire, /localStorage\.removeItem\(DRAFT_KEY\);[\s\S]*await drawAgain\(\(\) => drawProject\(into, view, \{ filed: ticket\.id, unchecked, uploaded, notUploaded \}\)\);/);
  const draw = app.slice(app.indexOf('async function drawProject'), app.indexOf('async function copyText'));
  assert.match(draw, /<details class="add-task">\s*<summary>Add Task<label class="suggest-switch">[\s\S]*?<\/label><\/summary>\s*<form class="request fields"\$\{suggesting \? ' hidden' : ''\}>/, 'drawn closed, on the board and the list alike');
  assert.match(draw, /<button type="submit" class="btn btn-primary submit-task">Suggest Titles<\/button>/, 'the first submit asks for titles (SP-248)');
  assert.match(wire, /button\.textContent = asking \? 'Suggest Titles' : 'Submit Task';/, 'once a title is up for picking (or his own is typed), the button says Submit Task, in his words');
  assert.doesNotMatch(app, /File request/i, 'the old button words are gone');
  assert.match(app, /Filed <a href="\/t\/\$\{encodeURIComponent\(filed\)\}">\$\{escapeHtml\(filed\)\}<\/a>/);
  assert.match(draw, /wireAddTask\(board\.project, view, adding\);/);
  assert.doesNotMatch(app, /drawNew/, 'the separate New request page is gone');
  // The old address opens the Tasks page with the box open.
  assert.match(/async function route\(\{ place = null \} = \{\}\) \{[\s\S]*?\n\}/.exec(app)[0], /\} else if \(isNew\) \{[\s\S]*?await drawTasks\(savedView\(\), \{ adding: true \}\);/);
  assert.doesNotMatch(readFileSync(WEB('index.html'), 'utf8'), /New request|href="\/new"/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  const box = /details\.add-task \{([^}]*)\}/.exec(css);
  assert.ok(box, 'the Add Task box has its own rule');
  assert.match(box[1], /background: var\(--brand-blue\);/, 'the box is the logo blue, closed and open');
  assert.match(box[1], /color: var\(--ink-primary\);/, 'dark text on the blue, not white');
  assert.match(css, /details\.add-task form\.request :is\(input, textarea\) \{[^}]*background: var\(--bg-surface\);/, 'the fields stay white');
  // The status line (Filing…, Not filed: …) keeps its quiet grey and red, so it sits on white, readable on the blue.
  assert.match(css, /details\.add-task \.note:not\(:empty\) \{[^}]*background: var\(--bg-surface\);/, 'the note sits on a white pill inside the blue box');
});

test('the Add Task box takes files: the ticket is filed first, then each file goes up as itself, and the note names any that did not (SP-140)', () => {
  const app = pageScript();
  const wire = app.slice(app.indexOf('function wireAddTask'), app.indexOf('/**', app.indexOf('function wireAddTask')));
  const draw = app.slice(app.indexOf('async function drawProject'), app.indexOf('async function copyText'));
  assert.match(draw, /<label for="files">Files<\/label>\s*<input id="files" type="file" multiple aria-describedby="files-hint">/, 'several at once');
  assert.match(draw, /Files are not kept in the saved draft: after a reload, pick them again\./);
  // Filed first, then the files, one at a time; a failure is kept by name and the ticket stands.
  const filed = wire.indexOf("api('POST', `/projects/${encodeURIComponent(into)}/tickets`");
  const sent = wire.indexOf('await uploadFile(ticket.id, file);');
  assert.ok(filed > 0 && sent > filed, 'the ticket is filed before any file is sent');
  assert.match(wire, /notUploaded\.push\(\{ name: file\.name, why: err\.message \}\);/);
  assert.match(wire, /notUploaded\.push\(\{ name: file\.name, why: 'over 10 MB' \}\);/);
  assert.match(wire, /You were signed out; \$\{ticket\.id\} was filed, but \$\{file\.name\} and any files after it were not uploaded\./);
  assert.doesNotMatch(/function savedDraft[\s\S]*?\n\}/.exec(app)[0], /files/, 'the draft keeps only the text');
  // The upload is the file itself, with a type and headers only the page's own script can send.
  const up = /async function uploadFile[\s\S]*?\n\}/.exec(app)[0];
  assert.match(up, /'content-type': 'application\/octet-stream'/);
  assert.match(up, /'x-file-name': encodeURIComponent\(file\.name\)/);
  assert.match(up, /body: file,/);
  // Uploaded names ride in the filed pod; the ones that were not stay in the lasting line, each with why, escaped (SP-223).
  const pod = /function filedPod[\s\S]*?\n\}/.exec(app)[0];
  assert.match(pod, /Uploaded \$\{names\}/);
  assert.match(pod, /escapeHtml\(n\)/);
  const note = /function notUploadedNote[\s\S]*?\n\}/.exec(app)[0];
  assert.match(note, /Not uploaded: /);
  assert.match(note, /The ticket is filed without/);
  assert.match(note, /escapeHtml\(f\.name\)/);
  assert.match(draw, /\$\{notUploadedNote\(notUploaded\)\}<\/p>/);
});

test('a filed task shows a larger pod centred on the Tasks heading row, above the page and out of its flow, for 3 seconds then a 1-second fade, then gone; warnings stay as a lasting line (SP-223)', () => {
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawProject'), app.indexOf('async function copyText'));
  // The pod sits in the heading's own row, drawn only after a filing.
  assert.match(draw, /<div class="tasks-head title-row"><h1>Tasks<\/h1>\$\{filed \? filedPod\(filed, uploaded\) : ''\}\s*<div class="toolbar">/);
  const pod = /function filedPod[\s\S]*?\n\}/.exec(app)[0];
  assert.match(pod, /<output class="filed-pod">Filed <a href="\/t\/\$\{encodeURIComponent\(filed\)\}">\$\{escapeHtml\(filed\)\}<\/a>/, 'the id is still a link');
  // The old line under the toolbar is drawn only for a warning, and never says Filed.
  assert.match(draw, /\$\{filed && \(unchecked \|\| notUploaded\.length\) \? `<p class="filed-note">/);
  assert.doesNotMatch(draw, /<p class="filed-note">Filed/, 'a plain success is the pod alone');
  // Off the page once faded, so it catches no clicks.
  assert.match(app, /const FILED_POD_MS = 4000;/);
  assert.match(/function wireFiledPod[\s\S]*?\n\}/.exec(app)[0], /setTimeout\(\(\) => pod\.remove\(\), FILED_POD_MS\);/);
  assert.match(draw, /wireFiledPod\(\);/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /\.tasks-head \{ position: relative; \}/, 'the row the pod is centred on; adds no height of its own');
  const rule = /\.filed-pod \{([^}]*)\}/.exec(css)[1];
  assert.match(rule, /position: absolute;/, 'out of the page flow: nothing moves');
  assert.match(rule, /top: 50%; left: 50%; transform: translate\(-50%, -50%\);/, 'centred on the heading row');
  assert.match(rule, /z-index: 10;/, 'drawn above the heading, toolbar and tables');
  assert.match(rule, /font-size: var\(--text-xl\);/, 'larger than the body text');
  assert.match(rule, /animation: filed-pod-fade 4s linear forwards;/);
  assert.match(css, /@keyframes filed-pod-fade \{ 0%, 75% \{ opacity: 1; \} 100% \{ opacity: 0; \} \}/, '3 seconds full, then 1 second to nothing');
});

test('the ticket page lists its attachments by name and size, each a download, a plain picture also previewed, never an SVG (SP-140)', () => {
  const app = pageScript();
  const list = /function renderAttachments[\s\S]*?\n\}/.exec(app)[0];
  assert.match(list, /href="\$\{href\}" download="\$\{escapeHtml\(a\.name\)\}">\$\{escapeHtml\(a\.name\)\}<\/a> <span class="quiet">\$\{escapeHtml\(sizeOf\(a\.size\)\)\}<\/span>/);
  assert.match(list, /PREVIEW_TYPES\.includes\(a\.type\) \? `<a class="preview"[^`]*<img src="\$\{href\}"/);
  assert.match(list, /<h2>Attachments<\/h2>/);
  assert.match(app, /const PREVIEW_TYPES = Object\.freeze\(\['image\/png', 'image\/jpeg', 'image\/gif', 'image\/webp'\]\);/);
  const ticket = app.slice(app.indexOf('async function drawTicket'), app.indexOf('wireCopyButtons();', app.indexOf('async function drawTicket')));
  assert.match(ticket, /<section class="description">[^\n]*<\/section>\s*\$\{renderAttachments\(t\)\}/, 'right under the description');
});

test('the Add Task box checks the project before filing: asks "Did you mean ...?" when another fits, files where he says, never blocks on a failed check', () => {
  const app = pageScript();
  const wire = app.slice(app.indexOf('function wireAddTask'), app.indexOf('/**', app.indexOf('function wireAddTask')));
  // The check comes first, with the words as typed, and writes nothing (its server test reads the store).
  const check = wire.indexOf("api('POST', `/projects/${encodeURIComponent(slug)}/tickets/check`, {");
  const file = wire.indexOf("api('POST', `/projects/${encodeURIComponent(into)}/tickets`, {");
  assert.ok(check > 0 && file > check, 'the check is asked before the ticket is filed');
  assert.match(wire.slice(check), /^api\('POST', [^,]+, \{\s*name: picked, description: description\.value,\s*\}\)/);
  // No suggestion: files into the project shown, as before.
  assert.match(wire, /let into = slug;\s*if \(suggest\) \{/);
  // A suggestion: File in X files there; Keep in files here; closing files nothing and keeps the text.
  assert.match(wire, /const choice = await askProject\(question, suggest\);\s*if \(choice === 'move'\) into = suggest\.slug;\s*else if \(choice !== 'keep'\) \{[^}]*busy\(false\);[^}]*return;\s*\}/);
  assert.doesNotMatch(wire.slice(wire.indexOf("else if (choice !== 'keep')"), wire.indexOf('return;', wire.indexOf("else if (choice !== 'keep')"))), /removeItem|title\.value =|description\.value =/, 'closing leaves the form and the draft as they were');
  // A failed check (anything but a sign-out) files into the project shown, and the note says so.
  assert.match(wire, /\} catch \(err\) \{\s*if \(err instanceof SignedOut\) return drawSignIn\([^)]*\);\s*unchecked = true;\s*\}/);
  assert.match(app, /const UNCHECKED_NOTE = 'The project check could not run, so it went into the project shown\.';/);
  const draw = app.slice(app.indexOf('async function drawProject'), app.indexOf('async function copyText'));
  assert.match(draw, /\$\{unchecked \? UNCHECKED_NOTE : ''\}/);
  // Filed elsewhere: X's board opens, naming X's new ticket id.
  assert.match(wire, /if \(into !== slug\) history\.pushState\(null, '', `\/\$\{view\}\/\$\{encodeURIComponent\(into\)\}`\);/);
  // The question box: the words of the ticket, File in X, Keep in the project shown, and a close.
  assert.match(draw, /<dialog class="project-check"[^>]*>\s*<form method="dialog">/);
  assert.match(draw, /Did you mean for that to be associated with project <strong class="project-name"><\/strong>\?/);
  assert.match(draw, /<button type="submit" class="btn btn-primary" value="move">File in<\/button>/);
  assert.match(draw, /<button type="submit" class="btn" value="keep">Keep in \$\{escapeHtml\(board\.projectName\)\}<\/button>/);
  assert.match(draw, /<button type="submit" class="close" value="" aria-label="Close: file nothing">/);
  const ask = app.slice(app.indexOf('function askProject'), app.indexOf('/**', app.indexOf('function askProject')));
  assert.match(ask, /\.project-name'\)\.textContent = suggest\.name;/, 'the name goes in as text, never markup');
  assert.match(ask, /button\[value="move"\]'\)\.textContent = `File in \$\{suggest\.name\}`;/);
  assert.match(ask, /question\.returnValue = '';[\s\S]*resolve\(question\.returnValue\)[\s\S]*question\.showModal\(\);/, 'Esc or the close button answers empty: file nothing');
  assert.match(readFileSync(WEB('app.css'), 'utf8'), /dialog\.project-check \{/);
});

// ── Suggested titles in the Add Task box (SP-248) ────────────────────────────

test('the Add Task box has a Suggest a Title / Write My Own Title toggle: Suggest shows only the Description, Write My Own shows the Title too', () => {
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawProject'), app.indexOf('async function copyText'));
  const wire = app.slice(app.indexOf('function wireAddTask'), app.indexOf('/**', app.indexOf('function wireAddTask')));
  // The toggle, first in the form, in Title Case (docs/UI_DOCTRINE.md).
  assert.match(draw, /<form class="request fields"\$\{suggesting \? ' hidden' : ''\}>\s*<div class="title-mode" role="radiogroup" aria-label="How the Title Is Chosen">\s*<label><input type="radio" name="title-mode" value="suggest"> Suggest a Title<\/label>\s*<label><input type="radio" name="title-mode" value="own"> Write My Own Title<\/label>\s*<\/div>/);
  // The Title field sits in its own wrapper, required only while it shows.
  assert.match(draw, /<div class="own-title">\s*<label for="title">Title<\/label>\s*<input id="title" type="text" class="field-long">\s*<\/div>/);
  assert.doesNotMatch(draw, /<input id="title" type="text" required>/, 'never required while hidden: the browser would refuse the submit');
  assert.match(wire, /const typing = mode === 'own' \|\| stage === 'type';\s*ownTitle\.hidden = !typing;\s*title\.required = typing;\s*description\.required = mode === 'suggest';/);
  // The choice list and Suggest Again, both hidden until titles come back.
  assert.match(draw, /<fieldset class="title-choices" hidden>\s*<legend>Pick a Title<\/legend>\s*<div class="choices"><\/div>\s*<\/fieldset>/);
  assert.match(draw, /<button type="button" class="btn suggest-again" hidden>Suggest Again<\/button>/);
  assert.match(wire, /choices\.hidden = stage !== 'pick';/);
  assert.match(wire, /const asking = stage === 'ask' && mode === 'suggest';\s*again\.hidden = asking;\s*again\.textContent = stage === 'ask' \? 'Suggest Titles' : 'Suggest Again';/, 'Write My Own Title offers Suggest Titles beside Submit Task');
  // Opening the box puts the cursor in the first field the mode shows.
  assert.match(wire, /const firstField = \(\) => \(mode === 'own' \? title : description\);/);
  // Not when the form is hidden behind the Suggest side, nor when the Suggest checkbox opened it (SP-303).
  // Only a mark the checkbox sets says so: clicking the bar or Enter on it focuses the <summary> too, and must still land in the form.
  assert.match(wire, /const bySwitch = box\.dataset\.openedBySwitch === '1';\s*delete box\.dataset\.openedBySwitch;\s*if \(box\.open && !form\.hidden && !bySwitch\) firstField\(\)\.focus\(\);/);
  assert.doesNotMatch(wire, /contains\(document\.activeElement\)/, 'the bar focusing itself is no reason to skip the form');
  // The old New request address opens on the form even with Suggest ticked, and unticks it.
  assert.match(wire, /if \(adding\) \{\s*box\.querySelector\('summary \.suggest-switch input'\)\.checked = false;\s*form\.hidden = false;\s*box\.querySelector\('\.suggest-next'\)\.hidden = true;\s*try \{ localStorage\.setItem\(SUGGEST_SWITCH_KEY, '0'\); \}/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /details\.add-task \[hidden\] \{ display: none; \}/, 'a hidden part stays hidden whatever else styles it');
  assert.match(css, /details\.add-task \.title-mode label:has\(input:checked\) \{/, 'the picked side of the toggle stands out');
  assert.match(css, /details\.add-task fieldset\.title-choices \{[^}]*background: var\(--bg-surface\);/, 'the choices sit on white inside the blue box');
});

test('SP-303: the Add Task bar has a Suggest checkbox at its right; ticked shows Suggest Next Tasks in the same box, unticked the form; switching keeps both, opens a shut box, and the tick is kept in this browser', () => {
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawProject'), app.indexOf('async function copyText'));
  // One box: the checkbox sits in its bar, after the words Add Task.
  assert.equal((draw.match(/<details class="add-task">/g) || []).length, 1, 'one Add Task box');
  assert.match(draw, /<summary>Add Task<label class="suggest-switch">Suggest <input type="checkbox" value="on" aria-label="Suggest Next Tasks"\$\{suggesting \? ' checked' : ''\}><\/label><\/summary>/);
  // value="on" matches what the browser reads back, so the minute's redraw never takes the checkbox for typing.
  assert.match(draw, /const suggesting = savedSuggestSwitch\(\);/);
  // Drawn on the side he left: the other side hidden from the first paint.
  assert.match(draw, /<form class="request fields"\$\{suggesting \? ' hidden' : ''\}>/);
  assert.match(draw, /<div class="suggest-next"\$\{suggesting \? '' : ' hidden'\}>/);
  assert.match(draw, /wireSuggestSwitch\(\);/);
  // Kept in this browser, as the title toggle is.
  assert.match(app, /const SUGGEST_SWITCH_KEY = 'tracker-add-task-suggest';/);
  assert.match(/function savedSuggestSwitch[\s\S]*?\n\}/.exec(app)[0], /return localStorage\.getItem\(SUGGEST_SWITCH_KEY\) === '1';/);
  const wire = /function wireSuggestSwitch\(\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(wire, /localStorage\.setItem\(SUGGEST_SWITCH_KEY, tick\.checked \? '1' : '0'\)/, 'kept at once');
  // Switching only hides one side and shows the other: nothing is redrawn, so a draft, a picked title, the rows and a run all stay.
  assert.match(wire, /form\.hidden = tick\.checked;\s*part\.hidden = !tick\.checked;[\s\S]*?if \(!box\.open\) box\.dataset\.openedBySwitch = '1';\s*box\.open = true;/, 'opens a shut box, never folds an open one, and marks the opening as its own');
  assert.doesNotMatch(wire, /innerHTML|box\.open = false|\.value = /, 'switching wipes nothing');
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /details\.add-task > summary \.suggest-switch \{[^}]*float: right;/, 'right-aligned on the bar');
});

test('the title toggle is kept in this browser beside the draft and outlives a filing; anything but "own" reads as Suggest a Title', () => {
  const app = pageScript();
  const wire = app.slice(app.indexOf('function wireAddTask'), app.indexOf('/**', app.indexOf('function wireAddTask')));
  assert.match(app, /const TITLE_MODE_KEY = 'tracker-request-title-mode';/);
  assert.match(/function savedTitleMode[\s\S]*?\n\}/.exec(app)[0], /return titleModeOf\(localStorage\.getItem\(TITLE_MODE_KEY\)\);/);
  assert.match(wire, /let mode = savedTitleMode\(\);/);
  assert.match(wire, /mode = titleModeOf\(m\.value\);\s*try \{ localStorage\.setItem\(TITLE_MODE_KEY, mode\); \}/, 'a change of mode is kept at once');
  assert.match(wire, /for \(const m of modes\) m\.checked = m\.value === mode;/, 'the box opens on the mode it was left in');
  assert.doesNotMatch(app, /removeItem\(TITLE_MODE_KEY\)/, 'filing forgets the words, never the mode');
  assert.deepEqual(TITLE_MODES, ['suggest', 'own']);
  assert.equal(titleModeOf('own'), 'own');
  for (const kept of ['suggest', null, undefined, '', 'OWN', 'nonsense']) assert.equal(titleModeOf(kept), 'suggest', String(kept));
});

test('Suggest a Title: the first submit asks the title suggester; Write My Own Title shows Submit Task at once and files his title, with Suggest Titles beside it (his own first)', () => {
  const app = pageScript();
  const wire = app.slice(app.indexOf('function wireAddTask'), app.indexOf('/**', app.indexOf('function wireAddTask')));
  assert.match(wire, /if \(stage === 'ask' && mode === 'suggest'\) return askTitles\(\);/, 'in Suggest a Title the first submit asks, it does not file');
  assert.match(wire, /button\.textContent = asking \? 'Suggest Titles' : 'Submit Task';/, 'in Write My Own Title the button is Submit Task from the start');
  assert.match(wire, /api\('POST', `\/projects\/\$\{encodeURIComponent\(slug\)\}\/tickets\/suggest-titles`,\s*mode === 'own' \? \{ description: description\.value, title: title\.value \} : \{ description: description\.value \}\)/);
  assert.match(wire, /choiceList\.innerHTML = renderTitleChoices\(\{ own: mode === 'own' \? title\.value : null, titles \}\);\s*stage = 'pick';/);
  assert.match(wire, /again\.addEventListener\('click', \(\) => \{ keep\(\); askTitles\(\); \}\);/, 'Suggest Again asks for a fresh five; the words are not touched');
  // New words after the list is up make it stale: the button goes back to Suggest Titles.
  assert.match(wire, /if \(stage === 'pick' && \(e\.target === title \|\| e\.target === description\)\) \{\s*stage = 'ask';\s*show\(\);/);
  // Filing takes the title exactly as shown: the picked choice, or what he typed after a failure.
  assert.match(wire, /const picked = stage === 'pick' \? choiceList\.querySelector\('input\[name="title-choice"\]:checked'\)\?\.value : title\.value;/);
  // The project check still runs before filing, with the picked title.
  const check = wire.indexOf('/tickets/check`');
  assert.ok(wire.indexOf('const picked =') < check && check < wire.indexOf("status: 'Requested'"), 'picked, then checked, then filed');
});

test('a failed suggestion says why in one line and shows the Title field, and the ticket can still be filed with what he types', () => {
  const app = pageScript();
  const wire = app.slice(app.indexOf('function wireAddTask'), app.indexOf('/**', app.indexOf('function wireAddTask')));
  const failed = wire.slice(wire.indexOf('const askTitles'), wire.indexOf('choiceList.innerHTML = renderTitleChoices'));
  assert.match(failed, /if \(err instanceof SignedOut\) return drawSignIn\('You were signed out; your request was not filed\. What you typed is kept/);
  assert.match(failed, /stage = 'type';\s*show\(\);\s*say\(err instanceof Refused \? err\.message : SUGGEST_UNANSWERED, 'error'\);\s*busy\(false\);\s*title\.focus\(\);/);
  assert.doesNotMatch(failed, /title\.value =|description\.value =|removeItem/, 'nothing typed is lost');
  assert.match(app, /const SUGGEST_UNANSWERED = 'No titles could be suggested: the tracker did not answer\. Write your own title\.';/);
  // In the 'type' stage the Title field shows and is required, the button files.
  assert.match(wire, /const asking = stage === 'ask' && mode === 'suggest';[\s\S]*button\.textContent = asking \? 'Suggest Titles' : 'Submit Task';/);
});

test('renderTitleChoices: his own title first as "Keep my title", then the suggestions, the first picked, every title escaped and filed as shown', () => {
  const five = ['Add a title suggester', 'Suggest titles <b>now</b>', 'Offer five titles', 'Let the tracker name tasks', 'Show title choices'];
  const box = (html) => [...html.matchAll(/<input type="radio" name="title-choice" value="([^"]*)"( checked)?> <span>([^<]*)<\/span>/g)].map((m) => ({ value: m[1], checked: Boolean(m[2]), label: m[3] }));
  const suggestOnly = box(renderTitleChoices({ titles: five }));
  assert.deepEqual(suggestOnly.map((c) => c.value), five.map(escapeHtml));
  assert.deepEqual(suggestOnly.map((c) => c.checked), [true, false, false, false, false]);
  assert.ok(!renderTitleChoices({ titles: five }).includes('<b>'), 'a title is text, never markup');
  const own = box(renderTitleChoices({ own: '  My own "title" ', titles: five }));
  assert.equal(own.length, 6);
  assert.deepEqual(own[0], { value: escapeHtml('  My own "title" '), checked: true, label: escapeHtml('Keep my title:   My own "title" ') }, 'his title as typed, untrimmed');
  assert.equal(box(renderTitleChoices({ own: 'Offer five titles', titles: five })).length, 5, 'a suggestion that is his own title is offered once');
  assert.equal(box(renderTitleChoices({ own: '   ', titles: five })).length, 5, 'a blank title is no choice');
  assert.equal(renderTitleChoices({}), '');
});

/** A stand-in `claude` for the title suggester: plain Node that answers `body`. */
function stubClaude(dir, name, body) {
  const command = join(dir, name);
  writeFileSync(command, `#!/usr/bin/env node\nlet input = '';\nprocess.stdin.on('data', (c) => { input += c; });\nprocess.stdin.on('end', () => {\n  require('node:fs').writeFileSync(${JSON.stringify(`${command}.seen`)}, input);\n  ${body}\n});\n`);
  chmodSync(command, 0o755);
  return { command, seen: () => readFileSync(`${command}.seen`, 'utf8') };
}

test('against a stubbed suggester, the page\'s calls file the picked title: suggest, check, file; a failure answers one plain line and filing still works', async () => {
  const f = await fixture();
  const five = ['Add a title suggester', 'Suggest titles from a description', 'Offer five titles on Add Task', 'Let the tracker name tasks', 'Show title choices when adding'];
  const stubs = mkdtempSync(join(tmpdir(), 'tracker-claude-'));
  const good = stubClaude(stubs, 'good', `process.stdout.write(${JSON.stringify(five.join('\n'))});`);
  const bad = stubClaude(stubs, 'bad', `process.stdout.write('only one\\n');`);
  const serve = (claudeCommand) => startServer({ store: f.store, port: 0, claudeCommand, suggestTimeoutMs: 5000 });
  const servers = [];
  try {
    const at = async (command) => { const s = await serve(command); servers.push(s); return `http://127.0.0.1:${s.address().port}`; };
    const post = async (base, path, body) => {
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    const base = await at(good.command);
    // Suggest a Title: the description alone.
    const description = 'On the Add Task form, suggest titles from what I write.  ';
    const s1 = await post(base, '/projects/alpha/tickets/suggest-titles', { description });
    assert.equal(s1.status, 200, JSON.stringify(s1.body));
    assert.deepEqual(s1.body.titles, five);
    assert.doesNotMatch(good.seen(), /^Title:/m, 'no title sent in Suggest a Title');
    // Write My Own Title: his title travels too, and leads the list the page draws.
    const s2 = await post(base, '/projects/alpha/tickets/suggest-titles', { description, title: 'My own title' });
    assert.equal(s2.status, 200);
    assert.match(good.seen(), /^Title: My own title$/m);
    const drawn = renderTitleChoices({ own: 'My own title', titles: s2.body.titles });
    assert.ok(drawn.indexOf('Keep my title: My own title') < drawn.indexOf(five[0]));
    // Picked: the project check runs, then the ticket is filed under the pick, exactly.
    const picked = five[2];
    assert.equal((await post(base, '/projects/alpha/tickets/check', { name: picked, description })).status, 200);
    const filed = await post(base, '/projects/alpha/tickets', { name: picked, description, status: 'Requested' });
    assert.equal(filed.status, 201, JSON.stringify(filed.body));
    const back = f.store.getTicket(filed.body.id);
    assert.equal(back.name, picked);
    assert.equal(back.description, description, 'the description as typed, untrimmed');
    // A failed suggestion: one plain line for the page to show, and a typed title still files.
    const failed = await post(await at(bad.command), '/projects/alpha/tickets/suggest-titles', { description });
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error, 'bad-answer');
    assert.ok(failed.body.message && !failed.body.message.includes('\n'), `one line: ${failed.body.message}`);
    assert.doesNotMatch(failed.body.message, /only one/, 'never the run\'s own output');
    const none = await post(await at(join(stubs, 'no-such-claude')), '/projects/alpha/tickets/suggest-titles', { description });
    assert.equal(none.status, 503);
    assert.match(none.body.message, /Write your own title/);
    const typed = await post(base, '/projects/alpha/tickets', { name: 'Typed after a failure', description, status: 'Requested' });
    assert.equal(typed.status, 201);
    assert.equal(f.store.getTicket(typed.body.id).name, 'Typed after a failure');
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
    rmSync(stubs, { recursive: true, force: true });
    await f.cleanup();
  }
});

// ── Suggest Next Tasks (SP-251) ──────────────────────────────────────────────

/** The page script's Suggest Next Tasks wiring, from its first line to the next comment block. */
function suggestWire() {
  const app = pageScript();
  const start = app.indexOf('function wireSuggestNext');
  return { app, wire: app.slice(start, app.indexOf('/**', start)) };
}

/** Ask GET /projects/<slug>/suggest-next until the run is not running, at most `ms`. */
async function settledRun(f, slug, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const r = await f.call('GET', `/projects/${slug}/suggest-next`);
    if (r.body?.state !== 'running' || Date.now() > until) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
}

test('moveSuggestion: moving a row by drag, keyboard or dropdown puts it there and the rest close up behind it, numbers 1, 2, 3 ... with no gaps or repeats', () => {
  const rows = [0, 1, 2, 3, 4];
  // The spec's own case: pick 2 for the row at 5; it becomes 2, the old 2 to 4 become 3 to 5.
  assert.deepEqual(moveSuggestion(rows, 4, 1), [0, 4, 1, 2, 3]);
  // Drag the last to the top; then pick 2 on the top row.
  const dragged = moveSuggestion(rows, 4, 0);
  assert.deepEqual(dragged, [4, 0, 1, 2, 3]);
  assert.deepEqual(moveSuggestion(dragged, 0, 1), [0, 4, 1, 2, 3]);
  // The arrow keys: one up, one down; past either end it stays put.
  assert.deepEqual(moveSuggestion(rows, 2, 1), [0, 2, 1, 3, 4]);
  assert.deepEqual(moveSuggestion(rows, 2, 3), [0, 1, 3, 2, 4]);
  assert.deepEqual(moveSuggestion(rows, 0, -1), rows);
  assert.deepEqual(moveSuggestion(rows, 4, 5), rows);
  assert.deepEqual(moveSuggestion(rows, 9, 0), rows, 'no row there: nothing moves');
  assert.notEqual(moveSuggestion(rows, 1, 2), rows, 'a new list, the old one untouched');
  // Any run of moves leaves every row exactly once.
  let order = rows;
  for (const [from, to] of [[3, 0], [0, 4], [2, 2], [1, 3], [4, 0]]) {
    order = moveSuggestion(order, from, to);
    assert.deepEqual([...order].sort(), rows);
  }
  // And the dropdowns drawn from it read 1 to n, each row its own place.
  const html = renderSuggestRows(DEMO_SUGGESTIONS, { order, dropped: [], filed: {} });
  const selected = [...html.matchAll(/<option value="(\d)" selected>/g)].map((m) => Number(m[1]));
  assert.deepEqual(selected, [1, 2, 3, 4, 5]);
  assert.equal((html.match(/<option /g) ?? []).length, 25, 'five places offered on each of five rows');
});

test('renderSuggestRows: a handle, a place dropdown, Keep, the title, and the why and description under More; a filed row names its ticket; every word escaped', () => {
  const suggestions = [
    { title: 'Fix <b>this</b>', description: 'Line one\nline <i>two</i>', why: 'Because "so"' },
    { title: 'Second', description: '', why: '' },
  ];
  const html = renderSuggestRows(suggestions, { order: [1, 0], dropped: [0], filed: { 1: { id: 'AL-9', project: 'alpha' } } });
  const rows = html.split('</li>').filter(Boolean);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^<li class="suggestion" data-index="1" draggable="true">/, 'drawn in the order given');
  assert.match(rows[0], /<button type="button" class="drag-handle" aria-label="Move Second: arrow keys, or drag"/);
  assert.match(rows[0], /<label class="keep"><input type="checkbox" value="keep" checked> Keep<\/label>/);
  assert.match(rows[0], /<span class="filed">Filed <a href="\/t\/AL-9">AL-9<\/a><\/span>/);
  assert.doesNotMatch(rows[0], /class="why"|suggestion-description/, 'nothing empty under More');
  assert.match(rows[1], /<label class="keep"><input type="checkbox" value="keep"> Keep<\/label>/, 'unticked stays unticked');
  // Every Keep box carries its value: one with none reads "on" against a drawn "" and holds the page's redraw for good.
  assert.equal((html.match(/<input type="checkbox"/g) || []).length, (html.match(/<input type="checkbox" value="keep"/g) || []).length);
  assert.equal(redrawHold({ fields: [{ focused: false, value: 'keep', initial: 'keep' }] }), null, 'a Keep box as drawn does not hold the redraw');
  assert.equal(redrawHold({ fields: [{ focused: false, value: 'on', initial: '' }] }), 'typing', 'what a box with no value would read');
  assert.match(rows[1], /<details class="more"><summary>More<\/summary><p class="why"><strong>Why:<\/strong> Because &quot;so&quot;<\/p><p class="suggestion-description">Line one\nline &lt;i&gt;two&lt;\/i&gt;<\/p><\/details>/);
  assert.ok(!html.includes('<b>') && !html.includes('<i>'), 'a suggestion is text, never markup');
  assert.equal(renderSuggestRows([], { order: [], dropped: [], filed: {} }), '');
});

test('renderSuggestRows: each row has an i that names its own suggestion, wherever the row is moved (SP-304)', () => {
  const suggestions = [{ title: 'A <one>' }, { title: 'B' }, { title: 'C' }];
  const html = renderSuggestRows(suggestions, { order: [2, 0, 1], dropped: [], filed: {} });
  const rows = html.split('</li>').filter(Boolean);
  assert.equal(rows.length, 3);
  for (const [place, index] of [[0, 2], [1, 0], [2, 1]]) {
    const i = rows[place].match(/<button type="button" class="suggestion-info-open" data-index="(\d)" aria-label="About ([^"]*)" title="About This Task"><svg [^>]*aria-hidden="true">[\s\S]*?<\/svg><\/button>/);
    assert.ok(i, `row ${place + 1} has an i button`);
    assert.equal(Number(i[1]), index, 'the i carries the suggestion\'s own index, not its place');
    assert.equal(i[2], escapeHtml(suggestions[index].title));
  }
  // Moved again, each i still names the same suggestion.
  const moved = renderSuggestRows(suggestions, { order: moveSuggestion([2, 0, 1], 0, 2), dropped: [], filed: {} });
  assert.match(moved.split('</li>')[2], /class="suggestion-info-open" data-index="2" aria-label="About C"/);
  assert.match(html, /<span class="suggestion-title">A &lt;one&gt;<\/span><button type="button" class="suggestion-info-open"/, 'the i sits beside the title');
  assert.match(html, /<details class="more"><summary>More<\/summary>/, 'the More fold stays');
});

test('renderSuggestionInfo: the title as heading, Why It Matters and Description, every word escaped (SP-304)', () => {
  const html = renderSuggestionInfo({ title: 'Fix <b>this</b> & that', why: 'Because <script>x</script> & so', description: 'Line one\nline <i>two</i>' });
  assert.match(html, /^<h2 id="suggestion-info-title">Fix &lt;b&gt;this&lt;\/b&gt; &amp; that<\/h2>/);
  assert.match(html, /<h3>Why It Matters<\/h3><p>Because &lt;script&gt;x&lt;\/script&gt; &amp; so<\/p>/);
  assert.match(html, /<h3>Description<\/h3><p>Line one\nline &lt;i&gt;two&lt;\/i&gt;<\/p>/);
  assert.ok(!/<(b|i|script)>/.test(html), 'a suggestion is text, never markup');
  assert.ok(html.indexOf('Why It Matters') < html.indexOf('Description'));
  // A section the suggestion lacks is left out; one with neither says so.
  const bare = renderSuggestionInfo({ title: 'Bare', why: '', description: 'Only this' });
  assert.doesNotMatch(bare, /Why It Matters/);
  assert.match(bare, /<h3>Description<\/h3><p>Only this<\/p>/);
  assert.match(renderSuggestionInfo({ title: 'Empty' }), /<p class="quiet">This suggestion came with nothing more to say\.<\/p>/);
  assert.equal(renderSuggestionInfo(undefined), '<h2 id="suggestion-info-title"></h2><p class="quiet">This suggestion came with nothing more to say.</p>');
});

test('renderSuggestionInfo shows About This Task, Related Tickets, Topics, Tags and Links, each only when there, every word escaped (SP-305)', () => {
  const html = renderSuggestionInfo({
    title: 'T', why: 'W', description: 'D',
    about: 'About <b>it</b> & more',
    related: [{ id: 'AL-3', name: 'The <i>board</i>' }],
    topics: ['Board <x>'], tags: ['fix&go'],
    links: [{ label: 'The <plan>', path: 'docs/PLAN.md' }, { label: 'Odd name', path: 'docs/a b#c.md' }, { label: 'Board ticket', ticket: 'AL-3' }],
  }, { repo: 'owner/app' });
  assert.match(html, /<h3>About This Task<\/h3><p>About &lt;b&gt;it&lt;\/b&gt; &amp; more<\/p>/);
  assert.match(html, /<h3>Related Tickets<\/h3><ul class="related"><li><a href="\/t\/AL-3">AL-3<\/a> The &lt;i&gt;board&lt;\/i&gt;<\/li><\/ul>/, 'a related ticket links to its page, with its name');
  assert.match(html, /<h3>Topics<\/h3><p class="chips"><span class="tag topic">Board &lt;x&gt;<\/span><\/p>/);
  assert.match(html, /<h3>Tags<\/h3><p class="chips"><span class="tag">fix&amp;go<\/span><\/p>/);
  assert.match(html, /<li><a href="https:\/\/github\.com\/owner\/app\/blob\/main\/docs\/PLAN\.md" target="_blank" rel="noopener noreferrer">The &lt;plan&gt;<\/a> <code>docs\/PLAN\.md<\/code><\/li>/, 'a file opens on GitHub at main');
  assert.match(html, /href="https:\/\/github\.com\/owner\/app\/blob\/main\/docs\/a%20b%23c\.md"/, 'each part of the path is encoded');
  assert.match(html, /<li><a href="\/t\/AL-3">Board ticket<\/a><\/li><\/ul>$/, 'a ticket link opens its page');
  assert.ok(!/<(b|i|x|plan)>/.test(html), 'text, never markup');
  const order = ['Why It Matters', 'Description', 'About This Task', 'Related Tickets', 'Topics', 'Tags', 'Links'].map((h) => html.indexOf(`<h3>${h}</h3>`));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'under the Why and the description, in this order');
  assert.ok(order.every((i) => i > 0));

  // Empty sections are left out; an older suggestion draws exactly as before.
  const old = { title: 'Old', why: 'W', description: 'D' };
  assert.equal(renderSuggestionInfo({ ...old, related: [], topics: [], tags: [], links: [], about: '' }, { repo: 'owner/app' }), renderSuggestionInfo(old));
  assert.doesNotMatch(renderSuggestionInfo(old), /About This Task|Related Tickets|Topics|Tags|Links/);

  // With no repository, a file is named but not linked; a bad path is never linked.
  const unlinked = renderSuggestionInfo({ title: 'T', links: [{ label: 'Plan', path: 'docs/PLAN.md' }] });
  assert.match(unlinked, /<li>Plan <code>docs\/PLAN\.md<\/code><\/li>/);
  assert.doesNotMatch(unlinked, /<a /);
  for (const [repo, path] of [['owner/app', '../x'], ['owner/app', '/etc/passwd'], ['owner/app', 'javascript:alert(1)'], ['owner/app', 'a//b'], ['bad repo', 'x.md'], ['owner/app/extra', 'x.md'], [null, 'x.md']]) {
    assert.equal(suggestionFileHref(repo, path), null, `${repo} ${path}`);
  }
  assert.match(renderSuggestionInfo({ title: 'T', links: [{ label: 'Up', path: '../x' }] }, { repo: 'owner/app' }), /<li>Up <code>\.\.\/x<\/code><\/li>/, 'shown as text, never a link');
});

test('the info box\'s file links use the repository the latest run answers with (SP-305)', () => {
  const { wire } = suggestWire();
  assert.match(wire, /repo = typeof latest\.repo === 'string' \? latest\.repo : null;/);
  assert.match(wire, /renderSuggestionInfo\(suggestion, \{ repo \}\)/);
});

test('Suggest Next Tasks sends the open tickets\' tags and topics and the project\'s topic and tag names, checks the answer against them, and answers the repository (SP-305)', async () => {
  const runs = [];
  const f = await fixture({ suggest: { run: async (o) => { runs.push(o); return DEMO_SUGGESTIONS.map((s) => ({ ...s })); } } });
  try {
    const topic = f.store.addTopic({ project: 'alpha', name: 'Board', actor: f.operator.id });
    f.store.changeTicket('AL-3', { actor: f.operator.id, topics: [topic.id] });
    f.store.updateProject('alpha', { repo: 'owner/app' });
    await f.call('POST', '/projects/alpha/suggest-next', { body: {} });
    const latest = await settledRun(f, 'alpha');
    assert.equal(latest.body.repo, 'owner/app');
    const input = JSON.parse(runs[0].input);
    assert.deepEqual(input.projectTopics, ['Board']);
    assert.ok(input.projectTags.includes('tracker') && input.projectTags.includes('fix'), input.projectTags.join(', '));
    assert.deepEqual(input.openTickets.find((t) => t.id === 'AL-3').topics, ['Board']);
    assert.deepEqual(input.openTickets.find((t) => t.id === 'AL-5').tags, ['tracker', 'fix']);
    const { known } = runs[0];
    assert.deepEqual(known.tickets.get('AL-3'), { id: 'AL-3', name: 'The board is missing: draw the seven columns' });
    assert.equal(known.tickets.has('AL-9'), false, 'a Live ticket is not open, so never related');
    assert.equal(known.topics.get('board'), 'Board');
    assert.equal(known.tags.get('tracker'), 'tracker');
  } finally { await f.cleanup(); }
});

test('the demo\'s suggestions carry the info box\'s fields, naming only the demo\'s own tickets, topics and tags (SP-305)', () => {
  const full = DEMO_SUGGESTIONS.filter((s) => s.about && s.related?.length && s.topics?.length && s.tags?.length && s.links?.length);
  assert.ok(full.length >= 2);
  const dir = mkdtempSync(join(tmpdir(), 'tracker-demo-sp305-'));
  const store = openStore(join(dir, 'tracker.db'));
  try {
    seedDemo(store);
    const open = new Map(store.listTickets('alpha', { open: true }).map((t) => [t.id, t.name]));
    const tags = new Set(store.listTickets('alpha').flatMap((t) => t.tags));
    for (const s of full) {
      for (const r of s.related) assert.equal(open.get(r.id), r.name, r.id);
      for (const t of s.topics) assert.ok(DEMO_TOPICS.includes(t), t);
      for (const t of s.tags) assert.ok(tags.has(t), t);
      for (const l of s.links) assert.ok(l.ticket ? open.has(l.ticket) : suggestionFileHref('o/r', l.path), JSON.stringify(l));
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('suggestState keeps the order, ticks and filed tickets for the same run only; filingPlan files the kept rows not yet filed, and orders every kept one', () => {
  const fresh = suggestState(null, 't1', 4);
  assert.deepEqual(fresh, { at: 't1', order: [0, 1, 2, 3], dropped: [], filed: {} });
  const kept = { at: 't1', order: [2, 0, 3, 1], dropped: [0], filed: { 2: { id: 'AL-7', project: 'alpha' } } };
  assert.deepEqual(suggestState(kept, 't1', 4), kept);
  assert.deepEqual(suggestState(kept, 't2', 4), { ...fresh, at: 't2' }, 'a new run starts over');
  assert.deepEqual(suggestState({ ...kept, order: [0, 0, 1, 2] }, 't1', 4), fresh, 'a broken order starts over');
  assert.deepEqual(suggestState({ ...kept, order: [0, 1] }, 't1', 4), fresh, 'a different count starts over');
  assert.deepEqual(suggestState('nonsense', 't1', 4), fresh);
  // Only the kept rows, in the order shown; the one already filed is not filed again.
  assert.deepEqual(filingPlan(kept), { kept: [2, 3, 1], file: [3, 1] });
  assert.deepEqual(filingPlan({ ...kept, filed: { 1: { id: 'a', project: 'x' }, 2: { id: 'b', project: 'x' }, 3: { id: 'c', project: 'x' } } }).file, [], 'a retry after everything filed files nothing');
  assert.deepEqual(filingPlan({ ...kept, dropped: [0, 1, 2, 3] }), { kept: [], file: [] });
});

test('orderPlan orders only the kept tickets still in Requested in the project they were filed into; a started one is left alone and a deleted or moved one is gone (SP-251 review)', () => {
  const filed = { 0: { id: 'AL-1', project: 'alpha' }, 1: { id: 'AL-2', project: 'alpha' }, 2: { id: 'AL-3', project: 'alpha' }, 3: { id: 'AL-4', project: 'alpha' }, 4: { id: 'BE-5', project: 'beta' } };
  const now = {
    0: { id: 'AL-1', project: 'alpha', status: 'needs-input' },
    1: null,
    2: { id: 'AL-3', project: 'beta', status: 'requested' },
    3: { id: 'AL-4', project: 'alpha', status: 'requested' },
  };
  // Row 4 is missing from `now`: filed by this press, so ordered without a read.
  const plan = orderPlan([4, 3, 2, 1, 0], filed, now);
  assert.deepEqual([...plan.byProject], [['beta', ['BE-5']], ['alpha', ['AL-4']]]);
  assert.deepEqual(plan.leftAlone, [{ index: 0, id: 'AL-1' }]);
  assert.deepEqual(plan.gone, [{ index: 2, id: 'AL-3' }, { index: 1, id: 'AL-2' }]);
  assert.deepEqual([...orderPlan([0, 3], filed).byProject], [['alpha', ['AL-1', 'AL-4']]], 'nothing read back: all filed by this press');
  assert.deepEqual(orderPlan([9], filed).byProject.size, 0, 'a row never filed is not ordered');
  assert.equal(andList([]), '');
  assert.equal(andList(['A']), 'A');
  assert.equal(andList(['A', 'B']), 'A and B');
  assert.equal(andList(['A', 'B', 'C']), 'A, B and C');
});

test('File in This Order again, a day later, against the server: a ticket already started keeps its version, a deleted one is dropped, and the order call still works', async () => {
  const f = await fixture();
  try {
    const filed = {};
    for (const i of [0, 1, 2, 3]) {
      const r = await f.call('POST', '/projects/alpha/tickets', { body: { name: `Suggestion ${i}`, description: '', status: 'Requested' } });
      assert.equal(r.status, 201, r.text);
      filed[i] = { id: r.body.id, project: 'alpha' };
    }
    assert.equal((await f.call('POST', '/projects/alpha/tickets/order', { body: { ids: [0, 1, 2, 3].map((i) => filed[i].id) } })).status, 200);
    // Since then: intake took the first on, and the second was deleted.
    f.store.changeTicket(filed[0].id, { actor: f.loop.id, status: 'Needs your input' });
    f.store.deleteTicket(filed[1].id, { actor: f.operator.id });
    const startedVersion = f.store.getTicket(filed[0].id).version;
    // He ticks a fifth and presses again: it is filed, then the earlier ones are read back the way the page does.
    const fifth = await f.call('POST', '/projects/alpha/tickets', { body: { name: 'Suggestion 4', description: '', status: 'Requested' } });
    filed[4] = { id: fifth.body.id, project: 'alpha' };
    const now = {};
    for (const i of [0, 1, 2, 3]) {
      const r = await f.call('GET', `/tickets/${filed[i].id}`);
      if (r.status === 404) now[i] = null;
      else { assert.equal(r.status, 200, r.text); now[i] = r.body; }
    }
    const plan = orderPlan([4, 0, 1, 2, 3], filed, now);
    assert.deepEqual(plan.leftAlone.map((t) => t.id), [filed[0].id]);
    assert.deepEqual(plan.gone.map((t) => t.id), [filed[1].id]);
    const ids = plan.byProject.get('alpha');
    assert.deepEqual(ids, [filed[4].id, filed[2].id, filed[3].id]);
    // Naming the deleted one would fail the whole call: the old way, shown once.
    assert.equal((await f.call('POST', '/projects/alpha/tickets/order', { body: { ids: [filed[1].id, ...ids] } })).status, 400);
    const r = await f.call('POST', '/projects/alpha/tickets/order', { body: { ids } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.tickets.map((t) => t.place), [1, 2, 3]);
    assert.equal(f.store.getTicket(filed[0].id).version, startedVersion, 'the started ticket was not touched: a lane\'s guarded write on it still works');
  } finally { await f.cleanup(); }
});

test('suggestRunLine says a run is going or why it failed, plainly', () => {
  assert.match(suggestRunLine({ state: 'running' }), /^Reading the project for its next tasks/);
  assert.equal(suggestRunLine({ state: 'failed', message: 'Claude is not set up on this machine.' }), 'No suggestions this time: Claude is not set up on this machine.');
  assert.equal(suggestRunLine({ state: 'failed' }), 'No suggestions this time: the run failed.');
  assert.equal(suggestRunLine({ state: 'done', suggestions: [] }), '');
  assert.equal(suggestRunLine(null), '');
  assert.equal(SUGGEST_POLL_MS, 10_000, 'it checks back about every 10 seconds');
});

test('Suggest Next Tasks, against a stubbed suggester: a run answers the list; filing the kept rows in Requested and setting their order puts them in that order on the Tasks page', async () => {
  const f = await fixture({ suggest: { run: demoSuggest({ ms: 50 }) } });
  try {
    assert.equal((await f.call('GET', '/projects/alpha/suggest-next')).status, 404, 'nothing asked for yet: the box shows no list');
    const started = await f.call('POST', '/projects/alpha/suggest-next', { body: {} });
    assert.equal(started.status, 202);
    assert.equal(started.body.run.state, 'running');
    const latest = await settledRun(f, 'alpha');
    assert.equal(latest.body.state, 'done');
    assert.deepEqual(latest.body.suggestions.map((s) => s.title), DEMO_SUGGESTIONS.map((s) => s.title));

    // What the page does: drag the last to the top, untick the third shown, file the rest in order.
    let state = suggestState(null, latest.body.at, latest.body.suggestions.length);
    state.order = moveSuggestion(state.order, 4, 0);
    state.dropped = [state.order[2]];
    const plan = filingPlan(state);
    assert.equal(plan.file.length, 4);
    for (const i of plan.file) {
      const s = latest.body.suggestions[i];
      const r = await f.call('POST', '/projects/alpha/tickets', { body: { name: s.title, description: s.description, status: 'Requested' } });
      assert.equal(r.status, 201, r.text);
      state.filed[i] = { id: r.body.id, project: 'alpha' };
    }
    const ids = plan.kept.map((i) => state.filed[i].id);
    assert.equal((await f.call('POST', '/projects/alpha/tickets/order', { body: { ids } })).status, 200);
    // A retry files nothing twice.
    assert.deepEqual(filingPlan(state).file, []);

    const board = (await f.call('GET', '/projects/alpha/board')).body;
    const requested = board.columns.find((c) => c.status === 'Requested').tickets;
    const titles = plan.kept.map((i) => latest.body.suggestions[i].title);
    assert.deepEqual(requested.filter((t) => ids.includes(t.id)).map((t) => t.name), titles, 'the Requested stage lists them in the order set');
    assert.ok(!requested.some((t) => t.name === latest.body.suggestions[state.dropped[0]].title), 'the unticked one was not filed');
  } finally { await f.cleanup(); }
});

test('Suggest Next Tasks, against a stubbed suggester that fails: the run says why, and Try Again starts another', async () => {
  let calls = 0;
  const f = await fixture({ suggest: { run: async () => { calls += 1; if (calls === 1) throw new Error('the copy could not be made'); return DEMO_SUGGESTIONS.map((s) => ({ ...s })); } } });
  try {
    await f.call('POST', '/projects/alpha/suggest-next', { body: {} });
    const failed = await settledRun(f, 'alpha');
    assert.equal(failed.body.state, 'failed');
    assert.match(suggestRunLine(failed.body), /^No suggestions this time: the run failed \(the copy could not be made\)\.$/);
    await f.call('POST', '/projects/alpha/suggest-next', { body: {} });
    assert.equal((await settledRun(f, 'alpha')).body.state, 'done', 'Try Again is just another run');
  } finally { await f.cleanup(); }
});

test('the Suggest Next Tasks box sits beside Add Task, in Title Case, and its button runs the suggester and checks back while it runs', () => {
  const { app, wire } = suggestWire();
  const draw = app.slice(app.indexOf('async function drawProject'), app.indexOf('function wireListPickers'));
  // SP-303: inside the Add Task box, after its form; no box of its own.
  assert.ok(draw.indexOf('</form>', draw.indexOf('<details class="add-task">')) < draw.indexOf('<div class="suggest-next"'), 'inside the Add Task box, after the form');
  assert.ok(draw.indexOf('<div class="suggest-next"') < draw.indexOf('</details>', draw.indexOf('<details class="add-task">')), 'inside the Add Task box');
  assert.doesNotMatch(draw, /<details class="suggest-next">|<summary>Suggest Next Tasks<\/summary>/, 'no separate Suggest Next Tasks bar');
  assert.match(draw, /<div class="row run-row"><button type="button" class="btn btn-primary suggest-run">Suggest Next Tasks<\/button><span class="run-note note" role="status"><\/span><\/div>/, 'before any suggestions, the run button is at the top');
  assert.match(draw, /<div class="row file-row" hidden><button type="button" class="btn btn-primary file-order">File in This Order<\/button>/);
  assert.match(draw, /wireSuggestNext\(board\.project, view\);/);
  // SP-319: with suggestions showing, the one run button moves to the right of
  // the bottom row, across from File in This Order; with none, back to the top.
  const drawRows = wire.slice(wire.indexOf('const drawRows = '), wire.indexOf('const move = '));
  assert.match(drawRows, /fileRow\.hidden = !state;\s*[\s\S]*?if \(state\) \{ if \(run\.parentNode !== fileRow\) fileRow\.append\(run\); \}\s*else if \(run\.parentNode !== runRow\) runRow\.prepend\(run\);/, 'the run button follows the file row');
  assert.match(wire, /const runRow = box\.querySelector\('\.run-row'\);/);
  assert.match(wire, /run\.textContent = latest\?\.state === 'failed' \? 'Try Again' : latest\?\.state === 'done' \? 'Suggest Again' : 'Suggest Next Tasks';/);
  // POST starts it; GET reads it, unrecorded so a finished run never redraws the whole page under him.
  assert.match(wire, /api\('POST', path, \{\}\)/);
  assert.match(wire, /api\('GET', path, undefined, \{ unrecorded: true \}\)/);
  assert.match(wire, /const path = `\/projects\/\$\{encodeURIComponent\(slug\)\}\/suggest-next`;/);
  assert.match(wire, /setTimeout\(async \(\) => \{[\s\S]*?\}, SUGGEST_POLL_MS\);/, 'checks back about every 10 seconds');
  assert.match(wire, /if \(!box\.isConnected\) return;/, 'a page drawn over stops checking back');
  // The page opens on the last list, on its own.
  assert.match(wire, /\/\/ On opening the page: the last list, on its own\.\s*\(async \(\) => \{\s*const latest = await read\(\);/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /details\.add-task \[hidden\] \{ display: none; \}/, 'the hidden side stays hidden');
  assert.doesNotMatch(css, /details\.suggest-next/, 'no rule for the old separate box');
  // SP-319: the rows lay out as rows (never un-hiding the hidden file row), Suggest Again pushed right, wrapping on a narrow window.
  assert.match(css, /details\.add-task \.suggest-next \.row:not\(\[hidden\]\) \{ display: flex; flex-wrap: wrap; gap: var\(--space-4\); align-items: center; \}/);
  assert.match(css, /details\.add-task \.suggest-next \.file-row button\.suggest-run \{ margin-left: auto; \}/);
});

test('the Suggest Next Tasks rows move by dropdown, by the arrow keys on the handle, and by dragging, all through moveSuggestion, and the state is kept for a redraw', () => {
  const { wire } = suggestWire();
  assert.match(wire, /if \(e\.target\.matches\('select\.place'\)\) move\(placeOf\(li\), Number\(e\.target\.value\) - 1\);/);
  assert.match(wire, /const to = \{ ArrowUp: from - 1, ArrowDown: from \+ 1, Home: 0, End: state\.order\.length - 1 \}\[e\.key\];/);
  assert.match(wire, /move\(from, to, true\);/, 'the keyboard keeps focus on the moved handle');
  assert.match(wire, /list\.addEventListener\('drop', /);
  assert.match(wire, /move\(from, placeOf\(li\)\);/);
  assert.match(wire, /state\.order = moveSuggestion\(state\.order, from, to\);\s*save\(\);\s*drawRows\(/);
  assert.match(wire, /state = suggestState\(savedSuggestState\(slug\), latest\.at, suggestions\.length\);/);
});

test('a run that answers while File in This Order is filing waits until filing ends, File in This Order is off while a run goes, and the box opens on its own only on the page\'s first draw', () => {
  const { wire } = suggestWire();
  const show = wire.slice(wire.indexOf('const show = (latest) => {'), wire.indexOf('const read = async'));
  // A finished (or failed) run never swaps suggestions and state under the filing loop: it is held.
  assert.match(show, /if \(!box\.isConnected\) return;\s*if \(filing\) \{ held = latest; return; \}\s*say\(runNote/, 'held before anything is drawn or replaced');
  assert.ok(show.indexOf('held = latest') < show.indexOf('suggestions = latest.suggestions'), 'held before the rows are replaced');
  assert.ok(show.indexOf('held = latest') < show.indexOf('state = null'), 'held before a failed run clears the state');
  // While a run is going, nothing is filed from the rows it is about to replace.
  assert.match(show, /running = latest\?\.state === 'running';\s*run\.disabled = running;[\s\S]*?fileButton\.disabled = running;/);
  const file = wire.slice(wire.indexOf("fileButton.addEventListener('click'"));
  assert.match(file, /if \(!state \|\| filing \|\| running\) return;/);
  // When filing ends, the held answer is drawn, and File in This Order stays off if it is a run still going.
  assert.match(file, /filing = false;\s*fileButton\.disabled = running;\s*run\.disabled = running;\s*\/\/[^\n]*\n\s*if \(held !== undefined\) \{\s*const latest = held;\s*held = undefined;\s*show\(latest\);\s*\} else drawRows\(\);/);
  // A failed start while filing leaves Suggest off until filing ends.
  assert.match(wire, /run\.textContent = 'Try Again';\s*run\.disabled = filing;/);
  // The box opens on its own only on the page's first draw: a minute's redraw keeps his fold.
  assert.match(wire, /const mayOpen = !refreshing;/);
  assert.doesNotMatch(show, /(box|fold)\.open = true/, 'a check-back never opens a box he closed');
  const opening = wire.slice(wire.indexOf('// On opening the page'));
  // SP-303: and only while the Suggest checkbox is ticked; it never ticks the checkbox itself.
  assert.match(opening, /show\(latest\);\s*\/\/[^\n]*\n\s*if \(mayOpen && savedSuggestSwitch\(\) && \(running \|\| \(latest\.state === 'done' && state && filingPlan\(state\)\.file\.length\)\)\) fold\.open = true;/);
  assert.equal((wire.match(/(box|fold)\.open = true/g) || []).length, 1, 'only the first draw opens it');
  assert.doesNotMatch(wire, /SUGGEST_SWITCH_KEY|\.checked = true/, 'never flips the checkbox');
});

test('File in This Order files only the kept rows not yet filed, in Requested, after the project check; keeps each at once; then sets the order; a failed step says which', () => {
  const { wire } = suggestWire();
  const file = wire.slice(wire.indexOf("fileButton.addEventListener('click'"));
  assert.match(file, /const plan = filingPlan\(state\);/);
  assert.match(file, /for \(const i of plan\.file\) \{/);
  const check = file.indexOf('/tickets/check`');
  const post = file.indexOf("status: 'Requested'");
  const order = file.indexOf('/tickets/order`');
  assert.ok(check > 0 && check < post && post < order, 'checked, then filed, then ordered');
  assert.match(file, /\{ name: s\.title, description: s\.description \?\? '', status: 'Requested' \}/, 'title and description as shown');
  assert.match(file, /state\.filed\[i\] = \{ id: ticket\.id, project: into \};\s*save\(\);/, 'each filed ticket is kept at once: a retry never files it again');
  assert.match(file, /for \(const i of plan\.kept\) \{\s*if \(fresh\.has\(i\) \|\| !state\.filed\[i\]\) continue;/, 'each ticket an earlier press filed is read back first');
  assert.match(file, /const order = orderPlan\(plan\.kept, state\.filed, now\);/, 'only the ones still in Requested are ordered');
  assert.match(file, /for \(const \[project, ids\] of order\.byProject\)/);
  assert.match(file, /if \(err instanceof Refused && err\.status === 404\) \{ now\[i\] = null; continue; \}/, 'a deleted ticket is gone, not a failure');
  assert.match(file, /state\.dropped = \[\.\.\.new Set\(\[\.\.\.state\.dropped, \.\.\.order\.gone\.map/, 'a gone ticket is unticked, so a later press never names it');
  assert.match(file, /so \$\{order\.leftAlone\.length === 1 \? 'its' : 'their'\} place was left alone/);
  assert.match(file, /no longer in this project \(deleted or moved\)/);
  // The project check that cannot run says so, as Add Task does.
  assert.match(file, /unchecked\.push\(s\.title\);/);
  assert.match(file, /The project check could not run for /);
  assert.doesNotMatch(file, /'the tracker did not answer\.'/, 'the words live in SUGGEST_NEXT_UNANSWERED');
  // The smaller ones: Keep and the dropdown hold still while filing; the end of filing leaves a running run's button off.
  assert.match(wire, /if \(filing\) \{ e\.target\.checked = !e\.target\.checked; return; \}/);
  assert.match(wire, /if \(filing\) \{ drawRows\(\); return; \}/);
  assert.match(file, /run\.disabled = running;/);
  assert.match(file, /Not filed: "\$\{s\.title\}"/);
  assert.match(file, /Their order was not set \(/);
  assert.match(file, /Press File in This Order again: nothing is filed twice\./);
});
