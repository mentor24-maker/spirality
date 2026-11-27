/**
 * The phone page (/mlist): Waiting on You and Tasks, one tap apart, and a
 * ticket's ask on the same page, laid out for a phone held sideways, with
 * buttons and a dropdown that answer the ask (SP-409).
 *
 * Part of Dane's page: app.mjs is the entry the page loads and imports this
 * file. Its own file (SP-352), so a ticket that changes it never edits the
 * same file as one that changes another page. The drawing is
 * render-mlist.mjs.
 */
import { closeQuestion, goQuestion, mergeQuestion, mlistAnswer, mlistHref, mlistPlace, openTasks, renderMlist, renderMlistTicket } from './render.mjs';
import { api, setTitle, main, route, SignedOut, drawSignIn, showMessage } from './app.mjs';

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
    wireAnswers(thread, view);
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

/**
 * The answer controls under a ticket's ask (renderMlistAnswer). Each posts
 * what he would have typed, through the comments route the ticket page's
 * reply box, Merge, Close and Go use, and the relay acts on it; the page
 * never moves a status itself. Merge, Close and Go ask the ticket page's
 * own question first. On success the page goes back to the list it came
 * from, read again, so the answered ticket is off Waiting on You, and the
 * message strip says what was posted. A failed send says so in red in the
 * strip (UI_DOCTRINE 7) and the ticket stays open, its buttons back.
 */
function wireAnswers(ticket, view) {
  const answer = mlistAnswer(ticket);
  if (!answer) return;
  const questions = { 'merge-button': mergeQuestion(ticket), 'close-button': closeQuestion(ticket), 'go-button': goQuestion(ticket) };
  for (const form of main.querySelectorAll('form.mlist-answer')) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const kind = ['merge-button', 'close-button', 'go-button', 'pick', 'text'].find((k) => form.classList.contains(`mlist-${k}`));
      const body = kind === 'pick' ? form.querySelector('select').value
        : kind === 'text' ? form.querySelector('input').value.trim()
          : answer.word;
      if (!body) return showMessage({ kind: 'error', text: 'Not posted: there is nothing to send.' });
      if (questions[kind] && !confirm(questions[kind])) return;
      const buttons = [...main.querySelectorAll('form.mlist-answer button')];
      for (const b of buttons) b.disabled = true;
      showMessage({ kind: 'info', text: 'Posting…' });
      try {
        await api('POST', `/tickets/${encodeURIComponent(ticket.id)}/comments`, { body });
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn('You were signed out; your answer was not posted.');
        for (const b of buttons) b.disabled = false;
        return showMessage({ kind: 'error', text: `Not posted: ${err.message}` });
      }
      history.pushState(null, '', mlistHref({ view }));
      await route();
      showMessage({ kind: 'success', text: `Posted \u201c${body}\u201d on ${ticket.id}.` });
    });
  }
}
