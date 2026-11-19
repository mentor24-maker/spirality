'use strict';

/**
 * What should the loop runner do about a pass that died on a usage limit?
 *
 * WHY THIS EXISTS (2026-09-02, task 86bbtuje2 — audit Phase 1). Between 2:05
 * and 2:50am the build loop fired three passes. Each died in seconds on
 *
 *   You've hit your session limit · resets 2:50am (America/Denver)
 *
 * and each time the runner slept its fixed 900s and retried into the same
 * closed window, blind. The message NAMES the reset time; nothing read it.
 *
 * This module is the reading. It is pure — text and a clock in, a decision
 * out — so every branch is testable without a runner, a log file or a real
 * limit. The bash side calls it through scripts/loop_runner_delay.mjs and
 * treats any failure as "use the normal interval", because a guard that can
 * kill the runner is worse than no guard.
 *
 * THREE ANSWERS, NEVER TWO (the house rule):
 *
 *   null                     no limit message in the text. Normal pacing.
 *   { seconds, reason }      a limit with a readable reset: sleep until then.
 *   { seconds: DEFAULT_BACKOFF_SECONDS, reason }
 *                            a limit whose time could not be read. Backing off
 *                            a fixed half hour is honest — "we know we are
 *                            limited, we do not know until when" — where
 *                            pretending no limit exists would burn the next
 *                            three passes discovering it again.
 *
 * SINCE 2026-09-20 (task 86bc3t0n1, round 2) `limitDelay` IS NO LONGER THE
 * RUNNER'S QUESTION. It answers "does this text name a usage limit, and when
 * does it reset" — a text question, and the only one text can honestly answer.
 * The runner asks `passOutcome` instead, which decides from the pass's EXIT
 * CODE first and consults this function only afterwards. See its header for
 * the two live failures that forced the split.
 */

/** Sleep this long on a limit whose reset time cannot be parsed. */
const DEFAULT_BACKOFF_SECONDS = 1800;

/**
 * Added past the stated reset. The message says "resets 2:50am"; waking at
 * 2:50:00 by the runner's clock races the limiter's clock and loses often
 * enough to waste a whole pass. Two minutes is noise against any real window.
 */
const MARGIN_SECONDS = 120;

/**
 * A computed sleep longer than this means the arithmetic went wrong somewhere
 * (a mis-read time, a timezone surprise), and obeying it would silence a loop
 * for most of a day on a guess. Fall back to the default backoff instead —
 * the next pass re-reads the situation half an hour from now.
 */
const CAP_SECONDS = 8 * 60 * 60;

/** The line, as observed live. Historical variants (all seen in real logs):
 *  "resets 10:50am", "resets 10pm", "resets 12am" — always with a zone in
 *  parentheses so far, but the zone is treated as optional and defaulted,
 *  because a wording change must degrade to the backoff, never to a crash. */
const LIMIT_LINE = /hit your .{0,20}limit/i;
const RESET_TIME = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/i;

/**
 * THE OTHER WAY A PASS DIES, AND IT NEVER CLEARS ITSELF (task 86bc3t0n1,
 * round 2). On 2026-09-18 at 02:08 MDT the Mini hit a real weekly limit. Ten
 * minutes later the message changed to
 *
 *   Failed to authenticate: OAuth session expired and could not be refreshed
 *
 * and never changed back — 185 times in loop-build.log, 93 in loop-review.log.
 * The quota reset on schedule the next evening and nothing improved, because by
 * then the login was gone. 90 hours, 20 tickets open, found because Dane asked.
 *
 * A usage limit is a clock running down. A dead login is a door that is locked
 * until a human unlocks it, and sleeping half an hour in front of it is the
 * wrong answer 48 times a day. So it gets its OWN answer — no backoff, and a
 * beat that alarms at once rather than waiting out a window.
 */
const AUTH_FAILURE_LINE = /(failed to authenticate|oauth session (?:has )?expired|session expired and could not be refreshed|please run .{0,12}login|invalid api key|authentication_error)/i;

/**
 * The END banner this runner writes for every pass:
 *
 *   ===== 2026-09-20 01:08:58 END /loop-build (exit 1 — not a verdict; ...) =====
 *
 * This is NOT prose-grepping in the sense this ticket is about. The runner
 * wrote this line itself, in a fixed shape, recording a number the kernel gave
 * it — it is the exit code, written down. Reading it back is what lets the
 * by-hand test in the ticket ("feed it the real log") answer the same way the
 * runner does, without the caller having to know the code already.
 */
const END_BANNER_EXIT = /\bEND \/\S+ \(exit (\d+)/;

/** What a pass turned out to be. Four, never two — and never a boolean. */
const PASS_RAN = 'ran';
const PASS_STOOD_DOWN = 'stood-down';
const PASS_BLOCKED = 'blocked';
const PASS_TIMED_OUT = 'timed-out';

/**
 * THE EXIT CODE scripts/run_with_time_limit.sh RETURNS WHEN IT STOPPED A PASS
 * (the GNU `timeout` convention). It is a fact the runner's own wrapper wrote,
 * not something the pass said, and it means one thing: the pass was alive and
 * working when the limit arrived, and did not finish.
 *
 * WHY IT IS ITS OWN ANSWER (task 86bccr85e, 2026-10-04). It used to fall
 * through to `blocked`, and `blocked` renders as "an expired login … somebody
 * has to sign in on that machine". That day the Mini was signed in and
 * working; every build pass was stopped at the two-hour limit while re-running
 * one failing render check. The heartbeat told Dane he was the blocker when
 * nothing needed his hands, and pointed the diagnosis at the wrong cause.
 */
const TIME_LIMIT_EXIT = 124;

const DEFAULT_ZONE = 'America/Denver';

/** The wall-clock hour and minute of `nowMs` in `zone`, or null if the zone
 *  name is one Intl refuses — treated as unreadable, never as UTC. */
function wallClock(nowMs, zone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }).formatToParts(new Date(nowMs));
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    const h = get('hour');
    const m = get('minute');
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return { h, m };
  } catch {
    return null;
  }
}

/**
 * Cut a log tail down to the LAST pass's output.
 *
 * The runner appends forever, so the tail handed to `limitDelay` still holds
 * the previous pass's lines — and a 2:38am "resets 2:50am" sitting above a
 * 3:00am pass that succeeded would read as a limit whose reset is now almost
 * a day away. Scoping at the last START marker means a limit line can only
 * ever belong to the pass that just ran.
 *
 * No marker at all returns the text unchanged: better to over-read a fresh
 * log than to silently scan nothing.
 */
const PASS_START_MARKER = ' START /';

function scopeToLastPass(text) {
  const body = String(text || '');
  const at = body.lastIndexOf(PASS_START_MARKER);
  return at === -1 ? body : body.slice(at);
}

/**
 * The sentence a timed-out beat carries: how long the limit was and which
 * ticket the pass was holding, so the reader goes to the ticket rather than to
 * the machine. Pure — the caller reads the claim marker and hands over what it
 * found.
 *
 * @param {object} opts
 * @param {number} [opts.limitSeconds]  the time limit the pass ran into
 * @param {string} [opts.ticket]        the ticket id the pass had claimed, if any
 * @param {string} [opts.ticketWhy]     why the ticket could not be named, when it could not
 */
function timedOutWhy({ limitSeconds, ticket = '', ticketWhy = '' } = {}) {
  const secs = Number(limitSeconds);
  const limitText = Number.isFinite(secs) && secs > 0
    ? (secs % 3600 === 0 ? `${secs / 3600}h` : `${Math.round(secs / 60)}m`)
    : 'its';
  const head = `the pass ran the full ${limitText} time limit without finishing — usually a gate or test it `
    + 'cannot get past, not a login';
  const id = String(ticket || '').trim();
  // StarCaster's copy linked the ticket on ClickUp here. Spirality's lanes
  // work against whichever tracker the project names, so the id alone is
  // given, never one tracker's address (SP-396, CLAUDE.md rule 2).
  if (id) return `${head}; it was working on ticket ${id}`;
  return `${head}; which ticket it was working on could not be named (${ticketWhy || 'no claim was recorded'})`;
}

/**
 * Decide, from the tail of a pass's output.
 *
 * @param {object} opts
 * @param {string} opts.text   the pass output (or its tail)
 * @param {number} opts.nowMs  the clock, injected so tests own it
 */
function limitDelay({ text, nowMs } = {}) {
  const body = String(text || '');
  if (!LIMIT_LINE.test(body)) return null;

  const m = RESET_TIME.exec(body);
  if (!m) {
    return {
      seconds: DEFAULT_BACKOFF_SECONDS,
      reason: 'a usage limit was hit but its reset time could not be read — backing off '
        + `${DEFAULT_BACKOFF_SECONDS}s instead of retrying into a closed window`,
    };
  }

  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  const half = m[3].toLowerCase();
  const zone = (m[4] || DEFAULT_ZONE).trim();

  // 12am is midnight, 12pm is noon; every other hour is offset by half.
  if (hour === 12) hour = half === 'am' ? 0 : 12;
  else if (half === 'pm') hour += 12;

  if (!Number.isFinite(hour) || hour > 23 || !Number.isFinite(minute) || minute > 59) {
    return {
      seconds: DEFAULT_BACKOFF_SECONDS,
      reason: `a usage limit named a time that does not parse ("${m[0]}") — backing off ${DEFAULT_BACKOFF_SECONDS}s`,
    };
  }

  const now = wallClock(Number(nowMs), zone) || wallClock(Number(nowMs), DEFAULT_ZONE);
  if (!now) {
    return {
      seconds: DEFAULT_BACKOFF_SECONDS,
      reason: `a usage limit named a zone this machine cannot resolve ("${zone}") — backing off ${DEFAULT_BACKOFF_SECONDS}s`,
    };
  }

  // Minutes-of-day arithmetic in the message's own zone: a reset "earlier"
  // than now means tomorrow. The 2:05am incident is the <= case — a pass that
  // dies AT the reset minute must wait for the margin, not zero.
  let delta = (hour * 60 + minute) - (now.h * 60 + now.m);
  if (delta <= 0) delta += 24 * 60;
  const seconds = delta * 60 + MARGIN_SECONDS;

  if (seconds > CAP_SECONDS) {
    return {
      seconds: DEFAULT_BACKOFF_SECONDS,
      reason: `the reset time reads as ${Math.round(seconds / 3600)}h away, which is past the ${Math.round(CAP_SECONDS / 3600)}h `
        + `sanity cap — backing off ${DEFAULT_BACKOFF_SECONDS}s and letting the next pass re-read it`,
    };
  }

  return {
    seconds,
    reason: `session limit — sleeping ${seconds}s until the stated reset (${m[1]}${m[2] ? `:${m[2]}` : ''}${half} ${zone}) plus a ${MARGIN_SECONDS}s margin`,
  };
}

/**
 * The exit code this pass reported, read back off the runner's own END banner.
 *
 * Returns a number, or null when there is no banner to read — which is a
 * DIFFERENT answer from zero and is never rounded down to one. A pass whose
 * exit code cannot be established has produced no evidence that it did any
 * work, and `passOutcome` treats it accordingly.
 */
function exitCodeFromLog(text) {
  const m = END_BANNER_EXIT.exec(String(text || ''));
  if (!m) return null;
  const code = Number(m[1]);
  return Number.isFinite(code) ? code : null;
}

/**
 * WHAT DID THIS PASS ACTUALLY DO? (task 86bc3t0n1, round 2.)
 *
 * THE DEFECT, STATED ONCE: a pass's fate used to be decided by grepping its
 * prose, and that cuts both ways. Both have now been observed live.
 *
 *   - An authentication failure contains none of the expected words, so it fell
 *     through to the ordinary path and beat as a healthy working pass. 278
 *     consecutive failures wrote 278 healthy marks; the pipeline was dead for 90
 *     hours and every status screen said it was fine.
 *   - A pass that merely wrote ABOUT limits matched the pattern. On 2026-09-20
 *     the review pass quoted `LIMIT_LINE` in its own report, the regex matched
 *     that sentence in the log, and the review lane slept half an hour for
 *     nothing.
 *
 * AN EXIT CODE IS A FACT. LOG TEXT IS A GUESS ABOUT A FACT. So the exit code
 * decides first and the text is only ever consulted afterwards, for the one
 * thing it genuinely knows — WHICH kind of failure this was, and when a limit
 * says it resets. A pass that exited 0 produced its report and did its work; no
 * sentence inside that report can make it a stand-down.
 *
 * THREE ANSWERS, NEVER TWO, and they are not interchangeable:
 *
 *   ran         the pass worked (or honestly found nothing to do). Pace normally.
 *   stood-down  it could not work, and the thing stopping it clears ITSELF —
 *               a usage limit runs down. Sleep until it does.
 *   blocked     it could not work, and nothing will change that without a human
 *               at a keyboard — an expired login, or a failure naming no cause
 *               that clears itself. Do NOT sleep on it: sleeping half an hour in
 *               front of a locked door 48 times a day is what the 90 hours were.
 *   timed-out   it WAS working, and the two-hour limit stopped it before it
 *               finished (exit 124). Not a login, not a limit — usually a gate
 *               or test the pass cannot get past (task 86bccr85e).
 *
 * @param {object} opts
 * @param {string} opts.text      this pass's output (already scoped to the pass)
 * @param {number|null} opts.exitCode  what the pass exited with; null = unknown
 * @param {number} opts.nowMs     the clock, injected so tests own it
 */
function passOutcome({ text, exitCode, nowMs } = {}) {
  const body = String(text || '');
  const raw = exitCode === null || exitCode === undefined || exitCode === '' ? null : Number(exitCode);
  const code = Number.isFinite(raw) ? raw : null;

  if (code === 0) {
    // A limit or authentication phrase in the output of a pass that EXITED 0 is
    // the pass writing about one — which is exactly what a pass working on this
    // ticket does. Named in the reason rather than swallowed, so that if a real
    // limit ever does exit 0 the log says so on the very first occurrence
    // instead of the backoff quietly never firing again.
    const mentioned = LIMIT_LINE.test(body) || AUTH_FAILURE_LINE.test(body);
    return {
      kind: PASS_RAN,
      sleepSeconds: 0,
      why: '',
      reason: mentioned
        ? 'this pass exited 0, so it did its work. A limit or authentication phrase appears in its own '
          + 'output — that is a pass WRITING about one, not a pass stopped by one — so it is not backing off.'
        : '',
    };
  }

  if (code === null) {
    return {
      kind: PASS_BLOCKED,
      sleepSeconds: 0,
      why: "this pass's exit code could not be established, so there is no evidence it did any work",
      reason: 'no exit code could be read for this pass. A reading that could not be taken is never '
        + 'rendered as a healthy pass — recording it as blocked, and not backing off.',
    };
  }

  // Non-zero from here down. AUTHENTICATION OUTRANKS A LIMIT, and the order
  // matters because the real outage was both: a genuine weekly limit at 02:08
  // followed ten minutes later by an expired login that never cleared. A log
  // tail carrying both lines must answer with the one that needs a human.
  if (AUTH_FAILURE_LINE.test(body)) {
    return {
      kind: PASS_BLOCKED,
      sleepSeconds: 0,
      why: `the pass exited ${code} without authenticating — a login has expired, and that never clears `
        + 'on its own; it needs a human at a keyboard on the machine that runs this lane',
      reason: 'this pass could not authenticate. That is not a usage limit and waiting will not fix it — '
        + 'not backing off, and recording it as blocked so the roll call alarms now rather than after a window.',
    };
  }

  // THE TIME LIMIT OUTRANKS A LIMIT LINE, and only the authentication check
  // above outranks it. Exit 124 is the wrapper saying it stopped a pass that
  // was still running two hours in — a pass a usage limit had closed would
  // have exited in seconds, so a limit phrase in a timed-out pass's output is
  // the pass writing about one. Pace normally: the next pass is the retry.
  if (code === TIME_LIMIT_EXIT) {
    return {
      kind: PASS_TIMED_OUT,
      sleepSeconds: 0,
      why: 'the pass ran the full time limit without finishing and was stopped',
      reason: `this pass exited ${TIME_LIMIT_EXIT}: the time limit stopped it while it was still running. `
        + 'It was working, not locked out — recording it as timed out, not as blocked, and pacing normally.',
    };
  }

  const limit = limitDelay({ text: body, nowMs });
  if (limit) {
    return {
      kind: PASS_STOOD_DOWN,
      sleepSeconds: limit.seconds,
      why: `a usage limit closed this pass; the runner is sleeping ${limit.seconds}s until it resets`,
      reason: limit.reason,
    };
  }

  return {
    kind: PASS_BLOCKED,
    sleepSeconds: 0,
    why: `the pass exited ${code} having done no work, and its output names no cause that clears itself`,
    reason: `this pass exited ${code} and named neither a usage limit nor an authentication failure. `
      + 'It did not work, and nothing here says it will next hour — recording it as blocked rather than '
      + 'as a run, and pacing normally so a one-off crash costs one interval and not a night.',
  };
}

module.exports = {
  PASS_START_MARKER,
  scopeToLastPass,
  DEFAULT_BACKOFF_SECONDS,
  MARGIN_SECONDS,
  CAP_SECONDS,
  AUTH_FAILURE_LINE,
  END_BANNER_EXIT,
  PASS_RAN,
  PASS_STOOD_DOWN,
  PASS_BLOCKED,
  PASS_TIMED_OUT,
  TIME_LIMIT_EXIT,
  timedOutWhy,
  exitCodeFromLog,
  passOutcome,
  limitDelay,
};
