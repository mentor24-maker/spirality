'use strict';

/**
 * STAGE COUNTS FOR THE WEEKLY REPORT (SP-206).
 *
 * StarCaster's Monday report (`scripts/weekly_report.mjs`, its `gatherStages`)
 * runs `npm run clickup -- stage-counts --list <id> --since <date> --until
 * <date>` and reads one JSON object from it. Once StarCaster's `clickup`
 * command is Spirality's door, the door has to answer the same thing, in the
 * same shape, or the report's "ticket stages" row goes blank.
 *
 * The shape StarCaster's door prints, which `weekly_report.mjs` reads
 * unchanged:
 *
 *   { list, total, byStatus, since, until, closedInWindow }
 *
 *   - byStatus: how many tickets sit in each status NOW, keyed by the status
 *     in lower case ("in review"). The report draws these as the pipeline.
 *   - total: every ticket counted, Live included.
 *   - closedInWindow: how many shipped inside the window (null without
 *     --since).
 *
 * Two fields are added, which StarCaster's report ignores:
 *
 *   - startedInWindow: tickets filed inside the window;
 *   - enteredInWindow: for each of the eight statuses, how many tickets
 *     moved into it (or were filed in it) inside the window, from the
 *     ticket's history. A ticket that entered a status twice counts once.
 *
 * "Shipped" and "filed" are counted the way the tracker's Reporting page
 * counts Finished and Started (tracker/pageData.mjs, `reportsOf`): a ticket
 * finished when it LAST entered Live, and only if it is Live now; a ticket
 * started when it was filed.
 *
 * The window is whole days in UTC, `--since` from midnight to `--until` at
 * the last millisecond, as StarCaster's command reads it.
 */

const { STAGE_ORDER, LIVE } = require('./loopStatuses.js');

const STATUSES = STAGE_ORDER.map((s) => s.toLowerCase());
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The window from `--since` and `--until` (YYYY-MM-DD), as
 * `{ cutoff, ceiling }` in milliseconds (null and Infinity when not given),
 * or `{ error }` with the sentence to print (the caller exits 2).
 */
function parseWindow(since, until) {
  const day = (value, flag, time) => {
    if (!DATE.test(String(value))) return { error: `${flag} "${value}" is not a YYYY-MM-DD date.` };
    const at = Date.parse(`${value}T${time}Z`);
    // Date.parse rolls 2026-02-30 over to March; a date that does not come
    // back as itself is not a date.
    if (Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== value) {
      return { error: `${flag} "${value}" is not a YYYY-MM-DD date.` };
    }
    return { at };
  };
  if (since == null || since === '') {
    if (until != null && until !== '') return { error: '--until needs --since; a ceiling with no floor is not a window.' };
    return { cutoff: null, ceiling: Infinity };
  }
  const floor = day(since, '--since', '00:00:00.000');
  if (floor.error) return floor;
  if (until == null || until === '') return { cutoff: floor.at, ceiling: Infinity };
  const top = day(until, '--until', '23:59:59.999');
  if (top.error) return top;
  if (top.at < floor.at) return { error: `--until "${until}" is before --since "${since}".` };
  return { cutoff: floor.at, ceiling: top.at };
}

/** A time (ISO text, or milliseconds as a number or digits) in ms, or NaN. */
function msOf(value) {
  if (value == null || value === '') return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : Date.parse(String(value));
}

/**
 * Count the stages.
 *
 * `tickets`: as the door lists them (`status.status`, `date_created`).
 * `histories`: a Map from ticket id to its status moves, oldest first, each
 * `{ at, to }` (the filing counts as a move into the status it was filed
 * in). Needed only when there is a window; a ticket with no entry in it is a
 * caller's bug, and throws.
 */
function countStages(tickets, { list = null, since = null, until = null, window = { cutoff: null, ceiling: Infinity }, histories = new Map() } = {}) {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const t of tickets) {
    const key = String(t.status?.status ?? 'unknown').toLowerCase();
    byStatus[key] = (byStatus[key] || 0) + 1;
  }
  const out = { list, total: tickets.length, byStatus, since: since || null, until: until || null, closedInWindow: null };
  if (window.cutoff == null) return out;

  const inside = (at) => Number.isFinite(at) && at >= window.cutoff && at <= window.ceiling;
  const entered = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  let closed = 0;
  let started = 0;
  for (const t of tickets) {
    const moves = histories.get(String(t.id));
    if (!Array.isArray(moves)) throw new Error(`no status history was given for ${t.id}`);
    if (inside(msOf(t.date_created))) started += 1;
    const seen = new Set();
    let lastLive = null;
    for (const m of moves) {
      const to = String(m.to ?? '').toLowerCase();
      const at = msOf(m.at);
      if (to === LIVE) lastLive = at;
      if (inside(at) && !seen.has(to)) {
        seen.add(to);
        entered[to] = (entered[to] || 0) + 1;
      }
    }
    const isLive = String(t.status?.status ?? '').toLowerCase() === LIVE;
    if (isLive && inside(lastLive)) closed += 1;
  }
  out.closedInWindow = closed;
  out.startedInWindow = started;
  out.enteredInWindow = entered;
  return out;
}

/**
 * The one sentence a failed history read prints, naming every ticket whose
 * history did not come back. Null when nothing failed.
 */
function failedHistoryLine(problems) {
  if (!problems.length) return null;
  return `stage-counts FAILED: ${problems.length} ticket history read(s) did not come back, so nothing was printed: `
    + problems.map((p) => `${p.id} (${p.problem})`).join('; ');
}

module.exports = { STATUSES, parseWindow, countStages, failedHistoryLine };
