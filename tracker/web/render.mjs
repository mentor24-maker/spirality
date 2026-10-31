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

/**
 * Where an operator card's banner is in a comment: `{ start, end, lines }`
 * over the comment's lines, or null. Two forms:
 *
 *  - as `ask` posts it: a rule of #, `NEEDED FROM <NAME>: <the ask>`, any
 *    more lines of the ask, a closing rule (each line maybe in `**…**`);
 *  - an authored card that reached the tracker unrendered: the `@@NEEDED`
 *    section, up to the next `@@` marker. Its label is `operatorName`'s.
 */
function findBanner(lines, operatorName) {
  const label = lines.findIndex((l) => BANNER_LABEL.test(unbold(l)));
  if (label !== -1) {
    const start = label > 0 && BANNER_RULE.test(unbold(lines[label - 1])) ? label - 1 : label;
    let end = label + 1;
    while (end < lines.length && !BANNER_RULE.test(unbold(lines[end]))) end += 1;
    const ask = lines.slice(label, end).map(unbold);
    return { start, end: Math.min(end + 1, lines.length), lines: ask };
  }
  const raw = lines.findIndex((l) => RAW_SECTION.exec(l.trim())?.[1] === 'NEEDED');
  if (raw === -1) return null;
  let end = raw + 1;
  while (end < lines.length && !RAW_SECTION.test(lines[end].trim())) end += 1;
  const ask = lines.slice(raw + 1, end).map((l) => l.trim()).filter(Boolean);
  const who = String(operatorName || 'you').toUpperCase();
  return { start: raw, end, lines: [`NEEDED FROM ${who}: ${ask[0] ?? ''}`, ...ask.slice(1)] };
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
 * The left side of a ticket page's Quick Action section, as HTML: the
 * ticket's title, a short description and, in bold red, what is needed. The
 * short description is the newest operator card's "WHAT'S GOING ON" text, or
 * the description's first paragraph when no comment carries a card; what is
 * needed is that newest card's ask, and there is no red line without one.
 */
export function renderQuickAction({ name, description, comments = [] }) {
  const card = [...comments].reverse().find((c) => cardAsk(c.body) !== null);
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

/**
 * The Merge button for a ticket page's Quick Action section, as HTML, or ''
 * when the ticket is not in Ready to launch or the server named no merge
 * phrase. The phrase comes from the server (the project config's first
 * mergePhrases entry); the button posts it as his reply and the relay does
 * the merge, exactly as if he had typed it.
 */
export function renderMergeAction({ status, mergePhrase }) {
  if (String(status ?? '').toLowerCase() !== READY_TO_LAUNCH || !mergePhrase) return '';
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
