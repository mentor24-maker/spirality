'use strict';

/**
 * The preflight: every gate a loop pass must clear, in one place, in order.
 *
 * WHY THIS EXISTS (2026-09-02, task 86bbtujen — audit Phase 3). The gate
 * sequence — machine ownership, hand back what the last pass dropped, the
 * operator's pause switch, the work-in-progress cap — lived only as prose,
 * re-narrated across 1,186 lines of skill text and executed by the least
 * deterministic component in the system: a language model reading
 * instructions. Three gates were added on 2026-09-02 alone, each as more
 * prose. The panel-check incidents (2026-08-12/13) established the pattern
 * this closes: a rule that is only prose eventually goes unexecuted by a pass
 * that read it.
 *
 * This file is the pure half: WHICH gates, in WHAT order, what each exit code
 * means, and how the one composed verdict is reached. scripts/preflight.mjs
 * is the IO that actually runs them. A gate is CALLED, never re-implemented —
 * this module owns sequencing only, and each refusal's message stays the
 * refusing tool's own.
 *
 * THE HOUSE CONVENTION for the composed verdict:
 *   0  go — claim from the queue
 *   3  a normal decline (not this machine, deck taken, cap full)
 *   2  could not tell — NEVER rendered as 0 (DOCTRINE 3.11)
 *   1  a real failure
 *
 * Gates keep their own dialects (node:owns says 1 for "cannot tell";
 * wip-check documents 1 the same way), so each gate carries a TRANSLATION to
 * the house codes rather than the caller guessing — one place per dialect.
 */

/**
 * The canonical order, per loop. THIS TABLE IS THE SEQUENCE — a test reads it,
 * and the skills reference the command instead of enumerating it.
 *
 * Two properties worth stating because they are deliberate:
 *
 * - `pass-reconcile` runs BEFORE the pause check, exactly as the skill always
 *   ordered it: repairing a dropped ticket is not claiming and not merging,
 *   so a pause does not defer the repair.
 * - `pass-reconcile` is `warnOnly`: by its own contract every outcome ends
 *   with "carry on with your own pass either way" — but its line must still
 *   be REPORTED, because a hand-back's log line is the only evidence a
 *   previous pass dropped its ticket.
 */
const GATES = Object.freeze({
  'loop-build': Object.freeze([
    Object.freeze({
      id: 'ownership',
      npmArgs: Object.freeze(['node:owns', '--', 'loop-build']),
      // node:owns dialect: 0 = this machine's job, 3 = another machine's
      // (decline), 1 = cannot tell which machine this is (house 2 — "someone
      // else is doing it" and "nobody is doing it" look identical from here).
      translate: Object.freeze({ 0: 0, 3: 3, 1: 2 }),
      warnOnly: false,
    }),
    Object.freeze({
      id: 'reconcile',
      npmArgs: Object.freeze(['clickup', '--', 'pass-reconcile']),
      // pass-reconcile dialect: 0 nothing to do, 3 a hand-back was PERFORMED
      // (news, not a stop), 2 could not tell (say so, continue), 1 a hand-back
      // failed (say so loudly, continue — it retries next pass). None of these
      // stop the pass, so all translate to "go", and the WARN flag on non-zero
      // is what keeps them from vanishing into a green line.
      translate: Object.freeze({ 0: 0, 3: 0, 2: 0, 1: 0 }),
      warnOnly: true,
    }),
    Object.freeze({
      id: 'pause',
      npmArgs: Object.freeze(['pipeline', '--', 'check']),
      // pipeline check dialect: 0 running, 3 paused — and an unreadable switch
      // is already 3 by that tool's own fail-safe, so no 2 arrives here.
      translate: Object.freeze({ 0: 0, 3: 3 }),
      warnOnly: false,
    }),
    Object.freeze({
      id: 'cap',
      npmArgs: Object.freeze(['clickup', '--', 'wip-check']),
      // wip-check dialect: 0 room to claim, 3 capped (decline), 1 could not
      // tell (house 2).
      translate: Object.freeze({ 0: 0, 3: 3, 1: 2 }),
      warnOnly: false,
    }),
  ]),
  'loop-review': Object.freeze([
    Object.freeze({
      id: 'ownership',
      npmArgs: Object.freeze(['node:owns', '--', 'loop-review']),
      translate: Object.freeze({ 0: 0, 3: 3, 1: 2 }),
      warnOnly: false,
    }),
    // No reconcile: the marker is written by `claim --pass`, which is
    // loop-build's move; review claims nothing into a machine status that
    // way. No cap: review drains the very PRs the cap waits on — capping it
    // would deadlock the pipeline against itself (loopInterval's own test).
    Object.freeze({
      id: 'pause',
      npmArgs: Object.freeze(['pipeline', '--', 'check']),
      translate: Object.freeze({ 0: 0, 3: 3 }),
      warnOnly: false,
    }),
  ]),
});

const KNOWN_LOOPS = Object.freeze(Object.keys(GATES));

/**
 * What one gate's raw exit means for the run.
 *
 * An exit code the gate's dialect does not define is a REAL FAILURE, never a
 * guessable: a tool that starts speaking a new code has changed its contract,
 * and obeying an untranslated code would mean acting on a word nobody defined.
 */
function interpretGate(gate, rawCode) {
  const code = Number(rawCode);
  const translated = gate.translate[code];
  if (translated === undefined) {
    return {
      houseCode: 1,
      stop: true,
      warn: false,
      note: `${gate.id} exited ${rawCode}, which its dialect does not define — treated as a real failure, not guessed around`,
    };
  }
  if (gate.warnOnly) {
    return {
      houseCode: 0,
      stop: false,
      warn: code !== 0,
      note: code !== 0 ? `${gate.id} reported something (its exit ${code}) — read its line; it never stops the pass` : '',
    };
  }
  return {
    houseCode: translated,
    stop: translated !== 0,
    warn: false,
    note: '',
  };
}

/**
 * One line per gate, for the log: verdict word first so a column of these
 * scans, then the gate, then the tool's own first meaningful line.
 */
function renderGateLine(gate, rawCode, firstLine) {
  const r = interpretGate(gate, rawCode);
  const word = r.warn ? 'NOTE' : r.houseCode === 0 ? 'ok  ' : r.houseCode === 3 ? 'STOP' : r.houseCode === 2 ? '????' : 'FAIL';
  const said = String(firstLine || '').trim();
  return `${word}  ${gate.id.padEnd(10)} ${said}`.trimEnd();
}

/**
 * The composed verdict, from the gates actually run. The FIRST stopper wins
 * and nothing after it ran — stated, so a green line below a stop can never
 * be misread as having been checked.
 */
function composeVerdict(results) {
  for (const r of results) {
    if (r.stop) {
      return {
        code: r.houseCode,
        line: r.houseCode === 3
          ? `PREFLIGHT: stop — ${r.gateId} declined. A normal outcome; report its line and finish the pass.`
          : r.houseCode === 2
            ? `PREFLIGHT: could not tell at ${r.gateId}. Say so loudly and stop — never treat "could not check" as clear.`
            : `PREFLIGHT: failed at ${r.gateId}. Say so loudly and stop.`,
      };
    }
  }
  const warns = results.filter((r) => r.warn).map((r) => r.gateId);
  return {
    code: 0,
    line: warns.length
      ? `PREFLIGHT: go — and report what ${warns.join(', ')} said; those lines are the only evidence of what was repaired.`
      : 'PREFLIGHT: go — claim from the queue.',
  };
}

module.exports = {
  GATES,
  KNOWN_LOOPS,
  interpretGate,
  renderGateLine,
  composeVerdict,
};
