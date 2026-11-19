/**
 * The API Usage report (/reporting/usage, page-usage.mjs, SP-398): what each
 * action that used the Claude plan's quota spent, per model, with the ticket
 * it worked on, in a table that can be added to, edited and deleted from.
 *
 * Its own file, re-exported by render.mjs, like every page's drawing
 * (SP-364). Every word from the tracker is escaped before it is drawn: an
 * action or a model is typed by a person or a loop.
 */
import { escapeHtml } from './render-common.mjs';
import { renderProjectPicker } from './render-tasks.mjs';

/** The four token counts a row carries, with their column names, in order. */
export const USAGE_COUNT_COLUMNS = Object.freeze([
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cacheWrite', label: 'Cache Write' },
  { key: 'cacheRead', label: 'Cache Read' },
]);

/** The report's sortable columns, in order; Actions follows them. */
export const USAGE_COLUMNS = Object.freeze([
  { key: 'at', label: 'When' },
  { key: 'action', label: 'Action' },
  { key: 'ticket', label: 'Ticket' },
  { key: 'model', label: 'Model' },
  ...USAGE_COUNT_COLUMNS,
  { key: 'total', label: 'Total Tokens' },
]);

/** A whole number of tokens with thousands marked: 1,234,567. */
export function tokens(n) {
  return Number(n || 0).toLocaleString('en-US');
}

/** A time as a datetime-local box holds it, in this computer's own time zone ("2026-11-19T11:05"); '' for none. */
export function localInputValue(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * The rows that match the Model picker (`model`, '' for every model) and the
 * Find box (`text`, matched in the action, ticket and model, case aside).
 */
export function filterUsage(rows, { model = '', text = '' } = {}) {
  const needle = String(text).trim().toLowerCase();
  return rows.filter((r) => (!model || r.model === model)
    && (!needle || [r.action, r.ticket, r.model].some((v) => String(v ?? '').toLowerCase().includes(needle))));
}

/** `rows` sorted by `sort` (`{ column, direction }`), ties kept in the order given; as given when there is no sort. */
export function sortUsage(rows, sort) {
  if (!sort || !USAGE_COLUMNS.some((c) => c.key === sort.column)) return rows.slice();
  const flip = sort.direction === 'descending' ? -1 : 1;
  const numeric = sort.column !== 'action' && sort.column !== 'ticket' && sort.column !== 'model' && sort.column !== 'at';
  const value = (r) => (sort.column === 'at' ? Date.parse(r.at) : r[sort.column]);
  const compare = (a, b) => {
    const x = value(a);
    const y = value(b);
    if (numeric || sort.column === 'at') return (x ?? 0) - (y ?? 0);
    if (x == null || x === '') return y == null || y === '' ? 0 : 1;
    if (y == null || y === '') return -1;
    return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
  };
  return rows.map((r, i) => [r, i]).sort(([a, i], [b, j]) => flip * compare(a, b) || i - j).map(([r]) => r);
}

/** The table's heading row: each column a button that sorts, the sorted one with `aria-sort` and an arrow; Actions plain. */
export function renderUsageHeadings(sort) {
  const heading = ({ key, label }) => {
    const on = sort?.column === key && (sort.direction === 'ascending' || sort.direction === 'descending');
    const arrow = on ? ` <span class="arrow" aria-hidden="true">${sort.direction === 'ascending' ? '▲' : '▼'}</span>` : '';
    const count = USAGE_COUNT_COLUMNS.some((c) => c.key === key) || key === 'total' ? ' count' : '';
    return `<th class="${key}${count}"${on ? ` aria-sort="${sort.direction}"` : ''}><button type="button" class="sort" data-sort="${key}">${escapeHtml(label)}${arrow}</button></th>`;
  };
  return `<tr>${USAGE_COLUMNS.map(heading).join('')}<th class="actions">Actions</th></tr>`;
}

/** One row of the table: its ticket a link to the ticket, its counts right-aligned, Edit and Delete last. */
function usageRow(r, timeOf) {
  const id = escapeHtml(r.id);
  const ticket = r.ticket ? `<a href="/t/${encodeURIComponent(r.ticket)}">${escapeHtml(r.ticket)}</a>` : '<span class="quiet">none</span>';
  return `<tr data-usage="${id}">
      <td class="at">${escapeHtml(timeOf(r.at))}</td>
      <td class="action">${escapeHtml(r.action)}</td>
      <td class="ticket">${ticket}</td>
      <td class="model">${escapeHtml(r.model)}</td>
      ${USAGE_COUNT_COLUMNS.map((c) => `<td class="count">${tokens(r[c.key])}</td>`).join('')}
      <td class="count total">${tokens(r.total)}</td>
      <td class="actions"><button type="button" class="btn btn-sm" data-edit-usage="${id}" aria-label="Edit This Row">Edit</button>
        <button type="button" class="btn btn-danger btn-sm" data-delete-usage="${id}" aria-label="Delete This Row">Delete</button></td></tr>`;
}

/** The table body for `rows`, each drawn by usageRow with its time put through `timeOf`. */
export function renderUsageBody(rows, { timeOf }) {
  return rows.map((r) => usageRow(r, timeOf)).join('');
}

/** The line under the table saying how many rows show: "12 of 40 actions" when filtered, "40 actions" when not. */
export function usageCountLine(shown, total) {
  const word = (n) => (n === 1 ? 'action' : 'actions');
  return shown === total ? `${total} ${word(total)}` : `${shown} of ${total} ${word(total)}`;
}

/**
 * The fields of the Add Usage form and of a row being edited, each id
 * ending in `suffix` so the two never share one. `r` fills them (an edit);
 * without it they are empty, the time now.
 */
function usageFields(r, suffix, { now }) {
  const value = (v) => (v == null ? '' : escapeHtml(v));
  const count = (key, label) => `<div class="beside"><label for="usage-${key}${suffix}">${label}</label>
      <input id="usage-${key}${suffix}" name="${key}" type="number" min="0" step="1" inputmode="numeric" value="${r ? Number(r[key]) : 0}"></div>`;
  return `<div class="beside"><label for="usage-at${suffix}">When</label>
      <input id="usage-at${suffix}" name="at" type="datetime-local" value="${escapeHtml(localInputValue(r ? r.at : now))}"></div>
    <label for="usage-action${suffix}">Action</label>
    <input id="usage-action${suffix}" name="action" maxlength="200" autocomplete="off" placeholder="Hand-run session" value="${value(r?.action)}">
    <label for="usage-model${suffix}">Model</label>
    <input id="usage-model${suffix}" name="model" maxlength="200" autocomplete="off" placeholder="claude-opus-5-5" value="${value(r?.model)}">
    <label for="usage-ticket${suffix}">Ticket</label>
    <input id="usage-ticket${suffix}" name="ticket" maxlength="200" autocomplete="off" placeholder="SP-12" value="${value(r?.ticket)}">
    ${USAGE_COUNT_COLUMNS.map((c) => count(c.key, `${c.label} Tokens`)).join('')}`;
}

/**
 * A form's values as the tracker takes an API usage row, or `{ problem }`
 * saying what to fix before anything is sent: an action and a model are
 * needed, the time must read as one, and each count is a whole number 0
 * or more. `get(name)` reads one box's value. A blank ticket is none.
 */
export function readUsageForm(get) {
  const action = String(get('action') ?? '').trim();
  const model = String(get('model') ?? '').trim();
  if (!action) return { problem: 'Not saved: say what the action was (for example, Hand-run session).' };
  if (!model) return { problem: 'Not saved: say which model it ran on (for example, claude-opus-5-5).' };
  const when = new Date(String(get('at') ?? ''));
  if (Number.isNaN(when.getTime())) return { problem: 'Not saved: give the date and time it happened.' };
  const body = { at: when.toISOString(), action, model, ticket: String(get('ticket') ?? '').trim() || null };
  for (const c of USAGE_COUNT_COLUMNS) {
    const raw = String(get(c.key) ?? '').trim();
    const n = raw === '' ? 0 : Number(raw);
    if (!Number.isSafeInteger(n) || n < 0) return { problem: `Not saved: ${c.label} Tokens is a whole number, 0 or more.` };
    body[c.key] = n;
  }
  return { body };
}

/** A row being edited, drawn in place of the row: its fields, then Save and Cancel. The row keeps its `data-usage`. */
export function renderUsageEditRow(r) {
  const id = escapeHtml(r.id);
  return `<td colspan="${USAGE_COLUMNS.length + 1}" class="edit-usage-cell"><form class="edit-usage fields" data-usage="${id}">
      ${usageFields(r, `-${id}`, { now: r.at })}
      <div class="row"><button type="submit" class="btn btn-save btn-sm">Save</button><button type="button" class="btn btn-sm cancel-edit">Cancel</button></div>
    </form></td>`;
}

/** The question asked before a row is deleted, naming what it spent. */
export function usageDeleteQuestion(r) {
  return `Delete this row? ${r?.action ?? ''} on ${r?.ticket ?? 'no ticket'}, ${r?.model ?? ''}: ${tokens(r?.total)} tokens. It comes off the report for good.`;
}

/**
 * The whole report for `project`: the title row (the Project picker and
 * Add Usage, the one main action), one line on what it counts, the Add
 * Usage form (hidden until Add Usage opens it), the totals per model, then
 * the rows with a Model picker and a Find box, newest first. `usage` is the
 * server's answer (`{ rows, byModel }`); `now` fills the new row's time.
 */
export function renderUsage({ projects, project, usage }, { timeOf, now = new Date().toISOString() }) {
  const rows = usage?.rows ?? [];
  const byModel = usage?.byModel ?? [];
  const models = byModel.map((m) => m.model).sort((a, b) => a.localeCompare(b));
  const sum = (key) => byModel.reduce((n, m) => n + m[key], 0);
  const summary = byModel.length
    ? `<div class="table-wrap"><table class="counts report usage-by-model"><thead><tr><th>Model</th><th class="count">Actions</th>${USAGE_COUNT_COLUMNS.map((c) => `<th class="count">${c.label}</th>`).join('')}<th class="count">Total Tokens</th></tr></thead>
      <tbody>${byModel.map((m) => `<tr><td class="name">${escapeHtml(m.model)}</td><td class="count">${tokens(m.actions)}</td>${USAGE_COUNT_COLUMNS.map((c) => `<td class="count">${tokens(m[c.key])}</td>`).join('')}<td class="count total">${tokens(m.total)}</td></tr>`).join('')}
      <tr class="all"><td class="name">All Models</td><td class="count">${tokens(sum('actions'))}</td>${USAGE_COUNT_COLUMNS.map((c) => `<td class="count">${tokens(sum(c.key))}</td>`).join('')}<td class="count total">${tokens(sum('total'))}</td></tr></tbody></table></div>`
    : '';
  const list = rows.length
    ? `<form class="usage-filter" role="search">
        <label for="usage-model-filter">Model</label>
        <select id="usage-model-filter"><option value="">All Models</option>${models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('')}</select>
        <label for="usage-search">Find</label>
        <input type="search" id="usage-search" placeholder="loop-build" autocomplete="off">
      </form>
      <div class="table-wrap"><table class="projects usage-list"><thead>${renderUsageHeadings(null)}</thead><tbody>${renderUsageBody(rows, { timeOf })}</tbody></table></div>
      <p class="quiet usage-count">${usageCountLine(rows.length, rows.length)}</p>`
    : `<p class="quiet no-usage">Nothing recorded for ${escapeHtml(project.name)} yet. Each loop pass adds its rows when it ends; Add Usage records one by hand.</p>`;
  return `<div class="title-row"><h1>API Usage</h1>
    <div class="toolbar">${renderProjectPicker(projects, project.slug)}<button type="button" class="btn btn-primary add-usage" aria-expanded="false" aria-controls="add-usage">Add Usage</button></div></div>
    <p class="page-desc">The tokens each Claude run spent for ${escapeHtml(project.name)}, by model and ticket: the unit the plan's quota is used in.</p>
    <section id="add-usage" class="add-usage" hidden aria-labelledby="add-usage-title">
      <h2 id="add-usage-title">Add Usage</h2>
      <form class="create-usage fields">
        ${usageFields(null, '', { now })}
        <div class="row"><button type="submit" class="btn btn-save">Save</button><button type="button" class="btn cancel-add">Cancel</button></div>
      </form>
    </section>
    <h2>By Model</h2>
    ${summary || '<p class="quiet">No tokens recorded yet.</p>'}
    <h2>Every Action</h2>
    ${list}`;
}
