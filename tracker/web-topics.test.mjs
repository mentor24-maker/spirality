/**
 * Tests for the Topics page. One file per page (SP-352),
 * so two tickets changing two pages no longer edit one test file; what they
 * share is tracker/webTestKit.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderTopics, renderTopicEditRow, topicDeleteQuestion, renderTagEditRow, tagDeleteQuestion, tagAddressable } from './web/render.mjs';
import { pageScript } from './pageScripts.mjs';
import { WEB } from './webTestKit.mjs';

// ── Topics (SP-243) ─────────────────────────────────────────────────────────

test('Topics in the top menu opens /topics, right after Tasks, and is marked current on its own page (SP-243)', () => {
  const html = readFileSync(WEB('index.html'), 'utf8');
  assert.match(html, /<a href="\/tasks" data-nav="tasks">Tasks<\/a>\s*<a href="\/topics" data-nav="topics">Topics<\/a>/);
  const app = pageScript();
  assert.match(app, /const topicsPage = location\.pathname === '\/topics';/);
  assert.match(app, /topicsPage \? 'topics' :/, 'marked current');
  assert.match(app, /\} else if \(topicsPage\) \{\s*await drawTopics\(\);/);
});

test('the Topics page lists the picked project\'s topics newest first, every name escaped, says "No topics yet" when there are none, and has a Create Topic form (SP-243)', () => {
  const projects = [{ slug: 'alpha', name: 'Alpha <One>' }, { slug: 'beta', name: 'Beta' }];
  const project = projects[0];
  const html = renderTopics({ projects, project, topics: [
    { id: 2, name: 'Login <b>', description: 'Signing "in"', createdByName: 'Dane <D>', createdAt: '2026-11-13T12:00:00Z' },
    { id: 1, name: 'Billing', description: '', createdByName: null, createdAt: '2026-11-12T12:00:00Z' },
  ] }, { timeOf: (iso) => `at ${iso}` });
  assert.match(html, /<h1>Topics<\/h1>/);
  for (const heading of ['Name', 'Description', 'Created By', 'Created']) assert.match(html, new RegExp(`<th>${heading}</th>`), heading);
  assert.match(html, /<td class="name">Login &lt;b&gt;<\/td>/);
  assert.match(html, /<td class="about">Signing &quot;in&quot;<\/td>/);
  assert.match(html, /<td class="by">Dane &lt;D&gt;<\/td>/);
  assert.match(html, /<td class="when">at 2026-11-13T12:00:00Z<\/td>/);
  assert.ok(html.indexOf('data-topic="2"') < html.indexOf('data-topic="1"'), 'in the order the server lists them (newest first)');
  assert.match(html, /<option value="alpha" selected>Alpha &lt;One&gt;<\/option>/, 'the picked project is chosen in the picker');
  assert.match(html, /<summary><span class="fold" aria-hidden="true"><\/span>Add Topic<\/summary>/);
  assert.match(html, /<form class="create-topic fields">[\s\S]*<label for="topic-name">Name<\/label>[\s\S]*<label for="topic-description">Description<\/label>[\s\S]*<button type="submit" class="btn btn-primary">Create Topic<\/button>/);
  assert.doesNotMatch(html, /<b>|<One>|<D>/, 'nothing unescaped');
  assert.doesNotMatch(html, /No topics yet/);
  const empty = renderTopics({ projects, project, topics: [] }, { timeOf: String });
  assert.match(empty, /No topics yet\./);
  assert.doesNotMatch(empty, /<table/);
  assert.match(empty, /Create Topic<\/button>/, 'an empty project can still create one');
  assert.match(renderTopics({ projects, project, topics: [] }, { timeOf: String, problem: 'Not created: a topic needs a name.' }), /<p class="note topic-note error" role="status">Not created: a topic needs a name\.<\/p>/);
});

test('each Topics row has Edit and Delete; Edit draws the row as Name and Description boxes with Save and Cancel; Delete asks first, naming how many tasks carry it (SP-308)', () => {
  const projects = [{ slug: 'alpha', name: 'Alpha' }];
  const topic = { id: 7, name: 'Login <b>', description: 'Signing "in"', createdByName: 'Dane', createdAt: 'x', tickets: 2 };
  const html = renderTopics({ projects, project: projects[0], topics: [topic] }, { timeOf: String });
  assert.match(html, /<th>Created<\/th><th><\/th><\/tr>/, 'a heading for the buttons column');
  assert.match(html, /<td class="actions"><button type="button" class="btn btn-sm edit-topic" data-edit-topic="7" aria-label="Edit Login &lt;b&gt;">Edit<\/button>\s*<button type="button" class="btn btn-danger btn-sm delete-topic" data-delete-topic="7" aria-label="Delete Login &lt;b&gt;">Delete<\/button><\/td><\/tr>/);
  const edit = renderTopicEditRow(topic);
  assert.match(edit, /^<td colspan="5" class="edit-topic-cell"><form class="edit-topic fields" data-topic="7">/, 'fills the whole row');
  assert.match(edit, /<label for="topic-name-7">Name<\/label>\s*<input id="topic-name-7" name="name" maxlength="200" autocomplete="off" value="Login &lt;b&gt;">/);
  assert.match(edit, /<label for="topic-description-7">Description<\/label>\s*<textarea id="topic-description-7" name="description" rows="3" maxlength="5000">Signing &quot;in&quot;<\/textarea>/);
  assert.match(edit, /<button type="submit" class="btn btn-save btn-sm">Save<\/button><button type="button" class="btn btn-sm cancel-edit">Cancel<\/button>/);
  assert.doesNotMatch(edit, /<b>/, 'nothing unescaped');
  assert.equal(topicDeleteQuestion(topic), 'Delete the topic Login <b>? It comes off the 2 tasks that carry it.');
  assert.equal(topicDeleteQuestion({ name: 'Billing', tickets: 1 }), 'Delete the topic Billing? It comes off the 1 task that carries it.');
  assert.equal(topicDeleteQuestion({ name: 'Billing', tickets: 0 }), 'Delete the topic Billing? No task carries it.');
  assert.equal(topicDeleteQuestion({ name: 'Billing' }), 'Delete the topic Billing? No task carries it.');
});

test('the Topics page refuses a blank name before sending, asks before a delete, and says it worked only when the read-back shows it (SP-308)', () => {
  const app = pageScript();
  const wire = app.slice(app.indexOf('function wireTopicRows'), app.length);
  assert.match(app, /wireTopicRows\(project, topics, topicsPath, say, again\);/);
  assert.ok(wire.indexOf("if (!name) return say('Not saved: a topic needs a name.', true);") < wire.indexOf("api('PATCH'"), 'a blank name is refused before anything is sent');
  assert.ok(wire.indexOf('confirm(topicDeleteQuestion(topic))') < wire.indexOf("api('DELETE'"), 'asks before deleting');
  assert.match(wire, /listed\.name === name && listed\.description === description/, 'an edit is checked against the list read back');
  assert.match(wire, /const stillThere = !back \|\| back\.topics\?\.some\(\(x\) => x\.id === topic\.id\);/, 'a delete is checked against the list read back');
  assert.match(wire, /again\(stillThere[\s\S]*, stillThere\);/);
  assert.match(wire, /addEventListener\('click', \(\) => again\('', false\)\)/, 'Cancel draws the page again');
});

test('the Topics page is two equal halves, Topics left and Tags right, stacked Topics first on a narrow screen (SP-307)', () => {
  const projects = [{ slug: 'alpha', name: 'Alpha' }];
  const html = renderTopics({ projects, project: projects[0], topics: [], tags: [] }, { timeOf: String });
  assert.match(html, /<div class="topics-columns">\s*<section class="topics-half"[\s\S]*<\/section>\s*<section class="tags-half"[\s\S]*<\/section>\s*<\/div>$/, 'Topics first, then Tags');
  assert.match(html, /<h2 id="topics-title">Topics<\/h2>/);
  assert.match(html, /<h2 id="tags-title">Tags<\/h2>/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /\.topics-columns \{ display: grid; grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/, 'equal halves');
  assert.match(css, /@media \(max-width: 800px\) \{ \.topics-columns \{ grid-template-columns: minmax\(0, 1fr\); \} \}/, 'stacked when narrow');
});

test('Add Topic is a colex at the top of the Topics half, closed on arrival and drawn open after a refused create (SP-307)', () => {
  const projects = [{ slug: 'alpha', name: 'Alpha' }];
  const topics = [{ id: 1, name: 'Billing', description: '', createdByName: 'Dane', createdAt: 'x' }];
  const html = renderTopics({ projects, project: projects[0], topics }, { timeOf: String });
  const half = html.slice(html.indexOf('<section class="topics-half"'), html.indexOf('<section class="tags-half"'));
  assert.match(half, /<details class="colex add-topic">\s*<summary>[\s\S]*Add Topic<\/summary>\s*<form class="create-topic fields">[\s\S]*<\/form>\s*<\/details>/, 'closed, holding the form');
  assert.ok(half.indexOf('<details class="colex add-topic"') < half.indexOf('<h2 id="topics-title">'), 'the form comes before the list');
  assert.ok(half.indexOf('<h2 id="topics-title">') < half.indexOf('<table class="projects topic-list">'));
  assert.doesNotMatch(html, /<h2>Create Topic<\/h2>/, 'no separate Create Topic heading any more');
  const refused = renderTopics({ projects, project: projects[0], topics }, { timeOf: String, problem: 'Not created: no.' });
  assert.match(refused, /<details class="colex add-topic" open>/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /details\.colex\[open\] > summary \.fold::before \{ content: '▾'; \}/);
});

test('the Tags half lists the tags it is given in their order, each with its description and task count, every tag escaped (SP-307, SP-309)', () => {
  const tags = [
    { name: '<b>', description: '', count: 1 },
    { name: 'alpha', description: 'First "one"', count: 2 },
    { name: 'Beta', description: '', count: 1 },
    { name: 'design', description: 'Looks', count: 0 },
    { name: 'zeta', description: '', count: 1 },
  ];
  const projects = [{ slug: 'alpha', name: 'Alpha' }];
  const html = renderTopics({ projects, project: projects[0], topics: [], tags }, { timeOf: String });
  const half = html.slice(html.indexOf('<section class="tags-half"'));
  for (const heading of ['Tag', 'Description', 'Tasks']) assert.match(half, new RegExp(`<th>${heading}</th>`), heading);
  assert.match(half, /<tr data-tag="alpha">\s*<td class="name"><span class="tag">alpha<\/span><\/td>\s*<td class="about">First &quot;one&quot;<\/td>\s*<td class="count">2 tasks<\/td>\s*<td class="actions">/);
  assert.match(half, /<td class="name"><span class="tag">&lt;b&gt;<\/span><\/td>\s*<td class="about"><span class="quiet">none<\/span><\/td>\s*<td class="count">1 task<\/td>/);
  assert.match(half, /<tr data-tag="design">[\s\S]*?<td class="count">0 tasks<\/td>\s*<td class="actions">/, 'a saved tag no task carries yet');
  assert.doesNotMatch(half, /<b>/, 'nothing unescaped');
  assert.ok(half.indexOf('data-tag="alpha"') < half.indexOf('data-tag="Beta"') && half.indexOf('data-tag="Beta"') < half.indexOf('data-tag="zeta"'), 'alphabetical');
  assert.match(renderTopics({ projects, project: projects[0], topics: [], tags: [] }, { timeOf: String }), /<p class="quiet no-tags">No tags yet\.<\/p>/);
  assert.match(renderTopics({ projects, project: projects[0], topics: [], tags: null }, { timeOf: String }), /<p class="note error no-tags">The tags could not be read\./, 'an unread board says so, never "No tags yet"');
});

test('the Topics page reads the project\'s tags from its tags route, and unread tags leave the topics working (SP-307, SP-309)', () => {
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawTopics'), app.length);
  assert.match(draw, /const tagsPath = `\/projects\/\$\{encodeURIComponent\(project\.slug\)\}\/tags`;/);
  assert.match(draw, /api\('GET', tagsPath\)\.then\(\(r\) => \(Array\.isArray\(r\?\.tags\) \? r\.tags : null\), \(err\) => \{ if \(err instanceof SignedOut\) throw err; return null; \}\)/);
  assert.match(draw, /renderTopics\(\{ projects, project, topics, tags \}/);
});

test('Add Tag is a colex at the top of the Tags half, beside Add Topic, closed on arrival and drawn open only after a refused tag create (SP-309)', () => {
  const projects = [{ slug: 'alpha', name: 'Alpha' }];
  const html = renderTopics({ projects, project: projects[0], topics: [], tags: [] }, { timeOf: String });
  const half = html.slice(html.indexOf('<section class="tags-half"'));
  assert.match(half, /<details class="colex add-tag">\s*<summary><span class="fold" aria-hidden="true"><\/span>Add Tag<\/summary>\s*<form class="create-tag fields">[\s\S]*<label for="tag-name">Name<\/label>[\s\S]*<label for="tag-description">Description<\/label>[\s\S]*<button type="submit" class="btn btn-primary">Create Tag<\/button>\s*<\/div>\s*<\/form>\s*<\/details>/);
  assert.ok(half.indexOf('<details class="colex add-tag"') < half.indexOf('<h2 id="tags-title">'), 'the form comes before the list');
  const tagRefused = renderTopics({ projects, project: projects[0], topics: [], tags: [] }, { timeOf: String, problem: 'Not created: no.', problemIn: 'tag' });
  assert.match(tagRefused, /<details class="colex add-tag" open>/);
  assert.match(tagRefused, /<details class="colex add-topic">/, 'Add Topic stays shut');
  const topicRefused = renderTopics({ projects, project: projects[0], topics: [], tags: [] }, { timeOf: String, problem: 'Not created: no.' });
  assert.match(topicRefused, /<details class="colex add-tag">/);
  assert.match(topicRefused, /<details class="colex add-topic" open>/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /form\.create-topic, form\.create-tag \{ max-width: 40rem; \}/, 'styled as Add Topic is');
});

test('Add Tag refuses a blank name before sending, and says a create worked only when the tag reads back with 0 tasks (SP-309)', () => {
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawTopics'), app.length);
  assert.match(draw, /if \(!name\) return say\('Not created: a tag needs a name\.', true\);/);
  assert.ok(draw.indexOf("a tag needs a name") < draw.indexOf("api('POST', tagsPath"), 'refused before anything is sent');
  assert.match(draw, /api\('GET', tagsPath, undefined, \{ unrecorded: true \}\)/, 'the list is read back');
  assert.match(draw, /const listed = back\?\.tags\?\.some\(\(t\) => t\.name === made\.name && t\.count === 0\);/);
  assert.match(draw, /again\(listed \? `Created the tag \$\{made\.name\} in \$\{project\.name\}\.` : `The tracker said the tag \$\{made\.name\} was created, but /);
  assert.match(draw, /, !listed, 'tag'\);/, 'a failed read-back opens Add Tag again');
});

test('each Tags row has Edit and Delete; Edit draws the row as Name and Description boxes with Save and Cancel; Delete asks first, naming how many tasks carry it (SP-310)', () => {
  const projects = [{ slug: 'alpha', name: 'Alpha' }];
  const tag = { name: 'ui <b>', description: 'Looks "good"', count: 2 };
  const html = renderTopics({ projects, project: projects[0], topics: [], tags: [tag] }, { timeOf: String });
  const half = html.slice(html.indexOf('<section class="tags-half"'));
  assert.match(half, /<th>Tasks<\/th><th><\/th><\/tr>/, 'a heading for the buttons column');
  assert.match(half, /<td class="actions"><button type="button" class="btn btn-sm edit-tag" data-edit-tag="ui &lt;b&gt;" aria-label="Edit ui &lt;b&gt;">Edit<\/button>\s*<button type="button" class="btn btn-danger btn-sm delete-tag" data-delete-tag="ui &lt;b&gt;" aria-label="Delete ui &lt;b&gt;">Delete<\/button><\/td><\/tr>/);
  const edit = renderTagEditRow(tag, 3);
  assert.match(edit, /^<td colspan="4" class="edit-tag-cell"><form class="edit-tag fields" data-tag="ui &lt;b&gt;">/, 'fills the whole row');
  assert.match(edit, /<label for="tag-name-3">Name<\/label>\s*<input id="tag-name-3" name="name" maxlength="100" autocomplete="off" value="ui &lt;b&gt;">/);
  assert.match(edit, /<label for="tag-description-3">Description<\/label>\s*<textarea id="tag-description-3" name="description" rows="3" maxlength="5000">Looks &quot;good&quot;<\/textarea>/);
  assert.match(edit, /<button type="submit" class="btn btn-save btn-sm">Save<\/button><button type="button" class="btn btn-sm cancel-edit">Cancel<\/button>/);
  assert.doesNotMatch(edit, /<b>/, 'nothing unescaped');
  assert.match(renderTagEditRow({ name: 'x' }, -1), /id="tag-name-0"/, 'a bad index falls back to 0');
  assert.equal(tagDeleteQuestion(tag), 'Delete the tag ui <b>? It comes off the 2 tasks that carry it.');
  assert.equal(tagDeleteQuestion({ name: 'page', count: 1 }), 'Delete the tag page? It comes off the 1 task that carries it.');
  assert.equal(tagDeleteQuestion({ name: 'page', count: 0 }), 'Delete the tag page? No task carries it.');
  assert.equal(tagDeleteQuestion({ name: 'page' }), 'Delete the tag page? No task carries it.');
  for (const name of ['ui', '...', 'a/b', '.x']) assert.equal(tagAddressable(name), true, name);
  for (const name of ['.', '..', '', null]) assert.equal(tagAddressable(name), false, String(name));
});

test('the Tags rows refuse a blank name before sending, ask before a delete, and say it worked only when the read-back shows it (SP-310)', () => {
  const app = pageScript();
  const wire = app.slice(app.indexOf('function wireTagRows'), app.indexOf('/**\n * SP-308: each Topics row'));
  assert.match(app, /if \(Array\.isArray\(tags\)\) wireTagRows\(project, tags, tagsPath, say, again\);/, 'wired only when the tags were read');
  assert.ok(wire.indexOf("if (!name) return say('Not saved: a tag needs a name.', true);") < wire.indexOf("api('PATCH'"), 'a blank name is refused before anything is sent');
  assert.ok(wire.indexOf('confirm(tagDeleteQuestion(tag))') < wire.indexOf("api('DELETE'"), 'asks before deleting');
  assert.ok(wire.indexOf('if (unsendable(tag))') < wire.indexOf("api('PATCH'") && wire.lastIndexOf('if (unsendable(tag))') < wire.indexOf("api('DELETE'"), 'a dot-only name is never sent');
  assert.match(wire, /const pathOf = \(name\) => `\$\{tagsPath\}\/\$\{encodeURIComponent\(name\)\}`;/, 'the name is encoded into the address');
  assert.match(wire, /listed && oldGone && listed\.description === description && listed\.count === tag\.count/, 'an edit is checked against the list read back');
  assert.match(wire, /const stillThere = !back \|\| back\.tags\?\.some\(\(x\) => x\.name === tag\.name\);/, 'a delete is checked against the list read back');
  assert.match(wire, /again\(stillThere[\s\S]*, stillThere, 'tag'\);/);
  assert.match(wire, /addEventListener\('click', \(\) => again\('', false, 'tag'\)\)/, 'Cancel draws the page again');
});

test('the Topics page refuses a blank name before sending, and says a create worked only when the topic reads back in the list (SP-243)', () => {
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawTopics'), app.length);
  assert.match(draw, /if \(!name\) return say\('Not created: a topic needs a name\.', true\);/);
  assert.ok(draw.indexOf("if (!name)") < draw.indexOf("api('POST', topicsPath"), 'refused before anything is sent');
  assert.match(draw, /api\('GET', topicsPath, undefined, \{ unrecorded: true \}\)/, 'the list is read back');
  assert.match(draw, /back\?\.topics\?\.some\(\(t\) => t\.id === made\.id\)/);
  assert.match(draw, /localStorage\.setItem\(PROJECT_KEY, chosen\.slug\)/, 'picking a project here selects it');
});
