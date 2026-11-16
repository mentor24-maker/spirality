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

module.exports = {
  KINDS,
  STARTERS,
  OUTCOMES,
  KIND_LABELS,
  STARTER_LABELS,
  OUTCOME_LABELS,
  CLASS_FIELDS,
  classValue,
};
