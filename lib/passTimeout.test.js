'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pt = require('./passTimeout.js');
const operatorCard = require('./operatorCard.js');

/**
 * Task 86bccr85c. On 2026-10-04 five loop-build passes in a row on "Galaxy
 * module 5/6" were stopped at the two-hour limit while re-running an 8-minute
 * `npm run check:render`, and nothing anywhere said so. These cover the two
 * answers: name what was running, and stop re-claiming after the second stop.
 */

const REPO = path.join(__dirname, '..');

// What `run_with_time_limit.sh` writes: depth, pid, elapsed, command.
const GALAXY_STOP = [
  "1\t501\t07:12\t/bin/zsh -c source ~/.claude/shell-snapshots/s.sh && eval 'cd .claude/worktrees/galaxy-5 && UI_HARNESS_BASE_URL=http://localhost:3058 npm run check:render 2>&1 | tail -40'",
  '1\t502\t1:45:03\tnode ~/.npm/_npx/mcp-server.js',
  '2\t601\t07:11\tnpm run check:render',
  '3\t701\t07:10\tnode scripts/ui/check_render.mjs',
  '4\t801\t06:58\t/Applications/Chromium.app/Contents/MacOS/Chromium --headless',
].join('\n');

test('elapsed times in every shape ps prints', () => {
  assert.equal(pt.etimeToSeconds('07:12'), 432);
  assert.equal(pt.etimeToSeconds('1:45:03'), 6303);
  assert.equal(pt.etimeToSeconds('2-01:00:00'), 176400);
  assert.equal(pt.etimeToSeconds('soon'), null);
  assert.equal(pt.formatDuration(432), '7m 12s');
  assert.equal(pt.formatDuration(7200), '2h 00m');
  assert.equal(pt.formatDuration(9), '9s');
});

test('the 2026-10-04 stop names the gate, not the shell or the browser under it', () => {
  const rows = pt.parseSnapshot(GALAXY_STOP);
  assert.equal(rows.length, 5);
  const stuck = pt.describeStuck(rows);
  assert.equal(stuck.kind, 'gate');
  assert.equal(stuck.what, 'npm run check:render');
  assert.equal(stuck.seconds, 432, 'the shallowest line naming it is the step the pass chose');
  assert.equal(pt.stuckSentence(stuck), 'it was running `npm run check:render` (7m 12s in)');
});

test('gate names: npm run, npm test, npx; plain commands are not gates', () => {
  assert.equal(pt.gateName('npm run --silent typecheck'), 'npm run typecheck');
  assert.equal(pt.gateName('/bin/bash /tmp/fake/npm run test:builder'), 'npm run test:builder');
  assert.equal(pt.gateName('npm test'), 'npm test');
  assert.equal(pt.gateName('npx --yes esbuild x.ts'), 'npx esbuild');
  assert.equal(pt.gateName('sleep 60'), '');
});

test('a shell with no named gate is reported as the command it was running', () => {
  const stuck = pt.describeStuck(pt.parseSnapshot("1\t9\t03:00\t/bin/zsh -c eval 'git merge origin/main'"));
  assert.equal(stuck.kind, 'command');
  assert.match(stuck.what, /git merge origin\/main/);
});

test('nothing under the pass is the idle shape of 2026-09-12, and says so', () => {
  for (const snap of ['', '\n', 'garbage line']) {
    const stuck = pt.describeStuck(pt.parseSnapshot(snap));
    assert.equal(stuck.kind, 'idle');
    assert.match(pt.stuckSentence(stuck), /nothing was running under it/);
  }
});

// ---------------------------------------------------------------------------
// The second stop escalates rather than going back to the claim line.
// ---------------------------------------------------------------------------

const c = (text, date) => ({ comment_text: text, date: String(date) });
const MARK = (n) => c(`${pt.TIMEOUT_MARK} a /loop-build pass was stopped (stop ${n})\n\n[machine]`, n * 1000);

test('first stop goes back to the claim line; the second escalates', () => {
  assert.deepEqual(pt.timeoutDecision(pt.priorTimeouts([])), { stop: 1, escalate: false });
  assert.deepEqual(pt.timeoutDecision(pt.priorTimeouts([MARK(1)])), { stop: 2, escalate: true });
  assert.deepEqual(pt.timeoutDecision(pt.priorTimeouts([MARK(1), MARK(2), MARK(3)])), { stop: 4, escalate: true });
});

test('stops before the ticket last reached a pull request do not count', () => {
  const comments = [MARK(1), c('PR opened: https://github.com/x/y/pull/9', 1500), c('unrelated note', 1600)];
  assert.equal(pt.priorTimeouts(comments), 0, 'a pass got through after that stop');
  assert.equal(pt.priorTimeouts([...comments, MARK(2)]), 1, 'a rework pass stopped after the PR does count');
});

test('comments are counted in time order whatever order the API returns them', () => {
  const newestFirst = [c('PR opened: https://github.com/x/y/pull/9', 5000), MARK(1)];
  assert.equal(pt.priorTimeouts(newestFirst), 0);
  assert.equal(pt.priorTimeouts([MARK(9), c('PR opened: x', 1000)]), 1);
});

test('the ticket note names the gate, the stop number and what happens next', () => {
  const rows = pt.parseSnapshot(GALAXY_STOP);
  const stuck = pt.describeStuck(rows);
  const first = pt.timeoutNote({ skill: 'loop-build', limitSeconds: 7200, at: '10/4 3:54am', rows, stuck, decision: { stop: 1, escalate: false } });
  assert.ok(first.startsWith(pt.TIMEOUT_MARK), 'the mark is what the next stop counts');
  assert.match(first, /stopped at the 2h 00m limit at 10\/4 3:54am \(stop 1/);
  assert.match(first, /npm run check:render/);
  assert.match(first, /hands this ticket back to the claim line/);
  const second = pt.timeoutNote({ skill: 'loop-build', limitSeconds: 7200, at: 'x', rows, stuck, decision: { stop: 2, escalate: true } });
  assert.match(second, /goes to Dane instead of back to the claim line/);
});

test('the escalation card passes the same shape check `ask` enforces', () => {
  const longGate = { kind: 'command', what: 'git merge origin/main && npm ci && some very long command line that goes on and on and on for many words indeed', seconds: 60 };
  for (const stuck of [pt.describeStuck(pt.parseSnapshot(GALAXY_STOP)), longGate, { kind: 'idle', what: '', seconds: null }]) {
    const body = pt.escalationCard({ skill: 'loop-build', limitSeconds: 7200, stuck, decision: { stop: 2, escalate: true }, at: '10/4 3:54am' });
    assert.doesNotThrow(() => operatorCard.buildCard(body), `card for ${stuck.kind} must be postable`);
    const card = operatorCard.parseCard(body);
    assert.match(card.asked, /No instruction of yours/, 'never an invented quote');
  }
});

// ---------------------------------------------------------------------------
// Rehearsal: a pass that hangs inside a gate, stopped by the real script.
// ---------------------------------------------------------------------------

test('rehearsal: a pass hung in a gate is stopped and the snapshot names that gate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pass-timeout-'));
  const fakeNpm = path.join(dir, 'npm');
  fs.writeFileSync(fakeNpm, '#!/bin/bash\nsleep 60\n', { mode: 0o755 });
  const snap = path.join(dir, 'snapshot');
  // A stand-in for `claude -p`: it runs a gate through a shell, as the Bash tool does.
  const r = spawnSync('bash', [path.join(REPO, 'scripts', 'run_with_time_limit.sh'), '3', '--',
    'bash', '-c', 'bash -c "npm run check:render; true" ; true'], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUN_WITH_TIME_LIMIT_POLL: '1', RUN_WITH_TIME_LIMIT_GRACE: '2', RUN_WITH_TIME_LIMIT_SNAPSHOT: snap },
    encoding: 'utf8', timeout: 30000,
  });
  assert.equal(r.status, 124);
  assert.match(r.stdout, /what was running under it/, 'the log names it too, not only the file');
  assert.match(r.stdout, /npm run check:render/);
  const stuck = pt.describeStuck(pt.parseSnapshot(fs.readFileSync(snap, 'utf8')));
  assert.equal(stuck.kind, 'gate');
  assert.equal(stuck.what, 'npm run check:render');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loop_runner.sh hands a stopped pass to pass-timeout, with the snapshot it asked for', () => {
  const runner = fs.readFileSync(path.join(REPO, 'scripts', 'loop_runner.sh'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  assert.match(runner, /RUN_WITH_TIME_LIMIT_SNAPSHOT="\$SNAPSHOT" \\\s*\n\s*"\$REPO\/scripts\/run_with_time_limit\.sh"/);
  assert.match(runner, /rm -f "\$SNAPSHOT"/, 'a stop must never report the previous stop\'s snapshot');
  assert.match(runner, /if \[ "\$CODE" -eq 124 \]; then\s*\n\s*npm run --silent clickup -- pass-timeout --pass "\$SKILL"[^\n]*\\\s*\n\s*--limit "\$\{LOOP_PASS_LIMIT_SECONDS:-7200\}" --snapshot "\$SNAPSHOT"/);
});
