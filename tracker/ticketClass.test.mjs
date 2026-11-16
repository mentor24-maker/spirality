// The ticket page's and the Tasks page's class controls (SP-345): Kind,
// Started By and How It Ended, drawn from the server's choices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEditPanel, renderClassFilters, filterByClass, NO_CLASS } from './web/render.mjs';

const choices = {
  priorities: ['urgent', 'high', 'normal', 'low'],
  statuses: [{ value: 'queued', label: 'Queued' }, { value: 'live', label: 'Live' }],
  kind: [{ value: 'feature', label: 'Feature' }, { value: 'fix', label: 'Fix' }],
  startedBy: [{ value: 'operator', label: 'Operator' }, { value: 'agent', label: 'Agent Session' }],
  outcome: [{ value: 'done', label: 'Done' }, { value: 'wont-do', label: "Won't Do" }],
};

test('the Change panel shows Kind and Started By as pickers that save, the current value chosen', () => {
  const html = renderEditPanel({ name: 'n', status: 'queued', choices, kind: 'fix', startedBy: null });
  assert.match(html, /<label for="edit-kind">Kind<\/label>/);
  assert.match(html, /<select id="edit-kind" data-field="kind">/);
  assert.match(html, /<option value="fix" selected>Fix<\/option>/);
  assert.match(html, /<label for="edit-started-by">Started By<\/label>/);
  assert.match(html, /<select id="edit-started-by" data-field="startedBy"><option value="" selected>None<\/option>/);
});

test('How It Ended waits for the ticket to close, then saves like the others', () => {
  const open = renderEditPanel({ name: 'n', status: 'queued', choices });
  assert.match(open, /<select id="edit-outcome" disabled[^>]*><option selected>Still Open<\/option><\/select>/);
  assert.doesNotMatch(open, /data-field="outcome"/);
  const live = renderEditPanel({ name: 'n', status: 'Live', choices, outcome: 'wont-do' });
  assert.match(live, /<select id="edit-outcome" data-field="outcome">/);
  assert.match(live, /<option value="wont-do" selected>Won&#39;t Do<\/option>/);
});

test('a value the server no longer offers still shows, marked (now)', () => {
  const html = renderEditPanel({ name: 'n', status: 'queued', choices, kind: 'chore' });
  assert.match(html, /<option value="chore" selected>chore \(now\)<\/option>/);
});

const classes = [
  { key: 'kind', label: 'Kind', options: [{ value: 'feature', label: 'Feature' }, { value: 'operational', label: 'Operational' }] },
  { key: 'startedBy', label: 'Started By', options: [{ value: 'agent', label: 'Agent Session' }] },
];

test('the Tasks page draws one filter per field: Any, None, then the choices, the picked one chosen', () => {
  const html = renderClassFilters(classes, { kind: 'operational' });
  assert.match(html, /<div class="class-filters"/);
  assert.match(html, /<label>Kind: <select name="kind"><option value="">Any<\/option><option value="none">None<\/option><option value="feature">Feature<\/option><option value="operational" selected>Operational<\/option><\/select><\/label>/);
  assert.match(html, /<select name="startedBy"><option value="" selected>Any<\/option>/);
  assert.equal(renderClassFilters([], {}), '');
  assert.equal(renderClassFilters(undefined), '');
});

test('filterByClass keeps every column and only the tickets every chosen filter lets through', () => {
  const columns = [
    { status: 'Queued', tickets: [{ id: 'A', kind: 'feature', startedBy: 'agent' }, { id: 'B', kind: 'operational', startedBy: 'agent' }, { id: 'C', kind: null, startedBy: null }] },
    { status: 'Live', tickets: [{ id: 'D', kind: 'feature', startedBy: 'operator' }] },
  ];
  assert.equal(filterByClass(columns, {}), columns);
  assert.equal(filterByClass(columns, { kind: '' }), columns);
  const ids = (cols) => cols.map((c) => [c.status, c.tickets.map((t) => t.id)]);
  assert.deepEqual(ids(filterByClass(columns, { kind: 'feature' })), [['Queued', ['A']], ['Live', ['D']]]);
  assert.deepEqual(ids(filterByClass(columns, { kind: 'feature', startedBy: 'agent' })), [['Queued', ['A']], ['Live', []]]);
  assert.deepEqual(ids(filterByClass(columns, { kind: NO_CLASS })), [['Queued', ['C']], ['Live', []]]);
  assert.equal(columns[0].tickets.length, 3, 'the columns given are not changed');
});
