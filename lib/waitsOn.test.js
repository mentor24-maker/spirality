'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { waitsOn, stillWaitingOn } = require('./waitsOn.js');

test('a Waits on: line names the ticket it waits on', () => {
  assert.deepEqual(waitsOn('## Goal\nBuild it.\n\nWaits on: 86bctbf46\n'), ['86bctbf46']);
});

test('several ids and links on one line, any letter case, no repeats', () => {
  const body = 'WAITS ON: https://app.clickup.com/t/86bctbf46, 86BCTBW76, https://app.clickup.com/t/90141423066/86bctbw76';
  assert.deepEqual(waitsOn(body), ['86bctbf46', '86bctbw76']);
});

test('several Waits on: lines add up', () => {
  assert.deepEqual(waitsOn('Waits on: aaa1\ntext\n  Waits on: bbb2'), ['aaa1', 'bbb2']);
});

test('a tracker-style id is accepted', () => {
  assert.deepEqual(waitsOn('Waits on: SP-12'), ['sp-12']);
});

test('formatting around an id is ignored', () => {
  assert.deepEqual(waitsOn('Waits on: `86bctbf46`.'), ['86bctbf46']);
});

test('prose that mentions waiting is not a declaration', () => {
  assert.deepEqual(waitsOn('This waits on: nothing in particular, it just reads that way.'), []);
  assert.deepEqual(waitsOn('It waits on the API ticket.'), []);
  assert.deepEqual(waitsOn(''), []);
  assert.deepEqual(waitsOn(undefined), []);
});

test('a word that is not an id is dropped, not guessed', () => {
  assert.deepEqual(waitsOn('Waits on: the API ticket'), []);
});

test('only prerequisites still open hold a ticket back', () => {
  const body = 'Waits on: aaa1, bbb2';
  assert.deepEqual(stillWaitingOn(body, new Set(['bbb2', 'ccc3'])), ['bbb2']);
  assert.deepEqual(stillWaitingOn(body, ['AAA1']), ['aaa1']);
  assert.deepEqual(stillWaitingOn(body, []), []);
  assert.deepEqual(stillWaitingOn('no declaration', ['aaa1']), []);
});
