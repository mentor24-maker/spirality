/**
 * The Tasks page (page-tasks.mjs): the project and topic pickers, the kind
 * filters, the search, the list's cells and its sorting.
 *
 * Split out of render.mjs (SP-364), which re-exports it, so every importer
 * still names render.mjs. Its rule holds here too: every character of
 * ticket text is escaped before it is drawn.
 */
import { escapeHtml, capital, option, byText, lastIfMissing } from './render-common.mjs';

/**
 * The words every filter bar's project picker offers for "every project"
 * (SP-403): spelled here once, Title Case (UI_DOCTRINE), so no page can
 * spell it its own way.
 */
export const ALL_PROJECTS_CHOICE = 'All Projects';

/**
 * The one project picker every filter bar draws (SP-403): Board, List,
 * Console, Topics, API Usage and Reporting. "Project: " and a dropdown of
 * every project by name, `current` (a slug) selected. Each option's value is
 * its slug, which the page opens on a change. Names are typed by people, so
 * every one is escaped. With `all` (a page that can show every project),
 * ALL_PROJECTS_CHOICE comes first, its value empty, chosen when `current` is none
 * of the projects.
 */
export function renderProjectPicker(projects, current, { all = false } = {}) {
  const options = projects.map((p) => `<option value="${escapeHtml(p.slug)}"${p.slug === current ? ' selected' : ''}>${escapeHtml(p.name)}</option>`);
  if (all) options.unshift(`<option value=""${projects.some((p) => p.slug === current) ? '' : ' selected'}>${ALL_PROJECTS_CHOICE}</option>`);
  return `<label class="project-picker">Project: <select name="project">${options.join('')}</select></label>`;
}

/**
 * A filter bar's controls in the one order every bar uses (SP-403): the
 * project picker first, then the page's other pickers (Topic, Kind, Started
 * By, How It Ended), then the search, then the Pipeline Status pod, then
 * anything the page keeps after them (the Console's Features key). Each part
 * is already-drawn HTML; a part a page does not have is left out.
 */
export function renderFilterBar({ project = '', pickers = [], search = '', pod = '', after = '' } = {}) {
  return [project, ...[].concat(pickers), search, pod, after].filter(Boolean).join('');
}

/**
 * The Topic picker on the Tasks page's toolbar, beside the project picker:
 * "Topic: " and a dropdown of "Any" then `topics` (the board's, `{ id, name }`,
 * already alphabetical), each by its id. It changes nothing on the board:
 * the topic chosen goes into the search as its Topic filter. In All
 * Projects each topic also carries its `project` and `projectName`: it is
 * shown as "Docs (Spirality)", and holds its project's slug, which the
 * search takes as its Project filter, a topic belonging to one project.
 * Names are typed by people, so every one is escaped.
 */
export function renderTopicPicker(topics = []) {
  const options = topics.map((t) => (t.project == null
    ? option(String(t.id), t.name, false)
    : `<option value="${escapeHtml(String(t.id))}" data-project="${escapeHtml(t.project)}">${escapeHtml(`${t.name} (${t.projectName})`)}</option>`));
  return `<label class="topic-picker">Topic: <select name="topic">${option('', 'Any', true)}${options.join('')}</select></label>`;
}

/**
 * SP-345: the Tasks page's class filters, one picker each for Kind, Started
 * By and How It Ended, from the board's `classes` (each `{ key, label,
 * options }`). "Any" first, then "None" (a ticket not given one yet), then
 * the choices; `chosen` holds each picker's value ('' for Any).
 */
export function renderClassFilters(classes = [], chosen = {}) {
  if (!Array.isArray(classes) || !classes.length) return '';
  const picker = (f) => {
    const on = chosen[f.key] ?? '';
    const choices = [option('', 'Any', on === ''), option(NO_CLASS, 'None', on === NO_CLASS),
      ...(f.options ?? []).map((o) => option(o.value, o.label, on === o.value))].join('');
    return `<label>${escapeHtml(f.label)}: <select name="${escapeHtml(f.key)}">${choices}</select></label>`;
  };
  return `<div class="class-filters" role="group" aria-label="Filter by Kind, Started By and How It Ended">${classes.map(picker).join('')}</div>`;
}

/** The class filters' value for "a ticket with none yet". */
export const NO_CLASS = 'none';

/**
 * SP-345: the board's columns with only the tickets every chosen class
 * filter lets through (`chosen`: key -> value, '' or absent for Any,
 * NO_CLASS for none). Every column stays, so a stage with none left shows
 * its empty line; nothing here changes `columns`.
 */
export function filterByClass(columns = [], chosen = {}) {
  const on = Object.entries(chosen ?? {}).filter(([, v]) => v);
  if (!on.length) return columns;
  const passes = (t) => on.every(([key, v]) => (v === NO_CLASS ? t[key] == null : t[key] === v));
  return columns.map((c) => ({ ...c, tickets: c.tickets.filter(passes) }));
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
 * first, the chosen value selected. The Topic filter offers the chosen
 * project's topics, so while Project is "Any" it is greyed out, "Any"
 * alone, with the hint "Pick a project first".
 */
export function renderSearchFilters(filters = [], { tickets = null } = {}) {
  const noProject = filters.find((f) => f.key === 'project')?.value == null;
  const picker = (f) => {
    const idle = f.key === 'topic' && noProject;
    const choices = idle ? '' : f.options.map((o) => option(o.value, o.label, o.value === f.value)).join('');
    return `
    <label>${escapeHtml(f.label)}
      <select name="${escapeHtml(f.key)}"${idle ? ' disabled title="Pick a project first"' : ''}>${option('', 'Any', idle || f.value == null)}${choices}</select>${idle ? '<span class="quiet hint">Pick a project first</span>' : ''}
    </label>${f.key === 'project' && tickets ? renderTicketLookup(tickets) : ''}`;
  };
  return `<div class="search-filters">${filters.map(picker).join('')}</div>`;
}

/**
 * The Search page's "Ticket number" field (SP-192), drawn beside the
 * Project filter: a plain text box whose browser list offers each of
 * `tickets` (the server's `{ id, name }`, already narrowed to the chosen
 * project and to the projects the reader may see) as "<id> · <title>",
 * the last of them shown greyed in the empty box as an example.
 * Its own small form, so Enter in it is a lookup, never a search.
 */
export function renderTicketLookup(tickets = []) {
  const example = tickets.length ? ` placeholder="${escapeHtml(tickets[tickets.length - 1].id)}"` : '';
  const offered = tickets.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(`${t.id} · ${t.name}`)}</option>`).join('');
  return `
    <form class="ticket-lookup">
      <label>Ticket Number
        <input type="text" name="ticket" list="ticket-numbers" autocomplete="off" spellcheck="false"${example} size="9">
      </label>
      <datalist id="ticket-numbers">${offered}</datalist>
    </form>`;
}

/**
 * What the "Ticket number" field does with `typed` (SP-192): the ticket
 * page's address when it names one of `tickets` (ignoring case and spaces,
 * so "sp-12" finds SP-12), otherwise one plain line saying there is no such
 * ticket in `projectName`, or in any project when none is chosen. Nothing
 * typed is neither. Answers `{ href }`, `{ note }` or null.
 */
export function lookupTicket(typed, tickets = [], projectName = null) {
  const wanted = String(typed ?? '').replace(/\s+/g, '').toUpperCase();
  if (!wanted) return null;
  const hit = tickets.find((t) => String(t.id).toUpperCase() === wanted);
  if (hit) return { href: `/t/${encodeURIComponent(hit.id)}` };
  return { note: `No ticket ${wanted} in ${projectName ?? 'any project'}` };
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
 * SP-174: the Tasks tables' sortable headings. The priorities in order of
 * importance, the same order `PRIORITY_RANK` in lib/loopStatuses.js gives
 * (a test holds the two together; the page cannot load that file).
 */
export const PRIORITY_ORDER = Object.freeze(['urgent', 'high', 'normal', 'low']);

/**
 * SP-208: a List view row's Priority cell, a dropdown that saves on change
 * (app.mjs wireListPriorities). The same choices and rule as the Change
 * panel's picker: Urgent, High, Normal, Low, the ticket's own selected; a
 * ticket with none shows "None", and once one is picked "None" is no longer
 * offered. Beside it, the note that says "Saving…", "Saved" or a refusal.
 */
export function renderListPriority({ id, priority }) {
  const options = [
    ...(priority == null ? [option('', 'None', true)] : []),
    ...PRIORITY_ORDER.map((p) => option(p, capital(p), p === priority)),
  ].join('');
  return `<select class="list-priority" data-priority-of="${escapeHtml(id)}" aria-label="Priority of ${escapeHtml(id)}">${options}</select><span class="note" data-priority-note="${escapeHtml(id)}" role="status"></span>`;
}

/**
 * SP-244: a List view row's Assigned To cell, a dropdown that saves on change
 * (app.mjs wireListPickers). The same choices and rule as the Change panel's
 * picker: the project's operator, the current assignee marked "(now)" when
 * it is someone else, and Nobody. `operator` is the board's `{ id, name }`,
 * or null. Beside it, the note that says "Saving…", "Saved" or a refusal.
 */
export function renderListAssignee({ id, assignee, assigneeId }, operator) {
  const options = [
    ...(operator ? [option(String(operator.id), operator.name, assigneeId === operator.id)] : []),
    ...(assigneeId != null && assigneeId !== operator?.id ? [option(String(assigneeId), `${assignee ?? `actor ${assigneeId}`} (now)`, true)] : []),
    option('', 'Nobody', assigneeId == null),
  ].join('');
  return `<select class="list-assignee" data-assignee-of="${escapeHtml(id)}" aria-label="Assignee of ${escapeHtml(id)}">${options}</select><span class="note" data-assignee-note="${escapeHtml(id)}" role="status"></span>`;
}

/**
 * SP-246: every tag used on a board's tickets, each once, alphabetical
 * (case aside), for the List view's Add Tag dropdowns, with the project's
 * saved tags (the board's `tags`, SP-309) among them, so a tag made on the
 * Topics page is offered before any task carries it. `board` is the
 * server's board answer; anything unreadable in it is skipped.
 */
export function projectTags(board) {
  const seen = new Set();
  for (const tag of Array.isArray(board?.tags) ? board.tags : []) if (typeof tag === 'string' && tag) seen.add(tag);
  for (const c of Array.isArray(board?.columns) ? board.columns : []) {
    for (const t of Array.isArray(c?.tickets) ? c.tickets : []) {
      for (const tag of Array.isArray(t?.tags) ? t.tags : []) if (typeof tag === 'string' && tag) seen.add(tag);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * SP-246: a List view row's Tags cell (app.mjs wireListPickers). Each tag a
 * chip with a × that removes it; then an Add Tag dropdown of the project's
 * other tags (`known`, from projectTags), never one the ticket already has,
 * with New Tag… last, which opens the hidden text box beside it (Enter adds,
 * Escape cancels). Beside them, the note that says "Saving…", "Saved" or a
 * refusal.
 */
export function renderListTags({ id, tags = [] }, known = []) {
  const own = Array.isArray(tags) ? tags : [];
  const chips = own.map((tag) => `<span class="tag">${escapeHtml(tag)}<button type="button" class="remove-tag" data-untag-of="${escapeHtml(id)}" data-tag="${escapeHtml(tag)}" title="Remove ${escapeHtml(tag)}" aria-label="Remove tag ${escapeHtml(tag)} from ${escapeHtml(id)}">×</button></span>`).join('');
  const options = [
    option('', 'Add Tag', true),
    ...known.filter((tag) => !own.includes(tag)).map((tag) => option(tag, tag, false)),
    '<option value="" data-new-tag>New Tag…</option>',
  ].join('');
  return `${chips}<select class="list-tags" data-tags-of="${escapeHtml(id)}" aria-label="Add a tag to ${escapeHtml(id)}">${options}</select><input type="text" class="new-tag" data-new-tag-of="${escapeHtml(id)}" aria-label="New tag for ${escapeHtml(id)}: type it and press Enter" placeholder="docs" hidden><span class="note" data-tags-note="${escapeHtml(id)}" role="status"></span>`;
}

/**
 * SP-247: a List view row's Topics cell (app.mjs wireListPickers). Each of
 * the ticket's topics a chip with a × that removes it (a quiet dash when it
 * has none); then an Add Topic dropdown of the project's other topics
 * (`known`, the board's `topics`, each `{ id, name }`), never one the ticket
 * already has. A project with no topics says where they are made. Beside
 * them, the note that says "Saving…", "Saved" or a refusal.
 */
export function renderListTopics({ id, topics = [] }, known = []) {
  const own = Array.isArray(topics) ? topics.filter((t) => t && Number.isInteger(t.id)) : [];
  const all = Array.isArray(known) ? known.filter((t) => t && Number.isInteger(t.id)) : [];
  const ownIds = new Set(own.map((t) => t.id));
  const chips = own.length
    ? own.map((t) => `<span class="tag topic">${escapeHtml(t.name)}<button type="button" class="remove-tag" data-untopic-of="${escapeHtml(id)}" data-topic="${t.id}" title="Remove ${escapeHtml(t.name)}" aria-label="Remove topic ${escapeHtml(t.name)} from ${escapeHtml(id)}">×</button></span>`).join('')
    : '<span class="quiet">–</span>';
  const options = [
    option('', 'Add Topic', true),
    ...all.filter((t) => !ownIds.has(t.id)).map((t) => option(String(t.id), t.name, false)),
    ...(all.length ? [] : ['<option value="" disabled>No topics yet: make one on the Topics page</option>']),
  ].join('');
  return `${chips}<select class="list-topics" data-topics-of="${escapeHtml(id)}" aria-label="Add a topic to ${escapeHtml(id)}">${options}</select><span class="note" data-topics-note="${escapeHtml(id)}" role="status"></span>`;
}

/** The columns a stage's table sorts on, in the order they are drawn, with the class each cell wears. */
export const SORT_COLUMNS = Object.freeze([
  { key: 'id', label: 'Ticket #' },
  { key: 'name', label: 'Ticket' },
  { key: 'priority', label: 'Priority' },
  { key: 'tags', label: 'Tags' },
  { key: 'topics', label: 'Topics' },
  { key: 'assignee', label: 'Assigned To' },
  { key: 'when', label: 'Last Change' },
]);

const rankOf = (p) => {
  const i = PRIORITY_ORDER.indexOf(String(p ?? '').toLowerCase());
  return i === -1 ? null : i;
};
/** SP-193: the number after a ticket id's prefix (`SP-12` gives 12), or null when it has none. */
const numberOf = (id) => {
  const m = /(\d+)\s*$/.exec(String(id ?? ''));
  return m ? Number(m[1]) : null;
};
const COMPARE = {
  id: (a, b) => lastIfMissing((x, y) => x - y)(numberOf(a.id), numberOf(b.id)) || byText(String(a.id ?? ''), String(b.id ?? '')),
  name: (a, b) => byText(String(a.name ?? ''), String(b.name ?? '')),
  priority: (a, b) => lastIfMissing((x, y) => x - y)(rankOf(a.priority), rankOf(b.priority)),
  tags: (a, b) => lastIfMissing(byText)(a.tags?.[0] ?? null, b.tags?.[0] ?? null),
  topics: (a, b) => lastIfMissing(byText)(a.topics?.[0]?.name ?? null, b.topics?.[0]?.name ?? null),
  assignee: (a, b) => lastIfMissing(byText)(a.assignee || null, b.assignee || null),
  when: (a, b) => {
    const x = Date.parse(a.updatedAt);
    const y = Date.parse(b.updatedAt);
    return lastIfMissing((p, q) => p - q)(Number.isNaN(x) ? null : x, Number.isNaN(y) ? null : y);
  },
};

/**
 * A stage's tickets sorted by `column` (a SORT_COLUMNS key), `ascending` or
 * `descending`; descending is ascending turned round, so "none" comes first
 * there. Ties keep the order `tickets` came in. No sort, or a column it does
 * not know, gives the tickets back in the order they came. Never changes
 * `tickets`.
 */
export function sortTickets(tickets, sort) {
  const compare = sort && COMPARE[sort.column];
  if (!compare) return tickets.slice();
  const flip = sort.direction === 'descending' ? -1 : 1;
  return tickets
    .map((t, i) => [t, i])
    .sort(([a, i], [b, j]) => flip * compare(a, b) || i - j)
    .map(([t]) => t);
}

/** The sort a click on `column`'s heading gives: ascending first, the other way on a second click. */
export function nextSort(sort, column) {
  return sort?.column === column && sort.direction === 'ascending'
    ? { column, direction: 'descending' }
    : { column, direction: 'ascending' };
}

/**
 * A stage's table heading row: each sortable heading a button (Tab reaches
 * it, Enter or Space sorts), the sorted one marked with `aria-sort` and an
 * arrow, ▲ ascending, ▼ descending; Actions a plain heading.
 */
export function renderSortHeadings(sort) {
  const heading = ({ key, label }) => {
    const on = sort?.column === key && (sort.direction === 'ascending' || sort.direction === 'descending');
    const arrow = on ? ` <span class="arrow" aria-hidden="true">${sort.direction === 'ascending' ? '▲' : '▼'}</span>` : '';
    return `<th class="${key}"${on ? ` aria-sort="${sort.direction}"` : ''}><button type="button" class="sort" data-sort="${key}">${escapeHtml(label)}${arrow}</button></th>`;
  };
  return `<tr>${SORT_COLUMNS.map(heading).join('')}<th class="actions">Actions</th></tr>`;
}
