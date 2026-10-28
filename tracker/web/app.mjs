/**
 * Dane's page (docs/TRACKER_MVP.md, "Dane's page"): sign in, see what waits
 * on you, open a ticket, answer it. Plain browser JavaScript, no packages,
 * no build step; tracker/server.mjs serves it.
 *
 * Every word of ticket text reaches the page through render.mjs, which
 * escapes it. Anything else drawn here is either this file's own fixed
 * wording or passed through escapeHtml.
 *
 * Signing in is the person's own tracker token, the same kind every loop
 * holds. It is kept in this browser's local storage so a pinned tab stays
 * signed in, and sent only to this server. "Sign out" forgets it.
 */
import { escapeHtml, renderComment, renderMarkdown } from './render.mjs';

const TOKEN_KEY = 'tracker-token';
const main = document.getElementById('main');
const who = document.getElementById('who');
const signOut = document.getElementById('sign-out');
let me = null;

/** A status as the contract writes it: "needs your input" -> "Needs your input". */
const statusName = (s) => String(s ?? '').replace(/^./, (c) => c.toUpperCase());

/** A time in this computer's own time zone, with the zone named. */
const when = (iso) => new Date(iso).toLocaleString(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

class SignedOut extends Error {}

/** Call the tracker as the signed-in person. Answers the parsed JSON, or throws with the server's own message. */
async function api(method, path, body) {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) throw new SignedOut();
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    throw new SignedOut();
  }
  let json = null;
  try { json = await res.json(); } catch { /* reported below */ }
  if (!res.ok) throw new Error(json?.message ?? `the tracker answered ${res.status}.`);
  if (!json) throw new Error('the tracker answered with something that is not JSON.');
  return json;
}

function showError(err) {
  main.innerHTML = `<p class="error">${escapeHtml(err.message)}</p><p><a href="/">Back to Waiting on you</a></p>`;
}

function drawSignIn(problem) {
  me = null;
  who.textContent = '';
  signOut.hidden = true;
  document.title = 'Sign in · Tracker';
  main.innerHTML = `
    <h1>Sign in</h1>
    <form class="sign-in">
      <label for="token">Your tracker token</label>
      <input id="token" type="password" autocomplete="current-password" required>
      <button type="submit">Sign in</button>
      ${problem ? `<p class="error">${escapeHtml(problem)}</p>` : ''}
    </form>`;
  const form = main.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    localStorage.setItem(TOKEN_KEY, form.querySelector('#token').value.trim());
    await route();
    if (!me) drawSignIn('That token was not accepted.');
  });
}

async function drawWaiting() {
  const { waiting, unsure } = await api('GET', '/waiting');
  document.title = 'Waiting on you · Tracker';
  const rows = (list) => list.map((t) => `
    <tr>
      <td class="project">${escapeHtml(t.projectName)}</td>
      <td class="status">${escapeHtml(statusName(t.status))}</td>
      <td><a href="/t/${encodeURIComponent(t.id)}">${escapeHtml(t.name)}</a> <span class="quiet">${escapeHtml(t.id)}</span></td>
      <td class="when">${escapeHtml(when(t.updatedAt))}</td>
    </tr>`).join('');
  const table = (list) => `<table><thead><tr><th>Project</th><th>Status</th><th>Ticket</th><th>Last change</th></tr></thead><tbody>${rows(list)}</tbody></table>`;
  main.innerHTML = `
    <h1>Waiting on you</h1>
    ${waiting.length ? table(waiting) : '<p class="quiet">Nothing is waiting on you.</p>'}
    ${unsure.length ? `
      <h2>In your statuses but not assigned to you</h2>
      <p class="quiet">A hand-off that did not finish: the loop cannot tell whether these need you.</p>
      ${table(unsure)}` : ''}`;
}

async function drawTicket(id) {
  const t = await api('GET', `/tickets/${encodeURIComponent(id)}/thread`);
  document.title = `${t.name} · Tracker`;
  const comments = t.comments.map((c) => `
    <article class="comment${c.machine ? ' machine' : ''}">
      <div class="by">
        <span class="author">${escapeHtml(c.author.name)}</span>${c.machine ? '<span class="tag">loop</span>' : ''}
        · ${escapeHtml(when(c.createdAt))}${c.parent != null ? ` · a reply to comment ${escapeHtml(c.parent)}` : ''}
      </div>
      ${renderComment(c.body, { operatorName: me?.name })}
    </article>`).join('');
  main.innerHTML = `
    <h1>${escapeHtml(t.name)}</h1>
    <p class="meta">
      <span>${escapeHtml(t.id)}</span><span>${escapeHtml(t.projectName)}</span>
      <span>${escapeHtml(statusName(t.status))}</span>
      <span>${t.assignee ? `assigned to ${escapeHtml(t.assignee.name)}` : 'not assigned'}</span>
    </p>
    <section class="description">${renderMarkdown(t.description) || '<p class="quiet">No description.</p>'}</section>
    <h2>Comments</h2>
    ${comments || '<p class="quiet">No comments yet.</p>'}
    <form class="reply">
      <label for="reply">Reply as ${escapeHtml(me?.name ?? 'you')}</label>
      <textarea id="reply" required></textarea>
      <div class="row"><button type="submit">Post reply</button><span class="note"></span></div>
    </form>`;
  const form = main.querySelector('form.reply');
  const box = form.querySelector('textarea');
  const note = form.querySelector('.note');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    note.className = 'note quiet';
    note.textContent = 'Posting…';
    try {
      // Exactly as typed: no trimming, no formatting. "merge" arrives as "merge".
      await api('POST', `/tickets/${encodeURIComponent(t.id)}/comments`, { body: box.value });
      await drawTicket(t.id);
      main.querySelector('.comment:last-of-type')?.scrollIntoView({ block: 'center' });
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; your reply was not posted.');
      note.className = 'note error';
      note.textContent = `Not posted: ${err.message}`;
      button.disabled = false;
    }
  });
}

async function route() {
  try {
    me = await api('GET', '/me');
    who.textContent = `Signed in as ${me.name}`;
    signOut.hidden = false;
    const ticket = /^\/t\/([^/]+)$/.exec(location.pathname);
    if (ticket) await drawTicket(decodeURIComponent(ticket[1]));
    else await drawWaiting();
  } catch (err) {
    if (err instanceof SignedOut) drawSignIn();
    else showError(err);
  }
}

// Links inside the page change the address without reloading it.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a || a.target === '_blank' || a.origin !== location.origin || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  history.pushState(null, '', a.pathname);
  route();
});
window.addEventListener('popstate', route);
signOut.addEventListener('click', () => {
  localStorage.removeItem(TOKEN_KEY);
  history.pushState(null, '', '/');
  drawSignIn();
});

route();
