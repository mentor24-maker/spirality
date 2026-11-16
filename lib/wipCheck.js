'use strict';

/**
 * Spirality's work-in-progress check (SP-238): may loop-build claim another
 * ticket, or is the number in flight already at the cap Dane set on the
 * Settings page?
 *
 * `npm run clickup -- wip-check` reads the facts (the project's tickets, its
 * open pull requests, the page's `wip-cap` setting) and hands them here; this
 * module only decides, so a test can give it any facts it likes.
 *
 * WHAT COUNTS AS IN FLIGHT. Two kinds of ticket, each counted once:
 *
 *   - a ticket with an open pull request that `lib/wipCap.js` counts against
 *     its build cap (its ticket is in Building or In review, and not a build
 *     whose pass died). That reading is wipCap's own, `wipDecision` and
 *     `classifyPrs` as they came from StarCaster, not a second one here
 *     (engineering rule 3, move, don't rewrite);
 *   - a ticket in Building with no open pull request yet: a build under way
 *     that has not opened its pull request. wipCap only sees pull requests,
 *     so without this a pass that has just claimed would not count at all.
 *
 * Rework, Queued, Live and the two statuses that are Dane's do not count,
 * for the reasons wipCap.js gives. wipCap's second ceiling (how many finished
 * pull requests may wait on Dane) is not applied here: the Settings page has
 * no control for it, and a stop Dane cannot see or change is not one to add
 * unasked. The count of them is still reported.
 *
 * WHEN IT CANNOT TELL, the pass goes on and says so (`code: 1`), the way
 * `wipCap.undeterminedDecision` already chooses: the cap is a throughput
 * setting, and refusing on a GitHub hiccup would stop all work.
 */

const wipCap = require('./wipCap.js');
const { operatorName } = require('./substrateConfig.js');

/** Where the page keeps the cap (tracker/pipelineControls.mjs). */
const CAP_SETTING = 'wip-cap';

/** A whole number of 0 or more written as one, else null. */
function wholeNumber(raw) {
  const text = String(raw ?? '').trim();
  return /^[0-9]+$/.test(text) ? Number(text) : null;
}

/**
 * The cap in force, and where it came from.
 *
 * `settings` is what the tracker answered for the project's controls:
 * `{ unsupported: true }` (a project whose tickets are not on the tracker,
 * so it has no page), `{ ok: false, why }` (the read failed), or
 * `{ ok: true, controls: [{ key, value }] }`.
 *
 * On a lane (its runner sets LOOP_RUNNER_PID) the page's value wins.
 * In a hand run CLAUDE_LOOP_WIP_CAP, when it is a whole number, overrides
 * it for that run. With no page, the override or wipCap's default.
 *
 * @returns {{ cap: number|null, source: string, why?: string }}
 *   `cap` null means it could not tell; `why` says so.
 */
function capInForce({ settings, env = process.env } = {}) {
  const onLane = Boolean(String(env?.LOOP_RUNNER_PID ?? '').trim());
  const override = wholeNumber(env?.[wipCap.CAP_ENV]);
  const useOverride = override != null && !onLane;
  if (settings?.unsupported) {
    return useOverride
      ? { cap: override, source: `${wipCap.CAP_ENV} (this project keeps no Settings page)` }
      : { cap: wipCap.DEFAULT_WIP_CAP, source: 'the default (this project keeps no Settings page)' };
  }
  if (!settings?.ok) {
    return { cap: null, source: null, why: `the Settings page's cap could not be read: ${settings?.why || 'unknown'}` };
  }
  const row = (Array.isArray(settings.controls) ? settings.controls : []).find((c) => c && c.key === CAP_SETTING);
  const page = wholeNumber(row?.value);
  if (page == null) {
    return { cap: null, source: null, why: `the tracker's answer has ${row ? `"${row.value}" for` : 'no'} the "${CAP_SETTING}" setting` };
  }
  if (useOverride) return { cap: override, source: `${wipCap.CAP_ENV} for this hand run (the Settings page says ${page})` };
  return { cap: page, source: 'the Settings page' };
}

/** A ticket's status, lowercased, from either shape the door sees. */
function statusOf(ticket) {
  return String(ticket?.status?.status ?? ticket?.status ?? '').trim().toLowerCase();
}

/**
 * The decision, from the facts.
 *
 * @param {object} opts
 * @param {object[]} opts.tickets  every ticket of the project, closed ones
 *   included (a pull request whose ticket is Live must be known as that),
 *   each `{ id, status: { status }, date_updated }`
 * @param {object[]} opts.prs  the repository's open pull requests, each
 *   `{ number, state, body }`
 * @param {number} opts.cap
 * @returns {{ code: 0|3, full: boolean, count: number, cap: number,
 *   ids: string[], line: string, detail: string }}
 */
function wipCheckVerdict({ tickets, prs, cap, nowMs = Date.now(), strandedAfterMs } = {}) {
  const list = Array.isArray(tickets) ? tickets : [];
  const realId = new Map(list.map((t) => [String(t.id).toLowerCase(), String(t.id)]));
  const ticketStatusById = {};
  for (const t of list) {
    ticketStatusById[String(t.id).toLowerCase()] = { status: statusOf(t), dateUpdated: Number(t.date_updated) };
  }
  const decision = wipCap.wipDecision({
    prs, cap, ticketStatusById, nowMs,
    ...(strandedAfterMs == null ? {} : { strandedAfterMs }),
  });
  const knownIds = [...realId.keys()];
  const prById = new Map();
  for (const pr of Array.isArray(prs) ? prs : []) {
    if (!pr || typeof pr !== 'object' || String(pr.state || 'OPEN').toUpperCase() !== 'OPEN') continue;
    const id = wipCap.ticketIdFromPrBody(pr.body, knownIds);
    if (id && !prById.has(id)) prById.set(id, pr.number);
  }
  const counted = new Set(decision.groups.inProgress);
  const ids = [];
  for (const [id, number] of prById) if (counted.has(number)) ids.push(realId.get(id) || id.toUpperCase());
  const freshBuilds = list.filter((t) => statusOf(t) === wipCap.STRANDABLE_STATUS && !prById.has(String(t.id).toLowerCase()));
  for (const t of freshBuilds) ids.push(String(t.id));
  const count = ids.length;
  const full = count >= cap;
  const line = full
    ? `full: ${count} of ${cap} in flight (${ids.join(', ')})`
    : `room: ${count} of ${cap} in flight`;
  // wipCap's own message ends in its own verdict against the cap, which
  // leaves out the builds with no pull request; only its counts are quoted.
  const g = decision.groups;
  const detail = `${ids.length ? `in flight: ${ids.join(', ')}` : 'nothing in flight'} `
    + `(${freshBuilds.length} building with no pull request yet). `
    + `Open pull requests: ${decision.openCount}, of which ${decision.inProgress} count (ticket building or in review); `
    + `not counted: ${decision.operatorHeld} waiting on ${operatorName()}, ${decision.stranded} whose build pass died, `
    + `${decision.rework} in rework, ${g.queued.length} queued, ${g.live.length} already live, `
    + `${g.unknown.length} with no ticket found, ${g.unrecognised.length} in a status not recognised.`;
  return { code: full ? 3 : 0, full, count, cap, ids, line, detail };
}

/** The verdict when the facts could not be read: the pass goes on, and says so. */
function unknownVerdict(why) {
  return {
    code: 1,
    full: null,
    line: `could not tell how many tickets are in flight (${why}), so the work-in-progress cap was NOT applied: the pass goes on without it.`,
  };
}

module.exports = { CAP_SETTING, capInForce, wipCheckVerdict, unknownVerdict };
