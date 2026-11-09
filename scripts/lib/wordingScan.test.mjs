import test from 'node:test';
import assert from 'node:assert/strict';
import { findWording, isExempt, ALLOWED } from './wordingScan.mjs';

// Built from halves, so this test file passes the check it tests.
const W = ['pro', 'duct'].join('');

test('a file that says the word fails, naming the line and the word', () => {
  const hits = findWording('docs/x.md', `fine line\nset up a ${W}\nall our ${W}s, and ${W[0].toUpperCase()}${W.slice(1)} too\n`);
  assert.deepEqual(hits.map((h) => [h.line, h.word]), [[2, W], [3, `${W}s`], [3, `${W[0].toUpperCase()}${W.slice(1)}`]]);
  assert.equal(hits[0].text, `set up a ${W}`);
});

test('longer words pass: production, its identifiers, a settings name', () => {
  assert.deepEqual(findWording('a.mjs', `${W}ion deploys; const ${W}Slug = x; ${W}_name; ${W}Scripts`), []);
});

test('the old names on the allow-list pass, the word beside them does not', () => {
  assert.deepEqual(findWording('a.mjs', `npm run onboard -- --${W} slug; /setup/fields?${W}=x; url.searchParams.get('${W}')`), []);
  assert.deepEqual(findWording('a.mjs', `--${W} names the ${W}`).map((h) => h.word), [W]);
  for (const a of ALLOWED) assert.ok(a.why, `${a.text} gives its reason`);
});

test('the work log is history and is not searched; a binary file is not either', () => {
  assert.equal(isExempt('docs/work-log/2026-11-01-x.md'), true);
  assert.equal(isExempt('docs/WORK-LOG.md'), true);
  assert.equal(isExempt('docs/DOCTRINE.md'), false);
  assert.deepEqual(findWording('docs/work-log/2026-11-01-x.md', `a ${W}`), []);
  assert.deepEqual(findWording('picture.png', null), []);
});
