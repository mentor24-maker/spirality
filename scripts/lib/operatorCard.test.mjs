import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCard, validateCard, buildCard, renderCard, cardSurvived, findBlockquoteLines, countWords } from './operatorCard.mjs';

const sixty = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');

const good = `@@ASKED
build the to-do list
@@WHEN
2026-10-11 9:40am
@@CONTEXT
${sixty}
@@NEEDED
Pick option A or B.`;

test('a well-formed card parses, validates and renders with the banner last', () => {
  const { card, rendered, comment } = buildCard(good);
  assert.equal(card.asked, 'build the to-do list');
  assert.equal(validateCard(card).length, 0);
  assert.ok(rendered.trim().endsWith('#'.repeat(29)));
  assert.ok(rendered.includes('NEEDED FROM DANE: Pick option A or B.'));
  const banner = comment.filter((r) => r.attributes && r.attributes.color);
  assert.ok(banner.length >= 3);
});

test('the three required sections and the word range are enforced', () => {
  const card = parseCard('@@ASKED\n\n@@CONTEXT\ntoo short\n@@NEEDED\n');
  const problems = validateCard(card);
  assert.ok(problems.some((p) => p.startsWith('@@ASKED is empty')));
  assert.ok(problems.some((p) => p.includes('the floor is 50')));
  assert.ok(problems.some((p) => p.startsWith('@@NEEDED is empty')));
  const long = `@@ASKED\nx\n@@CONTEXT\n${Array.from({ length: 120 }, () => 'w').join(' ')}\n@@NEEDED\ny`;
  assert.ok(validateCard(parseCard(long)).some((p) => p.includes('the ceiling is 100')));
});

test('text before the first marker, unknown markers and a bare @@MEASURED are refused', () => {
  assert.throws(() => parseCard('hello\n@@ASKED\nx'), /text before the first/);
  assert.throws(() => parseCard('@@BOGUS\nx'), /not a card section/);
  assert.throws(() => parseCard('@@EVIDENCE\n@@MEASURED\nx'), /SAME line/);
  assert.throws(() => parseCard('@@ASKED\nx\n@@ASKED\ny'), /appears twice/);
});

test('blockquotes are refused anywhere outside a fence', () => {
  assert.deepEqual(findBlockquoteLines('a\n> b\n```\n> inside fence is fine\n```\n> c'), [2, 6]);
  const card = parseCard(`${good}\n> quoted`);
  assert.ok(validateCard(card).some((p) => p.includes('blockquote')));
});

test('a costly ask needs evidence with a fence, output and a measured line', () => {
  const costly = good.replace('Pick option A or B.', 'Please upgrade the plan.');
  assert.ok(validateCard(parseCard(costly)).some((p) => p.startsWith('@@EVIDENCE is missing')));
  const withEvidence = `${costly}\n@@EVIDENCE\n@@MEASURED 8:04pm\n\`\`\`\n$ doppler me\nDanes-MacBook\n\`\`\``;
  assert.equal(validateCard(parseCard(withEvidence)).length, 0);
  assert.ok(renderCard(parseCard(withEvidence)).includes('measured at 8:04pm'));
  const noOutput = `${costly}\n@@EVIDENCE\n@@MEASURED 8:04pm\n\`\`\`\n$ doppler me\n\`\`\``;
  assert.ok(validateCard(parseCard(noOutput)).some((p) => p.includes('no output')));
});

test("cardSurvived notices when Dane's words were eaten", () => {
  const { card, rendered } = buildCard(good);
  assert.equal(cardSurvived(card, rendered), null);
  assert.ok(cardSurvived(card, rendered.replace('build the to-do list', '')));
  assert.equal(countWords('a — b, c!'), 3);
});
