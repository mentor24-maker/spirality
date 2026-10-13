'use strict';

/**
 * clickupTicketLink — what counts as "this PR names its ticket", defined ONCE.
 *
 * WHY THIS FILE EXISTS (2026-08-26, task 86bbmmv7t, finding 2). Two readers
 * answered that question and they did not agree. `pr-opened` accepted a bare
 * task id — `ClickUp: 86bbjt18r` — and let the PR through; the review gate
 * required a full `app.clickup.com/t/<id>` URL and refused the same body with
 * "the PR body carries no ClickUp ticket link". The failure direction was safe
 * (it refused rather than passed), but once the gate is REQUIRED it strands a
 * PR that the command which checked it calls traceable, with a message saying
 * the opposite of what the reader can plainly see in the body.
 *
 * The disagreement was possible only because each side had its own matcher. So
 * there is one matcher now, here, and both sides import it — the same shape
 * the verdict parser already uses (`mergeOnComment.isReviewPassed`, imported by
 * the gate and by `loopTrail` rather than re-implemented in either).
 *
 * WHICH WAY THE DISAGREEMENT WAS SETTLED: the **full URL wins**, and a bare id
 * is no longer enough. Two reasons, in order of weight:
 *
 *   1. A bare id cannot be recognised safely. Ids are lowercase alphanumeric
 *      (`86bbmmv7t`), which is also the shape of an abbreviated commit sha, a
 *      build hash, and half the tokens in a stack trace. Matching them in prose
 *      means either false positives or a workspace-specific prefix rule — and a
 *      matcher that fails OPEN on a coincidence is the worse of the two errors,
 *      because it certifies a PR as traceable to a ticket nobody can open.
 *   2. The URL is what the reader needs anyway. A link in a PR body is one
 *      click; an id is a copy, a paste and a search. `loop-build` step 7 has
 *      always asked for the URL on a line of its own, so this makes the
 *      shipped rule match the written one rather than the other way round.
 *
 * Both live URL shapes are accepted: the plain `app.clickup.com/t/<id>` form
 * the loop writes, and the `t/<workspace>/<id>` form ClickUp's own "copy link"
 * button produces. Ids are alphanumeric and workspace segments are all digits,
 * so the two are told apart by shape rather than by position.
 */

const CLICKUP_LINK_RE = /https?:\/\/app\.clickup\.com\/t\/(?:\d+\/)?([a-z0-9]+)/i;

/** Every ticket a body links to, in the order they appear, lowercased. */
function findTicketIds(prBody) {
  const all = String(prBody || '').match(new RegExp(CLICKUP_LINK_RE, 'gi')) || [];
  return all
    .map((link) => {
      const m = CLICKUP_LINK_RE.exec(link);
      return m ? m[1].toLowerCase() : '';
    })
    .filter(Boolean);
}

/**
 * The ticket id a PR body points at, or '' if it points at none.
 *
 * This is the FIRST link in the body, which is a convention and not a fact —
 * see `reviewGate.ticketNamesThisPr` for the check that confirms the ticket it
 * lands on is actually this PR's own.
 */
function findTicketId(prBody) {
  const m = CLICKUP_LINK_RE.exec(String(prBody || ''));
  return m ? m[1] : '';
}

/**
 * Does this body link to THIS ticket? Accepts the task id, the task URL, or
 * both; a body that links to some other ticket does not count, which is the
 * case that let two PRs ship on 2026-08-22 pairable only by their titles.
 */
function bodyNamesTicket(body, taskId, taskUrl) {
  const wanted = String(taskId || '').trim().toLowerCase()
    || findTicketId(taskUrl).toLowerCase();
  if (!wanted) return false;
  return findTicketIds(body).includes(wanted);
}

module.exports = {
  CLICKUP_LINK_RE,
  findTicketId,
  findTicketIds,
  bodyNamesTicket,
};
