import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LANES, parseStatus, readPasses, standsDownOnItsLane, judgeFirstPass, rerunSince, ticketsNamed, waitMinutesFrom, setupTicketBody, withLine } from './onboardLanes.mjs';

// Normie's review lane, 11/4 9:39 AM, as its log has it (the hold-up 14 pass).
const NORMIE_STAND_DOWN = `I stopped before reviewing anything, for two reasons:

1. **There's nothing to review.** The "In review" queue on the tracker has 0 tickets.
2. **The automatic reviewer is already running.** The review lane on the Mini (\`com.normie.loop-review\`) is loaded, and a pass started at 9:39 AM Mountain and is still going. The skill says not to start a hand-run review while that lane is loaded, because two reviewers on the same ticket overwrite each other's verdict.

You don't need to do anything. The lane checks the queue every 30 minutes, so it will pick up the next ticket that reaches "In review" by itself.`;

const REVIEW_LOG = `
[loop-runner] 09:39:18 main checkout is not on a clean main — not pulling.

===== 2026-11-04 09:39:20 START /loop-review =====
LANE STOOD DOWN: the review lane is loaded and this pass was started by hand
${NORMIE_STAND_DOWN}
===== 2026-11-04 09:39:35 END /loop-review (exit 0 — not a verdict; the pass's report above is) =====
[loop-runner] 09:39:35 sleeping 1800s before the next /loop-review

===== 2026-11-04 10:09:40 START /loop-review =====
Queue empty: no ticket is In review. Nothing to do this pass.
===== 2026-11-04 10:09:52 END /loop-review (exit 0 — not a verdict; the pass's report above is) =====
`;

const at = (s) => { const [d, t] = s.split(' '); const [y, m, dd] = d.split('-'); const [h, mi, se] = t.split(':'); return new Date(+y, m - 1, +dd, +h, +mi, +se); };

test('the lanes are the four the installer makes for every project', () => {
  const installer = readFileSync(new URL('../scripts/install_loop_runner.sh', import.meta.url), 'utf8');
  assert.match(installer, /^SKILLS=\(loop-build loop-review loop-intake\)$/m);
  assert.match(installer, /^RELAY=relay$/m);
  assert.deepEqual([...LANES].sort(), ['loop-build', 'loop-intake', 'loop-review', 'relay']);
});

test('--status is read job by job: installed and loaded', () => {
  const jobs = parseStatus([
    'checkout: /x on branch \'setup\'',
    '── loop-build',
    'schedule: INSTALLED at /Users/x/Library/LaunchAgents/com.p.loop-build.plist',
    'loaded:   yes — 123\t0\tcom.p.loop-build',
    '── loop-review',
    'schedule: INSTALLED at /p.plist',
    'loaded:   no',
    '── relay',
    'schedule: not installed on this machine',
    'loaded:   no',
  ].join('\n'));
  assert.deepEqual(jobs, {
    'loop-build': { installed: true, loaded: true },
    'loop-review': { installed: true, loaded: false },
    relay: { installed: false, loaded: false },
  });
});

test('a lane\'s log is read pass by pass, with its report and what came after', () => {
  const passes = readPasses(REVIEW_LOG, 'loop-review');
  assert.equal(passes.length, 2);
  assert.deepEqual(passes[0].start, at('2026-11-04 09:39:20'));
  assert.deepEqual(passes[0].end, at('2026-11-04 09:39:35'));
  assert.match(passes[0].report, /^LANE STOOD DOWN: the review lane is loaded[^\n]*\nI stopped before reviewing anything/);
  assert.match(passes[0].after, /sleeping 1800s/);
  assert.equal(passes[1].report, 'Queue empty: no ticket is In review. Nothing to do this pass.');
});

test('another lane\'s lines in the same log are not read as this lane\'s', () => {
  assert.equal(readPasses(REVIEW_LOG, 'loop-build').length, 0);
  assert.equal(readPasses('===== 2026-11-04 09:39:20 START /loop-review-extra =====\n', 'loop-review').length, 0);
});

test('the relay\'s START and END lines are read too', () => {
  const log = `
===== 2026-11-04 09:39:10 START relay — /Users/x/WebApps/p =====
NO-6  Ready to launch  no merge phrase yet
===== 2026-11-04 09:39:14 END relay — pass complete (exit 0) =====`;
  const [p] = readPasses(log, 'relay');
  assert.deepEqual(p.end, at('2026-11-04 09:39:14'));
  assert.equal(p.report, 'NO-6  Ready to launch  no merge phrase yet');
});

test('a stand-down is the fixed LANE STOOD DOWN line, never the wording', () => {
  assert.equal(standsDownOnItsLane(`LANE STOOD DOWN: the review lane is loaded\n${NORMIE_STAND_DOWN}`), true);
  assert.equal(standsDownOnItsLane('Ignoring 1 permissions.allow entry\nLANE STOOD DOWN: the build lane is loaded'), true, 'a warning line before it is fine');
  // Normie's 11/4 words came from a skill that had no fixed line: never guessed at.
  assert.equal(standsDownOnItsLane(NORMIE_STAND_DOWN), false);
  // The four healthy passes the wording check flagged in Normie's real logs (SP-111 review, comment 1193).
  for (const healthy of [
    'This is the review lane\'s own scheduled pass, not a second reviewer started by hand. Reviewed NO-7: PASSED.',
    'I am the review lane\'s own scheduled pass, so no second reviewer is running alongside it. Queue empty.',
    'This session is the build lane\'s own scheduled pass (LOOP_RUNNER_PID is set), not a second copy started by hand. Built NO-8.',
    'Built NO-7. The old skill printed "The automatic reviewer is already running" and told a hand-run review to stop; that is fixed.',
  ]) assert.equal(standsDownOnItsLane(healthy), false, healthy);
  assert.equal(standsDownOnItsLane('The words LANE STOOD DOWN: inside a sentence do not count'), false);
  assert.equal(standsDownOnItsLane('Queue empty: no ticket is In review. Nothing to do this pass.'), false);
  assert.equal(standsDownOnItsLane('Reviewed NO-7, PR #67: PASSED. The review lane will take the next one.'), false);
  // Mentioning the runner is not standing down on it.
  assert.equal(standsDownOnItsLane('This pass runs under the build runner (LOOP_RUNNER_PID set), so it is the lane. Built NO-8 into PR #68.'), false);
});

test('a first pass that stood down is a FAILED lane, naming hold-up 14', () => {
  const r = judgeFirstPass(readPasses(REVIEW_LOG, 'loop-review'), 'loop-review', { since: at('2026-11-04 09:39:00') });
  assert.equal(r.verdict, 'failed');
  assert.match(r.why, /stood down.*hold-up 14/);
});

test('only passes after the install count: an older stand-down is history', () => {
  const r = judgeFirstPass(readPasses(REVIEW_LOG, 'loop-review'), 'loop-review', { since: at('2026-11-04 10:00:00') });
  assert.equal(r.verdict, 'ok');
});

test('no pass yet, or a pass too young to judge, is waiting; one working for minutes is ok', () => {
  const since = at('2026-11-04 12:00:00');
  assert.equal(judgeFirstPass([], 'loop-build', { since }).verdict, 'waiting');
  const running = readPasses('===== 2026-11-04 12:00:05 START /loop-build =====\nclaiming NO-9\n', 'loop-build');
  assert.equal(judgeFirstPass(running, 'loop-build', { since, now: at('2026-11-04 12:01:00') }).verdict, 'waiting');
  const r = judgeFirstPass(running, 'loop-build', { since, now: at('2026-11-04 12:10:05') });
  assert.equal(r.verdict, 'ok');
  assert.match(r.why, /working for 10 minutes/);
});

test('a runner pass that could not sign in, hit the time limit or said nothing is FAILED', () => {
  const since = at('2026-11-04 12:00:00');
  const signIn = readPasses(`===== 2026-11-04 12:00:05 START /loop-intake =====
Please run /login
===== 2026-11-04 12:00:06 END /loop-intake (exit 1 — not a verdict; the pass's report above is) =====
[loop-runner] 12:00:06 THIS PASS COULD NOT SIGN IN TO CLAUDE. Nothing will change until a person signs in`, 'loop-intake');
  assert.match(judgeFirstPass(signIn, 'loop-intake', { since }).why, /could not sign in/);
  const limit = readPasses(`===== 2026-11-04 12:00:05 START /loop-build =====
working
===== 2026-11-04 14:00:05 END /loop-build (exit 124 — not a verdict; the pass's report above is) =====`, 'loop-build');
  assert.match(judgeFirstPass(limit, 'loop-build', { since }).why, /time limit/);
  const silent = readPasses(`===== 2026-11-04 12:00:05 START /loop-build =====
===== 2026-11-04 12:00:09 END /loop-build (exit 0 — not a verdict; the pass's report above is) =====`, 'loop-build');
  assert.equal(judgeFirstPass(silent, 'loop-build', { since }).verdict, 'failed');
});

test('a relay pass is ok only on "pass complete (exit 0)"', () => {
  const since = at('2026-11-04 12:00:00');
  const good = readPasses(`===== 2026-11-04 12:00:05 START relay — /p =====
===== 2026-11-04 12:00:08 END relay — pass complete (exit 0) =====`, 'relay');
  assert.equal(judgeFirstPass(good, 'relay', { since }).verdict, 'ok');
  const bad = readPasses(`===== 2026-11-04 12:00:05 START relay — /p =====
UNCHECKED: NO-6 merge failed
===== 2026-11-04 12:00:08 END relay — A STEP FAILED AND SAID SO ABOVE (exit 1) =====`, 'relay');
  const r = judgeFirstPass(bad, 'relay', { since });
  assert.equal(r.verdict, 'failed');
  assert.match(r.why, /A STEP FAILED/);
});

test('the setup ticket keeps Dane\'s words verbatim, or says they were not given', () => {
  const base = { productSlug: 'pressplay', githubRepo: 'o/pressplay', prUrl: 'https://github.com/o/pressplay/pull/3', branch: 'spirality-setup' };
  const withWords = setupTicketBody({ ...base, asked: 'set up PressPlay\n' });
  assert.match(withWords, /## Asked\n~~~\nset up PressPlay\n~~~/);
  assert.match(withWords, /https:\/\/github\.com\/o\/pressplay\/pull\/3/);
  assert.match(withWords, /`spirality-setup` in `o\/pressplay`/);
  assert.match(setupTicketBody(base), /not recorded/);
  // The door refuses "> " blockquote lines.
  assert.doesNotMatch(withWords, /^> /m);
});

test('the Ticket: line is added once, on a line of its own', () => {
  const line = 'Ticket: http://t.example/t/PP-1';
  const once = withLine('Summary.\n\nHow to test: ...\n', line);
  assert.equal(once, `Summary.\n\nHow to test: ...\n\n${line}\n`);
  assert.equal(withLine(once, line), once);
  assert.equal(withLine('', line), `\n\n${line}\n`);
});

test('"already running" about something other than the lane is not a stand-down', () => {
  assert.equal(standsDownOnItsLane('The tracker server is already running; test it by hand at http://localhost:4180.'), false);
});

test('a rerun with every lane loaded judges each lane\'s newest pass, not none', () => {
  const passes = readPasses(REVIEW_LOG, 'loop-review');
  assert.deepEqual(rerunSince(passes), at('2026-11-04 10:09:40'));
  assert.equal(judgeFirstPass(passes, 'loop-review', { since: rerunSince(passes) }).verdict, 'ok');
  // A lane whose newest pass stood down still fails on the rerun.
  const stoodDown = readPasses(REVIEW_LOG.split('\n[loop-runner] 09:39:35')[0], 'loop-review');
  assert.equal(judgeFirstPass(stoodDown, 'loop-review', { since: rerunSince(stoodDown) }).verdict, 'failed');
  // No pass in the log yet: wait for the next one.
  const now = at('2026-11-04 12:00:00');
  assert.deepEqual(rerunSince([], now), now);
  assert.equal(judgeFirstPass([], 'loop-build', { since: rerunSince([], now) }).verdict, 'waiting');
});

test('a relay START with no END is waiting for seconds, then FAILED, never ok', () => {
  const since = at('2026-11-04 12:00:00');
  const orphan = readPasses(`===== 2026-11-04 12:00:05 START relay — /p =====
relay: 1 "Ready to launch" in list 0`, 'relay');
  assert.equal(judgeFirstPass(orphan, 'relay', { since, now: at('2026-11-04 12:00:30') }).verdict, 'waiting');
  const r = judgeFirstPass(orphan, 'relay', { since, now: at('2026-11-04 12:04:05') });
  assert.equal(r.verdict, 'failed');
  assert.match(r.why, /no END.*Ready to launch/);
});

test('a pass with no END followed by another START stopped early: FAILED, any lane', () => {
  const since = at('2026-11-04 12:00:00');
  const relay = readPasses(`===== 2026-11-04 12:00:05 START relay — /p =====
[relay] the lock could not be retaken. Stopping.
===== 2026-11-04 12:10:05 START relay — /p =====`, 'relay');
  assert.match(judgeFirstPass(relay, 'relay', { since, now: at('2026-11-04 12:10:10') }).why, /without an END line: \[relay\] the lock/);
  const build = readPasses(`===== 2026-11-04 12:00:05 START /loop-build =====
claiming NO-9
===== 2026-11-04 12:30:05 START /loop-build =====`, 'loop-build');
  assert.equal(judgeFirstPass(build, 'loop-build', { since, now: at('2026-11-04 12:30:10') }).verdict, 'failed');
});

test('a ticket already filed under the PR\'s exact name is found, by exact name only', () => {
  const queue = [
    'NO-12\tin review\thigh\t2026-11-04\tSet up Normie\'s loop',
    'NO-13\tqueued\tnormal\t2026-11-04\tSet up Normie\'s loop, again',
  ].join('\n');
  assert.deepEqual(ticketsNamed(queue, "Set up Normie's loop"), ['NO-12']);
  assert.deepEqual(ticketsNamed(queue, 'Set up'), []);
  assert.deepEqual(ticketsNamed('', 'x'), []);
});

test('--wait-minutes must be a number of minutes greater than 0', () => {
  assert.equal(waitMinutesFrom(undefined), 10);
  assert.equal(waitMinutesFrom('5'), 5);
  assert.equal(waitMinutesFrom('2.5'), 2.5);
  for (const bad of ['', 'ten', '0', '-3', 'NaN', 'Infinity', '5m']) assert.equal(waitMinutesFrom(bad), null, bad);
});

test('a runner pass that exited non-zero never did its lane\'s work: FAILED, with the code and its last line', () => {
  const since = at('2026-11-04 12:00:00');
  const missing = readPasses(`===== 2026-11-04 12:00:05 START /loop-build =====
/Users/x/WebApps/p/scripts/loop_runner.sh: line 120: claude: No such file or directory
===== 2026-11-04 12:00:05 END /loop-build (exit 127 — not a verdict; the pass's report above is) =====`, 'loop-build');
  const r = judgeFirstPass(missing, 'loop-build', { since });
  assert.equal(r.verdict, 'failed');
  assert.match(r.why, /exited 127: .*claude: No such file or directory/);
  const crashed = readPasses(`===== 2026-11-04 12:00:05 START /loop-review =====
Reviewed nothing; something went wrong
===== 2026-11-04 12:00:09 END /loop-review (exit 1 — not a verdict; the pass's report above is) =====`, 'loop-review');
  assert.match(judgeFirstPass(crashed, 'loop-review', { since }).why, /exited 1: Reviewed nothing/);
  const noCode = readPasses(`===== 2026-11-04 12:00:05 START /loop-review =====
x
===== 2026-11-04 12:00:09 END /loop-review =====`, 'loop-review');
  assert.match(judgeFirstPass(noCode, 'loop-review', { since }).why, /without an exit code/);
});

test('a relay START that found another relay pass running is skipped, not judged', () => {
  const since = at('2026-11-04 12:00:00');
  const passes = readPasses(`===== 2026-11-04 12:00:05 START relay — /p =====
[relay] a relay pass is already running (pid 4242, lock: /x/p-relay.lock). Not starting a second.
===== 2026-11-04 12:00:40 START relay — /p =====
relay done: 0 ticket(s) looked at.
===== 2026-11-04 12:00:44 END relay — pass complete (exit 0) =====`, 'relay');
  const r = judgeFirstPass(passes, 'relay', { since });
  assert.equal(r.verdict, 'ok', r.why);
  const onlyLocked = readPasses(`===== 2026-11-04 12:00:05 START relay — /p =====
[relay] a relay pass is already running (pid 4242, lock: /x/p-relay.lock). Not starting a second.`, 'relay');
  assert.equal(judgeFirstPass(onlyLocked, 'relay', { since }).verdict, 'waiting');
});
