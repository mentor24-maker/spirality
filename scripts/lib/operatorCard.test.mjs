import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCard, validateCard, buildCard, renderCard, cardSurvived, findBlockquoteLines, findBranchLinks, branchLinkRefusal, findSqlFiles, sqlBlockFiles, sqlFilesWithoutBlock, sqlBlockFor, sqlHandoffRefusal, SQL_BLOCK_HEAD, countWords, fenceFor, fenceLines, splitFences, renderCardComment } from './operatorCard.mjs';

const sixty = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');

const good = `@@ASKED
build the to-do list
@@WHEN
2026-10-11 9:40am
@@CONTEXT
${sixty}
@@NEEDED
Pick option A or B.
Your move: Reply — A or B.`;

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

test('his own ``` inside a four-backtick @@ASKED fence does not end the fence', () => {
  assert.deepEqual(findBlockquoteLines('````\nsee:\n```\n> from the email\n```\n````'), []);
  assert.deepEqual(findBlockquoteLines('~~~\n```\n> from the email\n~~~\n> c'), [5]);
});

test('@@ASKED may carry his own "> " and ``` lines bare: the card fences it with a longer run (SP-44)', () => {
  const card = parseCard(good.replace('@@ASKED\n', '@@ASKED\n> his pasted line\n```\nnpm run thing\n```\n'));
  assert.ok(!validateCard(card).some((p) => p.includes('blockquote')));
  const fence = fenceFor(card.asked);
  assert.equal(fence, '````');
  assert.ok(renderCard(card).includes(`${fence}\n${card.asked}\n${fence}\n`), renderCard(card));
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

test('the card check and the card builder agree on where a fence ends (SP-44)', () => {
  for (const fenced of ['~~~\n> line from the email\n~~~', '````\n```\n> x\n```\n````']) {
    const card = parseCard(good.replace(sixty, `${sixty}\n${fenced}`));
    assert.deepEqual(validateCard(card), []);
    const quoted = renderCardComment(card).filter((r) => /^> /m.test(r.text));
    assert.ok(quoted.length, 'the quoted line is in the comment');
    for (const r of quoted) assert.equal(r.attributes?.['code-block'], 'plain', `"${r.text}" went out as plain text`);
  }
  assert.deepEqual(splitFences('a\n````\n```\nb\n```\n````\nc').blocks, [['```', 'b', '```']]);
  assert.deepEqual(fenceLines('~~~\nx\n```\n~~~').map((l) => l.role), ['open', 'body', 'body', 'close']);
});

test('the card `ask` posts needs the same one-line move as the shared module (SP-68)', async () => {
  const shared = (await import('../../lib/operatorCard.js')).default;
  const mjs = await import('./operatorCard.mjs');
  const sixty = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
  const without = mjs.parseCard(`@@ASKED\nx\n@@CONTEXT\n${sixty}\n@@NEEDED\nPick A or B.`);
  assert.ok(mjs.validateCard(without).some((p) => /must END with one line naming his move/.test(p)));
  assert.equal(mjs.readYourMove, shared.readYourMove, 'one rule, not a copy');
  assert.throws(() => mjs.buildCard(`@@ASKED\nx\n@@CONTEXT\n${sixty}\n@@NEEDED\nmove this ticket to Live yourself\nYour move: Reply — ok`), /move the ticket himself/);
});

test('the card `ask` posts refuses a Doppler write command, as the shared module does', async () => {
  const shared = (await import('../../lib/operatorCard.js')).default;
  const mjs = await import('./operatorCard.mjs');
  const sixty = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
  const ub7 = [
    'doppler secrets set APP_PASSWORD --project upwork-blaster --config dev',
    'openssl rand -base64 48 | doppler secrets set APP_SESSION_SECRET --project upwork-blaster --config dev --silent',
  ];
  assert.equal(mjs.dopplerWriteProblems, shared.dopplerWriteProblems, 'one rule, not a copy');
  for (const line of ub7) {
    const text = `@@ASKED\nx\n@@CONTEXT\n${sixty}\n@@NEEDED\nRun this on the Mini:\n${line}\nYour move: Reply — "done"`;
    assert.throws(() => mjs.buildCard(text), /doppler secrets set[\s\S]*DOCTRINE 4\.1[\s\S]*Nothing was posted/, line);
  }
  const asked = `@@ASKED\nI ran ${ub7.join(' and then ')}\n@@CONTEXT\n${sixty}\n@@NEEDED\nOpen the Doppler dashboard and add the key.\nYour move: Reply — "done"`;
  assert.doesNotThrow(() => mjs.buildCard(asked));
});

test('findBranchLinks flags branch links and passes main and commit links (SP-178)', () => {
  const gh = 'https://github.com/mentor24-maker/spirality';
  assert.deepEqual(findBranchLinks(`Read ${gh}/blob/setup-review/docs/onboarding/SETUP_REVIEW.md now`),
    [`${gh}/blob/setup-review/docs/onboarding/SETUP_REVIEW.md`]);
  assert.deepEqual(findBranchLinks(`See [the folder](${gh}/tree/some-branch/docs).`), [`${gh}/tree/some-branch/docs`]);
  assert.deepEqual(findBranchLinks(`${gh}/tree/some-branch`), [`${gh}/tree/some-branch`]);
  assert.deepEqual(findBranchLinks(`${gh}/blob/main/README.md`), []);
  assert.deepEqual(findBranchLinks(`${gh}/blob/a78628c/docs/x.md`), []);
  assert.deepEqual(findBranchLinks(`${gh}/blob/a78628c07fef41862bbfe69c77f4e10f2a64e107/docs/onboarding/SETUP_REVIEW.md`), []);
  assert.deepEqual(findBranchLinks(`${gh}/pull/83/files and ${gh}/pull/83`), []);
  // Six hex characters is too short to be a commit id; it reads as a branch name.
  assert.equal(findBranchLinks(`${gh}/blob/abc123/x.md`).length, 1);
  // Inside a fence it is quoted text, not a link offered to Dane.
  assert.deepEqual(findBranchLinks(`his words:\n\`\`\`\n${gh}/blob/setup-review/x.md\n\`\`\`\n`), []);
  const two = findBranchLinks(`${gh}/blob/a/x.md\nand ${gh}/blob/main/y.md and ${gh}/tree/b/z`);
  assert.deepEqual(two, [`${gh}/blob/a/x.md`, `${gh}/tree/b/z`]);
  const msg = branchLinkRefusal(two, 'Nothing was posted.');
  assert.match(msg, /Nothing was posted\./);
  assert.ok(msg.includes(`  ${gh}/blob/a/x.md`) && msg.includes('git rev-parse HEAD') && msg.includes('/files'), msg);
});

// DOCTRINE 6.5: SQL handed to Dane goes in the run block, one per file (SP-381).
const ROW = '#'.repeat(58);
const C = '0123456789abcdef0123456789abcdef01234567';
const block = (ref, file) => `${SQL_BLOCK_HEAD}\n\nhttps://github.com/o/r/blob/${ref}/${file}\n\n${ROW}`;
const handoff = (body) => `Run this file in the SQL editor, then reply here.\n\nIt adds two fields; it changes nothing that exists.\n\n\n${body}\n\n\nYour move: Reply "ran it".`;

test('a correct run block, by commit or by main, passes (SP-381)', () => {
  for (const ref of [C, C.slice(0, 7), 'main']) {
    const text = handoff(block(ref, 'docs/SQL/0042_add_field.sql'));
    assert.deepEqual(findSqlFiles(text), ['docs/SQL/0042_add_field.sql']);
    assert.deepEqual(sqlBlockFiles(text), ['docs/SQL/0042_add_field.sql']);
    assert.deepEqual(sqlFilesWithoutBlock(text), []);
  }
  const two = handoff(`${block(C, 'docs/SQL/a.sql')}\n\n\n${block(C, 'docs/SQL/b.sql')}`);
  assert.deepEqual(sqlFilesWithoutBlock(two), []);
});

test('a bare path, a bold numbered path, a fenced block and a branch link are refused (SP-381)', () => {
  assert.deepEqual(sqlFilesWithoutBlock(handoff('Run docs/SQL/x.sql in the editor.')), ['docs/SQL/x.sql']);
  assert.deepEqual(sqlFilesWithoutBlock(handoff('**1. docs/SQL/a.sql**\n**2. `docs/SQL/b.sql`**')), ['docs/SQL/a.sql', 'docs/SQL/b.sql']);
  const fenced = handoff(`\`\`\`\n${block(C, 'docs/SQL/x.sql')}\n\`\`\`\nThe file is docs/SQL/x.sql.`);
  assert.deepEqual(sqlBlockFiles(fenced), [], 'a fenced block is dead text, so it covers nothing');
  assert.deepEqual(sqlFilesWithoutBlock(fenced), ['docs/SQL/x.sql']);
  const branch = handoff(block('sql-handoff-check', 'docs/SQL/x.sql'));
  assert.deepEqual(sqlBlockFiles(branch), []);
  assert.deepEqual(sqlFilesWithoutBlock(branch), ['docs/SQL/x.sql']);
  const bareLink = handoff(`https://github.com/o/r/blob/${C}/docs/SQL/x.sql`);
  assert.deepEqual(sqlFilesWithoutBlock(bareLink), ['docs/SQL/x.sql'], 'a link with no block round it is not the handoff');
});

test('two files with one block leave the other refused; a block missing a line covers nothing (SP-381)', () => {
  const text = handoff(`${block(C, 'docs/SQL/a.sql')}\n\nThen also docs/SQL/b.sql.`);
  assert.deepEqual(findSqlFiles(text), ['docs/SQL/a.sql', 'docs/SQL/b.sql']);
  assert.deepEqual(sqlFilesWithoutBlock(text), ['docs/SQL/b.sql']);
  const squashed = `${SQL_BLOCK_HEAD}\nhttps://github.com/o/r/blob/${C}/docs/SQL/a.sql\n${ROW}`;
  assert.deepEqual(sqlFilesWithoutBlock(squashed), ['docs/SQL/a.sql']);
  const shortRow = `${SQL_BLOCK_HEAD}\n\nhttps://github.com/o/r/blob/${C}/docs/SQL/a.sql\n\n######`;
  assert.deepEqual(sqlFilesWithoutBlock(shortRow), ['docs/SQL/a.sql'], 'six # is a heading, not the row');
  assert.deepEqual(sqlFilesWithoutBlock(`${block(C, 'docs/SQL/a.sql')}\nSee a.sql above.`), [], 'a bare name is covered by its block');
});

test('a card naming no .sql file, or one only inside a fence, is untouched (SP-381)', () => {
  assert.deepEqual(findSqlFiles(good), []);
  assert.deepEqual(sqlFilesWithoutBlock('Nothing about SQL here; a `.sql` file is mentioned only by kind.'), []);
  assert.deepEqual(sqlFilesWithoutBlock('The review read:\n```\nsee docs/SQL/x.sql\n```\nnothing else.'), []);
  assert.deepEqual(sqlFilesWithoutBlock(`See https://github.com/o/r/pull/12/files for the change.`), []);
});

test('the refusal names each file and prints its block ready to paste (SP-381)', () => {
  const ready = sqlBlockFor('docs/SQL/x.sql', 'owner/repo');
  assert.equal(ready, `${SQL_BLOCK_HEAD}\n\nhttps://github.com/owner/repo/blob/<commit>/docs/SQL/x.sql\n\n${ROW}`);
  assert.ok(sqlBlockFor('docs/SQL/x.sql').includes('github.com/<owner>/<repo>/blob/<commit>/'));
  const msg = sqlHandoffRefusal(['docs/SQL/x.sql', 'docs/SQL/y.sql'], 'Nothing was posted.', 'owner/repo');
  assert.match(msg, /DOCTRINE 6\.5/);
  assert.match(msg, /Nothing was posted\./);
  assert.match(msg, /no block for: docs\/SQL\/x\.sql/);
  assert.match(msg, /no block for: docs\/SQL\/y\.sql/);
  assert.ok(msg.includes(`\n\n\n${ready}\n\n`), 'the block sits with two blank lines round it');
  // The ready-made block, once <commit> is filled in, passes the check it came from.
  const filled = handoff(sqlBlockFor('docs/SQL/x.sql', 'owner/repo').replace('<commit>', C));
  assert.deepEqual(sqlFilesWithoutBlock(filled), []);
});
