'use strict';

/**
 * WHICH WORKTREES UNDER .claude/worktrees/ CAN GO? (SP-421)
 *
 * Every build pass makes a worktree, and nothing removes one. By 2026-11-27
 * there were about 510 under `.claude/worktrees/`, and the only record of
 * which a dead pass left behind was a note on that pass's ticket
 * (`handbackNote` in lib/passHandback.js). `npm run clickup -- stale-worktrees`
 * lists them all, each with what it belongs to, and flags the ones whose work
 * is finished or abandoned, so a person (or a later ticket) can clean up
 * knowing what each one was.
 *
 * READ-ONLY, ON PURPOSE. This module decides; it runs nothing. The door reads
 * the facts (git's worktree listing, one `gh pr list --state all`, the
 * tickets) and prints. Nothing here, and nothing in the door's branch for it,
 * removes a worktree, deletes a branch or writes to the tracker
 * (staleWorktrees.test.js holds both to that).
 *
 * THE FLAG, one word per worktree:
 *   - STALE: its pull request is merged or closed, or its ticket is Live,
 *     Done or closed, or the ticket sits where nothing builds on this branch
 *     (anything but the statuses in ACTIVE_STATUSES).
 *     A worktree with no pull request whose commit is already on main and
 *     that holds no uncommitted edits is STALE too: a review pass's local
 *     `<branch>-review` checkout is that shape, and so is a dead pass that
 *     never committed anything.
 *   - UNPUSHED: the branch never reached the remote and has no pull request,
 *     the shape a dead pass leaves. A detached worktree has no branch to push,
 *     so it reads the same way, and its line says "(detached)".
 *   - ACTIVE: otherwise, including a worktree whose pull request names no
 *     ticket: "(no ticket)" is never STALE on a guess.
 *   - UNKNOWN: something it needed could not be read; the line says what.
 *     Never STALE: a reading not taken never makes a worktree look safe to
 *     remove.
 */

const { REWORK, BUILDING, IN_REVIEW, READY_TO_LAUNCH, NEEDS_YOUR_INPUT, LIVE, TERMINAL_ALIASES, statusOf } = require('./loopStatuses.js');

/** The ticket statuses in which something still builds on, or waits on, the branch. */
const ACTIVE_STATUSES = Object.freeze([BUILDING, REWORK, IN_REVIEW, READY_TO_LAUNCH, NEEDS_YOUR_INPUT]);

/** The flags, in the order the count line names them. */
const FLAGS = Object.freeze(['STALE', 'UNPUSHED', 'ACTIVE', 'UNKNOWN']);

/** The folder, under the main checkout, that the passes' worktrees live in. */
const WORKTREE_FOLDER = '.claude/worktrees';

/**
 * `git worktree list --porcelain` as a list of `{ path, head, branch, detached }`,
 * in git's order (the main checkout first). Takes the text, so tests pass a
 * fake listing; the door's listWorktrees() (pass-reconcile) reads with it too.
 */
function parseWorktreeList(text) {
  return String(text || '').split(/\n\n+/).map((block) => {
    const e = { path: '', head: '', branch: '', detached: false };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) e.path = line.slice(9);
      else if (line.startsWith('HEAD ')) e.head = line.slice(5);
      else if (line.startsWith('branch ')) e.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (line === 'detached') e.detached = true;
    }
    return e;
  }).filter((e) => e.path);
}

/**
 * The entries that are passes' worktrees: directly under
 * `<main checkout>/.claude/worktrees/`. The main checkout (git lists it
 * first) and anything elsewhere, such as `~/loop-logs/releases/*`, are left
 * out.
 */
function passWorktrees(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return [];
  const root = `${String(list[0].path).replace(/\/+$/, '')}/${WORKTREE_FOLDER}/`;
  return list.slice(1).filter((e) => {
    const p = String(e.path);
    return p.startsWith(root) && p.length > root.length && !p.slice(root.length).includes('/');
  });
}

/** The branch a review pass's `<branch>-review[N]` checkout reviews, or ''. */
function reviewedBranch(branch) {
  const m = /^(.+)-review\d*$/.exec(String(branch || ''));
  return m ? m[1] : '';
}

/**
 * The pull request a worktree belongs to, from one `gh pr list --state all`
 * reading (`number, state, headRefName, headRefOid, body`): by its branch,
 * an open one first, then the newest. A worktree whose branch has none (a
 * review pass checks a pull request out as `<branch>-review`; a catch-up or
 * detached checkout has no branch of its own) belongs to the pull request
 * whose head commit it sits on, and failing that a `<branch>-review` (or
 * `-review2`, ...) branch belongs to `<branch>`'s pull request: loop-review's
 * SKILL.md makes its checkout with `-b <branch>-review`, and merges main into
 * it, so its head often matches no pull request's. Null when there is none.
 *
 * @param {object[]} prs
 * @param {string|{branch: string, head?: string}} worktree  a branch name, or the worktree
 */
function prForBranch(prs, worktree) {
  const { branch, head } = typeof worktree === 'string' ? { branch: worktree, head: '' } : (worktree || {});
  const list = Array.isArray(prs) ? prs : [];
  let mine = branch ? list.filter((p) => p && p.headRefName === branch) : [];
  if (mine.length === 0 && head) mine = list.filter((p) => p && p.headRefOid && p.headRefOid === head);
  const reviewed = reviewedBranch(branch);
  if (mine.length === 0 && reviewed) mine = list.filter((p) => p && p.headRefName === reviewed);
  if (mine.length === 0) return null;
  const open = mine.filter((p) => String(p.state).toUpperCase() === 'OPEN');
  const pool = open.length ? open : mine;
  return pool.reduce((a, b) => (Number(b.number) > Number(a.number) ? b : a));
}

/**
 * One worktree's flag and the reason behind it.
 *
 * @param {object} w      `{ branch, detached, pushed, dirty, onMain }`; onMain:
 *                        its commit is already on the remote's main
 * @param {object|null} pr  `{ number, state }` or null for none
 * @param {object} ticket `{ id: '' }` for no ticket; else `{ id, status }`,
 *                        `{ id, problem }` when it could not be read, or
 *                        `{ id, unread: true }` when its pull request is
 *                        finished and the ticket was not needed
 * @returns {{ flag: string, why: string }}
 */
function worktreeFlag(w, pr, ticket = { id: '' }) {
  const state = pr ? String(pr.state || '').toUpperCase() : '';
  if (state === 'MERGED' || state === 'CLOSED') return { flag: 'STALE', why: `pull request #${pr.number} is ${state.toLowerCase()}` };
  if (!pr) {
    // A review pass's local `-review` branch, or a checkout of a commit that
    // has since merged: nothing in it is anywhere but main already.
    if (w.onMain && !w.dirty) return { flag: 'STALE', why: 'no pull request, its commit is already on main and nothing is uncommitted' };
    if (!w.branch) return { flag: 'UNPUSHED', why: 'detached, no branch and no pull request' };
    if (!w.pushed) return { flag: 'UNPUSHED', why: 'branch never pushed and no pull request' };
    return { flag: 'ACTIVE', why: 'pushed, no pull request yet' };
  }
  if (!ticket || !ticket.id) return { flag: 'ACTIVE', why: `pull request #${pr.number} is open and names no ticket` };
  if (ticket.problem) return { flag: 'UNKNOWN', why: `ticket ${ticket.id} could not be read (${ticket.problem})` };
  const status = statusOf(ticket);
  if (!status) return { flag: 'UNKNOWN', why: `ticket ${ticket.id} came back with no status` };
  if (status === LIVE || TERMINAL_ALIASES.includes(status)) return { flag: 'STALE', why: `ticket ${ticket.id} is ${status}` };
  if (!ACTIVE_STATUSES.includes(status)) return { flag: 'STALE', why: `ticket ${ticket.id} is ${status}, where nothing builds on this branch` };
  return { flag: 'ACTIVE', why: `ticket ${ticket.id} is ${status}` };
}

const folderName = (p) => String(p).replace(/\/+$/, '').split('/').pop();

/** The printed line for one worktree, tab-separated. */
function worktreeLine(w, pr, ticket, verdict) {
  const prText = pr ? `#${pr.number} ${String(pr.state || '').toLowerCase()}` : 'no pull request';
  const ticketText = ticket && ticket.id
    ? `${ticket.id} ${ticket.problem ? '(unreadable)' : ticket.unread ? '(not read)' : statusOf(ticket) || '(no status)'}`
    : '(no ticket)';
  return [
    folderName(w.path),
    w.branch || '(detached)',
    w.pushed ? 'pushed' : 'not pushed',
    w.dirty ? 'uncommitted edits' : 'clean',
    prText,
    ticketText,
    verdict.flag,
    verdict.why,
  ].join('\t');
}

/** The closing line: `510 worktree(s): 430 STALE, 40 UNPUSHED, 35 ACTIVE, 5 UNKNOWN`. */
function countLine(flags) {
  const counts = Object.fromEntries(FLAGS.map((f) => [f, 0]));
  for (const f of flags) counts[f] = (counts[f] || 0) + 1;
  return `${flags.length} worktree(s): ${FLAGS.map((f) => `${counts[f]} ${f}`).join(', ')}`;
}

module.exports = {
  ACTIVE_STATUSES,
  FLAGS,
  WORKTREE_FOLDER,
  parseWorktreeList,
  passWorktrees,
  reviewedBranch,
  prForBranch,
  worktreeFlag,
  worktreeLine,
  countLine,
};
