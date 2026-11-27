/**
 * The phone page (/mlist): Waiting on You and Tasks, one tap apart, and a
 * ticket's ask on the same page, laid out for a phone held sideways. Read
 * only; answering from here is a later slice.
 *
 * Part of Dane's page: app.mjs is the entry the page loads and imports this
 * file. Its own file (SP-352), so a ticket that changes it never edits the
 * same file as one that changes another page. The drawing is
 * render-mlist.mjs.
 */
import { mlistPlace, openTasks, renderMlist, renderMlistTicket } from './render.mjs';
import { api, setTitle, main } from './app.mjs';

/** The class the stylesheet keys the phone layout on, set on <body> only while /mlist is open. */
export const PHONE_CLASS = 'mlist-page';
/** The viewport line a phone needs to draw the page at its own width rather than a desktop's. */
const VIEWPORT = 'width=device-width, initial-scale=1';

/**
 * Turn the phone layout on for /mlist and off for every other page: the
 * body class that strips the header down, and the viewport line. The rest
 * of the site stays the desktop page it is (docs/TRACKER_MVP.md).
 */
export function phoneLayout(on) {
  document.body.classList.toggle(PHONE_CLASS, on);
  let meta = document.head.querySelector('meta[name="viewport"]');
  if (on && !meta) {
    meta = document.createElement('meta');
    meta.name = 'viewport';
    meta.content = VIEWPORT;
    document.head.append(meta);
  } else if (!on && meta) meta.remove();
}

/** Draw the place the address names: a ticket's ask, Tasks, or Waiting on You. */
export async function drawMlist() {
  const { view, ticket } = mlistPlace(location.search);
  if (ticket) {
    const thread = await api('GET', `/tickets/${encodeURIComponent(ticket)}/thread`);
    setTitle(`${thread.name} · Tracker`);
    main.innerHTML = renderMlistTicket(thread, view);
    return;
  }
  if (view === 'tasks') {
    const { projects } = await api('GET', '/projects');
    const boards = await Promise.all(projects.map((p) => api('GET', `/projects/${encodeURIComponent(p.slug)}/board`)));
    setTitle('Tasks · Tracker');
    main.innerHTML = renderMlist({ view, tasks: openTasks(boards) });
    return;
  }
  const { waiting, unsure } = await api('GET', '/waiting');
  setTitle('Waiting on You · Tracker');
  main.innerHTML = renderMlist({ view, waiting, unsure });
}
