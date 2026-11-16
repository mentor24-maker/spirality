'use strict';

// SP-349: which files each open pull request changes, decided without GitHub or the tracker.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalFiles, parseRestFiles, sharedWith, refreshPlan, sharedLine } = require('./prFiles.js');

test('normalFiles trims, drops blanks and repeats, and sorts', () => {
  assert.deepEqual(normalFiles([' b.js', 'a.js', '', 'b.js', '  ']), ['a.js', 'b.js']);
  assert.deepEqual(normalFiles([]), []);
});

test('normalFiles refuses anything that is not a list of paths, never answering "no files"', () => {
  for (const bad of [null, undefined, 'a.js', 42, { a: 1 }, ['a.js', 3], [null]]) assert.equal(normalFiles(bad), null);
});

test('parseRestFiles reads one line per changed file, both names of a rename', () => {
  const text = 'tracker/store.mjs\t\nlib/new.js\tlib/old.js\n\ndocs/a.md\t\n';
  assert.deepEqual(parseRestFiles(text), { files: ['docs/a.md', 'lib/new.js', 'lib/old.js', 'tracker/store.mjs'], count: 3 });
  assert.deepEqual(parseRestFiles(''), { files: [], count: 0 });
});

const records = [
  { ticket: 'SP-1', number: 10, files: ['a.js', 'b.js'] },
  { ticket: 'SP-2', number: 12, files: ['b.js', 'c.js'] },
  { ticket: 'SP-3', number: 11, files: ['d.js'] },
];

test('sharedWith names each other open pull request sharing a file, with only the shared files', () => {
  assert.deepEqual(sharedWith(records, ['b.js', 'd.js']), [
    { ticket: 'SP-1', number: 10, files: ['b.js'] },
    { ticket: 'SP-3', number: 11, files: ['d.js'] },
    { ticket: 'SP-2', number: 12, files: ['b.js'] },
  ]);
  assert.deepEqual(sharedWith(records, ['z.js']), []);
  assert.deepEqual(sharedWith(records, []), []);
});

test('sharedWith never says a ticket or a pull request clashes with itself', () => {
  assert.deepEqual(sharedWith(records, ['a.js', 'b.js'], { ticket: 'sp-1' }), [{ ticket: 'SP-2', number: 12, files: ['b.js'] }]);
  assert.deepEqual(sharedWith(records, ['a.js', 'b.js'], { number: 10 }), [{ ticket: 'SP-2', number: 12, files: ['b.js'] }]);
});

test('refreshPlan reads the new and the moved, forgets the closed, and counts the current', () => {
  const kept = [
    { number: 1, head: 'aaa' },
    { number: 2, head: 'bbb' },
    { number: 3, head: 'ccc' },
  ];
  const open = [
    { number: 1, headRefOid: 'aaa' },
    { number: 2, headRefOid: 'bbb2' },
    { number: 4, headRefOid: 'ddd' },
  ];
  const plan = refreshPlan({ records: kept, openPrs: open });
  assert.deepEqual(plan.read.map((p) => p.number), [2, 4]);
  assert.deepEqual(plan.forget.map((r) => r.number), [3]);
  assert.equal(plan.current, 1);
});

test('refreshPlan reads again a record with no head commit', () => {
  const plan = refreshPlan({ records: [{ number: 5, head: null }], openPrs: [{ number: 5, headRefOid: 'eee' }] });
  assert.deepEqual(plan.read.map((p) => p.number), [5]);
  assert.equal(plan.current, 0);
});

test('sharedLine is the ticket page\'s words', () => {
  assert.equal(sharedLine({ ticket: 'SP-2', number: 12, files: ['b.js', 'c.js'] }), 'Changes the same files as SP-2 (PR #12): b.js, c.js');
  assert.equal(sharedLine({ ticket: null, number: 12, files: ['b.js'] }), 'Changes the same files as PR #12: b.js');
});
