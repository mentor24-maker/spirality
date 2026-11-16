'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readWaitsOn, waitsOn, waitsOnText, holdReasons } = require('./waitsOn.js');

test('a Waits on: line names the ticket it waits on', () => {
  assert.deepEqual(waitsOn('## Goal\nBuild it.\n\nWaits on: 86bctbf46\n'), ['86bctbf46']);
});

test('a tracker id waits as itself, any case (SP-32)', () => {
  assert.deepEqual(waitsOn('Waits on: SP-12'), ['sp-12']);
  assert.deepEqual(waitsOn('- **Waits on:** SP-12, sp-3'), ['sp-12', 'sp-3']);
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

test('a list marker, bold, italic or quote around the marker still counts (the markdown keeps them)', () => {
  for (const line of ['*   Waits on: aaa1', '- Waits on: aaa1', '+ Waits on: aaa1', '1. Waits on: aaa1',
    '**Waits on:** aaa1', '*Waits on:* aaa1', '> Waits on: aaa1', '> - **Waits on:** `aaa1`', '**Waits on: aaa1**']) {
    assert.deepEqual(readWaitsOn(`## Scope\n${line}\n`), { ids: ['aaa1'], unparsed: [] }, line);
  }
});

test('a link in angle brackets or a markdown link is read', () => {
  assert.deepEqual(waitsOn('Waits on: <https://app.clickup.com/t/aaa1>, [x](https://app.clickup.com/t/9/bbb2)'), ['aaa1', 'bbb2']);
});

test('a Waits on: line naming something that is not an id is reported, never dropped', () => {
  assert.deepEqual(readWaitsOn('Waits on: the API ticket').unparsed, ['the API ticket']);
  assert.deepEqual(readWaitsOn('Waits on: aaa1 (the API ticket)').unparsed, ['aaa1 (the API ticket)']);
  assert.deepEqual(readWaitsOn('Waits on: aaa1 and bbb2').unparsed, ['aaa1 and bbb2']);
  assert.deepEqual(readWaitsOn('Waits on: aaa1; bbb2').unparsed, ['aaa1; bbb2']);
  assert.deepEqual(readWaitsOn('Waits on: aaa1 and https://app.clickup.com/t/bbb2').unparsed, ['aaa1 and https://app.clickup.com/t/bbb2']);
  assert.deepEqual(readWaitsOn('- **Waits on:**').unparsed, ['(nothing named)']);
  assert.deepEqual(readWaitsOn('Waits on: aaa1, the API one'), { ids: ['aaa1'], unparsed: ['the API one'] });
});

test('queue and claim read the same text: markdown first, plain as the fallback', () => {
  assert.equal(waitsOnText({ markdown_description: '- Waits on: aaa1', description: 'Waits on: aaa1' }), '- Waits on: aaa1');
  assert.equal(waitsOnText({ description: 'Waits on: aaa1' }), 'Waits on: aaa1');
  assert.equal(waitsOnText({}), '');
});

test('only prerequisites still open hold a ticket back', () => {
  const t = { markdown_description: '* Waits on: aaa1, bbb2' };
  const states = { aaa1: 'closed', bbb2: 'open' };
  assert.deepEqual(holdReasons(t, (id) => states[id]), { reasons: ['waits on bbb2 (still open)'], unreadable: false });
  assert.deepEqual(holdReasons(t, () => 'closed'), { reasons: [], unreadable: false });
  assert.deepEqual(holdReasons({ description: 'no declaration' }, () => 'open'), { reasons: [], unreadable: false });
});

test('a prerequisite that cannot be read holds the ticket back and says so', () => {
  assert.deepEqual(holdReasons({ description: 'Waits on: typo1' }, () => 'unreadable'),
    { reasons: ['waits on typo1 (could not be read)'], unreadable: true });
  assert.deepEqual(holdReasons({ description: 'Waits on: aaa1' }, () => undefined).unreadable, true);
});

test('an unparsed Waits on: line holds the ticket back', () => {
  assert.deepEqual(holdReasons({ description: 'Waits on: aaa1 and bbb2' }, () => 'closed'),
    { reasons: ['its Waits on: line names "aaa1 and bbb2", which is not a ticket id or link'], unreadable: false });
});

test('an id followed by its title reads as the id (SP-313: the SP-276 shape)', () => {
  assert.deepEqual(readWaitsOn('Waits on: SP-265, SP-271 ("Run a project\'s lanes from Spirality\'s folder")'),
    { ids: ['sp-265', 'sp-271'], unparsed: [] });
  for (const line of ['Waits on: SP-271 "Run lanes"', 'Waits on: SP-271 (“Run lanes”)', "Waits on: SP-271 'Dane's lanes'",
    'Waits on: SP-271 ‘Dane’s lanes’', 'Waits on: SP-271 ( "Run lanes" )', '- **Waits on:** `SP-271` ("Run lanes").',
    'Waits on: https://app.clickup.com/t/86bctbf46 ("Run lanes")', 'Waits on: <https://app.clickup.com/t/86bctbf46> "Run lanes"',
    'Waits on: [x](https://app.clickup.com/t/86bctbf46) ("Run lanes")']) {
    const { ids, unparsed } = readWaitsOn(line);
    assert.equal(ids.length, 1, line);
    assert.deepEqual(unparsed, [], line);
  }
});

test('a comma inside a title does not split the piece', () => {
  assert.deepEqual(readWaitsOn('Waits on: SP-271 ("Run lanes, then checks"), SP-3'), { ids: ['sp-271', 'sp-3'], unparsed: [] });
  assert.deepEqual(readWaitsOn('Waits on: SP-265, SP-271 ("Run a project lanes, from Spirality")'), { ids: ['sp-265', 'sp-271'], unparsed: [] });
  assert.deepEqual(readWaitsOn('Waits on: SP-1 \'Dane\'s and Rich\'s, lanes\', SP-2'), { ids: ['sp-1', 'sp-2'], unparsed: [] });
});

test('text that is not an id then a quoted title is still refused (SP-313)', () => {
  assert.deepEqual(readWaitsOn('Waits on: the API ticket'), { ids: [], unparsed: ['the API ticket'] });
  assert.deepEqual(readWaitsOn('Waits on: aaa1 and bbb2'), { ids: [], unparsed: ['aaa1 and bbb2'] });
  for (const piece of ['SP-271 Run lanes', '("Run lanes")', '"Run lanes"', 'SP-271 (Run lanes)', 'SP-271 and SP-2 ("Run lanes")',
    'SP-271("Run lanes")', 'SP-271 "Run lanes" extra', 'SP-1 ("needs SP-2 first")', 'SP-1 "see https://app.clickup.com/t/bbb2"',
    "aaa1 'x' and bbb2 'y'", 'aaa1 "x" and bbb2 "y"', 'SP-1 ("unclosed',
    // A single quote not between two letters ends the title, so none of these hides bbb2 (review of PR #258).
    "SP-1 'x'; bbb2 'y'", "SP-1 'x'. and bbb2 'y'", "SP-1 ('x') and bbb2 ('y')", 'SP-1 ‘x’; bbb2 ‘y’',
    // A title with a bare ClickUp-style id, or any digit, might name a ticket.
    'SP-1 ("after 86bctbw76")', "SP-1 'after 86bctbw76'", 'SP-1 "step 2"']) {
    const got = readWaitsOn(`Waits on: ${piece}`);
    assert.deepEqual(got.ids, [], piece);
    assert.equal(got.unparsed.length, 1, piece);
  }
  assert.deepEqual(holdReasons({ description: 'Waits on: SP-271 Run lanes' }, () => 'closed').reasons,
    ['its Waits on: line names "SP-271 Run lanes", which is not a ticket id or link']);
});

test('an unclosed title keeps the rest of the line as one refused piece', () => {
  assert.deepEqual(readWaitsOn('Waits on: SP-1 ("oops, SP-2'), { ids: [], unparsed: ['SP-1 ("oops, SP-2'] });
});
