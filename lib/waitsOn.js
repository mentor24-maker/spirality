'use strict';

/**
 * waitsOn — "this ticket builds on that one", declared once, read by the claim.
 *
 * WHY THIS FILE EXISTS (2026-10-27, task 86bctfun6). The build loop takes the
 * oldest Queued ticket, whatever it builds on. So a plan whose steps depend on
 * each other could only be filed one wave at a time, each wave after the one
 * before had merged, and Dane looked for the tracker plan's tickets in the
 * Loop Queue and found most of them missing. A ticket may now say what it waits
 * on, and the claim leaves it alone until that ticket is closed.
 *
 * The declaration is a line of its own in the description:
 *
 *   Waits on: 86bctbf46
 *   Waits on: https://app.clickup.com/t/86bctbf46, 86bctbw76
 *
 * Any letter case; one or more ticket ids or ticket links, separated by commas.
 * Prose that merely mentions waiting does nothing: a ticket is held back by a
 * declaration, never by how a paragraph was worded (the same rule as
 * `Next slice:` in relayLane.js).
 *
 * A bare id is safe here although clickupTicketLink.js refuses one in a PR
 * body: there the id had to be picked out of free prose, here it sits after a
 * marker that names it. A bare id is also what the tracker that replaces
 * ClickUp will use (docs/TRACKER_MVP.md), so the line works on either.
 *
 * ClickUp's own dependency feature is not used for the same reason.
 */

const { CLICKUP_LINK_RE } = require('./clickupTicketLink.js');

const WAITS_ON_LINE_RE = /^[ \t]*waits on:[ \t]*(.+?)[ \t]*$/gim;
const BARE_ID_RE = /^[a-z0-9][a-z0-9-]*$/i;

/** Every ticket a description says it waits on, lowercased, in order, no repeats. */
function waitsOn(description) {
  const ids = [];
  for (const m of String(description || '').matchAll(WAITS_ON_LINE_RE)) {
    for (const raw of m[1].split(',')) {
      const token = raw.trim().replace(/^[`*_]+|[`*_.]+$/g, '');
      if (!token) continue;
      const link = CLICKUP_LINK_RE.exec(token);
      const id = link ? link[1] : (BARE_ID_RE.test(token) ? token : '');
      if (id && !ids.includes(id.toLowerCase())) ids.push(id.toLowerCase());
    }
  }
  return ids;
}

/**
 * The prerequisites still open, given the ids of every open ticket in the list.
 * A prerequisite absent from that set is closed (or lives in another list,
 * which this check cannot see and does not hold a ticket back for).
 */
function stillWaitingOn(description, openIds) {
  const open = new Set([...(openIds || [])].map((id) => String(id).toLowerCase()));
  return waitsOn(description).filter((id) => open.has(id));
}

module.exports = {
  waitsOn,
  stillWaitingOn,
};
