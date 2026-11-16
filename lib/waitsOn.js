'use strict';

/**
 * waitsOn — "this ticket builds on that one", declared once, read by the claim.
 *
 * WHY THIS FILE EXISTS (2026-10-27, task 86bctfun6). The build loop takes the
 * oldest Queued ticket, whatever it builds on. So a plan whose steps depend on
 * each other could only be filed one wave at a time, each wave after the one
 * before had merged, and Dane looked for the tracker plan's tickets in the
 * Loop Queue and found most of them missing. A ticket may now say what it waits
 * on, and the claim leaves it alone until that ticket is closed.
 *
 * The declaration is a line of its own in the description:
 *
 *   Waits on: 86bctbf46
 *   Waits on: https://app.clickup.com/t/86bctbf46, 86bctbw76
 *   Waits on: SP-265, SP-271 ("Run a project's lanes from Spirality's folder")
 *
 * Any letter case; one or more ticket ids or ticket links, separated by commas;
 * a list marker, quote or bold around the marker is fine (`- **Waits on:** x`).
 * An id or link may be followed by its title, in quotes (straight or curly,
 * double or single) or in brackets around quotes (`("...")`); the title is
 * ignored and a comma inside it does not split the line (SP-313). Inside
 * single quotes an apostrophe may sit only between two letters (`'Dane's
 * lanes'`); any other single quote ends the title. Words in brackets with no
 * quotes (`aaa1 (the API ticket)`), words with no quotes at all, and a title
 * with a link or any digit in it (`("after 86bctbw76")`, `("needs SP-2")`)
 * stay unparsed: they might be naming another ticket, and a doubtful piece
 * holds the ticket back.
 * Prose that merely mentions waiting does nothing: a ticket is held back by a
 * declaration, never by how a paragraph was worded (the same rule as
 * `Next slice:` in relayLane.js).
 *
 * A bare id is safe here although clickupTicketLink.js refuses one in a PR
 * body: there the id had to be picked out of free prose, here it sits after a
 * marker that names it. A bare id is also what the tracker that replaces
 * ClickUp will use (docs/TRACKER_MVP.md), so the line works on either.
 *
 * ClickUp's own dependency feature is not used for the same reason.
 */

const LINK = String.raw`https?:\/\/app\.clickup\.com\/t\/(?:\d+\/)?([a-z0-9]+)\/?`;
// A token is one of: a bare id, a link, a link in <angle brackets>, or a
// markdown link `[text](link)`. Anything else on the line is NOT guessed at.
const LINK_TOKEN_RE = new RegExp(String.raw`^(?:<?${LINK}>?|\[[^\]]*\]\(${LINK}\))$`, 'i');
const BARE_ID_RE = /^[a-z0-9][a-z0-9-]*$/i;
// A title after the id (SP-313): one quoted string, bare or inside brackets.
// Inside single quotes an apostrophe may sit only between two letters
// (Dane's), so `SP-1 'x'; bbb2 'y'` is not one long title hiding bbb2.
// splitPieces ends a single-quoted title by the same rule (isApostrophe).
const QUOTED = String.raw`(?:"[^"]*"|“[^”]*”|'(?:[^']|(?<=\p{L})'(?=\p{L}))*'|‘(?:[^’]|(?<=\p{L})’(?=\p{L}))*’)`;
const TITLED_RE = new RegExp(String.raw`^(.*?\S)\s+(?:${QUOTED}|\(\s*${QUOTED}\s*\))$`, 'u');
// A title that might name a ticket is refused, so no prerequisite hides in
// one: a link, an `SP-2`, or a bare ClickUp id like 86bctbw76. Any digit at
// all counts, because a bare id cannot be told from a word by its shape.
const TICKETISH_RE = /\d|https?:\/\//i;
const LETTER_RE = /\p{L}/u;
const OPEN_CLOSE = { '"': '"', '“': '”', "'": "'", '‘': '’' };
// A line of its own, which may sit in a quote (`> `), a list item (`- `,
// `* `, `+ `, `1. `) and/or bold or italic around the marker
// (`**Waits on:**`): loop-spec writes descriptions as bullet lists, and the
// markdown text keeps the bullets.
const WAITS_ON_LINE_RE = /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d+[.)])[ \t]+)?[*_]{0,2}waits on:[*_]{0,2}(.*)$/gim;

/** A single quote between two letters is an apostrophe, never a title's end. */
function isApostrophe(prev, next) {
  return LETTER_RE.test(prev) && LETTER_RE.test(next);
}

/**
 * A token without the backticks and bold or italic marks around it
 * (`` `SP-1` ``, `**SP-1**`); `trailing` names more characters to drop from
 * its end only (the full stop that ends a sentence).
 */
function stripMarks(text, trailing = '') {
  return text.replace(/^[`*_]+/, '').replace(new RegExp(`[\`*_${trailing}]+$`), '');
}

/**
 * The pieces of a Waits on: line, split on the commas that sit outside a
 * quoted or bracketed title. A single quote opens a title only at the start
 * of a word and closes it anywhere but between two letters (the same rule
 * QUOTED uses), so an apostrophe (Dane's) neither opens nor ends one. An unclosed quote or bracket keeps the rest of the line as
 * one piece, which then stays unparsed: a mis-split can only hold back.
 */
function splitPieces(rest) {
  const pieces = [];
  let cur = '';
  let quote = '';
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    const prev = i === 0 ? ' ' : rest[i - 1];
    const next = i + 1 < rest.length ? rest[i + 1] : ' ';
    if (quote) {
      const single = quote === "'" || quote === '’';
      if (c === quote && !(single && isApostrophe(prev, next))) quote = '';
    } else if (OPEN_CLOSE[c] && (!(c === "'" || c === '‘') || /[\s(]/.test(prev))) {
      quote = OPEN_CLOSE[c];
    } else if (c === '(') depth++;
    else if (c === ')' && depth > 0) depth--;
    else if (c === ',' && depth === 0) { pieces.push(cur); cur = ''; continue; }
    cur += c;
  }
  pieces.push(cur);
  return pieces;
}

/** The id a single token names (a bare id or a link), or '' when it names none. */
function tokenId(token) {
  const link = LINK_TOKEN_RE.exec(token);
  return link ? (link[1] || link[2]) : (BARE_ID_RE.test(token) ? token : '');
}

/** The id a piece names: the token alone, or the token then a quoted title. */
function pieceId(piece) {
  const whole = tokenId(piece);
  if (whole) return whole;
  const titled = TITLED_RE.exec(piece);
  if (!titled) return '';
  const title = piece.slice(titled[1].length);
  if (TICKETISH_RE.test(title)) return '';
  return tokenId(stripMarks(titled[1]));
}

/**
 * What a description declares it waits on: `ids` (lowercased, in order, no
 * repeats) and `unparsed`, every piece of a `Waits on:` line that is not a
 * ticket id or link. An unparsed piece must hold the ticket back, never be
 * dropped: "Waits on: aaa1 and bbb2" read as "nothing" claims it early.
 */
function readWaitsOn(description) {
  const ids = [];
  const unparsed = [];
  for (const m of String(description || '').matchAll(WAITS_ON_LINE_RE)) {
    const rest = m[1].trim();
    if (!rest.replace(/[`*_.\s]/g, '')) { unparsed.push('(nothing named)'); continue; }
    for (const raw of splitPieces(rest)) {
      const token = stripMarks(raw.trim(), '.');
      if (!token) continue;
      const id = pieceId(token);
      if (!id) unparsed.push(token);
      else if (!ids.includes(id.toLowerCase())) ids.push(id.toLowerCase());
    }
  }
  return { ids, unparsed };
}

/** Every ticket a description says it waits on, lowercased, in order, no repeats. */
function waitsOn(description) {
  return readWaitsOn(description).ids;
}

/**
 * The text both `queue --claimable` and `claim` read the line from: the
 * markdown description when the ticket carries one (it keeps bullets, bold
 * and backticks), else the plain one. One source, so the two can never
 * disagree about what a ticket waits on.
 */
function waitsOnText(ticket) {
  return ticket?.markdown_description ?? ticket?.description ?? '';
}

/**
 * Why a ticket is held back, one line per reason, given what is known about
 * each prerequisite: `lookup(id)` returns 'open', 'closed' or 'unreadable'.
 * A prerequisite is held for wherever it lives, in this list or another.
 * `unreadable` is set when any reason is a failed read (claim exits 1 on it).
 */
function holdReasons(ticket, lookup) {
  const { ids, unparsed } = readWaitsOn(waitsOnText(ticket));
  const reasons = unparsed.map((t) => `its Waits on: line names "${t}", which is not a ticket id or link`);
  let unreadable = false;
  for (const id of ids) {
    const state = lookup(id);
    if (state === 'closed') continue;
    if (state === 'open') reasons.push(`waits on ${id} (still open)`);
    else { reasons.push(`waits on ${id} (could not be read)`); unreadable = true; }
  }
  return { reasons, unreadable };
}

module.exports = {
  readWaitsOn,
  waitsOn,
  waitsOnText,
  holdReasons,
};
