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
 * alarm was enough to flip STALLED to MOVING for the next 24 hours. With the
 * bus in its own tracker project (`busProject`) the Team chat ticket is not
 * normally in the queue at all; it is still excluded, for a project whose
 * bus ticket was made in its own queue.
 */

const busFallback = require('./busFallback.js');
const pipelinePause = require('./pipelinePause.js');

const NOTICEBOARD_NAMES = [
  ...busFallback.ALL_TASK_NAMES,
  pipelinePause.SWITCH_TASK_NAME,
];

const NORMALISED = new Set(NOTICEBOARD_NAMES.map((n) => String(n).trim().toLowerCase()));

/** Is this ticket a noticeboard rather than a piece of work? */
function isNoticeboard(task) {
  return NORMALISED.has(String(task?.name ?? '').trim().toLowerCase());
}

/** The tickets that are work. Anything not a list is no tickets. */
function workTickets(tasks) {
  return (Array.isArray(tasks) ? tasks : []).filter((t) => !isNoticeboard(t));
}

module.exports = {
  NOTICEBOARD_NAMES,
  isNoticeboard,
  workTickets,
};
