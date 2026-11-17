/**
 * The ticket page (page-ticket.mjs): its comments, the operator card and
 * what is read from it, the status line, the quick actions (Merge, Close,
 * Go, Reply), the bug report's actions, the Delete action and the Change
 * panel.
 *
 * Split out of render.mjs (SP-364), which re-exports it, so every importer
 * still names render.mjs. Its rule holds here too: every character of
 * ticket text is escaped before it is drawn.
 */
import { escapeHtml, link, renderInline, FENCE, closesFence, HEADING, RULE, BULLET, NUMBERED, renderMarkdown, unbold, BANNER_RULE, BANNER_LABEL, RAW_SECTION, findBanner, cardAsk, mountainTime, INFO_ICON, capital, option, renderCopyRow } from './render-common.mjs';

/**
 * A comment as HTML: its Markdown, with an operator card's banner drawn as
 * the red `NEEDED FROM …` block. Everything else in the comment, before or
 * after the banner, renders as ordinary Markdown.
 */
export function renderComment(body, { operatorName } = {}) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const banner = findBanner(lines, operatorName);
  if (!banner) return renderMarkdown(body);
  const [first, ...rest] = banner.lines;
  const m = BANNER_LABEL.exec(first);
  const head = `<strong>${escapeHtml(m[0])}</strong>${renderInline(first.slice(m[0].length))}`;
  const box = `<div class="banner">${[head, ...rest.map(renderInline)].join('<br>')}</div>`;
  return [
    renderMarkdown(lines.slice(0, banner.start).join('\n')),
    box,
    renderMarkdown(lines.slice(banner.end).join('\n')),
  ].filter(Boolean).join('\n');
}

const CONTEXT_HEADING = "WHAT'S GOING ON";

/**
 * The "WHAT'S GOING ON" text of an operator card, as plain text, or null when
 * the comment carries no card. Two forms, as for the banner: the heading line
 * `ask` posts (maybe in `**…**`) and the paragraph under it, or an authored
 * card's `@@CONTEXT` section, up to the next `@@` marker.
 */
export function cardContext(body) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const heading = lines.findIndex((l) => unbold(l) === CONTEXT_HEADING);
  const text = [];
  if (heading !== -1) {
    let i = heading + 1;
    while (i < lines.length && !lines[i].trim()) i += 1;
    while (i < lines.length && lines[i].trim() && !BANNER_RULE.test(unbold(lines[i])) && !BANNER_LABEL.test(unbold(lines[i]))) {
      text.push(lines[i++].trim());
    }
  } else {
    const raw = lines.findIndex((l) => RAW_SECTION.exec(l.trim())?.[1] === 'CONTEXT');
    if (raw === -1) return null;
    for (let i = raw + 1; i < lines.length && !RAW_SECTION.test(lines[i].trim()); i += 1) {
      if (lines[i].trim()) text.push(lines[i].trim());
    }
  }
  return text.join(' ') || null;
}

/**
 * The description's first paragraph of prose, as plain text: headings,
 * fenced code, rules and lists are passed over. Empty when there is none.
 */
export function firstParagraph(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE.test(line)) {
      const run = FENCE.exec(line)[1];
      i += 1;
      while (i < lines.length && !closesFence(lines[i], run)) i += 1;
      i += 1;
      continue;
    }
    if (!line.trim() || HEADING.test(line) || RULE.test(line) || BULLET.test(line) || NUMBERED.test(line)) { i += 1; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i])
      && !RULE.test(lines[i]) && !BULLET.test(lines[i]) && !NUMBERED.test(lines[i])) {
      para.push(lines[i++].trim());
    }
    return para.join(' ');
  }
  return '';
}

/**
 * His own request, read off a description's `## Asked` section (SP-213):
 * the fenced block under that heading, as the intake loop writes it. Its
 * first line is his title; the text after the first blank line is his
 * prompt, and a one-line request is both. `slicedFrom` is the ticket id an
 * `## Order` section names in `Sliced from SP-<n>`, or null. Returns
 * `{ title, words, slicedFrom }`, or null when there is no `## Asked`
 * heading, no fence right under it, or the fence never closes. Headings
 * inside a fence are never read as sections. Text only: nothing is escaped
 * or reformatted here.
 */
export function originalRequest(description) {
  const lines = String(description ?? '').replace(/\r\n?/g, '\n').split('\n');
  const sections = new Map();
  let run = null;
  lines.forEach((line, i) => {
    if (run) { if (closesFence(line, run)) run = null; return; }
    const fence = FENCE.exec(line);
    if (fence) { run = fence[1]; return; }
    const h = /^##\s+(Asked|Order)\s*$/i.exec(line);
    if (h && !sections.has(h[1].toLowerCase())) sections.set(h[1].toLowerCase(), i);
  });
  if (!sections.has('asked')) return null;
  let i = sections.get('asked') + 1;
  while (i < lines.length && !lines[i].trim()) i += 1;
  const open = FENCE.exec(lines[i] ?? '');
  if (!open) return null;
  const body = [];
  for (i += 1; i < lines.length && !closesFence(lines[i], open[1]); i += 1) body.push(lines[i]);
  if (i >= lines.length) return null;
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body.at(-1).trim()) body.pop();
  if (!body.length) return null;
  const title = body[0].trim();
  const blank = body.findIndex((l) => !l.trim());
  const words = blank === -1 ? body.join('\n') : body.slice(blank + 1).join('\n').replace(/^\n+/, '');
  let slicedFrom = null;
  if (sections.has('order')) {
    for (let j = sections.get('order') + 1; j < lines.length && !HEADING.test(lines[j]); j += 1) {
      const m = /^\s*Sliced from\s+([A-Za-z][A-Za-z0-9]*-\d+)\b/.exec(lines[j]);
      if (m) { slicedFrom = m[1].toUpperCase(); break; }
    }
  }
  return { title, words, slicedFrom };
}

/** The tag a website visitor's bug report is filed with (StarCaster's composeBugReportTask). */
export const BUG_REPORT_TAG = 'bug-report';

/**
 * A website visitor's bug report, read off a ticket (SP-286): only for a
 * ticket tagged BUG_REPORT_TAG whose description has a `## What the reporter
 * said` section with a fenced block under it, and no `## Asked` section (a
 * report intake has rewritten shows his request instead). Returns
 * `{ words, facts, screenshots }`: the visitor's words exactly as typed
 * (line breaks kept), the `## Where and who` bullets as `{ label, value }`
 * (`- **Page:** …`, the value's code backticks taken off), and whether the
 * `## Screenshots` section holds anything but "(none attached)". Null
 * otherwise. Headings inside a fence are never read as sections. Text only:
 * nothing is escaped here.
 */
export function bugReport({ tags = [], description } = {}) {
  if (!(tags ?? []).includes(BUG_REPORT_TAG)) return null;
  const lines = String(description ?? '').replace(/\r\n?/g, '\n').split('\n');
  const sections = new Map();
  let run = null;
  lines.forEach((line, i) => {
    if (run) { if (closesFence(line, run)) run = null; return; }
    const fence = FENCE.exec(line);
    if (fence) { run = fence[1]; return; }
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h && !sections.has(h[1].toLowerCase())) sections.set(h[1].toLowerCase(), i);
  });
  if (sections.has('asked') || !sections.has('what the reporter said')) return null;
  // A section's lines: up to the next heading that is not inside a fence.
  const starts = [...sections.values()].sort((a, b) => a - b);
  const sectionLines = (name) => {
    if (!sections.has(name)) return [];
    const from = sections.get(name);
    const to = starts.find((s) => s > from) ?? lines.length;
    return lines.slice(from + 1, to);
  };
  const said = sectionLines('what the reporter said');
  let i = 0;
  while (i < said.length && !said[i].trim()) i += 1;
  const open = FENCE.exec(said[i] ?? '');
  if (!open) return null;
  const body = [];
  for (i += 1; i < said.length && !closesFence(said[i], open[1]); i += 1) body.push(said[i]);
  if (i >= said.length) return null;
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body.at(-1).trim()) body.pop();
  const facts = [];
  for (const line of sectionLines('where and who')) {
    const m = /^\s*[-*+]\s+\*\*([^*]+?):?\*\*:?\s*(.*)$/.exec(line);
    if (m) facts.push({ label: m[1].replace(/:$/, '').trim(), value: m[2].trim().replace(/^`([^`]*)`$/, '$1') });
  }
  const shots = sectionLines('screenshots').map((l) => l.trim())
    .filter((l) => l && !RULE.test(l) && !/^_.*_$/.test(l) && l !== '(none attached)');
  return { words: body.join('\n'), facts, screenshots: shots.length > 0 };
}

/** One `## Where and who` fact as a list row: a page (bare, or one markdown link) is a link, a submitted time reads in Mountain time. */
function bugReportFact({ label, value }) {
  const key = label.toLowerCase();
  let shown = escapeHtml(value);
  // An older ClickUp-imported report writes its page as one markdown link (SP-314).
  const md = /^\[([^\[\]]*)\]\((https?:\/\/[^\s()]+)\)$/.exec(value);
  if (key === 'page' && /^https?:\/\/\S+$/.test(value)) shown = link(value, escapeHtml(value));
  else if (key === 'page' && md) shown = link(md[2], escapeHtml(md[1] || md[2]));
  else if (key === 'submitted' && !Number.isNaN(Date.parse(value)) && /\d{4}-\d{2}-\d{2}T/.test(value)) shown = escapeHtml(mountainTime(value));
  return `<li><span class="fact-label">${escapeHtml(label)}:</span> ${shown}</li>`;
}

/** The newest comment that carries an operator card, or undefined. */
const newestCard = (comments = []) => [...comments].reverse().find((c) => cardAsk(c.body) !== null);

/**
 * The words an inline `code` span must start with to read as a command he
 * could run, rather than a file name, a status or a quoted phrase (SP-169).
 * `scripts/` matches any path under the scripts folder. A span is a command
 * when its first word is one of these and something follows it (`git` alone
 * is a word in a sentence, `git status` is a command); a `scripts/…` path is
 * a command on its own. Add a word here to offer its commands for copying.
 */
export const COMMAND_WORDS = Object.freeze([
  'npm', 'node', 'npx', 'git', 'gh', 'bash', 'sh', 'cd', 'doppler', 'launchctl', 'sqlite3', 'curl', 'open', 'scripts/',
]);

/** Does an inline code span's text read as a command (COMMAND_WORDS)? */
export function isCommand(text) {
  const words = String(text ?? '').trim().split(/\s+/);
  const first = words[0] ?? '';
  if (COMMAND_WORDS.includes(first)) return words.length > 1;
  return COMMAND_WORDS.some((w) => w.endsWith('/') && first.startsWith(w) && first.length > w.length);
}

/** The lines of `lines` outside fenced blocks: a fence and what it holds are left out. */
function outsideFences(lines) {
  const out = [];
  let run = null;
  for (const line of lines) {
    if (run) { if (closesFence(line, run)) run = null; continue; }
    const fence = FENCE.exec(line);
    if (fence) { run = fence[1]; continue; }
    out.push(line);
  }
  return out;
}

const CODE_SPAN = /`([^`\n]+)`/g;

/** The inline code spans in `text` that read as commands, trimmed, in order. */
function inlineCommands(text) {
  return [...String(text ?? '').matchAll(CODE_SPAN)].map((m) => m[1].trim()).filter(isCommand);
}

/**
 * The commands an operator card gives him to run. First the text of each
 * fenced block in its banner, without the fence, blank lines at either end,
 * trailing spaces or an indent every line shares. Then each inline `code`
 * span in its "WHAT'S GOING ON" text and its ask that reads as a command
 * (isCommand), so a command written mid-sentence gets a Copy box too
 * (SP-169). Each command once, at its first place. [] when the comment
 * carries no card or the card names no command.
 */
export function cardCommands(body) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const banner = findBanner(lines, '');
  if (!banner) return [];
  const commands = [];
  const askText = outsideFences(banner.ask).join('\n');
  for (const command of [...fencedCommands(banner.ask), ...inlineCommands(cardContext(body)), ...inlineCommands(askText)]) {
    if (!commands.includes(command)) commands.push(command);
  }
  return commands;
}

/** The text of each closed fenced block in an ask's lines, tidied (cardCommands). */
function fencedCommands(ask) {
  const commands = [];
  for (let i = 0; i < ask.length; i += 1) {
    const fence = FENCE.exec(ask[i]);
    if (!fence) continue;
    const block = [];
    i += 1;
    while (i < ask.length && !closesFence(ask[i], fence[1])) block.push(ask[i++]);
    if (i >= ask.length) break; // never closed: not a command he can trust
    while (block.length && !block[0].trim()) block.shift();
    while (block.length && !block.at(-1).trim()) block.pop();
    if (!block.length) continue;
    const indent = Math.min(...block.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length));
    commands.push(block.map((l) => l.slice(indent).replace(/\s+$/, '')).join('\n'));
  }
  return commands;
}

/**
 * The commands of a ticket's newest operator card, for the right side of its
 * Quick Action section, as HTML: each one escaped, with its own Copy button.
 * The page copies the `<code>` element's text, so what lands on the
 * clipboard is exactly what is drawn. '' when the card has no command.
 */
export function renderCommands({ comments = [] }) {
  const card = newestCard(comments);
  const commands = card ? cardCommands(card.body) : [];
  if (!commands.length) return '';
  const rows = commands.map(renderCopyRow);
  return `<div class="commands">${rows.join('')}</div>`;
}

const FILES_MADE_HEAD = 'Files made by this ticket:';
const MERGE_NOTE = /^Merged: PR #\d+/m;
const FILE_LINE = /^- (.+): (\S+)$/;
const FILES_MORE = /^- and (\d+) more:/;

/**
 * The newest merge note's file list (SP-166 writes it, SP-170 draws it):
 * `{ files: [{ path, href }], more }`, `more` the count the note left
 * unnamed. Only a loop's comment counts (a person quoting one is not a
 * merge), and only an http(s) link is kept: any other line under the
 * heading is left out, never drawn as a link.
 */
function newestFilesNote(comments = []) {
  for (const c of [...comments].reverse()) {
    if (!c?.machine) continue;
    const body = String(c.body ?? '').replace(/\r\n?/g, '\n');
    if (!MERGE_NOTE.test(body)) continue;
    const lines = body.split('\n');
    const start = lines.findIndex((l) => l.trim() === FILES_MADE_HEAD);
    if (start === -1) continue;
    const files = [];
    let more = 0;
    for (const raw of lines.slice(start + 1)) {
      const line = raw.trim();
      if (!line.startsWith('- ')) break;
      const extra = FILES_MORE.exec(line);
      if (extra) { more = Number(extra[1]); continue; }
      const m = FILE_LINE.exec(line);
      if (m && /^https?:\/\//i.test(m[2])) files.push({ path: m[1], href: m[2] });
    }
    return { files, more };
  }
  return { files: [], more: 0 };
}

/**
 * The files a ticket made, from the newest merge note that lists them:
 * `[{ path, href }]`, [] when no merge note has a list.
 */
export function filesMade(comments = []) {
  return newestFilesNote(comments).files;
}

/**
 * The Files Made box for a ticket's page, as HTML: each file's path, escaped,
 * linking to the file in a new tab. '' when the ticket made no file, so
 * nothing is drawn, not even the heading.
 */
export function renderFilesMade({ comments = [] }) {
  const { files, more } = newestFilesNote(comments);
  if (!files.length) return '';
  const rows = files.map((f) => `<li>${link(f.href, escapeHtml(f.path))}</li>`);
  const rest = more ? `<p class="quiet">And ${escapeHtml(more)} more: see the pull request's Files changed tab.</p>` : '';
  return `<section class="files-made"><h2>Files Made</h2><ul>${rows.join('')}</ul>${rest}</section>`;
}

/**
 * What each status means for him, in one line (SP-118, SP-290): shown behind
 * the information icon beside "Status: <status>" under the ticket's heading.
 * The machine's statuses say nothing is needed; his two say what is.
 */
export const STATUS_LINES = {
  requested: 'The intake loop is writing it up as a spec. Nothing is needed from you.',
  queued: 'It waits for the build loop to pick it up. Nothing is needed from you.',
  building: 'The build loop is working on it. Nothing is needed from you.',
  'in review': 'The review loop is checking the pull request. Nothing is needed from you.',
  rework: 'The build loop is fixing what review found. Nothing is needed from you.',
  'needs your input': 'The loop is waiting on your answer below.',
  'ready to launch': 'The work is built and checked, and waits on your Merge.',
  live: 'It is done. Nothing is needed from you.',
};

/**
 * The information line once his move is made (SP-290 send-back): his answer
 * is in, or his merge word stands, so the page has dropped the ask and the
 * Merge, and the line must not ask him again. Wins over STATUS_LINES, in the
 * order statusLabel names them.
 */
export const ANSWER_IN_LINE = 'Your answer is in; the loop takes it from here. Nothing is needed from you.';
export const MERGE_STANDS_LINE = 'Your merge word is in; the relay merges it on its next pass. Nothing is needed from you.';

/**
 * The information line once a Ready to launch ticket's pull request is past
 * the merge (SP-290 second send-back, SP-226's prSettled): merged, or closed
 * without merging. Wins over the merge word and the bare status, because the
 * page has dropped the Merge in both cases.
 */
export const PR_MERGED_LINE = 'The pull request is merged; the relay moves this to Live on its next pass. Nothing is needed from you.';
export const PR_CLOSED_LINE = 'The pull request was closed without merging; see the note below.';

/**
 * The information line for one of his two statuses while his move is still
 * to make (SP-290 third send-back): it names the move the page's own buttons
 * offer, decided by the same tests the buttons use (offersMerge,
 * offersClose), never by the bare status. Close wins over the status's own
 * line; a Ready to launch ticket with no Merge to offer (no pull request,
 * no merge word, or a card asking for a reply) points at the reply box.
 */
export const CLOSE_LINE = 'It waits on your Close; the card below says why.';
export const REPLY_LINE = 'It waits on your reply below.';

/** The line for his statuses, from the move the page offers (see CLOSE_LINE). */
function hisMoveLine(t, state) {
  if (heldBugReport(t)) return HELD_REPORT_STATUS_LINE;
  if (offersClose(t)) return CLOSE_LINE;
  if (state === READY_TO_LAUNCH) return offersMerge(t) ? STATUS_LINES[state] : REPLY_LINE;
  return STATUS_LINES[state];
}

/**
 * The ticket's status, first under its heading (SP-290): "Status: Queued" in
 * the page's own type, the status as statusLabel writes it, and beside it an
 * information button whose line (STATUS_LINES, or ANSWER_IN_LINE /
 * MERGE_STANDS_LINE once his move is made, or PR_MERGED_LINE /
 * PR_CLOSED_LINE once the pull request is past the merge, or on his two
 * statuses the move the page's buttons offer, hisMoveLine) shows on hover,
 * on tap (the page toggles aria-expanded) and from the keyboard. Takes the
 * page's whole ticket, as the buttons do. '' with no status; no button for
 * a status with no line.
 */
export function renderStatusLine(t) {
  const { status, answerIn = false, mergeStands = false, pullRequestState = null } = t;
  const state = String(status ?? '').trim().toLowerCase();
  if (!state) return '';
  const settled = prSettled({ status, pullRequestState })
    ? (pullRequestState.state === 'MERGED' ? PR_MERGED_LINE : PR_CLOSED_LINE)
    : null;
  const line = settled ?? (answerIn ? ANSWER_IN_LINE : mergeStands ? MERGE_STANDS_LINE
    : HIS_STATUSES.includes(state) ? hisMoveLine(t, state) : STATUS_LINES[state]);
  const info = line
    ? `<button type="button" class="status-info" title="Status Information" aria-label="Status Information" aria-expanded="false" aria-describedby="status-tip">${INFO_ICON}</button>`
      + `<span class="status-tip" id="status-tip" role="tooltip">${escapeHtml(line)}</span>`
    : '';
  return `<p class="status-line">Status: <span class="status-name">${escapeHtml(statusLabel({ status, answerIn, mergeStands }))}</span>${info}</p>`;
}

/** Where `line`'s inline code spans sit, as [start, end) pairs: nothing inside one is ever split. */
const codeRanges = (line) => [...line.matchAll(CODE_SPAN)].map((m) => [m.index, m.index + m[0].length]);
const inCode = (ranges, at) => ranges.some(([from, to]) => at >= from && at < to);

/** `line` cut at each index in `cuts` (ascending), every piece trimmed, empty pieces dropped. */
function cutAt(line, cuts) {
  const pieces = [];
  let last = 0;
  for (const at of [...cuts, line.length]) {
    pieces.push(line.slice(last, at).trim());
    last = at;
  }
  return pieces.filter(Boolean);
}

/**
 * Where an option begins in `line` (`A) …`, `B) …`): the indexes of a run of
 * markers lettered A, B, C… in order, each at the line's start or after a
 * space, none inside inline code. Only a run counts, so "plan B) later" in a
 * sentence is not an option list.
 */
function optionStarts(line, ranges) {
  const marks = [...line.matchAll(/(^|\s)([A-Z])\)\s/g)]
    .map((m) => ({ at: m.index + m[1].length, letter: m[2] }))
    .filter((m) => !inCode(ranges, m.at));
  const run = [];
  for (const m of marks) {
    const want = String.fromCharCode('A'.charCodeAt(0) + run.length);
    if (m.letter === want) run.push(m.at);
    else if (m.letter === 'A') { run.length = 0; run.push(m.at); }
  }
  return run;
}

/**
 * The red ask of a card laid out as paragraphs of lines, so it reads as
 * steps rather than one block (SP-169): `Options:` starts a new paragraph,
 * each option (`A) …`, `B) …`) and the `Your move:` line start a line of
 * their own, whether the card wrote them on separate lines or ran them
 * together. Lines already split stay as written, and nothing inside inline
 * code or a fenced block is ever cut. Text only: the words are not changed.
 */
export function askParagraphs(ask) {
  const paragraphs = [[]];
  let run = null;
  for (const raw of String(ask ?? '').split('\n')) {
    if (run) { if (closesFence(raw, run)) run = null; paragraphs.at(-1).push(raw); continue; }
    const fence = FENCE.exec(raw);
    if (fence) { run = fence[1]; paragraphs.at(-1).push(raw); continue; }
    const ranges = codeRanges(raw);
    const cuts = new Set();
    for (const m of raw.matchAll(/\s(?=Options:|Your move:)/g)) if (!inCode(ranges, m.index)) cuts.add(m.index);
    const options = optionStarts(raw, ranges);
    const listed = /^\s*Options:/.test(raw) || /\sOptions:/.test(raw);
    if (options.length > 1 || (options.length && listed)) options.forEach((at) => cuts.add(at));
    const pieces = raw.trim() ? cutAt(raw, [...cuts].sort((a, b) => a - b)) : [raw];
    for (const piece of pieces) {
      if (/^Options:/.test(piece) && paragraphs.at(-1).length) paragraphs.push([]);
      paragraphs.at(-1).push(piece);
    }
  }
  return paragraphs.filter((p) => p.length);
}

/**
 * The left side of a ticket page's Quick Action section, as HTML: the
 * ticket's title, a short description and, in bold red, what is needed. The
 * short description is the newest operator card's "WHAT'S GOING ON" text, or
 * the description's first paragraph when no comment carries a card. What is
 * needed is that newest card's ask, drawn only while the ticket is in one of
 * his two statuses and his answer is not in (renderAnswerIn); a card stays in
 * the thread after he answers, and its ask is no longer his move (SP-118).
 * Under the heading (and the Ticket name line) comes renderStatusLine.
 *
 * When the description carries his `## Asked` request (SP-213), his own
 * words come first: his title is the heading (the ticket's current name on a
 * quiet line under it when a loop renamed it), then his words exactly as he
 * typed them under "Original Request", a link to the ticket a slice was cut
 * from, and only then the summary, under "How the Loop Understood It".
 *
 * A website visitor's bug report (bugReport, SP-286) has no `## Asked`:
 * its heading is "Bug Report:" in place of the name the sending app cut off,
 * then the visitor's words in bold, then the `## Where and who` facts, and
 * the description's first paragraph (its "(none attached)" line) is never
 * the summary.
 */
export function renderQuickAction(t) {
  const { name, description, status, tags = [], comments = [], answerIn = false, mergeStands = false, pullRequestState = null } = t;
  const card = newestCard(comments);
  const report = bugReport({ tags, description });
  // A bug report's first paragraph is its "(none attached)" screenshots line (SP-286): only a card's context is a summary.
  const fallback = report ? '' : firstParagraph(description);
  const summary = card ? cardContext(card.body) ?? fallback : fallback;
  const state = String(status ?? '').toLowerCase();
  const his = HIS_STATUSES.includes(state);
  // SP-226: a merged or closed PR is past the card's "Your move: Merge".
  // SP-285: nor is it his move while his merge word still stands.
  const ask = card && his && !answerIn && !mergeStands && !prSettled({ status, pullRequestState }) ? cardAsk(card.body) : null;
  const asked = originalRequest(description);
  const top = asked ? [
    `<h1>${escapeHtml(asked.title)}</h1>`,
    String(name ?? '').trim() !== asked.title ? `<p class="ticket-name quiet">Ticket name: ${escapeHtml(name)}</p>` : '',
    renderStatusLine(t),
    '<h2 class="request-heading">Original Request</h2>',
    `<p class="original-request">${escapeHtml(asked.words)}</p>`,
    asked.slicedFrom ? `<p class="sliced-from">Sliced from <a href="/t/${escapeHtml(asked.slicedFrom)}">${escapeHtml(asked.slicedFrom)}</a></p>` : '',
    summary ? '<h2 class="request-heading">How the Loop Understood It</h2>' : '',
  ] : report ? [
    '<h1>Bug Report:</h1>',
    renderStatusLine(t),
    `<p class="bug-words">${escapeHtml(report.words)}</p>`,
    report.facts.length ? `<ul class="bug-facts">${report.facts.map(bugReportFact).join('')}</ul>` : '',
    report.screenshots ? '<p class="bug-shots quiet">Screenshots are attached: see the description under Details.</p>' : '',
  ] : [`<h1>${escapeHtml(name)}</h1>`, renderStatusLine(t)];
  return [
    ...top,
    summary ? `<p class="summary">${renderInline(summary)}</p>` : '',
    ask ? askParagraphs(ask).map((p) => `<p class="needed">${p.map(renderInline).join('<br>')}</p>`).join('\n') : '',
  ].filter(Boolean).join('\n');
}

/** The status the relay merges from, as the tracker stores it (lib/mergeOnComment.js). */
const READY_TO_LAUNCH = 'ready to launch';
/** The two statuses that are his, where a card can ask him to close (lib/loopStatuses.js). */
const NEEDS_YOUR_INPUT = 'needs your input';
const HIS_STATUSES = [READY_TO_LAUNCH, NEEDS_YOUR_INPUT];

/**
 * The move an operator card ends its ask with, `Your move: Merge`, `Close`
 * or `Reply` (SP-68), as 'Merge' | 'Close' | 'Reply', or null when the
 * comment carries no card or its ask names no move. The same rule `ask`
 * enforces (readYourMove in lib/operatorCard.js), read off the ask as drawn.
 */
export function cardMove(body) {
  const lines = String(cardAsk(body) ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const m = /^\**\s*Your move:\s*\**\s*(Merge|Close|Reply)\b/i.exec(lines.at(-1) ?? '');
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : null;
}

/** The short note beside the status of a ticket whose answer is in (SP-93). */
export const ANSWER_IN_NOTE = 'your answer is in';

/**
 * The short note beside the status of a Ready to launch ticket whose merge
 * word still stands (SP-285): he said it, a machine has written since (a
 * conflict hand-off), and the relay merges on its own once it can.
 */
export const MERGE_STANDS_NOTE = 'your merge word stands';

/**
 * A ticket's status as the page writes it, with ANSWER_IN_NOTE after it
 * when his answer is in: "Ready to launch · your answer is in", or
 * MERGE_STANDS_NOTE when his merge word still stands. Plain text.
 */
export function statusLabel({ status, answerIn = false, mergeStands = false }) {
  const name = String(status ?? '').replace(/^./, (c) => c.toUpperCase());
  if (answerIn) return `${name} · ${ANSWER_IN_NOTE}`;
  return mergeStands ? `${name} · ${MERGE_STANDS_NOTE}` : name;
}

/**
 * The ticket page's held-up line (SP-228), from the server's `heldUp`
 * (pageData.heldUpBy): "Held up: Relay keeps failing since 9:00 pm", or ''
 * when no failing lane owes the next move. `timeOf` writes the time, the
 * same way the header's health line does. It goes above the card, so it is
 * read before any "Your move".
 */
export function heldUpLine({ heldUp = null } = {}, timeOf) {
  if (!heldUp || typeof heldUp.stage !== 'string' || !heldUp.stage) return '';
  const reason = typeof heldUp.reason === 'string' && heldUp.reason ? heldUp.reason : 'keeps failing';
  return heldUp.since ? `Held up: ${heldUp.stage} ${reason} since ${timeOf(heldUp.since)}` : `Held up: ${heldUp.stage} ${reason}`;
}

/**
 * The ticket page's same-file lines (SP-349), from the server's
 * `sharedFiles` (pageData.sharedFilesOf): one "Changes the same files as
 * SP-12 (PR #40): a.js, b.js" per other open pull request that shares a
 * file with this ticket's, the ticket and the pull request linked; '' when
 * none does.
 */
export function renderSharedFiles({ sharedFiles = [] } = {}) {
  const rows = (Array.isArray(sharedFiles) ? sharedFiles : []).filter((s) => s && Number.isInteger(s.number) && Array.isArray(s.files) && s.files.length);
  if (!rows.length) return '';
  const line = (s) => {
    const pr = /^https:\/\/github\.com\//.test(String(s.url ?? ''))
      ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">PR #${s.number}</a>`
      : `PR #${s.number}`;
    const who = s.ticket
      ? `<a href="/t/${encodeURIComponent(s.ticket)}"${s.ticketName ? ` title="${escapeHtml(s.ticketName)}"` : ''}>${escapeHtml(s.ticket)}</a> (${pr})`
      : pr;
    return `<li>Changes the same files as ${who}: ${s.files.map((f) => `<code>${escapeHtml(f)}</code>`).join(', ')}</li>`;
  };
  return `<ul class="shared-files">${rows.map(line).join('')}</ul>`;
}

/** heldUpLine as HTML, a `<p class="held-up">`, or ''. */
export function renderHeldUp(t, timeOf) {
  const line = heldUpLine(t, timeOf);
  return line ? `<p class="held-up" role="status">${escapeHtml(line)}</p>` : '';
}

/**
 * The one line that stands in for the Merge, Close and Go buttons once his
 * answer is in (the server's `answerIn`), as HTML, or ''. The buttons stay
 * away until the relay answers: its comment becomes the newest, and the
 * server stops saying so. No minutes are spelled out; the relay's interval
 * lives in the installer.
 */
export function renderAnswerIn({ answerIn = false, mergeStands = false }) {
  if (answerIn) return '<p class="answer-in">Your answer is in. The relay acts on it at its next pass.</p>';
  // SP-285: said, then a machine wrote (a conflict hand-off). Still his answer.
  if (mergeStands) return '<p class="answer-in">Your merge word stands. The relay merges this on its own as soon as it can; you do not need to say it again.</p>';
  return '';
}

/**
 * The ticket page's reply box, as HTML, or '' once his answer is in
 * (SP-160). While it is in, his comment is the newest word and the relay
 * acts on it at its next pass, so a second reply typed in that gap would
 * quietly overrule the first. The box comes back with the relay's comment,
 * exactly as Merge, Close and Go do. `name` is who the reply posts as.
 * Never on a held bug report (heldBugReport, SP-287): nothing reads a
 * reply there, so its Approve and Reject stand in its place.
 */
export function renderReplyForm(t, name) {
  const { answerIn = false } = t ?? {};
  if (answerIn) return '';
  // SP-291: while a loop has the ticket nothing asks him for a reply; renderCommentForm stands in.
  if (loopHasIt(t)) return '';
  // SP-287: no loop reads a reply on a held bug report; renderBugReportActions stands in.
  if (heldBugReport(t)) return '';
  return `<form class="reply">
        <label for="reply">Reply as ${escapeHtml(name ?? 'you')}</label>
        <textarea id="reply" required></textarea>
        <div class="row"><button type="submit" class="btn">Post Reply</button><span class="note"></span></div>
      </form>`;
}

/**
 * The six statuses in which a loop has the ticket (SP-291): nothing on its
 * page asks him for a reply, so the right column shows the ticket itself.
 * His two (Needs your input, Ready to launch) are not here, nor is a status
 * the page does not know, which keeps today's layout.
 */
export const LOOP_HAS_STATUSES = Object.freeze(['requested', 'queued', 'building', 'in review', 'rework', 'live']);

/** Does a loop have this ticket (LOOP_HAS_STATUSES)? */
export function loopHasIt({ status } = {}) {
  return LOOP_HAS_STATUSES.includes(String(status ?? '').toLowerCase());
}

/**
 * The Add Comment box under a loop ticket's comments (SP-291), as HTML, or
 * '' on any other ticket (his two statuses keep the reply box). It posts
 * through the same comments route as the reply box, so a note on a Queued
 * ticket is there when the build loop reads it.
 */
export function renderCommentForm(t) {
  if (!loopHasIt(t)) return '';
  return `<form class="add-comment">
        <label for="add-comment">Add a Note for the Loop</label>
        <textarea id="add-comment" required></textarea>
        <div class="row"><button type="submit" class="btn">Add Comment</button><span class="note"></span></div>
      </form>`;
}

/**
 * The Merge button for a ticket page's Quick Action section, as HTML, or ''.
 * Shown only on a Ready to launch ticket with a pull request of its own
 * (SP-64 showed Merge on a ticket that had none) whose newest card does not
 * name another move, and only when the server named a merge phrase. The
 * phrase comes from the server (the project config's first mergePhrases
 * entry); the button posts it as his reply and the relay does the merge,
 * exactly as if he had typed it. Never once his answer is in (renderAnswerIn).
 */
export function renderMergeAction({ status, mergePhrase, pullRequest, pullRequestState = null, comments = [], answerIn = false, mergeStands = false }) {
  const line = renderPullRequestState({ status, pullRequest, pullRequestState });
  if (prSettled({ status, pullRequestState })) return line;
  if (answerIn || mergeStands) return line;
  if (String(status ?? '').toLowerCase() !== READY_TO_LAUNCH || !mergePhrase || !pullRequest) return line;
  if (!offersMerge({ status, mergePhrase, pullRequest, pullRequestState, comments, answerIn, mergeStands })) return '';
  return `${line}<form class="merge-action">
        <button type="submit" class="btn btn-primary">Merge</button><span class="note"></span>
        <p class="quiet">Posts &ldquo;${escapeHtml(mergePhrase)}&rdquo; as your reply; the relay merges it within a few minutes.</p>
      </form>`;
}

/**
 * Does the page offer the Merge button (renderMergeAction)? A Ready to
 * launch ticket with a pull request, a merge word from the server, nothing
 * settled or said yet, and a newest card that names no other move. The
 * status line's "i" asks the same (hisMoveLine), so the two never disagree.
 */
export function offersMerge({ status, mergePhrase, pullRequest, pullRequestState = null, comments = [], answerIn = false, mergeStands = false }) {
  if (prSettled({ status, pullRequestState }) || answerIn || mergeStands) return false;
  if (String(status ?? '').toLowerCase() !== READY_TO_LAUNCH || !mergePhrase || !pullRequest) return false;
  const card = newestCard(comments);
  const move = card ? cardMove(card.body) : null;
  // A regex, not a quoted word: the page's code spells no merge phrase.
  return !move || /^Merge$/.test(move);
}

/**
 * Is a Ready to launch ticket's pull request already past the merge
 * (SP-226)? Merged or closed on GitHub, by the server's live read. A read
 * that failed (state null) or was not made is never settled: a failed read
 * must not hide a real merge.
 */
export function prSettled({ status, pullRequestState = null }) {
  if (String(status ?? '').toLowerCase() !== READY_TO_LAUNCH) return false;
  return pullRequestState?.state === 'MERGED' || pullRequestState?.state === 'CLOSED';
}

/**
 * The one line a Ready to launch ticket's page shows about its pull
 * request's live state (SP-226), as HTML, or '' when there is nothing to
 * say (an open PR, no PR, no read made, another status). Merged or closed
 * stands in place of the Merge button; "could not check" goes above it.
 */
export function renderPullRequestState({ status, pullRequest = null, pullRequestState = null }) {
  if (String(status ?? '').toLowerCase() !== READY_TO_LAUNCH || !pullRequest || !pullRequestState) return '';
  const n = escapeHtml(pullRequestState.number ?? /\/pull\/(\d+)/.exec(pullRequest)?.[1] ?? '?');
  if (pullRequestState.state === 'MERGED') return `<p class="pr-state">PR #${n} is merged. The ticket has not moved to Live yet; that is the relay's job, not yours.</p>`;
  if (pullRequestState.state === 'CLOSED') return `<p class="pr-state">PR #${n} was closed without merging.</p>`;
  if (pullRequestState.state == null) return `<p class="pr-state quiet">Could not check PR #${n} on GitHub just now.</p>`;
  return '';
}

/** The one question the Merge button asks before it posts. Plain text, for confirm(). */
export function mergeQuestion({ name, pullRequest }) {
  const number = /\/pull\/(\d+)/.exec(pullRequest ?? '')?.[1];
  return `Merge ${number ? `PR #${number}` : 'the pull request'} for ${name}?`;
}

/**
 * The Close button, as HTML, or '': shown on a ticket in one of his two
 * statuses whose newest card's move is Close, when the server named a close
 * word (the relay's own close list, lib/busRelayPlan.js). Like Merge, it
 * only posts his word as a reply; the relay decides and moves the ticket.
 * Never once his answer is in (renderAnswerIn).
 */
export function renderCloseAction({ status, closePhrase, comments = [], answerIn = false }) {
  if (!offersClose({ status, closePhrase, comments, answerIn })) return '';
  // The relay's two close paths differ: on Ready to launch it waits for the
  // work to be merged; on Needs your input the hand-back closes it at once.
  const when = String(status).toLowerCase() === READY_TO_LAUNCH
    ? 'the relay closes it within a few minutes once its work is merged'
    : 'the relay closes it on its next pass, a few minutes from now';
  return `<form class="close-action">
        <button type="submit" class="btn">Close</button><span class="note"></span>
        <p class="quiet">Posts &ldquo;${escapeHtml(closePhrase)}&rdquo; as your reply; ${when}.</p>
      </form>`;
}

/**
 * Does the page offer the Close button (renderCloseAction)? One of his two
 * statuses, a close word from the server, his answer not in, and a newest
 * card whose move is Close. The status line's "i" asks the same.
 */
export function offersClose({ status, closePhrase, comments = [], answerIn = false }) {
  if (answerIn) return false;
  if (!HIS_STATUSES.includes(String(status ?? '').toLowerCase()) || !closePhrase) return false;
  const card = newestCard(comments);
  return Boolean(card) && cardMove(card.body) === 'Close';
}

/** The one question the Close button asks before it posts. Plain text, for confirm(). */
export function closeQuestion({ name }) {
  return `Close ${name}?`;
}

/**
 * The Go button, as HTML, or '': shown on a Needs your input ticket whose
 * newest card's move is Reply and whose ask offers the go word in quotes
 * (every card loop-intake posts), when the server named that word
 * (GO_PHRASE in lib/busRelayPlan.js). Like Merge and Close, it only posts
 * his word as a reply; any reply to an intake card queues it. Never once
 * his answer is in (renderAnswerIn).
 */
export function renderGoAction({ status, goPhrase, comments = [], answerIn = false }) {
  if (answerIn) return '';
  if (String(status ?? '').toLowerCase() !== NEEDS_YOUR_INPUT || !goPhrase) return '';
  const card = newestCard(comments);
  if (!card || cardMove(card.body) !== 'Reply') return '';
  const word = goPhrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`["\u201c]${word}["\u201d]`, 'i').test(cardAsk(card.body) ?? '')) return '';
  return `<form class="go-action">
        <button type="submit" class="btn btn-primary">Go</button><span class="note"></span>
        <p class="quiet">Posts &ldquo;${escapeHtml(goPhrase)}&rdquo; as your reply; the relay queues it on its next pass.</p>
      </form>`;
}

/** The one question the Go button asks before it posts. Plain text, for confirm(). */
export function goQuestion({ name }) {
  return `Send ${name} to the build queue?`;
}

/**
 * Is this a held bug report (SP-287)? A ticket tagged BUG_REPORT_TAG, in
 * Needs your input, with no operator card anywhere in its thread. A
 * visitor's report arrives that way: the hold itself is the approval gate,
 * and no loop reads a reply to it (the relay acts only on an answer to a
 * card). Once a loop has asked about it, the card's own buttons and the
 * reply box are back, exactly as on any other ticket.
 */
export function heldBugReport({ status, tags = [], comments = [] } = {}) {
  if (!(tags ?? []).includes(BUG_REPORT_TAG)) return false;
  if (String(status ?? '').toLowerCase() !== NEEDS_YOUR_INPUT) return false;
  return !(comments ?? []).some((c) => cardAsk(c?.body) !== null);
}

/** The tag a rejected ticket carries: the contract's "killing a ticket" (docs/LOOP_CONTRACT.md). */
export const WONT_DO_TAG = 'wont-do';

/** The note Reject posts on the ticket, after moving it: why it is Live with nothing shipped. */
export const REJECT_COMMENT = 'Rejected from the ticket page: this bug report will not be worked on, and nothing shipped for it.';

/** The one line that stands where the reply box was on a held bug report. */
export const HELD_REPORT_LINE = 'No loop reads a reply on a bug report held for you, so there is no reply box here. Approve or Reject it; the Change panel under Details still works for anything else.';

/** The status line's "i" on a held bug report: its move is a button, not an answer. */
export const HELD_REPORT_STATUS_LINE = 'It waits on you to Approve or Reject it below.';

/**
 * The Approve and Reject buttons on a held bug report (heldBugReport), and
 * the line that stands in for its reply box, as HTML, or '' on any other
 * ticket. Approve moves it to Requested, so the intake lane writes it up;
 * Reject moves it to Live with the wont-do tag and posts REJECT_COMMENT.
 * The page writes both itself (they are his own status changes, the same
 * ones the Change panel makes), and reads each one back.
 */
export function renderBugReportActions(t) {
  if (!heldBugReport(t)) return '';
  return `<form class="approve-action">
        <button type="submit" class="btn btn-primary">Approve</button><span class="note"></span>
        <p class="quiet">Moves it to Requested; the intake lane writes it up as a spec for you to say go to.</p>
      </form>
      <form class="reject-action">
        <button type="submit" class="btn btn-danger">Reject</button><span class="note"></span>
        <p class="quiet">Moves it to Live with the ${escapeHtml(WONT_DO_TAG)} tag and a note that nothing shipped.</p>
      </form>
      <p class="held-report quiet">${escapeHtml(HELD_REPORT_LINE)}</p>`;
}

/** The one question Approve asks before it writes. Plain text, for confirm(). */
export function approveQuestion({ name }) {
  return `Approve ${name} and send it to intake?`;
}

/** The one question Reject asks before it writes. Plain text, for confirm(). */
export function rejectQuestion({ name }) {
  return `Reject ${name}? It moves to Live with the ${WONT_DO_TAG} tag, and nothing is built.`;
}

/**
 * Did a page write stick? The server's answer to a change (`{ ticket }`)
 * read against what was asked: the status, and every tag asked for.
 * Answers '' when it did, or what did not, in plain words.
 */
export function changeProblem(answer, { status, tags = [] } = {}) {
  const t = answer?.ticket;
  if (!t) return 'the tracker did not answer with the ticket.';
  const missing = [];
  if (status && String(t.status ?? '').toLowerCase() !== status) missing.push(`the status reads "${t.status}", not "${status}"`);
  for (const tag of tags) if (!(t.tags ?? []).includes(tag)) missing.push(`the ${tag} tag is not on it`);
  return missing.length ? `${missing.join(' and ')}.` : '';
}

/**
 * The statuses a ticket may be deleted from, as the tracker stores them:
 * nobody has started it yet. The server holds the rule (store.mjs
 * DELETABLE) and refuses any other; this only decides where a Delete is drawn.
 */
const DELETABLE = Object.freeze(['requested', 'queued']);

/** True when the page offers to delete a ticket in `status` (either spelling: "Queued" or "queued"). */
export function canDelete(status) {
  return DELETABLE.includes(String(status ?? '').toLowerCase());
}

/** The one question a Delete asks before it sends anything. Plain text, for confirm(). */
export function deleteQuestion({ id, name }) {
  return `Delete ${id} "${name}"? This cannot be undone.`;
}

/**
 * Why a delete was refused, in plain words: started since the page was
 * drawn (409), already gone (404), or the server's own message.
 */
export function deleteRefusal(id, err) {
  if (err?.status === 409) return `Not deleted: ${id} has been started since this page was drawn, so it stays. Reload the page to see where it is now.`;
  if (err?.status === 404) return `Not deleted: ${id} is no longer in the tracker. Reload the page to see the list as it is now.`;
  return `Not deleted: ${err?.message ?? 'the tracker did not answer.'}`;
}

/** The ticket page's Delete button, as HTML, or '' when the ticket has been started. */
export function renderDeleteAction({ status }) {
  if (!canDelete(status)) return '';
  return `<form class="delete-action">
        <button type="submit" class="btn btn-danger">Delete</button><span class="note"></span>
        <p class="quiet">Nobody has started this ticket yet, so it can still be deleted, with its comments.</p>
      </form>`;
}

/**
 * The ticket page's Change panel, as HTML: priority, tags, assignee, status,
 * name and description, each with its own note for "Saving…", "Saved" or the
 * server's refusal. The choices come from the server's thread answer
 * (`choices`, `operator`); none is written here. The current status and
 * assignee always show, even when a person could not choose them. The name
 * is locked once a pull request is recorded: its title must match the name.
 * Files (SP-373) adds files to the ticket after it is filed: Upload sends
 * each picked file on its own and reports in the message strip.
 */
export function renderEditPanel({ name, description, status, priority, tags = [], assignee, operator, pullRequest, choices = {}, kind = null, startedBy = null, outcome = null }) {
  const statuses = choices.statuses ?? [];
  const current = String(status ?? '').toLowerCase();
  const statusOptions = [
    ...(statuses.some((s) => s.value === current) ? [] : [{ value: current, label: capital(status), fixed: true }]),
    ...statuses,
  ].map((s) => option(s.value, s.fixed ? `${s.label} (now)` : s.label, s.value === current)).join('');
  const priorityOptions = [
    ...(priority == null ? [option('', 'None', true)] : []),
    ...(choices.priorities ?? []).map((p) => option(p, capital(p), p === priority)),
  ].join('');
  const who = [
    ...(operator ? [option(operator.id, operator.name, assignee?.id === operator.id)] : []),
    ...(assignee && assignee.id !== operator?.id ? [option(assignee.id, `${assignee.name} (now)`, true)] : []),
    option('', 'Nobody', assignee == null),
  ].join('');
  // SP-345: the ticket's class. A choice the server no longer offers still shows, marked "(now)".
  // These three report a save in the message strip (UI_DOCTRINE 7), never beside themselves.
  const classOptions = (field, value) => {
    const offered = choices[field] ?? [];
    return [
      option('', 'None', value == null),
      ...(value != null && !offered.some((c) => c.value === value) ? [option(value, `${value} (now)`, true)] : []),
      ...offered.map((c) => option(c.value, c.label, c.value === value)),
    ].join('');
  };
  // Only a closed ticket has an ending (lib/ticketClass.js), so How It Ended waits until it is Live.
  const closed = current === 'live';
  const endedPicker = closed || outcome != null
    ? `<select id="edit-outcome" data-field="outcome">${classOptions('outcome', outcome)}</select>`
    : '<select id="edit-outcome" disabled aria-describedby="edit-outcome-hint"><option selected>Still Open</option></select><span class="hint" id="edit-outcome-hint">Set when the ticket closes.</span>';
  const chips = tags.map((tag) => `<span class="tag">${escapeHtml(tag)}<button type="button" class="remove-tag" data-tag="${escapeHtml(tag)}" title="Remove ${escapeHtml(tag)}" aria-label="Remove tag ${escapeHtml(tag)}">×</button></span>`).join('');
  const nameField = pullRequest
    ? `<p id="edit-name" class="locked">${escapeHtml(name)}</p>
          <p class="quiet">The name cannot change now: a pull request is recorded, and its title must match the name exactly.</p>`
    : `<div class="row"><input id="edit-name" class="field-long" type="text" value="${escapeHtml(name)}" required><button type="submit" class="btn btn-save">Save</button></div>`;
  return `<details class="edit" open>
      <summary>Change This Ticket</summary>
      <p class="note edit-note" role="status"></p>
      <form class="edit-fields fields">
        <div class="beside"><label for="edit-priority">Priority</label>
        <div class="row"><select id="edit-priority" data-field="priority">${priorityOptions}</select><span class="note" data-note="priority"></span></div></div>
        <div class="beside"><span class="label">Tags</span>
        <div class="row"><span class="tags">${chips || '<span class="quiet">none</span>'}</span><span class="note" data-note="tags"></span></div></div>
        <div class="beside"><label for="edit-tag">Add a Tag</label>
        <input id="edit-tag" type="text" placeholder="docs" aria-describedby="edit-tag-hint">
        <span class="hint" id="edit-tag-hint">Type a tag and press Enter.</span></div>
        <div class="beside"><label for="edit-assignee">Assigned To</label>
        <div class="row"><select id="edit-assignee" data-field="assignee">${who}</select><span class="note" data-note="assignee"></span></div></div>
        <div class="beside"><label for="edit-status">Status</label>
        <div class="row"><select id="edit-status" data-field="status">${statusOptions}</select><span class="note" data-note="status"></span></div></div>
        <div class="beside"><label for="edit-kind">Kind</label>
        <div class="row"><select id="edit-kind" data-field="kind">${classOptions('kind', kind)}</select></div></div>
        <div class="beside"><label for="edit-started-by">Started By</label>
        <div class="row"><select id="edit-started-by" data-field="startedBy">${classOptions('startedBy', startedBy)}</select></div></div>
        <div class="beside"><label for="edit-outcome">How It Ended</label>
        <div class="row">${endedPicker}</div></div>
        <div class="beside"><label for="edit-files">Files</label>
        <div class="row"><input id="edit-files" type="file" multiple aria-describedby="edit-files-hint"><button type="button" class="btn edit-upload">Upload</button></div>
        <span class="hint" id="edit-files-hint">Screenshots, PDFs or notes, up to 10 MB each.</span></div>
      </form>
      <form class="edit-name">
        <label for="edit-name">Name</label>
        ${nameField}
        <span class="note" data-note="name"></span>
      </form>
      <form class="edit-description">
        <div class="row"><label for="edit-description">Description</label><button type="button" class="btn edit-open">Edit</button><span class="note" data-note="description"></span></div>
        <div class="editor" hidden>
          <textarea id="edit-description">${escapeHtml(description ?? '')}</textarea>
          <div class="row"><button type="submit" class="btn btn-save">Save</button><button type="button" class="btn edit-cancel">Cancel</button></div>
        </div>
      </form>
    </details>`;
}

/**
 * The Change panel's Upload (SP-373): send each file on its own through
 * `send(file)`, so one that fails is named and the rest still go up. A file
 * over `max` bytes is never sent. Answers `{ uploaded, notUploaded, message }`:
 * the names that went up, each that did not with why, and the message for the
 * strip, an error whenever any did not, so a failure never reads as success.
 * A signed-out answer stops at once: `signedOut` is set and `notUploaded`
 * names that file and every one after it.
 */
export async function uploadEach(files, send, { max, isSignedOut = () => false, onEach = () => {} }) {
  const uploaded = [];
  const notUploaded = [];
  let signedOut = false;
  for (const [i, file] of files.entries()) {
    if (file.size > max) {
      notUploaded.push({ name: file.name, why: 'over 10 MB' });
      continue;
    }
    onEach(file);
    try {
      await send(file);
      uploaded.push(file.name);
    } catch (err) {
      if (isSignedOut(err)) {
        signedOut = true;
        for (const left of files.slice(i)) notUploaded.push({ name: left.name, why: 'signed out' });
        break;
      }
      notUploaded.push({ name: file.name, why: String(err?.message ?? err).replace(/\.$/, '') });
    }
  }
  const text = [
    uploaded.length ? `Uploaded ${uploaded.join(', ')}.` : '',
    notUploaded.length ? `Not uploaded: ${notUploaded.map((f) => `${f.name} (${f.why})`).join(', ')}.` : '',
  ].filter(Boolean).join(' ');
  return { uploaded, notUploaded, signedOut, message: { kind: notUploaded.length ? 'error' : 'success', text } };
}

/** What a save that found the ticket moved says: nothing was overwritten, and it is not tried again. */
export const MOVED_MESSAGE = 'Not saved: this ticket changed while you were looking at it (a loop moved it, or another page saved first), so nothing was overwritten. The page now shows what is stored; make your change again if it still applies.';
