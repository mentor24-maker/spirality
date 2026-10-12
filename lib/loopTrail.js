'use strict';

/**
 * loopTrail — the two written traces the loop leaves on a ticket, and the
 * checks that they actually got left.
 *
 * WHY THIS EXISTS (2026-08-22, task 86bbjt18r). Merge-on-comment works, but
 * draining the Ready-to-launch backlog on 2026-08-22 found two ways an
 * approved ticket stalls that have nothing to do with judgement:
 *
 *   - Four tickets had no `PR opened:` comment at all, so the merge step
 *     correctly refused to guess which PR it was about. Two of those PRs also
 *     carried no ClickUp link in their body, so the ticket and its PR could
 *     only be matched by reading titles. The audit trail broke in BOTH
 *     directions at once.
 *   - Two tickets sat in `Ready to launch` — the operator's "safe to merge"
 *     signal — with no passing review verdict recorded on them. He approved
 *     both in good faith. A ticket reaching that status unreviewed is worse
 *     than a ticket stuck.
 *
 * The common cause is that both traces were prose in a skill file: a step
 * that says "add a ClickUp comment with the PR URL" is followed most of the
 * time, and nothing notices the times it is not. So both are commands now
 * (`clickup pr-opened`, `clickup verdict`), each writing a shape this module
 * defines and reading it back through the SAME parser the consumer uses —
 * `mergeOnComment.findPullRequest` and `mergeOnComment.isReviewPassed`. A
 * comment that the merge step could not act on is a comment this module
 * refuses to call written.
 */

const { findPullRequest, isReviewVerdict, isReviewPassed } = require('./mergeOnComment.js');
const { bodyNamesTicket } = require('./clickupTicketLink.js');

/** The one shape `mergeOnComment.findPullRequest` will find. */
function prOpenedComment(prUrl, extra) {
  const tail = String(extra || '').trim();
  return `PR opened: ${prUrl}${tail ? `\n\n${tail}` : ''}`;
}

/**
 * The one shape `mergeOnComment.isReviewPassed` will accept as a PASS.
 *
 * The send-back names `Rework` since 2026-08-31 (task 86bbr1u9v) — that is
 * where a send-back goes now, and a verdict that says "sent back to Queued"
 * while the ticket sits in `Rework` is a trail that contradicts the board.
 * Both readers are wording-agnostic (`REVIEW\b` for a verdict, `REVIEW:
 * PASSED` for a pass, both line-anchored in mergeOnComment.js), so the older
 * `sent back to Queued` comments already on live tickets keep counting as the
 * send-backs they are — which matters, because `sendBackRounds` counts them to
 * decide when a fourth round escalates to Dane instead.
 */
function verdictComment(passed, note) {
  const tail = String(note || '').trim();
  const head = passed
    ? 'REVIEW: PASSED'
    : 'REVIEW: sent back to Rework';
  return `${head}${tail ? ` — ${tail}` : ''}`;
}

/**
 * Can this ClickUp response even ANSWER "is the trail already here"?
 *
 * WHY THIS IS SEPARATE FROM prTrailLanded (2026-08-31, task 86bbq7z1k, round 3).
 * The `--if-missing` preflight read `json.comments || []`, so a 200 whose body
 * carried no `comments` list collapsed to an empty array — indistinguishable
 * from a ticket that genuinely has no trail on it. The guard then wrote, which
 * is a DUPLICATE `PR opened:` line: precisely what `--if-missing` exists to
 * prevent (acceptance criterion 2). An idempotence guard that cannot read fails
 * OPEN, which is the wrong direction; a duplicate is permanent and confusing,
 * while refusing costs one re-run.
 *
 * Observed live on this very ticket: two identical `pr-opened --if-missing`
 * calls eleven minutes apart, the first skipping correctly and the second
 * posting a second line. The one-off itself could not be reproduced — repeated
 * polling and a post-then-read-immediately probe both came back consistent — so
 * this is not a claim about what happened. It is the only path in the command
 * that turns a healthy-looking response into that exact symptom, and it should
 * not exist either way (DOCTRINE 3.11: a check that could not run never reports
 * a pass).
 *
 * An EMPTY array is readable and means "no trail" — that is a real answer, and
 * a ticket with no comments must still be writable. Only a missing or non-array
 * `comments` is CANNOT TELL.
 */
function commentsReadable(json) {
  return Array.isArray(json && json.comments);
}

/**
 * Did the `PR opened:` comment land in a form the merge step can use? Takes
 * the ticket's comments as read back from ClickUp, and the PR number that
 * was supposed to be recorded. Deliberately checks the NUMBER and not merely
 * "some PR line exists": a ticket rebuilt onto a second PR whose new comment
 * silently failed would otherwise verify against the old one.
 */
function prTrailLanded(comments, prNumber) {
  const found = findPullRequest(comments);
  if (!found) {
    return { ok: false, why: 'no "PR opened: <url>" line is readable on the ticket' };
  }
  if (Number(found.number) !== Number(prNumber)) {
    return {
      ok: false,
      why: `the newest "PR opened:" line on the ticket points at PR #${found.number}, not #${prNumber}`,
    };
  }
  return { ok: true, why: '', pr: found };
}

/**
 * Does the PR body carry its ClickUp ticket?
 *
 * A full `app.clickup.com/t/<id>` link is required. It used to accept a bare
 * id as well, and that was the one place this command disagreed with the
 * review gate, which has always required the URL: `ClickUp: 86bbjt18r` passed
 * here and was then refused by the gate with "the PR body carries no ClickUp
 * ticket link" (task 86bbmmv7t, finding 2). Both now read the SAME matcher, so
 * the disagreement cannot come back — the reasoning for settling it on the URL
 * is in `clickupTicketLink.js`.
 */
function prBodyCarriesTicket(body, taskId, taskUrl) {
  return bodyNamesTicket(body, taskId, taskUrl);
}

/**
 * May this ticket move to `Ready to launch`?
 *
 * That status means one thing to the operator: loop-review checked this and
 * it is safe to merge. So the gate is exactly the precondition the merge
 * step already applies — the NEWEST review verdict on the ticket must be a
 * PASS. Anything else (no verdict at all, or a send-back as the last word)
 * is refused, because promoting it puts a ticket in his inbox wearing a
 * badge that says "reviewed" when nothing reviewed it.
 *
 * Comments may arrive in any order; newest-first is imposed here rather than
 * assumed, for the same reason mergeDecision does it.
 */
function readyToLaunchGate(comments) {
  const sorted = (comments || [])
    .slice()
    .sort((a, b) => (Number(b && b.date) || 0) - (Number(a && a.date) || 0));
  const verdict = sorted.find((c) => isReviewVerdict(c && c.comment_text));
  if (!verdict) {
    return {
      ok: false,
      why: 'no review verdict has been recorded on this ticket — loop-review has not passed it',
    };
  }
  if (!isReviewPassed(verdict.comment_text)) {
    return {
      ok: false,
      why: 'the most recent review verdict on this ticket is not a PASS',
    };
  }
  return { ok: true, why: '', verdictId: String(verdict.id) };
}

/** Is this the status the gate above guards? */
function isReadyToLaunch(status) {
  return String(status || '').trim().toLowerCase() === 'ready to launch';
}

module.exports = {
  prOpenedComment,
  verdictComment,
  commentsReadable,
  prTrailLanded,
  prBodyCarriesTicket,
  readyToLaunchGate,
  isReadyToLaunch,
};
