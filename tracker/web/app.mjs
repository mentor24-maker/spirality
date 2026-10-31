/**
 * Dane's page (docs/TRACKER_MVP.md, "Dane's page"): sign in, see what waits
 * on you, open a ticket, answer it, pick a project, see that project's
 * whole queue as a board or as a list, see one project's details, add a
 * project (a person only), file a new request, and copy a ticket into
 * another project. Plain browser
 * JavaScript, no packages,
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
import { escapeHtml, renderComment, renderMarkdown, renderQuickAction, tabTitle } from './render.mjs';

const TOKEN_KEY = 'tracker-token';
/** Board or list: the last one opened, so "Tasks" in the header opens it again. */
const VIEW_KEY = 'tracker-view';
/** The selected project: the one "Tasks" in the header opens. */
const PROJECT_KEY = 'tracker-project';
/** The selected project's name, shown in the header beside the person signed in. */
const PROJECT_NAME_KEY = 'tracker-project-name';
/** The New request form's text while it is being typed, so a sign-out or a reload does not lose it. */
const DRAFT_KEY = 'tracker-request-draft';
const main = document.getElementById('main');
const who = document.getElementById('who');
const headerProject = document.getElementById('project');
const signOut = document.getElementById('sign-out');
let me = null;

/** How often the waiting count in the tab title is read again. */
const COUNT_EVERY_MS = 60_000;
/** The title the page itself asks for, and the last waiting count read (null: none yet). */
let pageTitle = 'Tracker';
let waitingCount = null;

function setTitle(title) {
  pageTitle = title;
  document.title = tabTitle(waitingCount, pageTitle);
}

/** Read the waiting count again and put it in the tab title. A failed read leaves the title alone. */
async function refreshCount() {
  if (!me) return;
  try {
    const { waiting } = await api('GET', '/waiting');
    waitingCount = waiting.length;
  } catch (err) {
    if (err instanceof SignedOut) drawSignIn();
    return;
  }
  document.title = tabTitle(waitingCount, pageTitle);
}

/** A status as the contract writes it: "needs your input" -> "Needs your input". */
const statusName = (s) => String(s ?? '').replace(/^./, (c) => c.toUpperCase());

/** A time in this computer's own time zone, with the zone named. */
const when = (iso) => new Date(iso).toLocaleString(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

class SignedOut extends Error {}

/** A refused call, carrying the HTTP status the tracker answered with. */
class Refused extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

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
  if (!res.ok) throw new Refused(json?.message ?? `the tracker answered ${res.status}.`, res.status);
  if (!json) throw new Error('the tracker answered with something that is not JSON.');
  return json;
}

function showError(err) {
  main.innerHTML = `<p class="error">${escapeHtml(err.message)}</p><p><a href="/">Back to Waiting on you</a></p>`;
}

function drawSignIn(problem) {
  me = null;
  waitingCount = null;
  who.textContent = '';
  headerProject.hidden = true;
  signOut.hidden = true;
  setTitle('Sign in · Tracker');
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
  waitingCount = waiting.length;
  setTitle('Waiting on you · Tracker');
  const rows = (list) => list.map((t) => `
    <tr>
      <td class="project">${escapeHtml(t.projectName)}</td>
      <td class="status">${escapeHtml(statusName(t.status))}</td>
      <td><a href="/t/${encodeURIComponent(t.id)}">${escapeHtml(t.name)}</a> <span class="quiet">${escapeHtml(t.id)}</span></td>
      <td class="when">${escapeHtml(when(t.updatedAt))}</td>
    </tr>`).join('');
  const table = (list) => `<table class="tickets"><thead><tr><th>Project</th><th>Status</th><th>Ticket</th><th>Last change</th></tr></thead><tbody>${rows(list)}</tbody></table>`;
  main.innerHTML = `
    <h1>Waiting on you</h1>
    ${waiting.length ? table(waiting) : '<p class="quiet">Nothing is waiting on you.</p>'}
    ${unsure.length ? `
      <h2>In your statuses but not assigned to you</h2>
      <p class="quiet">A hand-off that did not finish: the loop cannot tell whether these need you.</p>
      ${table(unsure)}` : ''}`;
}

/** The list's action icons: drawn here, never from ticket text. 24-unit outline icons. */
const ICONS = Object.freeze({
  open: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  reply: '<path d="M4 5h16v11H9l-5 4z"/>',
  view: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  pullRequest: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7"/><path d="M18 15.5V9a3 3 0 0 0-3-3h-4"/><path d="M13 3.5L10.5 6 13 8.5"/>',
});

/** One action icon: a link with its name as tooltip and for screen readers. Off-site links open a new tab. */
function action(href, label, icon, offSite = false) {
  const target = offSite ? ' target="_blank" rel="noopener noreferrer"' : '';
  return `<a class="action" href="${escapeHtml(href)}" title="${label}" aria-label="${label}"${target}>`
    + `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg></a>`;
}

/** Only an http(s) address is ever drawn as a link or an image; anything else is not drawn. */
const isWebAddress = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);

/** A project's logo, drawn small, or nothing when it has none. */
const logoOf = (p, cls = 'logo') => (isWebAddress(p.logo)
  ? `<img class="${cls}" src="${escapeHtml(p.logo)}" alt="" referrerpolicy="no-referrer">`
  : '');

/** A project's web address as a link that opens a new tab, or "none". */
const addressOf = (p) => (isWebAddress(p.url)
  ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.url)}</a>`
  : '<span class="quiet">none</span>');

/** The remembered view; a browser that will not keep it answers "list". */
function savedView() {
  try { return localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'list'; } catch { return 'list'; }
}

/** The selected project's slug, or null when none is remembered. */
function savedProject() {
  try { return localStorage.getItem(PROJECT_KEY); } catch { return null; }
}

/** Put the selected project's name in the header; none selected, nothing shown. */
function showProject() {
  let name = null;
  try { name = localStorage.getItem(PROJECT_NAME_KEY); } catch { /* nothing remembered */ }
  headerProject.textContent = name ?? '';
  headerProject.hidden = !name;
}

/**
 * Every project, one row each: its logo, name, slug, ticket ids, web
 * address, owner, how many tickets are open, and an Actions column whose
 * View icon opens its details page. Choosing a name selects the project and
 * opens its tasks; the selected one is marked, and "Tasks" in the header
 * goes back to it. A person signed in gets a New project button; a loop's
 * sign-in does not, and the server refuses it anyway.
 */
async function drawProjects() {
  const { projects } = await api('GET', '/projects');
  setTitle('Projects · Tracker');
  const selected = savedProject();
  // A renamed project shows its new name in the header from here on.
  const chosen = projects.find((p) => p.slug === selected);
  if (chosen) {
    try { localStorage.setItem(PROJECT_NAME_KEY, chosen.name); } catch { /* not remembered */ }
    showProject();
  }
  const row = (p) => `
    <tr${p.slug === selected ? ' class="selected"' : ''}>
      <td class="logo">${logoOf(p)}</td>
      <td class="name"><a href="/${savedView()}/${encodeURIComponent(p.slug)}"${p.slug === selected ? ' aria-current="true"' : ''}>${escapeHtml(p.name)}</a>${p.slug === selected ? '<span class="tag">Selected</span>' : ''}</td>
      <td class="slug">${escapeHtml(p.slug)}</td>
      <td class="prefix">${escapeHtml(p.prefix)}</td>
      <td class="url">${addressOf(p)}</td>
      <td class="owner">${p.owner ? escapeHtml(p.owner.name) : '<span class="quiet">nobody</span>'}</td>
      <td class="open">${p.open}</td>
      <td class="actions">${action(`/projects/${encodeURIComponent(p.slug)}`, 'View project', ICONS.view)}</td>
    </tr>`;
  main.innerHTML = `
    <h1>Projects</h1>
    ${me?.kind === 'human' ? '<div class="toolbar"><a class="button" href="/projects/new">New project</a></div>' : ''}
    ${projects.length
    ? `<p class="quiet">Choose a project's name to see its tasks.</p>
      <table class="projects"><thead><tr><th class="logo"><span class="hidden">Logo</span></th><th class="name">Name</th><th class="slug">Slug</th><th class="prefix">Ticket prefix</th><th class="url">Web address</th><th class="owner">Owner</th><th class="open">Open tickets</th><th class="actions">Actions</th></tr></thead><tbody>${projects.map(row).join('')}</tbody></table>`
    : '<p class="quiet">There are no projects yet.</p>'}`;
}

/**
 * One project's details: its logo, name, slug, ticket prefix, web address,
 * owner, operator, how many
 * tickets are open and how many sit in each status, with links to its board
 * and its list. Read-only. An unknown slug says so plainly.
 */
async function drawProjectDetails(slug) {
  let p;
  try {
    p = await api('GET', `/projects/${encodeURIComponent(slug)}`);
  } catch (err) {
    if (!(err instanceof Refused) || err.status !== 404) throw err;
    setTitle('No such project · Tracker');
    main.innerHTML = `<h1>Projects</h1><p>There is no project ${escapeHtml(slug)}.</p><p><a href="/projects">Back to Projects</a></p>`;
    return;
  }
  setTitle(`${p.name} · Tracker`);
  const at = (v) => `/${v}/${encodeURIComponent(p.slug)}`;
  const counts = p.statuses.map((s) => `<tr><td class="status">${escapeHtml(s.status)}</td><td class="count">${s.count}</td></tr>`).join('');
  main.innerHTML = `
    <h1 class="project">${logoOf(p, 'logo big')}${escapeHtml(p.name)}</h1>
    <div class="toolbar">
      <a href="/projects">All projects</a>
      <nav class="views" aria-label="Open"><a href="${at('board')}">Board</a><a href="${at('list')}">List</a></nav>
    </div>
    <dl class="details">
      <dt>Slug</dt><dd>${escapeHtml(p.slug)}</dd>
      <dt>Ticket prefix</dt><dd>${escapeHtml(p.prefix)}</dd>
      <dt>Web address</dt><dd>${addressOf(p)}</dd>
      <dt>Owner</dt><dd>${p.owner ? escapeHtml(p.owner.name) : '<span class="quiet">nobody</span>'}</dd>
      <dt>Operator</dt><dd>${p.operator ? escapeHtml(p.operator.name) : '<span class="quiet">nobody</span>'}</dd>
      <dt>Open tickets</dt><dd>${p.open}</dd>
    </dl>
    <h2>Tickets by status</h2>
    <table class="counts"><thead><tr><th>Status</th><th class="count">Tickets</th></tr></thead><tbody>${counts}</tbody></table>`;
}

/**
 * The Create Project form, for a person only: name, slug, ticket prefix, web
 * address, logo (an image's web address) and owner, picked from the
 * tracker's people. Saving files the project and opens its details page,
 * which reads it back from the server. A refused save shows the server's own
 * message and leaves every field as typed: the form is not redrawn.
 */
async function drawCreateProject() {
  setTitle('New project · Tracker');
  if (me?.kind !== 'human') {
    main.innerHTML = '<h1>New project</h1><p>Only a person signed in to the tracker can add a project.</p><p><a href="/projects">Back to Projects</a></p>';
    return;
  }
  const { people } = await api('GET', '/people');
  const field = (id, label, hint, attrs = '') => `
      <label for="${id}">${label}</label>
      ${hint ? `<span class="hint quiet">${hint}</span>` : ''}
      <input id="${id}" type="text"${attrs}>`;
  main.innerHTML = `
    <h1>New project</h1>
    <form class="request project">
      ${field('name', 'Name', '', ' required')}
      ${field('slug', 'Slug', 'Its part of every address, like my-project: small letters, digits and hyphens.', ' required autocapitalize="off" spellcheck="false"')}
      ${field('prefix', 'Ticket prefix', 'The start of its ticket ids, like SP in SP-12: capital letters and digits.', ' required autocapitalize="characters" spellcheck="false"')}
      ${field('url', 'Web address', 'Optional. Starts http:// or https://.', ' inputmode="url" spellcheck="false"')}
      ${field('logo', 'Logo', "Optional. An image's web address, starting http:// or https://.", ' inputmode="url" spellcheck="false"')}
      <label for="owner">Owner</label>
      <select id="owner"><option value="">Nobody</option>${people.map((p) => `<option value="${escapeHtml(p.id)}"${p.id === me.id ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select>
      <div class="row"><button type="submit">Add project</button><a href="/projects">Cancel</a><span class="note"></span></div>
    </form>`;
  const form = main.querySelector('form.project');
  const value = (id) => form.querySelector(`#${id}`).value;
  const note = form.querySelector('.note');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    note.className = 'note quiet';
    note.textContent = 'Adding…';
    try {
      const made = await api('POST', '/projects', {
        name: value('name'), slug: value('slug'), prefix: value('prefix'),
        url: value('url'), logo: value('logo'), owner: value('owner') ? Number(value('owner')) : null,
      });
      history.pushState(null, '', `/projects/${encodeURIComponent(made.slug)}`);
      await route();
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; the project was not added.');
      note.className = 'note error';
      note.textContent = `Not added: ${err.message}`;
      button.disabled = false;
    }
  });
  form.querySelector('#name').focus();
}

/**
 * "Tasks" in the header: the selected project, in the view last used. With
 * none selected, or one that no longer exists, the first project.
 */
async function drawTasks(view) {
  const { projects } = await api('GET', '/projects');
  if (!projects.length) {
    setTitle('Tasks · Tracker');
    main.innerHTML = '<h1>Tasks</h1><p class="quiet">There are no projects yet.</p>';
    return;
  }
  const slug = projects.some((p) => p.slug === savedProject()) ? savedProject() : projects[0].slug;
  history.replaceState(null, '', `/${view}/${encodeURIComponent(slug)}`);
  await drawProject(slug, view);
}

/**
 * One project, as a board or as a list. Both draw the same object, the
 * server's board (pageData.mjs boardOf): the eight statuses in the
 * contract's order, each holding its tickets in `queue` order, so the two
 * views cannot disagree about what is where. Read-only: moves stay with the
 * door and the loops. `Live` starts folded in both, its count showing,
 * because it only grows.
 *
 * The board is the statuses as columns of cards; the list is the same
 * statuses as groups of rows, with a ticket's priority, tags, assignee and
 * last change in their own columns, like ClickUp's List, and an Actions
 * column of icons. Each icon goes somewhere that already exists: the ticket,
 * the ticket's reply box, the ticket's pull request on GitHub.
 */
async function drawProject(slug, view) {
  const board = await api('GET', `/projects/${encodeURIComponent(slug)}/board`);
  // Opening a project selects it, and remembers the view: "Tasks" comes back here.
  try {
    localStorage.setItem(VIEW_KEY, view);
    localStorage.setItem(PROJECT_KEY, board.project);
    localStorage.setItem(PROJECT_NAME_KEY, board.projectName);
  } catch { /* the page still works; it is only not remembered */ }
  showProject();
  setTitle(`${board.projectName} ${view} · Tracker`);
  const at = (v, s) => `/${v}/${encodeURIComponent(s)}`;
  const toggle = ['board', 'list'].map((v) => `<a href="${at(v, board.project)}"${v === view ? ' class="current" aria-current="page"' : ''}>${v === 'board' ? 'Board' : 'List'}</a>`).join('');
  const head = (c) => `${escapeHtml(c.status)} <span class="quiet">${c.tickets.length}</span>`;
  /** A status's block: folded when it is Live, open otherwise. */
  const block = (c, cls, body) => (c.status === 'Live'
    ? `<details class="${cls}"><summary><h2>${head(c)}</h2></summary>${body}</details>`
    : `<section class="${cls}"><h2>${head(c)}</h2>${body}</section>`);

  const card = (t) => `
    <a class="card" href="/t/${encodeURIComponent(t.id)}">
      <span class="name">${escapeHtml(t.name)}</span>
      <span class="quiet">${escapeHtml(t.id)}${t.priority ? ` · ${escapeHtml(t.priority)}` : ''}</span>
      ${t.tags.length ? `<span class="tags">${t.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</span>` : ''}
    </a>`;
  const column = (c) => block(c, 'column', c.tickets.map(card).join('') || '<p class="quiet">None.</p>');

  const actions = (t) => {
    const at = `/t/${encodeURIComponent(t.id)}`;
    return [
      action(at, 'Open ticket', ICONS.open),
      action(`${at}#reply`, 'Reply', ICONS.reply),
      t.pullRequest ? action(t.pullRequest, 'Open pull request on GitHub', ICONS.pullRequest, true) : '',
    ].join('');
  };
  const row = (t) => `
    <tr>
      <td class="name"><a href="/t/${encodeURIComponent(t.id)}">${escapeHtml(t.name)}</a> <span class="quiet">${escapeHtml(t.id)}</span></td>
      <td class="priority">${t.priority ? escapeHtml(statusName(t.priority)) : '<span class="quiet">–</span>'}</td>
      <td class="tags">${t.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</td>
      <td class="assignee">${t.assignee ? escapeHtml(t.assignee) : '<span class="quiet">nobody</span>'}</td>
      <td class="when">${escapeHtml(when(t.updatedAt))}</td>
      <td class="actions">${actions(t)}</td>
    </tr>`;
  const group = (c) => block(c, 'group', c.tickets.length
    ? `<table><thead><tr><th class="name">Ticket</th><th class="priority">Priority</th><th class="tags">Tags</th><th class="assignee">Assigned to</th><th class="when">Last change</th><th class="actions">Actions</th></tr></thead><tbody>${c.tickets.map(row).join('')}</tbody></table>`
    : '');

  main.classList.add('wide');
  main.innerHTML = `
    <h1>Tasks</h1>
    <div class="toolbar">
      <a href="/projects">Change project</a>
      <nav class="views" aria-label="View">${toggle}</nav>
    </div>
    ${view === 'board'
    ? `<div class="board">${board.columns.map(column).join('')}</div>`
    : `<div class="list">${board.columns.map(group).join('')}</div>`}`;
}

async function drawTicket(id) {
  const [t, { projects }] = await Promise.all([
    api('GET', `/tickets/${encodeURIComponent(id)}/thread`),
    api('GET', '/projects'),
  ]);
  const others = projects.filter((p) => p.slug !== t.project);
  setTitle(`${t.name} · Tracker`);
  const comments = t.comments.map((c) => `
    <article class="comment${c.machine ? ' machine' : ''}">
      <div class="by">
        <span class="author">${escapeHtml(c.author.name)}</span>${c.machine ? '<span class="tag">loop</span>' : ''}
        · ${escapeHtml(when(c.createdAt))}${c.parent != null ? ` · a reply to comment ${escapeHtml(c.parent)}` : ''}
      </div>
      ${renderComment(c.body, { operatorName: me?.name })}
    </article>`).join('');
  // What it needs from Dane on top; everything else folded away, closed until he opens it.
  main.innerHTML = `
    <section class="quick">
      <div class="ask">${renderQuickAction(t)}</div>
      <form class="reply">
        <label for="reply">Reply as ${escapeHtml(me?.name ?? 'you')}</label>
        <textarea id="reply" required></textarea>
        <div class="row"><button type="submit">Post reply</button><span class="note"></span></div>
      </form>
    </section>
    <details class="details">
      <summary>Details</summary>
      <p class="meta">
        <span>${escapeHtml(t.id)}</span><span>${escapeHtml(t.projectName)}</span>
        <span>${escapeHtml(statusName(t.status))}</span>
        <span>${t.assignee ? `assigned to ${escapeHtml(t.assignee.name)}` : 'not assigned'}</span>
      </p>
      <section class="description">${renderMarkdown(t.description) || '<p class="quiet">No description.</p>'}</section>
      <h2>Comments</h2>
      ${comments || '<p class="quiet">No comments yet.</p>'}
      <h2>Copy to another project</h2>
      ${others.length ? `
      <form class="copy">
        <label for="copy-to">A new ticket with this title and description, in Requested there. This ticket stays exactly as it is.</label>
        <div class="row">
          <select id="copy-to">${others.map((p) => `<option value="${escapeHtml(p.slug)}">${escapeHtml(p.name)}</option>`).join('')}</select>
          <button type="submit">Copy</button><span class="note"></span>
        </div>
      </form>` : '<p class="quiet">There is no other project to copy into yet.</p>'}
    </details>`;
  const copyForm = main.querySelector('form.copy');
  copyForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = copyForm.querySelector('button');
    const copyNote = copyForm.querySelector('.note');
    button.disabled = true;
    copyNote.className = 'note quiet';
    copyNote.textContent = 'Copying…';
    try {
      const copy = await api('POST', `/tickets/${encodeURIComponent(t.id)}/clone`, { project: copyForm.querySelector('#copy-to').value });
      history.pushState(null, '', `/t/${encodeURIComponent(copy.id)}`);
      await route();
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; the ticket was not copied.');
      copyNote.className = 'note error';
      copyNote.textContent = `Not copied: ${err.message}`;
      button.disabled = false;
    }
  });
  const form = main.querySelector('form.reply');
  const box = form.querySelector('textarea');
  // Arrived by a Reply icon: go straight to the box.
  if (location.hash === '#reply') {
    form.scrollIntoView({ block: 'center' });
    box.focus();
  }
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
      // Show the reply he just posted: open Details at the end of the thread.
      main.querySelector('details.details').open = true;
      main.querySelector('.comment:last-of-type')?.scrollIntoView({ block: 'center' });
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; your reply was not posted.');
      note.className = 'note error';
      note.textContent = `Not posted: ${err.message}`;
      button.disabled = false;
    }
  });
}

/** The draft kept for the New request form, or empty fields. */
function savedDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}');
    return { project: String(d.project ?? ''), title: String(d.title ?? ''), description: String(d.description ?? '') };
  } catch { return { project: '', title: '', description: '' }; }
}

/**
 * The New request form: a project, a title and a description, filed into
 * `Requested`, which no loop builds from, unassigned and under the signed-in
 * person. The projects come from the server, and it starts on the one the
 * server's project config names. What he types is kept in this browser as
 * he types it, so a refused submit, a sign-out or a reload never loses it;
 * it is forgotten once the ticket is filed.
 */
async function drawNew() {
  const { projects, default: start } = await api('GET', '/projects');
  setTitle('New request · Tracker');
  if (!projects.length) {
    main.innerHTML = '<h1>New request</h1><p class="quiet">There are no projects to file into yet.</p>';
    return;
  }
  const draft = savedDraft();
  const chosen = projects.some((p) => p.slug === draft.project) ? draft.project : (start ?? projects[0].slug);
  main.innerHTML = `
    <h1>New request</h1>
    <form class="request">
      <label for="project">Project</label>
      <select id="project">${projects.map((p) => `<option value="${escapeHtml(p.slug)}"${p.slug === chosen ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select>
      <label for="title">Title</label>
      <input id="title" type="text" required>
      <label for="description">Description</label>
      <textarea id="description"></textarea>
      <div class="row"><button type="submit">File request</button><span class="note"></span></div>
    </form>`;
  const form = main.querySelector('form.request');
  const project = form.querySelector('#project');
  const title = form.querySelector('#title');
  const description = form.querySelector('#description');
  title.value = draft.title;
  description.value = draft.description;
  const keep = () => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ project: project.value, title: title.value, description: description.value }));
    } catch { /* the form still works; a sign-out would lose the text */ }
  };
  form.addEventListener('input', keep);
  form.addEventListener('change', keep);
  const note = form.querySelector('.note');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    keep();
    const button = form.querySelector('button');
    button.disabled = true;
    note.className = 'note quiet';
    note.textContent = 'Filing…';
    try {
      // Exactly as typed: no trimming, no formatting, the same rule as the reply box.
      const ticket = await api('POST', `/projects/${encodeURIComponent(project.value)}/tickets`, {
        name: title.value, description: description.value, status: 'Requested',
      });
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* nothing kept */ }
      history.pushState(null, '', `/t/${encodeURIComponent(ticket.id)}`);
      await route();
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; your request was not filed. What you typed is kept: it will be back in the form once you sign in.');
      note.className = 'note error';
      note.textContent = `Not filed: ${err.message}`;
      button.disabled = false;
    }
  });
  title.focus();
}

/** Underline the header link for the screen showing. */
function markNav(which) {
  for (const a of document.querySelectorAll('nav.site a')) a.classList.toggle('current', a.dataset.nav === which);
}

async function route() {
  try {
    me = await api('GET', '/me');
    who.textContent = `Signed in as ${me.name}`;
    signOut.hidden = false;
    showProject();
    main.classList.remove('wide');
    const ticket = /^\/t\/([^/]+)$/.exec(location.pathname);
    const project = /^\/(board|list)(?:\/([^/]+))?$/.exec(location.pathname);
    const projects = location.pathname === '/projects';
    const newProject = location.pathname === '/projects/new';
    const details = !newProject && /^\/projects\/([^/]+)$/.exec(location.pathname);
    const tasks = location.pathname === '/tasks';
    const isNew = location.pathname === '/new';
    markNav(isNew ? 'new' : projects || newProject || details ? 'projects' : ticket || project || tasks ? 'tasks' : 'waiting');
    if (isNew) {
      await drawNew();
      await refreshCount();
    } else if (ticket) {
      await drawTicket(decodeURIComponent(ticket[1]));
      await refreshCount();
    } else if (projects) {
      await drawProjects();
      await refreshCount();
    } else if (newProject) {
      await drawCreateProject();
      await refreshCount();
    } else if (details) {
      await drawProjectDetails(decodeURIComponent(details[1]));
      await refreshCount();
    } else if (tasks || (project && project[2] == null)) {
      // "Tasks" in the header: the selected project, in the view last used.
      await drawTasks(tasks ? savedView() : project[1]);
      await refreshCount();
    } else if (project) {
      await drawProject(decodeURIComponent(project[2]), project[1]);
      await refreshCount();
    } else {
      await drawWaiting();
    }
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
  history.pushState(null, '', a.pathname + a.hash);
  route();
});
window.addEventListener('popstate', route);
signOut.addEventListener('click', () => {
  localStorage.removeItem(TOKEN_KEY);
  history.pushState(null, '', '/');
  drawSignIn();
});

// The count in the tab title stays current while the tab sits pinned.
setInterval(refreshCount, COUNT_EVERY_MS);

route();
