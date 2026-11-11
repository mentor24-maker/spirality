'use strict';

/**
 * TICKETS AS DATA (SP-205).
 *
 * StarCaster's scheduled checks (throughput, stale-ready, stale-answer,
 * pipeline-pulse, sql:unapplied, broken-links, heartbeat's roll call) and its
 * review-gate workflow read the Loop Queue straight from ClickUp's API. Once
 * a project moves to the tracker, that list is written by nothing, so each
 * check needs one plain way to read the tickets through the door instead of
 * each one learning the tracker's own API: `npm run clickup -- tickets --json`.
 *
 * This file holds the shape of what that command prints, so a test reaches
 * it without a network. The door hands it tickets and comments in the shape
 * every tracker adapter answers (ClickUp's: scripts/tracker/apiTracker.mjs
 * makes the tracker's look the same), and it answers plain objects:
 *
 *   {
 *     id, name, status, priority, tags,
 *     created, updated, statusSince,            // ISO times, UTC
 *     comments: [{ id, author: { id, name }, by, at, text }]   // with --comments only
 *   }
 *
 * `status` is the status as the queue prints it ("in review"); `priority` is
 * "urgent", "high", "normal", "low" or null; `by` is "operator" when the
 * comment's author is the project's operator seat, "machine" otherwise.
 * `comments` are the top-level ones, oldest first, text exactly as stored.
 */

/** A ClickUp-style millisecond time (a number or its digits) as ISO, or null. */
function isoTime(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  const d = Number.isFinite(n) ? new Date(n) : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * When the ticket entered its current status, from a "Time in Status" answer
 * (`current_status.total_time.since`, ClickUp's shape, which the tracker
 * adapter answers too). Null when the answer does not say.
 */
function statusSinceFrom(timeInStatus) {
  return isoTime(timeInStatus?.current_status?.total_time?.since);
}

/** One top-level comment as data. */
function commentJson(c, { operatorId } = {}) {
  const authorId = c?.user?.id == null ? null : Number(c.user.id);
  return {
    id: String(c.id),
    author: { id: authorId, name: c?.user?.username ?? null },
    by: operatorId != null && authorId === Number(operatorId) ? 'operator' : 'machine',
    at: isoTime(c.date),
    text: typeof c.comment_text === 'string'
      ? c.comment_text
      : (Array.isArray(c.comment) ? c.comment.map((run) => String(run?.text ?? '')).join('') : ''),
  };
}

/**
 * One ticket as data. `statusSince` is the ISO time it entered its current
 * status; `comments`, when given, are the adapter's comment list (newest
 * first, as `listComments` answers) and come out oldest first.
 */
function ticketJson(task, { statusSince = null, comments, operatorId } = {}) {
  const out = {
    id: String(task.id),
    name: task.name,
    status: String(task.status?.status ?? '').toLowerCase(),
    priority: task.priority?.priority ?? null,
    tags: (task.tags || []).map((t) => t.name),
    created: isoTime(task.date_created),
    updated: isoTime(task.date_updated),
    statusSince,
  };
  if (comments) {
    // Newest first in, oldest first out; the sort only settles a list that
    // came in some other order, and keeps same-time comments as given.
    out.comments = comments
      .filter((c) => c.parent == null)
      .reverse()
      .map((c) => commentJson(c, { operatorId }))
      .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  }
  return out;
}

/**
 * The one sentence a failed `tickets --json` read prints, naming every
 * ticket whose extra reads failed and why. Null when nothing failed.
 */
function failedReadsLine(problems) {
  if (!problems.length) return null;
  return `tickets FAILED: ${problems.length} read(s) did not come back, so nothing was printed: `
    + problems.map((p) => `${p.id} ${p.what} (${p.problem})`).join('; ');
}

module.exports = { isoTime, statusSinceFrom, commentJson, ticketJson, failedReadsLine };
