'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, 'check_operator_handoff.cjs');
const {
  offendingCommands,
  statedException,
  splitFences,
  stripEnvPrefix,
  lastAssistantTurn,
  isInteractive,
} = require('../lib/operator_handoff.cjs');

/**
 * The Stop hook that enforces CLAUDE.md "CC runs the operational commands".
 *
 * The point of this file is the FAILING case. A guard that only proves it
 * stays quiet has proved nothing -- the rule it replaces was "enforced" by
 * being written down three times and was broken all three times. So the tests
 * that matter drive the real hook process with real JSON and assert it
 * actually refuses, with the actual exit code the harness reads.
 */

const FENCE = '```';

function fenced(body, lang = '') {
  return `${FENCE}${lang}\n${body}\n${FENCE}`;
}

/** A transcript the hook can read: one assistant turn, with an entrypoint. */
function makeTranscript(text, entrypoint = 'cli') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophandoff-'));
  const file = path.join(dir, 'transcript.jsonl');
  const records = [
    { type: 'user', entrypoint, message: { role: 'user', content: 'go' } },
    {
      type: 'assistant',
      entrypoint,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
  ];
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

/**
 * A session id no other test (or earlier run of this suite) can collide with.
 *
 * The refusal counter is keyed by session id, and since it now falls back to
 * the temp directory when there is no git dir, a FIXED id would persist across
 * tests and across runs -- three refusals anywhere would silently stand the
 * hook down everywhere after. Tests that need several turns to share a session
 * take one id from here and pass it to each call.
 */
let sessionSeq = 0;
function nextSession(tag = 'test') {
  sessionSeq += 1;
  return `${tag}-${process.pid}-${sessionSeq}`;
}

function runHook(
  text,
  { entrypoint = 'cli', sessionId = nextSession(), cwd = os.tmpdir(), payload = {}, env } = {}
) {
  const result = spawnSync('node', [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: sessionId,
      cwd,
      transcript_path: makeTranscript(text, entrypoint),
      ...payload,
    }),
    encoding: 'utf8',
    ...(env ? { env } : {}),
  });
  return { code: result.status, stderr: result.stderr || '' };
}

/** Five turns in a row, so a counter that never advances is visible as a run. */
function fiveTurns(message, opts) {
  return [0, 1, 2, 3, 4].map(() => runHook(message, opts).code);
}

// ---------------------------------------------------------------------------
// The four cases the ticket names, driven through the real hook.
// ---------------------------------------------------------------------------

test('a fenced doppler block fails the stop', () => {
  const { code, stderr } = runHook(
    `Here is how to list the Delray pages:\n\n${fenced('doppler run -- node scripts/list_pages.mjs', 'bash')}`
  );
  assert.equal(code, 2, 'must refuse the stop');
  assert.match(stderr, /hands the operator a command/i);
  assert.match(stderr, /doppler run -- node scripts\/list_pages\.mjs/);
});

test('the same block with "Exception: secret value" passes', () => {
  const { code } = runHook(
    `You have to run this one -- it prints the real token.\n\n`
    + `Exception: secret value\n\n${fenced('doppler run -- printenv SUPABASE_SERVICE_KEY', 'bash')}`
  );
  assert.equal(code, 0, 'a named exception is the sanctioned way through');
});

test('an inline backtick mention passes', () => {
  const { code } = runHook(
    'I ran `npm run doctor` and the folder is sound; `doppler run` was not needed.'
  );
  assert.equal(code, 0, 'naming a command is not handing it over');
});

test('npm run pipeline -- resume --operator-asked passes', () => {
  const { code } = runHook(
    `The line is paused. Only you can hand the deck back:\n\n`
    + fenced('npm run pipeline -- resume --operator-asked')
  );
  assert.equal(code, 0, 'resume is operator-only by doctrine');
});

// ---------------------------------------------------------------------------
// Break it on purpose: the exception line is what makes the difference.
// ---------------------------------------------------------------------------

test('removing the exception line turns the same reply into a refusal', () => {
  const block = fenced('doppler run -- printenv SUPABASE_SERVICE_KEY', 'bash');
  const withLine = `You have to run this one.\n\nException: secret value\n\n${block}`;
  const withoutLine = `You have to run this one.\n\n${block}`;

  assert.equal(runHook(withLine).code, 0);
  assert.equal(
    runHook(withoutLine).code, 2,
    'if this passes, the exception line is not what is being read'
  );
});

// ---------------------------------------------------------------------------
// Every command shape in the spec.
// ---------------------------------------------------------------------------

test('each handed-over command shape is caught', () => {
  const caught = [
    'doppler run --project starcaster -- node scripts/x.mjs',
    'ssh mac-mini',
    'ssh -p 22 dane@mini',
    'npm run db:refresh',
    'node scripts/check_conventions.cjs',
    'cd ~/WebApps/starcaster && npm run build',
  ];
  for (const command of caught) {
    assert.equal(
      offendingCommands(fenced(command)).length, 1,
      `should have been caught: ${command}`
    );
  }
});

test('near-misses are left alone', () => {
  const allowed = [
    'npm run pipeline -- resume --operator-asked',
    'ssh-keygen -t ed25519',       // local key work, not a hand-off
    'git status',
    'node server.js',              // not node scripts/
    'SELECT * FROM pages;',
    'cd ~/WebApps/normie && ls',   // not this repo's preamble
  ];
  for (const command of allowed) {
    assert.deepEqual(
      offendingCommands(fenced(command)), [],
      `should NOT have been caught: ${command}`
    );
  }
});

test('EVERY line of a block is judged, not only the first', () => {
  // The shape CLAUDE.md itself prints: a setup line, then the real command.
  // `node server.js` is not a hand-off, so first-line-only judged this clean
  // and never looked at the `npm run` underneath it.
  const harness = fenced(
    'PORT=3058 node server.js\n'
    + 'UI_HARNESS_BASE_URL=http://localhost:3058 npm run check:render'
  );
  assert.deepEqual(
    offendingCommands(harness).map((o) => o.command),
    ['npm run check:render'],
    'a command on the second line of a fence is still handed over'
  );

  assert.equal(offendingCommands(fenced('# a note\nnpm run build')).length, 1,
    'a comment above the command does not hide it');
  assert.equal(offendingCommands(fenced('\n\nnpm run build')).length, 1,
    'blank lines before the command do not hide it');
});

test('pasted npm OUTPUT is not read as a hand-off', () => {
  // The one false positive every-line scanning introduced, and why stripPrompt
  // no longer treats `>` as a shell prompt: `>` is npm's own log marker, so a
  // pasted run log looked like a hand-off of the command it was REPORTING.
  const log = fenced(
    '> starcaster@1.0.0 clickup\n'
    + '> doppler run --project starcaster -- node scripts/clickup_direct.mjs queue'
  );
  assert.deepEqual(
    offendingCommands(log), [],
    'reporting what a command said is the opposite of handing it over'
  );
  assert.equal(offendingCommands(fenced('$ npm run build')).length, 1,
    'control: a real `$` prompt is still stripped and still caught');
});

test('a leading VAR=value prefix does not hide the command', () => {
  const cases = [
    ['UI_HARNESS_BASE_URL=http://localhost:3057 npm run check:panels', 'npm run check:panels'],
    ['FOO=1 BAR=2 npm run build', 'npm run build'],
    ['PORT=3057 node scripts/x.mjs', 'node scripts/x.mjs'],
  ];
  for (const [line, bare] of cases) {
    assert.equal(stripEnvPrefix(line), bare, `should peel to \`${bare}\``);
    assert.equal(offendingCommands(fenced(line)).length, 1, `should be caught: ${line}`);
  }

  assert.deepEqual(
    offendingCommands(fenced('SKIP_CONVENTIONS=1 npm run pipeline -- resume --operator-asked')),
    [],
    'peeling the prefix must not peel away the operator-only exemption'
  );
  assert.deepEqual(
    offendingCommands(fenced('PORT=3058 node server.js')), [],
    'node server.js is not a hand-off shape with or without the prefix'
  );
});

test('a pasted shell prompt does not hide the command', () => {
  assert.equal(offendingCommands(fenced('$ npm run db:refresh')).length, 1);
});

test('an unterminated fence still counts', () => {
  assert.equal(offendingCommands('here:\n```bash\nnpm run db:refresh').length, 1);
});

test('a tilde fence counts too', () => {
  assert.equal(offendingCommands('~~~\nnpm run db:refresh\n~~~').length, 1);
});

// ---------------------------------------------------------------------------
// The exception line itself.
// ---------------------------------------------------------------------------

test('all four exceptions are accepted, and nothing else is', () => {
  for (const word of ['secret value', 'billing', 'browser login', 'decision']) {
    assert.equal(statedException(`Exception: ${word}\n`), word);
  }
  assert.equal(statedException('Exception: I was busy\n'), null);
  assert.equal(statedException('no exception here\n'), null);
});

test('markdown emphasis on the exception line is tolerated', () => {
  assert.equal(statedException('**Exception:** decision — your call\n'), 'decision');
});

test('a bullet in front of the exception line does not invalidate it', () => {
  // A hyphen bullet is a normal way to write this line, and `-` was not in the
  // strip set: naming an exception correctly and being refused anyway is the
  // surest way to send an agent to SKIP_OPERATOR_HANDOFF=1 for no reason.
  for (const bullet of ['-', '*', '+', '>', '  -  ']) {
    assert.equal(
      statedException(`${bullet} Exception: secret value\n`), 'secret value',
      `a \`${bullet.trim()}\` bullet must not invalidate the claim`
    );
  }
  assert.equal(
    statedException('- Exception: I was busy\n'), null,
    'a bullet does not make an unlisted reason acceptable'
  );
  assert.equal(
    runHook(`- Exception: secret value\n\n${fenced('doppler run -- printenv TOKEN')}`).code, 0,
    'and it works through the real hook, not just the helper'
  );
});

test('the four keywords are recognised in ordinary English, not only bare', () => {
  // Round 2's blocker. `statedException` required the keyword to be the FIRST
  // thing after the colon, so ten of these sixteen were refused -- including
  // `a real secret VALUE` and `a decision that is genuinely his`, which are
  // CLAUDE.md's OWN words for two of the four. The document and its tripwire
  // disagreeing about what the exceptions are called is the harmful direction:
  // it refuses a reply that named its exception correctly.
  const accepted = [
    ['Exception: decision', 'decision'],
    ['Exception: a decision that is genuinely his', 'decision'],
    ['Exception: a decision that is genuinely yours', 'decision'],
    ['Exception: this is a decision', 'decision'],
    ['Exception: billing', 'billing'],
    ['Exception: a billing screen', 'billing'],
    ['Exception: the secret value is yours to type', 'secret value'],
    ['Exception: a real secret VALUE', 'secret value'],
    ['Exception: browser login', 'browser login'],
    ['Exception: a browser login', 'browser login'],
    ['1. Exception: decision', 'decision'],
    ['1) Exception: decision', 'decision'],
    ['* Exception: decision', 'decision'],
    ['- Exception: decision', 'decision'],
    ['Exception - decision', 'decision'],
    ['Exception: DECISION', 'decision'],
  ];
  for (const [line, want] of accepted) {
    assert.equal(statedException(`${line}\n`), want, `must accept: ${line}`);
  }
});

test('widening the match did not make it a rubber stamp', () => {
  // The four keywords are still the whole list -- they just no longer have to
  // lead the sentence. A reason that is not one of them is still refused, in
  // every wrapper the peeling above tolerates.
  for (const line of [
    'Exception: I was busy',
    'Exception: it seemed fine',
    '1. Exception: I was busy',
    'Exception - I was busy',
    'Exceptional work today',
    'no exception here',
  ]) {
    assert.equal(statedException(`${line}\n`), null, `must refuse: ${line}`);
  }
});

test("CLAUDE.md's own wording gets through the real hook, not just the helper", () => {
  // The end-to-end version of the blocker: a reply that hands over a command
  // AND names its exception in the document's own words must end the turn.
  const message = `That value is yours to type.\n\nException: a real secret VALUE\n\n${fenced('doppler run -- printenv SUPABASE_SERVICE_KEY')}`;
  assert.equal(runHook(message).code, 0, 'a correctly-named exception must not be refused');
  assert.equal(
    runHook(`Here you go:\n\n${fenced('doppler run -- printenv SUPABASE_SERVICE_KEY')}`).code, 2,
    'control: the same block with no exception line is still refused'
  );
});

test('a numbered bullet does not invalidate the claim, through the real hook', () => {
  assert.equal(
    runHook(`1. Exception: a decision that is genuinely his\n\n${fenced('npm run db:refresh')}`).code, 0
  );
});

test('an exception line inside a code fence does not count', () => {
  const message = fenced('Exception: decision') + '\n' + fenced('npm run db:refresh');
  assert.equal(statedException(message), null, 'an example is not a claim');
  assert.equal(runHook(message).code, 2);
});

// ---------------------------------------------------------------------------
// Scope: headless loop runs have no operator at the other end.
// ---------------------------------------------------------------------------

test('a headless (sdk-cli) run is not touched', () => {
  const message = `Ran the refresh:\n\n${fenced('npm run db:refresh')}`;
  assert.equal(runHook(message, { entrypoint: 'cli' }).code, 2, 'control: fires interactively');
  assert.equal(
    runHook(message, { entrypoint: 'sdk-cli' }).code, 0,
    'nobody is reading a loop transcript live'
  );
});

test('isInteractive only says yes to a terminal session', () => {
  assert.equal(isInteractive('cli'), true);
  assert.equal(isInteractive('sdk-cli'), false);
  assert.equal(isInteractive(null), false);
});

// ---------------------------------------------------------------------------
// Failing open, and not wedging the session.
// ---------------------------------------------------------------------------

test('an unreadable transcript steps aside rather than wedging the turn', () => {
  const result = spawnSync('node', [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: nextSession('missing'),
      cwd: os.tmpdir(),
      transcript_path: path.join(os.tmpdir(), 'does-not-exist-12345.jsonl'),
    }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
});

test('unparseable input steps aside', () => {
  const result = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(result.status, 0);
});

test('SKIP_OPERATOR_HANDOFF=1 stands it down', () => {
  const result = spawnSync('node', [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: nextSession('skip'),
      cwd: os.tmpdir(),
      transcript_path: makeTranscript(fenced('npm run db:refresh'), 'cli'),
    }),
    encoding: 'utf8',
    env: { ...process.env, SKIP_OPERATOR_HANDOFF: '1' },
  });
  assert.equal(result.status, 0);
});

test('the stand-down also works from inside a WORKTREE', () => {
  // The regression this exists for: state used to be written to
  // `<toplevel>/.git/`, which is a DIRECTORY only in the main checkout. In a
  // worktree `.git` is a one-line file, so the write failed with ENOTDIR --
  // silently, because it is wrapped in a try/catch -- and the counter never
  // advanced. Every thread in this repo runs in a worktree, so the safety
  // valve was inoperative in exactly the folders that use it. Without the
  // `--absolute-git-dir` fix this test refuses four times instead of three.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophandoff-wt-'));
  const git = (args, cwd) => spawnSync('git', args, { cwd, stdio: 'ignore' });
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'test'], dir);
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'seed'], dir);

  const wt = path.join(dir, 'wt');
  git(['worktree', 'add', wt, '-b', 'topic'], dir);
  assert.ok(fs.statSync(path.join(wt, '.git')).isFile(), 'precondition: .git is a file in a worktree');

  const message = fenced('npm run db:refresh');
  const opts = { sessionId: nextSession('worktree'), cwd: wt };

  assert.equal(runHook(message, opts).code, 2);
  assert.equal(runHook(message, opts).code, 2);
  assert.equal(runHook(message, opts).code, 2);
  assert.equal(
    runHook(message, opts).code, 0,
    'the refusal counter never persisted in a worktree, so it could never stand down'
  );
});

test('it stands down after three refusals in one session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophandoff-repo-'));
  spawnSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  const message = fenced('npm run db:refresh');
  const opts = { sessionId: nextSession('wedge'), cwd: dir };

  assert.equal(runHook(message, opts).code, 2);
  assert.equal(runHook(message, opts).code, 2);
  assert.equal(runHook(message, opts).code, 2);
  assert.equal(
    runHook(message, opts).code, 0,
    'a hook that can wedge a conversation shut is worse than the miss it prevents'
  );
});

test('the stand-down still engages when the git dir cannot be resolved', () => {
  // The counter used to live inside `if (stateDir(cwd))`. `stateDir` shells out
  // to git, so in both conditions below it came back empty, the `if` was
  // skipped, and the hook refused EVERY turn with no limit at all -- the brake
  // missing in exactly the cases it exists for. Measured before the fix:
  // 2,2,2,2,2 for both. Five turns, so "no cap" cannot hide behind three.
  const message = fenced('npm run db:refresh');
  const capped = [2, 2, 2, 0, 0];

  // (a) cwd outside any git repository at all.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ophandoff-nogit-'));
  assert.deepEqual(
    fiveTurns(message, { sessionId: nextSession('nogit-dir'), cwd: outside }), capped,
    'outside a repo there is no git dir, and the brake must not depend on one'
  );

  // (b) `git` not on PATH -- a documented condition in agent shells here,
  // where a bare PATH without /opt/homebrew/bin is the normal starting state.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ophandoff-bin-'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  assert.equal(
    spawnSync('git', ['--version'], { env: { PATH: bin }, encoding: 'utf8' }).status, null,
    'precondition: git really is unreachable on this PATH'
  );
  assert.deepEqual(
    fiveTurns(message, {
      sessionId: nextSession('nogit-path'),
      cwd: os.tmpdir(),
      env: { ...process.env, PATH: bin },
    }),
    capped,
    'no git means no git dir, and still no unlimited refusal'
  );
});

test('stop_hook_active stands the hook down immediately', () => {
  // The harness's own infinite-loop guard. Ignoring it left the refusal
  // counter as the only brake in the system -- and that was the brake that
  // disappeared whenever the git dir could not be resolved. Two independent
  // limits, so neither one failing alone can wedge the session.
  const message = fenced('npm run db:refresh');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophandoff-active-'));
  spawnSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });

  assert.equal(
    runHook(message, { sessionId: nextSession('active-control'), cwd: dir }).code, 2,
    'control: the same reply refuses when the flag is absent'
  );
  assert.deepEqual(
    fiveTurns(message, {
      sessionId: nextSession('active-test'),
      cwd: dir,
      payload: { stop_hook_active: true },
    }),
    [0, 0, 0, 0, 0],
    'the harness says it has already blocked once; do not block again'
  );
});

// ---------------------------------------------------------------------------
// Transcript reading.
// ---------------------------------------------------------------------------

test('the last assistant message with TEXT is the one read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophandoff-tr-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'assistant', entrypoint: 'cli', message: { content: [{ type: 'text', text: 'first' }] } }),
    JSON.stringify({ type: 'assistant', entrypoint: 'cli', message: { content: [{ type: 'text', text: 'the real reply' }] } }),
    // The final record is very often a bare tool_use with no text at all.
    JSON.stringify({ type: 'assistant', entrypoint: 'cli', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } }),
  ].join('\n') + '\n');

  const turn = lastAssistantTurn(file);
  assert.equal(turn.text, 'the real reply');
  assert.equal(turn.entrypoint, 'cli');
});

test('splitFences keeps prose and blocks apart', () => {
  const { blocks, prose } = splitFences(`before\n${FENCE}\nin here\n${FENCE}\nafter`);
  assert.deepEqual(blocks, ['in here']);
  assert.deepEqual(prose, ['before', 'after']);
});

// ---------------------------------------------------------------------------
// The wiring. A hook script that nothing invokes is dead code that reads as a
// control -- exactly the "check that could silently not run" CLAUDE.md warns
// about. This is the only thing that proves the tripwire is armed.
// ---------------------------------------------------------------------------

test('the hook is registered as a Stop hook in .claude/settings.json', () => {
  const settingsPath = path.join(__dirname, '..', '..', '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  const stop = (settings.hooks && settings.hooks.Stop) || [];
  const commands = stop.flatMap((entry) => (entry.hooks || []).map((h) => String(h.command || '')));

  assert.ok(
    commands.some((c) => c.includes('scripts/hooks/check_operator_handoff.cjs')),
    'unwired, the tripwire is a file nobody runs'
  );
});

test('the wired command actually points at a file that exists', () => {
  assert.ok(fs.existsSync(HOOK), HOOK);
});
