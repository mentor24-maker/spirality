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

/**
 * A documentation file's text with its hard-wrapped lines joined back up
 * (SP-175), for renderMarkdown, which keeps every line break a ticket's
 * text has. A line is joined to the one before when both are text: not
 * blank, not a heading, rule, fence or table row, and the line itself not
 * the start of a list item (an indented one following a list item is that
 * item's next line). Fenced code is left exactly as written.
 */
export function unwrapDoc(text) {
  const out = [];
  let fence = null;
  const stands = (line) => !line.trim() || HEADING.test(line) || RULE.test(line) || FENCE.test(line) || /^\s*\|/.test(line);
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
    const startsItem = BULLET.test(line) || NUMBERED.test(line);
    if (out.length && !stands(before) && !stands(line) && !startsItem) out[out.length - 1] = `${before.replace(/\s+$/, '')} ${line.trim()}`;
    else out.push(line);
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
 * Why an open page must not be redrawn on this beat, or null when it may be.
 * `hidden`: the tab is in the background, so nothing is read at all.
 * `drawing`: a draw is already under way. `writing`: a save is in flight,
 * and it redraws the page itself when it lands. `fields`: the page's text
 * boxes and choosers as `{ focused, value, initial }`; one with focus, or
 * holding text that is not what it was drawn with, is him typing, and a
 * redraw would wipe it. `dialog`: a dialog on the page is open (the Pipeline
 * Status dialog has only buttons, so no field holds it, SP-173); a redraw
 * would drop it from under him, with focus lost, and it waits until it closes.
 */
export function redrawHold({ hidden = false, drawing = false, writing = false, dialog = false, fields = [] } = {}) {
  if (hidden) return 'hidden';
  if (drawing) return 'drawing';
  if (writing) return 'writing';
  if (dialog) return 'dialog';
  if (fields.some((f) => f.focused || f.value !== f.initial)) return 'typing';
  return null;
}

/**
 * The choice a chooser was drawn with: the option marked selected in the
 * page as drawn, else the first one ('' with none). `options` is the
 * chooser's options, each `{ value, defaultSelected }`.
 */
export function drawnChoice(options) {
  const all = [...options];
  return (all.find((o) => o.defaultSelected) ?? all[0])?.value ?? '';
}

/**
 * The header bell's colour for the same count: grey while nothing waits (or
 * the count is missing), yellow for one to three, red for more than three.
 */
export function bellColour(waitingCount) {
  if (!Number.isInteger(waitingCount) || waitingCount <= 0) return 'grey';
  return waitingCount <= 3 ? 'yellow' : 'red';
}

/**
 * The bus count in the header (Dane's choice D on the bus ticket: "the page count for
 * everything else"), from GET /bus: `{ text, href, title }`, or null when
 * nothing on the bus is unseen (or the answer is missing). It opens the
 * Team chat ticket with the most unseen posts at its comments (the ticket
 * page opens its Details fold for `#comments`); the title names each one.
 */
export function busLink(answer) {
  const unseen = Array.isArray(answer?.unseen) ? answer.unseen.filter((u) => Number(u.count) > 0) : [];
  const total = unseen.reduce((n, u) => n + Number(u.count), 0);
  if (!total) return null;
  return {
    text: `${total} New on the Bus`,
    href: `/t/${encodeURIComponent(unseen[0].id)}#comments`,
    title: unseen.map((u) => `${u.projectName}: ${u.count} new post${Number(u.count) === 1 ? '' : 's'} on ${u.name}`).join('; '),
  };
}

/** What the Pipeline Status pod says when GET /pipeline could not be read. */
export const PIPELINE_UNAVAILABLE = 'Pipeline Status unavailable';

/**
 * The Pipeline Status pod's contents on the Tasks page (SP-168), from GET
 * /pipeline: one short item per stage, "Relay 10:45 · Build running ·
 * Review 11:10 · Intake 11:04", as HTML. `timeOf` turns an ISO time into the
 * page's own clock time. A stage with no pass logged yet, or no next time
 * known, shows a dash, its title saying which. A missing or malformed answer
 * says PIPELINE_UNAVAILABLE.
 */
export function renderPipelinePod(answer, timeOf) {
  const stages = Array.isArray(answer?.stages) ? answer.stages : null;
  if (!stages || !stages.length) return `<span class="unavailable">${escapeHtml(PIPELINE_UNAVAILABLE)}</span>`;
  const item = (s) => {
    let shown;
    let title;
    if (s.running) {
      shown = 'running';
      title = `${s.name}: a pass is running now`;
    } else if (!s.logged) {
      shown = '–';
      title = `${s.name}: no passes logged yet`;
    } else if (!s.nextDue) {
      shown = '–';
      title = `${s.name}: the next pass's time is not known yet`;
    } else {
      shown = timeOf(s.nextDue);
      title = `${s.name}: next pass due ${shown}`;
    }
    return `<span class="stage${s.running ? ' running' : ''}" title="${escapeHtml(title)}">${escapeHtml(s.name)} ${escapeHtml(shown)}</span>`;
  };
  return stages.map(item).join('<span class="sep" aria-hidden="true"> · </span>');
}

/**
 * The pod button's accessible name (SP-173): "Pipeline Status: Relay 10:45,
 * Build running, Review –, Intake 11:04", so a screen reader names the button
 * for what it opens and still reads each stage. A missing or malformed answer
 * gives PIPELINE_UNAVAILABLE, which already names it.
 */
export function pipelinePodLabel(answer, timeOf) {
  const stages = Array.isArray(answer?.stages) ? answer.stages : null;
  if (!stages || !stages.length) return PIPELINE_UNAVAILABLE;
  const shown = (s) => (s.running ? 'running' : s.logged && s.nextDue ? timeOf(s.nextDue) : '–');
  return `Pipeline Status: ${stages.map((s) => `${s.name} ${shown(s)}`).join(', ')}`;
}

/**
 * How a pass ended, in plain words, from the exit code on its END line
 * (SP-173). The runners write these codes (scripts/run_relay.sh,
 * scripts/loop_runner.sh, scripts/run_with_time_limit.sh): 0 finished, 1 a
 * step failed and said so, 124 the time limit stopped it, anything else it
 * could not run. An END line with no code says only that it ended.
 */
export function passOutcome(code) {
  if (code === 0) return 'Finished';
  if (code === 1) return 'A step failed and said so';
  if (code === 124) return 'Hit its time limit and was stopped';
  if (Number.isInteger(code)) return `Could not run (exit ${code})`;
  return 'Ended';
}

/** How often a stage wakes, from its interval in seconds: "Every 30 minutes". */
export function wakesEvery(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '–';
  if (seconds % 3600 === 0) return seconds === 3600 ? 'Every hour' : `Every ${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? 'Every minute' : `Every ${seconds / 60} minutes`;
  return `Every ${seconds} seconds`;
}

/**
 * The Pipeline Status dialog's rows (SP-173), from GET /pipeline: per stage,
 * its next pass (or "Running now, since …"), when its last pass started and
 * ended and how it ended, and how often it wakes, as an HTML table. `timeOf`
 * turns an ISO time into the page's own time format. A stage with no pass
 * logged yet says "No passes logged yet". While a stage runs, its Last Ended
 * cell is the previous pass's and says "Previous pass: …". A missing or malformed answer says
 * PIPELINE_UNAVAILABLE.
 */
export function renderPipelineDetails(answer, timeOf) {
  const stages = Array.isArray(answer?.stages) ? answer.stages : null;
  if (!stages || !stages.length) return `<p class="unavailable">${escapeHtml(PIPELINE_UNAVAILABLE)}.</p>`;
  const row = (s) => {
    const name = `<th scope="row">${escapeHtml(s.name)}</th>`;
    const wakes = `<td>${escapeHtml(wakesEvery(s.interval))}</td>`;
    if (!s.logged) return `<tr>${name}<td colspan="3" class="quiet">No passes logged yet</td>${wakes}</tr>`;
    let next;
    if (s.running) next = s.lastStart ? `Running now, since ${timeOf(s.lastStart)}` : 'Running now';
    else next = s.nextDue ? timeOf(s.nextDue) : 'Not known yet';
    const started = s.lastStart ? timeOf(s.lastStart) : '–';
    // While a pass runs, the last END belongs to the pass before it: say so, so
    // a red outcome there does not read as the running pass failing.
    const ended = s.lastEnd ? `${s.running ? 'Previous pass: ' : ''}${timeOf(s.lastEnd)}: ${passOutcome(s.lastExit)}` : '–';
    const failed = s.lastEnd && s.lastExit !== 0 && s.lastExit != null;
    return `<tr${s.running ? ' class="running"' : ''}>${name}<td>${escapeHtml(next)}</td><td>${escapeHtml(started)}</td><td${failed ? ' class="failed"' : ''}>${escapeHtml(ended)}</td>${wakes}</tr>`;
  };
  return `<table class="pipeline-stages">
    <thead><tr><th scope="col">Stage</th><th scope="col">Next Pass</th><th scope="col">Last Started</th><th scope="col">Last Ended</th><th scope="col">Wakes</th></tr></thead>
    <tbody>${stages.map(row).join('')}</tbody>
  </table>`;
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
 * Where a ticket sits, in one quiet line, for each status that is the
 * machine's turn (SP-118): shown in place of a card's ask, which is only his
 * move while the ticket is in one of his two statuses.
 */
export const STATUS_LINES = {
  requested: 'In Requested: the intake loop is writing it up as a spec. Nothing is needed from you.',
  queued: 'In Queued: it waits for the build loop to pick it up. Nothing is needed from you.',
  building: 'In Building: the build loop is working on it. Nothing is needed from you.',
  'in review': 'In review: the review loop is checking the pull request. Nothing is needed from you.',
  rework: 'In Rework: the build loop is fixing what review found. Nothing is needed from you.',
  live: 'Live: it is done. Nothing is needed from you.',
};

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
 * On a machine status, one quiet line says where it is instead.
 */
export function renderQuickAction({ name, description, status, comments = [], answerIn = false }) {
  const card = newestCard(comments);
  const summary = card ? cardContext(card.body) ?? firstParagraph(description) : firstParagraph(description);
  const state = String(status ?? '').toLowerCase();
  const his = HIS_STATUSES.includes(state);
  const ask = card && his && !answerIn ? cardAsk(card.body) : null;
  const where = his ? null : STATUS_LINES[state] ?? null;
  return [
    `<h1>${escapeHtml(name)}</h1>`,
    summary ? `<p class="summary">${renderInline(summary)}</p>` : '',
    ask ? askParagraphs(ask).map((p) => `<p class="needed">${p.map(renderInline).join('<br>')}</p>`).join('\n') : '',
    where ? `<p class="where quiet">${escapeHtml(where)}</p>` : '',
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

/**
 * The project picker on the Tasks page's toolbar: "Project: " and a
 * dropdown of every project by name, `current` (a slug) selected. Each
 * option's value is its slug, which the page opens on a change. Names are
 * typed by people, so every one is escaped.
 */
export function renderProjectPicker(projects, current) {
  const options = projects.map((p) => `<option value="${escapeHtml(p.slug)}"${p.slug === current ? ' selected' : ''}>${escapeHtml(p.name)}</option>`);
  return `<label class="project-picker">Project: <select name="project">${options.join('')}</select></label>`;
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
 * A ticket's status as the page writes it, with ANSWER_IN_NOTE after it
 * when his answer is in: "Ready to launch · your answer is in". Plain text.
 */
export function statusLabel({ status, answerIn = false }) {
  const name = String(status ?? '').replace(/^./, (c) => c.toUpperCase());
  return answerIn ? `${name} · ${ANSWER_IN_NOTE}` : name;
}

/**
 * The one line that stands in for the Merge, Close and Go buttons once his
 * answer is in (the server's `answerIn`), as HTML, or ''. The buttons stay
 * away until the relay answers: its comment becomes the newest, and the
 * server stops saying so. No minutes are spelled out; the relay's interval
 * lives in the installer.
 */
export function renderAnswerIn({ answerIn = false }) {
  return answerIn ? '<p class="answer-in">Your answer is in. The relay acts on it at its next pass.</p>' : '';
}

/**
 * The ticket page's reply box, as HTML, or '' once his answer is in
 * (SP-160). While it is in, his comment is the newest word and the relay
 * acts on it at its next pass, so a second reply typed in that gap would
 * quietly overrule the first. The box comes back with the relay's comment,
 * exactly as Merge, Close and Go do. `name` is who the reply posts as.
 */
export function renderReplyForm({ answerIn = false }, name) {
  if (answerIn) return '';
  return `<form class="reply">
        <label for="reply">Reply as ${escapeHtml(name ?? 'you')}</label>
        <textarea id="reply" required></textarea>
        <div class="row"><button type="submit">Post Reply</button><span class="note"></span></div>
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
export function renderMergeAction({ status, mergePhrase, pullRequest, comments = [], answerIn = false }) {
  if (answerIn) return '';
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
 * Never once his answer is in (renderAnswerIn).
 */
export function renderCloseAction({ status, closePhrase, comments = [], answerIn = false }) {
  if (answerIn) return '';
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
        <button type="submit">Go</button><span class="note"></span>
        <p class="quiet">Posts &ldquo;${escapeHtml(goPhrase)}&rdquo; as your reply; the relay queues it on its next pass.</p>
      </form>`;
}

/** The one question the Go button asks before it posts. Plain text, for confirm(). */
export function goQuestion({ name }) {
  return `Send ${name} to the build queue?`;
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
  return `<h1>Set Your Password</h1>
    <form class="sign-in set-password">
      <label for="email">Email</label>
      <input id="email" type="email" value="${escapeHtml(email)}" readonly autocomplete="username">
      ${nameBox}
      <label for="password">Password (at least ${MIN_PASSWORD} characters)</label>
      <input id="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
      <label for="confirm">The same password again</label>
      <input id="confirm" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
      <button type="submit">Save Password</button>
      <p class="note"></p>
    </form>`;
}

/** What the page says once a password is set: where to sign in. */
export function renderPasswordSet(trackerAddress) {
  return `<h1>Password Set</h1>
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
      <summary>Change This Ticket</summary>
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
  return `<h1>Sign In</h1>
    <form class="sign-in">
      <label for="email">Email</label>
      <input id="email" type="email" autocomplete="username" required>
      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="current-password" required>
      <button type="submit">Sign In</button>
      <button type="button" class="link forgot">Forgot Password?</button>
      <p class="note${problem ? ' error' : ''}">${problem ? escapeHtml(problem) : ''}</p>
    </form>`;
}

/** "Forgot password?", as HTML: one email box, and a way back to signing in. */
export function renderForgot(email = '') {
  return `<h1>Forgot Password</h1>
    <form class="sign-in forgot">
      <p>Type your email. If it has an account, a link to set a new password is emailed to it. The link works for 1 hour.</p>
      <label for="email">Email</label>
      <input id="email" type="email" autocomplete="username" value="${escapeHtml(email)}" required>
      <button type="submit">Email Me a Link</button>
      <a href="/">Back to Sign In</a>
      <p class="note"></p>
    </form>`;
}

/** Characters with a meaning in a regular expression, so a search term is matched as typed. */
const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * A search term as a pattern: the whole term as one phrase, as typed,
 * ignoring upper and lower case. Null for an empty term. The server's search
 * (tracker/pageData.mjs searchTickets) and the bolding below both use it, so
 * what is found and what is bolded cannot differ.
 */
export function searchPattern(term, flags = '') {
  const text = String(term ?? '').trim();
  if (!text) return null;
  return new RegExp(text.replace(REGEXP_SPECIAL, '\\$&'), `iu${flags}`);
}

/**
 * Text with every occurrence of `term` in bold, safe for the page. The raw
 * text is split at each match first, each piece escaped, and only then the
 * `<b>` added, so a ticket's own text can never inject markup, and a term
 * that happens to spell part of an escape (`amp`) never breaks one.
 */
export function boldMatches(text, term) {
  const raw = String(text ?? '');
  const pattern = searchPattern(term, 'g');
  if (!pattern) return escapeHtml(raw);
  let out = '';
  let at = 0;
  for (const m of raw.matchAll(pattern)) {
    out += `${escapeHtml(raw.slice(at, m.index))}<b>${escapeHtml(m[0])}</b>`;
    at = m.index + m[0].length;
  }
  return out + escapeHtml(raw.slice(at));
}

/** Where an excerpt was found, in the words the results page says it. */
const PLACE_WORDS = Object.freeze({
  description: 'in the description',
  discussion: 'in the discussion',
  development: 'in the development',
});

/** The filters chosen in the server's answer, as the page says them: "Status: Queued". */
export function activeFilters(filters = []) {
  return filters.filter((f) => f.value != null)
    .map((f) => `${f.label}: ${f.options.find((o) => o.value === f.value)?.label ?? f.value}`);
}

/**
 * The search results page's filter row, from the server's answer: one
 * picker for each filter, its choices as the server lists them, "Any"
 * first, the chosen value selected.
 */
export function renderSearchFilters(filters = []) {
  const picker = (f) => `
    <label>${escapeHtml(f.label)}
      <select name="${escapeHtml(f.key)}">${option('', 'Any', f.value == null)}${f.options.map((o) => option(o.value, o.label, o.value === f.value)).join('')}</select>
    </label>`;
  return `<div class="search-filters">${filters.map(picker).join('')}</div>`;
}

/**
 * The search results page's list, from the server's answer
 * (`{ query, filters, results }`): one plain line for an empty search or
 * one with no matches, naming the filters chosen; otherwise each ticket
 * with its id, its title as a link to its page, its project and status,
 * and its excerpt with the place it was found, the term bold in title and
 * excerpt.
 */
export function renderSearchResults({ query, filters = [], results = [] }) {
  const term = String(query ?? '').trim();
  if (!term) return '<p class="quiet search-note">Type a word to search every task.</p>';
  if (!results.length) {
    const active = activeFilters(filters);
    return `<p class="quiet search-note">No tickets match ${escapeHtml(term)}${active.length ? ` with ${escapeHtml(active.join(', '))}` : ''}</p>`;
  }
  const item = (r) => `
    <li>
      <p class="result-head"><span class="quiet">${escapeHtml(r.id)}</span> <a href="/t/${encodeURIComponent(r.id)}">${boldMatches(r.name, term)}</a></p>
      <p class="quiet">${escapeHtml(r.projectName)} · ${escapeHtml(r.status)}</p>
      ${r.excerpt ? `<p class="excerpt">${boldMatches(r.excerpt, term)} <span class="quiet">${escapeHtml(PLACE_WORDS[r.place] ?? '')}</span></p>` : ''}
    </li>`;
  return `<ol class="search-results">${results.map(item).join('')}</ol>`;
}

// ── Set up a project (SP-127) ────────────────────────────────────────────────
//
// The page that walks a project's setup: the answers form, the steps the
// wizard (scripts/onboard/onboard.mjs) recorded in its state file, and at
// every stop the exact command for Dane to paste into a Terminal on the
// Mini. The page never runs anything; the server only reads the wizard's
// files and writes the answers file (tracker/setup.mjs). Nothing about any
// one project is written here: every name, step, command and default comes
// from the server's answer.

/**
 * One command and its Copy button, the same markup the ticket page's
 * commands use: the app's Copy handler copies the `code` element's text,
 * which is `text` exactly (escaped here, unescaped by the browser).
 */
export function renderCopyRow(text) {
  return `<div class="command"><pre><code>${escapeHtml(text)}</code></pre><button type="button" class="copy-command">Copy</button></div>`;
}

/** A project's slug from its name, the wizard's own rule (lib/onboardAnswers.mjs slugFromName). */
export function setupSlug(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Slugs the page cannot use: their setup page's address is another page's. */
export const SETUP_RESERVED_SLUGS = Object.freeze(['new', 'fields']);

/** Why a slug cannot be set up from the page, or null when it can. */
export function setupSlugProblem(slug) {
  if (!slug) return 'The project name needs a letter or a digit to make its slug from.';
  if (SETUP_RESERVED_SLUGS.includes(slug)) return `"${slug}" is the address of a page here; give the project another name.`;
  return null;
}

/** Each outcome the state file may give a step, as the step list says it. */
export const SETUP_OUTCOME_WORDS = Object.freeze({
  done: 'done',
  skip: 'skipped',
  running: 'running',
  stopped: 'stopped',
  failed: 'failed',
  pending: 'not yet',
});

/** The steps as a list, each with its outcome and what the wizard said of it; a plain line before the first run. */
export function renderSetupSteps(state) {
  if (!state) return '<p class="quiet setup-steps">Not started yet: no step has run.</p>';
  const item = (s) => {
    const outcome = Object.hasOwn(SETUP_OUTCOME_WORDS, s.outcome) ? s.outcome : 'pending';
    return `<li class="step ${outcome}"><span class="step-name">${escapeHtml(s.step)}</span> <span class="outcome">${escapeHtml(SETUP_OUTCOME_WORDS[outcome])}</span>${s.why ? `<span class="why quiet">${escapeHtml(s.why)}</span>` : ''}</li>`;
  };
  return `<ol class="setup-steps">${state.steps.map(item).join('')}</ol>`;
}

/** The step the state file says is running now, or null. */
export function runningStep(state) {
  return state?.steps?.find((s) => s.outcome === 'running')?.step ?? null;
}

/** The project's name as its answers give it; its slug until they do. */
export function setupName(setup) {
  return setup?.resolved?.projectName ?? setup?.answers?.projectName ?? setup?.project ?? '';
}

/** Whether the setup page reads again every few seconds: until the setup is finished, it is running or waiting on Dane. */
export function setupFollows(setup) {
  return !setup?.finished;
}

/** The lowest-numbered ticket on a project's board answer (`{ columns: [{ tickets: [{ id }] }] }`), or null. */
export function firstTicket(board) {
  const number = (id) => Number(/-(\d+)$/.exec(String(id))?.[1] ?? Infinity);
  const ids = (board?.columns ?? []).flatMap((c) => (c.tickets ?? []).map((t) => t.id));
  return ids.reduce((best, id) => (best == null || number(id) < number(best) ? id : best), null);
}

const PASTE_HERE = '<p>Paste this into a Terminal on the Mini:</p>';
const isLink = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);

/**
 * The box under the steps: what is next, from the server's answer for one
 * project (tracker/setup.mjs setupOf). `firstTicketId` is the project's
 * first ticket, for the finished box (null: not known). Every command shown
 * comes with a Copy button whose text is that command exactly.
 */
export function renderSetupNext(setup, { firstTicketId = null } = {}) {
  const { project, state, stateError, finished, commands } = setup;
  const name = setupName(setup);
  const resume = (lead = 'Then run the setup again; it skips every step already done.') => `<p>${lead}</p>${renderCopyRow(commands.resume)}`;
  const box = (kind, body) => `<section class="setup-next ${kind}" data-next="${kind}">${body}</section>`;
  if (finished) {
    const projectLink = `<a href="/projects/${encodeURIComponent(project)}">its project</a>`;
    const ticket = firstTicketId ? ` and <a href="/t/${encodeURIComponent(firstTicketId)}">its first ticket, ${escapeHtml(firstTicketId)}</a>` : '';
    return box('finished', `<h2>${escapeHtml(name)} Is Set Up</h2><p>Every step is done. See ${projectLink}${ticket}.</p>`);
  }
  if (stateError) {
    return box('unreadable', `<h2>The Setup's State Cannot Be Read</h2><p class="error">${escapeHtml(stateError)}</p>${resume('Running the setup again writes it afresh:')}`);
  }
  if (!state) {
    return box('start', `<h2>Start the Setup</h2>${PASTE_HERE}${renderCopyRow(commands.start)}<p class="quiet">This page follows it as it runs.</p>`);
  }
  // What each kind of stop the wizard records (its STOP_KINDS) asks of him.
  const stop = state.stop;
  const STOPS = {
    answers: () => `<h2>Some Answers Are Missing</h2><p>${escapeHtml(stop.why)}</p><p><a href="/setup/${encodeURIComponent(project)}/answers">Fill in the answers</a>, then paste this into a Terminal on the Mini:</p>${renderCopyRow(commands.start)}`,
    paste: () => {
      const lines = Array.isArray(stop.commands) ? stop.commands : [];
      return `<h2>Your Move (Real Secret Values)</h2><p>${escapeHtml(stop.why)}</p>${PASTE_HERE}${renderCopyRow(lines.join('\n'))}<p class="quiet">It makes the sign-ins and writes their keys into Doppler. No key is shown.</p>${resume('Once it has finished, run the setup again:')}`;
    },
    merge: () => {
      const link = isLink(stop.link) ? `<p><a href="${escapeHtml(stop.link)}">Open the setup ticket</a>: its Merge button is there.</p>` : '';
      return `<h2>Your Move (A Decision): Merge the Setup</h2><p>${escapeHtml(stop.why)}</p>${link}${resume('Once it has merged, run the setup again:')}`;
    },
    failed: () => `<h2>A Step Failed</h2><pre class="failed"><code>${escapeHtml(`FAILED: ${stop.step}: ${stop.why}`)}</code></pre>${resume('Fix it, then run the setup again; it skips every step already done:')}`,
  };
  if (stop && Object.hasOwn(STOPS, stop.kind)) return box(stop.kind, STOPS[stop.kind]());
  const running = runningStep(state);
  if (running) {
    return box('running', `<h2>Running: ${escapeHtml(running)}</h2><p class="quiet">This page follows it every few seconds.</p>${resume('If nothing changes for a long while, its run may have ended; run it again:')}`);
  }
  return box('resume', `<h2>Carry On with the Setup</h2>${resume('Paste this into a Terminal on the Mini; it skips every step already done:')}`);
}

/** The Projects page's list of projects mid-setup (`GET /setup`'s answer), each linking to its setup page; '' with none. */
export function renderSetupList({ setups = [] } = {}) {
  const open = setups.filter((s) => !s.finished);
  if (!open.length) return '';
  const item = (s) => `<li><a href="/setup/${encodeURIComponent(s.project)}">${escapeHtml(s.project)}</a> <span class="quiet">${s.stateError ? 'its state cannot be read' : !s.started ? 'not started yet' : `at ${escapeHtml(s.step ?? '')}`}</span></li>`;
  return `<section class="setups"><h2>Being Set Up</h2><ul>${open.map(item).join('')}</ul></section>`;
}

/** An answer as the form's text box shows it: a list with commas, an empty list as "none", the default when there is none. */
export function setupFieldText(field, answers) {
  const has = answers && Object.hasOwn(answers, field.key) && answers[field.key] != null;
  if (!has) return field.default ?? '';
  const v = answers[field.key];
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'none';
  return String(v);
}

/**
 * The answers form: one box per field the server gives (`GET
 * /setup/fields`), in its order, each with its question and filled in from
 * the saved answers or the default. Each has a note beside it for a
 * refusal naming it.
 */
export function renderSetupForm(fields, answers = null) {
  const box = (f) => {
    const id = `setup-${escapeHtml(f.key)}`;
    const value = setupFieldText(f, answers);
    const attrs = `id="${id}" name="${escapeHtml(f.key)}" data-default="${escapeHtml(f.default ?? '')}"${f.required ? ' required' : ''} autocapitalize="off" spellcheck="false"`;
    const input = f.key === 'description'
      ? `<textarea ${attrs}>${escapeHtml(value)}</textarea>`
      : `<input type="text" ${attrs} value="${escapeHtml(value)}">`;
    return `
      <label for="${id}">${escapeHtml(f.question)}</label>
      ${f.list ? '<span class="hint quiet">Commas between; "none" for none.</span>' : ''}
      ${input}
      <span class="note field-note" data-for="${escapeHtml(f.key)}"></span>`;
  };
  return fields.map(box).join('');
}

/**
 * The body the answers form sends (`PUT /setup/<slug>`): each field's text
 * as typed, or null where it is its default, so the default stays the
 * wizard's.
 */
export function setupBody(fields, values) {
  return Object.fromEntries(fields.map((f) => {
    const typed = String(values[f.key] ?? '').trim();
    return [f.key, typed === String(f.default ?? '').trim() ? null : typed];
  }));
}
