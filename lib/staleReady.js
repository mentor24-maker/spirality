'use strict';

/**
 * staleReady — whose hands does a stuck `Ready to launch` ticket actually need?
 *
 * WHY THIS EXISTS (2026-09-01, task 86bbqp68c)
 *
 * 86bbkw1mn sat in `Ready to launch` for six days with Dane's merge approval
 * already given. It was never waiting on him. The merge step read his "merge"
 * at 02:16 on 2026-08-31, correctly declined because CI was red, said so —
 * and then nothing ever looked again. The red check was one failing test out
 * of 1,846, from a clean-merge rule collision with `main`. PR #444 the day
 * before was the same shape. Twice in one week makes it the normal failure
 * mode of this stage, not bad luck.
 *
 * The structural hole is that `Ready to launch` has no owner watching its CI.
 * The loops never touch it on purpose (it is operator-held, and
 * `busRelayPlan.js` leaves it out of the handback table deliberately), so the
 * merge step re-declines forever without ever escalating, and from Dane's side
 * a standing approval looks handled.
 *
 * THE PART THAT MATTERS IS NOT THE ALARM, IT IS THE ACTOR.
 *
 * `scripts/builder/pulse.js` already had a 24-hour threshold for this stage
 * and a bottleneck line that fired on it. When it fired it said:
 *
 *     Bottleneck: OPERATOR — N of M approved tickets have waited past 24h
 *     for a merge. The machine side is keeping up.
 *
 * In this incident that sentence is false in BOTH halves. The machine side was
 * not keeping up — CI was red — and it would have told Dane he was the blocker
 * when he was not. That is exactly what `docs/DOCTRINE.md` §2.5 was ratified
 * against: *whose hands does this need, and are they mine?* Naming the wrong
 * actor cost four days on ticket 86bbmfc15. The pulse could not do better,
 * because it never read GitHub check state at all — it reasoned from ClickUp
 * status and `date_updated`, which structurally cannot separate "waiting on
 * Dane" from "waiting on a red build".
 *
 * So this module's job is NOT to chase Dane. It is to answer "whose hands does
 * this need" honestly, and the most valuable thing it can ever say is
 * *"not yours."*
 *
 * PURE, AND TESTED AS SUCH. No network, no clock, no filesystem. The IO —
 * ClickUp, `gh`, the suppression stamps and the bus post — lives in
 * `scripts/stale_ready.mjs`, exactly the split `lib/loopThroughput.js` uses.
 */

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * How long a ticket may sit in `Ready to launch` before it is worth saying
 * something. Read from the pulse's own table rather than typed again here: two
 * copies of a threshold are two thresholds, and they drift the first time
 * somebody tunes one (the same reasoning `lib/nodeRoles.js` gives for being
 * the only owner table).
 */
const { STAGE_THRESHOLDS } = require('../scripts/builder/pulse.js');
const { isMergeCommand, isReviewVerdict, commentDate } = require('../scripts/builder/mergeOnComment.js');
const READY_STAGE = 'ready to launch';
const STALE_AFTER_HOURS = STAGE_THRESHOLDS[READY_STAGE].hours;

/**
 * THE SECOND CLOCK (2026-09-02, task 86bbtqytq — Dane's ruling, verbatim:
 * *"Yes -> tickets carrying your merge comment get a short fuse (1-2h)"*).
 *
 * 86bbqw49y sat in `Ready to launch` for TWELVE hours with its PR already
 * merged and the work already live. This check was awake and pointed straight
 * at it, and reported "0 past 24h / Nothing is stuck" — honestly, because 12
 * is less than 24. Cadence was never the problem: the threshold was measuring
 * the wrong thing.
 *
 * An untouched ticket in this stage can reasonably have 24 hours. A ticket
 * carrying an explicit `merge` from Dane is a DIFFERENT OBJECT: he has stated
 * an expectation, and the clock has to start where he stated it.
 *
 * WHY TWO HOURS AND NOT A NEW NUMBER. It is read from the pulse's `building`
 * threshold rather than typed here, because his ruling asked for exactly that
 * — "no new constant enters the codebase without a sibling", so an
 * approved-but-unmerged ticket gets the same patience the system already
 * extends to a build in flight. The coupling is deliberate and it is checked:
 * `staleReady.test.js` pins BOTH the value and the sibling, so retuning the
 * build threshold fails a test with this comment attached rather than silently
 * moving a clock somebody is waiting on.
 */
const APPROVED_STALE_AFTER_HOURS = STAGE_THRESHOLDS.building.hours;

/**
 * WHEN DID HIS EXPECTATION START? — the timestamp the short fuse burns from.
 *
 * Not `date_updated`, which is what makes this worth its own function: any
 * edit resets that, and 86bbqw49y collected 25 automated refusal comments
 * while it sat stuck. A clock reading ticket age would have been reset by the
 * refusals it exists to catch (Dane's ruling names this as the break test).
 *
 * Two rules, both deliberate:
 *
 *  - **The OLDEST live merge comment, not the newest.** If he says "merge",
 *    is ignored, and says it again, the wait began the first time. Starting
 *    over each time he repeats himself would reward the failure by moving the
 *    alarm further away.
 *  - **Live means newer than the current review verdict.** A merge command
 *    that predates the newest verdict authorized an EARLIER round — the merge
 *    step refuses it for exactly that reason — so a ticket rebuilt after a
 *    send-back does not arrive back in this stage already on fire from an
 *    approval that no longer applies. Such a ticket genuinely is waiting on a
 *    new word from him, which is what the 24h clock and row 1 already say.
 *
 * @returns epoch ms, or 0 when there is no live approval
 */
function liveApprovalAt(comments, { operatorId } = {}) {
  const all = Array.isArray(comments) ? comments : [];
  const verdictAt = all
    .filter((c) => isReviewVerdict(c && c.comment_text))
    .reduce((newest, c) => Math.max(newest, commentDate(c)), 0);
  const approvals = all
    .filter((c) => Number(c && c.user && c.user.id) === Number(operatorId))
    .filter((c) => isMergeCommand(c && c.comment_text))
    .map((c) => commentDate(c))
    .filter((at) => at > 0 && at >= verdictAt);
  return approvals.length ? Math.min(...approvals) : 0;
}

/**
 * Which clock a ticket is on, and the threshold that clock is measured
 * against. Pure, and the whole two-clock rule lives here so nothing downstream
 * has to remember which question it is asking.
 *
 * `record.approvedHours` is the age of Dane's LIVE merge word — hours since
 * the comment itself, never since `date_updated`. That distinction is the
 * ruling's own break test and it is not a nicety: any edit resets
 * `date_updated`, and the stuck ticket took 25 automated refusal comments
 * while it sat there. A clock reading ticket age would have been reset by the
 * very refusals it exists to catch.
 *
 * null / absent means no live approval, and the ticket keeps the 24h stage
 * clock — he has stated no expectation on those, and shortening them would
 * manufacture the "all is well x365" noise every watchdog here is built
 * against.
 */
function stalenessClock(record, {
  staleAfterHours = STALE_AFTER_HOURS,
  approvedAfterHours = APPROVED_STALE_AFTER_HOURS,
} = {}) {
  const approved = Number(record?.approvedHours);
  if (Number.isFinite(approved) && approved >= 0) {
    return { basis: 'approval', hours: approved, thresholdHours: approvedAfterHours };
  }
  return { basis: 'stage', hours: Number(record?.hours), thresholdHours: staleAfterHours };
}

/**
 * The three answers, and CANNOT TELL is one of them — said out loud, never
 * resolved to an actor by guessing. A sweep that turns an unreadable PR into
 * "waiting on Dane" is the defect, not the fallback (docs/DOCTRINE.md §3.11).
 */
const OPERATOR = 'operator';
const MACHINE = 'machine';
const CANNOT_TELL = 'cannot-tell';

/**
 * The suppression key, and it is deliberately the REASON rather than the
 * ticket. One post per ticket per window would swallow a ticket that goes
 * red → green → red, and a fault that returns must be announced again — the
 * same rule `scripts/report_job_failure.mjs` gets by clearing its stamp on the
 * next success. Keying on the reason gets it for a condition that CHANGES
 * rather than clears: a different key is new information and posts at once.
 */
function postKey(finding) {
  return `${finding.taskId}:${finding.reasonKey}`;
}

/**
 * The ticket a stamp key belongs to. Lives beside `postKey` rather than being
 * re-split at the call site, because a key format written in one place and
 * taken apart in another is a format with two definitions — and the reader
 * would fail SILENTLY, clearing nothing and turning the suppression window
 * into a permanent one.
 */
function stampKeyTaskId(key) {
  return String(key || '').split(':')[0];
}

function hoursText(hours) {
  const h = Number(hours) || 0;
  if (h < 48) return `${Math.round(h * 10) / 10}h`;
  return `${Math.round((h / 24) * 10) / 10}d`;
}

function truncate(text, max) {
  const s = String(text || '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * One stuck ticket, classified. The four rows of the ticket's own table, plus
 * the two states GitHub can legitimately be in that the table did not name
 * (checks still running, and a PR that is no longer open).
 *
 * @param record
 *   taskId, name, url        the ticket
 *   hours                    how long it has been in this stage (a FLOOR — see
 *                            RESIDENCY_PROXY_NOTE; `date_updated` is a proxy)
 *   commentsReadable         false when the comment fetch itself failed
 *   pr                       { number, url } or null when no "PR opened:" line
 *   prReadable               false when `gh` would not answer about that PR
 *   prReadError              why, when it would not
 *   prState                  'OPEN' | 'MERGED' | 'CLOSED'
 *   checks                   mergeOnComment.checkState() output, or null
 *   mergeWordGiven           has the operator authorized this round?
 *   mergeWordReadable        false when that could not be decided (no
 *                            readable operator id), with mergeWordError
 */
function classifyReady(record, opts = {}) {
  const taskId = String(record?.taskId || '');
  const name = truncate(record?.name, 60);
  const clock = stalenessClock(record, opts);
  const hours = Number(clock.hours) || 0;
  // The duration NAMES ITS OWN CLOCK. A bare "3.1h" beside a 24h threshold
  // reads as a mistake; "3.1h since you said \"merge\"" is the finding.
  const waited = clock.basis === 'approval'
    ? `${hoursText(hours)} since you said "merge"`
    : hoursText(hours);
  const say = (actor, reasonKey, message) => ({
    taskId,
    name: record?.name || '',
    url: record?.url || '',
    hours,
    basis: clock.basis,
    thresholdHours: clock.thresholdHours,
    actor,
    reasonKey,
    pr: record?.pr ? Number(record.pr.number) : null,
    message,
  });

  // Row 4a — the ticket's own trail could not be read. Nothing downstream of
  // this is knowable, so nothing downstream of it is claimed.
  if (record?.commentsReadable === false) {
    return say(CANNOT_TELL, 'comments-unreadable',
      `${taskId} "${name}" has been in Ready to launch ${waited} and its comments could not be read — `
      + 'so neither which PR it is about nor whether you have already said "merge" is known. '
      + 'Not resolved to anyone.');
  }

  // Row 4b — no PR trail at all. `findPullRequest` refuses to guess and so
  // does this: a ticket in Ready to launch with no "PR opened:" line is the
  // shape loopTrail.js was written for, and the merge step will refuse it
  // forever without ever saying why anywhere Dane looks.
  if (!record?.pr) {
    return say(CANNOT_TELL, 'no-pr-trail',
      `${taskId} "${name}" has been in Ready to launch ${waited}, but carries no "PR opened:" line — `
      + 'the merge step cannot tell which PR it is about, so it will keep declining. '
      + 'Not waiting on Dane; the trail needs repairing.');
  }

  const pr = Number(record.pr.number);

  // Row 4c — GitHub would not answer. Same rule as `build-start`: a state that
  // could not be read is not a state.
  if (record?.prReadable === false || !record?.prState) {
    const why = String(record?.prReadError || 'no reason was reported').slice(0, 160);
    return say(CANNOT_TELL, 'pr-unreadable',
      `${taskId} "${name}" has been in Ready to launch ${waited}, and GitHub would not say what state `
      + `PR #${pr} is in (${why}). Not resolved to anyone.`);
  }

  const state = String(record.prState).toUpperCase();

  // Not a row of the table, but observed drift and unambiguous: the work is in
  // and the ticket did not follow, or the PR was abandoned. Either way the
  // hands are the machine's, and saying "waiting on your merge word" about a
  // PR that no longer exists would be the same lie in a new shape.
  if (state === 'MERGED') {
    return say(MACHINE, 'pr-merged',
      `${taskId} "${name}" is still in Ready to launch — ${waited} — but PR #${pr} is already MERGED — `
      + 'the work is live and the ticket did not follow. Not waiting on Dane; `npm run reconcile` repairs this.');
  }
  if (state !== 'OPEN') {
    return say(MACHINE, 'pr-not-open',
      `${taskId} "${name}" has been in Ready to launch ${waited}, but PR #${pr} is ${state}, not open — `
      + 'there is nothing left to merge. Not waiting on Dane.');
  }

  const checks = record?.checks || null;
  if (!checks || !Number.isFinite(Number(checks.total))) {
    return say(CANNOT_TELL, 'checks-unreadable',
      `${taskId} "${name}" has been in Ready to launch ${waited}, and PR #${pr}'s checks could not be `
      + 'read. Not resolved to anyone.');
  }

  // Row 3 — THE ONE THIS TICKET EXISTS FOR. Red checks are a machine problem,
  // the merge step will keep declining, and the failing check is NAMED so the
  // reader does not have to go and find it.
  if ((checks.failed || []).length) {
    return say(MACHINE, 'checks-red',
      `${taskId} "${name}" — NOT waiting on you. PR #${pr} has failing checks `
      + `(${checks.failed.join(', ')}), so the merge step will keep declining it. It has been `
      + `${waited}. Your approval stands; the build has to go green first.`);
  }

  // A total of zero is not green — it is a PR GitHub never ran anything on,
  // which is its own known failure (#387, #389: a push landing seconds after
  // `gh pr create` makes GitHub drop both runs and none ever arrives). Calling
  // that green would send Dane to merge something nothing has checked.
  if (!(checks.total > 0)) {
    return say(MACHINE, 'no-checks',
      `${taskId} "${name}" — NOT waiting on you. PR #${pr} has NO check runs at all after ${waited}, `
      + 'so nothing has verified it and the merge gate will refuse it. A new commit is what creates a run.');
  }

  if ((checks.pending || []).length) {
    return say(MACHINE, 'checks-pending',
      `${taskId} "${name}" — NOT waiting on you. PR #${pr} still has checks running after ${waited} `
      + `(${checks.pending.join(', ')}), which is far longer than a run takes.`);
  }

  // Row 4d — whose comment is the merge word could not be decided, because
  // the operator's tracker id was not readable (SC-793 review: a NaN id
  // silently matches nobody, so every green ticket read "IS yours" even after
  // Dane had said "merge"). Who it waits on is exactly what is unknown.
  if (record?.mergeWordReadable === false) {
    const why = String(record?.mergeWordError || 'no reason was reported').slice(0, 160);
    return say(CANNOT_TELL, 'merge-word-unknown',
      `${taskId} "${name}" — PR #${pr} is green and has waited ${waited}, but whether you have already `
      + `said "merge" could not be read (${why}). Not resolved to anyone.`);
  }

  // Row 2 — green, approved, and still sitting there. The merge step is not
  // running, or is refusing for a reason it never said out loud.
  if (record?.mergeWordGiven) {
    return say(MACHINE, 'green-and-approved',
      `${taskId} "${name}" — NOT waiting on you. PR #${pr} is green and you have already given the merge `
      + `word, and it has still not merged after ${waited}. The merge step is not running, or is refusing `
      + 'for a reason it has not recorded.');
  }

  // Row 1 — the only row where the original sentence was right.
  return say(OPERATOR, 'awaiting-merge-word',
    `${taskId} "${name}" — this one IS yours. PR #${pr} is green and reviewed and has waited ${waited} for `
    + 'your merge word. Reply "merge" on the ticket.');
}

/**
 * Every ticket in `Ready to launch`, split into the ones past the threshold
 * and the ones that are simply fresh. Records for tickets under the threshold
 * are returned too — the caller needs them to CLEAR suppression stamps, and a
 * stamp that is never cleared is an alarm that fires once and then never again.
 */
function readyFindings(records, {
  staleAfterHours = STALE_AFTER_HOURS,
  approvedAfterHours = APPROVED_STALE_AFTER_HOURS,
} = {}) {
  const opts = { staleAfterHours, approvedAfterHours };
  const findings = [];
  const fresh = [];
  // Tickets whose comment trail could not be read while they are still inside
  // their stage clock. Not findings — a transient read failure on a ticket
  // fifteen minutes old is not an alarm — but not silence either: for those
  // the short fuse could not be applied at all this pass, and the report says
  // so out loud rather than counting them as measured.
  const unmeasured = [];
  for (const r of records || []) {
    const clock = stalenessClock(r, opts);
    if (r?.commentsReadable === false && Number.isFinite(clock.hours) && clock.hours <= clock.thresholdHours) {
      unmeasured.push(String(r?.taskId || ''));
    }
    if (!Number.isFinite(clock.hours)) {
      // ClickUp gave no usable `date_updated`, so this ticket's age is not
      // knowable at all. It is a finding rather than a silent skip: "we could
      // not measure it" and "it is fine" are different answers, and only one
      // of them is safe to render as quiet.
      findings.push({
        taskId: String(r?.taskId || ''),
        name: r?.name || '',
        url: r?.url || '',
        hours: 0,
        basis: 'stage',
        thresholdHours: 0,
        actor: CANNOT_TELL,
        reasonKey: 'age-unknown',
        pr: null,
        message:
          `${r?.taskId} "${truncate(r?.name, 60)}" is in Ready to launch and ClickUp returned no usable `
          + 'date_updated, so how long it has been there is unknowable. Not resolved to anyone.',
      });
      continue;
    }
    // Each ticket against ITS OWN threshold — 2h once he has said "merge",
    // 24h otherwise. Comparing both to one number is the bug this ticket is.
    if (clock.hours <= clock.thresholdHours) { fresh.push(String(r.taskId)); continue; }
    findings.push(classifyReady(r, opts));
  }
  // Worst first, and "worst" can no longer be raw hours: a 3h ticket he
  // approved is 1.5x past its fuse while a 26h one is barely past its own.
  // Sorted by how far past its OWN threshold each is, so the two clocks can be
  // ranked against each other at all.
  findings.sort((a, b) => overdueRatio(b) - overdueRatio(a));
  return { findings, fresh, unmeasured, staleAfterHours, approvedAfterHours };
}

/** How far past its own threshold a finding is, as a multiple. A finding with
 *  no measurable clock (age-unknown) sorts to the top: "could not measure it"
 *  outranks every measured wait. */
function overdueRatio(finding) {
  const threshold = Number(finding?.thresholdHours);
  if (!Number.isFinite(threshold) || threshold <= 0) return Infinity;
  return Number(finding?.hours || 0) / threshold;
}

/** How many findings landed on each actor — what the pulse needs to stop
 *  naming the wrong one. */
function actorTally(findings) {
  const tally = { operator: 0, machine: 0, cannotTell: 0 };
  for (const f of findings || []) {
    if (f.actor === OPERATOR) tally.operator += 1;
    else if (f.actor === MACHINE) tally.machine += 1;
    else tally.cannotTell += 1;
  }
  return tally;
}

/**
 * Which findings are due to be posted, given what this machine has already
 * said. Pure, so the suppression rule itself is break-testable.
 *
 * @param stamps  postKey -> ISO time it was last posted
 * @returns { due, held } — `held` carries why, so a quiet pass can say so
 */
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

/** The bus message. Written for somebody who was not already suspicious: it
 *  leads with who it is on, because that is the whole point of the check. */
function renderStalePost({
  findings, node = '', staleAfterHours = STALE_AFTER_HOURS,
  approvedAfterHours = APPROVED_STALE_AFTER_HOURS,
}) {
  const list = findings || [];
  const tally = actorTally(list);
  const lines = [];
  lines.push(`READY TO LAUNCH — ${list.length} ticket(s) past their clock `
    + `(${approvedAfterHours}h once you have said "merge", ${staleAfterHours}h otherwise)`);
  lines.push('');
  if (tally.machine || tally.cannotTell) {
    const parts = [];
    if (tally.machine) parts.push(`${tally.machine} on the machine side`);
    if (tally.cannotTell) parts.push(`${tally.cannotTell} that could not be resolved to anyone`);
    const yours = tally.operator ? `${tally.operator} genuinely waiting on you` : 'none waiting on you';
    lines.push(`Whose hands: ${parts.join(', ')}, ${yours}.`);
  } else {
    lines.push(`Whose hands: all ${tally.operator} of these are waiting on your merge word.`);
  }
  lines.push('');
  for (const f of list) {
    lines.push(`• ${f.message}`);
    if (f.url) lines.push(`  ${f.url}`);
  }
  lines.push('');
  lines.push(`A ticket you have approved is measured from your "merge" comment itself, which nothing `
    + 'resets. Every other age comes from ClickUp\'s date_updated, which any edit resets — those are the '
    + 'FLOOR of the real wait, never the ceiling.');
  lines.push(`Say more: \`npm run stale-ready\`${node ? `  (reported by ${node})` : ''}`);
  lines.push('[CC-starcaster]');
  return lines.join('\n');
}

/** The console report. Prints on every run, findings or not — an all-clear and
 *  a run that died halfway must not look the same (pulse rule 1). */
function renderReport({
  findings, fresh, unmeasured, staleAfterHours = STALE_AFTER_HOURS,
  approvedAfterHours = APPROVED_STALE_AFTER_HOURS, readyCount,
}) {
  const list = findings || [];
  const tally = actorTally(list);
  const lines = [];
  lines.push(`READY TO LAUNCH — ${readyCount} ticket(s) in the stage, ${list.length} past their clock`);
  lines.push(`Two clocks: ${approvedAfterHours}h from your "merge" comment, ${staleAfterHours}h in the `
    + 'stage for a ticket you have not approved.');
  lines.push('='.repeat(72));
  lines.push('');
  const blind = (unmeasured || []).filter(Boolean);
  const blindLine = blind.length
    ? `${blind.length} ticket(s) could not have the short fuse applied at all — their comments would not `
      + `read, so whether you have said "merge" on them is unknown: ${blind.join(', ')}.`
    : '';
  if (!list.length) {
    lines.push(`Nothing is stuck. ${(fresh || []).length} ticket(s) are in the stage and none is past `
      + 'its own clock.');
    if (blindLine) { lines.push(''); lines.push(blindLine); }
    return lines.join('\n');
  }
  lines.push(`On you: ${tally.operator}   On the machine side: ${tally.machine}   `
    + `CANNOT TELL: ${tally.cannotTell}`);
  lines.push('');
  for (const f of list) {
    lines.push(`[${f.actor.toUpperCase()}] ${f.message}`);
    lines.push('');
  }
  if (blindLine) lines.push(blindLine);
  return lines.join('\n').trimEnd();
}

/**
 * The exit code. Same ladder as `npm run throughput`, for the same reason:
 * "could not tell" is never rendered as healthy.
 *   0  nothing stuck
 *   1  at least one ticket is stuck (a finding, whoever it is on)
 *   2  something needed for the verdict could not be read
 */
function exitCodeFor(findings) {
  const list = findings || [];
  if (list.some((f) => f.actor === CANNOT_TELL)) return 2;
  return list.length ? 1 : 0;
}

module.exports = {
  MS_PER_HOUR,
  READY_STAGE,
  STALE_AFTER_HOURS,
  APPROVED_STALE_AFTER_HOURS,
  stalenessClock,
  liveApprovalAt,
  overdueRatio,
  OPERATOR,
  MACHINE,
  CANNOT_TELL,
  actorTally,
  classifyReady,
  duePosts,
  exitCodeFor,
  hoursText,
  postKey,
  stampKeyTaskId,
  readyFindings,
  renderReport,
  renderStalePost,
};
