/**
 * The Docs page (page-docs.mjs): the command list, the context documents,
 * the documentation list and the Loop Queue diagram.
 *
 * Split out of render.mjs (SP-364), which re-exports it, so every importer
 * still names render.mjs. Its rule holds here too: every character of
 * ticket text is escaped before it is drawn.
 */
import { escapeHtml, renderInline, headingId, renderMarkdown, unwrapDoc, option, byText, lastIfMissing } from './render-common.mjs';

/**
 * A command's short line in the Quick Claude Commands pod (SP-212): its own
 * `summary:`, or else the first seven words of its description and "…".
 */
export function commandSummary(command) {
  if (command.summary) return String(command.summary);
  const words = String(command.description ?? '').trim().split(/\s+/).filter(Boolean);
  return words.length > 7 ? `${words.slice(0, 7).join(' ')}…` : words.join(' ');
}

/** A command's plain explanation in its pop-up (SP-212): its own `about:`, or else its description. */
export const commandAbout = (command) => String(command.about || command.description || '');

/**
 * The Docs page's Quick Claude Commands search (SP-179, SP-212): the
 * commands whose name, description, summary or plain explanation holds
 * `term`, case set aside; every one when `term` is blank. Those whose name
 * holds it come first, so typing "review" puts /loop-review above the
 * skills that only mention review.
 */
export function matchCommands(commands, term) {
  const t = String(term ?? '').trim().toLowerCase();
  if (!t) return commands;
  const byName = commands.filter((c) => c.name.toLowerCase().includes(t));
  const words = (c) => [c.description, c.summary, c.about].filter(Boolean).join('\n').toLowerCase();
  const byWords = commands.filter((c) => !byName.includes(c) && words(c).includes(t));
  return [...byName, ...byWords];
}

/** Where one command's own page is: `/docs/commands/<name>`. */
export const commandHref = (name) => `/docs/commands/${encodeURIComponent(name)}`;

/**
 * The Quick Claude Commands list under the search box (SP-212): each
 * command as `/<name>` and its short line, nothing else. Each is a link to
 * its own page that the page opens as a pop-up instead (`data-command`
 * names which). A search that leaves nothing says so; with no copied
 * commands yet, one line says that too.
 */
export function renderCommandList(commands, term = '') {
  const shown = matchCommands(commands, term);
  const none = commands.some((c) => c.source === 'Your command')
    ? ''
    : '<p class="quiet commands-none">Your own commands have not been copied here yet: run <code>npm run commands:copy</code> on the computer they live on.</p>';
  const rows = shown.map((c) => `<li><a class="command-open" href="${commandHref(c.name)}" data-command="${escapeHtml(c.name)}"><code>/${escapeHtml(c.name)}</code> <span class="command-summary">${renderInline(commandSummary(c))}</span></a></li>`);
  const list = shown.length
    ? `<ul class="command-list">${rows.join('')}</ul>`
    : `<p class="quiet">No command matches “${escapeHtml(String(term).trim())}”.</p>`;
  return `${list}${none}`;
}

/**
 * What a command's pop-up holds (SP-212): its name, where it comes from, its
 * plain explanation and a link to the page with all its steps.
 */
export function renderCommandDetails(command) {
  const paragraphs = commandAbout(command).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return `
    <h2 id="command-details-title"><code>/${escapeHtml(command.name)}</code></h2>
    <p class="quiet">${escapeHtml(command.source)}</p>
    ${paragraphs.map((p) => `<p>${renderInline(p)}</p>`).join('')}
    <p><a href="${commandHref(command.name)}">See All the Steps</a></p>`;
}

/** One command's page: its name, where it comes from, its description and its steps, formatted. */
export function renderCommandView(command) {
  return `
    <h1><code>/${escapeHtml(command.name)}</code></h1>
    <p class="quiet">${escapeHtml(command.source)}</p>
    <p>${renderInline(command.description)}</p>
    <div class="command-steps">${renderMarkdown(command.steps)}</div>
    <p><a href="/docs">Back to Docs</a></p>`;
}

/**
 * The Docs page's Context Documents section (SP-176): the files kept on the
 * project itself, newest first, each with its type, size, adder and time, a
 * Download link (always saved, never opened in the page) and a Remove
 * button, and one Upload Document button over a hidden file picker. `size`
 * and `timeOf` put a byte count and a time in words. Every name is escaped.
 */
export function renderContextDocs({ project, docs = [] }, { size, timeOf }) {
  const base = `/projects/${encodeURIComponent(project.slug)}/docs`;
  const row = (d) => `<tr data-doc="${escapeHtml(d.id)}">
      <td class="name">${escapeHtml(d.name)}</td>
      <td class="type">${escapeHtml(d.type)}</td>
      <td class="size">${escapeHtml(size(d.size))}</td>
      <td class="by">${d.addedByName ? escapeHtml(d.addedByName) : '<span class="quiet">unknown</span>'}</td>
      <td class="when">${escapeHtml(timeOf(d.createdAt))}</td>
      <td class="actions"><a href="${base}/${encodeURIComponent(d.id)}" download="${escapeHtml(d.name)}">Download</a>
        <button type="button" class="btn btn-danger btn-sm remove-doc" data-remove-doc="${escapeHtml(d.id)}" data-name="${escapeHtml(d.name)}" aria-label="Remove ${escapeHtml(d.name)}">Remove</button></td></tr>`;
  return `<section class="context-docs">
    <h2>Context Documents</h2>
    <p class="quiet">Briefs, notes and reference files that belong to ${escapeHtml(project.name)} as a whole, not to one task. One file at a time, up to 10 MB.</p>
    <div class="row"><button type="button" class="btn btn-primary upload-doc">Upload Document</button><input type="file" class="doc-file" aria-label="Document to Upload" hidden></div>
    <p class="note quiet doc-note" role="status"></p>
    ${docs.length
    ? `<div class="table-wrap"><table class="projects doc-list"><thead><tr><th>File</th><th>Type</th><th>Size</th><th>Added By</th><th>Added On</th><th></th></tr></thead>
      <tbody>${docs.map(row).join('')}</tbody></table></div>`
    : `<p class="quiet">${escapeHtml(project.name)} has no context documents yet.</p>`}
  </section>`;
}

/**
 * SP-195: the Docs page's Reference Docs and Work Log section. Every file
 * there is one of the repository's docs/ Markdown files; its kind comes
 * from its folder and its date from the `YYYY-MM-DD` a file name starts
 * with (every work-log entry has one). Worked out here from the path, so
 * the server's /documentation answer stays as it is.
 */
export const DOC_KINDS = ['Reference', 'Onboarding', 'Work Log', 'Operator Prompts'];
/** SP-293: operator-prompts/ holds one file per hand-run thread, dated like the work log. */
const DOC_FOLDERS = { onboarding: 'Onboarding', 'work-log': 'Work Log', 'operator-prompts': 'Operator Prompts' };
const NEWEST_FIRST = new Set(['Work Log', 'Operator Prompts']);

/** A docs/ file's kind and date from its path (relative to docs/): `{ kind, date }`, date 'YYYY-MM-DD' or null. */
export function docInfo(path) {
  const parts = String(path ?? '').split('/');
  const name = parts[parts.length - 1];
  const folder = parts.length > 1 ? parts[0] : '';
  const kind = !folder ? 'Reference' : DOC_FOLDERS[folder] ?? folder;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(name);
  const ok = m && !Number.isNaN(Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`)) && Number(m[2]) >= 1 && Number(m[2]) <= 12;
  return { kind, date: ok ? `${m[1]}-${m[2]}-${m[3]}` : null };
}

/** A 'YYYY-MM-DD' in words, the way the page writes a day: "Nov 10, 2026". Read as a calendar day, never moved by time zone. */
export function docDay(date) {
  if (!date) return '';
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

const kindRank = (kind) => {
  const i = DOC_KINDS.indexOf(kind);
  return i === -1 ? DOC_KINDS.length : i;
};
const DOC_COMPARE = {
  title: (a, b) => byText(String(a.title ?? ''), String(b.title ?? '')),
  kind: (a, b) => kindRank(a.kind) - kindRank(b.kind) || byText(a.kind, b.kind),
  date: (a, b) => lastIfMissing(byText)(a.date, b.date),
};
/** The order the section opens in: Reference, then Onboarding, then Work Log and Operator Prompts newest first, then any other folder; title within a kind. */
const docStart = (a, b) => DOC_COMPARE.kind(a, b)
  || (NEWEST_FIRST.has(a.kind) ? lastIfMissing(byText)(b.date, a.date) : 0)
  || DOC_COMPARE.title(a, b) || byText(a.path, b.path);

/** The /documentation files as the section's rows: `{ path, title, kind, date }`, in the order it opens in. Never changes `files`. */
export function docRows(files = []) {
  return files.map((f) => ({ path: f.path, title: f.title, ...docInfo(f.path) })).sort(docStart);
}

/**
 * `rows` sorted by Title, Kind or Date (`sort.column` 'title', 'kind' or
 * 'date'), ascending or descending; a file with no date goes last going up.
 * Ties keep the opening order. No sort gives the rows back as they came.
 */
export function sortDocs(rows, sort) {
  const compare = sort && DOC_COMPARE[sort.column];
  if (!compare) return rows.slice();
  const flip = sort.direction === 'descending' ? -1 : 1;
  return rows.map((r, i) => [r, i]).sort(([a, i], [b, j]) => flip * compare(a, b) || i - j).map(([r]) => r);
}

/**
 * The rows of `kind` ('' for all) whose title or path holds `text`, any
 * case. The path is read below docs/, the part that differs, so typing
 * "docs" finds the files about docs, not every file.
 */
export function filterDocs(rows, { kind = '', text = '' } = {}) {
  const needle = String(text).trim().toLowerCase();
  return rows.filter((r) => (!kind || r.kind === kind)
    && (!needle || String(r.title ?? '').toLowerCase().includes(needle) || String(r.path ?? '').toLowerCase().includes(needle)));
}

const DOC_COLUMNS = [{ key: 'title', label: 'Title' }, { key: 'kind', label: 'Kind' }, { key: 'date', label: 'Date' }];

/** The section's heading row: Title, Kind and Date each a button that sorts, the sorted one with `aria-sort` and an arrow; Path plain. */
export function renderDocHeadings(sort) {
  const heading = ({ key, label }) => {
    const on = sort?.column === key && (sort.direction === 'ascending' || sort.direction === 'descending');
    const arrow = on ? ` <span class="arrow" aria-hidden="true">${sort.direction === 'ascending' ? '▲' : '▼'}</span>` : '';
    return `<th class="${key}"${on ? ` aria-sort="${sort.direction}"` : ''}><button type="button" class="sort" data-sort="${key}">${escapeHtml(label)}${arrow}</button></th>`;
  };
  return `<tr>${DOC_COLUMNS.map(heading).join('')}<th class="path">Path</th></tr>`;
}

/** The table body for `rows`, each title opening its file page at `address(path)`; every word escaped. */
export function renderDocBody(rows, address) {
  return rows.map((d) => `<tr data-doc="${escapeHtml(d.path)}">
      <td class="title"><a href="${escapeHtml(address(d.path))}">${escapeHtml(d.title)}</a></td>
      <td class="kind">${escapeHtml(d.kind)}</td>
      <td class="date">${escapeHtml(docDay(d.date))}</td>
      <td class="path"><code>docs/${escapeHtml(d.path)}</code></td></tr>`).join('');
}

/** The count line: "Showing 12 of 134", or that none match. */
export function docCountLine(shown, total) {
  return shown ? `Showing ${shown} of ${total}` : 'No document matches.';
}

/**
 * The whole section, folded (closed) when the page opens: its heading with
 * the count, a Kind drop-down and a search box, the count line and the
 * table. `files` is the /documentation list, or null when it could not be
 * read; `address` is a file's page address.
 */
export function renderDocumentation(files, address) {
  const heading = (n) => `<summary><h2>Reference Docs and Work Log${n == null ? '' : ` (${n})`}</h2></summary>`;
  if (!files) return `<details class="spirality-docs">${heading(null)}<p class="quiet">The reference docs and work log could not be read.</p></details>`;
  if (!files.length) return `<details class="spirality-docs">${heading(0)}<p class="quiet">The docs folder holds no Markdown files, so there are no reference docs or work log entries.</p></details>`;
  const rows = docRows(files);
  const kinds = [...DOC_KINDS, ...[...new Set(rows.map((r) => r.kind))].filter((k) => !DOC_KINDS.includes(k)).sort(byText)];
  return `<details class="spirality-docs">${heading(rows.length)}
    <p class="quiet">The repository's docs folder: the reference documents, the onboarding guides and the work log, one plain-English entry per merged pull request.</p>
    <div class="row doc-filters">
      <label for="doc-kind">Kind</label>
      <select id="doc-kind"><option value="">All</option>${kinds.map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('')}</select>
      <label for="doc-search">Find a Document</label>
      <input type="search" id="doc-search" aria-describedby="doc-search-hint" placeholder="UI_DOCTRINE" autocomplete="off">
      <span class="hint" id="doc-search-hint">By its title or its path.</span>
    </div>
    <p class="quiet doc-count" role="status">${docCountLine(rows.length, rows.length)}</p>
    <div class="table-wrap"><table class="projects spirality-docs sortable"><thead>${renderDocHeadings(null)}</thead>
      <tbody>${renderDocBody(rows, address)}</tbody></table></div>
  </details>`;
}

/**
 * The Console view (SP-233): every ticket in flight as an icon tile, from
 * GET /in-flight (pageData.consoleOf). Everything below is pure, so the
 * tests draw exactly what the page draws.
 */

/**
 * The boxes on Dane's Spirality Loop Queue diagram (SP-337), in the order a
 * ticket meets them, each with its place in the 3200 x 1800 picture (left,
 * top, right, bottom, in pixels) and its section on the Loop Queue Anatomy
 * page, whose heading ids come from headingId.
 */
export const LOOP_QUEUE_DIAGRAM = Object.freeze({
  src: '/web/loop-queue-diagram.png',
  alt: 'Spirality Loop Queue: how a ticket moves from Requested to Live',
  width: 3200,
  height: 1800,
  page: 'LOOP_QUEUE_ANATOMY.md',
  boxes: Object.freeze([
    { label: 'Requested', box: [62, 1213, 468, 1387] },
    { label: 'Needs your input', box: [62, 652, 497, 826] },
    { label: 'Queued', box: [702, 1002, 1199, 1387] },
    { label: 'Rework', box: [702, 652, 1199, 797] },
    { label: 'Building', box: [1441, 1213, 1789, 1387] },
    { label: 'In review', box: [1941, 1213, 2288, 1387] },
    { label: 'Ready to launch', box: [2442, 1213, 2857, 1387] },
    { label: 'Live', box: [3001, 1213, 3157, 1387] },
  ].map((b) => Object.freeze({ ...b, anchor: headingId(b.label) }))),
});

/** The Loop Queue diagram's id on the Docs page (SP-361): the anatomy page's cut-outs link to `/docs#loop-queue-diagram`. */
export const LOOP_QUEUE_FIGURE_ID = 'loop-queue-diagram';

/**
 * The Loop Queue diagram for the top of the Docs page's right-hand column
 * (SP-337): the picture at the column's width, and over each status box a
 * link to that status's section of the anatomy page. A plain image map uses
 * fixed pixels and drifts once the picture is scaled, so the links are an
 * SVG laid over the picture with the picture's own size as its viewBox: each
 * box keeps its pixel place in the original and scales with it at any width.
 * (An inline style would place them too, but the page's lock forbids it.)
 * `docAddress` turns a docs/ path into the page's address for it.
 */
export function renderLoopQueueDiagram(docAddress) {
  const d = LOOP_QUEUE_DIAGRAM;
  const links = d.boxes.map(({ label, box: [l, t, r, b], anchor }) => {
    const href = escapeHtml(`${docAddress(d.page)}#${anchor}`);
    return `<a class="diagram-box" href="${href}" aria-label="${escapeHtml(label)}"><title>${escapeHtml(label)}</title><rect x="${l}" y="${t}" width="${r - l}" height="${b - t}" rx="24"></rect></a>`;
  }).join('');
  return `<figure class="loop-diagram" id="${LOOP_QUEUE_FIGURE_ID}"><img src="${d.src}" alt="${escapeHtml(d.alt)}" width="${d.width}" height="${d.height}"><svg class="loop-diagram-links" viewBox="0 0 ${d.width} ${d.height}" role="group" aria-label="Loop Queue statuses">${links}</svg></figure>`;
}

/** The margin, in the picture's pixels, kept around a status box cut from the diagram (SP-361). */
const CUT_MARGIN = 24;
/** How many of the picture's pixels make one pixel of a cut-out on the page: every box drawn at the same scale (SP-361). */
const CUT_SCALE = 2.75;

/**
 * One status box cut from the Loop Queue diagram (SP-361): an SVG whose
 * viewBox is the box's area plus a small margin (kept inside the picture),
 * holding the whole picture, so only the box shows. Its width and height
 * attributes draw every box at the same scale, and app.css lets it shrink
 * with its column; an inline style would size it too, but the page's lock
 * forbids it. Decorative: the link around it carries the name.
 */
export function renderDiagramCut([l, t, r, b]) {
  const d = LOOP_QUEUE_DIAGRAM;
  const x = Math.max(0, l - CUT_MARGIN);
  const y = Math.max(0, t - CUT_MARGIN);
  const w = Math.min(d.width, r + CUT_MARGIN) - x;
  const h = Math.min(d.height, b + CUT_MARGIN) - y;
  return `<svg class="anatomy-cut" viewBox="${x} ${y} ${w} ${h}" width="${Math.round(w / CUT_SCALE)}" height="${Math.round(h / CUT_SCALE)}" aria-hidden="true" focusable="false"><image href="${d.src}" x="0" y="0" width="${d.width}" height="${d.height}"></image></svg>`;
}

/**
 * The Loop Queue Anatomy page's drawing on the tracker (SP-361). `body` is
 * the file's text with its "# " title already taken off (drawDoc draws it
 * as the page's heading). The opening paragraph is drawn as before; then
 * one table row per "## " section, in the file's order: on the left that
 * status's box cut from the diagram, a link to the diagram on the Docs page;
 * on the right the section's copy, drawn by the same Markdown drawing. The
 * box shows the status's name, so no heading is drawn, but the row carries
 * the heading's old id, so the diagram's links into this page (SP-337) still
 * land on their status. A section with no box on the diagram keeps its name
 * as text in the left cell, so nothing in the file is lost.
 */
export function renderLoopQueueAnatomy(body) {
  const [intro, ...sections] = unwrapDoc(String(body ?? '')).split(/^## /m);
  const used = new Map();
  const rows = sections.map((section) => {
    const [heading, ...rest] = section.split('\n');
    const words = heading.trim();
    const base = headingId(words);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    const id = n === 1 ? base : `${base}-${n}`;
    const found = LOOP_QUEUE_DIAGRAM.boxes.find((b) => b.anchor === base);
    const left = found
      ? `<a class="anatomy-box" href="/docs#${LOOP_QUEUE_FIGURE_ID}" aria-label="${escapeHtml(`${found.label}: show it on the Loop Queue diagram`)}">${renderDiagramCut(found.box)}</a>`
      : `<strong>${renderInline(words)}</strong>`;
    return `<tr id="${escapeHtml(id)}"><td class="anatomy-cut-cell">${left}</td><td class="anatomy-copy">${renderMarkdown(rest.join('\n'))}</td></tr>`;
  });
  const opening = renderMarkdown(intro);
  if (!rows.length) return opening;
  return `${opening}\n<table class="anatomy"><tbody>${rows.join('')}</tbody></table>`;
}
