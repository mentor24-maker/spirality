/**
 * The search across every ticket, for the Tasks page (SP-364 split it out
 * of pageData.mjs, which re-exports it): its weights, filters, the ticket
 * lookup and searchTickets.
 */
import machineComment from '../lib/machineComment.js';
import loopStatuses from '../lib/loopStatuses.js';
import { searchPattern } from './web/render.mjs';
import { visibleProjects } from './pageData-common.mjs';

const { isMachineComment, stripMachineMarker } = machineComment;
const { STAGE_ORDER, DISPLAY, PRIORITY_RANK, statusOf } = loopStatuses;

/**
 * Where a search looks, most weight first, in the order Dane gave them: the
 * title, the description, the discussion (comments people wrote), and the
 * development (comments the loops wrote: build and review notes, pull
 * request links, operator cards). Each weight is more than all the lighter
 * ones together, so a title match always outranks any mix of the others.
 */
export const SEARCH_WEIGHTS = Object.freeze({ title: 8, description: 4, discussion: 2, development: 1 });

/** About how many characters an excerpt shows, and how many of them come before the match. */
const EXCERPT_LENGTH = 160;
const EXCERPT_LEAD = 60;

/** Some text on one line, about EXCERPT_LENGTH characters around the first match of `pattern`. */
function excerptOf(text, pattern) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const at = flat.search(pattern);
  if (at < 0) return null;
  const start = Math.max(0, Math.min(at - EXCERPT_LEAD, flat.length - EXCERPT_LENGTH));
  const end = Math.min(flat.length, start + EXCERPT_LENGTH);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/** The priorities the store keeps, most urgent first: the ticket page's picker and the search's filter. */
export const PRIORITIES = Object.freeze(Object.keys(PRIORITY_RANK).sort((a, b) => PRIORITY_RANK[a] - PRIORITY_RANK[b]));

/** A status or priority as the page writes it: "urgent" -> "Urgent". */
const capital = (s) => String(s).replace(/^./, (c) => c.toUpperCase());

/**
 * The search's six filters, in the order the page shows them, each with
 * the query parameter that carries it, its label, and its choices as
 * `{ value, label }` (the value is what the address holds): the projects
 * the reader may see (visibleProjects, `only`) by name, the topics of
 * `project` (a slug of one of those projects) by name, alphabetical, each
 * by its id, and none while no project is chosen, the eight statuses in
 * the contract's STAGE_ORDER, the store's priorities plus "none", and
 * every actor, people and loops, by name ("Assigned to" also takes
 * "nobody"). "Created by" is the actor on a ticket's `created` event.
 */
export function searchFilterChoices(store, { only = null, project = null } = {}) {
  const actors = store.listActors().map((a) => ({ value: String(a.id), label: a.name }));
  const projects = visibleProjects(store, only);
  const topics = project != null && projects.some((p) => p.slug === project)
    ? store.listTopics(project)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id - b.id)
      .map((t) => ({ value: String(t.id), label: t.name }))
    : [];
  return [
    { key: 'project', label: 'Project', options: projects.map((p) => ({ value: p.slug, label: p.name })) },
    { key: 'topic', label: 'Topic', options: topics },
    { key: 'status', label: 'Status', options: STAGE_ORDER.map((name) => ({ value: name, label: name })) },
    { key: 'priority', label: 'Priority', options: [...PRIORITIES.map((p) => ({ value: p, label: capital(p) })), { value: 'none', label: 'None' }] },
    { key: 'createdBy', label: 'Created By', options: actors },
    { key: 'assignee', label: 'Assigned To', options: [{ value: 'nobody', label: 'Nobody' }, ...actors] },
  ];
}

/** What a filter's value is called in a refusal. */
const FILTER_NOUNS = Object.freeze({ project: 'project', topic: 'topic', status: 'status', priority: 'priority', createdBy: 'actor', assignee: 'actor' });

/**
 * Read the search's filters from `get(key)` (the address's query
 * parameters): each one absent or empty is "Any". A status or priority is
 * matched ignoring case. Answers `{ filters }`, each filter with the value
 * chosen (as its choice writes it) or null, or `{ problem }`, a plain
 * sentence naming the value that is not one of the choices. A project the
 * reader may not see (`only`) is not one of them: it is refused word for
 * word as one that does not exist, never answered. A topic is one of the
 * chosen project's, so one from another project, or any topic while no
 * project is chosen, is refused too.
 */
export function readSearchFilters(store, get, { only = null } = {}) {
  const project = String(get('project') ?? '').trim() || null;
  const filters = searchFilterChoices(store, { only, project }).map((f) => ({ ...f, value: null }));
  for (const f of filters) {
    const raw = String(get(f.key) ?? '').trim();
    if (!raw) continue;
    const hit = f.options.find((o) => (f.key === 'status' || f.key === 'priority' ? o.value.toLowerCase() === raw.toLowerCase() : o.value === raw));
    if (!hit) {
      const known = f.key === 'status' || f.key === 'priority' ? ` ${f.label} is one of: ${f.options.map((o) => o.label).join(', ')}.`
        : f.key === 'topic' && project == null ? ' Pick a project first: a topic belongs to one project.'
        : f.key === 'topic' ? ` ${f.label} is one of that project's topics${f.options.length ? `: ${f.options.map((o) => o.label).join(', ')}` : ', and it has none'}.` : '';
      return { problem: `There is no ${FILTER_NOUNS[f.key]} "${raw}" to filter ${f.label} by.${known}` };
    }
    f.value = hit.value;
  }
  return { filters };
}

/** Does `ticket` pass every chosen filter? Created by is read from its events only when that filter is on. */
function passesFilters(store, ticket, chosen, topicsOf) {
  if (chosen.topic != null && !(topicsOf.get(ticket.id) ?? []).some((t) => String(t.id) === chosen.topic)) return false;
  if (chosen.status != null && ticket.status !== statusOf(chosen.status)) return false;
  if (chosen.priority != null && (ticket.priority ?? 'none') !== chosen.priority) return false;
  if (chosen.assignee != null && String(ticket.assignee ?? 'nobody') !== chosen.assignee) return false;
  if (chosen.createdBy != null) {
    const created = store.listEvents(ticket.id).find((e) => e.field === 'created');
    if (String(created?.actor) !== chosen.createdBy) return false;
  }
  return true;
}

/**
 * The tickets the Search page's "Ticket number" field offers (SP-192):
 * every ticket of `project` (a slug, or null for every project), `Live`
 * ones too, each as `{ id, name }`, project by project in the order the
 * store lists them, then by number. Only the projects the reader may see
 * (visibleProjects, `only`) are read, so a project they may not see offers
 * nothing even when named. Reads only.
 */
export function lookupTickets(store, project = null, { only = null } = {}) {
  const tickets = [];
  for (const p of visibleProjects(store, only)) {
    if (project != null && p.slug !== project) continue;
    for (const t of store.listTickets(p.slug)) tickets.push({ id: t.id, name: t.name });
  }
  return tickets;
}

/**
 * Every ticket in every project (or the one the Project filter names), closed ones too, that matches `query` as
 * one phrase, ignoring case (render.mjs searchPattern, the same pattern the
 * page bolds with). A ticket scores the SEARCH_WEIGHTS of each place it
 * matched in; results go highest score first, then most recently changed.
 * Each carries its id, title, project, status (as the contract shows it),
 * score, and one excerpt from the heaviest place it matched outside the
 * title, with that place named (both null for a title-only match). Whether
 * a comment is a loop's is the relay's own check, as on the ticket page
 * (threadOf). `filters` (readSearchFilters) narrow the tickets before any
 * are scored; the answer carries them back, with their choices, for the
 * page to draw. `only` narrows the projects searched to the ones the
 * reader may see (visibleProjects). Reads only. An empty query finds nothing.
 */
export function searchTickets(store, query, filters = null, { only = null } = {}) {
  filters ??= searchFilterChoices(store, { only }).map((f) => ({ ...f, value: null }));
  const term = String(query ?? '').trim();
  const pattern = searchPattern(term);
  if (!pattern) return { query: term, filters, results: [] };
  const chosen = Object.fromEntries(filters.map((f) => [f.key, f.value]));
  const kinds = new Map();
  const isMachine = (c) => {
    if (!kinds.has(c.author)) kinds.set(c.author, store.getActor(c.author)?.kind);
    return kinds.get(c.author) === 'machine';
  };
  const results = [];
  for (const project of visibleProjects(store, only)) {
    if (chosen.project != null && project.slug !== chosen.project) continue;
    const topicsOf = chosen.topic != null ? store.ticketTopicsOf(project.slug) : null;
    for (const ticket of store.listTickets(project.slug)) {
      if (!passesFilters(store, ticket, chosen, topicsOf)) continue;
      const discussion = [];
      const development = [];
      for (const c of store.listComments(ticket.id)) {
        // Who wrote it decides which it is (SP-26); a stamp line on an
        // imported comment is history, taken off whoever wrote it.
        const text = isMachineComment(c.body) ? stripMachineMarker(c.body) : c.body;
        if (isMachine(c)) development.push(text);
        else discussion.push(text);
      }
      const places = [
        ['title', [ticket.name]],
        ['description', [ticket.description ?? '']],
        ['discussion', discussion],
        ['development', development],
      ];
      let score = 0;
      let place = null;
      let excerpt = null;
      for (const [name, texts] of places) {
        const hit = texts.find((text) => pattern.test(text));
        if (hit == null) continue;
        score += SEARCH_WEIGHTS[name];
        if (name !== 'title' && place == null) {
          place = name;
          excerpt = excerptOf(hit, pattern);
        }
      }
      if (!score) continue;
      results.push({
        id: ticket.id,
        name: ticket.name,
        project: project.slug,
        projectName: project.name,
        status: DISPLAY[ticket.status] ?? ticket.status,
        score,
        place,
        excerpt,
        updatedAt: ticket.updatedAt,
      });
    }
  }
  results.sort((a, b) => b.score - a.score || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return { query: term, filters, results };
}
