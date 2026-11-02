/**
 * Ticket text to HTML, for Dane's page. Runs in the browser and, unchanged,
 * in the Node tests (tracker/web.test.mjs), so what is tested is what draws.
 *
 * EVERY CHARACTER OF TICKET TEXT IS ESCAPED BEFORE IT IS DRAWN. Descriptions
 * and comments are written by loops, by Dane and, once imported, by whatever
 * was in ClickUp; a `<script>` in any of them must show as the text
 * "<script>", never run. So nothing here passes ticket text through as
 * markup: the Markdown below is recognised on the raw text, each piece is
 * escaped, and only the tags this file writes itself reach the page. A link
 * is drawn only for an http(s) address.
 *
 * The Markdown is the small part loops and cards actually write: headings,
 * paragraphs, bullet and numbered lists, `- [ ]` checkboxes, fenced code,
 * rules, **bold**, *italic*, `code`, [links](https://…) and bare addresses
 * (so `PR opened: https://…` is clickable). Anything else shows as written.
 */

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text made safe to place anywhere in HTML, inside or outside an attribute. */
export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

/** A bare address ends before trailing punctuation that belongs to the sentence. */
function trimUrl(url) {
  const m = /^(.*?)([.,;:!?]*)$/.exec(url);
  return [m[1], m[2]];
}

function link(href, label) {
  return `<a href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank">${label}</a>`;
}

const INLINE = /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"'`)\]]+)|\*\*([^*\n]+)\*\*|\*([^*\s][^*\n]*)\*/g;

/** One line or paragraph of inline Markdown, escaped. */
export function renderInline(text) {
  const s = String(text ?? '');
  let out = '';
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    out += escapeHtml(s.slice(last, m.index));
    last = m.index + m[0].length;
    const [, code, label, href, bare, bold, italic] = m;
    if (code !== undefined) out += `<code>${escapeHtml(code)}</code>`;
    else if (label !== undefined) out += link(href, renderInline(label));
    else if (bare !== undefined) {
      const [url, tail] = trimUrl(bare);
      out += link(url, escapeHtml(url)) + escapeHtml(tail);
    } else if (bold !== undefined) out += `<strong>${renderInline(bold)}</strong>`;
    else out += `<em>${renderInline(italic)}</em>`;
  }
  return out + escapeHtml(s.slice(last));
}

const FENCE = /^\s*(`{3,}|~{3,})/;
/** Does `line` close a fence opened by `run`? Same character, at least as long, nothing after. */
const closesFence = (line, run) => {
  const m = FENCE.exec(line);
  return Boolean(m) && m[1][0] === run[0] && m[1].length >= run.length && !line.trim().slice(m[1].length).trim();
};
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const CHECKBOX = /^\[([ xX])\]\s+(.*)$/;

function listItem(text) {
  const box = CHECKBOX.exec(text);
  if (!box) return `<li>${renderInline(text)}</li>`;
  const done = box[1] !== ' ';
  return `<li class="check${done ? ' done' : ''}"><span class="box">${done ? '☑' : '☐'}</span> ${renderInline(box[2])}</li>`;
}

/** A block of Markdown, escaped, as HTML. */
export function renderMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    if (FENCE.test(line)) {
      const run = FENCE.exec(line)[1];
      const body = [];
      i += 1;
      while (i < lines.length && !closesFence(lines[i], run)) body.push(lines[i++]);
      i += 1; // the closing fence, or past the end of an unclosed one
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6); // the page's own h1/h2 sit above
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (RULE.test(line)) { out.push('<hr>'); i += 1; continue; }
    const before = i;
    for (const [pattern, tag] of [[BULLET, 'ul'], [NUMBERED, 'ol']]) {
      if (!pattern.test(line)) continue;
      const items = [];
      while (i < lines.length && pattern.test(lines[i])) items.push(listItem(pattern.exec(lines[i++])[1]));
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      break;
    }
    if (i === before) {
      const para = [];
      while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i])
        && !RULE.test(lines[i]) && !BULLET.test(lines[i]) && !NUMBERED.test(lines[i])) {
        para.push(renderInline(lines[i++]));
      }
      out.push(`<p>${para.join('<br>')}</p>`);
    }
  }
  return out.join('\n');
}

/** A line with any `**…**` wrapping taken off: the tracker stores a card's bold runs that way. */
const unbold = (line) => line.trim().replace(/^\*\*([\s\S]*)\*\*$/, '$1').trim();
const BANNER_RULE = /^#{20,}$/;
const BANNER_LABEL = /^NEEDED FROM [^:\n]+:/;
const RAW_SECTION = /^@@([A-Z]+)\s*$/;

/** A line with one `**…**` wrapping taken off, its indent kept. */
const unwrap = (line) => {
  const m = /^(\s*)\*\*([\s\S]*)\*\*\s*$/.exec(line);
  return (m ? m[1] + m[2] : line).replace(/\s+$/, '');
};

/**
 * The first index from `from` where `isEnd(lines[i])` holds outside a fenced
 * block (`run` is a fence already open at `from`), so a command line inside a
 * fence never ends a banner. A fence left open falls back to the first match
 * anywhere, so a broken card still ends where it used to.
 */
function endOutsideFences(lines, from, isEnd, peel, run = null) {
  let i = from;
  for (; i < lines.length; i += 1) {
    const line = peel(lines[i]);
    if (run) { if (closesFence(line, run)) run = null; continue; }
    const fence = FENCE.exec(line);
    if (fence) { run = fence[1]; continue; }
    if (isEnd(lines[i])) return i;
  }
  if (!run) return i;
  for (i = from; i < lines.length && !isEnd(lines[i]); i += 1);
  return i;
}

/**
 * Where an operator card's banner is in a comment: `{ start, end, lines, ask }`
 * over the comment's lines, or null. Two forms:
 *
 *  - as `ask` posts it: a rule of #, `NEEDED FROM <NAME>: <the ask>`, any
 *    more lines of the ask, a closing rule (each line maybe in `**…**`);
 *  - an authored card that reached the tracker unrendered: the `@@NEEDED`
 *    section, up to the next `@@` marker. Its label is `operatorName`'s.
 *
 * `lines` is the banner as drawn, each line trimmed, label first. `ask` is
 * the ask as written, without its label: one `**…**` layer off each line when
 * the tracker stored the banner bold, and nothing else touched, so a fenced
 * command inside it reads exactly as it was posted.
 */
function findBanner(lines, operatorName) {
  const label = lines.findIndex((l) => BANNER_LABEL.test(unbold(l)));
  if (label !== -1) {
    const start = label > 0 && BANNER_RULE.test(unbold(lines[label - 1])) ? label - 1 : label;
    const peel = /^\s*\*\*[\s\S]*\*\*\s*$/.test(lines[label]) ? unwrap : (l) => l;
    const first = unbold(lines[label]).replace(BANNER_LABEL, '').trim();
    const end = endOutsideFences(lines, label + 1, (l) => BANNER_RULE.test(unbold(l)), peel, FENCE.exec(first)?.[1]);
    const ask = [first, ...lines.slice(label + 1, end).map(peel)];
    return { start, end: Math.min(end + 1, lines.length), lines: lines.slice(label, end).map(unbold), ask };
  }
  const raw = lines.findIndex((l) => RAW_SECTION.exec(l.trim())?.[1] === 'NEEDED');
  if (raw === -1) return null;
  const end = endOutsideFences(lines, raw + 1, (l) => RAW_SECTION.test(l.trim()), (l) => l);
  const ask = lines.slice(raw + 1, end).map((l) => l.trim()).filter(Boolean);
  const who = String(operatorName || 'you').toUpperCase();
  return { start: raw, end, lines: [`NEEDED FROM ${who}: ${ask[0] ?? ''}`, ...ask.slice(1)], ask: lines.slice(raw + 1, end) };
}

/**
 * The ask in an operator card's banner, as plain text without its `NEEDED
 * FROM …:` label, or null when the comment carries no card. The hand-over
 * email (tracker/notify.mjs) reads a card through this, so it quotes the
 * same words the page draws in red.
 */
export function cardAsk(body) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const banner = findBanner(lines, '');
  if (!banner) return null;
  const [first, ...rest] = banner.lines;
  return [first.replace(BANNER_LABEL, ''), ...rest].join('\n').trim();
}

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

/**
 * The browser tab's title: `(N) Tracker` while N tickets wait on the person
 * signed in, so a pinned tab shows a hand-over without being opened, and the
 * page's own title when nothing waits (or the count could not be read).
 */
export function tabTitle(waitingCount, pageTitle) {
  return Number.isInteger(waitingCount) && waitingCount > 0 ? `(${waitingCount}) Tracker` : pageTitle;
}

/**
 * The header bell's colour for the same count: grey while nothing waits (or
 * the count is missing), yellow for one to three, red for more than three.
 */
export function bellColour(waitingCount) {
  if (!Number.isInteger(waitingCount) || waitingCount <= 0) return 'grey';
  return waitingCount <= 3 ? 'yellow' : 'red';
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

/** The newest comment that carries an operator card, or undefined. */
const newestCard = (comments = []) => [...comments].reverse().find((c) => cardAsk(c.body) !== null);

/**
 * The commands an operator card's ask gives him to run: the text of each
 * fenced block in its banner, without the fence, blank lines at either end,
 * trailing spaces or an indent every line shares. [] when the comment
 * carries no card or the ask has no fenced block.
 */
export function cardCommands(body) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const ask = findBanner(lines, '')?.ask ?? [];
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
  const rows = commands.map((c) => `<div class="command"><pre><code>${escapeHtml(c)}</code></pre><button type="button" class="copy-command">Copy</button></div>`);
  return `<div class="commands">${rows.join('')}</div>`;
}

/**
 * The left side of a ticket page's Quick Action section, as HTML: the
 * ticket's title, a short description and, in bold red, what is needed. The
 * short description is the newest operator card's "WHAT'S GOING ON" text, or
 * the description's first paragraph when no comment carries a card; what is
 * needed is that newest card's ask, and there is no red line without one.
 */
export function renderQuickAction({ name, description, comments = [] }) {
  const card = newestCard(comments);
  const summary = card ? cardContext(card.body) ?? firstParagraph(description) : firstParagraph(description);
  const ask = card ? cardAsk(card.body) : null;
  return [
    `<h1>${escapeHtml(name)}</h1>`,
    summary ? `<p class="summary">${renderInline(summary)}</p>` : '',
    ask ? `<p class="needed">${ask.split('\n').map(renderInline).join('<br>')}</p>` : '',
  ].filter(Boolean).join('\n');
}

/**
 * The trail under the main menu: where the page sits, as `{ label, href }`
 * steps from the outside in (Spirality > Task SP-47 > Details). Every step
 * before the last is a link back up; the last is the page itself and never
 * a link. Every label is escaped: project and ticket names are typed by
 * people.
 */
export function renderTrail(steps) {
  const parts = steps.map(({ label, href }, i) => {
    if (i === steps.length - 1) return `<span aria-current="page">${escapeHtml(label)}</span>`;
    return href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : `<span>${escapeHtml(label)}</span>`;
  });
  return `<nav class="trail" aria-label="You are here">${parts.join('<span class="sep"> &gt; </span>')}</nav>`;
}

/** The status the relay merges from, as the tracker stores it (lib/mergeOnComment.js). */
const READY_TO_LAUNCH = 'ready to launch';
/** The two statuses that are his, where a card can ask him to close (lib/loopStatuses.js). */
const HIS_STATUSES = [READY_TO_LAUNCH, 'needs your input'];

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

/**
 * The Merge button for a ticket page's Quick Action section, as HTML, or ''.
 * Shown only on a Ready to launch ticket with a pull request of its own
 * (SP-64 showed Merge on a ticket that had none) whose newest card does not
 * name another move, and only when the server named a merge phrase. The
 * phrase comes from the server (the project config's first mergePhrases
 * entry); the button posts it as his reply and the relay does the merge,
 * exactly as if he had typed it.
 */
export function renderMergeAction({ status, mergePhrase, pullRequest, comments = [] }) {
  if (String(status ?? '').toLowerCase() !== READY_TO_LAUNCH || !mergePhrase || !pullRequest) return '';
  const card = newestCard(comments);
  const move = card ? cardMove(card.body) : null;
  // A regex, not a quoted word: the page's code spells no merge phrase.
  if (move && !/^Merge$/.test(move)) return '';
  return `<form class="merge-action">
        <button type="submit">Merge</button><span class="note"></span>
        <p class="quiet">Posts &ldquo;${escapeHtml(mergePhrase)}&rdquo; as your reply; the relay merges it within a few minutes.</p>
      </form>`;
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
 */
export function renderCloseAction({ status, closePhrase, comments = [] }) {
  if (!HIS_STATUSES.includes(String(status ?? '').toLowerCase()) || !closePhrase) return '';
  const card = newestCard(comments);
  if (!card || cardMove(card.body) !== 'Close') return '';
  // The relay's two close paths differ: on Ready to launch it waits for the
  // work to be merged; on Needs your input the hand-back closes it at once.
  const when = String(status).toLowerCase() === READY_TO_LAUNCH
    ? 'the relay closes it within a few minutes once its work is merged'
    : 'the relay closes it on its next pass, a few minutes from now';
  return `<form class="close-action">
        <button type="submit">Close</button><span class="note"></span>
        <p class="quiet">Posts &ldquo;${escapeHtml(closePhrase)}&rdquo; as your reply; ${when}.</p>
      </form>`;
}

/** The one question the Close button asks before it posts. Plain text, for confirm(). */
export function closeQuestion({ name }) {
  return `Close ${name}?`;
}

/** A stage colour the page will use: `#rrggbb` only, anything else is no colour. */
const HEX = /^#[0-9a-f]{6}$/i;

const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
/** `share` of `rgb` mixed into `toward` (both `[r, g, b]`). */
const mix = (rgb, toward, share) => rgb.map((v, i) => v * share + toward[i] * (1 - share));
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(channels(a)), luminance(channels(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** How much of the stage colour is in its heading bar: a light tint, so the heading reads on it. */
const TINT_SHARE = 0.15;
/** The contrast a heading's text keeps against its bar (WCAG's figure for bold headings). */
const HEADING_CONTRAST = 3;
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

/**
 * How a stage with a chosen colour is drawn on the Tasks page, or null when
 * it has none (or the saved value is not `#rrggbb`), so it looks as it
 * always did. `border` is the colour itself; `tint` is the heading bar, the
 * colour lightened towards white; `text` is the heading's text: the colour
 * itself, unless it is too pale to read on its own tint (a yellow, say), in
 * which case it is darkened just enough to read. The text and the bar are
 * never the same solid colour.
 */
export function stageLook(colour) {
  if (typeof colour !== 'string' || !HEX.test(colour)) return null;
  const border = colour.toLowerCase();
  const rgb = channels(border);
  const tint = toHex(mix(rgb, WHITE, TINT_SHARE));
  let text = border;
  for (let share = 0.9; contrast(text, tint) < HEADING_CONTRAST && share > 0; share -= 0.1) text = toHex(mix(rgb, BLACK, share));
  if (contrast(text, tint) < HEADING_CONTRAST) text = '#000000';
  return { border, tint, text };
}

/** The server's `/stage-colours` answer as `{ status: look }`, only for stages with a usable colour. */
export function stageLooks(answer) {
  const looks = {};
  for (const { status, colour } of Array.isArray(answer?.stages) ? answer.stages : []) {
    const look = stageLook(colour);
    if (look && typeof status === 'string') looks[status] = look;
  }
  return looks;
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
        <button type="submit">Delete</button><span class="note"></span>
        <p class="quiet">Nobody has started this ticket yet, so it can still be deleted, with its comments.</p>
      </form>`;
}

/** The shortest password the tracker takes (store.mjs MIN_PASSWORD); the server holds the rule. */
export const MIN_PASSWORD = 12;

/**
 * Why an emailed link cannot be used, in plain words, from the store's code
 * (`unknown-link`, `used-link`, `expired-link`), or null for any other.
 */
export function linkProblem(code) {
  if (code === 'used-link') return 'This link has already been used. Nothing was changed. Ask for a new one if you still need to set your password.';
  if (code === 'expired-link') return 'This link has expired. Nothing was changed. Ask for a new one.';
  if (code === 'unknown-link') return 'This link is not one the tracker made. Nothing was changed. Check you opened the whole link from the email.';
  return null;
}

/**
 * What is wrong with a set-password form before it is sent, or null: the
 * same checks the server makes, said before a round trip. `purpose` is the
 * link's; only an invite asks for a name.
 */
export function passwordProblem({ purpose, name, password, confirm }) {
  if (purpose === 'invite' && !String(name ?? '').trim()) return 'Type your name.';
  if ([...String(password ?? '')].length < MIN_PASSWORD) return `A password must be at least ${MIN_PASSWORD} characters.`;
  if (password !== confirm) return 'The two passwords are not the same.';
  return null;
}

/** The set-password form for a link that can be used, as HTML. The email is shown, never changed here. */
export function renderSetPassword({ purpose, email }) {
  const nameBox = purpose === 'invite'
    ? `<label for="name">Your name</label>
      <input id="name" type="text" autocomplete="name" required>`
    : '';
  return `<h1>Set your password</h1>
    <form class="sign-in set-password">
      <label for="email">Email</label>
      <input id="email" type="email" value="${escapeHtml(email)}" readonly autocomplete="username">
      ${nameBox}
      <label for="password">Password (at least ${MIN_PASSWORD} characters)</label>
      <input id="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
      <label for="confirm">The same password again</label>
      <input id="confirm" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
      <button type="submit">Save password</button>
      <p class="note"></p>
    </form>`;
}

/** What the page says once a password is set: where to sign in. */
export function renderPasswordSet(trackerAddress) {
  return `<h1>Password set</h1>
    <p>Password set. Sign in at <a href="/">${escapeHtml(trackerAddress)}</a>.</p>`;
}

/** A status or priority as the page writes it: "in review" -> "In review". */
const capital = (s) => String(s ?? '').replace(/^./, (c) => c.toUpperCase());

/** One <option>, chosen when `on`. */
const option = (value, label, on) => `<option value="${escapeHtml(value)}"${on ? ' selected' : ''}>${escapeHtml(label)}</option>`;

/**
 * The ticket page's Change panel, as HTML: priority, tags, assignee, status,
 * name and description, each with its own note for "Saving…", "Saved" or the
 * server's refusal. The choices come from the server's thread answer
 * (`choices`, `operator`); none is written here. The current status and
 * assignee always show, even when a person could not choose them. The name
 * is locked once a pull request is recorded: its title must match the name.
 */
export function renderEditPanel({ name, description, status, priority, tags = [], assignee, operator, pullRequest, choices = {} }) {
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
  const chips = tags.map((tag) => `<span class="tag">${escapeHtml(tag)}<button type="button" class="remove-tag" data-tag="${escapeHtml(tag)}" title="Remove ${escapeHtml(tag)}" aria-label="Remove tag ${escapeHtml(tag)}">×</button></span>`).join('');
  const nameField = pullRequest
    ? `<p id="edit-name" class="locked">${escapeHtml(name)}</p>
          <p class="quiet">The name cannot change now: a pull request is recorded, and its title must match the name exactly.</p>`
    : `<div class="row"><input id="edit-name" type="text" value="${escapeHtml(name)}" required><button type="submit">Save</button></div>`;
  return `<details class="edit" open>
      <summary>Change this ticket</summary>
      <p class="note edit-note" role="status"></p>
      <form class="edit-fields">
        <label for="edit-priority">Priority</label>
        <div class="row"><select id="edit-priority" data-field="priority">${priorityOptions}</select><span class="note" data-note="priority"></span></div>
        <label for="edit-tag">Tags</label>
        <div class="row"><span class="tags">${chips || '<span class="quiet">none</span>'}</span><input id="edit-tag" type="text" placeholder="Add a tag, then Enter"><span class="note" data-note="tags"></span></div>
        <label for="edit-assignee">Assigned to</label>
        <div class="row"><select id="edit-assignee" data-field="assignee">${who}</select><span class="note" data-note="assignee"></span></div>
        <label for="edit-status">Status</label>
        <div class="row"><select id="edit-status" data-field="status">${statusOptions}</select><span class="note" data-note="status"></span></div>
      </form>
      <form class="edit-name">
        <label for="edit-name">Name</label>
        ${nameField}
        <span class="note" data-note="name"></span>
      </form>
      <form class="edit-description">
        <div class="row"><span class="label">Description</span><button type="button" class="edit-open">Edit</button><span class="note" data-note="description"></span></div>
        <div class="editor" hidden>
          <textarea id="edit-description">${escapeHtml(description ?? '')}</textarea>
          <div class="row"><button type="submit">Save</button><button type="button" class="edit-cancel">Cancel</button></div>
        </div>
      </form>
    </details>`;
}

/** What a save that found the ticket moved says: nothing was overwritten, and it is not tried again. */
export const MOVED_MESSAGE = 'Not saved: this ticket changed while you were looking at it (a loop moved it, or another page saved first), so nothing was overwritten. The page now shows what is stored; make your change again if it still applies.';

/** The sign-in form, as HTML: email, password, and "Forgot password?". `problem` is said under it. */
export function renderSignIn(problem) {
  return `<h1>Sign in</h1>
    <form class="sign-in">
      <label for="email">Email</label>
      <input id="email" type="email" autocomplete="username" required>
      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="current-password" required>
      <button type="submit">Sign in</button>
      <button type="button" class="link forgot">Forgot password?</button>
      <p class="note${problem ? ' error' : ''}">${problem ? escapeHtml(problem) : ''}</p>
    </form>`;
}

/** "Forgot password?", as HTML: one email box, and a way back to signing in. */
export function renderForgot(email = '') {
  return `<h1>Forgot password</h1>
    <form class="sign-in forgot">
      <p>Type your email. If it has an account, a link to set a new password is emailed to it. The link works for 1 hour.</p>
      <label for="email">Email</label>
      <input id="email" type="email" autocomplete="username" value="${escapeHtml(email)}" required>
      <button type="submit">Email me a link</button>
      <a href="/">Back to Sign in</a>
      <p class="note"></p>
    </form>`;
}
