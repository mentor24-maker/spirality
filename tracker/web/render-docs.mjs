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

/**
 * How wide, in the picture's pixels, the invisible line laid along each
 * arrow is (SP-391), set in app.css: wide enough that a thin arrow is easy to hit. Every
 * line stops short of the boxes it joins by more than half this, so a click
 * on a box still reaches the box's own link.
 */
export const DIAGRAM_ARROW_HIT_WIDTH = 40;

/**
 * The arrows and notes on the Loop Queue diagram that open a pop-up (SP-391),
 * each with its heading, the two statuses it joins, 50 to 100 words on what
 * it does between them (agreeing with docs/LOOP_CONTRACT.md and
 * docs/LOOP_QUEUE_ANATOMY.md), and its place in the 3200 x 1800 picture:
 * `line`, the points an invisible wide line follows along the arrow (none
 * for a note), and `words`, the rectangle (left, top, right, bottom) round
 * its label. Measured from the picture's own pixels.
 */
export const LOOP_QUEUE_ARROWS = Object.freeze([
  {
    id: 'written-up-as-a-spec',
    heading: 'Written Up as a Spec',
    from: 'Requested',
    to: 'Needs your input',
    line: [[265, 1189], [265, 850]],
    words: [140, 965, 390, 1070],
    copy: 'loop-intake, its own lane on the Mini, takes the oldest Requested ticket and writes it up as a spec: a goal, a scope, what it must not do, acceptance criteria, test steps and the files it will change, with Dane\'s own words kept verbatim under an Asked heading. A request too big for one pull request is sliced, and each further slice is filed in Requested so no build loop reaches it early. The ticket then goes to Needs your input with a card asking him to approve it as written, or to say what to change.',
  },
  {
    id: 'operator-says-go',
    heading: 'Operator Says Go',
    from: 'Needs your input',
    to: 'Queued',
    line: [[521, 740], [600, 740], [600, 1099], [678, 1099]],
    words: [500, 870, 698, 970],
    copy: 'Dane answers the card on a ticket in Needs your input, often with a single word of approval, and the relay, the pass that carries out his comments every few minutes, moves the ticket on. With no pull request yet it goes to Queued, into line for a build pass. With a pull request still open it goes to Rework instead, and if he says to close it, or its pull request already merged, it goes to Live. No loop takes a ticket out of Needs your input any other way.',
  },
  {
    id: 'claimed-for-building',
    heading: 'Build Pass Claims the Next Ticket',
    from: 'Queued',
    to: 'Building',
    line: [[1223, 1300], [1417, 1300]],
    words: null,
    copy: 'This arrow has no label because it is one step: a build pass claims the ticket at the head of the queue with the claim command, which reads the ticket\'s status and refuses if it moved first. Only one build lane runs per project, and its passes run one after another, so two passes never build the same ticket. A ticket whose "Waits on:" line names an open ticket, or that shares a file with work in flight, is held back and the next one is taken.',
  },
  {
    id: 'rework-is-always-taken-first',
    heading: 'Rework Is Always Taken First',
    from: 'Rework',
    to: 'Building',
    line: [[1223, 724], [1615, 724], [1615, 1189]],
    words: [1450, 925, 1870, 1030],
    copy: 'A build pass takes every Rework ticket before any Queued one, because finishing half-built work comes before starting new work. The same claim command moves it to Building, but the pass does not start again: it checks out the branch that already exists, reads the reviewer\'s notes, fixes what they named and pushes to the same pull request. A Rework ticket is never held back for sharing files with other work in flight, since its pull request already exists.',
  },
  {
    id: 'pull-request-opened',
    heading: 'Pull Request Opened',
    from: 'Building',
    to: 'In review',
    line: [[1813, 1300], [1917, 1300]],
    words: [1735, 1095, 1995, 1192],
    copy: 'When the code is built and npm run verify passes, the build pass writes a plain-English work-log entry, opens a pull request titled with the ticket\'s exact name and linking back to the ticket, and records it with the pr-opened command, which checks both links. Only then does it move the ticket to In review. A pass may never end with its ticket still in Building, since no loop claims from there: a ticket left behind would be unreachable.',
  },
  {
    id: 'passes',
    heading: 'Passes',
    from: 'In review',
    to: 'Ready to launch',
    line: [[2312, 1300], [2418, 1300]],
    words: [2285, 1135, 2445, 1192],
    copy: 'loop-review, a separate lane that did not write the code, runs npm run verify itself, reads the change against the spec\'s acceptance criteria and walks the ticket\'s test steps for real. When everything holds, it writes a passing verdict on the ticket and hands it to Dane in Ready to launch with a card asking for his word to merge. The ask command refuses Ready to launch unless the newest verdict on the ticket is a pass.',
  },
  {
    id: 'operator-merges',
    heading: 'Operator Merges',
    from: 'Ready to launch',
    to: 'Live',
    line: [[2881, 1300], [2977, 1300]],
    words: [2848, 1095, 3045, 1192],
    copy: 'Dane replies on a Ready to launch ticket with a merge phrase, and the relay checks every gate again, the green verify check, the passing review and the pull request\'s state, before it merges the pull request and closes the ticket as Live. No build or review loop ever merges anything. On StarCaster alone, two auto-merge lanes may merge after an hour in which he did not object, under a standing policy he ruled on.',
  },
  {
    id: 'sent-back',
    heading: 'Sent Back',
    from: 'In review',
    to: 'Rework',
    line: [[2114, 1189], [2114, 450], [950, 450], [950, 628]],
    words: [1355, 415, 1645, 485],
    copy: 'When review finds a real problem, it writes a failing verdict naming what to fix and moves the ticket from In review to Rework, guarded on the status it expects, so nothing is written if the ticket has moved. The branch, the open pull request and the notes all survive, and the next build pass fixes what was named and pushes to the same pull request. A ticket may be sent back three times; after that the spec is the problem, not the builder.',
  },
  {
    id: 'judgment-call',
    heading: 'Judgment Call',
    from: 'In review',
    to: 'Needs your input',
    line: [[2220, 1189], [2220, 281], [281, 281], [281, 628]],
    words: [1320, 250, 1675, 312],
    copy: 'Some questions only Dane can settle: what a feature should do, whether a cost is worth it, or a spec that has proved wrong. When review meets one, it hands the ticket to him in Needs your input with an operator card ending in his move, instead of passing it or sending it back. A fourth send-back is never made: after three rounds review asks him here, because failing again and again means the spec needs his judgment.',
  },
  {
    id: 'oldest-first',
    heading: 'Oldest First (Priority Ignored)',
    from: 'Rework',
    to: 'Building',
    line: null,
    words: [765, 803, 1135, 897],
    copy: 'Rework tickets are taken in the order they were created, and their priority is not consulted. Priority says what to start, and rework is not started: it is half-built work with a branch, an open pull request and review notes already waiting. Taking the oldest first keeps send-backs from going stale behind fresh high-priority work, which is what happened before Rework became its own status on 31 August 2026.',
  },
  {
    id: 'highest-priority-first',
    heading: 'Highest Priority First, Then Oldest',
    from: 'Queued',
    to: 'Building',
    line: null,
    words: [725, 1420, 1175, 1520],
    copy: 'A build pass takes the most urgent Queued ticket first: urgent before high before normal before low. Within one priority, a ticket given a place in the queue on the tracker page comes before one without, lower place first, but place never beats priority. After that the oldest goes first. No Queued ticket is taken at all while any Rework ticket waits, because finishing half-built work comes before starting new work.',
  },
].map((a) => Object.freeze(a)));

/** One arrow's pop-up body (SP-391): its heading, the two statuses it joins and its copy. */
export function renderArrowDetails(arrow) {
  return `
    <h2 id="arrow-details-title">${escapeHtml(arrow.heading)}</h2>
    <p class="quiet">From ${escapeHtml(arrow.from)} to ${escapeHtml(arrow.to)}</p>
    <p>${escapeHtml(arrow.copy)}</p>`;
}

/**
 * One arrow or note's clickable target over the diagram (SP-391): a button
 * the keyboard reaches, holding an invisible wide line along the arrow and
 * an invisible rectangle round its words, so either opens its pop-up.
 */
function renderArrowTarget(arrow) {
  const label = `${arrow.heading}: from ${arrow.from} to ${arrow.to}`;
  const line = arrow.line ? `<polyline points="${arrow.line.map(([x, y]) => `${x},${y}`).join(' ')}"></polyline>` : '';
  const words = arrow.words ? (([l, t, r, b]) => `<rect x="${l}" y="${t}" width="${r - l}" height="${b - t}" rx="16"></rect>`)(arrow.words) : '';
  return `<g class="diagram-arrow" role="button" tabindex="0" aria-haspopup="dialog" data-arrow="${escapeHtml(arrow.id)}" aria-label="${escapeHtml(label)}"><title>${escapeHtml(arrow.heading)}</title>${line}${words}</g>`;
}

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
 * Over each arrow and note, in the same SVG, a target that opens its pop-up
 * (SP-391), drawn with the one dialog they share.
 * `docAddress` turns a docs/ path into the page's address for it.
 */
export function renderLoopQueueDiagram(docAddress) {
  const d = LOOP_QUEUE_DIAGRAM;
  const links = d.boxes.map(({ label, box: [l, t, r, b], anchor }) => {
    const href = escapeHtml(`${docAddress(d.page)}#${anchor}`);
    return `<a class="diagram-box" href="${href}" aria-label="${escapeHtml(label)}"><title>${escapeHtml(label)}</title><rect x="${l}" y="${t}" width="${r - l}" height="${b - t}" rx="24"></rect></a>`;
  }).join('');
  const arrows = LOOP_QUEUE_ARROWS.map(renderArrowTarget).join('');
  const dialog = `<dialog class="arrow-details" aria-labelledby="arrow-details-title">
      <form method="dialog">
        <button type="submit" class="close" aria-label="Close">×</button>
        <div class="arrow-details-body"></div>
        <div class="row"><button type="submit" class="btn">Close</button></div>
      </form>
    </dialog>`;
  return `<figure class="loop-diagram" id="${LOOP_QUEUE_FIGURE_ID}"><img src="${d.src}" alt="${escapeHtml(d.alt)}" width="${d.width}" height="${d.height}"><svg class="loop-diagram-links" viewBox="0 0 ${d.width} ${d.height}" role="group" aria-label="Loop Queue statuses and arrows">${links}${arrows}</svg>${dialog}</figure>`;
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
