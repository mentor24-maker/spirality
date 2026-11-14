import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openStore } from './store.mjs';
import { createSuggester, FIELD_LIMITS, readSuggestions, runSuggest, skillPrompt, SuggestError, ticketsInput } from './nextSuggest.mjs';

const five = (prefix = 'Add') => [1, 2, 3, 4, 5].map((n) => ({ title: `${prefix} thing ${n}`, description: `Do thing ${n}.`, why: `docs/PLAN.md says ${n}.` }));

/**
 * A scratch folder holding: a local git repository with one commit on main
 * (the project to copy), a stub `claude` that records its arguments, its
 * folder and its standard input and prints STUB_OUT (or hangs, with
 * STUB_HANG), and an empty temp root for the run's folder.
 */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'next-suggest-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '--quiet', '-b', 'main');
  writeFileSync(join(repo, 'CLAUDE.md'), '# A test project\n');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'first');
  const stub = join(dir, 'claude-stub');
  const record = join(dir, 'record.json');
  writeFileSync(stub, `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), sawRepo: fs.existsSync('CLAUDE.md'), input }));
  if (process.env.STUB_HANG) { setInterval(() => {}, 1000); return; }
  process.stdout.write(process.env.STUB_OUT || '');
  process.exit(Number(process.env.STUB_EXIT || 0));
});
`);
  chmodSync(stub, 0o755);
  const tmpRoot = join(dir, 'tmp');
  mkdirSync(tmpRoot);
  return {
    dir, repo, stub, tmpRoot,
    source: () => repo,
    recorded: () => JSON.parse(readFileSync(record, 'utf8')),
    leftovers: () => readdirSync(tmpRoot),
    env: (extra) => ({ ...process.env, ...extra }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('readSuggestions reads a clean list, taking off fences, numbering and repeats, and cutting long fields', () => {
  assert.deepEqual(readSuggestions(JSON.stringify(five())), five());
  const messy = '```json\n' + JSON.stringify([
    { title: '1. Add a growth column', description: 'd1', why: 'w1' },
    { title: '2) Write the plan', description: 'd2' },
    { title: '#3 Move the watchdogs', why: 'w3' },
    { title: ' add a GROWTH   column ', description: 'repeat' },
    { title: 'x'.repeat(500), description: 'y'.repeat(5000), why: 'z'.repeat(5000) },
  ]) + '\n```\nThat is all.';
  const got = readSuggestions(messy);
  assert.deepEqual(got.slice(0, 3).map((s) => s.title), ['Add a growth column', 'Write the plan', 'Move the watchdogs']);
  assert.equal(got.length, 4, 'the repeat is dropped');
  assert.equal(got[1].why, '');
  assert.equal(got[2].description, '');
  assert.equal(got[3].title.length, FIELD_LIMITS.title);
  assert.equal(got[3].description.length, FIELD_LIMITS.description);
  assert.equal(got[3].why.length, FIELD_LIMITS.why);
  assert.ok(got[3].title.endsWith('…'));
});

test('readSuggestions refuses anything but three to seven titled items, never a half list', () => {
  const bad = [
    'not json at all', '[{"title": "Add x",', '{"title": "Add x"}', '[]',
    JSON.stringify(five().slice(0, 2)),
    JSON.stringify([...five(), ...five('Write'), ...five('Move')].slice(0, 8)),
    JSON.stringify([...five().slice(0, 3), { description: 'no title' }]),
    JSON.stringify([...five().slice(0, 3), { title: '   ' }]),
    JSON.stringify([...five().slice(0, 3), 'just text']),
    JSON.stringify([five()[0], five()[0], five()[0]]),
  ];
  for (const text of bad) {
    assert.throws(() => readSuggestions(text), (err) => err instanceof SuggestError && err.code === 'bad-answer' && err.message.length > 10, text);
  }
});

test('ticketsInput sends each open ticket with its newest five comments, long text cut', () => {
  const tickets = [{ id: 'AL-1', name: 'Add x', status: 'queued', priority: 'high', description: 'd'.repeat(9000), tags: [], loopNote: 'secret-ish note' }];
  const comments = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, body: `comment ${i + 1}`, createdAt: `2026-11-1${i}` }));
  const input = JSON.parse(ticketsInput(tickets, () => comments));
  const t = input.openTickets[0];
  assert.deepEqual(Object.keys(t), ['id', 'name', 'status', 'priority', 'description', 'recentComments']);
  assert.deepEqual(t.recentComments.map((c) => c.body), ['comment 4', 'comment 5', 'comment 6', 'comment 7', 'comment 8']);
  assert.ok(t.description.length <= 4000);
});

test('skillPrompt is the suggest-next skill\'s steps, without its front matter', () => {
  const prompt = skillPrompt();
  assert.ok(prompt.includes('# Suggest next tasks'));
  assert.ok(!prompt.startsWith('---'));
  assert.ok(prompt.includes('Print **only** the JSON array'));
});

test('a run copies main into a fresh folder, gives claude the tickets on standard input only, reads five suggestions, and removes the folder', async () => {
  const s = scratch();
  try {
    let folder = null;
    const input = ticketsInput([{ id: 'AL-7', name: 'Unmistakable ticket name', status: 'queued', description: 'private words' }]);
    const got = await runSuggest({ repo: 'me/app', input, claudeBin: s.stub, source: s.source, tmpRoot: s.tmpRoot, env: s.env({ STUB_OUT: JSON.stringify(five()) }), onFolder: (f) => { folder = f; } });
    assert.deepEqual(got, five());
    const r = s.recorded();
    assert.equal(r.sawRepo, true, 'claude ran inside the copy');
    assert.ok(r.cwd.includes('spirality-suggest-'), 'in a fresh temp folder, never the lanes\' checkout');
    assert.ok(r.input.includes('Unmistakable ticket name') && r.input.includes('private words'), 'the tickets went in on standard input');
    const argv = r.args.join(' ');
    assert.ok(!argv.includes('Unmistakable ticket name') && !argv.includes('private words') && !argv.includes('AL-7'), 'and never in the arguments');
    assert.ok(argv.includes('# Suggest next tasks'), 'the skill is the prompt');
    assert.equal(r.args[r.args.indexOf('--tools') + 1], 'Read,Grep,Glob', 'read-only tools only');
    assert.equal(r.args[r.args.indexOf('--allowedTools') + 1], 'Read,Grep,Glob');
    assert.ok(folder && !existsSync(folder));
    assert.deepEqual(s.leftovers(), []);
  } finally { s.cleanup(); }
});

test('a bad answer, two items, a crash, a missing claude and a failed copy each fail with a plain message, and leave no folder', async () => {
  const s = scratch();
  try {
    const cases = [
      [{ STUB_OUT: '{ not json' }, s.stub, s.source, 'bad-answer'],
      [{ STUB_OUT: JSON.stringify(five().slice(0, 2)) }, s.stub, s.source, 'bad-answer'],
      [{ STUB_OUT: 'boom', STUB_EXIT: '3' }, s.stub, s.source, 'claude-failed'],
      [{}, join(s.dir, 'no-such-claude'), s.source, 'not-found'],
      [{}, s.stub, () => join(s.dir, 'no-such-repo'), 'copy-failed'],
    ];
    for (const [env, claudeBin, source, code] of cases) {
      await assert.rejects(
        runSuggest({ repo: 'me/app', input: '{}', claudeBin, source, tmpRoot: s.tmpRoot, env: s.env(env) }),
        (err) => err instanceof SuggestError && err.code === code && err.message.length > 20,
        code,
      );
      assert.deepEqual(s.leftovers(), [], `${code}: the folder is gone`);
    }
    await assert.rejects(runSuggest({ repo: null, input: '{}', claudeBin: s.stub, tmpRoot: s.tmpRoot }), (err) => err.code === 'no-repo' && /repository/.test(err.message));
  } finally { s.cleanup(); }
});

test('a claude that hangs is stopped at the time limit, the run fails, and the folder is gone', async () => {
  const s = scratch();
  try {
    const started = Date.now();
    await assert.rejects(
      runSuggest({ repo: 'me/app', input: '{}', claudeBin: s.stub, source: s.source, tmpRoot: s.tmpRoot, timeLimitMs: 1500, env: s.env({ STUB_HANG: '1' }) }),
      (err) => err instanceof SuggestError && err.code === 'time-limit' && /2-second limit|1-second limit|limit for a run passed/.test(err.message),
    );
    assert.ok(Date.now() - started < 10000, 'it did not wait for the stub');
    assert.deepEqual(s.leftovers(), []);
  } finally { s.cleanup(); }
});

test('the suggester keeps one run per project, answers it while it runs, and keeps the finished list in the store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-suggest-store-'));
  const store = openStore(join(dir, 'tracker.db'));
  try {
    const human = store.createActor({ kind: 'human', name: 'Operator' });
    const project = store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL', operator: human.id, repo: 'me/app' });
    let release;
    const calls = [];
    const run = (options) => { calls.push(options); return new Promise((resolve) => { release = resolve; }); };
    const sug = createSuggester({ store, run, inputOf: () => 'the tickets', options: { claudeBin: 'stub' } });
    assert.equal(sug.latest('alpha'), null);
    const first = sug.start(project);
    const second = sug.start(project);
    assert.equal(first.state, 'running');
    assert.equal(second.id, first.id, 'two starts in a row give one run');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { claudeBin: 'stub', repo: 'me/app', input: 'the tickets' });
    assert.equal(sug.latest('alpha').state, 'running');
    release(five());
    await sug.settled('alpha');
    const done = sug.latest('alpha');
    assert.equal(done.state, 'done');
    assert.deepEqual(done.suggestions, five());
    assert.deepEqual(store.nextSuggestions('alpha').suggestions, five(), 'kept in the store');

    // A failed run replaces it, with its message; a new start after a finish is a new run.
    const third = sug.start(project);
    assert.notEqual(third.id, first.id);
    const p = sug.settled('alpha');
    release(Promise.reject(new SuggestError('bad-answer', 'Claude gave 2 suggestions; a good answer has 3 to 7.')));
    await p;
    assert.deepEqual(sug.latest('alpha'), { state: 'failed', message: 'Claude gave 2 suggestions; a good answer has 3 to 7.', at: sug.latest('alpha').at });
    assert.equal(store.listTickets('alpha').length, 0, 'no ticket is written');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
