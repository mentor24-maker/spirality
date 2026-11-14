'use strict';

/**
 * What the throughput, checkout-currency and failed-pass watchdogs share
 * (SP-268): how often one finding may be said again, where their reminder
 * stamps live, and the failed-pass post.
 *
 * Moved from StarCaster's `lib/nodeHeartbeat.js` (commit 0682572): the
 * repost window (`REPOST_EVERY_MS`), `dueAgain`, `ageText` and
 * `renderFailurePost`, the parts these three watchdogs read from it. The rest
 * of that file is the heartbeat, which is its own ticket (SP-266). Changes:
 * the failure post starts `ALARM:`, so the tracker texts it (docs/TRACKER_MVP.md,
 * "The bus"), and drops StarCaster's `[CC-starcaster]` sign-off, because
 * `bus-post` already heads every post with the machine it came from.
 *
 * Pure: no network, no clock of its own, no files.
 */

const path = require('node:path');
const { mountainTime: trackerBusMountainTime } = require('./trackerBus.js');

/**
 * One post per finding per 6 hours. A job failing every ten minutes would
 * otherwise bury the bus, and a buried bus is an unread one. Each watchdog
 * clears its stamp on the next good reading, not on a timer, so a fault that
 * is fixed and comes back is said again at once.
 */
const REPOST_EVERY_MS = 6 * 60 * 60 * 1000;

/** Has `everyMs` passed since `lastAt` (an ISO time)? A missing or unreadable time is due. */
function dueAgain({ lastAt, now = Date.now(), everyMs }) {
  if (!lastAt) return true;
  const then = Date.parse(lastAt);
  if (!Number.isFinite(then)) return true;
  return now - then >= everyMs;
}

/** "12m ago", "3h 5m ago", "2d 4h ago". */
function ageText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'in the future (check the clocks)';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m ago`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
}

/**
 * The folder these watchdogs keep their reminder stamps in: beside the lane
 * logs, named for the project, so they outlive any worktree and two projects
 * on one machine never share one. Both parts come from the project config.
 */
function stampDir({ logDir, slug }) {
  if (!logDir || !slug) throw new Error('stampDir needs the project config\'s logDir and projectSlug');
  return path.join(logDir, `${slug}-watchdogs`);
}

/** A job name as a file-name part: letters, digits and dashes only. */
function jobFileName(job) {
  return String(job || '').replace(/[^a-z0-9-]/gi, '-');
}

/** The stamp that says a job's failure was already posted (cleared by its next success). */
function failureStampFile({ logDir, slug, job }) {
  return path.join(stampDir({ logDir, slug }), `failed-${jobFileName(job)}.stamp`);
}

/**
 * The bus post for a failed scheduled job: which job, on which machine, its
 * exit, when, and the end of its log. Starts `ALARM:` so it is texted.
 * `when` turns the ISO time into the words the reader sees (Mountain time
 * in the script); it defaults to the ISO time itself.
 */
function renderFailurePost({ job, node, status, at = new Date().toISOString(), logTail = '', logPath = '', when = (iso) => iso }) {
  return [
    `ALARM: 🚨 **${job} FAILED on ${node}**, exit status ${status} at ${when(at)}.`,
    '',
    logPath ? `Log: \`${logPath}\`` : '',
    logTail ? ['', 'Last lines:', '```', String(logTail).trimEnd(), '```'].join('\n') : '',
    '',
    `_Repeated at most once every ${Math.round(REPOST_EVERY_MS / 3600000)} hours until the job succeeds again._`,
  ].filter((l) => l !== '').join('\n');
}

/**
 * An ISO time in Mountain time, the way Dane reads times ("11/14/2026, 9:36 AM MT").
 * The bus's own formatter (lib/trackerBus.js), so there is one copy; this
 * wrapper only takes an ISO string and hands back anything unreadable as it came.
 */
function mountainTime(iso) {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? trackerBusMountainTime(ms) : String(iso);
}

module.exports = {
  REPOST_EVERY_MS,
  dueAgain,
  ageText,
  stampDir,
  jobFileName,
  failureStampFile,
  renderFailurePost,
  mountainTime,
};
