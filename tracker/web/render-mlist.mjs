/**
 * The phone page (/mlist), as HTML: a stripped-down page for a phone held
 * sideways that flips between Waiting on You and Tasks and opens a ticket's
 * ask on the same page. Pure: page-mlist.mjs reads the tracker and draws
 * what these return, and the tests call them directly.
 *
 * Where he is lives in the address, so a reload keeps it:
 * `/mlist` (Waiting on You), `/mlist?view=tasks`, and either with
 * `&ticket=<id>` for one ticket's ask.
 */
import { escapeHtml } from './render-common.mjs';
import { answerControl, renderAnswerOptions, renderQuickAction, statusLabel } from './render-ticket.mjs';

/** The two lists the page flips between, the first being where it opens. */
export const MLIST_VIEWS = Object.freeze([
  { view: 'waiting', label: 'Waiting on You' },
  { view: 'tasks', label: 'Tasks' },
]);

/** The stage Tasks leaves out: it only grows, and nothing there needs him. */
const LIVE = 'live';

/** Where the address puts him: `{ view, ticket }`, an unknown view reading as Waiting on You. */
export function mlistPlace(search = '') {
  const params = new URLSearchParams(search);
  const view = MLIST_VIEWS.some((v) => v.view === params.get('view')) ? params.get('view') : MLIST_VIEWS[0].view;
  const ticket = (params.get('ticket') ?? '').trim() || null;
  return { view, ticket };
}

/** The address of a place on the page; Waiting on You, the default, carries no `view`. */
export function mlistHref({ view = MLIST_VIEWS[0].view, ticket = null } = {}) {
  const params = new URLSearchParams();
  if (view !== MLIST_VIEWS[0].view) params.set('view', view);
  if (ticket) params.set('ticket', ticket);
  const query = params.toString();
  return query ? `/mlist?${query}` : '/mlist';
}

/**
 * Every open ticket on the boards he can see, as Tasks lists them: each
 * board's stages in the board's own order, Live left out.
 */
export function openTasks(boards = []) {
  const rows = [];
  for (const board of boards) {
    for (const column of board.columns ?? []) {
      if (String(column.status ?? '').trim().toLowerCase() === LIVE) continue;
      for (const t of column.tickets ?? []) rows.push({ ...t, status: column.status, projectName: board.projectName });
    }
  }
  return rows;
}

/**
 * The two lists at the top as tabs, the same markup as the Tasks and Settings
 * tabs: they are two views of one page, not actions, so neither is a button.
 * The one showing carries aria-current and takes the tab blue from nav.tabs.
 */
function renderToggle(view) {
  return `<nav class="tabs mlist-tabs" aria-label="Lists">${MLIST_VIEWS.map((v) => (v.view === view
    ? `<a href="${escapeHtml(mlistHref({ view: v.view }))}" aria-current="page">${v.label}</a>`
    : `<a href="${escapeHtml(mlistHref({ view: v.view }))}">${v.label}</a>`)).join('')}</nav>`;
}

/** One ticket's row: its id, name and status on one line, the whole row a link to its ask. */
export function renderMlistRow(t, view) {
  return `<li><a class="mlist-row" href="${escapeHtml(mlistHref({ view, ticket: t.id }))}">`
    + `<span class="mlist-id">${escapeHtml(t.id)}</span>`
    + `<span class="mlist-name">${escapeHtml(t.name)}</span>`
    + `<span class="mlist-status">${escapeHtml(statusLabel(t))}</span></a></li>`;
}

/** A list of rows, or the plain sentence saying it is empty. */
const rowsOf = (list, view, empty) => (list.length
  ? `<ul class="mlist-rows">${list.map((t) => renderMlistRow(t, view)).join('')}</ul>`
  : `<p class="quiet">${empty}</p>`);

/**
 * The list the address names: Waiting on You (`waiting`, and `unsure`, his
 * statuses with nobody assigned, apart as the home page shows them) or
 * Tasks (`tasks`, from openTasks).
 */
export function renderMlist({ view, waiting = [], unsure = [], tasks = [] }) {
  const body = view === 'tasks'
    ? rowsOf(tasks, view, 'No tickets are open right now.')
    : rowsOf(waiting, view, 'Nothing is waiting on you.')
      + (unsure.length ? `<h2>In Your Statuses but Not Assigned to You</h2>${rowsOf(unsure, view, '')}` : '');
  return `<div class="mlist">${renderToggle(view)}${body}</div>`;
}

/**
 * One ticket on the phone page: Back to the list it came from and Open Full
 * Page, then the same title, status, "what's going on" and red ask as the
 * ticket page's Quick Action (renderQuickAction), so the two never differ,
 * and under the ask the controls that answer it (renderMlistAnswer).
 */
export function renderMlistTicket(t, view) {
  return `<div class="mlist">`
    + `<nav class="mlist-toggle" aria-label="Ticket">`
    + `<a class="btn" href="${escapeHtml(mlistHref({ view }))}">Back</a>`
    + `<a class="btn" href="/t/${encodeURIComponent(t.id)}">Open Full Page</a></nav>`
    + `<section class="quick mlist-ticket"><div class="ask"><p class="mlist-id">${escapeHtml(t.id)}</p>${renderQuickAction(t)}${renderMlistAnswer(t)}</div></section>`
    + `</div>`;
}

/**
 * How the phone page answers a ticket, or null: the one rule the ticket
 * page uses too (answerControl in render-ticket.mjs), under the name the
 * phone page has always called it, so the two pages cannot drift (SP-423).
 */
export { answerControl as mlistAnswer } from './render-ticket.mjs';

/**
 * The phone page's answer to a ticket's ask, as HTML, or '' when there is
 * nothing to answer: one control for the card's move (a Merge, Close or Go
 * button, or a dropdown of its lettered options and Send), then a folded
 * Something Else box for any other reply. Every control posts exactly what
 * he would have typed, through the comments route the ticket page uses,
 * and reports in the message strip (UI_DOCTRINE 7), never a note beside it.
 */
export function renderMlistAnswer(t = {}) {
  const answer = answerControl(t);
  if (!answer) return '';
  // The labels sit inside the HTML, never quoted on their own: the page's code spells no merge or go word.
  const button = (kind, html) => `<form class="mlist-answer mlist-${kind}">${html}</form>`;
  const main = answer.kind === 'merge-button' ? button(answer.kind, '<button type="submit" class="btn btn-save">Merge</button>')
    : answer.kind === 'close-button' ? button(answer.kind, '<button type="submit" class="btn btn-save">Close</button>')
      : answer.kind === 'go-button' ? button(answer.kind, '<button type="submit" class="btn btn-save">Go</button>')
        : answer.kind === 'pick' ? `<form class="mlist-answer mlist-pick">`
          + '<label for="mlist-pick">Your Answer</label>'
          + `<select id="mlist-pick" required>${renderAnswerOptions(answer.options)}</select>`
          + `<button type="submit" class="btn btn-save">Send</button></form>`
          : '';
  const other = '<details class="mlist-other"><summary class="btn">Something Else</summary>'
    + '<form class="mlist-answer mlist-text"><label for="mlist-text">Your Reply</label>'
    + `<input id="mlist-text" type="text" required autocomplete="off"><button type="submit" class="btn">Send</button></form></details>`;
  return `<div class="mlist-answers">${main}${other}</div>`;
}
