'use strict';

/**
 * `npm run repair` — the one repair entry point, and the answer to the
 * question the ticket called load-bearing (2026-09-02, task 86bbtnk3k —
 * audit Phase 4).
 *
 * THE PROBLEM. Four repair tools existed and an operator could not know which
 * to run: `pipeline sweep` (stranded tickets — reachable since this morning,
 * called by nothing), `pass-reconcile` (the loop's own dropped-claim marker),
 * `npm run reconcile` (ClickUp/GitHub drift — "meant to run on a schedule"
 * since 2026-08-18, hand-run ever since), and `resume`'s sweep. A repair
 * nobody runs is the defect that opened the 2026-09-02 stall report, in a
 * new coat.
 *
 * THE SHAPE. Three steps, each CALLED through its own npm script — never
 * re-implemented, exactly the preflight's doctrine — in an order where every
 * automatic write is evidence-based and everything else is a loud report:
 *
 *   marker    `clickup -- pass-reconcile`. The loop's dropped-claim backstop.
 *             Normally the next pass runs this itself; the scheduled repair
 *             exists for the case where there IS no next pass — the runner
 *             dead, the Mini rebooted — and the relay's idle wake is the one
 *             vantage that survives that (the watchdog doctrine). On a
 *             machine with no marker it answers "no claim" and writes
 *             nothing. It is called with `--scheduled`, which is not a
 *             formality — see the step below.
 *   drift     `reconcile -- --check`. Its writes are already automation-safe
 *             by design: it moves a ticket only on hard evidence (its PR
 *             MERGED, ticket in a machine status → Live), FLAGS operator
 *             statuses rather than ever moving them, and reports could-not-
 *             check apart from clean (DOCTRINE 3.11).
 *   stranded  `pipeline -- sweep` — DRY, ALWAYS, in every mode this module
 *             will compose. See below; this is the safety answer.
 *
 * WHY THE SCHEDULED SWEEP NEVER PASSES --apply. A stranded ticket is one
 * sitting in a machine status, untouched past the threshold, with no pass on
 * it. Two kinds of actor produce that state and only one may be repaired
 * unattended:
 *
 *   - a LOOP pass that died. Its claim wrote the pass marker, so the marker
 *     step above already repairs it — within one loop interval by the next
 *     pass, or by this schedule when the runner itself is dead.
 *   - a HAND session (the fast-track lane). It holds a ticket in `Building`
 *     for hours, legitimately, with no marker — five did on 2026-09-02
 *     alone. The marker is the ONLY machine-readable difference between
 *     those two, and no timing threshold can tell them apart: an automatic
 *     `--apply` here would eventually yank a ticket out from under Dane's
 *     own session, which is the one way this feature could do harm.
 *
 *   So unmarked strandings are REPORTED — to the bus, naming the tickets and
 *   the exact command (`npm run pipeline -- sweep --apply`) — and never
 *   moved. The dry run is the finding; a person or an agent session decides.
 *
 * Pure module: step table, dialect readings, post policy, composed outcome.
 * scripts/repair.mjs is the IO.
 */

/** The steps, in order. A test reads this table; the runner executes it. */
const STEPS = Object.freeze([
  Object.freeze({
    id: 'marker',
    // `--scheduled` IS LOAD-BEARING (2026-09-04, task 86bbu60ax). Without it,
    // pass-reconcile assumes its original seat — the first thing a new
    // loop-build pass runs, where a new pass starting proves the previous one
    // ended. A timer proves no such thing, so this call was revoking LIVE
    // build claims every half hour: twice in one morning on 86bbqb0ac, while
    // the pass was still building, putting the ticket back in the claim line
    // for a second builder to take. The flag makes it judge on the claim's age
    // instead. passClaim.js carries the argument.
    npmArgs: Object.freeze(['clickup', '--', 'pass-reconcile', '--scheduled']),
    // pass-reconcile dialect: 0 nothing (including a live claim deliberately
    // left alone) / 3 handed back (news!) / 2 could not tell / 1 a hand-back
    // failed. Nothing here aborts the run; 3 is a repair to report, 2 and 1
    // are degradations to report.
    reading: Object.freeze({ 0: 'clean', 3: 'repaired', 2: 'cannot-tell', 1: 'failed' }),
  }),
  Object.freeze({
    id: 'drift',
    // --check, not --live: same writes, plus the two disciplines a SCHEDULED
    // pass owes (task 86bbtqytq). It asks the pipeline switch before it reads
    // anything, and its flags carry a 6h window that clears when the
    // contradiction resolves. `--live` remains the by-hand shape.
    npmArgs: Object.freeze(['reconcile', '--', '--check']),
    // reconcile dialect: 0 ran and changed nothing, 3 declined because Dane
    // has the deck, 4 ran and WROTE, 2 could not ASK the switch, 1 could not
    // read the queue at all — nothing was checked.
    //
    // WHY 4 AND NOT 3 FOR "WROTE" (merged 2026-09-04). Two branches gave
    // reconcile's exit 3 a meaning on the same day and the meanings were
    // different: this one made it "Dane has the deck", #593 made it "this pass
    // moved a ticket". Both were right about their own half and shipping both
    // would have left one number meaning two things — a scheduled pass that
    // closed a ticket would have been read as a pass that declined to run, and
    // the REPAIRED it exists to announce would have printed PAUSED. That is
    // the "keep both sides" resolution DOCTRINE 6.7 is about, and it does not
    // announce itself: every gate stays green through it.
    //
    // 3 keeps the decline, because that is the repo-wide dialect every other
    // actor already speaks — `node:owns`, `pipeline -- check`, `clickup claim`,
    // the loop preflight — and reconcile's own stand-down cites it by name. The
    // write gets 4, a number no reader of this file had a prior meaning for.
    //
    // 2 is the lane review round 1 found missing (2026-09-03). Reconcile used
    // to grade an unreadable switch as a pause, so a throttled or unauthorised
    // ClickUp read composed to exit 0 / PAUSED: the drift watchdog off the
    // air, on a green board, with nothing raising a hand. `composeOutcome`
    // already had a cannot-tell lane and it was simply not reachable from
    // here.
    //
    // The 4 is not decoration either (2026-09-04, ticket 86bbuv66c). This step
    // used to have a two-value dialect, and reconcile exited 0 whether it had
    // moved a ticket or not — so the pass that wrongly closed a live urgent
    // ticket printed "REPAIR: CLEAN". A watchdog that cannot report its own
    // writes is narrating, not watching. `composeOutcome` maps 'repaired' to
    // exit 0 with the word REPAIRED, so a pass that repaired still does not
    // page — it is a change to report, not a failure. Found by session
    // starcaster-3e.
    reading: Object.freeze({ 0: 'clean', 3: 'paused', 4: 'repaired', 2: 'cannot-tell', 1: 'cannot-tell' }),
  }),
  Object.freeze({
    id: 'stranded',
    // DRY. ALWAYS. The refusal to append --apply is the safety property;
    // repair.test.js fails if this array ever grows one.
    npmArgs: Object.freeze(['pipeline', '--', 'sweep']),
    // sweep dialect: 0 clean / 3 a dry run FOUND stranded work (the finding
    // this schedule exists to surface) / 2 queue unreadable / 1 failed.
    reading: Object.freeze({ 0: 'clean', 3: 'findings', 2: 'cannot-tell', 1: 'failed' }),
  }),
]);

/** How often the scheduled mode may take a fresh reading at all. The relay
 *  wakes every 10 minutes on both machines; a full repair reads ClickUp and
 *  GitHub, and a 10-minute cadence would spend the request budget answering a
 *  question whose state changes far slower. Same pattern as throughput's
 *  hourly read stamp. */
const READ_EVERY_MS = 30 * 60 * 1000;

/** One bus post per finding-state per 6 hours, cleared by the next clean run —
 *  the discipline every sentinel here follows. The suppression stamp is
 *  per-machine, so the same finding can post twice (once per machine); that is
 *  the KNOWN RESIDUAL stale-ready states in its own header, shared rather
 *  than re-litigated. */
const POST_EVERY_MS = 6 * 60 * 60 * 1000;

/** What one step's exit means. An exit its dialect does not define is a
 *  failure, never guessed around — the tool changed its contract. */
function readStep(step, rawCode) {
  const meaning = step.reading[Number(rawCode)];
  return meaning || 'failed';
}

/**
 * The composed outcome of a run, by severity, never averaged:
 *
 *   1 failed        any step FAILED (or spoke an undefined code)
 *   2 cannot-tell   nothing failed, but a reading could not be taken —
 *                   never rendered as clean (DOCTRINE 3.11)
 *   3 findings      the dry sweep FOUND stranded work awaiting a decision
 *   0 clean         everything ran; repairs (if any) succeeded
 */
function composeOutcome(meanings) {
  if (meanings.includes('failed')) return { code: 1, word: 'FAILED' };
  if (meanings.includes('cannot-tell')) return { code: 2, word: 'CANNOT TELL' };
  if (meanings.includes('findings')) return { code: 3, word: 'FINDINGS' };
  // A step that DECLINED because Dane has the deck ran no check, so the pass
  // is not clean — it is quiet on purpose, which is a different word. Exit 0,
  // because a deliberate operator state is not an alarm: the same call the
  // preflight makes when the switch turns it away.
  if (meanings.includes('paused')) return { code: 0, word: 'PAUSED' };
  return { code: 0, word: meanings.includes('repaired') ? 'REPAIRED' : 'CLEAN' };
}

/**
 * Should this scheduled run post its findings to the bus?
 * Post only on findings/cannot-tell/failed, at most once per POST_EVERY_MS;
 * a clean run clears the stamp so the NEXT finding posts immediately.
 */
function postDecision({ outcomeCode, lastPostedAtMs, nowMs, everyMs = POST_EVERY_MS } = {}) {
  if (outcomeCode === 0) return { post: false, clear: true, why: 'clean — nothing to say, stamp cleared' };
  const last = Number(lastPostedAtMs);
  if (Number.isFinite(last) && nowMs - last < everyMs) {
    return { post: false, clear: false, why: `already said within ${Math.round(everyMs / 3600000)}h` };
  }
  return { post: true, clear: false, why: 'a finding, not yet said this window' };
}

/** Is a fresh scheduled reading due at all? */
function readDue({ lastReadAtMs, nowMs, everyMs = READ_EVERY_MS } = {}) {
  const last = Number(lastReadAtMs);
  return !Number.isFinite(last) || nowMs - last >= everyMs;
}

/** One line per step for the log: meaning first, so a column scans. */
/**
 * The sweep's preamble — the lines it prints BEFORE it has said anything about
 * a ticket. Named exactly, because `findingLine` picks the first line that is
 * not one of these.
 */
const SWEEP_PREAMBLE = Object.freeze([/^The pipeline is /, /^\(counting a ticket stranded /]);

/**
 * WHICH LINE OF A STEP'S OUTPUT GOES ON THE REPORT.
 *
 * For the stranded sweep this is not `all[0]`: the sweep opens with the
 * pipeline status banner, so the first line of a run that found something is
 * "The pipeline is RUNNING…", which reads as a clean report.
 *
 * It used to be picked by grepping for the phrase "stranded ticket", which the
 * sweep's summary carries on only SOME of its branches (found in the round-1
 * review of task 86bbur9tk, 2026-09-05). A run whose whole finding was
 * "1 ticket was left in Building because a half-finished build for it is still
 * on a machine" matched nothing, fell back to the banner, and the finding
 * never reached the report or the bus — an alarm silenced by the wording of
 * the thing it was alarming about.
 *
 * Matching by what a line is NOT is exact where a keyword was a guess: the
 * preamble is a closed set this repo controls, the findings are open prose.
 */
function findingLine(lines, stepId) {
  const rows = (Array.isArray(lines) ? lines : []).filter(Boolean);
  if (stepId === 'stranded') {
    const found = rows.find((l) => !SWEEP_PREAMBLE.some((re) => re.test(l)));
    if (found) return found;
  }
  return rows[0] || '(the step printed nothing)';
}

function renderStepLine(step, meaning, firstLine) {
  const word = {
    clean: 'ok  ', repaired: 'FIX ', findings: 'HELD', paused: 'SKIP',
    'cannot-tell': '????', failed: 'FAIL',
  }[meaning] || 'FAIL';
  return `${word}  ${step.id.padEnd(9)} ${String(firstLine || '').trim()}`.trimEnd();
}

module.exports = {
  SWEEP_PREAMBLE,
  findingLine,
  STEPS,
  READ_EVERY_MS,
  POST_EVERY_MS,
  readStep,
  composeOutcome,
  postDecision,
  readDue,
  renderStepLine,
};
