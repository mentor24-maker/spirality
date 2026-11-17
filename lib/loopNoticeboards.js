'use strict';

/**
 * The standing tickets that are noticeboards, not work (SP-268).
 *
 * Moved from StarCaster's `lib/loopNoticeboards.js` (commit 0682572), cut to
 * the two noticeboards Spirality has: the bus's "Team chat" ticket (under
 * every name it has had) and the pipeline pause switch. StarCaster's others
 * (the heartbeat roll call, the pulse digest, unapplied SQL, broken links)
 * belong to watchdogs that stay in StarCaster or have not moved.
 *
 * Why it matters: a noticeboard sits in a finished status, so the throughput
 * watchdog (`lib/loopThroughput.js`) would count it as a ticket that shipped,
 * and every post to it as the queue being touched. In StarCaster, saving one
 * alarm was enough to flip STALLED to MOVING for the next 24 hours.
 *
 * A project is normally its own bus (SP-356): its Team chat sits in its own
 * queue. So besides the two names, ANY ticket tagged `noticeboard` is one,
 * which covers StarCaster's Pipeline pulse, Node roll call, SQL waiting for
 * you and Broken links on client sites (and the steward's questions for the
 * operator) without a list of a project's names here. `bus-post` tags the
 * Team chat it makes; a project tags its own boards.
 */

const busFallback = require('./busFallback.js');
const pipelinePause = require('./pipelinePause.js');

const NOTICEBOARD_NAMES = [
  ...busFallback.ALL_TASK_NAMES,
  pipelinePause.SWITCH_TASK_NAME,
];

/** The tag that makes any ticket a noticeboard (SP-356). */
const NOTICEBOARD_TAG = 'noticeboard';

const NORMALISED = new Set(NOTICEBOARD_NAMES.map((n) => String(n).trim().toLowerCase()));

/**
 * The ticket's tags as lower-case words, whichever shape the reader gave:
 * ClickUp's `[{ name }]` (the door) or plain strings (the tracker's rows).
 */
function tagWords(task) {
  const tags = Array.isArray(task?.tags) ? task.tags : [];
  return tags.map((t) => String((t && typeof t === 'object') ? (t.name ?? '') : (t ?? '')).trim().toLowerCase()).filter(Boolean);
}

/** Does the ticket carry the `noticeboard` tag? */
function hasNoticeboardTag(task) {
  return tagWords(task).includes(NOTICEBOARD_TAG);
}

/** Is this ticket a noticeboard rather than a piece of work? By name, or by its tag. */
function isNoticeboard(task) {
  return NORMALISED.has(String(task?.name ?? '').trim().toLowerCase()) || hasNoticeboardTag(task);
}

/** The tickets that are work. Anything not a list is no tickets. */
function workTickets(tasks) {
  return (Array.isArray(tasks) ? tasks : []).filter((t) => !isNoticeboard(t));
}

module.exports = {
  NOTICEBOARD_NAMES,
  NOTICEBOARD_TAG,
  hasNoticeboardTag,
  isNoticeboard,
  workTickets,
};
