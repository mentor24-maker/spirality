'use strict';

/**
 * relayLane — the pure decisions of Spirality's relay pass that are NOT
 * already in mergeOnComment.
 *
 * WHY THIS EXISTS (2026-10-13, task 86bchpkxz). Dane wrote "merge PR #4" on
 * a Ready to launch ticket at 9:23 AM and nothing read it for four hours:
 * Spirality ran only loop-build and loop-review, and neither one merges.
 * `mergeOnComment` already decides WHETHER his word authorizes a merge
 * (mergeDecision) and whether GitHub will allow it (githubGate). What was
 * missing is the hands: a pass that reads the queue, carries those decisions
 * out, and writes the record back. That pass is the `relay` command in
 * scripts/clickup.mjs; the parts of it that can be decided without a network
 * live here, so each is tested without ClickUp or GitHub.
 *
 * Three small questions:
 *
 *   1. What do the threaded replies under one of his comments say about an
 *      earlier pass's answer?            → markerBookkeeping
 *   2. After the merge, Live or Queued?  → mergeDestination
 *   3. What does `gh pr view` need to be asked for, so githubGate can read
 *      every field it looks at?          → PR_VIEW_FIELDS
 *
 * Nothing here merges, posts, or reads a config. Every product-specific value
 * (the operator's id, the merge phrases, the repository) reaches the relay
 * through the project config at the door, never through this file.
 */

const { latestMergeMarker, countMergeRefusals } = require('./mergeOnComment');

/**
 * Every field githubGate reads, plus the three the relay itself needs (url,
 * headRefOid, mergedAt). Asking for fewer would make the gate answer "cannot
 * tell" for a field it was never given; asking here, in one list, is what
 * keeps the dry run and the real pass reading the same pull request.
 */
const PR_VIEW_FIELDS = Object.freeze([
  'state', 'isDraft', 'mergeable', 'mergeStateStatus', 'reviewDecision',
  'statusCheckRollup', 'url', 'headRefOid', 'mergedAt', 'number',
]);

/**
 * Read one operator comment's reply thread into the bookkeeping mergeDecision
 * wants: is this authorization spent (a terminal marker), or was it refused,
 * and if so for what reason, when, and how many times for that reason?
 *
 * Copied from the loop body of StarCaster's bus-relay (scripts/
 * clickup_direct.mjs), where it was inline and untested; the rules are
 * mergeOnComment's, read through its own parser so the writer and the reader
 * cannot drift.
 */
function markerBookkeeping(replies) {
  const marker = latestMergeMarker(replies);
  if (!marker) return { marker: null, handled: false, refused: null, refusedAt: '', refusedCount: 0 };
  if (marker.kind === 'refused') {
    return {
      marker,
      handled: false,
      refused: marker.reason,
      refusedAt: marker.at || '',
      refusedCount: countMergeRefusals(replies, marker.reason),
    };
  }
  return { marker, handled: true, refused: null, refusedAt: '', refusedCount: 0 };
}

/**
 * Fold one comment's bookkeeping into the maps mergeDecision takes. Returns
 * the same object it was given, mutated, so a caller can build the maps in a
 * loop with no second copy of the key-stringing rule.
 */
function recordBookkeeping(books, commentId, keeping) {
  const id = String(commentId);
  if (keeping.handled) books.handled.add(id);
  if (keeping.refused != null) {
    books.refused.set(id, keeping.refused);
    books.refusedAt.set(id, keeping.refusedAt);
    books.refusedCount.set(id, keeping.refusedCount);
  }
  return books;
}

function emptyBooks() {
  return { handled: new Set(), refused: new Map(), refusedAt: new Map(), refusedCount: new Map() };
}

/**
 * Where the ticket goes once its pull request is merged.
 *
 * `Live` is the answer unless the ticket's description says, on a line of
 * its own, that another slice is still to come:
 *
 *   Next slice: the Needs your input hand-back, once busRelayPlan arrives
 *
 * That line is the ONE convention. "Next slice: none" (or "done") reads as
 * no next slice. A sentence in prose ("the ticket returns to Queued after
 * each slice") is deliberately not read: the relay moves a ticket on a
 * declaration, never on an inference from how a paragraph was worded, and
 * the build pass that narrows a description to one slice is the pass that
 * writes the line (loop-build SKILL.md, "offer named slices").
 *
 * A `Queued` ticket is claimed by the next build pass, so the line is what
 * keeps a sliced ticket moving without anyone dragging it back by hand.
 */
const NEXT_SLICE_RE = /^[ \t]*(?:[-*]\s+)?(?:\*\*)?next slice(?:\*\*)?\s*:\s*(.*?)\s*$/im;
const NO_NEXT_SLICE = new Set(['', 'none', 'done', 'no', 'n/a', '-']);

function mergeDestination(description) {
  const m = NEXT_SLICE_RE.exec(String(description || ''));
  if (!m) return { status: 'Live', why: 'no "Next slice:" line in the description' };
  const rest = String(m[1] || '').replace(/[.!]+$/, '').trim();
  if (NO_NEXT_SLICE.has(rest.toLowerCase())) {
    return { status: 'Live', why: `the description's "Next slice:" line says ${JSON.stringify(rest || 'nothing')}` };
  }
  return { status: 'Queued', why: `the description says more remains — "Next slice: ${rest}"` };
}

/**
 * One line per ticket, the shape the dry run and the real pass both print,
 * so a reader comparing the two logs sees the same words. `outcome` is the
 * relay's own vocabulary; `detail` is the reason in plain words.
 */
function relayLine({ task, status, outcome, detail }) {
  const name = task && task.name ? ` "${task.name}"` : '';
  const id = task && task.id ? task.id : '?';
  return `${id}\t${status || '?'}\t${outcome}\t${detail}${name}`;
}

module.exports = {
  PR_VIEW_FIELDS,
  NEXT_SLICE_RE,
  markerBookkeeping,
  recordBookkeeping,
  emptyBooks,
  mergeDestination,
  relayLine,
};
