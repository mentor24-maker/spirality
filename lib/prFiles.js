'use strict';

/**
 * Which files each open pull request changes (SP-349): the record the
 * same-file hold-back (SP-351) stands on, so nothing has to guess.
 *
 * The tracker keeps one record per open pull request, `{ ticket, number,
 * repo, head, files, readAt }` (tracker/store.mjs, `pr_files`). The door
 * (`npm run clickup -- pr-opened`, `pr-files-refresh`) reads the files from
 * GitHub and writes them; the relay refreshes them whenever a branch moves
 * and forgets a pull request once it merges or closes. This module only
 * decides, so a test can hand it any facts it likes:
 *
 *   - `normalFiles`: a list of paths as stored (trimmed, no blanks, no
 *     repeats, sorted), or null when it is not a list of paths at all;
 *   - `parseRestFiles`: GitHub's answer, one `<path>\t<old path>` line per
 *     changed file, as the list of paths (a renamed file counts under both
 *     names, since either can clash);
 *   - `sharedWith`: the other open pull requests that change any of the
 *     given files, each with the files they share;
 *   - `refreshPlan`: from the records and GitHub's open pull requests, which
 *     need their files read again (new, or the branch moved) and which are
 *     gone (merged or closed) and should be forgotten.
 *
 * A read that fails is never stored as "no files": the caller says so and
 * writes nothing. An empty list is only ever GitHub's own answer for a pull
 * request with no changed files.
 *
 * Nothing here is project-specific: the repository comes from the project
 * config, through the caller.
 */

/** A list of paths as the tracker keeps it, or null when it is not one. */
function normalFiles(list) {
  if (!Array.isArray(list)) return null;
  const out = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') return null;
    const path = raw.trim();
    if (!path) continue;
    out.add(path);
  }
  return [...out].sort();
}

/**
 * GitHub's list of a pull request's files, as `gh api --paginate
 * repos/<repo>/pulls/<n>/files --jq '.[] | [.filename, (.previous_filename
 * // "")] | @tsv'` prints it, as `{ files, count }`: every path (both names
 * of a rename) and how many changed files GitHub listed (a rename is one),
 * to compare with the pull request's own count.
 */
function parseRestFiles(text) {
  const files = [];
  let count = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    count += 1;
    const [path, old] = line.split('\t');
    if (path && path.trim()) files.push(path.trim());
    if (old && old.trim()) files.push(old.trim());
  }
  return { files: normalFiles(files), count };
}

/**
 * The other open pull requests that change any of `files`, as
 * `[{ ticket, number, files }]`, `files` being the shared ones, ordered by
 * pull request number. `except` leaves out the asker's own pull request
 * (`{ number }`) and its own ticket (`{ ticket }`), so a ticket is never
 * said to clash with itself.
 */
function sharedWith(records, files, except = {}) {
  const wanted = new Set(normalFiles(files) || []);
  if (!wanted.size) return [];
  const ticket = except.ticket == null ? null : String(except.ticket).toUpperCase();
  const number = except.number == null ? null : Number(except.number);
  const out = [];
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || !Array.isArray(r.files)) continue;
    if (number != null && Number(r.number) === number) continue;
    if (ticket != null && String(r.ticket ?? '').toUpperCase() === ticket) continue;
    const shared = r.files.filter((f) => wanted.has(f));
    if (shared.length) out.push({ ticket: r.ticket ?? null, number: Number(r.number), files: shared });
  }
  return out.sort((a, b) => a.number - b.number);
}

/**
 * What a refresh must do. `records` are the tracker's (`{ number, head }`),
 * `openPrs` GitHub's open pull requests (`{ number, headRefOid }`).
 * Answers `{ read, forget, current }`: `read` the open pull requests with no
 * record or whose branch has moved since it was read, `forget` the records
 * whose pull request is no longer open, `current` how many are already up to
 * date.
 */
function refreshPlan({ records = [], openPrs = [] } = {}) {
  const byNumber = new Map((records || []).map((r) => [Number(r.number), r]));
  const open = new Set();
  const read = [];
  let current = 0;
  for (const pr of openPrs || []) {
    const n = Number(pr?.number);
    if (!Number.isInteger(n) || n <= 0) continue;
    open.add(n);
    const had = byNumber.get(n);
    if (had && had.head && pr.headRefOid && had.head === pr.headRefOid) current += 1;
    else read.push(pr);
  }
  const forget = (records || []).filter((r) => !open.has(Number(r.number)));
  return { read, forget, current };
}

/** "Changes the same files as SP-12 (PR #40): a.js, b.js" — the ticket page's and the door's line. */
function sharedLine(s) {
  const who = s.ticket ? `${s.ticket} (PR #${s.number})` : `PR #${s.number}`;
  return `Changes the same files as ${who}: ${s.files.join(', ')}`;
}

module.exports = { normalFiles, parseRestFiles, sharedWith, refreshPlan, sharedLine };
