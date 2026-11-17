/**
 * The Add Task page (page-add-task.mjs): the title choices and Suggest Next
 * Tasks.
 *
 * Split out of render.mjs (SP-364), which re-exports it, so every importer
 * still names render.mjs. Its rule holds here too: every character of
 * ticket text is escaped before it is drawn.
 */
import { escapeHtml, INFO_ICON, option } from './render-common.mjs';

/**
 * The Add Task box's two ways to name a task (SP-248): `suggest`, where the
 * title is picked from suggestions made from the description alone, and
 * `own`, where he types a title first and it is offered beside them.
 */
export const TITLE_MODES = Object.freeze(['suggest', 'own']);

/** A kept title mode read back from the browser: `own` only when it says so, else `suggest`. */
export function titleModeOf(text) {
  return text === 'own' ? 'own' : 'suggest';
}

/**
 * The Add Task box's choice list: in Write My Own Title his own title first
 * ("Keep my title: ..."), then the suggested ones, each a radio button whose
 * value is the title exactly as it is filed. A suggestion that repeats his
 * own title is not offered twice. The first choice starts picked. Every
 * title is escaped; an empty list draws nothing.
 */
export function renderTitleChoices({ own = null, titles = [] } = {}) {
  const mine = typeof own === 'string' && own.trim() ? own : null;
  const choices = [
    ...(mine == null ? [] : [{ value: mine, text: `Keep my title: ${mine}` }]),
    ...titles.filter((t) => typeof t === 'string' && t.trim() && t !== mine).map((t) => ({ value: t, text: t })),
  ];
  return choices.map((c, i) => `<label class="title-choice"><input type="radio" name="title-choice" value="${escapeHtml(c.value)}"${i === 0 ? ' checked' : ''}> <span>${escapeHtml(c.text)}</span></label>`).join('');
}

/** How often the Suggest Next Tasks box checks back while a run is going. */
export const SUGGEST_POLL_MS = 10_000;

/**
 * `order` (the suggestions' keys, first place first) with the one at `from`
 * moved to `to` (both 0-based, `to` held inside the list), the rest closing
 * up behind it: moving the fifth to second makes the old second to fourth
 * the third to fifth. A new array; the numbers shown are always place + 1,
 * so they stay 1, 2, 3 ... with no gaps or repeats.
 */
export function moveSuggestion(order, from, to) {
  const list = [...order];
  if (!Number.isInteger(from) || from < 0 || from >= list.length) return list;
  const at = Math.max(0, Math.min(list.length - 1, Number.isInteger(to) ? to : from));
  const [moved] = list.splice(from, 1);
  list.splice(at, 0, moved);
  return list;
}

/**
 * The Suggest Next Tasks box's kept state for a run that finished at `at`
 * with `count` suggestions: `saved` when it is for that same run and still
 * holds every suggestion once, else a fresh one (the list order, all kept,
 * none filed). `order` holds each suggestion's index in the run's list,
 * `dropped` the indexes unticked, `filed` index -> `{ id, project }`.
 */
export function suggestState(saved, at, count) {
  const fresh = { at, order: Array.from({ length: count }, (_, i) => i), dropped: [], filed: {} };
  if (!saved || typeof saved !== 'object' || saved.at !== at || !Array.isArray(saved.order)) return fresh;
  const order = saved.order;
  if (order.length !== count || [...order].sort((a, b) => a - b).some((v, i) => v !== i)) return fresh;
  const dropped = Array.isArray(saved.dropped) ? saved.dropped.filter((i) => Number.isInteger(i) && i >= 0 && i < count) : [];
  const filed = {};
  for (const [k, v] of Object.entries(saved.filed ?? {})) {
    if (Number(k) >= 0 && Number(k) < count && typeof v?.id === 'string' && typeof v?.project === 'string') filed[k] = { id: v.id, project: v.project };
  }
  return { at, order: [...order], dropped, filed };
}

/**
 * What "File in This Order" does with `state` (suggestState): `file`, the
 * kept suggestions not yet filed, in the order shown; `kept`, every kept
 * one in that order (filed before or now), whose tickets get places 1, 2,
 * 3 ... A suggestion already filed is never in `file`, so a retry files
 * nothing twice.
 */
export function filingPlan(state) {
  const dropped = new Set(state.dropped);
  const kept = state.order.filter((i) => !dropped.has(i));
  return { kept, file: kept.filter((i) => !state.filed[i]) };
}

/**
 * Which kept rows' tickets File in This Order puts in order (SP-251).
 * `kept` is filingPlan's kept rows in the order shown, `filed` the state's
 * filed tickets (`{ id, project }` by row), and `now` the tickets filed by
 * an earlier press as read back just now, by row: the ticket, or null when
 * it no longer answers. A row missing from `now` was filed by this press.
 *
 * Only a ticket still waiting (Requested, in the project it was filed into)
 * is ordered: placing a started one bumps its version, and a lane's or the
 * page's guarded write on it then fails (orderTickets, tracker/store.mjs).
 * A started one is left alone; one deleted or moved to another project is
 * `gone`, since naming it would make the whole order call fail.
 * Answers `{ byProject, leftAlone, gone }`: byProject maps a project to its
 * ids in the order shown; the other two are lists of `{ index, id }`.
 */
export function orderPlan(kept, filed, now = {}) {
  const byProject = new Map();
  const leftAlone = [];
  const gone = [];
  for (const index of kept) {
    const f = filed[index];
    if (!f) continue;
    if (Object.hasOwn(now, index)) {
      const t = now[index];
      if (!t || t.project !== f.project) { gone.push({ index, id: f.id }); continue; }
      if (t.status !== 'requested') { leftAlone.push({ index, id: f.id }); continue; }
    }
    byProject.set(f.project, [...(byProject.get(f.project) ?? []), f.id]);
  }
  return { byProject, leftAlone, gone };
}

/** "SP-1", "SP-1 and SP-2", "SP-1, SP-2 and SP-3". */
export function andList(items) {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** The box's line for a run: what is going on, or why it failed. Empty for a finished one. */
export function suggestRunLine(run) {
  if (!run) return '';
  if (run.state === 'running') return 'Reading the project for its next tasks… This takes a few minutes; the list shows here when it is done.';
  if (run.state === 'failed') return `No suggestions this time: ${run.message ?? 'the run failed.'}`;
  return '';
}

/**
 * The Suggest Next Tasks rows for `suggestions` in `state`'s order (suggestState):
 * each a drag handle (arrow keys move it too), its place as a dropdown of
 * 1 to the number of rows, a Keep checkbox, the title, an i button that
 * opens the row's About box (SP-304, renderSuggestionInfo), and the why and
 * description under More. The i carries the suggestion's own index, not its
 * place, so a moved row's i still opens its own suggestion. A filed row names its ticket. Every word is
 * escaped: a suggestion is text, never markup.
 */
export function renderSuggestRows(suggestions, state) {
  const n = state.order.length;
  const dropped = new Set(state.dropped);
  return state.order.map((i, place) => {
    const s = suggestions[i] ?? {};
    const title = escapeHtml(s.title ?? '');
    const options = Array.from({ length: n }, (_, k) => `<option value="${k + 1}"${k === place ? ' selected' : ''}>${k + 1}</option>`).join('');
    const filed = state.filed[i];
    return `<li class="suggestion" data-index="${i}" draggable="true">`
      + `<button type="button" class="drag-handle" aria-label="Move ${title}: arrow keys, or drag" title="Drag, or use the arrow keys">⠿</button>`
      + `<select class="place" aria-label="Place of ${title}">${options}</select>`
      // The value is written out: a checkbox without one reads "on" against a
      // drawn value of "", which the page's redraw hold takes for typing, and
      // the minute's redraw would never run while the list shows.
      + `<label class="keep"><input type="checkbox" value="keep"${dropped.has(i) ? '' : ' checked'}> Keep</label>`
      + `<span class="suggestion-title">${title}</span>`
      + `<button type="button" class="suggestion-info-open" data-index="${i}" aria-label="About ${title}" title="About This Task">${INFO_ICON}</button>`
      + (filed ? `<span class="filed">Filed <a href="/t/${encodeURIComponent(filed.id)}">${escapeHtml(filed.id)}</a></span>` : '')
      + `<details class="more"><summary>More</summary>`
      + (s.why ? `<p class="why"><strong>Why:</strong> ${escapeHtml(s.why)}</p>` : '')
      + (s.description ? `<p class="suggestion-description">${escapeHtml(s.description)}</p>` : '')
      + `</details></li>`;
  }).join('');
}

/** A GitHub repository's `owner/name`, the store's own shape; anything else links no file. */
const GITHUB_REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * A suggested file's address on GitHub, at `main` (SP-305), or null when
 * `repo` is not an `owner/name` or `path` is not a plain relative path (the
 * server checks it too: no `..`, no leading `/`, no scheme or `:`).
 */
export function suggestionFileHref(repo, path) {
  if (typeof repo !== 'string' || !GITHUB_REPO.test(repo) || typeof path !== 'string' || !path) return null;
  if (path.startsWith('/') || /[\u0000-\u001f\u007f\\:]/.test(path)) return null;
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '..')) return null;
  return `https://github.com/${repo}/blob/main/${parts.map(encodeURIComponent).join('/')}`;
}

/**
 * What a suggestion's About box holds (SP-304): its title as the heading,
 * Why It Matters and Description, then (SP-305) About This Task, Related
 * Tickets (each a link to its ticket, with its name), Topics and Tags as
 * chips, and Links: a file opens on the project's GitHub repository
 * (`repo`) at main, a ticket opens its page. Each only when the suggestion
 * has it; a file with no repository to link it to is named, unlinked.
 * Every word is escaped: a suggestion is text, never markup.
 */
export function renderSuggestionInfo(suggestion, { repo = null } = {}) {
  const s = suggestion ?? {};
  const list = (v) => (Array.isArray(v) ? v : []);
  const section = (heading, text) => (text
    ? `<h3>${heading}</h3><p>${escapeHtml(text)}</p>`
    : '');
  const ticketLink = (id, label) => `<a href="/t/${encodeURIComponent(id)}">${escapeHtml(label)}</a>`;
  const related = list(s.related).filter((r) => typeof r?.id === 'string' && r.id)
    .map((r) => `<li>${ticketLink(r.id, r.id)}${r.name ? ` ${escapeHtml(r.name)}` : ''}</li>`).join('');
  const chips = (heading, cls, names) => {
    const shown = list(names).filter((n) => typeof n === 'string' && n);
    return shown.length ? `<h3>${heading}</h3><p class="chips">${shown.map((n) => `<span class="${cls}">${escapeHtml(n)}</span>`).join('')}</p>` : '';
  };
  const links = list(s.links).map((l) => {
    if (typeof l?.ticket === 'string' && l.ticket) return `<li>${ticketLink(l.ticket, l.label || l.ticket)}</li>`;
    if (typeof l?.path !== 'string' || !l.path) return '';
    const href = suggestionFileHref(repo, l.path);
    const label = escapeHtml(l.label || l.path);
    const where = l.label && l.label !== l.path ? ` <code>${escapeHtml(l.path)}</code>` : '';
    return href
      ? `<li><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>${where}</li>`
      : `<li>${label}${where}</li>`;
  }).join('');
  const body = section('Why It Matters', s.why) + section('Description', s.description)
    + section('About This Task', s.about)
    + (related ? `<h3>Related Tickets</h3><ul class="related">${related}</ul>` : '')
    + chips('Topics', 'tag topic', s.topics)
    + chips('Tags', 'tag', s.tags)
    + (links ? `<h3>Links</h3><ul class="links">${links}</ul>` : '');
  return `<h2 id="suggestion-info-title">${escapeHtml(s.title ?? '')}</h2>`
    + (body || '<p class="quiet">This suggestion came with nothing more to say.</p>');
}

// ── The message strip (UI_DOCTRINE section 7, SP-323) ──────────────────────
// What a button reports (Saving…, Saved, Not saved: …) appears once, in one
// strip between the header and the page, one message at a time. app.mjs's
// showMessage puts it there; these draw what it shows.
