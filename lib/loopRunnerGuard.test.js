'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const guard = require('./loopRunnerGuard.js');

const REPO = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
/** Executable source only: comments explain the rules and must not satisfy them. */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
/** Shell source without comment lines, same reason. */
function shellWithoutComments(text) {
  return text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

// 2026-09-02, 02:08 in America/Denver (UTC-6 in September) — eight minutes
// into the real incident this module was written about.
const AT_0208 = Date.parse('2026-09-02T08:08:00.000Z');
const limitLine = (t) => `You've hit your session limit · resets ${t}`;

// ---------------------------------------------------------------------------
// The parser (task 86bbtuje2). Every message shape below was seen in a real
// log on the Mini; none is invented.
// ---------------------------------------------------------------------------

test('the 2:05am incident, replayed: the runner sleeps to the stated reset', () => {
  const d = guard.limitDelay({ text: limitLine('2:50am (America/Denver)'), nowMs: AT_0208 });
  // 02:08 -> 02:50 is 42 minutes, plus the margin.
  assert.equal(d.seconds, 42 * 60 + guard.MARGIN_SECONDS);
  assert.match(d.reason, /2:50am/);
});

test('hour-only and 12-o-clock forms parse — all seen live', () => {
  // "resets 10pm" at 21:30 Denver -> 30 min + margin.
  const at2130 = Date.parse('2026-09-03T03:30:00.000Z');
  assert.equal(guard.limitDelay({ text: limitLine('10pm (America/Denver)'), nowMs: at2130 }).seconds,
    30 * 60 + guard.MARGIN_SECONDS);
  // "resets 12am" (midnight) at 23:00 Denver -> 60 min + margin.
  const at2300 = Date.parse('2026-09-03T05:00:00.000Z');
  assert.equal(guard.limitDelay({ text: limitLine('12am (America/Denver)'), nowMs: at2300 }).seconds,
    60 * 60 + guard.MARGIN_SECONDS);
  // "resets 12:50pm" at 12:08 Denver -> 42 min + margin.
  const at1208 = Date.parse('2026-09-02T18:08:00.000Z');
  assert.equal(guard.limitDelay({ text: limitLine('12:50pm (America/Denver)'), nowMs: at1208 }).seconds,
    42 * 60 + guard.MARGIN_SECONDS);
});

test('no limit line means null — the two absences must not blur', () => {
  // null is "pace normally"; a backoff object is "limited but unreadable".
  // Collapsing them would either slow every healthy pass or blind the guard.
  assert.equal(guard.limitDelay({ text: 'a perfectly ordinary pass report', nowMs: AT_0208 }), null);
  assert.equal(guard.limitDelay({ text: '', nowMs: AT_0208 }), null);
});

test('a limit whose time cannot be read backs off rather than retrying blind', () => {
  const d = guard.limitDelay({ text: "You've hit your session limit · resets soonish", nowMs: AT_0208 });
  assert.equal(d.seconds, guard.DEFAULT_BACKOFF_SECONDS);
  assert.match(d.reason, /could not be read/);
});

test('an absurd computed sleep falls to the backoff, never to silence-for-a-day', () => {
  // A reset that reads as ~23h away is almost always a stale or mis-read
  // message, and obeying it would park a loop for most of a day on a guess.
  const at1400 = Date.parse('2026-09-02T20:00:00.000Z'); // 14:00 Denver
  const d = guard.limitDelay({ text: limitLine('1pm (America/Denver)'), nowMs: at1400 });
  assert.equal(d.seconds, guard.DEFAULT_BACKOFF_SECONDS);
  assert.match(d.reason, /sanity cap/);
});

test('a zone this machine cannot resolve degrades to the default zone, not a crash', () => {
  const d = guard.limitDelay({ text: limitLine('2:50am (Mars/Olympus)'), nowMs: AT_0208 });
  // Computed as Denver — the only zone ever observed — and still a real sleep.
  assert.equal(d.seconds, 42 * 60 + guard.MARGIN_SECONDS);
});

test('a missing zone defaults instead of failing — wording drift must degrade', () => {
  const d = guard.limitDelay({ text: limitLine('2:50am'), nowMs: AT_0208 });
  assert.equal(d.seconds, 42 * 60 + guard.MARGIN_SECONDS);
});

// ---------------------------------------------------------------------------
// Scoping: a limit line can only belong to the pass that just ran.
// ---------------------------------------------------------------------------

test('a previous pass\'s limit line is out of scope for this pass', () => {
  // The trap: 2:38am's "resets 2:50am" is still in the log tail when the
  // 3:00am pass succeeds. Unscoped, that reads as a limit whose reset is now
  // ~24h away -> the sanity cap -> a needless half-hour backoff after a
  // HEALTHY pass, forever, every pass, since the line never leaves the tail.
  const text = [
    '===== 2026-09-02 02:38:43 START /loop-build =====',
    limitLine('2:50am (America/Denver)'),
    '===== 2026-09-02 02:38:47 END /loop-build =====',
    '===== 2026-09-02 03:00:00 START /loop-build =====',
    'a healthy pass report',
  ].join('\n');
  const scoped = guard.scopeToLastPass(text);
  assert.equal(guard.limitDelay({ text: scoped, nowMs: Date.parse('2026-09-02T09:05:00.000Z') }), null);
  // And unscoped it WOULD have misfired — proving the scope is load-bearing.
  assert.notEqual(guard.limitDelay({ text, nowMs: Date.parse('2026-09-02T09:05:00.000Z') }), null);
});

test('a log with no pass marker is scanned whole', () => {
  assert.equal(guard.scopeToLastPass('no markers here'), 'no markers here');
});

// ---------------------------------------------------------------------------
// The runner and its installer — source-shape, because the thing under test
// is a bash file whose behaviour IS its text.
// ---------------------------------------------------------------------------

test('a pass runs pull -> claude -> limit reading -> sleep decision, in that order', () => {
  const sh = shellWithoutComments(read('scripts/loop_runner.sh'));
  // Moved from StarCaster (SP-396). StarCaster's runner beats between the
  // limit reading and the sleep; Spirality's beat after every pass is the next
  // slice (SP-397), so the beat's place in this order is checked there.
  const pull = sh.indexOf('git pull -q --ff-only origin main');
  const pass = sh.indexOf('"$CLAUDE_BIN" -p');
  const limit = sh.indexOf('loop_runner_delay.mjs');
  const pace = sh.indexOf('sleep_until_woken', sh.indexOf('read_wake_time', limit));
  assert.ok(pull > 0 && pass > pull, 'the timid pull comes before the pass, or a merged skill edit lags a cycle');
  assert.ok(limit > pass, 'the limit is read out of the pass\'s own output, so it follows the pass');
  assert.ok(pace > limit, 'the usage limit outranks the wake time');
});

test('THE ROUND-2 DEFECT: the runner consults the EXIT CODE, and only asks the guard when it is non-zero', () => {
  const sh = shellWithoutComments(read('scripts/loop_runner.sh'));
  const guardCall = sh.indexOf('loop_runner_delay.mjs');
  assert.ok(guardCall > 0, 'the guard is still called');
  // The guard call must sit INSIDE a non-zero test on $CODE. A pass that
  // exited 0 produced its report and did its work; on 2026-09-20 the review
  // pass quoted LIMIT_LINE in that report, the regex matched its own sentence,
  // and the review lane slept half an hour for nothing.
  const gate = sh.lastIndexOf('[ "$CODE" -ne 0 ]', guardCall);
  assert.ok(gate > 0 && gate < guardCall,
    'the guard is only asked about a pass that exited non-zero — otherwise a pass WRITING about limits backs the lane off');
  assert.match(sh, /--exit "\$CODE"/,
    'and the exit code is handed forward as a fact rather than re-derived from the prose');
});

test('the lock records its pid and a stale lock is cleared, not obeyed forever', () => {
  const sh = shellWithoutComments(read('scripts/loop_runner.sh'));
  assert.match(sh, /echo "\$\$" > "\$LOCK\/pid"/, 'the lock names its holder');
  assert.match(sh, /kill -0 "\$OLD_PID"/, 'liveness of the holder is CHECKED, not assumed');
  assert.match(sh, /STALE lock/, 'and a dead holder is announced before the takeover');
  // Without this, a reboot leaves the lock of the life that died, RunAtLoad
  // finds it, and the loops never start again — silently.
});

test('the runner still refuses the honest case: a second LIVE runner', () => {
  const sh = shellWithoutComments(read('scripts/loop_runner.sh'));
  assert.match(sh, /Refusing to start a second/, 'the 2026-08-22 double-review incident stays closed');
});

test('the permission model is unchanged: allowedTools, never skip-permissions', () => {
  const sh = read('scripts/loop_runner.sh');
  assert.match(sh, /--allowedTools/);
  // shellWithoutComments, not the JS stripper: the flag's only appearance is
  // in a `#` comment explaining why it is NOT used — exactly the appearance
  // this assertion must ignore. (Found by this test failing on the unbroken
  // file: an assertion that cannot pass is as dead as one that cannot fail.)
  assert.doesNotMatch(shellWithoutComments(sh), /dangerously-skip-permissions/);
});

test('the END line no longer presents the exit code as a verdict', () => {
  const sh = shellWithoutComments(read('scripts/loop_runner.sh'));
  assert.match(sh, /END \/\$SKILL \(exit \$CODE — not a verdict/,
    'claude -p exits 0 whenever it produced output; the pass that abandoned 86bbjt1b4 exited 0');
});

test('neither the runner nor the installer will run from a worktree', () => {
  for (const f of ['scripts/loop_runner.sh', 'scripts/install_loop_runner.sh']) {
    assert.match(shellWithoutComments(read(f)), /gitdir:.*worktrees/,
      `${f} must refuse a folder that is deleted when its work ships`);
  }
});

test('the installer keeps the runner alive across death and reboot', () => {
  const sh = read('scripts/install_loop_runner.sh');
  assert.match(sh, /<key>KeepAlive<\/key>/);
  assert.match(sh, /<key>RunAtLoad<\/key>/);
  assert.match(sh, /<key>ThrottleInterval<\/key>/,
    'KeepAlive plus the lock means a refused start would relaunch hot without a throttle');
  for (const skill of ['loop-build', 'loop-review']) {
    assert.match(sh, new RegExp(skill), `both loops install: ${skill}`);
  }
});

test('the installer speaks bash 3.2 — the bash every Mac actually ships', () => {
  for (const f of ['scripts/install_loop_runner.sh', 'scripts/loop_runner.sh']) {
    assert.doesNotMatch(shellWithoutComments(read(f)), /declare -A/,
      `${f}: associative arrays do not exist in macOS bash, and the failure is a launch-time error on the machine that matters`);
  }
});

test('the delay CLI answers "<kind> <seconds>", scopes to the last pass, and never kills the runner', () => {
  const src = withoutComments(read('scripts/loop_runner_delay.mjs'));
  assert.match(src, /scopeToLastPass/, 'unscoped, a stale limit line backs off every healthy pass forever');
  assert.match(src, /`\$\{kind\} \$\{seconds\}`/,
    'kind and seconds first: the runner has to record WHAT the pass did, not only how long to sleep');
  // Every failure path answers, and answers `blocked 0` — the runner keeps its
  // normal pacing, and a pass this script could not read about is never
  // recorded as a healthy one.
  for (const m of src.match(/say\(guard\.PASS_\w+, \d+\)/g) || []) {
    assert.ok(/PASS_BLOCKED, 0/.test(m) || /PASS_RAN|PASS_STOOD_DOWN/.test(m), `unexpected answer shape: ${m}`);
  }
  assert.ok((src.match(/catch \(err\)[\s\S]*?PASS_BLOCKED/) || [])[0],
    'the catch-all answers blocked, not ran — an unreadable pass is not a healthy pass');
  assert.doesNotMatch(src, /process\.exit\((?!0)/, 'and never exits non-zero');
});

// ---------------------------------------------------------------------------
// ROUND 2 — the defect stated once: a pass's fate was decided by grepping its
// prose, and that failed in BOTH directions, live, within three days of each
// other. These tests use the REAL log shapes, copied from the Mini's own
// loop-build.log (recovered 2026-09-20 from the nightly node backup) and from
// the review lane's log on this machine — not paraphrases.
// ---------------------------------------------------------------------------

/** Verbatim from mac-mini:~/loop-logs/loop-build.log, 185 occurrences. */
const REAL_AUTH_FAILURE_PASS = [
  '',
  '===== 2026-09-20 01:08:57 START /loop-build =====',
  'Failed to authenticate: OAuth session expired and could not be refreshed',
  '===== 2026-09-20 01:08:58 END /loop-build (exit 1 — not a verdict; the pass\'s report above is) =====',
].join('\n');

/** The real weekly limit, as it read at 02:08 on 2026-09-18 before the login died. */
const REAL_LIMIT_PASS = [
  '',
  '===== 2026-09-18 02:08:11 START /loop-build =====',
  "You've hit your weekly limit · resets Sep 19 at 5pm (America/Denver)",
  '===== 2026-09-18 02:08:12 END /loop-build (exit 1 — not a verdict; the pass\'s report above is) =====',
].join('\n');

/**
 * A pass that WORKED and wrote about limits — the 2026-09-20 review pass, which
 * quoted the guard's own regex in its report. `node scripts/loop_runner_delay.mjs
 * ~/loop-logs/loop-review.log` answered 1800 and the lane slept for nothing.
 */
const REAL_PASS_DISCUSSING_LIMITS = [
  '',
  '===== 2026-09-20 14:24:00 START /loop-review =====',
  'REVIEW: sent back to Rework.',
  'the guard only recognises the words "hit your … limit", so an authentication failure falls through',
  'LIMIT_LINE = /hit your .{0,20}limit/i',
  '===== 2026-09-20 14:26:00 END /loop-review (exit 0 — not a verdict; the pass\'s report above is) =====',
].join('\n');

test('DIRECTION ONE: the real authentication failure is BLOCKED, never a run', () => {
  const scoped = guard.scopeToLastPass(REAL_AUTH_FAILURE_PASS);
  const out = guard.passOutcome({ text: scoped, exitCode: 1, nowMs: Date.parse('2026-09-20T07:09:00.000Z') });
  assert.equal(out.kind, guard.PASS_BLOCKED,
    'this exact line beat as a healthy working pass 278 times, and the pipeline read as fine for 90 hours');
  assert.equal(out.sleepSeconds, 0,
    'and it must NOT back off — a dead login does not clear with time, and 48 half-hour sleeps a day proved it');
  assert.match(out.why, /login/i, 'the beat carries a reason a reader can act on');
});

test('DIRECTION TWO: a pass that merely WRITES about limits does not back the lane off', () => {
  const scoped = guard.scopeToLastPass(REAL_PASS_DISCUSSING_LIMITS);
  // The old guard's answer, kept here as the proof the text really does match —
  // so this test cannot pass by accident on a fixture that never triggered it.
  assert.notEqual(guard.limitDelay({ text: scoped, nowMs: Date.now() }), null,
    'the fixture must still match LIMIT_LINE, or this test proves nothing');
  const out = guard.passOutcome({ text: scoped, exitCode: 0, nowMs: Date.now() });
  assert.equal(out.kind, guard.PASS_RAN, 'it exited 0 — it did its work');
  assert.equal(out.sleepSeconds, 0, 'the review lane slept 1800s for this on 2026-09-20');
  assert.match(out.reason, /WRITING about one/,
    'and it says so out loud, so a real limit that ever exits 0 shows up on its first occurrence');
});

test('a real usage limit still stands down and still sleeps to its stated reset', () => {
  const scoped = guard.scopeToLastPass(REAL_LIMIT_PASS);
  const out = guard.passOutcome({ text: scoped, exitCode: 1, nowMs: Date.parse('2026-09-18T08:08:12.000Z') });
  assert.equal(out.kind, guard.PASS_STOOD_DOWN, 'a limit clears itself, so it is not a block');
  assert.ok(out.sleepSeconds > 0, 'and it sleeps rather than retrying into the same closed window');
});

test('authentication OUTRANKS a limit when a pass names both — which is what 09-18 was', () => {
  // The real sequence: a weekly limit, then ten minutes later the login died
  // and never came back. A tail carrying both must answer with the one that
  // needs a human, or the lane sleeps its way through three days.
  const both = [
    '===== 2026-09-18 02:38:00 START /loop-build =====',
    "You've hit your weekly limit · resets Sep 19 at 5pm (America/Denver)",
    'Failed to authenticate: OAuth session expired and could not be refreshed',
    '===== 2026-09-18 02:38:01 END /loop-build (exit 1) =====',
  ].join('\n');
  const out = guard.passOutcome({ text: guard.scopeToLastPass(both), exitCode: 1, nowMs: Date.now() });
  assert.equal(out.kind, guard.PASS_BLOCKED);
  assert.equal(out.sleepSeconds, 0);
});

test('an exit code that cannot be established is BLOCKED — never rounded down to zero', () => {
  const out = guard.passOutcome({ text: 'anything at all', exitCode: null, nowMs: Date.now() });
  assert.equal(out.kind, guard.PASS_BLOCKED, 'a reading that could not be taken never renders as healthy');
  assert.equal(out.sleepSeconds, 0);
});

test('a non-zero pass naming no known cause is blocked, and paced normally', () => {
  const out = guard.passOutcome({
    text: 'Error: ENOSPC: no space left on device', exitCode: 2, nowMs: Date.now(),
  });
  assert.equal(out.kind, guard.PASS_BLOCKED, 'it did no work; calling that a run is the 90-hour defect');
  assert.equal(out.sleepSeconds, 0, 'but a one-off crash costs one interval, not a night');
});

test('the exit code is read back off the runner\'s own END banner when none is given', () => {
  assert.equal(guard.exitCodeFromLog(REAL_AUTH_FAILURE_PASS), 1);
  assert.equal(guard.exitCodeFromLog(REAL_PASS_DISCUSSING_LIMITS), 0);
  assert.equal(guard.exitCodeFromLog('a log with no banner in it'), null,
    'and "no banner" is its own answer, not a zero');
});

// ---------------------------------------------------------------------------
// Task 86bccr85e — a pass the TIME LIMIT stopped is not a locked door.
//
// On 2026-10-04 every build pass on the Mini was killed at two hours (exit
// 124) while re-running one failing render check. Exit 124 named neither a
// limit nor a login, so it fell through to `blocked`, and the heartbeat told
// Dane to go and sign in on a machine that was signed in and working.
// ---------------------------------------------------------------------------

/** The shape run_with_time_limit.sh leaves in the log when it stops a pass. */
const REAL_TIMED_OUT_PASS = [
  '',
  '===== 2026-10-04 10:00:01 START /loop-build =====',
  '[run_with_time_limit] 2026-10-04 12:00:01 stopped after 7200s — still running at the limit, which a working pass never reaches: claude -p /loop-build',
  '===== 2026-10-04 12:00:32 END /loop-build (exit 124 — not a verdict; the pass\'s report above is) =====',
].join('\n');

test('exit 124 is TIMED OUT — never blocked, and it does not back off', () => {
  const out = guard.passOutcome({ text: guard.scopeToLastPass(REAL_TIMED_OUT_PASS), exitCode: 124, nowMs: Date.now() });
  assert.equal(out.kind, guard.PASS_TIMED_OUT, 'blocked renders as an expired login — the false sentence this ticket is about');
  assert.equal(out.sleepSeconds, 0, 'the next pass is the retry; a timeout is not a limit window');
  assert.doesNotMatch(`${out.why} ${out.reason}`, /login|sign in/i);
});

test('the exit code is read back off the END banner too, so the by-hand reading agrees', () => {
  const scoped = guard.scopeToLastPass(REAL_TIMED_OUT_PASS);
  assert.equal(guard.exitCodeFromLog(scoped), guard.TIME_LIMIT_EXIT);
});

test('the other direction: an authentication failure is still BLOCKED, even on exit 124', () => {
  // A login that died mid-pass and left the session hanging must still send
  // somebody to sign in — the timeout branch may never swallow it.
  const both = `${REAL_TIMED_OUT_PASS}\nFailed to authenticate: OAuth session expired and could not be refreshed`;
  const out = guard.passOutcome({ text: both, exitCode: 124, nowMs: Date.now() });
  assert.equal(out.kind, guard.PASS_BLOCKED);
  assert.match(out.why, /login/i);
  // And a plain non-zero exit with no cause named is still blocked — only 124 moved.
  assert.equal(guard.passOutcome({ text: 'boom', exitCode: 1, nowMs: Date.now() }).kind, guard.PASS_BLOCKED);
});

test('a limit phrase in a timed-out pass is the pass writing about one — it does not stand down', () => {
  const text = `${REAL_TIMED_OUT_PASS}\nthe guard matches "hit your session limit" in prose`;
  assert.notEqual(guard.limitDelay({ text, nowMs: Date.now() }), null, 'the fixture must still match LIMIT_LINE');
  assert.equal(guard.passOutcome({ text, exitCode: 124, nowMs: Date.now() }).kind, guard.PASS_TIMED_OUT);
});

test('the timed-out sentence names the limit and the ticket, and says so when it cannot', () => {
  const named = guard.timedOutWhy({ limitSeconds: 7200, ticket: '86bccr85e' });
  assert.match(named, /full 2h time limit/);
  assert.match(named, /working on ticket 86bccr85e$/, 'the id alone: no one tracker\'s address (SP-396)');
  assert.doesNotMatch(named, /sign in|needs a human/i);
  const unnamed = guard.timedOutWhy({ limitSeconds: 5400, ticketWhy: 'it had not claimed one' });
  assert.match(unnamed, /full 90m time limit/);
  assert.match(unnamed, /could not be named \(it had not claimed one\)/);
});

test('the delay CLI answers "timed-out 0 <why>" for a stopped pass, on one line', () => {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-timeout-'));
  try {
    const log = path.join(dir, 'loop-build.log');
    fs.writeFileSync(log, REAL_TIMED_OUT_PASS);
    const run = spawnSync(process.execPath, [
      path.join(REPO, 'scripts', 'loop_runner_delay.mjs'), log, '--exit', '124', '--skill', 'loop-build', '--limit', '7200',
    ], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    const line = run.stdout.trim();
    assert.equal(line.split('\n').length, 1, 'the runner reads exactly one line');
    assert.match(line, /^timed-out 0 the pass ran the full 2h time limit without finishing/);
    // Whichever ticket the claim marker on this checkout names, the sentence
    // either names one or says why it could not — never neither.
    assert.match(line, /working on ticket \S+|could not be named \(/);
    // BREAK TEST: the same log with exit 1 is still blocked, with no third field.
    const blocked = spawnSync(process.execPath, [
      path.join(REPO, 'scripts', 'loop_runner_delay.mjs'), log, '--exit', '1',
    ], { encoding: 'utf8' });
    assert.equal(blocked.stdout.trim(), 'blocked 0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
