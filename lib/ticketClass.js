'use strict';

/**
 * A ticket's class: its kind, who started it and how it ended (SP-345).
 *
 * WHY THIS EXISTS (2026-11-16). Dane is starting to report on productivity
 * and efficiency, and until now every ticket counted the same: a
 * merge-conflict fix-up, a feature and a dropped ticket were each one
 * finished ticket. 58 of Spirality's 344 tickets (17%) were merge-conflict
 * fix-ups the loop filed for itself, and a dropped ticket closed as `Live`
 * with a `wont-do` tag, so every report counted it as shipped. These three
 * fields let a report split the work without guessing from tags or titles.
 *
 * The values are part of the contract (docs/LOOP_CONTRACT.md, "A ticket's
 * kind, who started it and how it ended"), the same in every project, so
 * they live here and never in a project's config. A ticket's kind is judged
 * inside the project whose queue it is in: in Spirality the loop is what the
 * project makes, so loop work is a Feature there.
 *
 * Each field is one of its values or nothing (null): a ticket filed before
 * the fields existed has none until someone gives it one.
 */

/** What the ticket is, exactly one. */
const KINDS = Object.freeze(['feature', 'fix', 'operational', 'documentation']);

/** Who started it. An agent session is never a person, so it has its own value. */
const STARTERS = Object.freeze(['operator', 'client', 'agent']);

/** How a closed ticket ended. An open ticket has none. */
const OUTCOMES = Object.freeze(['done', 'wont-do', 'duplicate', 'test']);

/** Each value as the page and a report write it (Title Case, docs/UI_DOCTRINE.md). */
const KIND_LABELS = Object.freeze({
  feature: 'Feature',
  fix: 'Fix',
  operational: 'Operational',
  documentation: 'Documentation',
});
const STARTER_LABELS = Object.freeze({
  operator: 'Operator',
  client: 'Client',
  agent: 'Agent Session',
});
const OUTCOME_LABELS = Object.freeze({
  done: 'Done',
  'wont-do': "Won't Do",
  duplicate: 'Duplicate',
  test: 'Test',
});

/** The three fields, by the name the store, the API and the door use. */
const CLASS_FIELDS = Object.freeze({
  kind: Object.freeze({ label: 'Kind', values: KINDS, labels: KIND_LABELS }),
  startedBy: Object.freeze({ label: 'Started By', values: STARTERS, labels: STARTER_LABELS }),
  outcome: Object.freeze({ label: 'How It Ended', values: OUTCOMES, labels: OUTCOME_LABELS }),
});

/**
 * A value as kept: lower case, spaces and underscores as hyphens, so
 * "Won't do", "wont do" and "WONT_DO" all read as `wont-do`. Null and the
 * empty string are "none" (null). Anything else that is not one of the
 * field's values answers `{ problem }`, a plain sentence naming the choices.
 */
function classValue(field, value) {
  const spec = CLASS_FIELDS[field];
  if (!spec) return { problem: `"${field}" is not a ticket class field: ${Object.keys(CLASS_FIELDS).join(', ')}.` };
  if (value == null) return { value: null };
  const v = String(value).trim().toLowerCase().replace(/['’]/g, '').replace(/[\s_]+/g, '-');
  if (v === '' || v === 'none') return { value: null };
  if (spec.values.includes(v)) return { value: v };
  return { problem: `"${value}" is not a ${spec.label.toLowerCase()}: ${spec.values.join(', ')}, or none.` };
}

/**
 * The class of a ticket a loop or watchdog files on its own (SP-346): the
 * merge-conflict catch-up ("Resolve the merge conflict on PR #N"), the bus's
 * team chat, a project's setup ticket. Each exists only to keep things
 * running, so it is Operational, and an agent session started it.
 */
const LOOP_FILING_CLASS = Object.freeze({ kind: 'operational', startedBy: 'agent' });

/**
 * Who started a ticket, and its kind where that follows, when the filing
 * did not say (SP-346, docs/LOOP_CONTRACT.md, "Who sets them at filing"):
 * read from who filed it, so a new ticket never arrives blank.
 *
 * - A loop's sign-in (`actorKind` 'machine') files as an agent session. Its
 *   kind is never guessed: the loop says it, or it stays none.
 * - The project's operator, signed in as a person, files as `operator`.
 * - Any other person files as a client, and a client's ticket is a Fix
 *   unless they said otherwise: the people Dane invites file from an outside
 *   site (docs/OUTSIDE_SITE_API.md), and what they file is a bug report.
 *
 * `given` is the filing's own fields; a field it names (even as null, "none")
 * is the caller's word and is never replaced. Answers only the fields to add.
 */
function filedClass({ actorKind, isOperator = false, given = {} }) {
  const add = {};
  let startedBy = given.startedBy;
  if (!('startedBy' in given)) {
    if (actorKind === 'machine') startedBy = 'agent';
    else if (actorKind === 'human') startedBy = isOperator ? 'operator' : 'client';
    if (startedBy !== undefined) add.startedBy = startedBy;
  }
  if (!('kind' in given) && startedBy === 'client' && actorKind === 'human') add.kind = 'fix';
  return add;
}

/**
 * The endings that are not finished work (SP-347): a dropped ticket, a
 * duplicate and a test ticket close as `Live` like any other, but none of
 * them is something the project shipped. Every count of finished tickets
 * (the Reporting page, the door's `stage-counts`, the throughput watchdog)
 * leaves them out; a dropped ticket counted as a closure would hide a real
 * stall.
 */
const NOT_FINISHED_OUTCOMES = Object.freeze(['wont-do', 'duplicate', 'test']);

/**
 * Does a closed ticket with this ending count as finished? `done` does, and
 * so does none (an ending never recorded is not a reason to drop real work);
 * Won't do, Duplicate and Test do not. Read through classValue, so "Won't
 * do" as typed counts the same as `wont-do`.
 */
function countsAsFinished(outcome) {
  const read = classValue('outcome', outcome);
  return !(read.value && NOT_FINISHED_OUTCOMES.includes(read.value));
}

module.exports = {
  NOT_FINISHED_OUTCOMES,
  countsAsFinished,
  filedClass,
  LOOP_FILING_CLASS,
  KINDS,
  STARTERS,
  OUTCOMES,
  KIND_LABELS,
  STARTER_LABELS,
  OUTCOME_LABELS,
  CLASS_FIELDS,
  classValue,
};
