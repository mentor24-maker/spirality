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
 * This file is the entry the page loads and holds what every page shares:
 * signing in, the API call, the header, routing and the message strip. Each
 * page lives in its own file beside it (page-tasks.mjs, page-ticket.mjs,
 * page-console.mjs, page-add-task.mjs, page-reporting.mjs,
 * page-settings.mjs, page-projects.mjs, page-users.mjs, page-docs.mjs,
 * page-topics.mjs), which this file imports and which import what they
 * share from it (SP-352), so two tickets changing two pages no longer edit
 * one file.
 *
 * Every word of ticket text reaches the page through render.mjs, which
 * escapes it. Anything else drawn here is either these files' own fixed
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
import { PIPELINE_READ, escapeHtml, renderTrail, tabTitle, bellColour, busLink, linkProblem, passwordProblem, renderPasswordSet, renderSetPassword, renderSignIn, renderForgot, redrawHold, drawnChoice, renderPipelinePod, renderPipelineDetails, pipelinePodLabel, renderHealth, healthLines, lowerMeridiem, renderMessage, renderSavedCard, MESSAGE_CLOSES_MS, SAVED_CARD_MS } from './render.mjs';
import { field, drawSetupNew, drawSetup, drawProjects, drawCreateProject, drawEditProject, drawProjectDetails } from './page-projects.mjs';
import { drawSearch, drawTasks, drawProject, sortableTables, sorted } from './page-tasks.mjs';
import { drawConsole } from './page-console.mjs';
import { drawTicket } from './page-ticket.mjs';
import { drawReporting } from './page-reporting.mjs';
import { drawUsage } from './page-usage.mjs';
import { drawSettings } from './page-settings.mjs';
import { drawUsers } from './page-users.mjs';
import { docAt, commandAt, underDocs, drawDocs, drawCommand, drawDoc } from './page-docs.mjs';
import { drawTopics } from './page-topics.mjs';

/** Where an earlier version of the page kept a pasted token; removed on load, never read. */
const OLD_TOKEN_KEY = 'tracker-token';
/** Board or list: the last one opened, so "Tasks" in the header opens it again. */
export const VIEW_KEY = 'tracker-view';
/** The selected project: the one "Tasks" in the header opens. */
export const PROJECT_KEY = 'tracker-project';
/** The selected project's name, shown in the header beside the person signed in. */
export const PROJECT_NAME_KEY = 'tracker-project-name';
/** The Add Task box's text while it is being typed, so a sign-out or a reload does not lose it. */
export const DRAFT_KEY = 'tracker-request-draft';
/** The Add Task box's title toggle, Suggest a Title or Write My Own Title, kept beside the draft; it outlives a filing. */
export const TITLE_MODE_KEY = 'tracker-request-title-mode';
/** The Suggest Next Tasks box's order, ticks and filed tickets, per project (SP-251), so a redraw or a retry keeps them. */
export const SUGGEST_STATE_KEY = 'tracker-suggest-next';
/** The Add Task bar's Suggest checkbox (SP-303): '1' shows Suggest Next Tasks in the box, anything else the Add Task form. */
export const SUGGEST_SWITCH_KEY = 'tracker-add-task-suggest';
export const main = document.getElementById('main');
const who = document.getElementById('who');
const headerProject = document.getElementById('project');
const signOut = document.getElementById('sign-out');
const bell = document.getElementById('bell');
const busCount = document.getElementById('bus');
const health = document.getElementById('health');
const siteNav = document.querySelector('header nav.site');
export let me = null;

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
/** How often GET /pipeline is read again: the Tasks page's pod (SP-168) and, on every page, the header's health lines (SP-218). */
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
export let refreshing = false;

export function setTitle(title) {
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
export const statusName = (s) => String(s ?? '').replace(/^./, (c) => c.toUpperCase());

/** A time in this computer's own time zone, with the zone named. */
export const when = (iso) => new Date(iso).toLocaleString(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

/** A time of day in this computer's own time zone, for the Pipeline Status pod, am/pm in lowercase (SP-222): "10:45 am". */
const clockTime = (iso) => lowerMeridiem(new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));

/** The last Pipeline Status answer read (GET /pipeline), or null before any or after a failed read. */
let pipelineState = null;

/** When a failing stage's failures began, in the page's own time: "9:00 PM" today, "Nov 10, 9:00 PM" before. */
export const sinceTime = (iso) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? clockTime(iso)
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

/**
 * Read GET /pipeline again, on every page while signed in: it fills the
 * header's health lines (SP-218) and, when it is on the page, the Tasks
 * page's Pipeline Status pod (SP-168), at once from the last answer, so a
 * redraw never blanks it, then from a fresh read. A failed read says so in
 * the pod, shows no health line, and touches nothing else.
 */
export async function refreshPipeline() {
  if (!me) return;
  showPipeline();
  try {
    pipelineState = await api('GET', '/pipeline', undefined, { unrecorded: true });
  } catch (err) {
    if (err instanceof SignedOut) return;
    pipelineState = null;
  }
  showPipeline(true);
  // The Console's Building area follows each read (SP-365), between its own minute redraws.
  document.dispatchEvent(new Event(PIPELINE_READ));
}

/** The last Pipeline Status answer read, or null (before any, or after a failed read). */
export const lastPipeline = () => pipelineState;

/** The header's health lines from the last answer: one per failing stage, hidden when none is (or signed out). */
function showHealth() {
  const lines = me ? healthLines(pipelineState, sinceTime) : [];
  health.hidden = !lines.length;
  health.innerHTML = lines.length ? renderHealth(pipelineState, sinceTime) : '';
}

/** Draw the pod from the last answer; before the first read, it waits quietly. The dialog, when open, redraws with it. */
function showPipeline(read = false) {
  showHealth();
  const pod = main.querySelector('.pipeline-pod');
  if (!pod || (!pipelineState && !read)) return;
  pod.innerHTML = renderPipelinePod(pipelineState, clockTime, Date.now());
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
export function wirePipeline() {
  const pod = main.querySelector('.pipeline-pod');
  const dialog = main.querySelector('dialog.pipeline-status');
  if (!pod || !dialog) return;
  pod.addEventListener('click', () => {
    fillPipelineDialog(dialog);
    dialog.showModal();
  });
  dialog.addEventListener('close', () => pod.focus());
}

export class SignedOut extends Error {}

/** A refused call, carrying the HTTP status the tracker answered with. */
export class Refused extends Error {
  constructor(message, status, field = null, yourProjectsOnly = false) {
    super(message);
    this.status = status;
    this.field = field;
    // A 404 to someone who sees only their own projects: it may be there, on a project they are not on.
    this.yourProjectsOnly = yourProjectsOnly;
  }
}

/** Whether a refusal is the server's "not on a project you are on" 404 (server.mjs notFound). */
export const notOnProject = (err) => err instanceof Refused && err.status === 404 && err.yourProjectsOnly === true;

/**
 * The plain page a person gets for a ticket or project on a project they are
 * not a member of. The server answers a missing one and a hidden one with
 * the same words, so this page says both, and never shows the ticket.
 */
export function drawNotOnProject({ ticket = null, project = null }) {
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
export async function api(method, path, body, { unrecorded = false } = {}) {
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
export async function uploadFile(ticketId, file, to = `/tickets/${encodeURIComponent(ticketId)}/attachments`) {
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
export const MAX_FILE = 10 * 1024 * 1024;

/** A size in bytes in plain words: bytes, KB or MB. */
export function sizeOf(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The pictures a ticket page previews: the plain image kinds, never SVG (a picture that can carry a script). */
const PREVIEW_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** A ticket's attachments on its page: each by name and size, a link that downloads it, a picture also previewed. */
export function renderAttachments(t) {
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
  health.hidden = true;
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
export function putTrail(steps) {
  main.insertAdjacentHTML('afterbegin', renderTrail(steps));
}

export function showError(err) {
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
  health.hidden = true;
  siteNav.hidden = true;
  setTitle(title);
}

export function drawSignIn(problem) {
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
  const table = (list) => `<div class="table-wrap"><table class="tickets"><thead><tr><th>Project</th><th>Status</th><th>Ticket</th><th>Last Change</th></tr></thead><tbody>${rows(list)}</tbody></table></div>`;
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
export const ICONS = Object.freeze({
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
export function action(href, label, icon, offSite = false) {
  const target = offSite ? ' target="_blank" rel="noopener noreferrer"' : '';
  return `<a class="action" href="${escapeHtml(href)}" title="${label}" aria-label="${label}"${target}>`
    + `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg></a>`;
}

/** The same icon as a button, for an action that writes rather than goes somewhere. `data` is its own data-* attributes. */
export function actionButton(label, icon, data) {
  const attrs = Object.entries(data).map(([k, v]) => ` data-${k}="${escapeHtml(v)}"`).join('');
  return `<button type="button" class="action" title="${label}" aria-label="${label}"${attrs}>`
    + `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg></button>`;
}

/**
 * A list row's status icon, first in its Actions cell (SP-201): a green
 * check when his answer is in, a clock (a link to the reply box) when the
 * ticket waits on the person signed in, else an empty slot the same width,
 * so the icons after it line up down the column. Never both: an answered
 * ticket is not on Waiting on You.
 */
export function statusIcon(t) {
  const at = `/t/${encodeURIComponent(t.id)}`;
  if (t.answerIn || t.mergeStands) {
    // SP-285: a merge word that still stands is his answer too, the same check.
    const said = !t.answerIn && t.mergeStands ? 'Your Merge Word Stands' : 'Your Answer Is In';
    return `<span class="action status-icon answer-in-icon" role="img" title="${said}" aria-label="${said}">`
      + `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS.answerIn}</svg></span>`;
  }
  if (t.waiting) return action(`${at}#reply`, 'Waiting on Your Response', ICONS.waiting);
  return '<span class="action status-icon empty" aria-hidden="true"></span>';
}

/** Only an http(s) address is ever drawn as a link or an image; anything else is not drawn. */
const isWebAddress = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);

/** A project's logo, drawn small, or nothing when it has none. */
export const logoOf = (p, cls = 'logo') => (isWebAddress(p.logo)
  ? `<img class="${cls}" src="${escapeHtml(p.logo)}" alt="" referrerpolicy="no-referrer">`
  : '');

/** A project's web address as a link that opens a new tab, or "none". */
export const addressOf = (p) => (isWebAddress(p.url)
  ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.url)}</a>`
  : '<span class="quiet">none</span>');

/** A GitHub repository's owner and name, the store's own shape; anything else is not drawn as a link. */
const isRepo = (v) => typeof v === 'string' && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(v);

/** A project's GitHub repository as a link to it on GitHub that opens a new tab, or "none". */
export const repoOf = (p) => (isRepo(p.repo)
  ? `<a href="https://github.com/${escapeHtml(p.repo)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.repo)}</a>`
  : '<span class="quiet">none</span>');

/** The remembered project view, Board or List; a browser that will not keep it (or that last chose the Console) answers "list". */
export function savedView() {
  try { return localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'list'; } catch { return 'list'; }
}

/** The Tasks view "Tasks" in the header reopens: "console" when the Console was chosen last (SP-233), else savedView(). */
function savedTasksView() {
  try { if (localStorage.getItem(VIEW_KEY) === 'console') return 'console'; } catch { /* nothing remembered */ }
  return savedView();
}

/**
 * The Tasks page's view switch: Board and List for project `slug`, then the
 * Console (every project), `current` marked. A tab bar (UI_DOCTRINE 5,
 * SP-322) drawn as the last item of the Tasks title row, at its right-hand
 * end (SP-326): each tab is its own address, so a link with `aria-current`.
 */
export function viewSwitch(slug, current) {
  const views = [['board', 'Board', `/board/${encodeURIComponent(slug)}`], ['list', 'List', `/list/${encodeURIComponent(slug)}`], ['console', 'Console', '/console']];
  return `<nav class="tabs" aria-label="View">${views.map(([v, label, href]) => `<a href="${href}"${v === current ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
}

/** The selected project's slug, or null when none is remembered. */
export function savedProject() {
  try { return localStorage.getItem(PROJECT_KEY); } catch { return null; }
}

/** Put the selected project's name in the header; none selected, nothing shown. */
export function showProject() {
  let name = null;
  try { name = localStorage.getItem(PROJECT_NAME_KEY); } catch { /* nothing remembered */ }
  headerProject.textContent = name ?? '';
  headerProject.hidden = !name;
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
export async function route({ place = null } = {}) {
  const reads = new Map();
  drawing += 1;
  // A page opened anew starts with nothing said; a page that only read itself again keeps its message.
  if (!refreshing) clearMessage();
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
    // The health lines are on every page (SP-218): drawn from the last answer, read at once when there is none yet.
    if (pipelineState) showHealth();
    else refreshPipeline();
    const ticket = /^\/t\/([^/]+)$/.exec(location.pathname);
    const project = /^\/(board|list)(?:\/([^/]+))?$/.exec(location.pathname);
    const projects = location.pathname === '/projects';
    const newProject = location.pathname === '/projects/new';
    const details = !newProject && /^\/projects\/([^/]+)$/.exec(location.pathname);
    const editProject = /^\/projects\/([^/]+)\/edit$/.exec(location.pathname);
    const tasks = location.pathname === '/tasks';
    const consolePage = location.pathname === '/console';
    const isNew = location.pathname === '/new';
    const settings = location.pathname === '/settings';
    // The API Usage report is under Reporting, so Reporting stays marked on it.
    const usagePage = location.pathname === '/reporting/usage';
    const reporting = location.pathname === '/reporting' || usagePage;
    const usersPage = location.pathname === '/users';
    const docsPage = location.pathname === '/docs';
    const topicsPage = location.pathname === '/topics';
    const docPath = docAt();
    const docsCommand = commandAt();
    const docAny = underDocs();
    const search = location.pathname === '/search';
    const setupNew = location.pathname === '/setup/new';
    const setupAnswers = /^\/setup\/([^/]+)\/answers$/.exec(location.pathname);
    const setupPage = !setupNew && /^\/setup\/([^/]+)$/.exec(location.pathname);
    const setupAny = setupNew || setupAnswers || setupPage;
    let following = false;
    const waiting = !(setupAny || search || reporting || settings || usersPage || docsPage || topicsPage || docAny || isNew || ticket || projects || newProject || editProject || details || tasks || consolePage || project);
    markNav(reporting ? 'reporting' : settings ? 'settings' : usersPage ? 'users' : topicsPage ? 'topics' : docsPage || docAny ? 'docs' : projects || newProject || details || editProject || setupAny ? 'projects' : ticket || project || tasks || consolePage || isNew || search ? 'tasks' : 'waiting');
    if (setupNew) {
      await drawSetupNew(null);
    } else if (setupAnswers) {
      await drawSetupNew(decodeURIComponent(setupAnswers[1]));
    } else if (setupPage) {
      following = await drawSetup(decodeURIComponent(setupPage[1]));
    } else if (search) {
      await drawSearch(new URLSearchParams(location.search));
    } else if (usagePage) {
      await drawUsage();
    } else if (reporting) {
      await drawReporting();
    } else if (settings) {
      await drawSettings();
    } else if (usersPage) {
      await drawUsers();
    } else if (topicsPage) {
      await drawTopics();
    } else if (docsPage) {
      await drawDocs();
    } else if (docsCommand != null) {
      await drawCommand(docsCommand);
    } else if (docAny) {
      await drawDoc(docPath);
    } else if (isNew) {
      // The old New request address: the Tasks page with its Add Task box open.
      await drawTasks(savedView(), { adding: true });
    } else if (consolePage) {
      await drawConsole();
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
      await drawTasks(tasks ? savedTasksView() : project[1]);
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
    // The Console's "in 12 min" counts down on its own, so the beat draws it every time, changed or not.
    if (kept && (consolePage || (tasks && here() === '/console'))) lastDrawn = { address: here(), reads, ticking: true };
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
export async function drawAgain(draw) {
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

/** The page's areas that scroll sideways, whose place keepPlace keeps. */
const SIDEWAYS = '.console';

/**
 * Where he is on the page: how far down, which folding sections
 * (Details, each Tasks stage, the Add Task box, the Change panel) are open,
 * how each Tasks table is sorted, and how far across the Console is scrolled.
 * `restore` puts them back on the page drawn again.
 */
function keepPlace() {
  // A stage is known by its name alone, so a colour added on Settings between
  // two redraws (which changes its classes) does not lose its fold (SP-196).
  // A Settings project box (SP-289) is known by its project the same way.
  const key = (d) => (d.dataset.stage ? `stage|${d.dataset.stage}` : d.dataset.project ? `project|${d.dataset.project}` : d.className);
  const open = new Map([...main.querySelectorAll('details')].map((d) => [key(d), d.open]));
  const y = window.scrollY;
  // Each stage's sort (SP-174), by stage, put back on the stage's new table.
  const sorts = new Map(sortableTables().filter(({ table }) => sorted.get(table)?.sort).map(({ table, stage }) => [stage, sorted.get(table).sort]));
  // How far across each sideways-scrolling area is (the Console's stage
  // columns, SP-233), so his own columns at the right stay in view.
  const across = [...main.querySelectorAll(SIDEWAYS)].map((el) => el.scrollLeft);
  return {
    restore() {
      for (const d of main.querySelectorAll('details')) if (open.has(key(d))) d.open = open.get(key(d));
      for (const { table, stage } of sortableTables()) if (sorts.has(stage)) sorted.get(table)?.apply(sorts.get(stage));
      [...main.querySelectorAll(SIDEWAYS)].forEach((el, i) => { if (i < across.length) el.scrollLeft = across[i]; });
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
    // A page drawn every beat anyway (the Console) is not read twice to compare.
    const now = drawn.ticking ? [] : await Promise.all([...drawn.reads].map(([path]) => api('GET', path)));
    const changed = drawn.ticking || [...drawn.reads].some(([, before], i) => JSON.stringify(now[i]) !== before);
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

// ── The message strip (docs/UI_DOCTRINE.md section 7, SP-323) ───────────────
// One strip between the header and the page, one message at a time: an error
// until its × is pressed, anything else for four seconds, and a Save's success
// as the small card that fades by itself. A button reports here by calling
// showMessage, never by writing a note beside itself. So far only the Settings
// page's Stage Colours Save does; the other pages move onto it ticket by
// ticket, and messages.test.mjs stops new notes being added meanwhile.
const messages = document.getElementById('messages');
let messageTimer = null;

/** Empty the strip. */
function clearMessage() {
  clearTimeout(messageTimer);
  messageTimer = null;
  messages.hidden = true;
  messages.innerHTML = '';
}

/** Show one message (`{ kind: 'success' | 'error' | 'info', text }`) in the strip, in place of whatever it held. */
export function showMessage(said, { afterSave = false } = {}) {
  clearTimeout(messageTimer);
  messageTimer = null;
  messages.hidden = false;
  if (afterSave && said.kind === 'success') {
    messages.innerHTML = renderSavedCard(said.text);
    window.scrollTo({ top: 0 });
    messageTimer = setTimeout(clearMessage, SAVED_CARD_MS);
    return;
  }
  messages.innerHTML = renderMessage(said);
  messages.scrollIntoView({ block: 'nearest' });
  if (said.kind !== 'error') messageTimer = setTimeout(clearMessage, MESSAGE_CLOSES_MS);
}
messages.addEventListener('click', (e) => {
  if (e.target.closest('.message-close')) clearMessage();
});

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
// The header's health lines (SP-218) and the Tasks page's Pipeline Status pod (SP-168) read again once a minute.
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
