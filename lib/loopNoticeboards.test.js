'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const boards = require('./loopNoticeboards.js');
const throughput = require('./loopThroughput.js');

test('a ticket tagged noticeboard is a noticeboard, in either tag shape and any capitals (SP-356)', () => {
  assert.equal(boards.NOTICEBOARD_TAG, 'noticeboard');
  assert.equal(boards.isNoticeboard({ name: 'Pipeline pulse', tags: [{ name: 'noticeboard' }] }), true, 'the door\'s ClickUp shape');
  assert.equal(boards.isNoticeboard({ name: 'Node roll call', tags: ['Noticeboard'] }), true, 'the tracker\'s plain words');
  assert.equal(boards.isNoticeboard({ name: 'Fix the login page', tags: [{ name: 'bus-into-project' }] }), false);
  assert.equal(boards.isNoticeboard({ name: 'Fix the login page' }), false, 'no tags at all');
  assert.equal(boards.isNoticeboard({ name: 'Fix it', tags: 'noticeboard' }), false, 'tags that are not a list are none');
});

test('Team chat and the pause switch still count by name, with no tag', () => {
  assert.equal(boards.isNoticeboard({ name: 'Team chat' }), true);
  assert.equal(boards.isNoticeboard({ name: ' TEAM CHAT ' }), true);
  for (const name of boards.NOTICEBOARD_NAMES) assert.equal(boards.isNoticeboard({ name }), true, name);
});

test('workTickets and the throughput watchdog leave a tagged noticeboard out', () => {
  const tasks = [
    { id: '1', name: 'SQL waiting for you', tags: [{ name: 'noticeboard' }], status: { status: 'live' } },
    { id: '2', name: 'Team chat', status: { status: 'live' } },
    { id: '3', name: 'Build the thing', tags: [], status: { status: 'live' } },
  ];
  assert.deepEqual(boards.workTickets(tasks).map((t) => t.id), ['3']);
  assert.deepEqual(throughput.workTickets(tasks).map((t) => t.id), ['3']);
  assert.deepEqual(boards.workTickets(null), []);
});
