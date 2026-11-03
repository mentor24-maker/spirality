/**
 * Dane's page (docs/TRACKER_MVP.md, "Dane's page"): sign in, see what waits
 * on you, open a ticket, answer it, change its priority, tags, assignee,
 * status, name or description (a person only), pick a project, see that project's
 * whole queue as a board or as a list, see one project's details, add,
 * change or delete a project (a person only), file a new request from the
 * Tasks page's Add Task box, copy a ticket into another
 * project, choose a colour for each stage on the Settings page, read the
 * Reporting page's figures, see and invite people on the People page
 * (a person only), and search every ticket from the Tasks page's Search field. Plain browser
 * JavaScript, no packages,
 * no build step; tracker/server.mjs serves it.
 *
 * Every word of ticket text reaches the page through render.mjs, which
 * escapes it. Anything else drawn here is either this file's own fixed
 * wording or passed through escapeHtml.
 *
 * Signing in is the person's email and password. The server answers with
 * a 30-day session cookie this script cannot read, so a pinned tab stays
 * signed in and nothing secret is kept in local storage. Every write says
 * `content-type: application/json`, which the server requires of a cookie's
 * writes. "Sign out" ends the session at the server. "Forgot password?"
 * asks for a reset link by email.
 *
 * `/set-password?link=<token>` is the one view drawn without signing in:
 * an emailed link's own page. The link's token is sent only in a JSON body,
 * never in an address.
 */
import { canDelete, closeQuestion, deleteQuestion, deleteRefusal, escapeHtml, mergeQuestion, renderCommands, renderComment, renderDeleteAction, renderEditPanel, MOVED_MESSAGE, renderMarkdown, renderCloseAction, renderGoAction, goQuestion, renderMergeAction, renderAnswerIn, statusLabel, ANSWER_IN_NOTE, renderQuickAction, renderProjectPicker, renderTrail, stageLooks, tabTitle, bellColour, linkProblem, passwordProblem, renderPasswordSet, renderSetPassword, renderSignIn, renderForgot, renderSearchFilters, renderSearchResults, redrawHold, drawnChoice } from './render.mjs';

/** Where an earlier version of the page kept a pasted token; removed on load, never read. */
const OLD_TOKEN_KEY = 'tracker-token';
/** Board or list: the last one opened, so "Tasks" in the header opens it again. */
const VIEW_KEY = 'tracker-view';
/** The selected project: the one "Tasks" in the header opens. */
const PROJECT_KEY = 'tracker-project';
/** The selected project's name, shown in the header beside the person signed in. */
const PROJECT_NAME_KEY = 'tracker-project-name';
/** The Add Task box's text while it is being typed, so a sign-out or a reload does not lose it. */
const DRAFT_KEY = 'tracker-request-draft';
const main = document.getElementById('main');
const who = document.getElementById('who');
const headerProject = document.getElementById('project');
const signOut = document.getElementById('sign-out');
const bell = document.getElementById('bell');
let me = null;

/**
 * How often the page reads again: the waiting count in the tab title, and
 * the open page itself (Waiting on you, a board or list, a ticket), which
 * is drawn again when what it was drawn from has changed.
 */
const REFRESH_EVERY_MS = 60_000;
/** The title the page itself asks for, and the last waiting count read (null: none yet). */
let pageTitle = 'Tracker';
let waitingCount = null;

/** Every GET of the draw under way, as path -> its answer in JSON; null between draws. */
let recording = null;
/** The page showing, if it is one that keeps itself current: its address and what it was drawn from. */
let lastDrawn = null;
/** Draws and writes under way; a beat never redraws over either. */
let drawing = 0;
let writing = 0;
/** True while a beat is redrawing the page, so the draw does not jump to the reply box again. */
let refreshing = false;

function setTitle(title) {
  pageTitle = title;
  document.title = tabTitle(waitingCount, pageTitle);
}

/** Colour the header bell from the last count read; before any read it stays grey. */
function showBell() {
  bell.dataset.colour = bellColour(waitingCount);
}

/** Read the waiting count again and put it in the tab title and the bell. A failed read leaves both alone. */
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
  showBell();
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
  const write = method !== 'GET' && method !== 'HEAD';
  const reads = recording;
  if (write) writing += 1;
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: write ? { 'content-type': 'application/json' } : {},
      body: write ? JSON.stringify(body ?? {}) : undefined,
    });
  } finally {
    if (write) writing -= 1;
  }
  if (res.status === 401) throw new SignedOut();
  let json = null;
  try { json = await res.json(); } catch { /* reported below */ }
  if (!res.ok) throw new Refused(json?.message ?? `the tracker answered ${res.status}.`, res.status);
  if (!json) throw new Error('the tracker answered with something that is not JSON.');
  if (!write) reads?.set(path, JSON.stringify(json));
  return json;
}

/**
 * Call one of the tracker's no-sign-in calls: an emailed link's, signing
 * in or out, or "Forgot password?". Answers `{ ok, body }`: the parsed JSON, or the refusal's
 * `{ error, message }`. Throws only when the tracker could not be reached.
 */
async function linkCall(path, body) {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* said below */ }
  return { ok: res.ok, body: json ?? { message: `the tracker answered ${res.status}.` } };
}

/** An emailed link's page: show its email, take a password (and a name, for an invite), use the link once. */
async function drawSetPassword() {
  me = null;
  lastDrawn = null;
  who.textContent = '';
  headerProject.hidden = true;
  signOut.hidden = true;
  bell.hidden = true;
  setTitle('Set your password · Tracker');
  const link = new URLSearchParams(location.search).get('link') ?? '';
  const refused = (answer) => {
    main.innerHTML = `<h1>Set your password</h1><p class="error">${escapeHtml(linkProblem(answer.error) ?? answer.message)}</p>`;
  };
  const info = await linkCall('/account/link', { link });
  if (!info.ok) {
    refused(info.body);
    return;
  }
  const { purpose } = info.body;
  main.innerHTML = renderSetPassword(info.body);
  const form = main.querySelector('form.set-password');
  const note = form.querySelector('.note');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = (id) => form.querySelector(`#${id}`)?.value ?? '';
    const typed = { purpose, name: value('name'), password: value('password'), confirm: value('confirm') };
    const problem = passwordProblem(typed);
    note.className = problem ? 'note error' : 'note quiet';
    note.textContent = problem ?? 'Saving…';
    if (problem) return;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    let answer;
    try {
      answer = await linkCall('/account/set-password', { link, password: typed.password, ...(purpose === 'invite' ? { name: typed.name.trim() } : {}) });
    } catch {
      answer = { ok: false, body: { message: 'The tracker did not answer. Nothing was saved; try again.' } };
    }
    if (answer.ok) {
      main.innerHTML = renderPasswordSet(location.origin);
    } else if (linkProblem(answer.body.error)) {
      refused(answer.body);
    } else {
      button.disabled = false;
      note.className = 'note error';
      note.textContent = `Not saved: ${answer.body.message}`;
    }
  });
}

/** Put the trail at the top of the page just drawn: `steps` as renderTrail takes them. */
function putTrail(steps) {
  main.insertAdjacentHTML('afterbegin', renderTrail(steps));
}

function showError(err) {
  main.innerHTML = `<p class="error">${escapeHtml(err.message)}</p><p><a href="/">Back to Waiting on you</a></p>`;
}

/** Clear the header for a view drawn signed out. */
function signedOutHeader(title) {
  me = null;
  lastDrawn = null;
  waitingCount = null;
  who.textContent = '';
  headerProject.hidden = true;
  signOut.hidden = true;
  bell.hidden = true;
  setTitle(title);
}

function drawSignIn(problem) {
  signedOutHeader('Sign in · Tracker');
  main.innerHTML = renderSignIn(problem);
  const form = main.querySelector('form.sign-in');
  const note = form.querySelector('.note');
  form.querySelector('button.forgot').addEventListener('click', () => {
    drawForgot(form.querySelector('#email').value.trim());
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    note.className = 'note quiet';
    note.textContent = 'Signing in…';
    let answer;
    try {
      answer = await linkCall('/signin', { email: form.querySelector('#email').value.trim(), password: form.querySelector('#password').value });
    } catch {
      answer = { ok: false, body: { message: 'The tracker did not answer. Try again.' } };
    }
    if (!answer.ok) {
      button.disabled = false;
      note.className = 'note error';
      note.textContent = answer.body.message;
      return;
    }
    await route();
    if (!me) drawSignIn('Signed in, but the tracker did not keep the sign-in. Check this browser allows cookies for this address.');
  });
}

/** "Forgot password?": ask for a reset link by email. The answer is the same whether or not the email has an account. */
function drawForgot(email) {
  signedOutHeader('Forgot password · Tracker');
  main.innerHTML = renderForgot(email);
  const form = main.querySelector('form.forgot');
  const note = form.querySelector('.note');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    let answer;
    try {
      answer = await linkCall('/account/forgot', { email: form.querySelector('#email').value.trim() });
    } catch {
      answer = { ok: false, body: { message: 'The tracker did not answer. Nothing was sent; try again.' } };
    }
    button.disabled = false;
    note.className = answer.ok ? 'note' : 'note error';
    note.textContent = answer.ok ? answer.body.sent : answer.body.message;
  });
}

async function drawWaiting() {
  const { waiting, unsure } = await api('GET', '/waiting');
  waitingCount = waiting.length;
  showBell();
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
  putTrail([{ label: 'Waiting on you' }]);
}

/** The list's action icons: drawn here, never from ticket text. 24-unit outline icons. */
const ICONS = Object.freeze({
  open: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  reply: '<path d="M4 5h16v11H9l-5 4z"/>',
  view: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  delete: '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  pullRequest: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7"/><path d="M18 15.5V9a3 3 0 0 0-3-3h-4"/><path d="M13 3.5L10.5 6 13 8.5"/>',
});

/** One action icon: a link with its name as tooltip and for screen readers. Off-site links open a new tab. */
function action(href, label, icon, offSite = false) {
  const target = offSite ? ' target="_blank" rel="noopener noreferrer"' : '';
  return `<a class="action" href="${escapeHtml(href)}" title="${label}" aria-label="${label}"${target}>`
    + `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg></a>`;
}

/** The same icon as a button, for an action that writes rather than goes somewhere. `data` is its own data-* attributes. */
function actionButton(label, icon, data) {
  const attrs = Object.entries(data).map(([k, v]) => ` data-${k}="${escapeHtml(v)}"`).join('');
  return `<button type="button" class="action" title="${label}" aria-label="${label}"${attrs}>`
    + `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg></button>`;
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

/** A GitHub repository's owner and name, the store's own shape; anything else is not drawn as a link. */
const isRepo = (v) => typeof v === 'string' && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(v);

/** A project's GitHub repository as a link to it on GitHub that opens a new tab, or "none". */
const repoOf = (p) => (isRepo(p.repo)
  ? `<a href="https://github.com/${escapeHtml(p.repo)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.repo)}</a>`
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
 * address, GitHub repository, owner, how many tickets are open, and an Actions column whose
 * View icon opens its details page. Choosing a name selects the project and
 * opens its tasks; the selected one is marked, and "Tasks" in the header
 * goes back to it. A person signed in gets a New project button and, on
 * each row, Edit and Delete icons; a loop's sign-in gets none of them, and
 * the server refuses it anyway. Delete asks first, then draws the table
 * again from the server, so a deleted project is gone because the server
 * says so; a refusal (a project with tickets) shows the server's own words
 * and the table is left as it was. `done` is a line to show above the table.
 */
async function drawProjects(done = '') {
  const { projects } = await api('GET', '/projects');
  setTitle('Projects · Tracker');
  const selected = savedProject();
  const people = me?.kind === 'human';
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
      <td class="repo">${repoOf(p)}</td>
      <td class="owner">${p.owner ? escapeHtml(p.owner.name) : '<span class="quiet">nobody</span>'}</td>
      <td class="open">${p.open}</td>
      <td class="actions">${action(`/projects/${encodeURIComponent(p.slug)}`, 'View project', ICONS.view)}${people
    ? action(`/projects/${encodeURIComponent(p.slug)}/edit`, 'Edit project', ICONS.edit)
      + actionButton('Delete project', ICONS.delete, { delete: p.slug, name: p.name })
    : ''}</td>
    </tr>`;
  main.innerHTML = `
    <h1>Projects</h1>
    ${me?.kind === 'human' ? '<div class="toolbar"><a class="button" href="/projects/new">New project</a></div>' : ''}
    <p class="note${done ? ' quiet' : ''}" role="status">${escapeHtml(done)}</p>
    ${projects.length
    ? `<p class="quiet">Choose a project's name to see its tasks.</p>
      <table class="projects"><thead><tr><th class="logo"><span class="hidden">Logo</span></th><th class="name">Name</th><th class="slug">Slug</th><th class="prefix">Ticket prefix</th><th class="url">Web address</th><th class="repo">GitHub repository</th><th class="owner">Owner</th><th class="open">Open tickets</th><th class="actions">Actions</th></tr></thead><tbody>${projects.map(row).join('')}</tbody></table>`
    : '<p class="quiet">There are no projects yet.</p>'}`;
  putTrail([{ label: 'Projects' }]);
  const note = main.querySelector('p.note');
  for (const button of main.querySelectorAll('button[data-delete]')) {
    button.addEventListener('click', async () => {
      const { delete: slug, name } = button.dataset;
      if (!confirm(`Delete ${name}?`)) return;
      button.disabled = true;
      note.className = 'note quiet';
      note.textContent = `Deleting ${name}…`;
      try {
        await api('DELETE', `/projects/${encodeURIComponent(slug)}`);
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${name} was not deleted.`);
        note.className = 'note error';
        note.textContent = `Not deleted: ${err.message}`;
        button.disabled = false;
        return;
      }
      // Deleted: forget it if it was the selected one, and read the table again.
      if (savedProject() === slug) {
        try {
          localStorage.removeItem(PROJECT_KEY);
          localStorage.removeItem(PROJECT_NAME_KEY);
        } catch { /* nothing remembered */ }
        showProject();
      }
      try {
        await drawProjects(`Deleted ${name}.`);
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn();
        showError(err);
      }
    });
  }
}

/**
 * One project's details: its logo, name, slug, ticket prefix, web address,
 * GitHub repository, owner, operator, how many
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
    putTrail([{ label: 'Projects' }]);
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
      <dt>GitHub repository</dt><dd>${repoOf(p)}</dd>
      <dt>Owner</dt><dd>${p.owner ? escapeHtml(p.owner.name) : '<span class="quiet">nobody</span>'}</dd>
      <dt>Operator</dt><dd>${p.operator ? escapeHtml(p.operator.name) : '<span class="quiet">nobody</span>'}</dd>
      <dt>Open tickets</dt><dd>${p.open}</dd>
    </dl>
    <h2>Tickets by status</h2>
    <table class="counts"><thead><tr><th>Status</th><th class="count">Tickets</th></tr></thead><tbody>${counts}</tbody></table>`;
  putTrail([{ label: p.name, href: '/projects' }, { label: 'Details' }]);
}

/** One labelled text box of the project forms. `attrs` is its own extra attributes, already safe. */
const field = (id, label, hint, attrs = '') => `
      <label for="${id}">${label}</label>
      ${hint ? `<span class="hint quiet">${hint}</span>` : ''}
      <input id="${id}" type="text"${attrs}>`;

/** The GitHub repository box's hint, the same on both project forms. */
const REPO_HINT = 'Optional. Where its pull requests live: owner/name, like my-org/my-app, or its https://github.com/ address.';

/**
 * The Create Project form, for a person only: name, slug, ticket prefix, web
 * address, logo (an image's web address), GitHub repository and owner, picked from the
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
  main.innerHTML = `
    <h1>New project</h1>
    <form class="request project">
      ${field('name', 'Name', '', ' required')}
      ${field('slug', 'Slug', 'Its part of every address, like my-project: small letters, digits and hyphens.', ' required autocapitalize="off" spellcheck="false"')}
      ${field('prefix', 'Ticket prefix', 'The start of its ticket ids, like SP in SP-12: capital letters and digits.', ' required autocapitalize="characters" spellcheck="false"')}
      ${field('url', 'Web address', 'Optional. Starts http:// or https://.', ' inputmode="url" spellcheck="false"')}
      ${field('logo', 'Logo', "Optional. An image's web address, starting http:// or https://.", ' inputmode="url" spellcheck="false"')}
      ${field('repo', 'GitHub repository', REPO_HINT, ' autocapitalize="off" spellcheck="false"')}
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
        url: value('url'), logo: value('logo'), repo: value('repo'), owner: value('owner') ? Number(value('owner')) : null,
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
 * The Edit project form, for a person only: the Create Project form filled
 * in with what the server holds. Name, web address, logo, GitHub repository and owner change;
 * the slug and ticket prefix are shown but cannot, since every ticket's id
 * is built from them. Saving sends the change and opens the details page,
 * which reads it back from the server. A refused save shows the server's own
 * message and leaves every field as typed.
 */
async function drawEditProject(slug) {
  setTitle('Edit project · Tracker');
  if (me?.kind !== 'human') {
    main.innerHTML = '<h1>Edit project</h1><p>Only a person signed in to the tracker can change a project.</p><p><a href="/projects">Back to Projects</a></p>';
    return;
  }
  let p;
  try {
    p = await api('GET', `/projects/${encodeURIComponent(slug)}`);
  } catch (err) {
    if (!(err instanceof Refused) || err.status !== 404) throw err;
    main.innerHTML = `<h1>Edit project</h1><p>There is no project ${escapeHtml(slug)}.</p><p><a href="/projects">Back to Projects</a></p>`;
    return;
  }
  const { people } = await api('GET', '/people');
  const filled = (v) => ` value="${escapeHtml(v ?? '')}"`;
  const fixed = 'It cannot change: every ticket\'s id is built from it.';
  main.innerHTML = `
    <h1>Edit project</h1>
    <form class="request project">
      ${field('name', 'Name', '', ` required${filled(p.name)}`)}
      ${field('slug', 'Slug', fixed, ` disabled${filled(p.slug)}`)}
      ${field('prefix', 'Ticket prefix', fixed, ` disabled${filled(p.prefix)}`)}
      ${field('url', 'Web address', 'Optional. Starts http:// or https://.', ` inputmode="url" spellcheck="false"${filled(p.url)}`)}
      ${field('logo', 'Logo', "Optional. An image's web address, starting http:// or https://.", ` inputmode="url" spellcheck="false"${filled(p.logo)}`)}
      ${field('repo', 'GitHub repository', REPO_HINT, ` autocapitalize="off" spellcheck="false"${filled(p.repo)}`)}
      <label for="owner">Owner</label>
      <select id="owner"><option value="">Nobody</option>${people.map((o) => `<option value="${escapeHtml(o.id)}"${o.id === p.owner?.id ? ' selected' : ''}>${escapeHtml(o.name)}</option>`).join('')}</select>
      <div class="row"><button type="submit">Save</button><a href="/projects">Cancel</a><span class="note"></span></div>
    </form>`;
  putTrail([{ label: p.name, href: '/projects' }, { label: 'Edit' }]);
  const form = main.querySelector('form.project');
  const value = (id) => form.querySelector(`#${id}`).value;
  const note = form.querySelector('.note');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    note.className = 'note quiet';
    note.textContent = 'Saving…';
    try {
      const saved = await api('PATCH', `/projects/${encodeURIComponent(p.slug)}`, {
        name: value('name'), url: value('url'), logo: value('logo'), repo: value('repo'), owner: value('owner') ? Number(value('owner')) : null,
      });
      history.pushState(null, '', `/projects/${encodeURIComponent(saved.slug)}`);
      await route();
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; the project was not changed.');
      note.className = 'note error';
      note.textContent = `Not saved: ${err.message}`;
      button.disabled = false;
    }
  });
  form.querySelector('#name').focus();
}

/**
 * "Tasks" in the header: the selected project, in the view last used. With
 * none selected, or one that no longer exists, the first project.
 */
async function drawTasks(view, opts = {}) {
  const { projects } = await api('GET', '/projects');
  if (!projects.length) {
    setTitle('Tasks · Tracker');
    main.innerHTML = '<h1>Tasks</h1><p class="quiet">There are no projects yet.</p>';
    putTrail([{ label: 'Tasks' }]);
    return;
  }
  const slug = projects.some((p) => p.slug === savedProject()) ? savedProject() : projects[0].slug;
  history.replaceState(null, '', `/${view}/${encodeURIComponent(slug)}`);
  await drawProject(slug, view, opts);
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
 * the ticket's reply box, the ticket's pull request on GitHub. The one
 * exception is the bin, on a ticket nobody has started: it asks, then deletes.
 *
 * Each status wears the colour chosen for it on the Settings page: its
 * border, a light tint behind its heading, its heading text. The colours go
 * on as properties after drawing, never as markup (the page allows no inline
 * style), and a stage with none, or colours that cannot be read, looks as
 * it always did.
 *
 * Above the stages sits the Add Task box (wireAddTask), closed unless
 * `adding` asks for it open or a kept draft has text in it. `filed` is the
 * id of the ticket the box just filed, named in a note after the redraw.
 */
async function drawProject(slug, view, { adding = false, filed = null } = {}) {
  const [board, looks, { projects }] = await Promise.all([
    api('GET', `/projects/${encodeURIComponent(slug)}/board`),
    api('GET', '/stage-colours').then(stageLooks, () => ({})),
    api('GET', '/projects'),
  ]);
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
    ? `<details class="${cls}" data-stage="${escapeHtml(c.status)}"><summary><h2>${head(c)}</h2></summary>${body}</details>`
    : `<section class="${cls}" data-stage="${escapeHtml(c.status)}"><h2>${head(c)}</h2>${body}</section>`);

  const card = (t) => `
    <a class="card" href="/t/${encodeURIComponent(t.id)}">
      <span class="name">${escapeHtml(t.name)}</span>
      <span class="quiet">${escapeHtml(t.id)}${t.priority ? ` · ${escapeHtml(t.priority)}` : ''}</span>
      ${t.answerIn ? `<span class="answer-in">${escapeHtml(ANSWER_IN_NOTE)}</span>` : ''}
      ${t.tags.length ? `<span class="tags">${t.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</span>` : ''}
    </a>`;
  const column = (c) => block(c, 'column', c.tickets.map(card).join('') || '<p class="quiet">None.</p>');

  const actions = (t, status) => {
    const at = `/t/${encodeURIComponent(t.id)}`;
    return [
      action(at, 'Open ticket', ICONS.open),
      action(`${at}#reply`, 'Reply', ICONS.reply),
      t.pullRequest ? action(t.pullRequest, 'Open pull request on GitHub', ICONS.pullRequest, true) : '',
      canDelete(status) ? actionButton('Delete ticket', ICONS.delete, { delete: t.id }) : '',
    ].join('');
  };
  const row = (status) => (t) => `
    <tr>
      <td class="name"><a href="/t/${encodeURIComponent(t.id)}">${escapeHtml(t.name)}</a> <span class="quiet">${escapeHtml(t.id)}</span>${t.answerIn ? ` <span class="answer-in">${escapeHtml(ANSWER_IN_NOTE)}</span>` : ''}</td>
      <td class="priority">${t.priority ? escapeHtml(statusName(t.priority)) : '<span class="quiet">–</span>'}</td>
      <td class="tags">${t.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</td>
      <td class="assignee">${t.assignee ? escapeHtml(t.assignee) : '<span class="quiet">nobody</span>'}</td>
      <td class="when">${escapeHtml(when(t.updatedAt))}</td>
      <td class="actions">${actions(t, status)}</td>
    </tr>`;
  const group = (c) => block(c, 'group', c.tickets.length
    ? `<table><thead><tr><th class="name">Ticket</th><th class="priority">Priority</th><th class="tags">Tags</th><th class="assignee">Assigned to</th><th class="when">Last change</th><th class="actions">Actions</th></tr></thead><tbody>${c.tickets.map(row(c.status)).join('')}</tbody></table>`
    : '');

  main.classList.add('wide');
  main.innerHTML = `
    <h1>Tasks</h1>
    <div class="toolbar">
      ${renderProjectPicker(projects, board.project)}
      ${searchForm('')}
      <nav class="views" aria-label="View">${toggle}</nav>
    </div>
    ${filed ? `<p class="filed-note">Filed <a href="/t/${encodeURIComponent(filed)}">${escapeHtml(filed)}</a></p>` : ''}
    <details class="add-task">
      <summary>Add Task</summary>
      <form class="request">
        <label for="title">Title</label>
        <input id="title" type="text" required>
        <label for="description">Description</label>
        <textarea id="description"></textarea>
        <div class="row"><button type="submit">File request</button><span class="note"></span></div>
      </form>
    </details>
    <p class="error list-note" role="alert" hidden></p>
    ${view === 'board'
    ? `<div class="board">${board.columns.map(column).join('')}</div>`
    : `<div class="list">${board.columns.map(group).join('')}</div>`}`;
  for (const el of main.querySelectorAll('[data-stage]')) {
    const look = looks[el.dataset.stage];
    if (!look) continue;
    el.classList.add('coloured');
    el.style.setProperty('--stage-border', look.border);
    el.style.setProperty('--stage-tint', look.tint);
    el.style.setProperty('--stage-text', look.text);
  }
  putTrail([{ label: board.projectName, href: '/projects' }, { label: view === 'board' ? 'Board' : 'List' }]);
  wireSearch();
  wireAddTask(board.project, view, adding);
  // Picking a project opens it in this same view, as a link would: Back returns here.
  main.querySelector('.project-picker select').addEventListener('change', (e) => {
    history.pushState(null, '', at(view, e.target.value));
    route();
  });
  // Delete: ask first, naming the ticket; then redraw from the server. A
  // refusal is said in words and nothing leaves the list until a redraw.
  const listNote = main.querySelector('.list-note');
  const names = new Map(board.columns.flatMap((c) => c.tickets).map((t) => [t.id, t.name]));
  for (const button of main.querySelectorAll('button[data-delete]')) {
    button.addEventListener('click', async () => {
      const id = button.dataset.delete;
      if (!confirm(deleteQuestion({ id, name: names.get(id) }))) return;
      button.disabled = true;
      listNote.hidden = true;
      try {
        await api('DELETE', `/tickets/${encodeURIComponent(id)}`);
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${id} was not deleted.`);
        listNote.textContent = deleteRefusal(id, err);
        listNote.hidden = false;
        button.disabled = false;
        return;
      }
      await drawAgain(() => drawProject(slug, view));
    });
  }
}

/** The Search field, holding `term`. The page allows no form to submit itself; wireSearch sends it. */
const searchForm = (term) => `
  <form class="search" role="search">
    <input type="search" name="q" aria-label="Search every task" placeholder="Search every task" value="${escapeHtml(term)}">
  </form>`;

/**
 * The search results page's address: the term, then each filter chosen on
 * the page's filter row (none on the Tasks page), so a reload or a pasted
 * link shows the same results.
 */
function searchAddress(term) {
  const params = new URLSearchParams({ q: term });
  for (const select of main.querySelectorAll('.search-filters select')) {
    if (select.value) params.set(select.name, select.value);
  }
  return `/search?${params}`;
}

/** Enter in the Search field, or a filter changed, opens the results page at searchAddress. */
function wireSearch() {
  const form = main.querySelector('form.search');
  const go = () => {
    history.pushState(null, '', searchAddress(form.elements.q.value.trim()));
    route();
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    go();
  });
  for (const select of main.querySelectorAll('.search-filters select')) select.addEventListener('change', go);
}

/**
 * The search results page: every ticket in every project matching the
 * address's term and filters, best matches first, as the server ranks and
 * filters them (pageData.mjs searchTickets), drawn by render.mjs
 * renderSearchResults, which escapes each ticket's text before bolding the
 * term. The Search field holds the term and the filter row the filters,
 * each choice from the server's answer; changing either searches again. A
 * filter the server refuses shows its message in place of the results.
 * Read-only.
 */
async function drawSearch(params) {
  const term = (params.get('q') ?? '').trim();
  let answer;
  let refusal = null;
  try {
    answer = await api('GET', `/search?${params}`);
  } catch (err) {
    if (!(err instanceof Refused) || err.status !== 400) throw err;
    refusal = err.message;
    answer = await api('GET', `/search?${new URLSearchParams({ q: term })}`);
  }
  setTitle(answer.query ? `Search: ${answer.query} · Tracker` : 'Search · Tracker');
  main.innerHTML = `
    <h1>Search</h1>
    <div class="toolbar">${searchForm(answer.query)}</div>
    ${renderSearchFilters(answer.filters)}
    ${refusal ? `<p class="error">${escapeHtml(refusal)}</p>` : `
    ${answer.results.length ? `<p class="quiet">${answer.results.length} ${answer.results.length === 1 ? 'ticket matches' : 'tickets match'}</p>` : ''}
    ${renderSearchResults(answer)}`}`;
  putTrail([{ label: 'Tasks', href: '/tasks' }, { label: 'Search' }]);
  wireSearch();
  if (!answer.query) main.querySelector('form.search input').focus();
}

/**
 * Put `text` on the clipboard; true when it got there. The page is served
 * over plain http on the Mini, where the browser hides navigator.clipboard,
 * so off a secure page it copies from a hidden text box instead.
 */
async function copyText(text, button) {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* fall through to the text box */ }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.className = 'offscreen';
  document.body.append(area);
  // Safari copies the page's selection, which a text box only holds while focused.
  area.focus();
  area.setSelectionRange(0, area.value.length);
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    button?.focus();
  }
}

/**
 * One ticket. A person signed in also gets the Change panel above the
 * description: each change is sent on its own with the ticket's version as
 * `ifVersion`, and the page is then drawn again from the server, so what it
 * shows is what was stored. `said` is a line to show after that redraw:
 * `{ field, text, error }`, `field` naming the note it goes in (none: the
 * panel's own note at its top). `kept` is what was typed and not saved
 * when a save redrew the page (wireEditPanel's `typed`), put back as it was.
 */
async function drawTicket(id, said = null, kept = null) {
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
      <div class="act">
      ${renderCommands(t)}
      ${renderAnswerIn(t)}
      ${renderMergeAction(t)}
      ${renderCloseAction(t)}
      ${renderGoAction(t)}
      <form class="reply">
        <label for="reply">Reply as ${escapeHtml(me?.name ?? 'you')}</label>
        <textarea id="reply" required></textarea>
        <div class="row"><button type="submit">Post reply</button><span class="note"></span></div>
      </form>
      ${renderDeleteAction(t)}
      </div>
    </section>
    <details class="details">
      <summary>Details</summary>
      <p class="meta">
        <span>${escapeHtml(t.id)}</span><span>${escapeHtml(t.projectName)}</span>
        <span>${escapeHtml(statusLabel(t))}</span>
        <span>${t.assignee ? `assigned to ${escapeHtml(t.assignee.name)}` : 'not assigned'}</span>
      </p>
      ${me?.kind === 'human' ? renderEditPanel(t) : ''}
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
  // Copy: the command exactly as drawn, onto the clipboard. The page never runs it.
  for (const button of main.querySelectorAll('button.copy-command')) {
    let reset;
    button.addEventListener('click', async () => {
      const text = button.parentElement.querySelector('code').textContent;
      button.textContent = (await copyText(text, button)) ? 'Copied' : 'Not copied';
      clearTimeout(reset);
      reset = setTimeout(() => { button.textContent = 'Copy'; }, 1500);
    });
  }
  // The ticket's own project, in the view last used; then the ticket; then this page of it.
  putTrail([
    { label: t.projectName, href: `/${savedView()}/${encodeURIComponent(t.project)}` },
    { label: `Task ${t.id}`, href: `/t/${encodeURIComponent(t.id)}` },
    { label: 'Details' },
  ]);
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
  // Merge, Close and Go: his word from the server (the project config's merge
  // phrase, the relay's close word, the intake card's go word), posted as his own reply through the
  // same call the reply box uses. The relay acts on it; the page never moves
  // a status itself.
  const wordButton = (selector, question, word, signedOut) => {
    const form = main.querySelector(selector);
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!confirm(question)) return;
      const button = form.querySelector('button');
      const note = form.querySelector('.note');
      button.disabled = true;
      note.className = 'note quiet';
      note.textContent = 'Posting…';
      try {
        await api('POST', `/tickets/${encodeURIComponent(t.id)}/comments`, { body: word });
        await drawAgain(() => drawTicket(t.id));
        main.querySelector('details.details').open = true;
        main.querySelector('.comment:last-of-type')?.scrollIntoView({ block: 'center' });
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(signedOut);
        note.className = 'note error';
        note.textContent = `Not posted: ${err.message}`;
        button.disabled = false;
      }
    });
  };
  wordButton('form.merge-action', mergeQuestion(t), t.mergePhrase, 'You were signed out; the merge word was not posted.');
  wordButton('form.close-action', closeQuestion(t), t.closePhrase, 'You were signed out; the close word was not posted.');
  wordButton('form.go-action', goQuestion(t), t.goPhrase, 'You were signed out; your go was not posted.');
  // Delete: ask first, naming the ticket; on success go to its project's list.
  const deleteForm = main.querySelector('form.delete-action');
  deleteForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!confirm(deleteQuestion(t))) return;
    const button = deleteForm.querySelector('button');
    const deleteNote = deleteForm.querySelector('.note');
    button.disabled = true;
    deleteNote.className = 'note quiet';
    deleteNote.textContent = 'Deleting…';
    try {
      await api('DELETE', `/tickets/${encodeURIComponent(t.id)}`);
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${t.id} was not deleted.`);
      deleteNote.className = 'note error';
      deleteNote.textContent = deleteRefusal(t.id, err);
      button.disabled = false;
      return;
    }
    history.pushState(null, '', `/list/${encodeURIComponent(t.project)}`);
    await route();
  });
  const panel = wireEditPanel(t);
  if (kept) {
    main.querySelector('form.reply textarea').value = kept.reply;
    panel?.restore(kept);
  }
  if (said) {
    main.querySelector('details.details').open = true;
    const where = main.querySelector(said.field ? `.edit [data-note="${said.field}"]` : '.edit-note');
    if (where) {
      where.className = `note${said.error ? ' error' : ' quiet'}${said.field ? '' : ' edit-note'}`;
      where.textContent = said.text;
    }
  }
  const form = main.querySelector('form.reply');
  const box = form.querySelector('textarea');
  // Arrived by a Reply icon: go straight to the box.
  if (location.hash === '#reply' && !refreshing) {
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
      await drawAgain(() => drawTicket(t.id));
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

/**
 * The Change panel's controls (render.mjs renderEditPanel): selects save on
 * change, tags on add or remove, name and description on Save. Each sends
 * only its own field with `ifVersion: t.version`. One save at a time: the
 * whole panel is held while a save is in flight, so two quick changes never
 * both carry the same version and the second never reads as "has moved". A
 * 409 means a loop moved the ticket: the page says so, draws it again as
 * stored, and does not try again. Any other refusal shows the server's words
 * beside the field and keeps what was typed. Every redraw carries over what
 * is typed elsewhere on the page (the reply box, an open description edit,
 * an unsaved name or tag), so a save never wipes it.
 */
function wireEditPanel(t) {
  const panel = main.querySelector('details.edit');
  if (!panel) return;
  const descForm = panel.querySelector('form.edit-description');
  const editor = descForm.querySelector('.editor');
  const area = descForm.querySelector('textarea');
  const nameBox = panel.querySelector('input#edit-name');
  const tagBox = panel.querySelector('#edit-tag');
  // What is typed and not yet saved, except the field this save sends.
  const typed = (field) => ({
    reply: main.querySelector('form.reply textarea')?.value ?? '',
    tag: field === 'tags' ? '' : tagBox.value,
    name: field !== 'name' && nameBox && nameBox.value !== t.name ? nameBox.value : null,
    description: field !== 'description' && !editor.hidden ? area.value : null,
  });
  // Draw the ticket again; if that fails the save already happened (or was
  // refused), so say which, and leave the panel held: it shows an old version.
  const redraw = async (said, kept, note, outcome) => {
    try {
      await drawAgain(() => drawTicket(t.id, said, kept));
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${outcome}, but the page could not show it.`);
      note.className = 'note error';
      note.textContent = `The page could not refresh (${err.message}): ${outcome}. Reload to see the ticket as stored.`;
    }
  };
  let saving = false;
  const save = async (field, value, note) => {
    if (saving) return;
    saving = true;
    const held = [...panel.querySelectorAll('input, select, textarea, button')].filter((c) => !c.disabled);
    for (const c of held) c.disabled = true;
    note.className = 'note quiet';
    note.textContent = 'Saving…';
    try {
      await api('PATCH', `/tickets/${encodeURIComponent(t.id)}`, { [field]: value, ifVersion: t.version });
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn(`You were signed out; the ${field} was not saved.`);
      if (err instanceof Refused && err.status === 409) return redraw({ text: MOVED_MESSAGE, error: true }, typed(), note, `the ${field} was not saved`);
      note.className = 'note error';
      note.textContent = `Not saved: ${err.message}`;
      for (const c of held) c.disabled = false;
      saving = false;
      return;
    }
    await redraw({ field, text: 'Saved' }, typed(field), note, `the ${field} was saved`);
  };
  for (const select of panel.querySelectorAll('select[data-field]')) {
    select.addEventListener('change', () => {
      const { field } = select.dataset;
      const value = field === 'assignee' ? (select.value ? Number(select.value) : null) : (select.value || null);
      save(field, value, panel.querySelector(`[data-note="${field}"]`));
    });
  }
  const tagNote = panel.querySelector('[data-note="tags"]');
  tagBox.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const tag = tagBox.value.trim();
    if (!tag) return;
    if (t.tags.includes(tag)) {
      tagNote.className = 'note quiet';
      tagNote.textContent = `${tag} is already a tag.`;
      return;
    }
    save('tags', [...t.tags, tag], tagNote);
  });
  for (const button of panel.querySelectorAll('button.remove-tag')) {
    button.addEventListener('click', () => {
      save('tags', t.tags.filter((tag) => tag !== button.dataset.tag), tagNote);
    });
  }
  const nameForm = panel.querySelector('form.edit-name');
  nameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    // Exactly as typed, the same rule as the reply box.
    if (nameBox) save('name', nameBox.value, nameForm.querySelector('[data-note="name"]'));
  });
  const shown = main.querySelector('section.description');
  const openEditor = () => {
    editor.hidden = false;
    shown.hidden = true;
  };
  descForm.querySelector('.edit-open').addEventListener('click', () => {
    openEditor();
    area.focus();
  });
  descForm.querySelector('.edit-cancel').addEventListener('click', () => {
    area.value = t.description ?? '';
    editor.hidden = true;
    shown.hidden = false;
  });
  descForm.addEventListener('submit', (e) => {
    e.preventDefault();
    save('description', area.value, descForm.querySelector('[data-note="description"]'));
  });
  return {
    // Put back what `typed` kept from the page before this redraw.
    restore(kept) {
      tagBox.value = kept.tag;
      if (kept.name != null && nameBox) nameBox.value = kept.name;
      if (kept.description != null) {
        area.value = kept.description;
        openEditor();
      }
    },
  };
}

/** The draft kept for the Add Task box, or empty fields. */
function savedDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}');
    return { title: String(d.title ?? ''), description: String(d.description ?? '') };
  } catch { return { title: '', description: '' }; }
}

/**
 * The Tasks page's Add Task box: a title and a description, filed into
 * `slug`, the project the page is showing, in `Requested`, which no loop
 * builds from, unassigned and under the signed-in person. What he types is
 * kept in this browser as he types it, so a refused submit, a sign-out or a
 * reload never loses it, and a kept draft with text in it opens the box on
 * its own; it is forgotten once the ticket is filed, and the page redraws
 * with the box closed and the new ticket in its stage.
 */
function wireAddTask(slug, view, adding) {
  const box = main.querySelector('details.add-task');
  const form = box.querySelector('form.request');
  const title = form.querySelector('#title');
  const description = form.querySelector('#description');
  const draft = savedDraft();
  title.value = draft.title;
  description.value = draft.description;
  box.addEventListener('toggle', () => { if (box.open) title.focus(); });
  if (adding || draft.title || draft.description) box.open = true;
  const keep = () => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ title: title.value, description: description.value }));
    } catch { /* the form still works; a sign-out would lose the text */ }
  };
  form.addEventListener('input', keep);
  const note = form.querySelector('.note');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    keep();
    const button = form.querySelector('button');
    button.disabled = true;
    note.className = 'note quiet';
    note.textContent = 'Filing…';
    let ticket;
    try {
      // Exactly as typed: no trimming, no formatting, the same rule as the reply box.
      ticket = await api('POST', `/projects/${encodeURIComponent(slug)}/tickets`, {
        name: title.value, description: description.value, status: 'Requested',
      });
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; your request was not filed. What you typed is kept: it will be back in the form once you sign in.');
      note.className = 'note error';
      note.textContent = `Not filed: ${err.message}`;
      button.disabled = false;
      return;
    }
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* nothing kept */ }
    try {
      await drawAgain(() => drawProject(slug, view, { filed: ticket.id }));
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${ticket.id} was filed.`);
      note.className = 'note error';
      note.textContent = `Filed ${ticket.id}, but the page could not be drawn again: ${err.message}`;
    }
  });
}

/**
 * A duration in ms in plain words: under an hour, whole hours up to two
 * days, then days to one decimal place.
 */
function spanOf(ms) {
  const hours = ms / 3_600_000;
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`;
  return `${(hours / 24).toFixed(1)} days`;
}

/**
 * The Reporting page: how many tasks were finished and started in each of
 * the server's time ranges, and how many are open in each stage now, for the
 * selected project or for all of them, and how the finished ones flowed:
 * time to finish, how many were sent back, and time waiting on the
 * operator, and the human hours of work the finished ones add up to, by the
 * build loop's estimates. Every figure is worked out by the
 * server (pageData.mjs reportsOf); the page only draws them, so the ranges
 * and the stages come from its answer, never typed out here. A stage wears
 * its Settings colour as properties, never as markup.
 */
async function drawReporting(chosen) {
  const { projects } = await api('GET', '/projects');
  const slug = chosen !== undefined ? chosen : (projects.some((p) => p.slug === savedProject()) ? savedProject() : '');
  const r = await api('GET', `/reports${slug ? `?project=${encodeURIComponent(slug)}` : ''}`);
  setTitle('Reporting · Tracker');
  const head = `<tr><th>Report</th>${r.ranges.map((g) => `<th class="count">${escapeHtml(g.label)}</th>`).join('')}</tr>`;
  const line = (label, counts) => `<tr><td class="name">${label}</td>${r.ranges.map((g) => `<td class="count">${Number(counts[g.key])}</td>`).join('')}</tr>`;
  // A flow row: one cell per range, "none finished in this range" where nothing finished.
  const flowLine = (label, cell) => `<tr><td class="name">${label}</td>${r.ranges.map((g) => {
    const f = r.flow[g.key];
    return `<td class="count">${f.finished ? escapeHtml(cell(f)) : '<span class="quiet">none finished in this range</span>'}</td>`;
  }).join('')}</tr>`;
  const span = (ms) => (ms == null ? 'none counted' : spanOf(ms));
  const flow = (title, how, rows) => `
    <h2>${title}</h2>
    <p class="quiet">${how}</p>
    <table class="counts report flow"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
  // A human-hours row: "no estimates yet in this range" where none was recorded, never 0 hours.
  const hoursLine = (label, cell) => `<tr><td class="name">${label}</td>${r.ranges.map((g) => {
    const h = r.humanHours[g.key];
    return `<td class="count">${h.estimated ? escapeHtml(cell(h)) : '<span class="quiet">no estimates yet in this range</span>'}</td>`;
  }).join('')}</tr>`;
  const estimatedLine = `<tr><td class="name">Tasks with an estimate</td>${r.ranges.map((g) => {
    const h = r.humanHours[g.key];
    return `<td class="count">${h.finished ? `${Number(h.estimated)} of ${Number(h.finished)} estimated` : '<span class="quiet">none finished in this range</span>'}</td>`;
  }).join('')}</tr>`;
  const hoursOf = (n) => `${Number(n)} hour${Number(n) === 1 ? '' : 's'}`;
  const open = r.open.map((s) => `<tr data-stage="${escapeHtml(s.status)}"><td class="status">${escapeHtml(s.status)}</td><td class="count">${Number(s.count)}</td></tr>`).join('');
  main.innerHTML = `
    <h1>Reporting</h1>
    <form class="report-scope">
      <label for="report-project">Project</label>
      <select id="report-project"><option value="">All projects</option>${projects.map((p) => `<option value="${escapeHtml(p.slug)}"${p.slug === r.project ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select>
    </form>
    <h2>Tasks finished and started</h2>
    <p class="quiet">Finished: moved to Live in that time and still Live. Started: filed in that time.</p>
    <table class="counts report"><thead>${head}</thead><tbody>${line('Tasks finished', r.finished)}${line('Tasks started', r.started)}</tbody></table>
    <h2>Human hours of work done</h2>
    <p class="quiet">For tasks finished in that time: the build loop's estimate, recorded on each pull request, of the hours an experienced programmer new to the code would take to do the same work. An estimate, not a measurement; tasks with none are left out of the total, and counted here.</p>
    <table class="counts report human-hours"><thead>${head}</thead><tbody>${hoursLine('Total', (h) => hoursOf(h.hours))}${estimatedLine}${hoursLine('Per day', (h) => `about ${Number(h.perDay)} human hour${Number(h.perDay) === 1 ? '' : 's'} a day`)}</tbody></table>
    ${flow('Time to finish',
    'For tasks finished in that time: from first entering Queued to entering Live. Tasks that never entered Queued are left out, and counted here.',
    flowLine('Middle (median)', (f) => span(f.timeToFinish.median))
      + flowLine('Longest', (f) => span(f.timeToFinish.longest))
      + flowLine('Left out, never Queued', (f) => String(Number(f.timeToFinish.leftOut))))}
    ${flow('Sent back',
    'Of the tasks finished in that time, how many review sent to Rework at least once (a task sent back twice counts once).',
    flowLine('Sent back at least once', (f) => `${Number(f.sentBack.count)} of ${Number(f.finished)} (${Math.round(f.sentBack.share * 100)}%)`))}
    ${flow('Waiting on you',
    'For tasks finished in that time: time spent in Needs your input or Ready to launch before going Live, added up and the middle (median) task.',
    flowLine('Total', (f) => span(f.waiting.total)) + flowLine('Middle (median)', (f) => span(f.waiting.median)))}
    <p class="waiting-now">Waiting on you right now: <strong>${Number(r.waitingNow)}</strong> task${Number(r.waitingNow) === 1 ? '' : 's'} in Needs your input or Ready to launch.</p>
    <h2>Open now</h2>
    <p class="quiet">Tasks in each stage that is not Live.</p>
    <table class="counts stages"><thead><tr><th>Stage</th><th class="count">Tasks</th></tr></thead><tbody>${open}</tbody></table>`;
  const looks = stageLooks({ stages: r.open });
  for (const el of main.querySelectorAll('[data-stage]')) {
    const look = looks[el.dataset.stage];
    if (!look) continue;
    el.classList.add('coloured');
    el.style.setProperty('--stage-border', look.border);
    el.style.setProperty('--stage-tint', look.tint);
    el.style.setProperty('--stage-text', look.text);
  }
  main.querySelector('#report-project').addEventListener('change', (e) => {
    drawReporting(e.target.value).catch((err) => (err instanceof SignedOut ? drawSignIn() : showError(err)));
  });
  putTrail([{ label: 'Reporting' }]);
}

/**
 * The Settings page: every stage in the contract's order, as the server lists
 * them, each with a colour picker and a Clear button. One Save stores them
 * all; the page then reads the colours back and says they were saved only
 * when what it reads is what it sent. A loop's sign-in is refused by the
 * server, and the page shows that refusal as it is.
 */
async function drawSettings() {
  const { stages } = await api('GET', '/stage-colours');
  setTitle('Settings · Tracker');
  /** What each stage will be saved as: `#rrggbb`, or null for no colour. */
  const chosen = Object.fromEntries(stages.map((s) => [s.status, s.colour]));
  const row = (s, i) => `
    <tr data-status="${escapeHtml(s.status)}">
      <td class="status"><label for="colour-${i}">${escapeHtml(s.status)}</label></td>
      <td class="picker"><input id="colour-${i}" type="color"></td>
      <td class="value"></td>
      <td class="clear"><button type="button">Clear</button></td>
    </tr>`;
  main.innerHTML = `
    <h1>Settings</h1>
    <h2>Stage colours</h2>
    <p class="quiet">Choose a colour for each stage of the loop. The same colours show for everyone.</p>
    <form class="colours">
      <table class="colours"><thead><tr><th>Stage</th><th>Colour</th><th></th><th></th></tr></thead><tbody>${stages.map(row).join('')}</tbody></table>
      <div class="row"><button type="submit">Save</button><span class="note"></span></div>
    </form>`;
  const form = main.querySelector('form.colours');
  const rows = [...form.querySelectorAll('tbody tr')];
  const show = (tr) => {
    const colour = chosen[tr.dataset.status];
    // A picker cannot show "none": it shows black, greyed, beside the words "no colour".
    tr.querySelector('input').value = colour ?? '#000000';
    tr.classList.toggle('unset', colour == null);
    tr.querySelector('.value').textContent = colour ?? 'no colour';
  };
  for (const tr of rows) {
    show(tr);
    tr.querySelector('input').addEventListener('input', (e) => { chosen[tr.dataset.status] = e.target.value; show(tr); });
    tr.querySelector('button').addEventListener('click', () => { chosen[tr.dataset.status] = null; show(tr); });
  }
  const note = form.querySelector('.note');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    note.className = 'note quiet';
    note.textContent = 'Saving…';
    try {
      await api('PUT', '/stage-colours', { colours: chosen });
      // Read back before saying it worked.
      const back = await api('GET', '/stage-colours');
      const wrong = back.stages.filter((s) => s.colour !== (chosen[s.status] ?? null));
      if (wrong.length) throw new Error(`the tracker read back different colours for ${wrong.map((s) => s.status).join(', ')}.`);
      note.textContent = 'Saved: the colours are stored on the tracker.';
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; the colours were not saved.');
      note.className = 'note error';
      note.textContent = `Not saved: ${err.message}`;
    }
    button.disabled = false;
  });
}

/**
 * The People page: everyone who has an account (name and email), the open
 * invites (email, who invited, when it expires) each with a Cancel button,
 * and an "Invite someone" form. Inviting emails a 7-day link; the server
 * makes the invite only if the email went out, and says so if it did not.
 * After every invite or cancel the page reads the list again and says it
 * worked only when what it reads agrees. A loop's sign-in sees no form and
 * no buttons, and the server refuses it anyway.
 */
async function drawPeople(done = '', problem = '') {
  const { people, invites = [] } = await api('GET', '/people');
  setTitle('People · Tracker');
  const person = me?.kind === 'human';
  const personRow = (p) => `
    <tr><td class="name">${escapeHtml(p.name)}</td><td class="email">${p.email ? escapeHtml(p.email) : '<span class="quiet">no email yet</span>'}</td></tr>`;
  const inviteRow = (i) => `
    <tr><td class="email">${escapeHtml(i.email)}</td><td class="by">${escapeHtml(i.invitedBy.name)}</td><td class="expires">${escapeHtml(when(i.expiresAt))}</td>
      <td class="actions">${person ? `<button type="button" data-cancel="${escapeHtml(i.id)}" data-email="${escapeHtml(i.email)}">Cancel</button>` : ''}</td></tr>`;
  main.innerHTML = `
    <h1>People</h1>
    <p class="note${problem ? ' error' : ' quiet'}" role="status">${escapeHtml(problem || done)}</p>
    ${person ? `<form class="invite">
      <label for="invite-email">Invite someone</label>
      <div class="row"><input id="invite-email" type="email" autocomplete="off" placeholder="their@email.com" required><button type="submit">Send invite</button></div>
      <span class="hint quiet">They get an email with a link to choose their name and password. It works once, for 7 days.</span>
    </form>` : ''}
    <h2>People with an account</h2>
    <table class="projects people"><thead><tr><th class="name">Name</th><th class="email">Email</th></tr></thead><tbody>${people.map(personRow).join('')}</tbody></table>
    <h2>Open invites</h2>
    ${invites.length
    ? `<table class="projects invites"><thead><tr><th class="email">Email</th><th class="by">Invited by</th><th class="expires">Expires</th><th class="actions"><span class="hidden">Actions</span></th></tr></thead><tbody>${invites.map(inviteRow).join('')}</tbody></table>`
    : '<p class="quiet">No open invites.</p>'}`;
  putTrail([{ label: 'People' }]);
  const note = main.querySelector('p.note');
  const busy = (text) => { note.className = 'note quiet'; note.textContent = text; };
  const again = (text, failed) => drawPeople(failed ? '' : text, failed ? text : '')
    .catch((err) => (err instanceof SignedOut ? drawSignIn() : showError(err)));
  const form = main.querySelector('form.invite');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = form.querySelector('input').value.trim();
    const button = form.querySelector('button');
    button.disabled = true;
    busy(`Sending an invite to ${email}…`);
    let sent;
    try {
      sent = await api('POST', '/invites', { email });
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${email} was not invited.`);
      note.className = 'note error';
      note.textContent = err.message;
      button.disabled = false;
      return;
    }
    // Read back before saying it worked.
    const back = await api('GET', '/people').catch(() => null);
    const listed = back?.invites?.some((i) => i.email === email.toLowerCase());
    again(listed ? sent.sent : `The tracker said the invite was sent, but it is not in the open invites when read back: ${sent.sent}`, !listed);
  });
  for (const button of main.querySelectorAll('button[data-cancel]')) {
    button.addEventListener('click', async () => {
      const { cancel: id, email } = button.dataset;
      if (!confirm(`Cancel the invite to ${email}? Its link will stop working.`)) return;
      button.disabled = true;
      busy(`Cancelling the invite to ${email}…`);
      try {
        await api('DELETE', `/invites/${encodeURIComponent(id)}`);
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; the invite to ${email} was not cancelled.`);
        note.className = 'note error';
        note.textContent = `Not cancelled: ${err.message}`;
        button.disabled = false;
        return;
      }
      const back = await api('GET', '/people').catch(() => null);
      const gone = back && !back.invites?.some((i) => String(i.id) === id);
      again(gone ? `Cancelled the invite to ${email}; its link no longer works.` : `The tracker said the invite to ${email} was cancelled, but it is still listed when read back.`, !gone);
    });
  }
}

/** Underline the header link (or the bell, for Waiting on you) for the screen showing. */
function markNav(which) {
  for (const a of document.querySelectorAll('nav.site a')) a.classList.toggle('current', a.dataset.nav === which);
  bell.classList.toggle('current', which === 'waiting');
  if (which === 'waiting') bell.setAttribute('aria-current', 'page');
  else bell.removeAttribute('aria-current');
}

/** The page's own address, as the beat compares it. */
const here = () => location.pathname + location.search;

/**
 * Draw the page the address names. Waiting on you, a board or list and a
 * ticket keep themselves current (refreshPage): every read of their draw is
 * kept in `lastDrawn`. `place` is a beat's saved scroll and open sections
 * (keepPlace), put back the moment the page is drawn, before it is shown. A
 * beat's draw that fails leaves the page as it was, to try again next beat.
 */
async function route({ place = null } = {}) {
  const reads = new Map();
  drawing += 1;
  try {
    if (location.pathname === '/set-password') {
      await drawSetPassword();
      return;
    }
    me = await api('GET', '/me');
    // Only the page's own reads are kept: who is signed in and the count are not what it shows.
    recording = reads;
    who.textContent = `Signed in as ${me.name}`;
    signOut.hidden = false;
    bell.hidden = false;
    showProject();
    // A beat redraws the same page, so its width stays as it is.
    if (!place) main.classList.remove('wide');
    const ticket = /^\/t\/([^/]+)$/.exec(location.pathname);
    const project = /^\/(board|list)(?:\/([^/]+))?$/.exec(location.pathname);
    const projects = location.pathname === '/projects';
    const newProject = location.pathname === '/projects/new';
    const details = !newProject && /^\/projects\/([^/]+)$/.exec(location.pathname);
    const editProject = /^\/projects\/([^/]+)\/edit$/.exec(location.pathname);
    const tasks = location.pathname === '/tasks';
    const isNew = location.pathname === '/new';
    const settings = location.pathname === '/settings';
    const reporting = location.pathname === '/reporting';
    const peoplePage = location.pathname === '/people';
    const search = location.pathname === '/search';
    const waiting = !(search || reporting || settings || peoplePage || isNew || ticket || projects || newProject || editProject || details || tasks || project);
    markNav(reporting ? 'reporting' : settings ? 'settings' : peoplePage ? 'people' : projects || newProject || details || editProject ? 'projects' : ticket || project || tasks || isNew || search ? 'tasks' : 'waiting');
    if (search) {
      await drawSearch(new URLSearchParams(location.search));
    } else if (reporting) {
      await drawReporting();
    } else if (settings) {
      await drawSettings();
    } else if (peoplePage) {
      await drawPeople();
    } else if (isNew) {
      // The old New request address: the Tasks page with its Add Task box open.
      await drawTasks(savedView(), { adding: true });
    } else if (ticket) {
      await drawTicket(decodeURIComponent(ticket[1]));
    } else if (projects) {
      await drawProjects();
    } else if (newProject) {
      await drawCreateProject();
    } else if (editProject) {
      await drawEditProject(decodeURIComponent(editProject[1]));
    } else if (details) {
      await drawProjectDetails(decodeURIComponent(details[1]));
    } else if (tasks || (project && project[2] == null)) {
      // "Tasks" in the header: the selected project, in the view last used.
      await drawTasks(tasks ? savedView() : project[1]);
    } else if (project) {
      await drawProject(decodeURIComponent(project[2]), project[1]);
    } else {
      await drawWaiting();
    }
    place?.restore();
    const kept = recording === reads;
    if (kept) recording = null;
    // Waiting on you read the count as it drew; every other page reads it now.
    if (!waiting) await refreshCount();
    if (kept) lastDrawn = ticket || project || tasks || isNew || waiting ? { address: here(), reads } : null;
  } catch (err) {
    if (place && !(err instanceof SignedOut)) return;
    lastDrawn = null;
    if (err instanceof SignedOut) drawSignIn();
    else showError(err);
  } finally {
    if (recording === reads) recording = null;
    drawing -= 1;
  }
}

/** The page's text boxes and choosers as redrawHold reads them. */
const fieldsOf = (root) => [...root.querySelectorAll('input, textarea, select')].map((el) => ({
  focused: el === document.activeElement,
  value: el.value,
  // A chooser is compared with the choice it was drawn with: "Copy to
  // another project" holds his pick until Copy is pressed.
  initial: el.tagName === 'SELECT' ? drawnChoice(el.options) : el.defaultValue,
}));

/**
 * Draw the page again in place after a save, keeping what the beat compares
 * against current, so the next beat does not find a "change" that was his
 * own save and wipe its "Saved" note.
 */
async function drawAgain(draw) {
  const reads = new Map();
  drawing += 1;
  recording = reads;
  try {
    await draw();
    if (recording === reads && lastDrawn?.address === here()) lastDrawn = { address: here(), reads };
  } finally {
    if (recording === reads) recording = null;
    drawing -= 1;
  }
}

/** Why this beat must leave the page alone, or null. */
const hold = () => redrawHold({ hidden: document.hidden, drawing: drawing > 0, writing: writing > 0, fields: fieldsOf(main) });

/**
 * Where he is on the page: how far down, and which folding sections
 * (Details, a Live column, the Add Task box, the Change panel) are open.
 * `restore` puts them back on the page drawn again.
 */
function keepPlace() {
  const key = (d) => `${d.className}|${d.dataset.stage ?? ''}`;
  const open = new Map([...main.querySelectorAll('details')].map((d) => [key(d), d.open]));
  const y = window.scrollY;
  return {
    restore() {
      for (const d of main.querySelectorAll('details')) if (open.has(key(d))) d.open = open.get(key(d));
      window.scrollTo(0, y);
    },
  };
}

/**
 * Keep the open page current (SP-94): read again everything it was drawn
 * from and, if any answer differs, draw it again where he left it. Never
 * while the tab is hidden, a draw or a save is under way, or he is typing:
 * that beat is skipped. A failed read leaves the page as it is; signed out
 * goes to sign-in.
 */
let checking = false;
async function refreshPage() {
  const drawn = lastDrawn;
  if (checking || !me || !drawn || drawn.address !== here() || hold()) return;
  checking = true;
  try {
    const now = await Promise.all([...drawn.reads].map(([path]) => api('GET', path)));
    const changed = [...drawn.reads].some(([, before], i) => JSON.stringify(now[i]) !== before);
    // He may have moved on, or started typing, while it read.
    if (!changed || lastDrawn !== drawn || drawn.address !== here() || hold()) return;
    refreshing = true;
    await route({ place: keepPlace() });
  } catch (err) {
    if (err instanceof SignedOut) drawSignIn();
  } finally {
    refreshing = false;
    checking = false;
  }
}

/** One beat: the count in the tab title, then the page itself while it is in view. */
async function beat() {
  await refreshCount();
  await refreshPage();
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
signOut.addEventListener('click', async () => {
  let answer;
  try {
    answer = await linkCall('/signout', {});
  } catch {
    answer = { ok: false, body: { message: 'The tracker did not answer.' } };
  }
  history.pushState(null, '', '/');
  drawSignIn(answer.ok ? undefined : `Not signed out: ${answer.body.message} Try Sign out again.`);
});

try { localStorage.removeItem(OLD_TOKEN_KEY); } catch { /* nothing kept */ }

// The count in the tab title stays current while the tab sits pinned in the
// background; the page itself is read again only while it is in view.
setInterval(beat, REFRESH_EVERY_MS);
// Back to the tab: show what changed while it was hidden straight away.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) beat();
});

route();
