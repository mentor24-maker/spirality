/**
 * The two traces a ticket must carry, and the readers that check them.
 *
 *   PR opened: <url>              written by loop-build (`pr-opened`)
 *   REVIEW: PASSED — <why>        written by loop-review (`verdict --pass`)
 *   REVIEW: sent back to Rework — <why>              (`verdict --fail`)
 *
 * One writer and one reader per shape, in this file, so the text a command
 * writes and the text the gate reads can never drift apart. Adapted from
 * StarCaster's loopTrail.js and mergeOnComment.js.
 */

import { isMachineComment } from './machineComment.mjs';

export const ESCALATE_AT_ROUND = 4;

const PR_LINE = /PR opened:\s*(https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+))/i;
const VERDICT_LINE = /^\s*REVIEW:\s*(PASSED|sent back to Rework)\b/i;

export function prOpenedComment(prUrl, extra) {
  const tail = String(extra || '').trim();
  return `PR opened: ${prUrl}${tail ? `\n\n${tail}` : ''}`;
}

export function verdictComment(passed, note) {
  const tail = String(note || '').trim();
  const head = passed ? 'REVIEW: PASSED' : 'REVIEW: sent back to Rework';
  return `${head}${tail ? ` — ${tail}` : ''}`;
}

export function commentsReadable(json) {
  return Array.isArray(json && json.comments);
}

/** Newest first, by ClickUp's millisecond date. */
export function newestFirst(comments) {
  return (comments || []).slice().sort((a, b) => (Number(b && b.date) || 0) - (Number(a && a.date) || 0));
}

/** The newest "PR opened:" line on a ticket, parsed. */
export function findPullRequest(comments) {
  for (const c of newestFirst(comments)) {
    const m = PR_LINE.exec(String((c && c.comment_text) || ''));
    if (m) return { url: m[1], owner: m[2], repo: m[3], number: Number(m[4]), commentId: String(c.id) };
  }
  return null;
}

export function prTrailLanded(comments, prNumber) {
  const found = findPullRequest(comments);
  if (!found) return { ok: false, why: 'no "PR opened: <url>" line is readable on the ticket' };
  if (Number(found.number) !== Number(prNumber)) {
    return { ok: false, why: `the newest "PR opened:" line on the ticket points at PR #${found.number}, not #${prNumber}` };
  }
  return { ok: true, why: '', pr: found };
}

/** Does a PR body link back to its ticket? Accepts /t/<id> and /t/<workspace>/<id>. */
export function bodyNamesTicket(body, taskId) {
  const id = String(taskId || '').trim();
  if (!id) return false;
  const re = new RegExp(`app\\.clickup\\.com/t/(?:\\d+/)?${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'i');
  return re.test(String(body || ''));
}

export function isReviewVerdict(text) {
  return VERDICT_LINE.test(String(text || ''));
}

export function isReviewPassed(text) {
  const m = VERDICT_LINE.exec(String(text || ''));
  return Boolean(m && /^passed$/i.test(m[1]));
}

/** Ready to launch is refused unless the NEWEST verdict on the ticket is a PASS. */
export function readyToLaunchGate(comments) {
  const verdict = newestFirst(comments).find((c) => isReviewVerdict(c && c.comment_text));
  if (!verdict) {
    return { ok: false, why: 'no review verdict has been recorded on this ticket — loop-review has not passed it' };
  }
  if (!isReviewPassed(verdict.comment_text)) {
    return { ok: false, why: 'the most recent review verdict on this ticket is not a PASS' };
  }
  return { ok: true, why: '', verdictId: String(verdict.id) };
}

/** How many send-backs the ticket already carries. */
export function sendBackRounds(comments) {
  return (comments || []).filter((c) => isReviewVerdict(c && c.comment_text) && !isReviewPassed(c.comment_text)).length;
}

/** The round number the NEXT send-back would be. */
export function nextRound(comments) {
  return sendBackRounds(comments) + 1;
}

/** Three send-backs mean the spec is wrong, not the build: a fourth goes to Dane. */
export function wouldEscalate(comments) {
  return nextRound(comments) >= ESCALATE_AT_ROUND;
}

/** One line per earlier send-back, for the escalation card. */
export function roundSummaryLines(comments) {
  const sent = newestFirst(comments).filter((c) => isReviewVerdict(c && c.comment_text) && !isReviewPassed(c.comment_text)).reverse();
  return sent.map((c, i) => {
    const text = String(c.comment_text || '').replace(/^\s*REVIEW:\s*sent back to Rework\s*(—|-)?\s*/i, '').split('\n')[0].trim();
    return `round ${i + 1}: ${text || '(no reason recorded)'}`;
  });
}

/**
 * Is the newest comment on the ticket Dane's own word? The loops post under
 * his seat, so authorship alone cannot answer it: a comment carrying the
 * machine marker is a loop's, whatever account posted it.
 */
export function operatorSpokeLast(comments, operatorId) {
  const newest = newestFirst(comments)[0];
  if (!newest) return false;
  if (isMachineComment(newest.comment_text)) return false;
  return String(newest.user && newest.user.id) === String(operatorId);
}
