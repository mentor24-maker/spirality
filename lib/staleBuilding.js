'use strict';

/**
 * A TICKET LEFT IN BUILDING BY A PASS THAT IS GONE (SP-101).
 *
 * On 2026-11-02 the build pass that claimed SP-92 stopped about a minute
 * later: no report, no END line in the log, a worktree with uncommitted edits
 * and no branch pushed. Nothing claims from "Building", and every pass after
 * it read the ticket as "another pass is building this" (the skill's
 * one-claimant rule) and left it alone, for a day, until a hand-run session
 * moved it back.
 *
 * So each build pass, before it claims, asks three questions about every
 * ticket in "Building", from facts it already has:
 *
 *   1. Is another build pass running? The runner's lock
 *      (`$LOG_DIR/$SLUG-loop-build.lock`, scripts/loop_runner.sh) holds the
 *      pid of the one runner. The runner is a serial `while true` loop, so a
 *      pass started BY that runner proves the runner's previous pass ended;
 *      a lock held by a live runner this pass is NOT under means a build
 *      pass may be running right now, and nothing is touched.
 *   2. Has the ticket reached a pull request? A `PR opened:` line means the
 *      work exists and is recorded; that is a stall of a different kind,
 *      never a re-queue.
 *   3. Has nothing happened on it for longer than the limit? This is the
 *      guard for a person's hand-run session, which holds no lock.
 *
 * Only when all three say "abandoned" is the ticket moved back to "Queued",
 * guarded on "Building", with one note. Nothing is ever deleted: the note
 * names the worktrees that look like the dead pass's, and they stay.
 *
 * The fail-safe direction, as in passClaim.js: a ticket repaired a pass late
 * is visible in the queue; a ticket built twice is silent and expensive. So
 * every reading that cannot be taken ("could not tell") leaves it alone.
 */

const path = require('node:path');
const { STRANDED_AFTER_MS } = require('./pipelinePause.js');

/**
 * How long a "Building" ticket may sit untouched before it counts as
 * abandoned. The ticket proposed 60 minutes "unless the code shows a better
 * number", and it does: pipelinePause's ninety minutes is already this
 * system's answer to "how long may a pass hold a ticket before it is
 * stranded rather than busy", and passClaim.js borrows it for the same
 * reason. One definition, not two free to drift.
 */
const ABANDONED_AFTER_MS = STRANDED_AFTER_MS;

/** The skill whose lock is read. The runner names its lock after the skill. */
const BUILD_SKILL = 'loop-build';

/** The runner's lock folder, built the way scripts/loop_runner.sh builds it. */
function buildLockPath({ logDir, productSlug, home = '' }) {
  const dir = String(logDir || '').replace(/^~(?=\/|$)/, home);
  return path.join(dir, `${productSlug}-${BUILD_SKILL}.lock`);
}

/**
 * What the lock says about other build passes.
 *
 *   free        no lock, or a lock whose pid is gone: no runner is running.
 *   ours        the lock's pid is an ancestor of this process: this pass IS
 *               the runner's pass, so its previous pass has ended.
 *   held        a live process this pass is not under holds it: a build pass
 *               may be running. Leave every ticket alone.
 *   unreadable  a lock exists and its pid could not be read. Could not tell.
 *
 * @param {{ exists: boolean, pid: string|null, alive: boolean, ancestors: number[] }} reading
 */
function lockState({ exists, pid, alive, ancestors = [] } = {}) {
  if (!exists) return { state: 'free', why: 'no build runner holds the lock' };
  const n = Number(String(pid ?? '').trim());
  if (!Number.isInteger(n) || n <= 0) {
    return { state: 'unreadable', why: 'the build lock exists but names no readable pid' };
  }
  if (ancestors.map(Number).includes(n)) {
    return { state: 'ours', why: `this pass runs under the build runner (pid ${n}), so its previous pass has ended` };
  }
  if (!alive) return { state: 'free', why: `the build lock names pid ${n}, which is no longer running` };
  return { state: 'held', why: `a build runner (pid ${n}) is running and this pass is not under it` };
}

/** "1.5 hours", "45 min" — the register the operator reads. */
function humanMs(ms) {
  const mins = Math.round(Number(ms) / 60000);
  if (!Number.isFinite(mins)) return 'an unknown time';
  if (mins < 90) return `${mins} min`;
  return `${(mins / 60).toFixed(1)} hours`;
}

/**
 * One ticket: put it back, or leave it, and why.
 *
 * @param {object} p
 * @param {string} p.status       the ticket's status as read now
 * @param {{state: string, why: string}} p.lock   lockState's answer
 * @param {boolean|null} p.hasPr  a `PR opened:` line is on it; null = comments unreadable
 * @param {number} p.updatedMs    the ticket's last change
 * @param {number} p.nowMs
 * @param {number} [p.limitMs]
 * @returns {{ action: 'requeue'|'leave'|'cannot-tell', reason: string, ageMs?: number }}
 */
function staleDecision({ status, lock, hasPr, updatedMs, nowMs = Date.now(), limitMs = ABANDONED_AFTER_MS } = {}) {
  if (String(status || '').trim().toLowerCase() !== 'building') {
    return { action: 'leave', reason: `it is "${status || '?'}", not "Building"` };
  }
  if (!lock || lock.state === 'unreadable') {
    return { action: 'cannot-tell', reason: lock ? lock.why : 'the build lock was not read' };
  }
  if (lock.state === 'held') return { action: 'leave', reason: lock.why };
  if (hasPr == null) return { action: 'cannot-tell', reason: 'its comments could not be read, so a recorded PR cannot be ruled out' };
  if (hasPr) return { action: 'leave', reason: 'it has a "PR opened:" line, so its work is recorded' };
  const updated = Number(updatedMs);
  if (!Number.isFinite(updated) || updated <= 0) {
    return { action: 'cannot-tell', reason: 'its last change carries no readable time' };
  }
  const age = Number(nowMs) - updated;
  // A time in the future reads as young: the direction that leaves work alone.
  if (!(age > Number(limitMs))) {
    return { action: 'leave', ageMs: age, reason: `it last changed ${humanMs(Math.max(age, 0))} ago, inside the ${humanMs(limitMs)} limit` };
  }
  return {
    action: 'requeue',
    ageMs: age,
    reason: `no build pass is on it (${lock.why}), no PR is recorded, and nothing has changed on it for ${humanMs(age)}`,
  };
}

/**
 * How soon after its claim a pass makes its worktree. Step 2 of the skill,
 * right after the claim: minutes, not an hour. Measured on SP-92's 2026-11-02
 * pass, a window up to the 90-minute limit also caught three unrelated
 * worktrees made 50 to 89 minutes later by other passes.
 */
const WORKTREE_WINDOW_MS = 20 * 60 * 1000;

/**
 * The worktrees that look like the dead pass's: made from just before the
 * ticket's last change (the claim, when nothing touched it since) to
 * WORKTREE_WINDOW_MS after it, on a branch that never reached the remote. A
 * guess, and the note says so; nothing is deleted on its strength.
 *
 * @param {Array<{ path: string, branch: string, createdMs: number, pushed: boolean, dirty: boolean }>} worktrees
 */
function leftoverWorktrees(worktrees, { updatedMs, windowMs = WORKTREE_WINDOW_MS, slackMs = 5 * 60 * 1000 } = {}) {
  const from = Number(updatedMs) - slackMs;
  const to = Number(updatedMs) + Number(windowMs);
  return (Array.isArray(worktrees) ? worktrees : []).filter((w) => {
    const at = Number(w.createdMs);
    return Number.isFinite(at) && at >= from && at <= to && !w.pushed;
  });
}

/**
 * The one note on the ticket. `when` is the last change, already written in
 * Mountain time by the caller.
 */
function requeueNote({ when, reason, leftovers = [] }) {
  const lines = [
    `Put back in Queued: this ticket sat in Building with nothing building it. It last changed ${when} MT (the claim, unless something touched it after).`,
    `Why: ${reason}.`,
  ];
  if (leftovers.length) {
    lines.push('Left over from that pass, maybe (made around the claim, never pushed):');
    for (const w of leftovers) {
      lines.push(`- worktree ${w.path}, branch ${w.branch || '(detached)'}${w.dirty ? ', with uncommitted edits' : ''}`);
    }
  } else {
    lines.push('No unpushed worktree from around the claim time was found.');
  }
  lines.push('Nothing was deleted: no worktree, no branch. The next build pass claims this ticket afresh.');
  return lines.join('\n');
}

module.exports = {
  ABANDONED_AFTER_MS,
  WORKTREE_WINDOW_MS,
  BUILD_SKILL,
  buildLockPath,
  lockState,
  staleDecision,
  leftoverWorktrees,
  requeueNote,
  humanMs,
};
