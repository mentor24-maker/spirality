'use strict';

/**
 * fileHold — keep two tickets that change the same file from being built at
 * the same time (SP-351).
 *
 * WHY THIS FILE EXISTS (2026-11-16). The only way to put tickets in order was
 * the hand-written `Waits on:` line, written for "this needs that one merged
 * first", never for "these two change the same file". SP-308 and SP-309 both
 * waited on SP-307 but not on each other, were built side by side and
 * clashed; SP-320 to SP-325 clashed with one another all day. Dane: "make a
 * second ticket sharing a file always wait. As you said, we can always run
 * another unrelated one in it's place, so there's no lost cycles."
 *
 * The rule, decided here so `queue --claimable` and `claim` can never
 * disagree (the way both already read `Waits on:` through lib/waitsOn.js):
 *
 *   - Only a ticket that will open a NEW pull request is ever held: a
 *     `Queued` ticket that is not a merge fix-up. A `Rework` ticket and a
 *     fix-up ticket ("Find out why PR #N ... will not merge") push to a pull
 *     request that already exists, so holding them cannot keep the overlap
 *     from happening, and two of them sharing a file would hold each other
 *     for ever. They are never held.
 *   - It is held by every open pull request (the tracker's record of its
 *     changed files, SP-349) whose ticket is still open, and by every ticket
 *     in `Building` with no pull request recorded yet (its likely files,
 *     SP-350). Its own ticket never holds it.
 *   - Any one shared file holds it. There is no exceptions list: the work
 *     log and the prompt log are one new file per entry, so two tickets
 *     never share one.
 *   - A record whose ticket is no longer open (Live, or closed) is a pull
 *     request that merged before the relay forgot its files, so it holds
 *     nothing: the held ticket takes its place in line the moment the pull
 *     requests that held it merge or close.
 *
 * The files a ticket will likely change are on its `Likely files:` line
 * (docs/LOOP_CONTRACT.md, "The files a ticket will likely change"). An older
 * ticket with no such line is read by the backticked paths under its
 * `## Affected files / artifacts` heading, as loop-intake compares them; a
 * ticket with neither names no files, and the build pass works them out and
 * writes the line (`npm run clickup -- likely-files`) before it claims.
 *
 * Nothing here is project-specific: ticket ids, statuses and the repository
 * come from the caller.
 */

const { normalFiles } = require('./prFiles.js');

// A line of its own, which may sit in a list item and/or have bold or italic
// around the marker, the same shapes lib/waitsOn.js accepts for its line.
const LIKELY_LINE_RE = /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d+[.)])[ \t]+)?[*_]{0,2}likely files:[*_]{0,2}(.*)$/gim;
const AFFECTED_HEADING_RE = /^#{1,6}[ \t]+affected files\b.*$/im;
const NEXT_HEADING_RE = /^#{1,6}[ \t]+\S/m;
const BACKTICKED_RE = /`([^`\n]+)`/g;
// A path, not a command or a word: no spaces, and a slash or a dot in it.
const PATHISH_RE = /^[^\s]*[./][^\s]*$/;

/** One path as written on the line: no backticks, marks or full stop around it. */
function cleanPath(raw) {
  return String(raw).trim().replace(/^[`*_'"]+/, '').replace(/[`*_'".;]+$/, '').trim();
}

/** The paths under the `## Affected files / artifacts` heading, backticked. */
function affectedSectionPaths(description) {
  const text = String(description || '');
  const head = AFFECTED_HEADING_RE.exec(text);
  if (!head) return [];
  const rest = text.slice(head.index + head[0].length);
  const next = NEXT_HEADING_RE.exec(rest);
  const section = next ? rest.slice(0, next.index) : rest;
  const out = [];
  for (const m of section.matchAll(BACKTICKED_RE)) {
    const p = cleanPath(m[1]);
    if (PATHISH_RE.test(p)) out.push(p);
  }
  return out;
}

/**
 * The files a ticket's description says it will likely change, as
 * `{ files, source }`: `source` is 'line' (its `Likely files:` line or
 * lines), 'affected' (no line, so the backticked paths under its
 * `## Affected files / artifacts` heading) or null (it names none; `files`
 * is then empty).
 */
function readLikelyFiles(description) {
  const fromLine = [];
  let sawLine = false;
  for (const m of String(description || '').matchAll(LIKELY_LINE_RE)) {
    sawLine = true;
    for (const piece of m[1].split(',')) {
      const p = cleanPath(piece);
      if (p) fromLine.push(p);
    }
  }
  if (sawLine && fromLine.length) return { files: normalFiles(fromLine), source: 'line' };
  const affected = affectedSectionPaths(description);
  if (affected.length) return { files: normalFiles(affected), source: 'affected' };
  return { files: [], source: null };
}

/** The text the files are read from: the markdown description, else the plain one (as waitsOnText). */
function descriptionOf(ticket) {
  return ticket?.markdown_description ?? ticket?.description ?? '';
}

// The names lib/conflictWork.js gives a merge fix-up ticket (conflictTicketName).
const FIXUP_NAME_RE = /^(?:Find out why|Resolve the merge conflict on|Check why) PR #(\d+)\b/;

/** The pull request a merge fix-up ticket works on, from its name, or null when it is not one. */
function fixupPrNumber(name) {
  const m = FIXUP_NAME_RE.exec(String(name || '').trim());
  return m ? Number(m[1]) : null;
}

function statusName(ticket) {
  return String(ticket?.status?.status ?? ticket?.status ?? '').trim().toLowerCase();
}

function idOf(x) {
  return x == null ? '' : String(x).trim().toUpperCase();
}

/**
 * Whether the hold applies to this ticket at all: it will open a new pull
 * request (a `queuedStatus` ticket that is not a merge fix-up).
 */
function holdApplies(ticket, { queuedStatus = 'queued' } = {}) {
  if (statusName(ticket) !== String(queuedStatus).toLowerCase()) return false;
  return fixupPrNumber(ticket?.name) == null;
}

/**
 * Why a ticket is held for shared files. `ticket` is the candidate (with
 * `id`, `name`, `status`, description); `tickets` every OPEN ticket of the
 * project (the queue as listed, Live and closed left out); `records` the
 * tracker's open pull requests' files (`{ ticket, number, repo, files }`);
 * `repo` the project's repository (a record from another one is left out);
 * `buildingStatus` the status a ticket is built in.
 *
 * Answers `{ applies, files, source, holders, inFlight }`: `applies` false for a ticket
 * that is never held (see the top of this file), `files`/`source` the
 * candidate's likely files as readLikelyFiles reads them, and `holders` one
 * entry per pull request or building ticket that shares any of them,
 * `{ ticket, number, files }` (`number` null for a ticket with no pull
 * request yet), pull requests first by number, then tickets by id.
 * `inFlight` counts the other open pull requests and Building tickets whose
 * files are known: with none, a ticket that names no files cannot clash.
 */
function fileHolds({ ticket, tickets = [], records = [], repo = null, buildingStatus = 'building', queuedStatus = 'queued' } = {}) {
  const { files, source } = readLikelyFiles(descriptionOf(ticket));
  const applies = holdApplies(ticket, { queuedStatus });
  if (!applies) return { applies, files, source, holders: [], inFlight: 0 };
  const wanted = new Set(files);
  let inFlight = 0;
  const self = idOf(ticket?.id);
  const open = new Map();
  for (const t of tickets || []) if (t && t.id != null) open.set(idOf(t.id), t);
  const holders = [];
  const withRecord = new Set();
  for (const r of records || []) {
    if (!r || !Array.isArray(r.files)) continue;
    if (repo && r.repo && String(r.repo).toLowerCase() !== String(repo).toLowerCase()) continue;
    const owner = idOf(r.ticket);
    if (!owner) continue;
    withRecord.add(owner);
    if (owner === self || !open.has(owner)) continue;
    inFlight += 1;
    const shared = normalFiles(r.files.filter((f) => wanted.has(f))) || [];
    if (shared.length) holders.push({ ticket: open.get(owner).id, number: Number(r.number), files: shared });
  }
  holders.sort((a, b) => a.number - b.number);
  const building = [];
  for (const [id, t] of open) {
    if (id === self || withRecord.has(id)) continue;
    if (statusName(t) !== String(buildingStatus).toLowerCase()) continue;
    const theirs = readLikelyFiles(descriptionOf(t)).files;
    if (theirs.length) inFlight += 1;
    const shared = theirs.filter((f) => wanted.has(f));
    if (shared.length) building.push({ ticket: t.id, number: null, files: shared });
  }
  building.sort((a, b) => idOf(a.ticket).localeCompare(idOf(b.ticket), 'en', { numeric: true }));
  return { applies, files, source, holders: [...holders, ...building], inFlight };
}

/** "SP-12 (PR #40) changes a.js, b.js" or "SP-12 (being built, no pull request yet) will change a.js". */
function holderLine(h) {
  if (h.number == null) return `${h.ticket} (being built, no pull request yet) will change ${h.files.join(', ')}`;
  return `${h.ticket} (PR #${h.number}) changes ${h.files.join(', ')}`;
}

/** The one line `queue --claimable` and `claim` print for a held ticket. */
function holdReason(holders) {
  return `held for shared files: ${holders.map(holderLine).join('; ')}`;
}

const HOLD_NOTE_HEAD = 'HELD FOR SHARED FILES';

/**
 * The note left on a held ticket, once per set of holders: which tickets and
 * files hold it, and that it needs nothing from anyone. Deterministic, so the
 * same holders give the same text and the note is not repeated every pass.
 */
function holdNote(holders) {
  return [
    `**${HOLD_NOTE_HEAD}** — the build lane is leaving this ticket for now, because work already in flight changes the same files:`,
    '',
    ...holders.map((h) => `- ${holderLine(h)}`),
    '',
    'Building it now would make the two clash. The lane builds another ticket in its place, and this one takes its normal place in line the moment those pull requests merge or close. Nothing is needed from anyone.',
  ].join('\n');
}

/** Whether a comment's text is a hold note (any holders). */
function isHoldNote(text) {
  return String(text || '').includes(`**${HOLD_NOTE_HEAD}**`);
}

/**
 * Whether the note for `holders` must be written: the newest hold note among
 * `comments` (`{ comment_text }` or `{ text }`, any order with `date`) says
 * something else, or there is none.
 */
function holdNoteDue(comments, holders) {
  const want = holdNote(holders).trim();
  const notes = (comments || [])
    .map((c) => ({ text: String(c?.comment_text ?? c?.text ?? ''), date: Number(c?.date ?? 0) }))
    .filter((c) => isHoldNote(c.text))
    .sort((a, b) => b.date - a.date);
  return !notes.length || !notes[0].text.includes(want);
}

/**
 * The description with a `Likely files:` line added: under the
 * `## Affected files / artifacts` section (after its last line of text) when
 * there is one, else at the end. Refuses (returns `{ error }`) when the
 * description already has the line, or no paths are given.
 */
function withLikelyFilesLine(description, files) {
  const list = normalFiles(files || []) || [];
  if (!list.length) return { error: 'no paths given' };
  const text = String(description || '');
  if (readLikelyFiles(text).source === 'line') return { error: `it already has a Likely files: line (${readLikelyFiles(text).files.join(', ')})` };
  const line = `Likely files: ${list.join(', ')}`;
  const head = AFFECTED_HEADING_RE.exec(text);
  if (!head) return { description: `${text.replace(/\s*$/, '')}\n\n${line}\n` };
  const start = head.index + head[0].length;
  const rest = text.slice(start);
  const next = NEXT_HEADING_RE.exec(rest);
  const end = next ? start + next.index : text.length;
  const section = text.slice(start, end).replace(/\s*$/, '');
  const after = text.slice(end);
  return { description: `${text.slice(0, start)}${section}\n\n${line}\n${after ? `\n${after}` : ''}` };
}

module.exports = {
  readLikelyFiles,
  fixupPrNumber,
  holdApplies,
  fileHolds,
  holderLine,
  holdReason,
  holdNote,
  isHoldNote,
  holdNoteDue,
  withLikelyFilesLine,
};
