'use strict';

/**
 * reconcile.js — open tickets whose pull request GitHub has already finished
 * with (SP-354, the part of StarCaster's scripts/reconcile_clickup_github.cjs
 * that Dane chose to move, docs/WATCHDOGS.md question 4).
 *
 * WHY. The relay moves a ticket only when it is the one merging, or when the
 * operator answers a ticket whose pull request is already merged
 * (lib/busRelayPlan.js). A pull request merged or closed straight on GitHub
 * leaves its ticket behind in `Ready to launch`, `In review` or wherever it
 * was, with nothing to say so. This names those tickets. It changes nothing:
 * the operator or the loop moves the ticket.
 *
 * A ticket's pull request is the newest `PR opened:` comment, read by
 * `findPullRequest` in lib/mergeOnComment.js, the one reader every other
 * check uses, so this can never name a ticket by another ticket's pull
 * request through a second reading of the trail.
 *
 * A pull request whose state could not be read is "could not check", with
 * the reason, and never counted as clean (DOCTRINE 3.11). So is one whose
 * link names a different repository from the project's: asking GitHub for
 * that number in the project's repository would read somebody else's pull
 * request.
 *
 * Pure: no network, no clock of its own, no files.
 */

const { findPullRequest } = require('./mergeOnComment.js');

/** The finding kinds, which are also the second half of a reminder stamp's key. */
const MERGED = 'merged';
const CLOSED = 'closed';
const UNCHECKED = 'unchecked';

/** Statuses that are not open: nothing to reconcile there. */
const DONE_STATUSES = new Set(['live', 'closed', 'complete', 'done']);

function statusOf(task) {
  return String(task?.status?.status || '').trim().toLowerCase();
}

/** Is this ticket open (every status but `Live` and closed)? */
function isOpen(task) {
  const s = statusOf(task);
  return Boolean(s) && !DONE_STATUSES.has(s);
}

/** "owner/repo", lower-cased, for comparing a link with the config. */
function repoKey(owner, repo) {
  return `${String(owner || '').toLowerCase()}/${String(repo || '').toLowerCase()}`;
}

/**
 * Which open tickets have a pull request to ask GitHub about, and which
 * cannot be checked before GitHub is asked at all.
 *
 * @param tasks         ClickUp-shaped tasks (watchdogDoor.mjs): id, name, url, status.status
 * @param commentsById  Map of ticket id -> comment records; a missing entry is an unreadable read
 * @param githubRepo    the project config's "owner/repo"
 * @returns { checked, toAsk, unchecked, noPr }
 *   checked   every open ticket looked at, in order
 *   toAsk     [{ task, pr }] tickets whose pull request GitHub must be asked about
 *   unchecked findings of kind UNCHECKED already known (comments unreadable, another repository)
 *   noPr      ids of open tickets with no `PR opened:` comment
 */
function planChecks({ tasks, commentsById, githubRepo }) {
  const checked = [];
  const toAsk = [];
  const unchecked = [];
  const noPr = [];
  const ours = String(githubRepo || '').toLowerCase();
  for (const task of tasks || []) {
    if (!isOpen(task)) continue;
    checked.push(task);
    const comments = commentsById instanceof Map ? commentsById.get(String(task.id)) : undefined;
    if (!comments) {
      unchecked.push(finding(task, { kind: UNCHECKED, why: 'its comments could not be read, so its pull request is unknown' }));
      continue;
    }
    const pr = findPullRequest(comments);
    if (!pr) { noPr.push(String(task.id)); continue; }
    if (ours && repoKey(pr.owner, pr.repo) !== ours) {
      unchecked.push(finding(task, { kind: UNCHECKED, pr, why: `its pull request is in ${pr.owner}/${pr.repo}, not this project's repository` }));
      continue;
    }
    toAsk.push({ task, pr });
  }
  return { checked, toAsk, unchecked, noPr };
}

function finding(task, { kind, pr = null, why = '', at = '' }) {
  return {
    taskId: String(task.id),
    name: task.name,
    url: task.url || '',
    status: statusOf(task),
    kind,
    pr: pr ? { number: pr.number, url: pr.url } : null,
    why,
    at,
  };
}

/**
 * One ticket and its pull request's state on GitHub, as a finding or null.
 *
 * @param snap { state: 'OPEN'|'MERGED'|'CLOSED'|null, at, why }
 *   `state: null` means GitHub could not be read; `why` says why.
 */
function classify({ task, pr, snap }) {
  const state = String(snap?.state || '').toUpperCase();
  if (state === 'OPEN') return null;
  if (state === 'MERGED') return finding(task, { kind: MERGED, pr, at: snap.at || '' });
  if (state === 'CLOSED') return finding(task, { kind: CLOSED, pr, at: snap.at || '' });
  const why = snap?.why || (state ? `GitHub gave a state this check does not know ("${state}")` : 'GitHub gave no state');
  return finding(task, { kind: UNCHECKED, pr, why: `its pull request could not be read: ${why}` });
}

/** The reminder stamp key for a finding: `<ticket>:<kind>`. */
function postKey(f) {
  return `${f.taskId}:${f.kind}`;
}

/** The ticket a stamp key belongs to, and its kind. Beside postKey so the format has one definition. */
function parseKey(key) {
  const [taskId, kind = ''] = String(key || '').split(':');
  return { taskId, kind };
}

/** Stamp keys no longer backed by a finding: cleared, so a finding that comes back is said at once. */
function staleKeys({ stampKeys, findings }) {
  const live = new Set((findings || []).map(postKey));
  return [...(stampKeys || [])].filter((k) => !live.has(k));
}

/**
 * Exit code without --check: 0 nothing found, 1 a finding, 2 could not tell
 * (any ticket that could not be checked, whatever else was found, because
 * part of the answer is missing).
 */
function exitCodeFor(findings) {
  const list = findings || [];
  if (list.some((f) => f.kind === UNCHECKED)) return 2;
  return list.length ? 1 : 0;
}

function prText(f) {
  return f.pr ? `pull request #${f.pr.number}` : 'its pull request';
}

/** One finding as one plain line. */
function findingLine(f, { when = (iso) => iso } = {}) {
  const head = `${f.taskId} "${f.name}" (${f.status})`;
  const at = f.at ? ` ${when(f.at)}` : '';
  if (f.kind === MERGED) return `${head}: ${prText(f)} was merged${at}, and the ticket is still open.`;
  if (f.kind === CLOSED) return `${head}: ${prText(f)} was closed without merging${at}, and the ticket still points at it.`;
  return `${head}: could not check: ${f.why}.`;
}

/** The console report. Prints on every run, findings or not, so an all-clear and a run that died do not look alike. */
function renderReport({ checked, findings, noPr, asked, when }) {
  const list = findings || [];
  const lines = [];
  lines.push(`RECONCILE: ${(checked || []).length} open ticket(s) read, ${asked} pull request(s) asked about on GitHub, `
    + `${(noPr || []).length} with no pull request.`);
  for (const t of checked || []) {
    const f = list.find((x) => x.taskId === String(t.id));
    const said = f ? (f.kind === UNCHECKED ? 'could not check' : f.kind === MERGED ? 'pull request merged' : 'pull request closed')
      : ((noPr || []).includes(String(t.id)) ? 'no pull request' : 'pull request open');
    lines.push(`  ${t.id} (${statusOf(t)}): ${said}`);
  }
  lines.push('');
  if (!list.length) {
    lines.push('Nothing found: no open ticket points at a pull request GitHub has merged or closed.');
    return lines.join('\n');
  }
  for (const f of list) lines.push(`• ${findingLine(f, { when })}`);
  return lines.join('\n');
}

/** The bus post: what was found, and that nothing was moved. */
function renderPost({ findings, node = '', when }) {
  const list = findings || [];
  const real = list.filter((f) => f.kind !== UNCHECKED).length;
  const lines = [];
  lines.push(`RECONCILE: ${real} open ticket(s) whose pull request GitHub has already merged or closed`
    + `${list.length > real ? `, ${list.length - real} that could not be checked` : ''}.`);
  lines.push('');
  for (const f of list) {
    lines.push(`• ${findingLine(f, { when })}`);
    if (f.url) lines.push(`  ${f.url}`);
  }
  lines.push('');
  lines.push('Nothing was moved: this check only reports. Move the ticket, or reopen the pull request.');
  lines.push(`Say more: \`npm run reconcile\`${node ? `  (reported by ${node})` : ''}`);
  return lines.join('\n');
}

module.exports = {
  MERGED,
  CLOSED,
  UNCHECKED,
  isOpen,
  planChecks,
  classify,
  postKey,
  parseKey,
  staleKeys,
  exitCodeFor,
  findingLine,
  renderReport,
  renderPost,
};
