'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isoTime, statusSinceFrom, commentJson, ticketJson, failedReadsLine } = require('./ticketsJson.js');

const TASK = {
  id: 'SP-7',
  name: 'Add a thing',
  status: { status: 'In Review', type: 'custom' },
  priority: { priority: 'high', id: '2' },
  tags: [{ name: 'tracker' }, { name: 'tracker-5' }],
  date_created: '1762800000000',
  date_updated: '1762803600000',
  description: 'never printed',
  assignees: [{ id: 9, username: 'Dana' }],
};

test('isoTime: millisecond digits, numbers and ISO text all come out ISO; nonsense is null', () => {
  assert.equal(isoTime('1762800000000'), '2025-11-10T18:40:00.000Z');
  assert.equal(isoTime(1762800000000), '2025-11-10T18:40:00.000Z');
  assert.equal(isoTime('2026-11-10T17:00:00Z'), '2026-11-10T17:00:00.000Z');
  assert.equal(isoTime(null), null);
  assert.equal(isoTime(''), null);
  assert.equal(isoTime('not a time'), null);
});

test('statusSinceFrom reads ClickUp\'s Time in Status shape, and says null when it does not', () => {
  assert.equal(statusSinceFrom({ current_status: { status: 'queued', total_time: { since: '1762800000000' } } }), '2025-11-10T18:40:00.000Z');
  assert.equal(statusSinceFrom({ current_status: { status: 'queued' } }), null);
  assert.equal(statusSinceFrom(null), null);
});

test('ticketJson: the fields a check reads, and nothing else (no description, no assignee)', () => {
  assert.deepEqual(ticketJson(TASK, { statusSince: '2025-11-10T19:00:00.000Z' }), {
    id: 'SP-7',
    name: 'Add a thing',
    status: 'in review',
    priority: 'high',
    tags: ['tracker', 'tracker-5'],
    created: '2025-11-10T18:40:00.000Z',
    updated: '2025-11-10T19:40:00.000Z',
    statusSince: '2025-11-10T19:00:00.000Z',
  });
});

test('ticketJson: no priority is null, no tags is an empty list, and no comments key without comments', () => {
  const t = ticketJson({ ...TASK, priority: null, tags: undefined });
  assert.equal(t.priority, null);
  assert.deepEqual(t.tags, []);
  assert.equal(t.statusSince, null);
  assert.equal('comments' in t, false);
});

test('ticketJson with comments: top-level only, oldest first, operator or machine by the author\'s seat', () => {
  const comments = [ // newest first, as every adapter's listComments answers
    { id: '3', comment_text: 'PR opened: x', user: { id: 2, username: 'Loop' }, date: '1762800300000', parent: null },
    { id: '2', comment_text: 'a reply', user: { id: 1, username: 'Dana' }, date: '1762800200000', parent: '1' },
    { id: '1', comment_text: 'go', user: { id: 1, username: 'Dana' }, date: '1762800100000', parent: null },
  ];
  const t = ticketJson(TASK, { comments, operatorId: 1 });
  assert.deepEqual(t.comments, [
    { id: '1', author: { id: 1, name: 'Dana' }, by: 'operator', at: '2025-11-10T18:41:40.000Z', text: 'go' },
    { id: '3', author: { id: 2, name: 'Loop' }, by: 'machine', at: '2025-11-10T18:45:00.000Z', text: 'PR opened: x' },
  ]);
  assert.deepEqual(ticketJson(TASK, { comments: [] }).comments, []);
});

test('ticketJson: comments at the same moment keep the order they were written in', () => {
  const at = '1762800000000';
  const comments = [
    { id: '2', comment_text: 'second', user: { id: 2 }, date: at },
    { id: '1', comment_text: 'first', user: { id: 2 }, date: at },
  ];
  assert.deepEqual(ticketJson(TASK, { comments }).comments.map((c) => c.id), ['1', '2']);
});

test('commentJson: a ClickUp rich-text body is read as its text; no operator seat means machine', () => {
  const c = commentJson({ id: 5, comment: [{ text: 'Hello ' }, { text: 'there', attributes: { bold: true } }], user: { id: '1', username: 'Dana' }, date: 0 });
  assert.equal(c.text, 'Hello there');
  assert.equal(c.id, '5');
  assert.equal(c.by, 'machine');
  assert.equal(commentJson({ id: 5, comment_text: 'x', user: { id: '1' }, date: 0 }, { operatorId: '1' }).by, 'operator');
});

test('failedReadsLine names every failed read, and is null when there were none', () => {
  assert.equal(failedReadsLine([]), null);
  assert.equal(
    failedReadsLine([{ id: 'SP-1', what: 'comments', problem: 'HTTP 500' }, { id: 'SP-2', what: 'status history', problem: 'HTTP 0' }]),
    'tickets FAILED: 2 read(s) did not come back, so nothing was printed: SP-1 comments (HTTP 500); SP-2 status history (HTTP 0)',
  );
});
