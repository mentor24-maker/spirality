/**
 * Tests for the API Usage report (/reporting/usage, SP-398). One file per
 * page (SP-352); what pages share is tracker/webTestKit.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderUsage, renderUsageEditRow, usageDeleteQuestion, usageCountLine, filterUsage, sortUsage, readUsageForm, tokens, localInputValue,
} from './web/render.mjs';
import { pageScript } from './pageScripts.mjs';

const timeOf = (iso) => `at ${iso}`;
const row = (over) => ({
  id: 1, project: 'alpha', at: '2026-11-19T18:00:00.000Z', action: '/loop-build', model: 'claude-opus-5-5', ticket: 'SP-12',
  input: 5, output: 1500, cacheWrite: 20000, cacheRead: 1000000, total: 1021505, session: 's', ...over,
});
const projects = [{ slug: 'alpha', name: 'Alpha <One>' }, { slug: 'beta', name: 'Beta' }];

test('/reporting/usage draws the API Usage report, marked under Reporting, and the Reporting page links to it', () => {
  const app = pageScript();
  assert.match(app, /const usagePage = location\.pathname === '\/reporting\/usage';/);
  assert.match(app, /const reporting = location\.pathname === '\/reporting' \|\| usagePage;/, 'Reporting stays marked in the top menu');
  assert.match(app, /\} else if \(usagePage\) \{\s*await drawUsage\(\);\s*\} else if \(reporting\) \{/, 'drawn before Reporting, which it is part of');
  assert.match(app, /<a href="\/reporting\/usage">API Usage<\/a>/);
});

test('the report has one title row with the Project picker and Add Usage, totals per model with an All Models row, and every action with its ticket linked, counts marked and Edit and Delete', () => {
  const usage = {
    rows: [row({ id: 2, model: 'claude-haiku-5-5', ticket: null, input: 1, output: 0, cacheWrite: 0, cacheRead: 0, total: 1 }), row({ action: '<b>x</b>' })],
    byModel: [
      { model: 'claude-opus-5-5', actions: 1, input: 5, output: 1500, cacheWrite: 20000, cacheRead: 1000000, total: 1021505 },
      { model: 'claude-haiku-5-5', actions: 1, input: 1, output: 0, cacheWrite: 0, cacheRead: 0, total: 1 },
    ],
  };
  const html = renderUsage({ projects, project: projects[0], usage }, { timeOf, now: '2026-11-19T18:00:00Z' });
  assert.match(html, /^<div class="title-row"><h1>API Usage<\/h1>/);
  assert.equal((html.match(/btn-primary/g) ?? []).length, 1, 'one main action');
  assert.match(html, /aria-expanded="false" aria-controls="add-usage">Add Usage<\/button>/);
  assert.match(html, /<section id="add-usage" class="add-usage" hidden/);
  assert.match(html, /Alpha &lt;One&gt;/);
  assert.doesNotMatch(html, /<b>x<\/b>/, 'every word escaped');
  assert.match(html, /<td class="name">All Models<\/td><td class="count">2<\/td>.*<td class="count total">1,021,506<\/td>/s);
  assert.match(html, /<td class="ticket"><a href="\/t\/SP-12">SP-12<\/a><\/td>/);
  assert.match(html, /<td class="ticket"><span class="quiet">none<\/span><\/td>/);
  assert.match(html, /<td class="count">1,000,000<\/td>/);
  for (const label of ['When', 'Action', 'Ticket', 'Model', 'Input', 'Output', 'Cache Write', 'Cache Read', 'Total Tokens']) {
    assert.match(html, new RegExp(`data-sort="[a-zA-Z]+">${label}</button>`), label);
  }
  assert.match(html, /data-edit-usage="2"[^>]*>Edit<\/button>/);
  assert.match(html, /class="btn btn-danger btn-sm" data-delete-usage="2"[^>]*>Delete<\/button>/);
  assert.match(html, /<p class="quiet usage-count">2 actions<\/p>/);
});

test('with nothing recorded the report says why and how rows arrive', () => {
  const html = renderUsage({ projects, project: projects[1], usage: { rows: [], byModel: [] } }, { timeOf });
  assert.match(html, /Nothing recorded for Beta yet\. Each loop pass adds its rows when it ends; Add Usage records one by hand\./);
  assert.match(html, /No tokens recorded yet\./);
});

test('the Model picker and Find box narrow the rows, and each column sorts both ways, ties kept in order', () => {
  const rows = [row({ id: 1, action: '/loop-build', ticket: 'SP-9', total: 30, at: '2026-11-19T10:00:00Z' }),
    row({ id: 2, action: '/loop-review', model: 'claude-haiku-5-5', ticket: 'SP-10', total: 10, at: '2026-11-19T12:00:00Z' }),
    row({ id: 3, action: 'Hand-run session', ticket: null, total: 20, at: '2026-11-19T11:00:00Z' })];
  assert.deepEqual(filterUsage(rows, { model: 'claude-haiku-5-5' }).map((r) => r.id), [2]);
  assert.deepEqual(filterUsage(rows, { text: 'REVIEW' }).map((r) => r.id), [2]);
  assert.deepEqual(filterUsage(rows, { text: 'sp-9' }).map((r) => r.id), [1]);
  assert.deepEqual(sortUsage(rows, { column: 'total', direction: 'descending' }).map((r) => r.id), [1, 3, 2]);
  assert.deepEqual(sortUsage(rows, { column: 'at', direction: 'ascending' }).map((r) => r.id), [1, 3, 2]);
  assert.deepEqual(sortUsage(rows, { column: 'ticket', direction: 'ascending' }).map((r) => r.id), [1, 2, 3], 'numbers in order, none last');
  assert.deepEqual(sortUsage(rows, null).map((r) => r.id), [1, 2, 3]);
  assert.equal(usageCountLine(1, 3), '1 of 3 actions');
  assert.equal(usageCountLine(1, 1), '1 action');
});

test('a form is refused on the page, before anything is sent, without an action, a model, a time or with a bad count; a blank ticket is none', () => {
  const form = (over) => (name) => ({ at: '2026-11-19T11:05', action: 'Hand-run session', model: 'claude-opus-5-5', ticket: ' ', input: '', output: '12', cacheWrite: '0', cacheRead: '3', ...over })[name];
  const ok = readUsageForm(form({}));
  assert.deepEqual({ ...ok.body, at: undefined }, { at: undefined, action: 'Hand-run session', model: 'claude-opus-5-5', ticket: null, input: 0, output: 12, cacheWrite: 0, cacheRead: 3 });
  assert.equal(ok.body.at, new Date('2026-11-19T11:05').toISOString(), 'the box is read in this computer\'s own time zone');
  assert.match(readUsageForm(form({ action: '  ' })).problem, /say what the action was/);
  assert.match(readUsageForm(form({ model: '' })).problem, /which model/);
  assert.match(readUsageForm(form({ at: '' })).problem, /date and time/);
  assert.match(readUsageForm(form({ output: '1.5' })).problem, /Output Tokens is a whole number/);
  assert.match(readUsageForm(form({ cacheRead: '-2' })).problem, /Cache Read Tokens/);
});

test('a row being edited holds its own values with Save and Cancel, and Delete asks first naming what it spent', () => {
  const html = renderUsageEditRow(row({ id: 7 }));
  assert.match(html, /<form class="edit-usage fields" data-usage="7">/);
  assert.match(html, new RegExp(`id="usage-at-7" name="at" type="datetime-local" value="${localInputValue('2026-11-19T18:00:00.000Z')}"`));
  assert.match(html, /id="usage-ticket-7" name="ticket"[^>]*value="SP-12"/);
  assert.match(html, /id="usage-cacheRead-7" name="cacheRead"[^>]*value="1000000"/);
  assert.match(html, /class="btn btn-save btn-sm">Save<\/button><button type="button" class="btn btn-sm cancel-edit">Cancel<\/button>/);
  assert.equal(usageDeleteQuestion(row({})), 'Delete this row? /loop-build on SP-12, claude-opus-5-5: 1,021,505 tokens. It comes off the report for good.');
  assert.equal(tokens(0), '0');
  assert.equal(localInputValue('not a time'), '');
});
