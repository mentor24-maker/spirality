import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSession, tallySession, ticketOf, transcriptFiles, transcriptLines, transcriptsRoot } from './usageRecord.mjs';

const usage = (input, output, cacheWrite, cacheRead) => ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead });
const answer = (id, model, u, { at = '2026-11-19T18:00:00Z', content = [] } = {}) => ({ type: 'assistant', timestamp: at, message: { id, model, usage: u, content } });
const bash = (command) => ({ type: 'tool_use', name: 'Bash', input: { command } });

test('each answer counts once, however many lines repeat its message id, and tokens add up per model, most first', () => {
  const lines = [
    { type: 'user', timestamp: '2026-11-19T17:59:00Z', message: { role: 'user', content: '/loop-build' } },
    answer('m1', 'claude-opus-5-5', usage(2, 100, 1000, 5000)),
    answer('m1', 'claude-opus-5-5', usage(2, 100, 1000, 5000)),
    answer('m1', 'claude-opus-5-5', usage(2, 100, 1000, 5000)),
    answer('m2', 'claude-opus-5-5', usage(3, 50, 0, 6000)),
    answer('h1', 'claude-haiku-5-5', usage(10, 5, 0, 0)),
    answer('s1', '<synthetic>', usage(0, 0, 0, 0)),
    answer('z1', 'claude-sonnet-5-5', usage(0, 0, 0, 0)),
  ];
  assert.deepEqual(tallySession(lines), {
    models: [
      { model: 'claude-opus-5-5', input: 5, output: 150, cacheWrite: 1000, cacheRead: 11000, total: 12155, requests: 2 },
      { model: 'claude-haiku-5-5', input: 10, output: 5, cacheWrite: 0, cacheRead: 0, total: 15, requests: 1 },
    ],
    startedAt: '2026-11-19T17:59:00.000Z',
    ticket: null,
  });
});

test('an odd count (missing, negative, not a number) is 0, and a session with no answers spent nothing', () => {
  const out = tallySession([answer('m1', 'claude-opus-5-5', { input_tokens: -4, output_tokens: '9', cache_read_input_tokens: 7 })]);
  assert.deepEqual(out.models, [{ model: 'claude-opus-5-5', input: 0, output: 0, cacheWrite: 0, cacheRead: 7, total: 7, requests: 1 }]);
  assert.deepEqual(tallySession([]), { models: [], startedAt: null, ticket: null });
});

test('the ticket is the one the pass claimed, else the first --task a Bash command named; a shell variable is not one', () => {
  const said = (...commands) => [answer('a', 'm', usage(1, 1, 0, 0), { content: commands.map(bash) })];
  assert.equal(ticketOf(said('npm run --silent clickup -- get --task SP-12', 'npm run --silent clickup -- claim --task sp-14')), 'SP-14', 'the claim wins, upper-cased');
  assert.equal(ticketOf(said('npm run clickup -- comments --task $ID', 'npm run clickup -- verdict --task "SP-9" --pass')), 'SP-9');
  assert.equal(ticketOf(said('npm run clickup -- get --task 86bcgm97x')), '86bcgm97x', 'a ClickUp task id');
  assert.equal(ticketOf(said('npm run clickup -- queue --claimable')), null);
  assert.equal(ticketOf([{ type: 'assistant', message: { content: [{ type: 'text', text: '--task SP-3' }] } }]), null, 'only commands it ran count');
});

test('a broken line is skipped, not fatal', () => {
  assert.deepEqual(transcriptLines('{"a":1}\n\n{"b":\n{"c":3}\n'), [{ a: 1 }, { c: 3 }]);
});

test("a session's transcripts are its own file in whichever folder holds it and its subagents'; a session id that could leave the folder finds none", () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-record-'));
  try {
    const session = '044a7351-20bc-46e0-b17e-16588c368b51';
    mkdirSync(join(root, '-Users-x-proj', session, 'subagents'), { recursive: true });
    mkdirSync(join(root, '-Users-x-other'));
    writeFileSync(join(root, '-Users-x-proj', `${session}.jsonl`), [
      JSON.stringify(answer('m1', 'claude-opus-5-5', usage(1, 2, 3, 4), { at: '2026-11-19T18:00:00Z', content: [bash('npm run clickup -- claim --task SP-7')] })),
      JSON.stringify(answer('m1', 'claude-opus-5-5', usage(1, 2, 3, 4))),
    ].join('\n'));
    writeFileSync(join(root, '-Users-x-proj', session, 'subagents', 'agent-1.jsonl'), JSON.stringify(answer('s1', 'claude-haiku-5-5', usage(5, 0, 0, 0), { at: '2026-11-19T18:05:00Z' })));
    writeFileSync(join(root, '-Users-x-proj', session, 'subagents', 'agent-1.meta.json'), '{}');
    writeFileSync(join(root, '-Users-x-other', 'another.jsonl'), JSON.stringify(answer('o', 'claude-opus-5-5', usage(99, 99, 99, 99))));
    assert.equal(transcriptFiles(root, session).length, 2);
    const read = readSession(root, session);
    assert.deepEqual(read.models.map((m) => [m.model, m.total]), [['claude-opus-5-5', 10], ['claude-haiku-5-5', 5]]);
    assert.equal(read.ticket, 'SP-7');
    assert.equal(read.startedAt, '2026-11-19T18:00:00.000Z');
    assert.deepEqual(transcriptFiles(root, '../-Users-x-other/another'), []);
    assert.deepEqual(transcriptFiles(join(root, 'missing'), session), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the transcripts live under CLAUDE_CONFIG_DIR when it is set, else ~/.claude', () => {
  assert.equal(transcriptsRoot({ CLAUDE_CONFIG_DIR: '/x/cfg' }), '/x/cfg/projects');
  assert.match(transcriptsRoot({}), /\.claude\/projects$/);
});
