/**
 * SP-403: every filter bar on the tracker reads the same way. One project
 * picker (renderProjectPicker) on every page that has one, labelled
 * "Project:" and offering "All Projects" spelled one way; one order for the
 * controls (renderFilterBar); one word, "Any", for "no filter" on every
 * picker but Project; and one CSS look.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderProjectPicker, renderFilterBar, renderTopicPicker, renderClassFilters, ALL_PROJECTS_CHOICE } from './web/render.mjs';
import { WEB } from './webTestKit.mjs';
import { PAGE_SCRIPTS, RENDER_SCRIPTS } from './pageScripts.mjs';

/** The pages with a project picker (SP-403's Scope), each by the file that draws its bar. */
const PICKER_PAGES = Object.freeze({
  'Board and List': 'page-tasks.mjs',
  Console: 'page-console.mjs',
  Topics: 'render-topics.mjs',
  'API Usage': 'render-usage.mjs',
  Reporting: 'page-reporting.mjs',
});

/** The pages that can show every project, so offer All Projects first. */
const ALL_PROJECT_PAGES = Object.freeze(['page-tasks.mjs', 'page-console.mjs', 'page-reporting.mjs']);

const PROJECTS = [{ slug: 'alpha', name: 'Alpha' }, { slug: 'beta', name: 'Beta' }];
const POD = '<button type="button" class="pipeline-pod" aria-haspopup="dialog" title="Open Pipeline Status"></button>';
const SEARCH = '<form class="search" role="search"><input type="search" name="q"></form>';

const source = (file) => readFileSync(WEB(file), 'utf8');

/** Every web source file, page code and drawing both, by name. */
const webSources = () => Object.fromEntries([...PAGE_SCRIPTS, ...RENDER_SCRIPTS].map((f) => [f, source(f)]));

test('every page with a project picker draws it through the one shared renderProjectPicker; no page builds its own project <select> (SP-403)', () => {
  for (const [page, file] of Object.entries(PICKER_PAGES)) {
    assert.match(source(file), /renderProjectPicker\(/, `${page} (${file}) draws the shared picker`);
  }
  // A <select> whose options are a list of projects, built by hand. The one
  // allowed is the Add Task box's "which project does this go into" field
  // (id add-project), which is a form field, not a filter.
  const handBuilt = /<select\b([^>]*)>(?:<option[^>]*>[^<]*<\/option>)*\$\{[\w.]*projects\.map\(/g;
  for (const [file, text] of Object.entries(webSources())) {
    for (const m of text.matchAll(handBuilt)) {
      assert.match(m[1], /id="add-project"/, `${file} builds its own project picker: ${m[0].slice(0, 80)}`);
    }
  }
  assert.doesNotMatch(source('page-reporting.mjs'), /report-project/, 'Reporting\'s own picker is gone');
});

test('every project picker reads "Project:" and offers "All Projects", spelled the same, where the page can show every project (SP-403)', () => {
  assert.equal(ALL_PROJECTS_CHOICE, 'All Projects', 'Title Case (UI_DOCTRINE)');
  const every = renderProjectPicker(PROJECTS, '', { all: true });
  assert.equal(every, '<label class="project-picker">Project: <select name="project"><option value="" selected>All Projects</option><option value="alpha">Alpha</option><option value="beta">Beta</option></select></label>');
  assert.match(renderProjectPicker(PROJECTS, 'beta', { all: true }), /<option value="">All Projects<\/option><option value="alpha">Alpha<\/option><option value="beta" selected>Beta<\/option>/);
  assert.doesNotMatch(renderProjectPicker(PROJECTS, 'alpha'), /All Projects|value=""/, 'a one-project page has no All Projects');
  for (const file of ALL_PROJECT_PAGES) {
    assert.match(source(file), /renderProjectPicker\([^)]*\{ all: true \}\)/, `${file} offers All Projects through the shared words`);
  }
  // Nobody spells it another way: no option, anywhere, reads "All projects" or "All Projects" by hand.
  for (const [file, text] of Object.entries(webSources())) {
    assert.doesNotMatch(text, /<option[^>]*>All [Pp]rojects/, `${file} types its own All Projects choice`);
    assert.doesNotMatch(text, /all: '/, `${file} passes its own words for All Projects`);
  }
});

test('the filter bar comes in one order: Project, the other pickers, search, the pod, then what follows (SP-403)', () => {
  const classes = [{ key: 'kind', label: 'Kind', options: [{ value: 'feature', label: 'Feature' }] }];
  // The parts handed over in a scrambled order still draw in the one order.
  const html = renderFilterBar({
    after: '<div class="feature-key"></div>',
    pod: POD,
    search: SEARCH,
    pickers: [renderTopicPicker([{ id: 1, name: 'Board' }]), renderClassFilters(classes, {})],
    project: renderProjectPicker(PROJECTS, 'alpha', { all: true }),
  });
  const at = ['class="project-picker"', 'class="topic-picker"', 'class="class-filters"', 'class="search"', 'class="pipeline-pod"', 'class="feature-key"'].map((c) => html.indexOf(c));
  assert.ok(at.every((i) => i !== -1), 'every part is drawn');
  assert.deepEqual(at.slice().sort((a, b) => a - b), at, 'Project first, then Topic and the class filters, search, the pod, the key');
  assert.ok(html.startsWith('<label class="project-picker">Project: '), 'the bar starts with "Project:"');
  // The Console's bar: Project, the pod, the Features key; nothing missing leaves a gap.
  assert.equal(renderFilterBar({ project: 'P', pod: 'D', after: 'K' }), 'PDK');
  assert.equal(renderFilterBar({ project: 'P', pickers: ['', 'T'], search: '' }), 'PT');
  // Board, List and Console all draw their bar through it.
  for (const file of ['page-tasks.mjs', 'page-console.mjs', 'page-reporting.mjs']) {
    assert.match(source(file), /renderFilterBar\(\{\s*project: renderProjectPicker\(/, `${file} draws its bar through renderFilterBar, Project first`);
  }
  // On Board, List and Console the pod is handed in the same slot.
  for (const file of ['page-tasks.mjs', 'page-console.mjs']) {
    assert.match(source(file), /pod: '<button type="button" class="pipeline-pod"/, `${file}: the pod in the pod slot`);
  }
});

test('pickers that mean "no filter" all say "Any": Topic, Kind, Started By, How It Ended, and Reporting\'s Kind (SP-403)', () => {
  assert.match(renderTopicPicker([]), /<option value="" selected>Any<\/option>/);
  const classes = [{ key: 'kind', label: 'Kind', options: [] }];
  assert.match(renderClassFilters(classes, {}), /<label>Kind: <select name="kind"><option value="" selected>Any<\/option>/);
  const reporting = source('page-reporting.mjs');
  assert.match(reporting, /<label class="kind-picker">Kind: <select id="report-kind"><option value="">Any<\/option>/, 'Reporting\'s Kind: "Kind:" and "Any", as on Tasks');
  assert.doesNotMatch(reporting, /All Kinds/);
});

test('every filter bar shares one look: the same label style and the same wrapping on a narrow window (SP-403)', () => {
  const css = source('app.css');
  assert.match(css, /\.project-picker, \.topic-picker, \.kind-picker, \.class-filters label, form\.search label \{ font-weight: 600; display: flex; align-items: center; gap: var\(--space-3\); \}/);
  assert.match(css, /\.tasks-bar, form\.report-scope \{ flex-wrap: wrap; justify-content: flex-start; gap: var\(--space-5\) var\(--space-7\); \}/);
  assert.doesNotMatch(css, /\.toolbar \.project-picker/, 'the label look is not tied to one kind of bar');
  assert.match(source('page-tasks.mjs'), /<label for="search-q">Search:<\/label>/, 'Search reads like the pickers: "Search:"');
});
