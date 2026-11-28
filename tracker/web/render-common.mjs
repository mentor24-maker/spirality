/**
 * What every page of Dane's page draws with: escaping, the Markdown,
 * the card's banners, the shared small parts (an <option>, a copy row, a time
 * in Mountain time) and the colours of the stages.
 *
 * Split out of render.mjs (SP-364), which re-exports it, so every importer
 * still names render.mjs. Its rule holds here too: every character of
 * ticket text is escaped before it is drawn.
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

export function link(href, label) {
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

export const FENCE = /^\s*(`{3,}|~{3,})/;
/** Does `line` close a fence opened by `run`? Same character, at least as long, nothing after. */
export const closesFence = (line, run) => {
  const m = FENCE.exec(line);
  return Boolean(m) && m[1][0] === run[0] && m[1].length >= run.length && !line.trim().slice(m[1].length).trim();
};
export const HEADING = /^(#{1,6})\s+(.*)$/;
// Three or more of one mark, spaces allowed between them: `---`, and the
// `* * *` older ClickUp-imported bug reports carry (SP-314).
export const RULE = /^\s*(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
export const BULLET = /^\s*[-*+]\s+(.*)$/;
export const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const CHECKBOX = /^\[([ xX])\]\s+(.*)$/;

function listItem(text) {
  const box = CHECKBOX.exec(text);
  if (!box) return `<li>${renderInline(text)}</li>`;
  const done = box[1] !== ' ';
  return `<li class="check${done ? ' done' : ''}"><span class="box">${done ? '☑' : '☐'}</span> ${renderInline(box[2])}</li>`;
}

/**
 * A heading's anchor (SP-331): its words in lower case, spaces to hyphens,
 * every other character dropped. "Needs your input" is `needs-your-input`.
 */
export function headingId(words) {
  return String(words ?? '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'section';
}

/**
 * A block of Markdown, escaped, as HTML. With `headingIds` (a documentation
 * file's page only, SP-331) each heading carries an `id` from headingId, a
 * repeat getting `-2`, `-3`, so a link can open the page at it. A ticket's
 * description never gets them: no id there may clash with the ticket page's
 * own `#comments` and `#reply`.
 */
export function renderMarkdown(text, { headingIds = false } = {}) {
  const used = new Map();
  const idFor = (words) => {
    const base = headingId(words);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };
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
      const id = headingIds ? ` id="${escapeHtml(idFor(heading[2]))}"` : '';
      out.push(`<h${level}${id}>${renderInline(heading[2])}</h${level}>`);
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

/** A Markdown quote line's opening `>` (and the one space after it). */
const QUOTE = /^\s*>\s?/;

/**
 * A documentation file's text with its hard-wrapped lines joined back up
 * (SP-175), for renderMarkdown, which keeps every line break a ticket's
 * text has. A line is joined to the one before when both are text: not
 * blank, not a heading, rule, fence or table row, and the line itself not
 * the start of a list item (an indented one following a list item is that
 * item's next line). A quote's lines (`> ...`) join each other, the
 * later ones' `>` taken off, but never the text before or after the quote.
 * Fenced code is left exactly as written.
 */
export function unwrapDoc(text) {
  const out = [];
  let fence = null;
  const stands = (line) => !line.trim() || HEADING.test(line) || RULE.test(line) || FENCE.test(line) || /^\s*\|/.test(line) || QUOTE.test(line);
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      out.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    if (FENCE.test(line)) {
      fence = FENCE.exec(line)[1];
      out.push(line);
      continue;
    }
    const before = out.length ? out[out.length - 1] : '';
    if (QUOTE.test(line)) {
      // A quote's next line joins the quote, its ">" taken off; a quote never joins the text around it.
      const rest = line.replace(QUOTE, '').trim();
      const joins = out.length && QUOTE.test(before) && before.replace(QUOTE, '').trim() && rest && !BULLET.test(rest) && !NUMBERED.test(rest);
      if (joins) out[out.length - 1] = `${before.replace(/\s+$/, '')} ${rest}`;
      else out.push(line);
      continue;
    }
    const startsItem = BULLET.test(line) || NUMBERED.test(line);
    if (out.length && !stands(before) && !stands(line) && !startsItem) out[out.length - 1] = `${before.replace(/\s+$/, '')} ${line.trim()}`;
    else out.push(line);
  }
  return out.join('\n');
}

/** A line with any `**…**` wrapping taken off: the tracker stores a card's bold runs that way. */
export const unbold = (line) => line.trim().replace(/^\*\*([\s\S]*)\*\*$/, '$1').trim();
export const BANNER_RULE = /^#{20,}$/;
export const BANNER_LABEL = /^NEEDED FROM [^:\n]+:/;
export const RAW_SECTION = /^@@([A-Z]+)\s*$/;

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
 *
 * A banner is never inside a fence: a fenced block quotes, so a `NEEDED
 * FROM …:` line or `@@NEEDED` marker there is someone's words, not the card
 * (SP-425: Dane's request quoted that very line, and the page drew it as the
 * ask, with no Go button). Only a fence left open falls back to the first
 * one anywhere, so a broken card is still found where it used to be.
 */
export function findBanner(lines, operatorName) {
  const outside = (isIt) => {
    const i = endOutsideFences(lines, 0, isIt, unwrap);
    return i < lines.length ? i : -1;
  };
  const label = outside((l) => BANNER_LABEL.test(unbold(l)));
  if (label !== -1) {
    const start = label > 0 && BANNER_RULE.test(unbold(lines[label - 1])) ? label - 1 : label;
    const peel = /^\s*\*\*[\s\S]*\*\*\s*$/.test(lines[label]) ? unwrap : (l) => l;
    const first = unbold(lines[label]).replace(BANNER_LABEL, '').trim();
    const end = endOutsideFences(lines, label + 1, (l) => BANNER_RULE.test(unbold(l)), peel, FENCE.exec(first)?.[1]);
    const ask = [first, ...lines.slice(label + 1, end).map(peel)];
    return { start, end: Math.min(end + 1, lines.length), lines: lines.slice(label, end).map(unbold), ask };
  }
  const raw = outside((l) => RAW_SECTION.exec(l.trim())?.[1] === 'NEEDED');
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

/** A time as Mountain time, the way the change log shows it: "Nov 12, 2026, 6:48 AM MST". */
export function mountainTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  return d.toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

/** The information icon: a ring with an "i" in it, drawn here, never from ticket text. */
export const INFO_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.5v.01"/></svg>';

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

/** A status or priority as the page writes it: "in review" -> "In review". */
export const capital = (s) => String(s ?? '').replace(/^./, (c) => c.toUpperCase());

/** One <option>, chosen when `on`. */
export const option = (value, label, on) => `<option value="${escapeHtml(value)}"${on ? ' selected' : ''}>${escapeHtml(label)}</option>`;

/**
 * One command and its Copy button, the same markup the ticket page's
 * commands use: the app's Copy handler copies the `code` element's text,
 * which is `text` exactly (escaped here, unescaped by the browser).
 */
export function renderCopyRow(text) {
  return `<div class="command"><pre><code>${escapeHtml(text)}</code></pre><button type="button" class="btn copy-command">Copy</button></div>`;
}

export const byText = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
/** Missing values (null) go after every present one; present ones compare with `cmp`. */
export const lastIfMissing = (cmp) => (a, b) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : cmp(a, b));
/** A share of the map or an area, to 0.0001: fine enough that areas side by side meet exactly. */
export const share = (n) => Math.round(n * 10_000) / 10_000;
