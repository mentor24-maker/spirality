// A card's banner is never inside a fence (SP-425). SP-424's intake card
// quoted Dane's request in a fence, and his words held the card marker
// itself; the page took that quoted line for the ask, drew "approve the
// merge of PR #" in red and offered no Go button.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cardAsk, renderComment, offersGo } from './web/render.mjs';

const FENCE3 = '```';
const FENCE4 = '````';
const RULE = '#############################';

/** SP-424's intake card, as the tracker stored it on 11/27 (shortened, every line that matters kept). */
const SP_424_CARD = [
  "**DANE'S WORDS — the instruction behind this ticket**",
  '',
  FENCE4,
  'Tweaks to Task Details page',
  '',
  '## Dane\'s words, verbatim',
  '',
  FENCE3,
  '1) Move the green button (Merge, Go) or action field up to just under the Status line',
  '2) Only ' + RULE,
  'NEEDED FROM DANE: approve the merge of PR #',
  RULE,
  '',
  'needs to be bold red. ',
  FENCE3,
  FENCE4,
  "**WHAT'S GOING ON**",
  '',
  'You want the left box on a ticket\'s page to lead with your move.',
  '',
  `**${RULE}**`,
  '**NEEDED FROM DANE: Reply "go" to queue it as written, or reply with what to change.**',
  '**Your move: Reply — "go", or what to change.**',
  `**${RULE}**`,
].join('\n');

test('the ask is the card\'s own banner, not a NEEDED FROM line quoted in a fence', () => {
  assert.equal(cardAsk(SP_424_CARD),
    'Reply "go" to queue it as written, or reply with what to change.\nYour move: Reply — "go", or what to change.');
});

test('a ticket whose card quotes the marker still offers Go', () => {
  assert.equal(offersGo({ status: 'Needs your input', goPhrase: 'go', comments: [{ body: SP_424_CARD }] }), true);
});

test('the quoted words stay inside their fence, and the real banner is the red box', () => {
  const html = renderComment(SP_424_CARD, { operatorName: 'Dane' });
  const boxes = html.match(/<div class="banner">[\s\S]*?<\/div>/g) ?? [];
  assert.equal(boxes.length, 1);
  assert.match(boxes[0], /Reply &quot;go&quot; to queue it/);
  assert.doesNotMatch(boxes[0], /approve the merge/);
  // The quote is one code block that still carries its rows of # and the quoted line.
  const pre = html.match(/<pre[\s\S]*?<\/pre>/)?.[0] ?? '';
  assert.match(pre, /NEEDED FROM DANE: approve the merge of PR #/);
  assert.match(pre, new RegExp(RULE));
});

test('a comment that only quotes a card in a closed fence carries no card', () => {
  const quoted = ['Here is what the card said:', '', FENCE3, RULE, 'NEEDED FROM DANE: Reply done.', RULE, FENCE3].join('\n');
  assert.equal(cardAsk(quoted), null);
  const raw = ['Quoting an authored card:', FENCE3, '@@NEEDED', 'Reply done.', FENCE3].join('\n');
  assert.equal(cardAsk(raw), null);
});

test('a card whose fence is left open is still found where it used to be', () => {
  const broken = ['Context', FENCE3, 'a log line', RULE, 'NEEDED FROM DANE: Reply done.', RULE].join('\n');
  assert.equal(cardAsk(broken), 'Reply done.');
});

test('a banner after a closed fence is found, the fence before it untouched', () => {
  const body = ['Run this:', FENCE3, 'npm run verify', FENCE3, RULE, 'NEEDED FROM DANE: Reply done.', RULE].join('\n');
  assert.equal(cardAsk(body), 'Reply done.');
  assert.match(renderComment(body), /<pre[\s\S]*npm run verify[\s\S]*<\/pre>/);
});
