import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeArgs, claudeCommandOf, MAX_TITLE_LENGTH, readTitles, SKILL_FILE, skillPrompt, suggestInput, suggestTitles, TitleSuggestError,
} from './titleSuggest.mjs';
import { parseSkill } from './commands.mjs';

const FIVE = ['Add a title suggester to the Add Task box', 'Suggest five titles from a description', 'Offer title choices when adding a task', 'Let the tracker suggest task titles', 'Show suggested titles on the Add Task box'];

/**
 * A stand-in `claude` in a fresh folder: it saves its arguments and what it
 * read on standard input next to itself, then runs `body` (plain Node, with
 * `input` holding what it read). Answers `{ command, seen, cleanup }`.
 */
function stubClaude(body) {
  const dir = mkdtempSync(join(tmpdir(), 'stub-claude-'));
  const command = join(dir, 'claude');
  writeFileSync(command, `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(join(dir, 'seen.json'))}, JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd() }));
  ${body}
});
`);
  chmodSync(command, 0o755);
  return {
    command,
    seen: () => JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8')),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('readTitles takes five lines and strips numbering, bullets and quotes', () => {
  assert.deepEqual(readTitles(FIVE.join('\n')), FIVE);
  const messy = `1. ${FIVE[0]}\n2) "${FIVE[1]}"\n- ${FIVE[2]}\n\n* **${FIVE[3]}**\n  • ${FIVE[4]}  \n`;
  assert.deepEqual(readTitles(messy), FIVE);
  assert.deepEqual(readTitles(FIVE.join('\r\n')), FIVE, 'Windows line ends read the same');
});

test('readTitles refuses anything but five different usable titles, never a short list', () => {
  const bad = (text, why) => assert.throws(() => readTitles(text), (err) => err instanceof TitleSuggestError && err.code === 'bad-answer' && why.test(err.message));
  bad('', /0 different titles, not 5/);
  bad(FIVE.slice(0, 3).join('\n'), /3 different titles/);
  bad(['Here are five titles:', ...FIVE].join('\n'), /6 different titles/);
  bad([...FIVE.slice(0, 4), FIVE[0].toUpperCase()].join('\n'), /4 different titles/, 'a repeat, ignoring case, is dropped before counting');
  bad([...FIVE.slice(0, 4), `Add ${'a very '.repeat(20)}long title`].join('\n'), new RegExp(`under ${MAX_TITLE_LENGTH}`));
  bad(null, /0 different/);
});

test('the run gets the skill as its prompt and no tools; the words go only on standard input', () => {
  const prompt = skillPrompt();
  assert.ok(prompt.startsWith('# Suggest five titles'), 'the steps below the front matter');
  assert.ok(!prompt.includes('summary:'), 'the front matter is not part of the prompt');
  assert.deepEqual(claudeArgs('P'), ['-p', 'P', '--tools', '', '--no-session-persistence', '--output-format', 'text']);
  assert.equal(suggestInput({ description: '  Fix the box  ' }), 'Description: Fix the box\n');
  assert.equal(suggestInput({ description: 'Fix the box', title: ' Box fix ' }), 'Description: Fix the box\nTitle: Box fix\n');
  assert.equal(suggestInput({ description: 'Fix the box', title: '   ' }), 'Description: Fix the box\n', 'a blank title is no title');
});

test('the skill file has the Docs page\'s front matter and asks for five verb-first titles', () => {
  const skill = parseSkill(readFileSync(SKILL_FILE, 'utf8'));
  assert.equal(skill.name, 'suggest-titles');
  assert.ok(skill.summary && skill.about && skill.description);
  assert.match(skill.steps, /exactly five/i);
  assert.match(skill.steps, /starting with a\s+verb/);
});

test('claudeCommandOf reads TRACKER_CLAUDE, else claude on the PATH', () => {
  assert.equal(claudeCommandOf({}), 'claude');
  assert.equal(claudeCommandOf({ TRACKER_CLAUDE: '  ' }), 'claude');
  assert.equal(claudeCommandOf({ TRACKER_CLAUDE: '/opt/bin/claude' }), '/opt/bin/claude');
});

test('suggestTitles answers a stub\'s five titles; the description never reaches its arguments', async () => {
  const stub = stubClaude(`process.stdout.write(${JSON.stringify(FIVE.map((t, i) => `${i + 1}. ${t}`).join('\n'))});`);
  try {
    const secret = 'Description words: zebra-quartz-41';
    assert.deepEqual(await suggestTitles({ description: secret, title: 'My own title' }, { command: stub.command }), FIVE);
    const seen = stub.seen();
    assert.equal(seen.input, `Description: ${secret}\nTitle: My own title\n`);
    assert.ok(!seen.args.some((a) => a.includes('zebra-quartz') || a.includes('My own title')), `arguments: ${JSON.stringify(seen.args)}`);
    assert.deepEqual(seen.args.slice(2), ['--tools', '', '--no-session-persistence', '--output-format', 'text']);
    assert.ok(!seen.cwd.startsWith(process.cwd()), 'it runs outside this checkout, so no project rules reach it');
  } finally { stub.cleanup(); }
});

test('suggestTitles: a short answer, a failed run, no command and a hang each fail with their own code', async () => {
  const code = async (stub, expected, opts = {}) => {
    await assert.rejects(suggestTitles({ description: 'Fix the box' }, { command: stub.command ?? stub, ...opts }),
      (err) => err instanceof TitleSuggestError && err.code === expected);
  };
  const three = stubClaude(`process.stdout.write('one\\ntwo\\nthree\\n');`);
  const empty = stubClaude('');
  const broken = stubClaude(`process.stderr.write('not signed in\\n'); process.exit(1);`);
  const hang = stubClaude('setInterval(() => {}, 1000);');
  try {
    await code(three, 'bad-answer');
    await code(empty, 'bad-answer');
    await code(broken, 'failed');
    await code(join(tmpdir(), 'no-such-dir-sp245', 'claude'), 'no-claude');
    const started = Date.now();
    await code(hang, 'too-slow', { timeoutMs: 300 });
    assert.ok(Date.now() - started < 3000, 'stopped at the limit, not left running');
  } finally {
    for (const s of [three, empty, broken, hang]) s.cleanup();
  }
  await assert.rejects(suggestTitles({ description: '   ' }, { command: '/bin/echo' }), (err) => err.code === 'no-description');
});
