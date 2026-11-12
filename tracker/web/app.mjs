/**
 * Dane's page (docs/TRACKER_MVP.md, "Dane's page"): sign in, see what waits
 * on you, open a ticket, answer it, change its priority, tags, assignee,
 * status, name or description (a person only), pick a project, see that project's
 * whole queue as a board or as a list, see one project's details, add,
 * change or delete a project (a person only), file a new request from the
 * Tasks page's Add Task box, copy a ticket into another
 * project, choose a colour for each stage on the Settings page, read the
 * Reporting page's figures, see and invite people on the Users page
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
import { canDelete, closeQuestion, deleteQuestion, deleteRefusal, escapeHtml, mergeQuestion, renderCommands, renderComment, renderFilesMade, renderDeleteAction, renderEditPanel, MOVED_MESSAGE, renderMarkdown, unwrapDoc, renderCloseAction, renderGoAction, goQuestion, renderMergeAction, renderAnswerIn, renderReplyForm, statusLabel, ANSWER_IN_NOTE, renderQuickAction, renderProjectPicker, renderTrail, stageLooks, tabTitle, bellColour, busLink, linkProblem, passwordProblem, renderPasswordSet, renderSetPassword, renderSignIn, renderForgot, renderSearchFilters, renderSearchResults, lookupTicket, redrawHold, drawnChoice, renderSetupSteps, renderSetupNext, renderSetupList, renderSetupForm, setupBody, setupSlug, setupSlugProblem, setupName, setupFollows, firstTicket, renderPipelinePod, renderPipelineDetails, pipelinePodLabel, renderCommandList, renderCommandView, renderCommandDetails, renderContextDocs, renderSortHeadings, renderListPriority, sortTickets, nextSort, renderDocumentation, docRows, sortDocs, filterDocs, renderDocHeadings, renderDocBody, docCountLine } from './render.mjs';

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
const busCount = document.getElementById('bus');
const siteNav = document.querySelector('header nav.site');
let me = null;

/**
 * How often the page reads again: the waiting count in the tab title, and
 * the open page itself (Waiting on you, a board or list, a ticket), which
 * is drawn again when what it was drawn from has changed.
 */
const REFRESH_EVERY_MS = 60_000;
/**
 * A setup page reads again far sooner: a step can finish in seconds, and he
 * is watching it. Only while the page says it follows (setupFollows).
 */
const SETUP_REFRESH_EVERY_MS = 4_000;
/** How often the Tasks page's Pipeline Status pod reads GET /pipeline again (SP-168). */
const PIPELINE_REFRESH_EVERY_MS = 60_000;
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
  await refreshBus();
}

/** The last bus answer read (GET /bus), or null before any. */
let busState = null;

/** Show the bus count in the header from the last answer read; nothing unseen, nothing shown. */
function showBus() {
  const link = me ? busLink(busState) : null;
  busCount.hidden = !link;
  if (!link) return;
  busCount.textContent = link.text;
  busCount.href = link.href;
  busCount.title = link.title;
  busCount.setAttribute('aria-label', link.title);
}

/**
 * Read the bus count again (Dane's choice D on the bus ticket). When the ticket open on the page is a
 * Team chat ticket with posts he has not seen, and the tab is in view, he is looking at them: mark
 * them seen, then read the count again. A failed read leaves the count alone.
 */
async function refreshBus() {
  if (!me) return;
  try {
    busState = await api('GET', '/bus');
    const open = ticketAt();
    // A tab in the background is not him looking: its posts stay counted.
    if (open && !document.hidden && busState.unseen.some((u) => u.id === open)) {
      await api('POST', `/tickets/${encodeURIComponent(open)}/seen`);
      busState = await api('GET', '/bus');
    }
  } catch (err) {
    if (err instanceof SignedOut) drawSignIn();
    return;
  }
  showBus();
}

/** A status as the contract writes it: "needs your input" -> "Needs your input". */
const statusName = (s) => String(s ?? '').replace(/^./, (c) => c.toUpperCase());

/** A time in this computer's own time zone, with the zone named. */
const when = (iso) => new Date(iso).toLocaleString(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

/** A time of day in this computer's own time zone, for the Pipeline Status pod: "10:45 AM". */
const clockTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** The last Pipeline Status answer read (GET /pipeline), or null before any or after a failed read. */
let pipelineState = null;

/**
 * Fill the Tasks page's Pipeline Status pod, when it is on the page (SP-168):
 * at once from the last answer, so a redraw never blanks it, then from a
 * fresh read. A failed read says so in the pod and touches nothing else.
 */
async function refreshPipeline() {
  if (!me || !main.querySelector('.pipeline-pod')) return;
  showPipeline();
  try {
    pipelineState = await api('GET', '/pipeline', undefined, { unrecorded: true });
  } catch (err) {
    if (err instanceof SignedOut) return;
    pipelineState = null;
  }
  showPipeline(true);
}

/** Draw the pod from the last answer; before the first read, it waits quietly. The dialog, when open, redraws with it. */
function showPipeline(read = false) {
  const pod = main.querySelector('.pipeline-pod');
  if (!pod || (!pipelineState && !read)) return;
  pod.innerHTML = renderPipelinePod(pipelineState, clockTime);
  pod.setAttribute('aria-label', pipelinePodLabel(pipelineState, clockTime));
  const dialog = main.querySelector('dialog.pipeline-status');
  if (dialog?.open) fillPipelineDialog(dialog);
}

/** Fill the Pipeline Status dialog's rows from the last answer read. */
function fillPipelineDialog(dialog) {
  dialog.querySelector('.pipeline-details').innerHTML = renderPipelineDetails(pipelineState, when);
}

/**
 * The pod is a button (SP-173): clicking it, or Enter or Space on it, opens
 * the Pipeline Status dialog from the last answer read. Escape or Close
 * shuts it, and focus goes back to the pod.
 */
function wirePipeline() {
  const pod = main.querySelector('.pipeline-pod');
  const dialog = main.querySelector('dialog.pipeline-status');
  if (!pod || !dialog) return;
  pod.addEventListener('click', () => {
    fillPipelineDialog(dialog);
    dialog.showModal();
  });
  dialog.addEventListener('close', () => pod.focus());
}

class SignedOut extends Error {}

/** A refused call, carrying the HTTP status the tracker answered with. */
class Refused extends Error {
  constructor(message, status, field = null, yourProjectsOnly = false) {
    super(message);
    this.status = status;
    this.field = field;
    // A 404 to someone who sees only their own projects: it may be there, on a project they are not on.
    this.yourProjectsOnly = yourProjectsOnly;
  }
}

/** Whether a refusal is the server's "not on a project you are on" 404 (server.mjs notFound). */
const notOnProject = (err) => err instanceof Refused && err.status === 404 && err.yourProjectsOnly === true;

/**
 * The plain page a person gets for a ticket or project on a project they are
 * not a member of. The server answers a missing one and a hidden one with
 * the same words, so this page says both, and never shows the ticket.
 */
function drawNotOnProject({ ticket = null, project = null }) {
  setTitle('Not on This Project · Tracker');
  const line = ticket != null
    ? `Ticket ${ticket} is on a project you are not a member of, or there is no such ticket.`
    : `You are not a member of the project ${project}, or there is no such project.`;
  main.innerHTML = `<h1>You Are Not on This Project</h1>
    <p>${escapeHtml(line)}</p>
    <p class="quiet">An admin can add you to a project from its page.</p>
    <p><a href="/projects">Back to Projects</a></p>`;
  putTrail([{ label: 'Projects', href: '/projects' }, { label: 'Not on This Project' }]);
}

/** Call the tracker as the signed-in person. Answers the parsed JSON, or throws with the server's own message. */
async function api(method, path, body, { unrecorded = false } = {}) {
  const write = method !== 'GET' && method !== 'HEAD';
  // `unrecorded`: a read that is not what the page shows (the Pipeline Status pod), so a change in it never redraws the page.
  const reads = unrecorded ? null : recording;
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
  if (!res.ok) throw new Refused(json?.message ?? `the tracker answered ${res.status}.`, res.status, json?.field ?? null, json?.yourProjectsOnly === true);
  if (!json) throw new Error('the tracker answered with something that is not JSON.');
  if (!write) reads?.set(path, JSON.stringify(json));
  return json;
}

/**
 * Upload one file to a ticket: the file itself as the body, its name and
 * type in headers (tracker/server.mjs, "attachments"). Answers the
 * attachment as listed, or throws with the server's own message. `to` is
 * another upload address taking the same body (a project's context
 * documents, `/projects/<slug>/docs`).
 */
async function uploadFile(ticketId, file, to = `/tickets/${encodeURIComponent(ticketId)}/attachments`) {
  writing += 1;
  let res;
  try {
    res = await fetch(to, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/octet-stream',
        'x-file-name': encodeURIComponent(file.name),
        'x-file-type': file.type || 'application/octet-stream',
      },
      body: file,
    });
  } finally {
    writing -= 1;
  }
  if (res.status === 401) throw new SignedOut();
  let json = null;
  try { json = await res.json(); } catch { /* reported below */ }
  if (!res.ok) throw new Refused(json?.message ?? `the tracker answered ${res.status}.`, res.status);
  return json;
}

/** The largest file the tracker keeps (MAX_ATTACHMENT in tracker/store.mjs), checked here only to say so before sending it. */
const MAX_FILE = 10 * 1024 * 1024;

/** A size in bytes in plain words: bytes, KB or MB. */
function sizeOf(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The pictures a ticket page previews: the plain image kinds, never SVG (a picture that can carry a script). */
const PREVIEW_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** A ticket's attachments on its page: each by name and size, a link that downloads it, a picture also previewed. */
function renderAttachments(t) {
  const files = t.attachments ?? [];
  if (!files.length) return '';
  const item = (a) => {
    const href = `/tickets/${encodeURIComponent(t.id)}/attachments/${encodeURIComponent(a.id)}`;
    return `<li>
        <a href="${href}" download="${escapeHtml(a.name)}">${escapeHtml(a.name)}</a> <span class="quiet">${escapeHtml(sizeOf(a.size))}</span>
        ${PREVIEW_TYPES.includes(a.type) ? `<a class="preview" href="${href}" download="${escapeHtml(a.name)}"><img src="${href}" alt="${escapeHtml(a.name)}"></a>` : ''}
      </li>`;
  };
  return `<section class="attachments"><h2>Attachments</h2><ul>${files.map(item).join('')}</ul></section>`;
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
  busCount.hidden = true;
  siteNav.hidden = true;
  setTitle('Set Your Password · Tracker');
  const link = new URLSearchParams(location.search).get('link') ?? '';
  const refused = (answer) => {
    main.innerHTML = `<h1>Set Your Password</h1><p class="error">${escapeHtml(linkProblem(answer.error) ?? answer.message)}</p>`;
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
  busCount.hidden = true;
  siteNav.hidden = true;
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
  setTitle('Waiting on You · Tracker');
  const rows = (list) => list.map((t) => `
    <tr>
      <td class="project">${escapeHtml(t.projectName)}</td>
      <td class="status">${escapeHtml(statusName(t.status))}</td>
      <td><a href="/t/${encodeURIComponent(t.id)}">${escapeHtml(t.name)}</a> <span class="quiet">${escapeHtml(t.id)}</span></td>
      <td class="when">${escapeHtml(when(t.updatedAt))}</td>
    </tr>`).join('');
  const table = (list) => `<table class="tickets"><thead><tr><th>Project</th><th>Status</th><th>Ticket</th><th>Last Change</th></tr></thead><tbody>${rows(list)}</tbody></table>`;
  main.innerHTML = `
    <h1>Waiting on You</h1>
    ${waiting.length ? table(waiting) : '<p class="quiet">Nothing is waiting on you.</p>'}
    ${unsure.length ? `
      <h2>In Your Statuses but Not Assigned to You</h2>
      <p class="quiet">A hand-off that did not finish: the loop cannot tell whether these need you.</p>
      ${table(unsure)}` : ''}`;
  putTrail([{ label: 'Waiting on You' }]);
}

/** The list's action icons: drawn here, never from ticket text. 24-unit outline icons. */
const ICONS = Object.freeze({
  open: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  reply: '<path d="M4 5h16v11H9l-5 4z"/>',
  view: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  delete: '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  answerIn: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  waiting: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
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

/**
 * A list row's status icon, first in its Actions cell (SP-201): a green
 * check when his answer is in, a clock (a link to the reply box) when the
 * ticket waits on the person signed in, else an empty slot the same width,
 * so the icons after it line up down the column. Never both: an answered
 * ticket is not on Waiting on You.
 */
function statusIcon(t) {
  const at = `/t/${encodeURIComponent(t.id)}`;
  if (t.answerIn) {
    return `<span class="action status-icon answer-in-icon" role="img" title="Your Answer Is In" aria-label="Your Answer Is In">`
      + `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS.answerIn}</svg></span>`;
  }
  if (t.waiting) return action(`${at}#reply`, 'Waiting on Your Response', ICONS.waiting);
  return '<span class="action status-icon empty" aria-hidden="true"></span>';
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
 * One change to a project's members from the Users or Projects page: add
 * (`verb` 'add') or remove `person` (`name`) on project `slug`
 * (`projectName`), through the same calls the project's own page uses.
 * `control` (the Remove button or the add picker) is disabled while it runs.
 * Then `listedNow()` reads the page's list again (true: they are on it,
 * false: they are not, null: cannot tell) and `again(text, failed)` redraws
 * the page saying it worked only when that read agrees. A refusal shows the
 * server's own reason (the owner or operator, who cannot be taken off) and
 * leaves the page as it was.
 */
async function changeMember({ control, note, slug, person, name, projectName, verb, listedNow, again }) {
  const adding = verb === 'add';
  const done = adding ? 'added' : 'removed';
  const where = `${adding ? 'to' : 'from'} ${projectName}`;
  control.disabled = true;
  note.className = 'note quiet';
  note.textContent = `${adding ? 'Adding' : 'Removing'} ${name} ${where}…`;
  try {
    if (adding) await api('POST', `/projects/${encodeURIComponent(slug)}/members`, { person: Number(person) });
    else await api('DELETE', `/projects/${encodeURIComponent(slug)}/members/${encodeURIComponent(person)}`);
  } catch (err) {
    if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${name} was not ${done} ${where}.`);
    if (control.tagName === 'SELECT') control.value = '';
    control.disabled = false;
    note.className = 'note error';
    note.textContent = `Not ${done}: ${err.message}`;
    return;
  }
  // Read back before saying it worked.
  const listed = await listedNow().catch(() => null);
  const ok = listed === adding;
  return again(ok
    ? `${adding ? 'Added' : 'Removed'} ${name} ${where}.`
    : `The tracker said ${name} was ${done} ${where}, but the list read back ${listed == null ? 'could not be read' : (listed ? 'still lists them' : 'does not list them')}.`, !ok);
}

/**
 * Every project, one row each: its logo, name, slug, ticket ids, web
 * address, GitHub repository, owner, how many tickets are open, and an Actions column whose
 * View icon opens its details page. Choosing a name selects the project and
 * opens its tasks; the selected one is marked, and "Tasks" in the header
 * goes back to it. A person signed in gets a Set up a project button (its
 * page links the bare New project form), the projects being set up, and, on
 * each row, Edit and Delete icons; a loop's sign-in gets none of them, and
 * the server refuses it anyway. Delete asks first, then draws the table
 * again from the server, so a deleted project is gone because the server
 * says so; a refusal (a project with tickets) shows the server's own words
 * and the table is left as it was. The Members column names each project's
 * members; an admin also gets Remove on each (never on its owner or
 * operator) and an Add Member picker of the people not on it, each change
 * read back (changeMember). `done` and `problem` are lines to show above
 * the table.
 */
async function drawProjects(done = '', problem = '') {
  const [{ projects, canEditMembers = false }, setups] = await Promise.all([
    api('GET', '/projects'),
    // Projects mid-setup; a tracker that cannot read setups (or a loop's sign-in) shows none.
    me?.kind === 'human' ? api('GET', '/setup').catch((err) => { if (err instanceof SignedOut) throw err; return { setups: [] }; }) : { setups: [] },
  ]);
  setTitle('Projects · Tracker');
  const selected = savedProject();
  const people = me?.kind === 'human';
  // Only an admin, signed in as a person, changes members here (as on a project's own page).
  const editing = people && canEditMembers === true;
  // The people an admin may add: everyone with an account.
  const everyone = editing ? (await api('GET', '/people')).people ?? [] : [];
  // The owner and operator are never taken off: a tag, no Remove.
  const fixedAs = (p, m) => [m.id === p.owner?.id ? 'Owner' : null, m.id === p.operator?.id ? 'Operator' : null].filter(Boolean);
  const memberOf = (p, m) => `<span class="member">${escapeHtml(m.name)}${fixedAs(p, m).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}${editing && !fixedAs(p, m).length
    ? `<button type="button" class="remove-member" data-remove="${escapeHtml(m.id)}" data-name="${escapeHtml(m.name)}" data-slug="${escapeHtml(p.slug)}" data-project="${escapeHtml(p.name)}" aria-label="Remove ${escapeHtml(m.name)} from ${escapeHtml(p.name)}">Remove</button>`
    : ''}</span>`;
  const membersCell = (p) => {
    const members = p.members ?? [];
    const addable = everyone.filter((x) => !members.some((m) => m.id === x.id));
    return `${members.length ? members.map((m) => memberOf(p, m)).join('') : '<span class="quiet">nobody</span>'}${editing && addable.length
      ? `<select class="add-member" data-slug="${escapeHtml(p.slug)}" data-project="${escapeHtml(p.name)}" aria-label="Add a member to ${escapeHtml(p.name)}"><option value="">Add Member…</option>${addable.map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('')}</select>`
      : ''}`;
  };
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
      <td class="members">${membersCell(p)}</td>
      <td class="open">${p.open}</td>
      <td class="actions">${action(`/projects/${encodeURIComponent(p.slug)}`, 'View Project', ICONS.view)}${people
    ? action(`/projects/${encodeURIComponent(p.slug)}/edit`, 'Edit Project', ICONS.edit)
      + actionButton('Delete Project', ICONS.delete, { delete: p.slug, name: p.name })
    : ''}</td>
    </tr>`;
  main.innerHTML = `
    <h1>Projects</h1>
    ${me?.kind === 'human' ? '<div class="toolbar"><a class="button" href="/setup/new">Set Up a Project</a></div>' : ''}
    <p class="note${problem ? ' error' : (done ? ' quiet' : '')}" role="status">${escapeHtml(problem || done)}</p>
    ${renderSetupList(setups)}
    ${projects.length
    ? `<p class="quiet">Choose a project's name to see its tasks.</p>
      <table class="projects"><thead><tr><th class="logo"><span class="hidden">Logo</span></th><th class="name">Name</th><th class="slug">Slug</th><th class="prefix">Ticket Prefix</th><th class="url">Web Address</th><th class="repo">GitHub Repository</th><th class="owner">Owner</th><th class="members">Members</th><th class="open">Open Tickets</th><th class="actions">Actions</th></tr></thead><tbody>${projects.map(row).join('')}</tbody></table>`
    : '<p class="quiet">There are no projects yet.</p>'}`;
  putTrail([{ label: 'Projects' }]);
  const note = main.querySelector('p.note');
  if (editing) {
    const again = (text, failed) => drawProjects(failed ? '' : text, failed ? text : '')
      .catch((err) => (err instanceof SignedOut ? drawSignIn() : showError(err)));
    // Read the project's members back from GET /projects: on it (true), off it (false), gone (null).
    const listedNow = (slug, person) => async () => {
      const back = (await api('GET', '/projects')).projects?.find((x) => x.slug === slug);
      return back ? (back.members ?? []).some((m) => String(m.id) === String(person)) : null;
    };
    for (const select of main.querySelectorAll('select.add-member')) {
      select.addEventListener('change', () => {
        if (!select.value) return;
        const { slug, project } = select.dataset;
        const name = select.selectedOptions[0]?.textContent ?? 'them';
        changeMember({ control: select, note, slug, person: select.value, name, projectName: project, verb: 'add', listedNow: listedNow(slug, select.value), again });
      });
    }
    for (const button of main.querySelectorAll('button.remove-member')) {
      button.addEventListener('click', () => {
        const { remove: id, name, slug, project } = button.dataset;
        if (!confirm(`Remove ${name} from ${project}?`)) return;
        changeMember({ control: button, note, slug, person: id, name, projectName: project, verb: 'remove', listedNow: listedNow(slug, id), again });
      });
    }
  }
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
 * and its list, and its members. An unknown slug says so plainly. An admin
 * gets Add Member (a picker of the people not on it) and Remove on each
 * member but the owner and operator; after each change the page reads the
 * project again and says it worked only when the members it reads agree. A
 * refusal shows the server's own reason. `done` and `problem` are lines to
 * show above the members.
 */
async function drawProjectDetails(slug, done = '', problem = '') {
  let p;
  try {
    p = await api('GET', `/projects/${encodeURIComponent(slug)}`);
  } catch (err) {
    if (notOnProject(err)) return drawNotOnProject({ project: slug });
    if (!(err instanceof Refused) || err.status !== 404) throw err;
    setTitle('No Such Project · Tracker');
    main.innerHTML = `<h1>Projects</h1><p>There is no project ${escapeHtml(slug)}.</p><p><a href="/projects">Back to Projects</a></p>`;
    putTrail([{ label: 'Projects' }]);
    return;
  }
  setTitle(`${p.name} · Tracker`);
  const at = (v) => `/${v}/${encodeURIComponent(p.slug)}`;
  const counts = p.statuses.map((s) => `<tr><td class="status">${escapeHtml(s.status)}</td><td class="count">${s.count}</td></tr>`).join('');
  const members = p.members ?? [];
  const editing = me?.kind === 'human' && p.canEditMembers === true;
  // The people an admin may add: everyone with an account who is not on it yet.
  const people = editing ? (await api('GET', '/people')).people ?? [] : [];
  const addable = people.filter((x) => !members.some((m) => m.id === x.id));
  const fixedAs = (m) => [m.id === p.owner?.id ? 'Owner' : null, m.id === p.operator?.id ? 'Operator' : null].filter(Boolean);
  const memberRow = (m) => `
    <tr><td class="name">${escapeHtml(m.name)}${fixedAs(m).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</td>
      <td class="by">${m.addedBy ? escapeHtml(m.addedBy.name) : '<span class="quiet">the tracker</span>'}</td>
      <td class="added">${escapeHtml(when(m.addedAt))}</td>
      ${editing ? `<td class="actions">${fixedAs(m).length ? '' : `<button type="button" data-remove="${escapeHtml(m.id)}" data-name="${escapeHtml(m.name)}">Remove</button>`}</td>` : ''}</tr>`;
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
    <h2>Tickets by Status</h2>
    <table class="counts"><thead><tr><th>Status</th><th class="count">Tickets</th></tr></thead><tbody>${counts}</tbody></table>
    <h2>Members</h2>
    <p class="note${problem ? ' error' : ' quiet'}" role="status">${escapeHtml(problem || done)}</p>
    ${members.length
    ? `<table class="projects people members"><thead><tr><th class="name">Name</th><th class="by">Added By</th><th class="added">Added</th>${editing ? '<th class="actions"><span class="hidden">Actions</span></th>' : ''}</tr></thead><tbody>${members.map(memberRow).join('')}</tbody></table>`
    : '<p class="quiet">Nobody is a member of this project yet.</p>'}
    ${editing ? (addable.length
    ? `<form class="invite members">
      <label for="add-member">Add a member</label>
      <div class="row"><select id="add-member">${addable.map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('')}</select><button type="submit">Add Member</button></div>
    </form>`
    : '<p class="quiet">Everyone with an account is a member.</p>') : ''}
    <p class="quiet">Only its members (and admins) see this project and its tickets.</p>`;
  putTrail([{ label: p.name, href: '/projects' }, { label: 'Details' }]);
  if (!editing) return;
  const note = main.querySelector('p.note');
  const busy = (text) => { note.className = 'note quiet'; note.textContent = text; };
  const again = (text, failed) => drawProjectDetails(slug, failed ? '' : text, failed ? text : '')
    .catch((err) => (err instanceof SignedOut ? drawSignIn() : showError(err)));
  // Send one change, then read the project back before saying it worked.
  const change = async (control, name, send, wanted, said, verb) => {
    control.disabled = true;
    busy(`${verb === 'add' ? 'Adding' : 'Removing'} ${name}…`);
    try {
      await send();
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${name} was not ${verb === 'add' ? 'added' : 'removed'}.`);
      control.disabled = false;
      note.className = 'note error';
      note.textContent = `Not ${verb === 'add' ? 'added' : 'removed'}: ${err.message}`;
      return;
    }
    const back = await api('GET', `/projects/${encodeURIComponent(slug)}`).catch(() => null);
    const listed = back?.members?.some((m) => String(m.id) === String(wanted.id));
    const ok = back != null && listed === wanted.listed;
    again(ok ? said : `The tracker said ${name} was ${verb === 'add' ? 'added' : 'removed'}, but the members read back ${back ? (listed ? 'still list them' : 'do not list them') : 'could not be read'}.`, !ok);
  };
  const form = main.querySelector('form.members');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const select = form.querySelector('select');
    const id = Number(select.value);
    const name = select.selectedOptions[0]?.textContent ?? 'them';
    change(form.querySelector('button'), name, () => api('POST', `/projects/${encodeURIComponent(slug)}/members`, { person: id }),
      { id, listed: true }, `Added ${name} to ${p.name}.`, 'add');
  });
  for (const button of main.querySelectorAll('button[data-remove]')) {
    button.addEventListener('click', () => {
      const { remove: id, name } = button.dataset;
      if (!confirm(`Remove ${name} from ${p.name}?`)) return;
      change(button, name, () => api('DELETE', `/projects/${encodeURIComponent(slug)}/members/${encodeURIComponent(id)}`),
        { id, listed: false }, `Removed ${name} from ${p.name}.`, 'remove');
    });
  }
}

/** One labelled text box of the project forms. `attrs` is its own extra attributes, already safe. */
const field = (id, label, hint, attrs = '') => `
      <label for="${id}">${label}</label>
      ${hint ? `<span class="hint quiet">${hint}</span>` : ''}
      <input id="${id}" type="text"${attrs}>`;

/** The GitHub repository box's hint, the same on both project forms. */
const REPO_HINT = 'Optional. Where its pull requests live: owner/name, like my-org/my-app, or its https://github.com/ address.';

/** The alert boxes' hints, the same on both project forms. */
const ALERT_EMAIL_HINT = "Where hand-over alerts for this project go. Empty: the tracker's default address.";
const ALERT_PHONE_HINT = 'For iMessage alerts, e.g. 801 555 0123, or +44 20 7946 0000 outside the US. Empty: no texts.';

/**
 * The Create Project form, for a person only: name, slug, ticket prefix, web
 * address, logo (an image's web address), GitHub repository, alert email and phone, and owner, picked from the
 * tracker's people. Saving files the project and opens its details page,
 * which reads it back from the server. A refused save shows the server's own
 * message and leaves every field as typed: the form is not redrawn.
 */
async function drawCreateProject() {
  setTitle('New Project · Tracker');
  if (me?.kind !== 'human') {
    main.innerHTML = '<h1>New Project</h1><p>Only a person signed in to the tracker can add a project.</p><p><a href="/projects">Back to Projects</a></p>';
    return;
  }
  const { people } = await api('GET', '/people');
  main.innerHTML = `
    <h1>New Project</h1>
    <form class="request project">
      ${field('name', 'Name', '', ' required')}
      ${field('slug', 'Slug', 'Its part of every address, like my-project: small letters, digits and hyphens.', ' required autocapitalize="off" spellcheck="false"')}
      ${field('prefix', 'Ticket prefix', 'The start of its ticket ids, like SP in SP-12: capital letters and digits.', ' required autocapitalize="characters" spellcheck="false"')}
      ${field('url', 'Web address', 'Optional. Starts http:// or https://.', ' inputmode="url" spellcheck="false"')}
      ${field('logo', 'Logo', "Optional. An image's web address, starting http:// or https://.", ' inputmode="url" spellcheck="false"')}
      ${field('repo', 'GitHub repository', REPO_HINT, ' autocapitalize="off" spellcheck="false"')}
      ${field('alertEmail', 'Alert email', ALERT_EMAIL_HINT, ' inputmode="email" autocapitalize="off" spellcheck="false"')}
      ${field('alertPhone', 'Alert phone', ALERT_PHONE_HINT, ' inputmode="tel" autocomplete="tel" spellcheck="false"')}
      <label for="owner">Owner</label>
      <select id="owner"><option value="">Nobody</option>${people.map((p) => `<option value="${escapeHtml(p.id)}"${p.id === me.id ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select>
      <div class="row"><button type="submit">Add Project</button><a href="/projects">Cancel</a><span class="note"></span></div>
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
        alertEmail: value('alertEmail'), alertPhone: value('alertPhone'),
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
 * in with what the server holds. Name, web address, logo, GitHub repository, owner and the
 * alert email and phone change;
 * the slug and ticket prefix are shown but cannot, since every ticket's id
 * is built from them. Saving sends the change and opens the details page,
 * which reads it back from the server. A refused save shows the server's own
 * message and leaves every field as typed.
 */
async function drawEditProject(slug) {
  setTitle('Edit Project · Tracker');
  if (me?.kind !== 'human') {
    main.innerHTML = '<h1>Edit Project</h1><p>Only a person signed in to the tracker can change a project.</p><p><a href="/projects">Back to Projects</a></p>';
    return;
  }
  let p;
  try {
    p = await api('GET', `/projects/${encodeURIComponent(slug)}`);
  } catch (err) {
    if (notOnProject(err)) return drawNotOnProject({ project: slug });
    if (!(err instanceof Refused) || err.status !== 404) throw err;
    main.innerHTML = `<h1>Edit Project</h1><p>There is no project ${escapeHtml(slug)}.</p><p><a href="/projects">Back to Projects</a></p>`;
    return;
  }
  const { people } = await api('GET', '/people');
  const filled = (v) => ` value="${escapeHtml(v ?? '')}"`;
  const fixed = 'It cannot change: every ticket\'s id is built from it.';
  main.innerHTML = `
    <h1>Edit Project</h1>
    <form class="request project">
      ${field('name', 'Name', '', ` required${filled(p.name)}`)}
      ${field('slug', 'Slug', fixed, ` disabled${filled(p.slug)}`)}
      ${field('prefix', 'Ticket prefix', fixed, ` disabled${filled(p.prefix)}`)}
      ${field('url', 'Web address', 'Optional. Starts http:// or https://.', ` inputmode="url" spellcheck="false"${filled(p.url)}`)}
      ${field('logo', 'Logo', "Optional. An image's web address, starting http:// or https://.", ` inputmode="url" spellcheck="false"${filled(p.logo)}`)}
      ${field('repo', 'GitHub repository', REPO_HINT, ` autocapitalize="off" spellcheck="false"${filled(p.repo)}`)}
      ${field('alertEmail', 'Alert email', ALERT_EMAIL_HINT, ` inputmode="email" autocapitalize="off" spellcheck="false"${filled(p.alertEmail)}`)}
      ${field('alertPhone', 'Alert phone', ALERT_PHONE_HINT, ` inputmode="tel" autocomplete="tel" spellcheck="false"${filled(p.alertPhone)}`)}
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
        alertEmail: value('alertEmail'), alertPhone: value('alertPhone'),
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
 * Set up a project, its answers (SP-127): `/setup/new`, for a person only.
 * The fields are the wizard's own (`GET /setup/fields`), each filled in with
 * its default; Save writes them (`PUT /setup/<slug>`, checked by the
 * wizard's checker) and opens the project's setup page. A refusal naming a
 * field shows beside it, and every box keeps what was typed.
 * `/setup/<slug>/answers` is the same form for a project already
 * started, filled in from its saved answers, until its sign-ins are made.
 * The bare New project form stays a link away, for a tracker project with
 * no repository.
 */
async function drawSetupNew(project) {
  setTitle('Set Up a Project · Tracker');
  putTrail([{ label: 'Projects', href: '/projects' }, { label: 'Set Up a Project' }]);
  if (me?.kind !== 'human') {
    main.innerHTML = '<h1>Set Up a Project</h1><p>Only a person signed in to the tracker can set up a project.</p><p><a href="/projects">Back to Projects</a></p>';
    return;
  }
  let saved = null;
  if (project) {
    saved = await api('GET', `/setup/${encodeURIComponent(project)}`);
    if (saved.locked) {
      main.innerHTML = `<h1>Set Up ${escapeHtml(setupName(saved))}</h1><p>Its sign-ins are made from these answers, so they no longer change here.</p><p><a href="/setup/${encodeURIComponent(project)}">Back to its setup</a></p>`;
      return;
    }
  }
  let { fields } = await api('GET', `/setup/fields?project=${encodeURIComponent(project ?? '')}`);
  main.innerHTML = `
    <h1>${project ? `Set Up ${escapeHtml(setupName(saved))}: Its Answers` : 'Set Up a Project'}</h1>
    <p class="quiet">The setup runs on the Mini: after Save, its page shows the command to paste into a Terminal there, and follows every step. A tracker project with no GitHub repository? <a href="/projects/new">New project</a>.</p>
    <form class="request setup">
      ${renderSetupForm(fields, saved?.answers ?? null)}
      <p class="quiet">Its slug, in every address and file name: <span class="slug">${escapeHtml(project ?? '')}</span></p>
      <div class="row"><button type="submit">Save</button><a href="${project ? `/setup/${encodeURIComponent(project)}` : '/projects'}">Cancel</a><span class="note form-note"></span></div>
    </form>`;
  const form = main.querySelector('form.setup');
  const note = form.querySelector('.form-note');
  const nameBox = form.querySelector('[name="projectName"]');
  const slugOf = () => project ?? setupSlug(nameBox?.value);
  const showSlug = () => { form.querySelector('.slug').textContent = slugOf() || '(none yet)'; };
  showSlug();
  if (!project && nameBox) {
    nameBox.addEventListener('input', showSlug);
    // Some defaults come from the slug (the ticket prefix): fill them again, where they are still the default.
    nameBox.addEventListener('change', async () => {
      let next;
      try {
        ({ fields: next } = await api('GET', `/setup/fields?project=${encodeURIComponent(slugOf())}`));
      } catch { return; }
      for (const f of next) {
        const box = form.querySelector(`[name="${f.key}"]`);
        if (!box) continue;
        if (box.value === box.dataset.default) box.value = f.default ?? '';
        box.dataset.default = f.default ?? '';
      }
      fields = next;
    });
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    for (const n of form.querySelectorAll('.field-note')) { n.className = 'note field-note'; n.textContent = ''; }
    const slug = slugOf();
    const problem = setupSlugProblem(slug);
    if (problem) {
      note.className = 'note form-note error';
      note.textContent = `Not saved: ${problem}`;
      return;
    }
    const values = Object.fromEntries(fields.map((f) => [f.key, form.querySelector(`[name="${f.key}"]`)?.value ?? '']));
    const button = form.querySelector('button');
    button.disabled = true;
    note.className = 'note form-note quiet';
    note.textContent = 'Saving…';
    try {
      await api('PUT', `/setup/${encodeURIComponent(slug)}`, setupBody(fields, values));
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; the answers were not saved.');
      const beside = err.field ? form.querySelector(`.field-note[data-for="${err.field}"]`) : null;
      if (beside) {
        beside.className = 'note field-note error';
        beside.textContent = err.message;
      }
      note.className = 'note form-note error';
      note.textContent = beside ? 'Not saved: see the note beside the field.' : `Not saved: ${err.message}`;
      button.disabled = false;
      return;
    }
    history.pushState(null, '', `/setup/${encodeURIComponent(slug)}`);
    await route();
  });
  nameBox?.focus();
}

/**
 * One project's setup page (SP-127): its steps as the wizard's state file
 * records them, and under them one box saying what is next, with a Copy
 * button for every command to paste on the Mini. The page runs nothing.
 * Answers whether it follows the setup (reads again every few seconds):
 * until the setup is finished.
 */
async function drawSetup(slug) {
  let setup;
  try {
    setup = await api('GET', `/setup/${encodeURIComponent(slug)}`);
  } catch (err) {
    if (!(err instanceof Refused) || err.status !== 400) throw err;
    setTitle('No Such Setup · Tracker');
    main.innerHTML = `<h1>Set Up a Project</h1><p>${escapeHtml(err.message)}</p><p><a href="/projects">Back to Projects</a></p>`;
    putTrail([{ label: 'Projects', href: '/projects' }, { label: 'Set Up a Project' }]);
    return false;
  }
  const name = setupName(setup);
  // The finished box links its first ticket: the lowest-numbered on its board.
  const firstTicketId = setup.finished
    ? await api('GET', `/projects/${encodeURIComponent(setup.project)}/board`).then(firstTicket, (err) => { if (err instanceof SignedOut) throw err; return null; })
    : null;
  setTitle(`Set Up ${name} · Tracker`);
  main.innerHTML = `
    <section class="setup">
      <h1>Set Up ${escapeHtml(name)}</h1>
      <div class="toolbar"><a href="/projects">All projects</a>${setup.locked ? '' : `<a href="/setup/${encodeURIComponent(setup.project)}/answers">Change the answers</a>`}</div>
      ${setup.answersError ? `<p class="note error">The answers do not check: ${escapeHtml(setup.answersError)}</p>` : ''}
      <h2>Steps</h2>
      ${renderSetupSteps(setup.state)}
      ${renderSetupNext(setup, { firstTicketId })}
    </section>`;
  putTrail([{ label: 'Projects', href: '/projects' }, { label: `Set Up ${name}` }]);
  wireCopyButtons();
  return setupFollows(setup);
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
 * SP-174: a click on a stage's table heading sorts that stage's rows by that
 * column, ascending first, the other way on a second click; each stage
 * sorts on its own. The rows already drawn are moved, not redrawn, so their
 * buttons keep working. `stages` are the drawn stages, each with its tickets
 * in the order the page drew them (the order a sort's ties keep). The sort
 * each table shows (null before any click) is kept in `sorted`, so the
 * minute's redraw puts it back (keepPlace); a reload or a fresh visit
 * shows the usual order.
 */
const sorted = new WeakMap();
/** Each sortable table on the page, with its stage: what keepPlace reads and restores. */
const sortableTables = () => [...main.querySelectorAll('[data-stage] table.sortable')]
  .map((table) => ({ table, stage: table.closest('[data-stage]').dataset.stage }));
function wireSortHeadings(stages) {
  const ticketsOf = new Map(stages.map((c) => [c.status, c.tickets]));
  for (const { table, stage } of sortableTables()) {
    const tickets = ticketsOf.get(stage);
    if (!tickets) continue;
    const apply = (sort) => {
      table.tHead.innerHTML = renderSortHeadings(sort);
      const rows = new Map([...table.tBodies[0].rows].map((tr) => [tr.dataset.id, tr]));
      for (const t of sortTickets(tickets, sort)) {
        const tr = rows.get(t.id);
        if (tr) table.tBodies[0].append(tr);
      }
      sorted.set(table, { sort, apply });
    };
    sorted.set(table, { sort: null, apply });
    table.tHead.addEventListener('click', (e) => {
      const button = e.target.closest('button[data-sort]');
      if (!button) return;
      const sort = nextSort(sorted.get(table)?.sort ?? null, button.dataset.sort);
      apply(sort);
      table.tHead.querySelector(`button[data-sort="${sort.column}"]`).focus();
    });
  }
}

/**
 * One project, as a board or as a list. Both draw the same object, the
 * server's board (pageData.mjs boardOf): the eight statuses in the
 * contract's order, each holding its tickets in `queue` order, so the two
 * views cannot disagree about what is where. Read-only: moves stay with the
 * door and the loops. Every stage folds by a click on its heading, or Enter
 * or Space on it (SP-196); `Live` starts folded in both, its count showing,
 * because it only grows, and every other stage starts open.
 *
 * The board is the working statuses as columns of cards, with Live under
 * them as a list section, newest change first (SP-165); the list is the same
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
 * id of the ticket the box just filed, named in a note after the redraw;
 * `unchecked` adds that the project check could not run. The question box
 * (the Add Task box's "Did you mean ...?") is drawn here, closed.
 *
 * In the List view each row's priority is a dropdown that saves on change
 * (SP-208, wireListPriorities); `said` is `{ id, text, error }`, the note
 * that save leaves beside that ticket's dropdown after the redraw.
 */
async function drawProject(slug, view, { adding = false, filed = null, unchecked = false, uploaded = [], notUploaded = [], said = null } = {}) {
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
  /**
   * A stage's heading (SP-196): its name on the left, its count right-aligned,
   * then the fold arrow, which the stylesheet draws from the block's open
   * state (down when open, right when folded).
   */
  const head = (c) => `<h2><span class="stage-name">${escapeHtml(c.status)}</span><span class="count quiet">${c.tickets.length}</span></h2><span class="fold" aria-hidden="true"></span>`;
  /** Whether a stage starts open: every one but Live, which only grows. */
  const startsOpen = (c) => c.status !== 'Live';
  /** A status's block: every stage folds; its heading is the summary that folds it. */
  const block = (c, cls, body) => `<details class="${cls}" data-stage="${escapeHtml(c.status)}"${startsOpen(c) ? ' open' : ''}><summary>${head(c)}</summary>${body}</details>`;

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
      statusIcon(t),
      action(at, 'Open Ticket', ICONS.open),
      action(`${at}#reply`, 'Reply', ICONS.reply),
      t.pullRequest ? action(t.pullRequest, 'Open Pull Request on GitHub', ICONS.pullRequest, true) : '',
      canDelete(status) ? actionButton('Delete Ticket', ICONS.delete, { delete: t.id }) : '',
    ].join('');
  };
  const row = (status) => (t) => `
    <tr data-id="${escapeHtml(t.id)}">
      <td class="id"><a href="/t/${encodeURIComponent(t.id)}">${escapeHtml(t.id)}</a></td>
      <td class="name"><a href="/t/${encodeURIComponent(t.id)}">${escapeHtml(t.name)}</a></td>
      <td class="priority">${view === 'list' ? renderListPriority(t) : t.priority ? escapeHtml(statusName(t.priority)) : '<span class="quiet">–</span>'}</td>
      <td class="tags">${t.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</td>
      <td class="assignee">${t.assignee ? escapeHtml(t.assignee) : '<span class="quiet">nobody</span>'}</td>
      <td class="when">${escapeHtml(when(t.updatedAt))}</td>
      <td class="actions">${actions(t, status)}</td>
    </tr>`;
  const group = (c) => block(c, 'group', c.tickets.length
    ? `<table class="sortable"><thead>${renderSortHeadings(null)}</thead><tbody>${c.tickets.map(row(c.status)).join('')}</tbody></table>`
    : '');

  // The board's columns are the working stages; Live, which only grows, is a
  // list section under them (SP-165), newest change first.
  const working = board.columns.filter((c) => c.status !== 'Live');
  const liveColumn = board.columns.find((c) => c.status === 'Live');
  const live = liveColumn && { ...liveColumn, tickets: liveColumn.tickets.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)) };

  main.innerHTML = `
    <h1>Tasks</h1>
    <div class="toolbar">
      ${renderProjectPicker(projects, board.project)}
      ${searchForm('')}
      <button type="button" class="pipeline-pod" aria-haspopup="dialog" title="Open Pipeline Status"></button>
      <nav class="views" aria-label="View">${toggle}</nav>
    </div>
    ${filed ? `<p class="filed-note">Filed <a href="/t/${encodeURIComponent(filed)}">${escapeHtml(filed)}</a>${unchecked ? `. ${UNCHECKED_NOTE}` : ''}${filesNote(uploaded, notUploaded)}</p>` : ''}
    <details class="add-task">
      <summary>Add Task</summary>
      <form class="request">
        <label for="title">Title</label>
        <input id="title" type="text" required>
        <label for="description">Description</label>
        <textarea id="description"></textarea>
        <label for="files">Files</label>
        <input id="files" type="file" multiple>
        <span class="hint quiet">Screenshots, PDFs or notes, up to 10 MB each. Files are not kept in the saved draft: after a reload, pick them again.</span>
        <div class="row"><button type="submit">Submit Task</button><span class="note"></span></div>
      </form>
    </details>
    <dialog class="project-check" aria-labelledby="project-check-question">
      <form method="dialog">
        <button type="submit" class="close" value="" aria-label="Close: file nothing">×</button>
        <p id="project-check-question">Did you mean for that to be associated with project <strong class="project-name"></strong>?</p>
        <div class="row">
          <button type="submit" value="move">File in</button>
          <button type="submit" value="keep">Keep in ${escapeHtml(board.projectName)}</button>
        </div>
      </form>
    </dialog>
    <dialog class="pipeline-status" aria-labelledby="pipeline-status-title">
      <form method="dialog">
        <button type="submit" class="close" aria-label="Close">×</button>
        <h2 id="pipeline-status-title">Pipeline Status</h2>
        <div class="pipeline-details"></div>
        <div class="row"><button type="submit">Close</button></div>
      </form>
    </dialog>
    <p class="error list-note" role="alert" hidden></p>
    ${view === 'board'
    ? `<div class="board">${working.map(column).join('')}</div>${live ? `<div class="list board-live">${group(live)}</div>` : ''}`
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
  wireSortHeadings(view === 'board' ? (live ? [live] : []) : board.columns);
  wireSearch();
  wireAddTask(board.project, view, adding);
  wirePipeline();
  refreshPipeline();
  // Picking a project opens it in this same view, as a link would: Back returns here.
  main.querySelector('.project-picker select').addEventListener('change', (e) => {
    history.pushState(null, '', at(view, e.target.value));
    route();
  });
  wireListPriorities(slug, view, board, said);
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

/**
 * SP-208: the List view's priority dropdowns. Picking one sends only the
 * priority, with the version the board drew (`ifVersion`), to the same
 * PATCH /tickets/:id the ticket page's Change panel uses. One save at a
 * time: every priority dropdown is held while a save is in flight, and
 * "Saving…" shows beside the one picked. Saved, the list is drawn again from
 * the server with "Saved" beside it. A 409 means a loop moved the ticket:
 * the list is drawn again as stored, with the moved message beside it. Any
 * other refusal shows the server's words and puts the old value back.
 */
function wireListPriorities(slug, view, board, said) {
  const selects = [...main.querySelectorAll('select[data-priority-of]')];
  const noteOf = (id) => [...main.querySelectorAll('[data-priority-note]')].find((n) => n.dataset.priorityNote === id);
  if (said) {
    const note = noteOf(said.id);
    if (note) {
      note.className = `note${said.error ? ' error' : ' quiet'}`;
      note.textContent = said.text;
    }
  }
  const tickets = new Map(board.columns.flatMap((c) => c.tickets).map((t) => [t.id, t]));
  let saving = false;
  for (const select of selects) {
    select.addEventListener('change', async () => {
      const id = select.dataset.priorityOf;
      const t = tickets.get(id);
      if (!t) return;
      const before = t.priority ?? '';
      if (saving) {
        select.value = before;
        return;
      }
      saving = true;
      const note = noteOf(id);
      const held = selects.filter((c) => !c.disabled);
      for (const c of held) c.disabled = true;
      note.className = 'note quiet';
      note.textContent = 'Saving…';
      let after;
      try {
        await api('PATCH', `/tickets/${encodeURIComponent(id)}`, { priority: select.value, ifVersion: t.version });
        after = { id, text: 'Saved' };
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; the priority of ${id} was not saved.`);
        if (err instanceof Refused && err.status === 409) {
          after = { id, text: MOVED_MESSAGE, error: true };
        } else {
          note.className = 'note error';
          note.textContent = `Not saved: ${err.message}`;
          select.value = before;
          for (const c of held) c.disabled = false;
          saving = false;
          return;
        }
      }
      try {
        await drawAgain(() => drawProject(slug, view, { said: after }));
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; the priority of ${id} was ${after.error ? 'not ' : ''}saved, but the page could not show it.`);
        note.className = 'note error';
        note.textContent = `The page could not refresh (${err.message}): the priority was ${after.error ? 'not ' : ''}saved. Reload to see the list as stored.`;
      }
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
 * the page's filter row, so a reload or a pasted link shows the same
 * results. On the Tasks page, which has no filter row, the project chosen
 * in its project picker goes in as the Project filter (SP-191).
 */
function searchAddress(term) {
  const params = new URLSearchParams({ q: term });
  for (const select of main.querySelectorAll('.project-picker select, .search-filters select')) {
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
 * The Search page's "Ticket number" field (SP-192): Enter, or picking one
 * of the tickets its list offers, opens that ticket's page; a number that
 * is not one of them (render.mjs lookupTicket) shows its plain line in
 * place of the results. `answer` is the server's: the tickets offered and
 * the Project filter, whose chosen name the line uses.
 */
function wireTicketLookup(answer) {
  const form = main.querySelector('form.ticket-lookup');
  if (!form) return;
  const box = form.elements.ticket;
  const project = answer.filters.find((f) => f.key === 'project');
  const projectName = project?.value == null ? null : project.options.find((o) => o.value === project.value)?.label ?? project.value;
  const look = (typed, { quiet = false } = {}) => {
    const found = lookupTicket(typed, answer.tickets, projectName);
    if (!found) return;
    if (found.href) {
      history.pushState(null, '', found.href);
      route();
    } else if (!quiet) {
      main.querySelector('.search-answer').innerHTML = `<p class="quiet search-note">${escapeHtml(found.note)}</p>`;
    }
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    look(box.value);
  });
  // A pick from the list arrives as an input with no typing behind it.
  box.addEventListener('input', (e) => {
    if (e.inputType == null || e.inputType === 'insertReplacementText') look(box.value, { quiet: true });
  });
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
    ${renderSearchFilters(answer.filters, { tickets: answer.tickets ?? [] })}
    <div class="search-answer">${refusal ? `<p class="error">${escapeHtml(refusal)}</p>` : `
    ${answer.results.length ? `<p class="quiet">${answer.results.length} ${answer.results.length === 1 ? 'ticket matches' : 'tickets match'}</p>` : ''}
    ${renderSearchResults(answer)}`}</div>`;
  putTrail([{ label: 'Tasks', href: '/tasks' }, { label: 'Search' }]);
  wireSearch();
  wireTicketLookup({ ...answer, tickets: answer.tickets ?? [] });
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

/** Copy: each command exactly as drawn, onto the clipboard. The page never runs it. */
function wireCopyButtons() {
  for (const button of main.querySelectorAll('button.copy-command')) {
    let reset;
    button.addEventListener('click', async () => {
      const text = button.parentElement.querySelector('code').textContent;
      button.textContent = (await copyText(text, button)) ? 'Copied' : 'Not Copied';
      clearTimeout(reset);
      reset = setTimeout(() => { button.textContent = 'Copy'; }, 1500);
    });
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
      ${renderReplyForm(t, me?.name)}
      ${renderDeleteAction(t)}
      </div>
    </section>
    ${renderFilesMade(t)}
    <details class="details">
      <summary>Details</summary>
      <p class="meta">
        <span>${escapeHtml(t.id)}</span><span>${escapeHtml(t.projectName)}</span>
        <span>${escapeHtml(statusLabel(t))}</span>
        <span>${t.assignee ? `assigned to ${escapeHtml(t.assignee.name)}` : 'not assigned'}</span>
      </p>
      ${me?.kind === 'human' ? renderEditPanel(t) : ''}
      <section class="description">${renderMarkdown(t.description) || '<p class="quiet">No description.</p>'}</section>
      ${renderAttachments(t)}
      <h2 id="comments">Comments</h2>
      ${comments || '<p class="quiet">No comments yet.</p>'}
      <h2>Copy to Another Project</h2>
      ${others.length ? `
      <form class="copy">
        <label for="copy-to">A new ticket with this title and description, in Requested there. This ticket stays exactly as it is.</label>
        <div class="row">
          <select id="copy-to">${others.map((p) => `<option value="${escapeHtml(p.slug)}">${escapeHtml(p.name)}</option>`).join('')}</select>
          <button type="submit">Copy</button><span class="note"></span>
        </div>
      </form>` : '<p class="quiet">There is no other project to copy into yet.</p>'}
    </details>`;
  wireCopyButtons();
  // Arrived by the bus count in the header: open the fold at the comments, where the posts are.
  if (location.hash === '#comments' && !refreshing) {
    main.querySelector('details.details').open = true;
    document.getElementById('comments').scrollIntoView({ block: 'start' });
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
  // After any successful post from this page (the reply box, Merge, Close,
  // Go): Details open so the new reply is there when he scrolls down, and
  // the page kept at the top.
  const afterPost = () => {
    main.querySelector('details.details').open = true;
    window.scrollTo(0, 0);
  };
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
        afterPost();
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
    // No box while his answer is in: nothing typed there to put back.
    const keptBox = main.querySelector('form.reply textarea');
    if (keptBox) keptBox.value = kept.reply;
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
  // While his answer is in there is no reply box (renderReplyForm): the
  // notice is all the page says, and a #reply address just shows it.
  const form = main.querySelector('form.reply');
  if (!form) return;
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
      afterPost();
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

/**
 * The filed note's words about the files picked: which went up, and which
 * did not, each by name with why. Nothing when no file was picked.
 */
function filesNote(uploaded, notUploaded) {
  const names = (list) => list.map((n) => `<strong>${escapeHtml(n)}</strong>`).join(', ');
  let words = '';
  if (uploaded.length) words += `. Uploaded ${names(uploaded)}`;
  if (notUploaded.length) {
    words += `. <span class="error">Not uploaded: ${notUploaded.map((f) => `<strong>${escapeHtml(f.name)}</strong> (${escapeHtml(f.why)})`).join(', ')}. The ticket is filed without ${notUploaded.length === 1 ? 'it' : 'them'}.</span>`;
  }
  return words;
}

/** The filed note's words when the Add Task box's project check could not run. */
const UNCHECKED_NOTE = 'The project check could not run, so it went into the project shown.';

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
 *
 * Before filing, the box asks the server whether the words fit another
 * project better (tracker/projectGuess.mjs). If one does, the
 * question box asks "Did you mean for that to be associated with project
 * X?": File in X files there and opens X's board; Keep in files here;
 * closing it files nothing and leaves the text in the form. A check that
 * fails never stops the filing: the task goes into the project shown and
 * the note says the check could not run.
 */
function wireAddTask(slug, view, adding) {
  const box = main.querySelector('details.add-task');
  const form = box.querySelector('form.request');
  const title = form.querySelector('#title');
  const description = form.querySelector('#description');
  const files = form.querySelector('#files');
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
  const question = main.querySelector('dialog.project-check');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    keep();
    const button = form.querySelector('button');
    button.disabled = true;
    note.className = 'note quiet';
    note.textContent = 'Checking the project…';
    // The check reads the words and writes nothing; a failed check files here as before.
    let suggest = null;
    let unchecked = false;
    try {
      ({ suggest } = await api('POST', `/projects/${encodeURIComponent(slug)}/tickets/check`, {
        name: title.value, description: description.value,
      }));
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; your request was not filed. What you typed is kept: it will be back in the form once you sign in.');
      unchecked = true;
    }
    let into = slug;
    if (suggest) {
      const choice = await askProject(question, suggest);
      if (choice === 'move') into = suggest.slug;
      else if (choice !== 'keep') {
        // Closed: nothing filed, the text stays in the form.
        note.className = 'note';
        note.textContent = '';
        button.disabled = false;
        title.focus();
        return;
      }
    }
    note.className = 'note quiet';
    note.textContent = 'Filing…';
    let ticket;
    try {
      // Exactly as typed: no trimming, no formatting, the same rule as the reply box.
      ticket = await api('POST', `/projects/${encodeURIComponent(into)}/tickets`, {
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
    // The ticket is filed first; then each file goes up on its own, so one
    // that fails is named and the rest, and the ticket, still stand.
    const uploaded = [];
    const notUploaded = [];
    for (const file of [...(files?.files ?? [])]) {
      if (file.size > MAX_FILE) {
        notUploaded.push({ name: file.name, why: 'over 10 MB' });
        continue;
      }
      note.textContent = `Filed ${ticket.id}. Uploading ${file.name}…`;
      try {
        await uploadFile(ticket.id, file);
        uploaded.push(file.name);
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${ticket.id} was filed, but ${file.name} and any files after it were not uploaded.`);
        notUploaded.push({ name: file.name, why: err.message });
      }
    }
    // Filed in another project: open its board, where the new ticket is.
    if (into !== slug) history.pushState(null, '', `/${view}/${encodeURIComponent(into)}`);
    try {
      await drawAgain(() => drawProject(into, view, { filed: ticket.id, unchecked, uploaded, notUploaded }));
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${ticket.id} was filed.`);
      note.className = 'note error';
      note.textContent = `Filed ${ticket.id}, but the page could not be drawn again: ${err.message}`;
    }
  });
}

/**
 * Ask in the Tasks page's question box whether the task belongs to
 * `suggest`, the project its words fit better. Answers 'move' (File in X),
 * 'keep' (Keep in the project shown) or '' (closed: file nothing).
 */
function askProject(question, suggest) {
  question.querySelector('.project-name').textContent = suggest.name;
  question.querySelector('button[value="move"]').textContent = `File in ${suggest.name}`;
  question.returnValue = '';
  return new Promise((resolve) => {
    question.addEventListener('close', () => resolve(question.returnValue), { once: true });
    question.showModal();
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
    <h2>Tasks Finished and Started</h2>
    <p class="quiet">Finished: moved to Live in that time and still Live. Started: filed in that time.</p>
    <table class="counts report"><thead>${head}</thead><tbody>${line('Tasks finished', r.finished)}${line('Tasks started', r.started)}</tbody></table>
    <h2>Human Hours of Work Done</h2>
    <p class="quiet">For tasks finished in that time: the build loop's estimate, recorded on each pull request, of the hours an experienced programmer new to the code would take to do the same work. An estimate, not a measurement; tasks with none are left out of the total, and counted here.</p>
    <table class="counts report human-hours"><thead>${head}</thead><tbody>${hoursLine('Total', (h) => hoursOf(h.hours))}${estimatedLine}${hoursLine('Per day', (h) => `about ${Number(h.perDay)} human hour${Number(h.perDay) === 1 ? '' : 's'} a day`)}</tbody></table>
    ${flow('Time to Finish',
    'For tasks finished in that time: from first entering Queued to entering Live. Tasks that never entered Queued are left out, and counted here.',
    flowLine('Middle (median)', (f) => span(f.timeToFinish.median))
      + flowLine('Longest', (f) => span(f.timeToFinish.longest))
      + flowLine('Left out, never Queued', (f) => String(Number(f.timeToFinish.leftOut))))}
    ${flow('Sent Back',
    'Of the tasks finished in that time, how many review sent to Rework at least once (a task sent back twice counts once).',
    flowLine('Sent back at least once', (f) => `${Number(f.sentBack.count)} of ${Number(f.finished)} (${Math.round(f.sentBack.share * 100)}%)`))}
    ${flow('Waiting on You',
    'For tasks finished in that time: time spent in Needs your input or Ready to launch before going Live, added up and the middle (median) task.',
    flowLine('Total', (f) => span(f.waiting.total)) + flowLine('Middle (median)', (f) => span(f.waiting.median)))}
    <p class="waiting-now">Waiting on you right now: <strong>${Number(r.waitingNow)}</strong> task${Number(r.waitingNow) === 1 ? '' : 's'} in Needs your input or Ready to launch.</p>
    <h2>Open Now</h2>
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
    <h2>Stage Colours</h2>
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
 * The Users page: everyone who has an account (name and email), the open
 * invites (email, who invited, when it expires) each with a Cancel button,
 * and an "Invite someone" form. When the tracker knows an outside site,
 * the form also asks where the link opens ("Send the link to": the tracker
 * page or that site's page). Inviting emails a 7-day link; the server
 * makes the invite only if the email went out, and says so if it did not.
 * After every invite or cancel the page reads the list again and says it
 * worked only when what it reads agrees. A loop's sign-in sees no form and
 * no buttons, and the server refuses it anyway. Each user's role shows in
 * the Role column; an admin gets a picker there instead, whose change is
 * read back the same way, and a refusal (the last admin) shows the server's
 * reason. The Projects column lists the projects each user is a member
 * of, each linking to its details page, under "All projects (admin)" for
 * an admin, who sees every project whatever they are a member of; an admin also gets Remove on each
 * (never where they are its owner or operator) and an Add to Project picker
 * of the projects they are not on, each change read back (changeMember).
 * Under it, which role has which permission.
 */
async function drawUsers(done = '', problem = '') {
  const { people, invites = [], sites = [], roles = [], permissions = [], canEditRoles = false } = await api('GET', '/people');
  setTitle('Users · Tracker');
  const person = me?.kind === 'human';
  const picker = person && canEditRoles;
  // An admin, signed in as a person, also puts people on projects and takes them off here.
  const { projects: all = [], canEditMembers = false } = person ? await api('GET', '/projects') : {};
  const editing = person && canEditMembers === true;
  const bySlug = new Map(all.map((x) => [x.slug, x]));
  // A project's owner and operator are never taken off: a tag, no Remove.
  const fixedAs = (p, x) => { const pr = bySlug.get(x.slug); return [pr?.owner?.id === p.id ? 'Owner' : null, pr?.operator?.id === p.id ? 'Operator' : null].filter(Boolean); };
  // An admin sees every project, so their cell says so first; their
  // own memberships follow, and "none" is left out under that line.
  const projectsCell = (p) => {
    const every = p.seesEveryProject === true;
    const label = every ? '<span class="every" title="An admin sees every project, so they are never shut out of one.">All projects (admin)</span>' : '';
    return `${label}${memberCell(p, every ? '' : '<span class="quiet">none</span>')}`;
  };
  const memberCell = (p, none) => {
    const mine = p.projects ?? [];
    if (!editing) return mine.length ? mine.map((x) => `<a href="/projects/${encodeURIComponent(x.slug)}">${escapeHtml(x.name)}</a>`).join(', ') : none;
    const addable = all.filter((x) => !mine.some((m) => m.slug === x.slug));
    return `${mine.length ? mine.map((x) => `<span class="member"><a href="/projects/${encodeURIComponent(x.slug)}">${escapeHtml(x.name)}</a>${fixedAs(p, x).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}${fixedAs(p, x).length
      ? ''
      : `<button type="button" class="remove-member" data-remove-from="${escapeHtml(x.slug)}" data-project="${escapeHtml(x.name)}" data-person="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" aria-label="Remove ${escapeHtml(p.name)} from ${escapeHtml(x.name)}">Remove</button>`}</span>`).join('') : none}${addable.length
      ? `<select class="add-member" data-person="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" aria-label="Add ${escapeHtml(p.name)} to a project"><option value="">Add to Project…</option>${addable.map((x) => `<option value="${escapeHtml(x.slug)}">${escapeHtml(x.name)}</option>`).join('')}</select>`
      : ''}`;
  };
  const roleCell = (p) => (picker
    ? `<select data-role-of="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" aria-label="Role of ${escapeHtml(p.name)}">${roles.map((r) => `<option value="${escapeHtml(r.name)}"${r.name === p.role ? ' selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}</select>`
    : escapeHtml(p.role ?? ''));
  const personRow = (p) => `
    <tr><td class="name">${escapeHtml(p.name)}</td><td class="email">${p.email ? escapeHtml(p.email) : '<span class="quiet">no email yet</span>'}</td><td class="role">${roleCell(p)}</td>
      <td class="projects">${projectsCell(p)}</td></tr>`;
  const roleRow = (r) => `
    <tr><td class="name"><b>${escapeHtml(r.name)}</b><span class="hint quiet">${escapeHtml(r.description)}</span></td>${permissions.map((x) => `<td class="has">${r.permissions.includes(x.name) ? '✓' : '<span class="hidden">no</span>'}</td>`).join('')}</tr>`;
  const inviteRow = (i) => `
    <tr><td class="email">${escapeHtml(i.email)}</td><td class="by">${escapeHtml(i.invitedBy.name)}</td><td class="expires">${escapeHtml(when(i.expiresAt))}</td>
      <td class="actions">${person ? `<button type="button" data-cancel="${escapeHtml(i.id)}" data-email="${escapeHtml(i.email)}">Cancel</button>` : ''}</td></tr>`;
  main.innerHTML = `
    <h1>Users</h1>
    <p class="note${problem ? ' error' : ' quiet'}" role="status">${escapeHtml(problem || done)}</p>
    ${person ? `<form class="invite">
      <label for="invite-email">Invite someone</label>
      <div class="row"><input id="invite-email" type="email" autocomplete="off" placeholder="their@email.com" required><button type="submit">Send Invite</button></div>
      ${sites.length ? `<label for="invite-site">Send the link to</label>
      <div class="row"><select id="invite-site"><option value="">the tracker page</option>${sites.map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('')}</select></div>` : ''}
      <span class="hint quiet">They get an email with a link to choose their name and password. It works once, for 7 days.</span>
    </form>` : ''}
    <h2>Users with an Account</h2>
    <table class="projects people"><thead><tr><th class="name">Name</th><th class="email">Email</th><th class="role">Role</th><th class="projects">Projects</th></tr></thead><tbody>${people.map(personRow).join('')}</tbody></table>
    <h2>Open Invites</h2>
    ${invites.length
    ? `<table class="projects invites"><thead><tr><th class="email">Email</th><th class="by">Invited By</th><th class="expires">Expires</th><th class="actions"><span class="hidden">Actions</span></th></tr></thead><tbody>${invites.map(inviteRow).join('')}</tbody></table>`
    : '<p class="quiet">No open invites.</p>'}
    <h2>Roles and Permissions</h2>
    <p class="quiet">Each role's permissions are recorded, not yet enforced: for now everyone may do what they could before.</p>
    <table class="projects roles"><thead><tr><th class="name">Role</th>${permissions.map((x) => `<th class="has" title="${escapeHtml(x.name)}">${escapeHtml(x.description)}</th>`).join('')}</tr></thead><tbody>${roles.map(roleRow).join('')}</tbody></table>`;
  putTrail([{ label: 'Users' }]);
  const note = main.querySelector('p.note');
  const busy = (text) => { note.className = 'note quiet'; note.textContent = text; };
  const again = (text, failed) => drawUsers(failed ? '' : text, failed ? text : '')
    .catch((err) => (err instanceof SignedOut ? drawSignIn() : showError(err)));
  const form = main.querySelector('form.invite');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = form.querySelector('input').value.trim();
    // "Send the link to": the tracker page (no site) or an outside site's page.
    const site = form.querySelector('#invite-site')?.value ?? '';
    const button = form.querySelector('button');
    button.disabled = true;
    busy(`Sending an invite to ${email}…`);
    let sent;
    try {
      sent = await api('POST', '/invites', site ? { email, site: Number(site) } : { email });
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
  for (const select of main.querySelectorAll('select[data-role-of]')) {
    const was = select.value;
    select.addEventListener('change', async () => {
      const { roleOf: id, name } = select.dataset;
      const role = select.value;
      select.disabled = true;
      busy(`Changing ${name}'s role to ${role}…`);
      try {
        await api('PUT', `/people/${encodeURIComponent(id)}/role`, { role });
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${name}'s role was not changed.`);
        select.value = was;
        select.disabled = false;
        note.className = 'note error';
        note.textContent = `Not changed: ${err.message}`;
        return;
      }
      // Read back before saying it worked.
      const back = await api('GET', '/people').catch(() => null);
      const now = back?.people?.find((p) => String(p.id) === id)?.role;
      again(now === role ? `${name} is now ${role}.` : `The tracker said ${name}'s role was changed to ${role}, but it reads back as ${now ?? 'unknown'}.`, now !== role);
    });
  }
  if (editing) {
    // Read the person's projects back from GET /people: on it (true), off it (false), unknown person (null).
    const listedNow = (slug, id) => async () => {
      const back = (await api('GET', '/people')).people?.find((x) => String(x.id) === String(id));
      return back ? (back.projects ?? []).some((x) => x.slug === slug) : null;
    };
    for (const select of main.querySelectorAll('select.add-member')) {
      select.addEventListener('change', () => {
        if (!select.value) return;
        const { person: id, name } = select.dataset;
        const slug = select.value;
        const projectName = select.selectedOptions[0]?.textContent ?? slug;
        changeMember({ control: select, note, slug, person: id, name, projectName, verb: 'add', listedNow: listedNow(slug, id), again });
      });
    }
    for (const button of main.querySelectorAll('button.remove-member')) {
      button.addEventListener('click', () => {
        const { removeFrom: slug, project, person: id, name } = button.dataset;
        if (!confirm(`Remove ${name} from ${project}?`)) return;
        changeMember({ control: button, note, slug, person: id, name, projectName: project, verb: 'remove', listedNow: listedNow(slug, id), again });
      });
    }
  }
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

/**
 * The Docs page (SP-171): the selected project's Context
 * Documents (SP-176, files kept on the project itself, uploaded, downloaded
 * and removed here); then every file on its tasks in one Task Files table,
 * newest first. The project is the one picked on the Projects page (shown
 * in the header), else the first. A task file's name downloads it through
 * the task's own download address; the task links to its page. SP-177 makes
 * the Task Files table changeable: Add File puts a file on one of the
 * project's tasks (the same upload the New Task form uses), Rename changes a
 * file's name only, and Remove, once confirmed by name and task, deletes it.
 * Each is read back from the table's own list before the page says it
 * worked. `done` and `problem` are the line the last change left, and
 * `section` says whose it is: 'docs' (Context Documents) or 'files' (Task
 * Files), so it shows in that section only. The Quick Claude Commands pod
 * (SP-179, SP-212) sits down the left third: every slash command,
 * searchable, each opening a pop-up. Last on the right, folded away, Reference Docs and Work Log (SP-175, SP-195): every
 * Markdown file in the repository's docs/ folder, each opening at
 * /docs/spirality/<path>, sortable and filtered on the page.
 */
async function drawDocs(done = '', problem = '', section = 'files') {
  // The documentation call is caught on its own: a tracker not yet restarted onto it answers 404, and Task Files still draws.
  const [{ projects }, files, commands] = await Promise.all([
    api('GET', '/projects'),
    api('GET', '/documentation').then((r) => r.files, () => null),
    // The same for the Commands list (SP-179).
    api('GET', '/commands').then((r) => r.commands, () => null),
  ]);
  setTitle('Docs · Tracker');
  const documentation = renderDocumentation(files, docAddress);
  if (!projects.length) {
    main.innerHTML = `<h1>Docs</h1>${docsColumns(`<h2>Task Files</h2><p class="quiet">There are no projects yet.</p>${documentation}`)}`;
    showCommands(commands);
    wireDocumentation(files);
    putTrail([{ label: 'Docs' }]);
    return;
  }
  const project = projects.find((p) => p.slug === savedProject()) ?? projects[0];
  const listPath = `/projects/${encodeURIComponent(project.slug)}/attachments`;
  const docsPath = `/projects/${encodeURIComponent(project.slug)}/docs`;
  const [{ attachments }, { docs }, { tickets }] = await Promise.all([
    api('GET', listPath),
    api('GET', docsPath),
    api('GET', `/projects/${encodeURIComponent(project.slug)}/tickets`),
  ]);
  const fileLine = section === 'files' ? { done, problem } : { done: '', problem: '' };
  const row = (a) => {
    const href = `/tickets/${encodeURIComponent(a.ticket)}/attachments/${encodeURIComponent(a.id)}`;
    const data = `data-ticket="${escapeHtml(a.ticket)}" data-file="${escapeHtml(a.id)}" data-name="${escapeHtml(a.name)}" data-task-name="${escapeHtml(a.ticketName)}"`;
    return `<tr data-file="${escapeHtml(a.id)}">
      <td class="name"><a href="${href}" download="${escapeHtml(a.name)}">${escapeHtml(a.name)}</a></td>
      <td class="task"><a href="/t/${encodeURIComponent(a.ticket)}">${escapeHtml(a.ticket)}</a> ${escapeHtml(a.ticketName)}</td>
      <td class="type">${escapeHtml(a.type)}</td>
      <td class="size">${escapeHtml(sizeOf(a.size))}</td>
      <td class="by">${a.addedByName ? escapeHtml(a.addedByName) : '<span class="quiet">unknown</span>'}</td>
      <td class="when">${escapeHtml(when(a.createdAt))}</td>
      <td class="actions"><button type="button" class="rename-file" ${data} aria-label="Rename ${escapeHtml(a.name)}">Rename</button>
        <button type="button" class="remove-file" ${data} aria-label="Remove ${escapeHtml(a.name)} from ${escapeHtml(a.ticket)}">Remove</button></td></tr>`;
  };
  main.innerHTML = `
    <h1>Docs</h1>
    ${docsColumns(`
    ${renderContextDocs({ project, docs }, { size: sizeOf, timeOf: when })}
    <h2>Task Files</h2>
    <p class="quiet">Files kept on the tasks of ${escapeHtml(project.name)}. Pick another project on the <a href="/projects">Projects</a> page.</p>
    <p class="note file-note${fileLine.problem ? ' error' : ' quiet'}" role="status">${escapeHtml(fileLine.problem || fileLine.done)}</p>
    ${tickets.length ? `<form class="add-file">
      <label for="add-file-task">Add a file to a task</label>
      <div class="row"><select id="add-file-task" required><option value="">Pick a task…</option>${tickets.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.id)} ${escapeHtml(t.name)}</option>`).join('')}</select>
        <input id="add-file-file" type="file" required aria-label="The file to add"><button type="submit">Add File</button></div>
      <span class="hint quiet">Up to 10 MB. It shows here and on the task's own page.</span>
    </form>` : ''}
    ${attachments.length
    ? `<table class="projects task-files"><thead><tr><th>File</th><th>Task</th><th>Type</th><th>Size</th><th>Added By</th><th>Added On</th><th><span class="hidden">Actions</span></th></tr></thead>
      <tbody>${attachments.map(row).join('')}</tbody></table>`
    : `<p class="quiet">No task in ${escapeHtml(project.name)} has a file yet.</p>`}
    ${documentation}`)}`;
  const note = main.querySelector('.file-note');
  const busy = (text) => { note.className = 'note file-note quiet'; note.textContent = text; };
  const refused = (control, text) => { note.className = 'note file-note error'; note.textContent = text; if (control) control.disabled = false; };
  const again = (text, failed) => drawAgain(() => drawDocs(failed ? '' : text, failed ? text : '', 'files'))
    .catch((err) => (err instanceof SignedOut ? drawSignIn() : showError(err)));
  // The table's own list, read again: what each change is checked against.
  const listedNow = async () => (await api('GET', listPath, undefined, { unrecorded: true })).attachments;
  const form = main.querySelector('form.add-file');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ticket = form.querySelector('#add-file-task').value;
    const file = form.querySelector('#add-file-file').files?.[0];
    const button = form.querySelector('button');
    if (!ticket || !file) return refused(null, 'Pick a task and a file first; nothing was added.');
    if (file.size > MAX_FILE) return refused(null, `${file.name} is over 10 MB. Add a smaller one; nothing was added.`);
    button.disabled = true;
    busy(`Adding ${file.name} to ${ticket}…`);
    let made;
    try {
      made = await uploadFile(ticket, file);
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${file.name} was not added.`);
      return refused(button, `Not added: ${err.message}`);
    }
    const back = await listedNow().catch(() => null);
    const listed = back?.some((a) => a.id === made.id && a.ticket === ticket);
    again(listed ? `Added ${made.name} to ${ticket}.` : `The tracker said ${made.name} was added to ${ticket}, but it is not in the table when read back.`, !listed);
  });
  for (const button of main.querySelectorAll('button.rename-file')) {
    button.addEventListener('click', async () => {
      const { ticket, file, name } = button.dataset;
      const typed = prompt(`New name for ${name} (on ${ticket}):`, name);
      if (typed == null) return;
      if (!typed.trim()) return refused(null, `Not renamed: a file needs a name. ${name} is unchanged.`);
      button.disabled = true;
      busy(`Renaming ${name}…`);
      let renamed;
      try {
        renamed = await api('PATCH', `/tickets/${encodeURIComponent(ticket)}/attachments/${encodeURIComponent(file)}`, { name: typed });
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${name} was not renamed.`);
        return refused(button, `Not renamed: ${err.message}`);
      }
      const back = await listedNow().catch(() => null);
      const now = back?.find((a) => String(a.id) === file)?.name;
      if (!renamed.changed && now === name) return again(`${name} already has that name; nothing changed.`, false);
      again(now === renamed.name ? `Renamed ${name} to ${now}.` : `The tracker said ${name} was renamed to ${renamed.name}, but it reads back as ${now ?? 'missing'}.`, now !== renamed.name);
    });
  }
  for (const button of main.querySelectorAll('button.remove-file')) {
    button.addEventListener('click', async () => {
      const { ticket, file, name, taskName } = button.dataset;
      if (!confirm(`Remove ${name} from ${ticket} ${taskName}? This cannot be undone from the page.`)) return;
      button.disabled = true;
      busy(`Removing ${name} from ${ticket}…`);
      try {
        await api('DELETE', `/tickets/${encodeURIComponent(ticket)}/attachments/${encodeURIComponent(file)}`);
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${name} was not removed.`);
        return refused(button, `Not removed: ${err.message}`);
      }
      const back = await listedNow().catch(() => null);
      const gone = back != null && !back.some((a) => String(a.id) === file);
      again(gone ? `Removed ${name} from ${ticket}.` : `The tracker said ${name} was removed from ${ticket}, but it is still listed when read back.`, !gone);
    });
  }
  wireContextDocs(project, docsPath, section === 'docs' ? done : '', section === 'docs' ? problem : '');
  showCommands(commands);
  wireDocumentation(files);
  putTrail([{ label: 'Docs' }]);
}

/**
 * The Docs page in two columns (SP-212): the Quick Claude Commands pod down
 * the left third, `rest` (Context Documents, Task Files, Reference Docs and
 * Work Log) on the right. A narrow screen stacks the pod above the rest
 * (app.css).
 */
const docsColumns = (rest) => `<div class="docs-columns">${commandsSection()}<div class="docs-main">${rest}</div></div>`;

/**
 * The Quick Claude Commands pod (SP-179, SP-212): a search box over every
 * slash command (GET /commands), each a name and a few words that open its
 * pop-up. Typing filters the list by name, summary or explanation as it is
 * typed; nothing is read again.
 */
function commandsSection() {
  return `<section class="commands-pod" aria-labelledby="commands-pod-title">
    <h2 id="commands-pod-title">Quick Claude Commands</h2>
    <p class="quiet">Every slash command you can give a session: your own and the loop skills. Click one to see what it does.</p>
    <input type="search" id="command-search" aria-label="Find a command" placeholder="Find a command" autocomplete="off">
    <div id="command-list"></div>
    <dialog class="command-details" aria-labelledby="command-details-title">
      <form method="dialog">
        <button type="submit" class="close" aria-label="Close">×</button>
        <div class="command-details-body"></div>
        <div class="row"><button type="submit">Close</button></div>
      </form>
    </dialog>
  </section>`;
}

/**
 * Fill the Quick Claude Commands list and keep it filtered as the search box
 * is typed in; null (the list could not be read) says so. A click on a
 * command opens its pop-up (SP-212); Escape or Close shuts it, and focus
 * goes back to the command clicked. A click with Ctrl, Cmd or Shift held
 * still follows the link to its steps page.
 */
function showCommands(commands) {
  const box = document.getElementById('command-search');
  const list = document.getElementById('command-list');
  if (!commands) {
    box.hidden = true;
    list.innerHTML = '<p class="quiet">The commands could not be read.</p>';
    return;
  }
  const show = () => { list.innerHTML = renderCommandList(commands, box.value); };
  box.addEventListener('input', show);
  show();
  const dialog = main.querySelector('dialog.command-details');
  let opener = null;
  list.addEventListener('click', (e) => {
    const link = e.target.closest('a.command-open');
    if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    const command = commands.find((c) => c.name === link.dataset.command);
    if (!command) return;
    // Not on to the page's own link handler, which would open the steps page instead.
    e.preventDefault();
    e.stopPropagation();
    opener = link;
    dialog.querySelector('.command-details-body').innerHTML = renderCommandDetails(command);
    dialog.showModal();
  });
  dialog.addEventListener('close', () => opener?.focus());
}

/**
 * The Reference Docs and Work Log section's controls (SP-195): the Kind
 * drop-down and the search box narrow the rows together as they change, and
 * a click on Title, Kind or Date sorts by it, the other way on a second
 * click. Only the table body and the count line are drawn again; nothing is
 * read again, and no choice is kept between visits. null (the list could
 * not be read) or an empty list has no controls.
 */
function wireDocumentation(files) {
  const table = main.querySelector('table.spirality-docs');
  if (!files?.length || !table) return;
  const rows = docRows(files);
  const kind = main.querySelector('#doc-kind');
  const search = main.querySelector('#doc-search');
  const count = main.querySelector('.doc-count');
  let sort = null;
  const show = () => {
    const shown = sortDocs(filterDocs(rows, { kind: kind.value, text: search.value }), sort);
    table.tBodies[0].innerHTML = renderDocBody(shown, docAddress);
    table.hidden = !shown.length;
    count.textContent = docCountLine(shown.length, rows.length);
  };
  kind.addEventListener('change', show);
  search.addEventListener('input', show);
  table.tHead.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-sort]');
    if (!button) return;
    sort = nextSort(sort, button.dataset.sort);
    table.tHead.innerHTML = renderDocHeadings(sort);
    show();
    table.tHead.querySelector(`button[data-sort="${sort.column}"]`).focus();
  });
}

/** The command a `/docs/commands/<name>` address opens, or null. */
const commandAt = () => {
  const m = /^\/docs\/commands\/([^/]+)$/.exec(location.pathname);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
};

/**
 * One command's own page, `/docs/commands/<name>`: its steps drawn as
 * formatted text (hard-wrapped lines joined back up first, as a
 * documentation file's are), and a way back.
 */
async function drawCommand(name) {
  const { commands } = await api('GET', '/commands');
  const command = commands.find((c) => c.name === name);
  setTitle(command ? `/${name} · Docs · Tracker` : 'Docs · Tracker');
  main.innerHTML = command
    ? renderCommandView({ ...command, steps: unwrapDoc(command.steps) })
    : `<h1>No Such Command</h1><p class="quiet">There is no command named /${escapeHtml(name)}.</p><p><a href="/docs">Back to Docs</a></p>`;
  putTrail([{ label: 'Docs', href: '/docs' }, { label: command ? `/${command.name}` : 'Not Found' }]);
}

/**
 * The Context Documents section's buttons (SP-176). Upload Document opens
 * the file picker and sends the one file picked (one over 10 MB is refused
 * here before it is sent); the server reads it back before it answers, and
 * the list is read again. Remove asks first, naming the file, then reads
 * the list back to check it is gone. A failure says so in the note and
 * changes nothing on the page.
 */
function wireContextDocs(project, docsPath, done, problem) {
  const note = main.querySelector('.doc-note');
  if (problem || done) {
    note.className = `note doc-note ${problem ? 'error' : 'quiet'}`;
    note.textContent = problem || done;
  }
  const say = (text, failed = false) => {
    note.className = `note doc-note ${failed ? 'error' : 'quiet'}`;
    note.textContent = text;
  };
  const again = (text, failed) => drawDocs(failed ? '' : text, failed ? text : '', 'docs')
    .catch((err) => (err instanceof SignedOut ? drawSignIn() : showError(err)));
  const picker = main.querySelector('input.doc-file');
  const upload = main.querySelector('button.upload-doc');
  upload.addEventListener('click', () => picker.click());
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file) return;
    if (file.size > MAX_FILE) return say(`Not uploaded: ${file.name} is over 10 MB. Upload a smaller file; nothing was saved.`, true);
    upload.disabled = true;
    say(`Uploading ${file.name}…`);
    try {
      await uploadFile(null, file, docsPath);
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${file.name} was not uploaded.`);
      upload.disabled = false;
      return say(`Not uploaded: ${err.message}`, true);
    }
    again(`Uploaded ${file.name} to ${project.name}.`, false);
  });
  for (const button of main.querySelectorAll('button[data-remove-doc]')) {
    button.addEventListener('click', async () => {
      const { removeDoc: id, name } = button.dataset;
      if (!confirm(`Remove ${name} from ${project.name}? It cannot be brought back.`)) return;
      button.disabled = true;
      say(`Removing ${name}…`);
      try {
        await api('DELETE', `${docsPath}/${encodeURIComponent(id)}`);
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${name} was not removed.`);
        button.disabled = false;
        return say(`Not removed: ${err.message}`, true);
      }
      const back = await api('GET', docsPath).catch(() => null);
      const gone = back != null && !back.docs.some((d) => String(d.id) === String(id));
      again(gone ? `Removed ${name} from ${project.name}.` : `The tracker said ${name} was removed, but ${back ? 'it is still listed when read back' : 'the list could not be read back'}.`, !gone);
    });
  }
}

/** The page address of a documentation file, `path` relative to docs/: each piece encoded. */
const docAddress = (path) => `/docs/spirality/${String(path).split('/').map(encodeURIComponent).join('/')}`;
/** Whether the address is a page under the Docs page, `/docs/<name>/<path>`: Spirality's own files or not. */
const underDocs = () => /^\/docs\/[^/]+\/.+$/.test(location.pathname);
/** The documentation file a `/docs/spirality/<path>` address opens, or null. */
const docAt = () => {
  const m = /^\/docs\/spirality\/(.+)$/.exec(location.pathname);
  if (!m) return null;
  try { return m[1].split('/').map(decodeURIComponent).join('/'); } catch { return null; }
};

/**
 * One of Spirality's documentation files (SP-175), drawn with the same
 * Markdown drawing as a ticket's description, its hard-wrapped lines joined
 * back up first (unwrapDoc). Its first "# " heading is the page's own
 * heading, so it is not drawn twice. Read only.
 */
async function drawDoc(path) {
  setTitle('Docs · Tracker');
  const back = '<p><a href="/docs">Back to Docs</a></p>';
  const missing = (where) => {
    main.innerHTML = `<h1>Docs</h1><p>There is no documentation file at <code>${escapeHtml(where)}</code>.</p>${back}`;
    putTrail([{ label: 'Docs', href: '/docs' }, { label: 'Not Found' }]);
  };
  // Any /docs/<name>/... the page does not know (another project's name, a typo): the same message, never a different page.
  if (!path) return missing(location.pathname);
  let doc;
  try {
    doc = await api('GET', `/documentation/${String(path).split('/').map(encodeURIComponent).join('/')}`);
  } catch (err) {
    if (!(err instanceof Refused) || err.status !== 404) throw err;
    return missing(`docs/${path}`);
  }
  setTitle(`${doc.title} · Docs · Tracker`);
  const body = doc.text.replace(/^(?:[ \t]*\n)*#[ \t]+.*\n?/, '');
  main.innerHTML = `
    ${back}
    <h1>${escapeHtml(doc.title)}</h1>
    <p class="quiet"><code>docs/${escapeHtml(doc.path)}</code></p>
    <section class="description doc">${renderMarkdown(unwrapDoc(body)) || '<p class="quiet">This file is empty.</p>'}</section>
    ${back}`;
  putTrail([{ label: 'Docs', href: '/docs' }, { label: doc.title }]);
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
/** The ticket id a `/t/<id>` address opens, or null. */
const ticketAt = () => { const m = /^\/t\/([^/]+)$/.exec(location.pathname); return m ? decodeURIComponent(m[1]) : null; };
/** The project slug a `/board/<slug>` or `/list/<slug>` address opens, or null. */
const boardAt = () => { const m = /^\/(?:board|list)\/([^/]+)$/.exec(location.pathname); return m ? decodeURIComponent(m[1]) : null; };

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
    siteNav.hidden = false;
    showProject();
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
    const usersPage = location.pathname === '/users';
    const docsPage = location.pathname === '/docs';
    const docPath = docAt();
    const docsCommand = commandAt();
    const docAny = underDocs();
    const search = location.pathname === '/search';
    const setupNew = location.pathname === '/setup/new';
    const setupAnswers = /^\/setup\/([^/]+)\/answers$/.exec(location.pathname);
    const setupPage = !setupNew && /^\/setup\/([^/]+)$/.exec(location.pathname);
    const setupAny = setupNew || setupAnswers || setupPage;
    let following = false;
    const waiting = !(setupAny || search || reporting || settings || usersPage || docsPage || docAny || isNew || ticket || projects || newProject || editProject || details || tasks || project);
    markNav(reporting ? 'reporting' : settings ? 'settings' : usersPage ? 'users' : docsPage || docAny ? 'docs' : projects || newProject || details || editProject || setupAny ? 'projects' : ticket || project || tasks || isNew || search ? 'tasks' : 'waiting');
    if (setupNew) {
      await drawSetupNew(null);
    } else if (setupAnswers) {
      await drawSetupNew(decodeURIComponent(setupAnswers[1]));
    } else if (setupPage) {
      following = await drawSetup(decodeURIComponent(setupPage[1]));
    } else if (search) {
      await drawSearch(new URLSearchParams(location.search));
    } else if (reporting) {
      await drawReporting();
    } else if (settings) {
      await drawSettings();
    } else if (usersPage) {
      await drawUsers();
    } else if (docsPage) {
      await drawDocs();
    } else if (docsCommand != null) {
      await drawCommand(docsCommand);
    } else if (docAny) {
      await drawDoc(docPath);
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
    // Waiting on you skipped refreshCount, so the bus count in the header is read here.
    if (waiting) await refreshBus();
    // A setup page under way follows it every few seconds (the fast beat below).
    if (kept && following) lastDrawn = { address: here(), reads, fast: true };
  } catch (err) {
    if (place && !(err instanceof SignedOut)) return;
    lastDrawn = null;
    if (err instanceof SignedOut) drawSignIn();
    else if (notOnProject(err) && ticketAt()) drawNotOnProject({ ticket: ticketAt() });
    else if (notOnProject(err) && boardAt()) drawNotOnProject({ project: boardAt() });
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
const hold = () => redrawHold({ hidden: document.hidden, drawing: drawing > 0, writing: writing > 0, dialog: Boolean(main.querySelector('dialog[open]')), fields: fieldsOf(main) });

/**
 * Where he is on the page: how far down, which folding sections
 * (Details, each Tasks stage, the Add Task box, the Change panel) are open,
 * and how each Tasks table is sorted.
 * `restore` puts them back on the page drawn again.
 */
function keepPlace() {
  // A stage is known by its name alone, so a colour added on Settings between
  // two redraws (which changes its classes) does not lose its fold (SP-196).
  const key = (d) => (d.dataset.stage ? `stage|${d.dataset.stage}` : d.className);
  const open = new Map([...main.querySelectorAll('details')].map((d) => [key(d), d.open]));
  const y = window.scrollY;
  // Each stage's sort (SP-174), by stage, put back on the stage's new table.
  const sorts = new Map(sortableTables().filter(({ table }) => sorted.get(table)?.sort).map(({ table, stage }) => [stage, sorted.get(table).sort]));
  return {
    restore() {
      for (const d of main.querySelectorAll('details')) if (open.has(key(d))) d.open = open.get(key(d));
      for (const { table, stage } of sortableTables()) if (sorts.has(stage)) sorted.get(table)?.apply(sorts.get(stage));
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
// The Pipeline Status pod on the Tasks page reads again once a minute (SP-168).
setInterval(refreshPipeline, PIPELINE_REFRESH_EVERY_MS);
// A setup page under way reads again every few seconds; every other page waits for the beat.
setInterval(() => {
  if (lastDrawn?.fast) refreshPage();
}, SETUP_REFRESH_EVERY_MS);
// Back to the tab: show what changed while it was hidden straight away.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) beat();
});

route();
