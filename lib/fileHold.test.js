'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readLikelyFiles, fixupPrNumber, holdApplies, fileHolds, holderLine, holdReason,
  holdNote, isHoldNote, holdNoteDue, withLikelyFilesLine,
} = require('./fileHold.js');

const spec = (likely, extra = '') => `## Goal\nDo it.\n\n## Affected files / artifacts\n- \`a.js\`\n\n${likely}\n\n## Acceptance criteria\n- works\n${extra}`;
const ticket = (id, status, description, name = `Do ${id}`) => ({ id, name, status: { status }, markdown_description: description });

test('the Likely files: line is read, paths cleaned, sorted and without repeats', () => {
  assert.deepEqual(readLikelyFiles(spec('Likely files: tracker/web/app.mjs, `lib/x.js`, tracker/web/app.mjs.')), {
    files: ['lib/x.js', 'tracker/web/app.mjs'], source: 'line',
  });
  assert.deepEqual(readLikelyFiles('- **Likely files:** a.js, b.js').files, ['a.js', 'b.js']);
  assert.deepEqual(readLikelyFiles('likely FILES: a.js\nLikely files: b.js').files, ['a.js', 'b.js']);
});

test('an older ticket with no line is read by the backticked paths under Affected files', () => {
  const d = '## Affected files / artifacts\n- `lib/a.js` (new)\n- `docs/B.md`\n- `npm run verify`\n\n## Acceptance criteria\n- `lib/not-here.js`\n';
  assert.deepEqual(readLikelyFiles(d), { files: ['docs/B.md', 'lib/a.js'], source: 'affected' });
});

test('a ticket that names no files says so', () => {
  assert.deepEqual(readLikelyFiles('## Goal\nNothing named.'), { files: [], source: null });
  assert.deepEqual(readLikelyFiles(''), { files: [], source: null });
  assert.equal(readLikelyFiles('Likely files:\n').source, null);
});

test('a merge fix-up ticket is known by its name, in each of its three forms', () => {
  assert.equal(fixupPrNumber('Find out why PR #271 (x-branch) will not merge'), 271);
  assert.equal(fixupPrNumber('Resolve the merge conflict on PR #40'), 40);
  assert.equal(fixupPrNumber('Check why PR #9 has not merged — no overlap was found'), 9);
  assert.equal(fixupPrNumber('Hold a ticket back from building'), null);
  assert.equal(fixupPrNumber('Explain why PR #3 matters'), null);
});

test('only a Queued ticket that is not a fix-up is ever held', () => {
  assert.equal(holdApplies(ticket('SP-1', 'queued', '')), true);
  assert.equal(holdApplies(ticket('SP-1', 'rework', '')), false);
  assert.equal(holdApplies(ticket('SP-1', 'queued', '', 'Find out why PR #4 will not merge')), false);
});

test('an open pull request sharing a file holds the ticket; one that shares none does not', () => {
  const me = ticket('SP-10', 'queued', spec('Likely files: tracker/server.mjs, lib/a.js'));
  const tickets = [me, ticket('SP-8', 'in review', ''), ticket('SP-9', 'rework', '')];
  const records = [
    { ticket: 'SP-9', number: 41, repo: 'o/r', files: ['tracker/server.mjs', 'x.js'] },
    { ticket: 'SP-8', number: 40, repo: 'o/r', files: ['docs/x.md'] },
  ];
  const out = fileHolds({ ticket: me, tickets, records, repo: 'o/r' });
  assert.equal(out.applies, true);
  assert.deepEqual(out.holders, [{ ticket: 'SP-9', number: 41, files: ['tracker/server.mjs'] }]);
  assert.equal(holdReason(out.holders), 'held for shared files: SP-9 (PR #41) changes tracker/server.mjs');
});

test('every open pull request holds, whatever its ticket waits in', () => {
  const me = ticket('SP-10', 'queued', 'Likely files: a.js');
  for (const status of ['building', 'in review', 'rework', 'needs your input', 'ready to launch']) {
    const out = fileHolds({ ticket: me, tickets: [me, ticket('SP-2', status, '')], records: [{ ticket: 'SP-2', number: 5, files: ['a.js'] }] });
    assert.equal(out.holders.length, 1, status);
  }
});

test('a pull request whose ticket is no longer open (merged) holds nothing', () => {
  const me = ticket('SP-10', 'queued', 'Likely files: a.js');
  const out = fileHolds({ ticket: me, tickets: [me], records: [{ ticket: 'SP-2', number: 5, files: ['a.js'] }] });
  assert.deepEqual(out.holders, []);
});

test('a ticket is never held by its own pull request, and another repository is left out', () => {
  const me = ticket('sp-10', 'queued', 'Likely files: a.js');
  const other = ticket('SP-2', 'in review', '');
  const records = [
    { ticket: 'SP-10', number: 5, repo: 'o/r', files: ['a.js'] },
    { ticket: 'SP-2', number: 6, repo: 'someone/else', files: ['a.js'] },
  ];
  assert.deepEqual(fileHolds({ ticket: me, tickets: [me, other], records, repo: 'o/r' }).holders, []);
});

test('a Building ticket with no pull request yet holds by its likely files', () => {
  const me = ticket('SP-10', 'queued', 'Likely files: a.js, b.js');
  const tickets = [
    me,
    ticket('SP-11', 'building', spec('Likely files: b.js')),
    ticket('SP-12', 'building', '## Affected files / artifacts\n- `a.js`\n'),
    ticket('SP-13', 'queued', 'Likely files: a.js'),
    ticket('SP-14', 'building', 'Likely files: z.js'),
  ];
  const out = fileHolds({ ticket: me, tickets, records: [] });
  assert.deepEqual(out.holders, [
    { ticket: 'SP-11', number: null, files: ['b.js'] },
    { ticket: 'SP-12', number: null, files: ['a.js'] },
  ]);
  assert.equal(holderLine(out.holders[0]), 'SP-11 (being built, no pull request yet) will change b.js');
});

test('a Building ticket with its pull request recorded holds by the pull request, not its guess', () => {
  const me = ticket('SP-10', 'queued', 'Likely files: a.js');
  const tickets = [me, ticket('SP-11', 'building', 'Likely files: a.js')];
  const records = [{ ticket: 'SP-11', number: 7, files: ['c.js'] }];
  assert.deepEqual(fileHolds({ ticket: me, tickets, records }).holders, []);
});

test('Rework and fix-up tickets are never held, even sharing a file', () => {
  const tickets = [ticket('SP-2', 'in review', '')];
  const records = [{ ticket: 'SP-2', number: 5, files: ['a.js'] }];
  const rework = ticket('SP-10', 'rework', 'Likely files: a.js');
  const fixup = ticket('SP-11', 'queued', 'Likely files: a.js', 'Find out why PR #9 (b) will not merge');
  for (const t of [rework, fixup]) {
    const out = fileHolds({ ticket: t, tickets: [...tickets, t], records });
    assert.equal(out.applies, false);
    assert.deepEqual(out.holders, []);
  }
});

test('a ticket that names no files is not held, and says it names none', () => {
  const me = ticket('SP-10', 'queued', '## Goal\nx');
  const out = fileHolds({ ticket: me, tickets: [me], records: [{ ticket: 'SP-2', number: 5, files: ['a.js'] }] });
  assert.equal(out.source, null);
  assert.deepEqual(out.holders, []);
});

test('the hold note is written once per set of holders', () => {
  const holders = [{ ticket: 'SP-9', number: 41, files: ['a.js'] }];
  const note = holdNote(holders);
  assert.ok(isHoldNote(note));
  assert.match(note, /SP-9 \(PR #41\) changes a\.js/);
  assert.doesNotMatch(note, /Your move|waiting on (you|Dane)/i);
  assert.equal(holdNoteDue([], holders), true);
  assert.equal(holdNoteDue([{ comment_text: note, date: 2 }], holders), false);
  assert.equal(holdNoteDue([{ comment_text: `[machine] ${note}`, date: 2 }], holders), false);
  const other = [{ ticket: 'SP-9', number: 41, files: ['a.js', 'b.js'] }];
  assert.equal(holdNoteDue([{ comment_text: note, date: 2 }], other), true);
  // The newest note counts, not any older one with the same holders.
  assert.equal(holdNoteDue([{ comment_text: note, date: 1 }, { comment_text: holdNote(other), date: 3 }], holders), true);
});

test('the Likely files: line goes under Affected files, or at the end', () => {
  const d = '## Goal\nx\n\n## Affected files / artifacts\n- `a.js`\n\n## Acceptance criteria\n- ok\n';
  const out = withLikelyFilesLine(d, ['b.js', 'a.js']);
  assert.equal(out.description, '## Goal\nx\n\n## Affected files / artifacts\n- `a.js`\n\nLikely files: a.js, b.js\n\n## Acceptance criteria\n- ok\n');
  assert.deepEqual(readLikelyFiles(out.description), { files: ['a.js', 'b.js'], source: 'line' });
  assert.equal(withLikelyFilesLine('## Goal\nx\n', ['a.js']).description, '## Goal\nx\n\nLikely files: a.js\n');
  assert.equal(withLikelyFilesLine('## Affected files / artifacts\n- `a.js`', ['a.js']).description, '## Affected files / artifacts\n- `a.js`\n\nLikely files: a.js\n');
});

test('the Likely files: line is never written twice, nor empty', () => {
  assert.match(withLikelyFilesLine('Likely files: a.js', ['b.js']).error, /already has a Likely files: line \(a\.js\)/);
  assert.equal(withLikelyFilesLine('x', []).error, 'no paths given');
  assert.equal(withLikelyFilesLine('x', [' ']).error, 'no paths given');
});

test('inFlight counts the other open pull requests and Building tickets whose files are known', () => {
  const me = ticket('SP-10', 'queued', '## Goal\nx');
  assert.equal(fileHolds({ ticket: me, tickets: [me], records: [] }).inFlight, 0);
  const tickets = [me, ticket('SP-2', 'in review', ''), ticket('SP-3', 'building', 'Likely files: q.js'), ticket('SP-4', 'building', 'no files')];
  const out = fileHolds({ ticket: me, tickets, records: [{ ticket: 'SP-2', number: 5, files: ['a.js'] }, { ticket: 'SP-10', number: 6, files: ['a.js'] }] });
  assert.equal(out.inFlight, 2);
  assert.deepEqual(out.holders, []);
});
