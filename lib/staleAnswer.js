'use strict';

/**
 * staleAnswer — Dane replied, and NOTHING MOVED.
 *
 * WHY THIS EXISTS (2026-09-06, task 86bbvr4w3)
 *
 * He answered `C` on 86bbv8nvy at 09:40. The 09:46 relay pass delivered that
 * answer to the party line, ran out of ClickUp request budget before it could
 * return the ticket to `Queued`, said so correctly — and then posted that
 * report into a bus write the same rate limit skipped. The ticket sat in
 * `Needs your input` for three and a half hours until he found it himself.
 *
 * The retry that stops it being permanent lives in
 * `scripts/builder/busRelayPlan.js`. This is the other half: the alarm, for
 * every reason the hand-back might still not happen — a dead relay, an
 * exhausted budget three passes running, a bug nobody has found yet.
 *
 * WHY NONE OF THE FOUR EXISTING WATCHDOGS COULD SEE IT, which is the whole
 * argument for a fifth:
 *
 *   - the ROLL CALL reads a day-resolution row, and a perfectly healthy relay
 *     legitimately reads as ~21h stale between pushes. It cannot resolve hours,
 *     let alone minutes.
 *   - the STALE-CHECK measures the relay's own beats. The relay was healthy —
 *     it had beaten nine minutes earlier. The job was alive; one ticket fell
 *     out of it.
 *   - THROUGHPUT asks whether the queue is getting shorter, over days.
 *   - STALE-READY watches `Ready to launch`. This is `Needs your input`, the
 *     one stage where the thing being waited on is a MACHINE ACTION on words
 *     he has already written.
 *
 * WHOSE HANDS, AND THE ANSWER IS ALMOST ALWAYS "NOT YOURS". A ticket in this
 * stage carrying an answer newer than the question is by definition not
 * waiting on him — he has spoken. Saying otherwise is the failure
 * `docs/DOCTRINE.md` 2.5 was ratified against, and the same failure
 * `lib/staleReady.js` was written to stop the pulse committing.
 *
 * PURE, AND TESTED AS SUCH. No network, no clock, no filesystem — the IO lives
 * in `scripts/stale_answer.mjs`, the same split `lib/staleReady.js` uses.
 */

const busRelayPlan = require('../scripts/builder/busRelayPlan.js');

const { DEFAULT_OVERLAP_MS } = busRelayPlan;

const MS_PER_MINUTE = 60 * 1000;

/** The stage this watches. Lower-case, matched case-insensitively at the
 *  call site, exactly as `busRelayPlan`'s handback table keys it. */
const ANSWER_STAGE = 'needs your input';

/**
 * HOW LONG AN ANSWER MAY SIT BEFORE IT IS WORTH SAYING SOMETHING — and the
 * ticket asks for minutes, not a day, because the thing being waited on is a
 * single status write that should happen on the very next pass.
 *
 * DERIVED, NOT TYPED. `DEFAULT_OVERLAP_MS` is one relay interval — the number
 * `busRelayPlan` already calls "the gap between passes", and the one this
 * measurement is actually about. Three of them is the threshold: one pass to
 * do the work, and two more before a miss is real rather than a pass that was
 * simply mid-flight when the reading was taken. Retuning the relay's cadence
 * moves this with it instead of leaving a stale number behind, which is the
 * coupling `lib/staleReady.js` states for its own two clocks and
 * `lib/nodeRoles.js` for ownership: one owner per number.
 */
const PASSES_BEFORE_STALE = 3;
const STALE_AFTER_MINUTES = (DEFAULT_OVERLAP_MS / MS_PER_MINUTE) * PASSES_BEFORE_STALE;

/** The three answers, and CANNOT TELL is one of them — said out loud, never
 *  resolved to an actor by guessing (docs/DOCTRINE.md 3.11). */
const OPERATOR = 'operator';
const MACHINE = 'machine';
const CANNOT_TELL = 'cannot-tell';

/**
 * WHAT A REPLY THREAD SAYS, READ OFF THE ENVELOPE `scripts/lib/clickup.cjs`
 * ACTUALLY RETURNS.
 *
 * WHY THIS IS A FUNCTION AND NOT THREE LINES AT THE CALL SITE (2026-09-07,
 * round 1 review). It was three lines at the call site, and they tested
 * `out.res.ok` — which is `clickup_direct.mjs`'s envelope, a different door.
 * `call()` here returns `{ ok, status, json, text, resetSeconds }` and has no
 * `res` at all, so the check was `undefined` on every reading: `wasRelayed`
 * could only ever answer "could not tell", `delivered` could never be false,
 * and the `answer-undelivered` finding — the one that names the party line
 * rather than the hand-back — was unreachable in production. Every finding
 * printed "the answer was delivered ... the hand-back is failing", which is
 * the exact mis-diagnosis this module's own opening docstring says it exists
 * to prevent, on the one surface Dane reads. It also spent one ClickUp request
 * per stale ticket for a value that was always discarded.
 *
 * Pure, so a test can hand it the real envelope shape and watch the wrong one
 * come back null. `null` means the read FAILED — "I could not check" and "it
 * was not delivered" are different findings and only one of them blames the
 * party line.
 */
function markersFromReplyEnvelope(out) {
  if (!out || out.ok !== true) return null;
  const replies = (out.json && (out.json.comments || out.json.replies)) || [];
  return {
    delivered: busRelayPlan.repliesShowRelayed(replies),
    handbackDone: busRelayPlan.repliesShowHandbackDone(replies),
  };
}

/** The suppression key — the REASON, not the ticket, so a condition that
 *  clears and returns is announced again. Same rule, same shape and the same
 *  reasoning as `staleReady.postKey`. */
function postKey(finding) {
  return `${finding.taskId}:${finding.reasonKey}`;
}

/** The ticket a stamp key belongs to. Lives beside `postKey` so the format is
 *  written and taken apart in one place — a second definition would fail
 *  silently, clearing nothing and making the window permanent. */
function stampKeyTaskId(key) {
  return String(key || '').split(':')[0];
}

/**
 * WHICH SUPPRESSION STAMPS TO DELETE, given every stamp on disk and the
 * tickets that are stuck RIGHT NOW.
 *
 * A KEEP-LIST, AND THAT IS THE WHOLE POINT (2026-09-07, round 1 review). The
 * first cut answered the opposite question in the IO half — it was handed the
 * ids of tickets still in `Needs your input` and not stuck, so a ticket that
 * left the stage altogether, which is the NORMAL healthy ending, never had its
 * stamp cleared. Getting stuck, getting fixed, and sticking again for the same
 * reason inside six hours was then silently suppressed: the fire-once alarm
 * criterion 4 exists to prevent, living inside the code written to prevent it.
 *
 * Pure and here rather than three lines beside `fs.rmSync`, because that is
 * exactly where the first version could not be tested and so was not.
 *
 * @param stampKeys  every stamp key on disk (`<taskId>:<reasonKey>`)
 * @param stuckTaskIds the ticket ids that are findings on THIS pass
 * @returns the keys to remove
 */
function stampsToClear(stampKeys, stuckTaskIds) {
  const keep = new Set((stuckTaskIds || []).map(String));
  return (stampKeys || []).filter((key) => !keep.has(stampKeyTaskId(key)));
}

function minutesText(minutes) {
  const m = Number(minutes) || 0;
  if (m < 90) return `${Math.round(m)}m`;
  if (m < 48 * 60) return `${Math.round((m / 60) * 10) / 10}h`;
  return `${Math.round((m / 1440) * 10) / 10}d`;
}

function truncate(text, max) {
  const s = String(text || '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * One ticket in `Needs your input`, classified.
 *
 * @param record
 *   taskId, name, url        the ticket
 *   commentsReadable         false when the comment fetch itself failed
 *   state                    busRelayPlan.answerAwaitingHandback()'s verdict:
 *                            'answered' | 'handled' | 'hand-held' | 'none' | 'no-question'
 *   answerMinutes            minutes since his answer (state 'answered'), or
 *                            since his newest comment when the trail carries no
 *                            escalation card and he spoke last
 *   operatorSpokeLast        is his the newest comment on the ticket?
 *   delivered                was that answer relayed? null when unknown
 */
function classifyAnswer(record) {
  const taskId = String(record?.taskId || '');
  const name = truncate(record?.name, 60);
  const waited = minutesText(record?.answerMinutes);
  const say = (actor, reasonKey, message) => ({
    taskId,
    name: record?.name || '',
    url: record?.url || '',
    minutes: Number(record?.answerMinutes) || 0,
    actor,
    reasonKey,
    message,
  });

  // The ticket's own trail could not be read, so nothing below it is knowable
  // and nothing below it is claimed.
  if (record?.commentsReadable === false) {
    return say(CANNOT_TELL, 'comments-unreadable',
      `${taskId} "${name}" is parked in Needs your input and its comments could not be read — `
      + 'so whether you have already answered is unknown. Not resolved to anyone.');
  }

  // No escalation card anywhere on the trail. `ask` always writes one, so this
  // is a ticket parked by hand or one whose card has scrolled off the newest
  // page of comments. Either way an answer cannot be told apart from something
  // he said last week — and the relay, for exactly that reason, will not retry
  // a hand-back here. Reported rather than skipped: "I could not measure it"
  // and "it is fine" are different answers and only one is safe to render as
  // quiet.
  if (record?.state === 'no-question') {
    return say(CANNOT_TELL, 'no-escalation-card',
      `${taskId} "${name}" is parked in Needs your input with your own comment newest (${waited} ago), `
      + 'but the trail carries no escalation card — so which comment is the question cannot be told, and '
      + 'the relay will not hand it back on its own. Not resolved to anyone; it needs an agent session.');
  }

  // THE ONE THIS CHECK EXISTS FOR. He answered, the answer reached the party
  // line, and the status never followed.
  if (record?.delivered === false) {
    return say(MACHINE, 'answer-undelivered',
      `${taskId} "${name}" — NOT waiting on you. You answered ${waited} ago and the relay has still not `
      + 'managed to deliver that answer anywhere, so it is holding the ticket rather than moving it on '
      + 'something nobody received. The party line or the ClickUp budget is the problem, not your reply.');
  }

  return say(MACHINE, 'answer-unhandled',
    `${taskId} "${name}" — NOT waiting on you. You answered ${waited} ago, the answer was delivered, and `
    + 'the ticket never left Needs your input. The hand-back is failing; nothing is picking this work up.');
}

/**
 * Every ticket in the stage, split into findings and the ones still inside
 * their clock. The fresh ids come back too — the caller needs them to CLEAR
 * suppression stamps, and a stamp that is never cleared is an alarm that fires
 * once and then never again.
 */
function answerFindings(records, { staleAfterMinutes = STALE_AFTER_MINUTES } = {}) {
  const findings = [];
  const fresh = [];
  // There is no `unmeasured` bucket here, and there was one until 2026-09-07:
  // declared, documented as "the report says so", never populated and never
  // read. It cannot be populated — it was meant for a ticket inside the clock
  // whose comments would not read, and the very first branch below makes an
  // unreadable ticket a finding at ANY age. `lib/staleReady.js` has a real one
  // (a ticket with no approval to measure from); this module has no such
  // shape, so it now claims none. A bucket the report never mentions is a
  // silence dressed as coverage.
  for (const r of records || []) {
    if (r?.commentsReadable === false) {
      // An unreadable ticket has no measurable answer age, so it cannot be
      // ranked against the threshold at all. It is a finding regardless: this
      // stage is where his words go to be acted on, and "I could not look" is
      // the one verdict that must never read as clear.
      findings.push(classifyAnswer(r));
      continue;
    }
    // Nothing of his after the question: the ticket is genuinely still his.
    // That is the healthy state of this stage and gets no finding — chasing
    // him here is precisely the wrong-actor failure this module opens with.
    if (r?.state === 'none') { fresh.push(String(r?.taskId || '')); continue; }

    // His answer was acted on and the ticket is parked here AGAIN, which means
    // somebody put it back on purpose. Quiet, and it must be: the relay will
    // not move it either (`answerAwaitingHandback` reads the same marker), so
    // alarming here would fire every six hours for as long as he chose to
    // leave it — an alarm about a deliberate act, on the ticket he parked.
    if (r?.state === 'handled') { fresh.push(String(r?.taskId || '')); continue; }

    // Held by hand (task 86bccgp8q): he is driving this ticket from his own
    // session, so his comments are steps in that work and the relay withholds
    // the move ON PURPOSE. Quiet for the same reason as `handled` — an alarm
    // here would report a deliberate hold as a broken hand-back.
    if (r?.state === 'hand-held') { fresh.push(String(r?.taskId || '')); continue; }

    // No card AND he did not speak last: there is no answer in sight, so
    // there is nothing to be late. Decided BEFORE the timestamp check below,
    // because such a ticket has no answer age by construction — reading its
    // missing clock as "unknowable" would file a CANNOT TELL on every quietly
    // parked ticket in the stage and drown the one finding that matters.
    if (r?.state === 'no-question' && !r?.operatorSpokeLast) {
      fresh.push(String(r?.taskId || ''));
      continue;
    }

    const minutes = Number(r?.answerMinutes);
    if (!Number.isFinite(minutes)) {
      // ClickUp gave the comment no usable date, so how long it has sat is
      // unknowable. Said out loud, never folded into clean.
      findings.push({
        taskId: String(r?.taskId || ''),
        name: r?.name || '',
        url: r?.url || '',
        minutes: 0,
        actor: CANNOT_TELL,
        reasonKey: 'answer-age-unknown',
        message:
          `${r?.taskId} "${truncate(r?.name, 60)}" is in Needs your input and your answer carries no `
          + 'usable timestamp, so how long it has sat is unknowable. Not resolved to anyone.',
      });
      continue;
    }
    if (minutes <= staleAfterMinutes) { fresh.push(String(r?.taskId || '')); continue; }
    findings.push(classifyAnswer(r));
  }
  // Longest wait first — one clock here, so raw minutes ranks honestly.
  findings.sort((a, b) => (Number(b.minutes) || 0) - (Number(a.minutes) || 0));
  return { findings, fresh, staleAfterMinutes };
}

/** How many findings landed on each actor. */
function actorTally(findings) {
  const tally = { operator: 0, machine: 0, cannotTell: 0 };
  for (const f of findings || []) {
    if (f.actor === OPERATOR) tally.operator += 1;
    else if (f.actor === MACHINE) tally.machine += 1;
    else tally.cannotTell += 1;
  }
  return tally;
}

/** Which findings are due to be posted, given what this machine has already
 *  said. Pure, so the suppression rule is break-testable. */
function duePosts({ findings, stamps, now, everyMs }) {
  const seen = stamps instanceof Map ? stamps : new Map(Object.entries(stamps || {}));
  const due = [];
  const held = [];
  for (const f of findings || []) {
    const key = postKey(f);
    const lastAt = seen.get(key) || '';
    const then = Date.parse(lastAt);
    if (!lastAt || !Number.isFinite(then) || (now - then) >= everyMs) due.push(f);
    else held.push({ key, lastAt });
  }
  return { due, held };
}

/** The bus message. It leads with the fact that matters most to the reader at
 *  2am: he already did his part. */
function renderStalePost({ findings, node = '', staleAfterMinutes = STALE_AFTER_MINUTES }) {
  const list = findings || [];
  const tally = actorTally(list);
  const lines = [];
  lines.push(`NEEDS YOUR INPUT — ${list.length} ticket(s) where you have ALREADY answered and nothing `
    + `moved (threshold ${minutesText(staleAfterMinutes)})`);
  lines.push('');
  lines.push(`Whose hands: ${tally.machine} on the machine side, ${tally.cannotTell} that could not be `
    + `resolved to anyone, ${tally.operator || 'none'} waiting on you.`);
  lines.push('');
  for (const f of list) {
    lines.push(`• ${f.message}`);
    if (f.url) lines.push(`  ${f.url}`);
  }
  lines.push('');
  lines.push('Each of these is measured from your own comment, which nothing resets — not from ticket age.');
  lines.push(`Say more: \`npm run stale-answer\`${node ? `  (reported by ${node})` : ''}`);
  lines.push('[CC-starcaster]');
  return lines.join('\n');
}

/** The console report. Prints on every run, findings or not — an all-clear and
 *  a run that died halfway must not look the same. */
function renderReport({ findings, fresh, staleAfterMinutes = STALE_AFTER_MINUTES, stageCount }) {
  const list = findings || [];
  const tally = actorTally(list);
  const lines = [];
  lines.push(`NEEDS YOUR INPUT — ${stageCount} ticket(s) in the stage, ${list.length} where your answer `
    + 'has landed and nothing moved');
  lines.push(`Threshold: ${minutesText(staleAfterMinutes)} from your comment — three relay passes, so a `
    + 'pass caught mid-flight is not an alarm.');
  lines.push('='.repeat(72));
  lines.push('');
  if (!list.length) {
    lines.push(`Nothing is stuck. ${(fresh || []).length} ticket(s) are in the stage and none carries an `
      + 'answer of yours that has gone unacted on.');
    return lines.join('\n');
  }
  lines.push(`On you: ${tally.operator}   On the machine side: ${tally.machine}   `
    + `CANNOT TELL: ${tally.cannotTell}`);
  lines.push('');
  for (const f of list) {
    lines.push(`[${f.actor.toUpperCase()}] ${f.message}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * The exit code. Same ladder as `npm run throughput` and `npm run stale-ready`,
 * for the same reason: "could not tell" is never rendered as healthy.
 *   0  nothing stuck
 *   1  at least one answer of his has gone unacted on
 *   2  CANNOT TELL — a reading the verdict needed could not be taken
 */
function exitCodeFor(findings) {
  const list = findings || [];
  if (list.some((f) => f.actor === CANNOT_TELL)) return 2;
  return list.length ? 1 : 0;
}

module.exports = {
  MS_PER_MINUTE,
  ANSWER_STAGE,
  PASSES_BEFORE_STALE,
  STALE_AFTER_MINUTES,
  OPERATOR,
  MACHINE,
  CANNOT_TELL,
  actorTally,
  answerFindings,
  classifyAnswer,
  duePosts,
  exitCodeFor,
  markersFromReplyEnvelope,
  stampsToClear,
  minutesText,
  postKey,
  stampKeyTaskId,
  renderReport,
  renderStalePost,
};
