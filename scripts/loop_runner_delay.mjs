#!/usr/bin/env node
/**
 * The IO half of loopRunnerGuard: read the tail of a pass log, print ONE line —
 *
 *   <kind> <seconds>
 *
 * `kind` is `ran`, `stood-down` or `blocked`; `seconds` is how long the runner
 * should sleep because of a usage limit, or 0 for "pace normally". The reason
 * goes to stderr, which the runner appends to the same log, so neither the
 * sleep nor the kind is ever a mystery.
 *
 *   node scripts/loop_runner_delay.mjs <log-file> [--exit <code>] [--skill <name>] [--limit <seconds>]
 *
 * A TIMED-OUT PASS GETS A THIRD FIELD (task 86bccr85e): `timed-out 0 <why>`,
 * where <why> names the time limit and the ticket the pass was holding — read
 * off the claim marker that `clickup claim` writes and that only a FINISHED
 * pass clears. A timed-out pass printed nothing of its own (it was killed), so
 * the marker is the one record of what it was stuck on. The runner reads the
 * line with `read -r kind seconds why`, so the first two fields are unchanged.
 *
 * TWO FIELDS, NOT ONE, SINCE 2026-09-20 (task 86bc3t0n1, round 2). This used to
 * print only the seconds, so the runner had nothing to record about a pass
 * except "it came back" — and from 2026-09-18 both lanes came back 278 times
 * having failed to authenticate, beat as healthy every time, and the pipeline
 * read as fine for 90 hours. The kind is the half that was missing.
 *
 * `--exit` IS THE FACT AND IT COMES FIRST. A pass's exit code decides what it
 * was; the log text is consulted only afterwards, for which kind of failure and
 * when a limit resets. When `--exit` is not given — running this by hand
 * against a log, which is how the ticket's own test steps read — the code is
 * read back off the runner's own END banner in that log. No banner and no flag
 * means the code is UNKNOWN, which is a third answer and is never rounded down
 * to zero.
 *
 * NOTHING HERE MAY FAIL THE RUNNER. Every problem — missing file, unreadable
 * tail, a bug in this script — prints a line and exits 0. A guard that can kill
 * the loop it guards is the one outcome worse than the blind retries it was
 * written to stop (task 86bbtuje2). On an internal failure it answers
 * `blocked 0`: the runner keeps its normal pacing, and a pass this script could
 * not read about is not recorded as a healthy one.
 *
 * Only THIS pass's output is scanned (`scopeToLastPass`): the log tail still
 * carries the previous pass's lines, and a 2:38am "resets 2:50am" sitting
 * above a 3:00am pass that succeeded would otherwise read as a limit whose
 * reset is 23 hours away — a healthy pass answered with a needless backoff.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const guard = require('../lib/loopRunnerGuard.js');

// The checkout whose claim marker names the pass's ticket: the folder this is
// run in. Spirality's runner runs it in the project's checkout (where the
// project's door wrote the marker), never in Spirality's own folder, which is
// a different checkout for every project but Spirality (SP-396).
const CHECKOUT = process.cwd();

/** Only the end of the log matters, and logs run to megabytes. */
const TAIL_BYTES = 16 * 1024;

function tailOf(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * One pass over the arguments: the log file, and `--exit <code>` if given.
 *
 * `exitCode` is null when the flag is absent OR unparseable — a malformed flag
 * is a code we do not have, and the one thing it must never become is a zero.
 */
function parseArgs(argv) {
  let file = '';
  let exitCode = null;
  let skill = '';
  let limitSeconds = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--exit') {
      const raw = Number(argv[i + 1]);
      if (Number.isFinite(raw)) exitCode = raw;
      i += 1;
      continue;
    }
    if (argv[i] === '--skill') {
      skill = String(argv[i + 1] || '');
      i += 1;
      continue;
    }
    if (argv[i] === '--limit') {
      const raw = Number(argv[i + 1]);
      if (Number.isFinite(raw)) limitSeconds = raw;
      i += 1;
      continue;
    }
    if (!argv[i].startsWith('--') && !file) file = argv[i];
  }
  return { file, exitCode, skill, limitSeconds };
}

/**
 * Which ticket was the stopped pass holding? The claim marker names it until a
 * pass hands the ticket on, and a pass the time limit killed never got there.
 * A marker left by the OTHER lane is not this pass's ticket, so it is named as
 * unknown rather than borrowed. Never throws — the caller's line still goes out.
 */
function claimedTicket(skill) {
  try {
    // Loaded here, not at the top (SP-396): it brings the door's status and
    // config modules with it, and a fault in any of them must cost only the
    // ticket's name on a timed-out pass, never the usage-limit reading.
    const passClaim = require('../lib/passClaim.js');
    const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: CHECKOUT, encoding: 'utf8' });
    const common = r.status === 0 ? String(r.stdout || '').trim() : '';
    const file = passClaim.markerPath(common ? path.resolve(CHECKOUT, common) : path.join(CHECKOUT, '.git'));
    const m = passClaim.readMarker(file);
    if (!m.found) return { ticket: '', ticketWhy: 'it had not claimed one' };
    if (!m.record) return { ticket: '', ticketWhy: m.why };
    if (skill && m.record.skill && String(m.record.skill) !== skill) {
      return { ticket: '', ticketWhy: `the claim on record belongs to ${m.record.skill}, not ${skill}` };
    }
    return { ticket: String(m.record.task), ticketWhy: '' };
  } catch (err) {
    return { ticket: '', ticketWhy: `the claim marker could not be read (${err?.message || err})` };
  }
}

function say(kind, seconds, why = '') {
  // One line: kind, seconds, and — only when there is one — the sentence the
  // beat should carry. Newlines would split the runner's `read`, so none survive.
  const tail = String(why || '').replace(/\s+/g, ' ').trim();
  console.log(tail ? `${kind} ${seconds} ${tail}` : `${kind} ${seconds}`);
  process.exit(0);
}

try {
  const { file, exitCode: fromFlag, skill, limitSeconds } = parseArgs(process.argv.slice(2));
  if (!file) {
    console.error('[loop_runner_delay] no log file given — answering "blocked 0": no pass was read, so none can be called healthy');
    say(guard.PASS_BLOCKED, 0);
  }

  const scoped = guard.scopeToLastPass(tailOf(file));
  // The flag if the runner gave one; otherwise the END banner this same runner
  // wrote into the log. Both are the exit code — one passed forward, one read
  // back — and neither is a guess about the text.
  const exitCode = fromFlag === null ? guard.exitCodeFromLog(scoped) : fromFlag;
  if (fromFlag === null) {
    console.error(exitCode === null
      ? '[loop_runner_delay] no --exit given and no END banner in this pass — the exit code is unknown'
      : `[loop_runner_delay] no --exit given; read exit ${exitCode} back off this pass's own END banner`);
  }

  const outcome = guard.passOutcome({ text: scoped, exitCode, nowMs: Date.now() });
  if (outcome.reason) console.error(`[loop_runner_delay] ${outcome.reason}`);
  if (outcome.kind === guard.PASS_TIMED_OUT) {
    say(outcome.kind, outcome.sleepSeconds, guard.timedOutWhy({ limitSeconds, ...claimedTicket(skill) }));
  }
  say(outcome.kind, outcome.sleepSeconds);
} catch (err) {
  console.error(`[loop_runner_delay] could not read the log (${err?.message || err}) — answering "blocked 0" (normal pacing, and not recorded as a healthy pass)`);
  say(guard.PASS_BLOCKED, 0);
}
