'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { HUMAN_HOURS_MAX, parseHumanHours, humanHoursLine, findHumanHours } = require('./humanHours.js');
const { prOpenedComment } = require('./loopTrail.js');
const { findPullRequest } = require('./mergeOnComment.js');

const PR = 'https://github.com/owner/repo/pull/';

let nextId = 1;
function c(t, text) {
  return { id: String(nextId++), date: String(1000 + t), comment_text: text };
}

test('whole and half hours, more than 0 and at most the cap, are accepted', () => {
  assert.deepEqual(parseHumanHours('6'), { ok: true, hours: 6 });
  assert.deepEqual(parseHumanHours('2.5'), { ok: true, hours: 2.5 });
  assert.deepEqual(parseHumanHours('0.5'), { ok: true, hours: 0.5 });
  assert.deepEqual(parseHumanHours(String(HUMAN_HOURS_MAX)), { ok: true, hours: 200 });
});

test('0, a negative number, more than the cap, a quarter hour or a word are refused, each saying why', () => {
  assert.match(parseHumanHours('0').why, /more than 0/);
  assert.match(parseHumanHours('-3').why, /more than 0/);
  assert.match(parseHumanHours('201').why, /at most 200/);
  assert.match(parseHumanHours('2.25').why, /whole or half/);
  assert.match(parseHumanHours('six').why, /not a number/);
  assert.match(parseHumanHours('').why, /not a number/);
  assert.match(parseHumanHours(null).why, /not a number/);
});

test('the estimate pr-opened writes is the estimate the reader finds', () => {
  const comments = [c(1, prOpenedComment(`${PR}7`, 'Why that estimate: one module and its tests.', { humanHours: 6 }))];
  assert.equal(findHumanHours(comments), 6);
  assert.match(comments[0].comment_text, /^PR opened: \S+\nHuman-hours estimate: 6\n\nWhy that estimate/);
  assert.equal(humanHoursLine(2.5), 'Human-hours estimate: 2.5');
});

test('no estimate is nothing: no PR line, or a PR line without the estimate', () => {
  assert.equal(findHumanHours([]), null);
  assert.equal(findHumanHours(undefined), null);
  assert.equal(findHumanHours([c(1, 'Human-hours estimate: 6')]), null);
  assert.equal(findHumanHours([c(1, prOpenedComment(`${PR}7`))]), null);
});

test('the newest PR opened comment wins, even when it carries no estimate', () => {
  const older = c(1, prOpenedComment(`${PR}7`, '', { humanHours: 6 }));
  const rebuilt = c(9, prOpenedComment(`${PR}8`, '', { humanHours: 3 }));
  assert.equal(findHumanHours([rebuilt, older]), 3);
  assert.equal(findHumanHours([older, c(9, prOpenedComment(`${PR}8`))]), null);
});

test('an estimate line the writer could not have written reads as nothing', () => {
  assert.equal(findHumanHours([c(1, `PR opened: ${PR}7\nHuman-hours estimate: 900`)]), null);
  assert.equal(findHumanHours([c(1, `PR opened: ${PR}7\nHuman-hours estimate: about six`)]), null);
});

test('the merge step still reads a PR opened comment that carries an estimate', () => {
  const found = findPullRequest([c(1, prOpenedComment(`${PR}12`, 'note', { humanHours: 4 }))]);
  assert.equal(found.number, 12);
  assert.equal(found.url, `${PR}12`);
});
