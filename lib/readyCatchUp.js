'use strict';

/**
 * readyCatchUp — after every merge, keep each pull request waiting in
 * `Ready to launch` current with `main`, or file its fix-up at once.
 *
 * WHY THIS EXISTS (SP-294, 2026-11-13). `main-moved` (mainMoved.js) tells the
 * tickets in Building, In review and Rework that `main` moved. It never looks
 * at `Ready to launch`, because that is Dane's status. So a pull request
 * waiting for his word went stale silently, and the conflict surfaced only
 * when he said merge: "MERGE NOT DONE … conflict", then the catch-up ticket,
 * then another build and review. Since 10/29 that happened to 70 of the 281
 * pull requests that went live (25%). His merge wait has a median of 44
 * minutes but a p90 of 8.6 hours, so starting the fix at his word threw that
 * head start away. Dane's words: "We need a way for the system to update
 * tasks in flight so they don't try to merge a PR that is bound to fail."
 *
 * WHAT IT DOES, per `Ready to launch` ticket whose recorded PR is open against
 * the same base and does not already hold the merge:
 *
 *   merges cleanly (no-overlap or same-files, by `git merge-tree`)
 *       catch the branch up now, through GitHub (`gh pr update-branch`: an
 *       ordinary merge of `main` into the branch, never a force push), so CI
 *       re-runs and the PR is current and green when he says merge. No
 *       comment is written: his inbox is not a log. Skipped while a catch-up
 *       ticket for that PR is still being worked (its builder owns the branch).
 *   conflicts
 *       file the catch-up ticket now, the same `CONFLICT TICKET FILED`
 *       mechanism the merge step uses at his word (conflictWork.js), so the
 *       build loop starts on it while he has not yet looked. That writes one
 *       `CONFLICT TICKET FILED:` comment on his ticket, which the merge step
 *       reads to find the filing and never file a second.
 *   cannot tell
 *       nothing is done to the branch, and the pass reports it. His merge
 *       word still meets the existing merge step, as before.
 *
 * RULES IT KEEPS.
 *   - It moves no status. No loop takes a ticket out of `Ready to launch`.
 *   - It never resolves a conflict. A branch that conflicts is not touched.
 *   - It respects the merge window (mergeWindowLease.js): while another pull
 *     request holds it, no branch is caught up this time; a window that
 *     cannot be read is reported, never taken as "held". It does not TAKE
 *     the window, because a `Ready to launch` PR lands only on Dane's word,
 *     so a hold would sit for the full 45 minutes and stop every other merge.
 *     A catch-up pushes to its own branch only; it cannot put any other
 *     branch behind, which is the thing the window exists to prevent.
 *   - His merge word, if already given, still stands: catching the branch up
 *     is the move the merge step would make itself, and a filed ticket is the
 *     one the merge step reads back and does not file twice.
 *   - Each ticket is re-read right before anything is done, and skipped
 *     unless it is still in `Ready to launch`.
 *
 * NEVER THROWS PAST ONE TICKET: the relay runs this after a merge it has
 * already recorded, so a failure on one ticket goes into `problems` and the
 * next ticket is still looked at. Every read and write is passed in, so each
 * rule is tested without the tracker, GitHub or git.
 */

const { READY_TO_LAUNCH, statusOf } = require('./loopStatuses.js');
const { KINDS } = require('./mainMoved.js');

const isReady = (status) => statusOf(String(status || '')) === READY_TO_LAUNCH;

/**
 * @param tasks   the list's tickets as last read (filtered here)
 * @param merge   { number, url, oid } the PR that just merged
 * @param base    the branch it merged into
 * @param repo    "owner/name" of the project's repository
 * @param openPrs Map PR number -> head branch, open against `base`
 * @param io.readComments (id) -> { comments } | { problem }
 * @param io.readStatus   (id) -> status string, or null when unreadable
 * @param io.findPullRequest (comments) -> { owner, repo, number } | null
 * @param io.contains     ({ branch }) -> true | false | null
 * @param io.check        ({ branch }) -> mainMoved verdict { kind, files, reason }
 * @param io.catchUpBeingWorked ({ comments, prNumber }) -> null when no catch-up
 *        ticket for that PR is in a worked status (Queued, Building, Rework,
 *        In review); { id, status } when one is; { id, cannotTell: true }
 *        when the one on file could not be read
 * @param io.window       ({ pr }) -> windowDecision result ({ action, cannotTell, reason })
 * @param io.updateBranch (prNumber) -> { ok, why }
 * @param io.fileConflict ({ task, comments, pr, branch, verdict }) ->
 *        { ok, filed: { id }, already: boolean, problem }
 * @returns {{ lines: string[], problems: string[], caughtUp: number, filed: number }}
 */
async function catchUpReadyTickets({ tasks, merge, base, repo, openPrs, dryRun, io }) {
  const lines = [], problems = [];
  let caughtUp = 0, filed = 0;
  for (const t of (tasks || []).filter((x) => isReady(x?.status?.status ?? x?.status))) {
    const line = (pr, what) => lines.push(`${t.id}\t${pr}\t${what}\t${t.name}`);
    try {
      const read = await io.readComments(t.id);
      if (!read.comments) { problems.push(`${t.id}: its comments could not be read (${read.problem}) — not checked against PR #${merge.number}`); line('-', 'NOT checked — comments unreadable'); continue; }
      const found = io.findPullRequest(read.comments);
      if (!found || `${found.owner}/${found.repo}`.toLowerCase() !== String(repo).toLowerCase()) { line('-', 'no PR of this repository recorded — nothing to catch up'); continue; }
      const prRef = `PR #${found.number}`;
      if (found.number === merge.number) continue;
      const branch = openPrs.get(found.number);
      if (!branch) { line(prRef, `not open against ${base} — nothing to catch up`); continue; }
      if (io.contains({ branch }) === true) { line(prRef, `already contains PR #${merge.number} — current`); continue; }

      const verdict = io.check({ branch });
      const what = `${verdict.kind}${verdict.files.length ? ` (${verdict.files.join(', ')})` : ''}${verdict.reason ? ` — ${verdict.reason}` : ''}`;
      if (verdict.kind === KINDS.CANNOT_TELL) {
        problems.push(`${t.id}: ${prRef} could not be checked against PR #${merge.number} (${verdict.reason}) — not caught up and nothing filed; his merge word meets the merge step as before`);
        line(prRef, `NOT caught up — ${what}`);
        continue;
      }
      const conflict = verdict.kind === KINDS.CONFLICT;
      // A catch-up ticket still being worked owns the branch: a GitHub merge
      // commit pushed under its builder rejects their next push and moves the
      // head their reviewer checks, and a half-pushed resolution can make
      // merge-tree say clean. So the clean path leaves it alone.
      if (!conflict) {
        const work = await io.catchUpBeingWorked({ comments: read.comments, prNumber: found.number });
        if (work?.cannotTell) {
          problems.push(`${t.id}: ${prRef} has catch-up ticket ${work.id} on file whose status could not be read — not caught up, so a builder there is not pushed under`);
          line(prRef, `NOT caught up — catch-up ticket ${work.id} unreadable`);
          continue;
        }
        if (work) { line(prRef, `not caught up — catch-up ticket ${work.id} is in ${work.status}, and its builder owns the branch`); continue; }
      }
      if (dryRun) { line(prRef, conflict ? `would file its catch-up ticket: ${what}` : `would catch it up: ${what}`); continue; }

      const now = await io.readStatus(t.id);
      if (now == null) { problems.push(`${t.id}: could not be re-read before acting — ${prRef} left as it is`); line(prRef, 'NOT acted on — ticket unreadable'); continue; }
      if (!isReady(now)) { line(prRef, `moved to ${now} since the list was read — left alone`); continue; }

      if (conflict) {
        const out = await io.fileConflict({ task: t, comments: read.comments, pr: { number: found.number, url: found.url }, branch, verdict });
        if (!out.ok) { problems.push(`${t.id}: ${prRef} conflicts with PR #${merge.number}, and its catch-up ticket was NOT filed (${out.problem}) — his merge word files it, as before`); line(prRef, `conflict — catch-up ticket NOT filed: ${out.problem}`); continue; }
        if (!out.already) filed += 1;
        line(prRef, `conflict — catch-up ticket ${out.filed.id} ${out.already ? 'already on file' : 'filed'}: ${what}`);
        continue;
      }

      const win = io.window({ pr: found.number });
      if (win.action === 'blocked' && win.cannotTell) {
        // A lease that cannot be read would otherwise switch this off for good, silently.
        problems.push(`${t.id}: ${prRef} not caught up — the merge window could not be read (${win.reason})`);
        line(prRef, `NOT caught up — merge window unreadable: ${win.reason}`);
        continue;
      }
      if (win.action === 'blocked') { line(prRef, `not caught up this time — ${win.reason}`); continue; }
      const upd = io.updateBranch(found.number);
      if (!upd.ok) { problems.push(`${t.id}: ${prRef} merges cleanly with PR #${merge.number} but could not be caught up (${upd.why}) — his merge word catches it up, as before`); line(prRef, `NOT caught up — ${upd.why}`); continue; }
      caughtUp += 1;
      line(prRef, `caught up: ${what}; its checks re-run`);
    } catch (err) {
      problems.push(`${t.id}: ${err?.message || err} — not checked against PR #${merge.number}`);
      line('-', 'NOT checked — the step failed on this ticket');
    }
  }
  return { lines, problems, caughtUp, filed };
}

module.exports = { catchUpReadyTickets };
