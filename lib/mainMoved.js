'use strict';

/**
 * mainMoved — telling every ticket still in flight that `main` just moved
 * under it, and whether that matters to its own branch.
 *
 * WHY THIS EXISTS (2026-10-27, task 86bctjffu). Two tickets claimed close
 * together branch from the same `main`. When the first merges, the second
 * finds out only when review merges `main` in, or when the relay refuses
 * Dane's merge word for a conflict — and then it goes back through a whole
 * build and review cycle. Dane's words: "Is there any way to telegraph the
 * fact that the original state has changed so it doesn't have to wait to test
 * it, then get rejected, then have to go through the whole process."
 *
 * So after every merge, each open ticket in a machine status (Building,
 * In review, Rework) gets one note saying which of four things is true:
 *
 *   no-overlap   the merge touched none of this branch's files and git merges
 *                the two cleanly — nothing to do now
 *   same-files   it touched some of the same files but still merges cleanly —
 *                merge `main` in and re-run verify before review
 *   conflict     merging `main` in now conflicts, in the files named
 *   cannot-tell  the check could not run — treated as same-files, never as clean
 *
 * HOW THE CHECK WORKS. `git merge-tree --write-tree` does the merge in memory
 * and prints the result: no checkout, no worktree, nothing pushed, so it is
 * safe to run from the relay's own main checkout. It answers right after a
 * merge, where GitHub's mergeability lags for minutes (see branchCatchUp.js).
 * Its exit code alone is not enough: it exits 1 BOTH for a conflict and for a
 * branch it cannot find. A conflict prints the merged tree's id first; an
 * error prints nothing to stdout. That difference is the only thing this
 * module accepts as a conflict.
 *
 * WHAT THIS IS NOT. It moves no status and resolves nothing. Dane's two
 * statuses are not told: a `Ready to launch` ticket's conflict is the merge
 * step's job (conflictWork.js), and his inbox is not a log.
 */

const { spawnSync } = require('node:child_process');
const { REWORK, BUILDING, IN_REVIEW } = require('./loopStatuses.js');

const KINDS = Object.freeze({
  NO_OVERLAP: 'no-overlap',
  SAME_FILES: 'same-files',
  CONFLICT: 'conflict',
  CANNOT_TELL: 'cannot-tell',
});

/** The statuses that are told. Each is a machine's, with a branch that may exist. */
const NOTIFY_STATUSES = Object.freeze([BUILDING, IN_REVIEW, REWORK]);

/**
 * The ONE shape a note is recorded in and read back from — the writer and the
 * reader share this, as `CONFLICT TICKET FILED:` does in conflictWork.js. The
 * pair of PR numbers is the duplicate guard: one note per merge per PR.
 */
const MAIN_MOVED_TRAIL = 'MAIN MOVED:';
const MAIN_MOVED_RE = /^MAIN MOVED:\s*PR\s*#(\d+)\s*->\s*PR\s*#(\d+)\s*—\s*(no-overlap|same-files|conflict|cannot-tell)\b/im;

function defaultRunGit(args, { cwd } = {}) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    ok: out.status === 0,
    status: out.status,
    stdout: String(out.stdout || '').trim(),
    stderr: String(out.stderr || '').trim(),
  };
}

const lines = (text) => String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Is this ticket one that gets told? */
function isNotifyTarget(task) {
  const status = String(task?.status?.status ?? task?.status ?? '').trim().toLowerCase();
  return NOTIFY_STATUSES.includes(status);
}

/**
 * Turn what git said into a verdict. Pure: every git answer comes in as an
 * argument, so each rule is tested without a repository.
 *
 * @param mergedFiles the files the merge commit changed, or null if unread
 * @param branchFiles the files the branch changes since it left main, or null
 * @param mergeTree   the `git merge-tree` result ({ status, stdout, stderr }), or null
 * @returns {{ kind, files: string[], reason: string }}
 */
function classify({ mergedFiles, branchFiles, mergeTree }) {
  const cannot = (reason) => ({ kind: KINDS.CANNOT_TELL, files: [], reason });
  if (!Array.isArray(mergedFiles)) return cannot('the files the merge changed could not be read');
  if (!Array.isArray(branchFiles)) return cannot("the branch's own files could not be read");
  if (!mergeTree) return cannot('the in-memory merge did not run');
  const out = lines(mergeTree.stdout);
  if (!OID_RE.test(out[0] || '')) {
    return cannot(`the in-memory merge failed (${String(mergeTree.stderr || '').slice(0, 200) || `exit ${mergeTree.status}`})`);
  }
  if (mergeTree.status === 1) return { kind: KINDS.CONFLICT, files: out.slice(1), reason: '' };
  if (mergeTree.status !== 0) return cannot(`the in-memory merge exited ${mergeTree.status}`);
  const touched = new Set(mergedFiles);
  const overlap = branchFiles.filter((f) => touched.has(f));
  return overlap.length
    ? { kind: KINDS.SAME_FILES, files: overlap, reason: '' }
    : { kind: KINDS.NO_OVERLAP, files: [], reason: '' };
}

/**
 * Ask git about one branch, after the caller has fetched. Three reads, no
 * writes: what the merge commit changed, what the branch changes since it left
 * `base`, and whether the two merge. A read that fails becomes null, which
 * classify() turns into cannot-tell.
 *
 * @param mergeCommit the merged PR's commit on `base` (a squash: one parent)
 */
function checkBranch({ base, branch, mergeCommit, cwd = process.cwd(), runGit = defaultRunGit }) {
  const read = (args) => {
    const res = runGit(args, { cwd });
    return res.ok ? lines(res.stdout) : null;
  };
  const mergedFiles = mergeCommit ? read(['diff', '--name-only', `${mergeCommit}^`, mergeCommit]) : null;
  const branchFiles = read(['diff', '--name-only', `origin/${base}...origin/${branch}`]);
  const mergeTree = runGit(['merge-tree', '--write-tree', '--name-only', '--no-messages', `origin/${base}`, `origin/${branch}`], { cwd });
  return classify({ mergedFiles, branchFiles, mergeTree });
}

const fileList = (files) => files.map((f) => `\`${f}\``).join(', ');

/**
 * The note, marker line first. `merged` is { number, url }; `pr` is the
 * ticket's own open PR { number }.
 */
function mainMovedComment({ merged, pr, base, verdict }) {
  const head = `${MAIN_MOVED_TRAIL} PR #${merged.number} -> PR #${pr.number} — ${verdict.kind}`;
  const what = `\`${base}\` changed under this ticket: PR #${merged.number} (${merged.url}) just merged.`;
  const next = {
    [KINDS.NO_OVERLAP]: `It touched none of the files PR #${pr.number} changes, and git merges the two cleanly. Nothing to do now.`,
    [KINDS.SAME_FILES]: `It changed ${verdict.files.length} file(s) PR #${pr.number} also changes: ${fileList(verdict.files)}. Git still merges them cleanly, but the next pass on this ticket merges \`${base}\` in and re-runs \`npm run verify\` before review.`,
    [KINDS.CONFLICT]: `Merging \`${base}\` into PR #${pr.number} now conflicts${verdict.files.length ? ` in: ${fileList(verdict.files)}` : ''}. The next build pass merges \`${base}\` in and resolves it before review; a review pass sends it straight back to Rework.`,
    [KINDS.CANNOT_TELL]: `The check could not run (${verdict.reason}), so nothing is known either way: treat it as same-files and merge \`${base}\` in before review.`,
  }[verdict.kind];
  return [head, '', what, next, '', '(Automatic — main-moved step.)'].join('\n');
}

function parse(text) {
  const m = MAIN_MOVED_RE.exec(String(text || ''));
  return m ? { merged: Number(m[1]), pr: Number(m[2]), kind: m[3] } : null;
}

const byNewest = (comments) => [...(comments || [])].sort((a, b) => Number(b?.date || 0) - Number(a?.date || 0));

/** The note already written for this merge on this PR, or null. */
function findMainMovedNote(comments, mergedNumber, prNumber) {
  for (const c of byNewest(comments)) {
    const got = parse(c?.comment_text);
    if (got && got.merged === Number(mergedNumber) && got.pr === Number(prNumber)) return { ...got, commentId: String(c.id) };
  }
  return null;
}

/**
 * The newest note about this PR, from any merge: what a build or review pass
 * reads. The newest is enough for a conflict, because every check runs against
 * the `main` of its moment, which holds every earlier merge too.
 */
function latestMainMoved(comments, prNumber) {
  for (const c of byNewest(comments)) {
    const got = parse(c?.comment_text);
    if (got && (prNumber == null || got.pr === Number(prNumber))) return { ...got, commentId: String(c.id) };
  }
  return null;
}

module.exports = {
  KINDS,
  NOTIFY_STATUSES,
  MAIN_MOVED_TRAIL,
  isNotifyTarget,
  classify,
  checkBranch,
  mainMovedComment,
  findMainMovedNote,
  latestMainMoved,
};
