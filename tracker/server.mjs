/**
 * The tracker's web API: the addresses the loops and Dane's page call to
 * read and move tickets, and the page itself. Design: docs/TRACKER_MVP.md, "The API".
 *
 * Plain Node `node:http`, no outside packages. Every call carries its
 * caller's own token (`Authorization: Bearer <token>`), so the author of a
 * write is the token's actor, a fact rather than a guess. Each call maps to
 * the store function of the same purpose; the store keeps the data true
 * (statuses, the atomic guards), and the contract's own rules stay in the
 * door.
 *
 * Answers are JSON:
 *   401  no token, or a token no actor holds
 *   403  a call only a person may make, from a machine's token
 *   404  an unknown project, ticket or address
 *   409  a guarded move found the ticket moved: `{ error, status, version }`,
 *        or a delete found the ticket started: `{ error: 'not-deletable', status }`,
 *        or a project delete found it holds tickets: `{ error: 'has-tickets', tickets }`,
 *        or an invite's email already has an account or an open invite
 *   502  an invite whose email did not go out (no invite is left open)
 *   503  an invite with no mail sender or no tracker address (nothing made)
 *   400  a bad field, or a body that names another author
 *   403  a write only a person may make, asked by a loop's token
 * A ticket's attachments are the one call whose body is not JSON: `POST
 * /tickets/<id>/attachments` takes the file's raw bytes
 * (`content-type: application/octet-stream`), its name in `x-file-name`
 * (percent-encoded) and its type in `x-file-type`, up to MAX_ATTACHMENT
 * (10 MB; bigger answers 413 and stores nothing). That content type and
 * those headers are ones only the page's own script can send, never a form
 * on another site. A download (`GET /tickets/<id>/attachments/<n>`) is
 * always sent as a file to save, never a page to open, so an uploaded HTML
 * file cannot run as the tracker's own page.
 * A refused write writes nothing. A token never appears in an answer or a
 * log line: the log names the actor id, never the header.
 *
 * Two calls answer without a token, because an emailed link is their proof
 * (docs/TRACKER_MVP.md, "Sign-ins"): `POST /account/link` says what a link
 * is for, and `POST /account/set-password` uses it. The link's token and the
 * password travel only in the JSON body, never in an address, so neither
 * can reach the log; a refusal answers the store's own code.
 *
 * A person signs in from the page with an email and a password
 * (`POST /signin`), which starts a session held in a cookie the page's
 * script cannot read; `POST /signout` ends it, and `POST /account/forgot`
 * emails a reset link. A call is signed in by a bearer token (every loop,
 * and a person's own token, as before) or by a person's session cookie; a
 * cookie never stands for a machine. A write made with the cookie must say
 * `content-type: application/json`, which a plain form on another site
 * cannot send, so another site can never write as the person signed in.
 *
 * Run directly, it opens the store at TRACKER_DB and listens on
 * TRACKER_PORT; both must be set, nothing is assumed. TRACKER_HOST is the
 * address it listens on: 127.0.0.1 (this machine only) unless set, and
 * 0.0.0.0 for every machine on the home network.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAX_ATTACHMENT, openStore, StoreError } from './store.mjs';
import { boardOf, PRIORITIES, projectDetailsOf, projectsList, readSearchFilters, reportsOf, searchTickets, stageColoursOf, threadOf, waitingFor } from './pageData.mjs';
import { createNotifier, DEFAULT_FROM, MAIL_FROM, MAIL_KEY, mailEnvFromDoppler, mailSettingsFromEnv, resendSender, textSettings } from './notify.mjs';
import { sendInvite, sendResetLink } from './account.mjs';
import { guessProject } from './projectGuess.mjs';
import { findConfigFile, loadProjectConfig } from '../lib/projectConfig.mjs';
import { saveAnswers, setupFields, setupList, setupOf, SetupError } from './setup.mjs';
import busRelayPlan from '../lib/busRelayPlan.js';
import loopStatuses from '../lib/loopStatuses.js';

/**
 * The session cookie's name and how long it lasts: 30 days, the store's own
 * session lifetime. There is no `Secure` flag yet because the tracker is
 * plain http on the home network, where a `Secure` cookie would never be
 * sent back. The ticket that opens the tracker to the internet must add
 * `Secure` (and serve https) before anything else.
 */
const SESSION_COOKIE = 'tracker_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const COOKIE_FLAGS = 'HttpOnly; SameSite=Strict; Path=/';

/** Sign-in failures: this many for one email within the window refuse that email for LOCK_MS. */
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

/** The one answer to a wrong password and to an unknown email, so neither says which. */
const NO_MATCH = 'That email and password do not match.';

/** The largest request body accepted, in bytes. A ticket description fits easily. */
const MAX_BODY = 1024 * 1024;

/** Store refusals that mean "no such thing", answered 404 rather than 400. */
const NOT_FOUND_CODES = new Set(['unknown-ticket', 'unknown-project', 'unknown-invite']);

/** The HTTP status each refused invite answers with (tracker/account.mjs sendInvite); any other is 400. */
const INVITE_REFUSALS = Object.freeze({ 'duplicate-email': 409, 'duplicate-invite': 409, 'no-mail': 503, 'no-address': 503, 'not-sent': 502 });

/** The fields a new ticket may carry. */
const FILE_FIELDS = Object.freeze(['name', 'description', 'status', 'priority', 'tags', 'assignee', 'loopNote']);
/** What the Add Task box's project check reads: the words about to be filed. */
const CHECK_FIELDS = Object.freeze(['name', 'description']);

/** The fields a new project may carry. */
const PROJECT_FIELDS = Object.freeze(['name', 'slug', 'prefix', 'url', 'logo', 'owner', 'repo', 'alertEmail', 'alertPhone']);

/** The fields a project change may carry. Its slug and prefix build every ticket's id, so they never change. */
const PROJECT_CHANGE_FIELDS = Object.freeze(['name', 'url', 'logo', 'owner', 'repo', 'alertEmail', 'alertPhone']);
const PROJECT_FIXED_FIELDS = Object.freeze(['slug', 'prefix']);

/**
 * A slug is the project's own part of every address (`/projects/<slug>`):
 * small letters, digits and single hyphens. `new` is the Create Project
 * form's own address, so no project may take it.
 */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_SLUGS = Object.freeze(['new']);

/** The fields a change may carry, besides its guards. */
const CHANGE_FIELDS = Object.freeze(['name', 'description', 'status', 'priority', 'tags', 'assignee', 'loopNote']);

/**
 * The statuses a person may move a ticket to from the ticket page, in the
 * contract's order. Not `Needs your input` or `Ready to launch`: only `ask`
 * sets those, with an operator card. Not `Building` or `In review`: a loop
 * claims and verifies those. The page offers only these; it does not decide them.
 */
const PERSON_STATUSES = Object.freeze(['requested', 'rework', 'queued', 'live']
  .map((s) => ({ value: s, label: loopStatuses.DISPLAY[s] })));

/**
 * Dane's page (tracker/web/): the only files served without a token, and the
 * only ones served at all, by name. The page holds no data; everything it
 * shows comes through the API below with his token. `/`, `/t/<id>`, `/board`,
 * `/board/<project>`, `/list`, `/list/<project>`, `/new` (the New request
 * form), `/settings` (the stage colours) and `/set-password` (an emailed
 * link's page, `?link=<token>`, which the page reads and never sends back
 * in an address) all answer the page itself, so each address opens its own view;
 * `/projects`, `/projects/<project>` and `/search` do too, for a browser opening them,
 * and `/projects/<project>/edit` (the Edit project form) and `/users` (the
 * Users page) always do. `/people`, the Users page's old address, sends a
 * browser on to `/users` (see pageRedirect); the page's own call to
 * `/people` still gets the data.
 */
const WEB_DIR = new URL('./web/', import.meta.url);
const WEB_FILES = Object.freeze({
  'index.html': 'text/html; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
  'app.mjs': 'text/javascript; charset=utf-8',
  'render.mjs': 'text/javascript; charset=utf-8',
  'wordmark.png': 'image/png',
  'icon.png': 'image/png',
});

/**
 * The page may run only its own scripts and talk only to this server; it may
 * show images from elsewhere (a project's logo is an image's web address),
 * which cannot run anything, and sends them no referrer. With
 * every ticket's text escaped before it is drawn, this is the second lock: an
 * injected script would not run even if escaping ever missed one.
 */
const PAGE_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' http: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-cache',
});

/**
 * The page file a GET of `pathname` answers with, or null when it is not a
 * page address. `/projects` is both the Projects screen and the call that
 * lists them, and `/projects/<project>` both a project's details page and
 * the call that reads them (`/projects/new` is the Create Project form), and
 * `/search?q=<term>` both the search results page and the search itself,
 * and `/setup/<slug>` (`/setup/new` the Set up a product form) both a
 * product's setup page and the call that reads it: a browser opening the address asks for HTML and
 * gets the page; the page's own call asks for anything and gets the data.
 */
function pageFile(pathname, accept = '') {
  if (/^\/(?:projects(?:\/[^/]+)?|search|setup\/(?!fields$)[^/]+)$/.test(pathname)) return /\btext\/html\b/.test(accept) ? 'index.html' : null;
  if (pathname === '/' || /^\/(?:tasks|board|list|new|settings|set-password|reporting|users)$/.test(pathname) || /^\/(?:t|board|list)\/[^/]+$/.test(pathname)) return 'index.html';
  if (/^\/projects\/[^/]+\/edit$/.test(pathname)) return 'index.html';
  if (/^\/setup\/[^/]+\/answers$/.test(pathname)) return 'index.html';
  const m = /^\/web\/([^/]+)$/.exec(pathname);
  return m && Object.hasOwn(WEB_FILES, m[1]) ? m[1] : null;
}

/**
 * Where a GET of `pathname` sends a browser instead, or null. `/people` was
 * the Users page's address: a browser opening it (an old bookmark) is sent
 * on to `/users`, while the page's and the onboarding scripts' own call to
 * `/people` (which does not ask for HTML) still gets the data. The send-on
 * is temporary (302) and never cached, because a browser keys a cached
 * redirect by address alone: a cached one would send the page's own data
 * call to the page too.
 */
function pageRedirect(pathname, accept = '') {
  if (pathname === '/people' && /\btext\/html\b/.test(accept)) return '/users';
  return null;
}

function sendPage(res, name) {
  const body = readFileSync(fileURLToPath(new URL(name, WEB_DIR)));
  res.writeHead(200, { ...PAGE_HEADERS, 'content-type': WEB_FILES[name], 'content-length': body.length });
  res.end(body);
}

/** A failure with the HTTP status it answers with. */
class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function send(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function bearerToken(req) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
  return m ? m[1] : null;
}

/** The session cookie's value, or null when the request carries none. */
function sessionToken(req) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === SESSION_COOKIE) return part.slice(at + 1).trim() || null;
  }
  return null;
}

/** Whether the request is an attachment's upload: the one write whose body is the file itself. */
function isUpload(req, pathname) {
  return req.method === 'POST' && /^\/tickets\/[^/]+\/attachments$/.test(pathname)
    && /^application\/octet-stream\s*(?:;|$)/i.test(req.headers['content-type'] ?? '');
}

/**
 * The upload's bytes. A body over MAX_ATTACHMENT is refused with 413: by
 * its stated length before a byte is read, or else once it passes the cap;
 * either way the rest is read and thrown away so the answer still reaches
 * the sender, and nothing is kept.
 */
async function readFile(req) {
  const tooLarge = () => new HttpError(413, 'too-large', `That file is over ${MAX_ATTACHMENT / (1024 * 1024)} MB. Attach a smaller one; nothing was saved.`);
  const stated = Number(req.headers['content-length']);
  let over = Number.isFinite(stated) && stated > MAX_ATTACHMENT;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    if (over) continue;
    size += chunk.length;
    if (size > MAX_ATTACHMENT) {
      over = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk);
  }
  if (over) throw tooLarge();
  return Buffer.concat(chunks);
}

/** A `content-disposition` that always saves: a plain-letters fallback name, and the real one encoded. */
function downloadDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Whether the request says its body is JSON. */
function saysJson(req) {
  return /^application\/json\s*(?:;|$)/i.test(req.headers['content-type'] ?? '');
}

/**
 * Sign-in failures per email, kept in memory (a restart forgets them).
 * `locked(email)` is whether that email is refused for now; `failed(email)`
 * counts one more, and answers true when it is the one that locks it.
 */
function failureCounter(now) {
  const byEmail = new Map();
  return {
    locked(email) {
      const entry = byEmail.get(email);
      return Boolean(entry && entry.lockedUntil > now());
    },
    failed(email) {
      const t = now();
      const entry = byEmail.get(email) ?? { times: [], lockedUntil: 0 };
      entry.times = entry.times.filter((at) => t - at < FAILURE_WINDOW_MS);
      entry.times.push(t);
      const locks = entry.times.length >= MAX_FAILURES;
      if (locks) {
        entry.lockedUntil = t + LOCK_MS;
        entry.times = [];
      }
      byEmail.set(email, entry);
      return locks;
    },
    cleared(email) {
      byEmail.delete(email);
    },
  };
}

/** The request body as a JSON object; an empty body is `{}`. */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'too-large', `the body is over ${MAX_BODY} bytes.`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad-json', 'the body is not valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'bad-json', 'the body must be a JSON object.');
  }
  return body;
}

/** Refuse a body that names an author other than the caller, or any field not in `allowed`. */
function checkBody(body, me, allowed) {
  for (const key of ['author', 'actor']) {
    if (key in body && body[key] !== me.id) {
      throw new HttpError(400, 'not-your-name', `a write's ${key} is the token's own actor (${me.id}); a body may not name another.`);
    }
  }
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k) && k !== 'author' && k !== 'actor');
  if (unknown.length) {
    throw new HttpError(400, 'bad-field', `unknown field(s): ${unknown.join(', ')}; allowed: ${allowed.join(', ')}.`);
  }
}

/** Refuse any field not in `allowed`, for a call made without a token. */
function onlyFields(body, allowed) {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw new HttpError(400, 'bad-field', `unknown field(s): ${unknown.join(', ')}; allowed: ${allowed.join(', ')}.`);
  }
}

/** Pick the named fields that are present in `body`. */
function pick(body, fields) {
  return Object.fromEntries(fields.filter((f) => f in body).map((f) => [f, body[f]]));
}

/** `?open=` reads as true for "1", "true" or "yes", false for "", "0", "false", "no". */
function flag(value) {
  if (value == null) return false;
  const v = value.trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(v)) return true;
  if (['', '0', 'false', 'no'].includes(v)) return false;
  throw new HttpError(400, 'bad-field', `open must be true or false, not "${value}".`);
}

/**
 * Build the request handler around an open store. `log` gets one line per
 * request (method, path, status, actor id); it is never handed a token.
 * `notifier` (tracker/notify.mjs) hears about every write once its answer
 * has gone back, so a hand-over email can never slow or fail the write.
 * `defaultProject` is the slug the New request form starts on: the project
 * config's projectSlug, never a literal here. One the store does not hold
 * is answered as null, and the page falls back to the first project.
 * `mergePhrase` is the word the ticket page's Merge button posts: the first
 * of the project config's mergePhrases, never a literal here. Null means no
 * Merge button; the reply box still takes the word typed by hand.
 * `closePhrase` is the word the Close button posts (CLOSE_PHRASE below,
 * the relay's own close list). Null means no Close button.
 * `goPhrase` is the word the Go button posts on an intake card (GO_PHRASE
 * below). Null means no Go button.
 * `accountMail` sends the "Forgot password?" and invite emails: `{ send,
 * pageUrl, projectName }`, each link opening under `pageUrl`. With no
 * `send`, an invite is refused and nothing is made. Null (or no
 * `send`) means no reset email goes out; the page's answer is the same,
 * and the log says why. `now` is the clock the sign-in failure count reads.
 * `setup` is what the "Set up a project" calls read (tracker/setup.mjs):
 * `{ homeConfig, homeRoot, folder, trackerDb }`, the tracker home's checked
 * settings file, its main folder, the folder this server runs from and its
 * database. Null means those calls answer 503 and nothing is read or written.
 */
/**
 * The word the ticket page's Close button posts: the first of the relay's
 * close list (CLOSE_PHRASES in lib/busRelayPlan.js), so the button can only
 * ever say something the relay reads as "close it".
 */
export const CLOSE_PHRASE = busRelayPlan.CLOSE_PHRASES[0];
/** The word the Go button posts: the one an intake card asks for (GO_PHRASE in lib/busRelayPlan.js). */
export const GO_PHRASE = busRelayPlan.GO_PHRASE;

export function createHandler(store, { log = () => {}, notifier = null, defaultProject = null, mergePhrase = null, closePhrase = null, goPhrase = null, accountMail = null, setup = null, now = Date.now } = {}) {
  const failures = failureCounter(now);

  /** The Users page's data: each person with their email, and the open invites. */
  function peopleOf() {
    return {
      people: store.listPeople().map((p) => ({ ...p, email: store.emailOf(p.id) })),
      invites: store.listInvites(),
    };
  }

  function requireProject(slug) {
    const project = store.getProject(slug);
    if (!project) throw new HttpError(404, 'unknown-project', `no project "${slug}".`);
    return project;
  }

  function requireTicket(id) {
    const ticket = store.getTicket(id);
    if (!ticket) throw new HttpError(404, 'unknown-ticket', `no ticket ${id}.`);
    return ticket;
  }

  async function route(req, me, url) {
    let parts;
    try {
      parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      throw new HttpError(400, 'bad-path', 'the address is not validly encoded.');
    }
    const { method } = req;

    if (parts.length === 1 && parts[0] === 'me' && method === 'GET') {
      return [200, me];
    }

    // Dane's page: "Set up a project" (tracker/setup.mjs). A person's only;
    // the server reads the wizard's files and writes one, the answers file,
    // and never runs the setup itself: the page shows the command to paste.
    if (parts[0] === 'setup' && parts.length <= 2) {
      if (me.kind !== 'human') {
        throw new HttpError(403, 'people-only', 'only a person signed in to the tracker may read or change a project\'s setup; a machine may not.');
      }
      if (!setup) throw new HttpError(503, 'no-setup', 'this tracker cannot read setups: its settings file was not usable when it started (its log says why).');
      try {
        if (parts.length === 1 && method === 'GET') return [200, setupList(setup)];
        if (parts.length === 2 && parts[1] === 'fields' && method === 'GET') {
          return [200, { fields: setupFields(setup, url.searchParams.get('product') ?? '') }];
        }
        if (parts.length === 2 && parts[1] !== 'fields' && method === 'GET') return [200, setupOf(setup, parts[1])];
        if (parts.length === 2 && parts[1] !== 'fields' && method === 'PUT') {
          const body = await readJson(req);
          return [200, saveAnswers(setup, parts[1], body)];
        }
      } catch (err) {
        if (err instanceof SetupError) throw new HttpError(err.status, err.code, err.message, err.field ? { field: err.field } : {});
        throw err;
      }
    }

    // An actor's name, for a reader showing who wrote a comment. Never its token.
    if (parts.length === 2 && parts[0] === 'actors' && method === 'GET') {
      const actor = /^[0-9]+$/.test(parts[1]) ? store.getActor(Number(parts[1])) : null;
      if (!actor) throw new HttpError(404, 'unknown-actor', `no actor ${parts[1]}.`);
      return [200, actor];
    }

    // Dane's page: what waits on the caller, across every project, by the
    // loop's own verdict (tracker/pageData.mjs).
    if (parts.length === 1 && parts[0] === 'waiting' && method === 'GET') {
      return [200, waitingFor(store, me.id)];
    }

    // Dane's page: the Projects screen, the project Tasks opens, and the New
    // request form's picker with the project it starts on.
    if (parts.length === 1 && parts[0] === 'projects' && method === 'GET') {
      const projects = projectsList(store);
      const fallback = projects.some((p) => p.slug === defaultProject) ? defaultProject : null;
      return [200, { projects, default: fallback }];
    }

    // Dane's page: the Create Project form. Only a person may add a project:
    // a loop's or a hand-run session's token is refused and nothing is written.
    if (parts.length === 1 && parts[0] === 'projects' && method === 'POST') {
      if (me.kind !== 'human') {
        throw new HttpError(403, 'people-only', 'only a person signed in to the tracker may add a project; a machine may not.');
      }
      const body = await readJson(req);
      checkBody(body, me, PROJECT_FIELDS);
      if (typeof body.slug === 'string' && body.slug.trim() && (!SLUG.test(body.slug) || RESERVED_SLUGS.includes(body.slug))) {
        throw new HttpError(400, 'bad-slug', RESERVED_SLUGS.includes(body.slug)
          ? `"${body.slug}" is the form's own address; choose another slug.`
          : `a slug is small letters, digits and single hyphens (like "my-project"), not "${body.slug}".`);
      }
      if (body.owner != null && !Number.isInteger(body.owner)) {
        throw new HttpError(400, 'bad-owner', `owner must be a person's actor id, not "${body.owner}".`);
      }
      const made = store.createProject(pick(body, PROJECT_FIELDS));
      return [201, projectDetailsOf(store, made.slug, { withAlerts: true })];
    }

    // Dane's page: the people in the tracker, for the Create Project form's
    // owner picker, and the Users page. A person also sees each one's email
    // and the open invites; a loop sees names and ids only. Never a machine,
    // never a token or a hash.
    if (parts.length === 1 && parts[0] === 'people' && method === 'GET') {
      return [200, me.kind === 'human' ? peopleOf() : { people: store.listPeople() }];
    }

    // Dane's page: the Users page's "Invite someone". Only a person may
    // invite; the invite is made only if its email goes out.
    if (parts.length === 1 && parts[0] === 'invites' && method === 'POST') {
      if (me.kind !== 'human') {
        throw new HttpError(403, 'people-only', 'only a person signed in to the tracker may invite someone; a machine may not.');
      }
      const body = await readJson(req);
      checkBody(body, me, ['email']);
      if (typeof body.email !== 'string' || !body.email.trim()) throw new HttpError(400, 'missing', 'type the email to invite.');
      const result = await sendInvite({
        store, email: body.email, madeBy: me.id, send: accountMail?.send ?? null,
        trackerUrl: accountMail?.pageUrl ?? null, projectName: accountMail?.projectName ?? 'tracker',
      });
      log(result.ok ? `invite sent actor=${me.id}` : `invite NOT sent (${result.code}) actor=${me.id}`);
      if (!result.ok) throw new HttpError(INVITE_REFUSALS[result.code] ?? 400, result.code, result.line);
      return [201, { sent: result.line, ...peopleOf() }];
    }

    // Dane's page: the Users page's Cancel button on an open invite.
    if (parts.length === 2 && parts[0] === 'invites' && method === 'DELETE') {
      if (me.kind !== 'human') {
        throw new HttpError(403, 'people-only', 'only a person signed in to the tracker may cancel an invite; a machine may not.');
      }
      const r = store.cancelInvite(/^[0-9]+$/.test(parts[1]) ? Number(parts[1]) : parts[1]);
      log(`cancelled invite ${r.cancelled} actor=${me.id}`);
      return [200, r];
    }

    // Dane's page: the Settings page's stage colours. Anyone signed in reads
    // them; only a person changes them, never a loop.
    if (parts.length === 1 && parts[0] === 'stage-colours') {
      if (method === 'GET') return [200, stageColoursOf(store)];
      if (method === 'PUT') {
        if (me.kind !== 'human') {
          throw new HttpError(403, 'people-only', 'only a person can change the stage colours; a loop sign-in may not.');
        }
        const body = await readJson(req);
        checkBody(body, me, ['colours']);
        store.setStageColours(body.colours);
        return [200, stageColoursOf(store)];
      }
    }

    // Dane's page: the Reporting page's figures, for one project
    // (`?project=<slug>`) or, with none named, every project. Read-only.
    if (parts.length === 1 && parts[0] === 'reports' && method === 'GET') {
      const slug = url.searchParams.get('project');
      const reports = reportsOf(store, { project: slug == null || slug === '' ? null : slug });
      if (!reports) throw new HttpError(404, 'unknown-project', `no project "${slug}".`);
      return [200, reports];
    }

    // Dane's page: the search results page's tickets, across every project,
    // best matches first (tracker/pageData.mjs searchTickets), narrowed by
    // its filters (`status`, `priority`, `createdBy`, `assignee`); a value
    // that is none of the choices is refused, never an empty list. Read-only.
    if (parts.length === 1 && parts[0] === 'search' && method === 'GET') {
      const { filters, problem } = readSearchFilters(store, (key) => url.searchParams.get(key));
      if (problem) throw new HttpError(400, 'unknown-filter', problem);
      return [200, searchTickets(store, url.searchParams.get('q'), filters)];
    }

    // Dane's page: one project's details page. A person also sees its alert
    // email and phone (the Edit project form); a loop never does.
    if (parts.length === 2 && parts[0] === 'projects' && method === 'GET') {
      const details = projectDetailsOf(store, parts[1], { withAlerts: me.kind === 'human' });
      if (!details) throw new HttpError(404, 'unknown-project', `no project "${parts[1]}".`);
      return [200, details];
    }

    // Dane's page: the Edit project form and the Delete icon. Only a person
    // may change or delete a project; a machine's token is refused and
    // nothing is written. A project with tickets is never deleted.
    if (parts.length === 2 && parts[0] === 'projects' && (method === 'PATCH' || method === 'DELETE')) {
      if (me.kind !== 'human') {
        throw new HttpError(403, 'people-only', `only a person signed in to the tracker may ${method === 'PATCH' ? 'change' : 'delete'} a project; a machine may not.`);
      }
      const project = requireProject(parts[1]);
      if (method === 'PATCH') {
        const body = await readJson(req);
        const fixed = PROJECT_FIXED_FIELDS.filter((k) => k in body);
        if (fixed.length) {
          throw new HttpError(400, 'not-changeable', `a project's ${fixed.join(' and ')} cannot change: every ticket's id and its project link are built from them.`);
        }
        checkBody(body, me, PROJECT_CHANGE_FIELDS);
        if (body.owner != null && !Number.isInteger(body.owner)) {
          throw new HttpError(400, 'bad-owner', `owner must be a person's actor id, not "${body.owner}".`);
        }
        store.updateProject(project.slug, pick(body, PROJECT_CHANGE_FIELDS));
        return [200, projectDetailsOf(store, project.slug, { withAlerts: true })];
      }
      let gone;
      try {
        gone = store.deleteProject(project.slug);
      } catch (err) {
        if (err instanceof StoreError && err.code === 'has-tickets') {
          throw new HttpError(409, 'has-tickets', err.message, { project: project.slug, tickets: err.tickets });
        }
        throw err;
      }
      log(`deleted project ${gone.slug} (prefix ${gone.prefix}) actor=${me.id}`);
      return [200, { deleted: gone.slug }];
    }

    // Dane's page: one project's board, the eight statuses in the contract's
    // order, each column in `queue` order.
    if (parts.length === 3 && parts[0] === 'projects' && parts[2] === 'board' && method === 'GET') {
      const board = boardOf(store, parts[1]);
      if (!board) throw new HttpError(404, 'unknown-project', `no project "${parts[1]}".`);
      return [200, board];
    }

    // Dane's page: the Add Task box asks, before it files, whether the words
    // fit another project better (tracker/projectGuess.mjs). Plain
    // word matching on the tickets already here; it writes nothing.
    if (parts.length === 4 && parts[0] === 'projects' && parts[2] === 'tickets' && parts[3] === 'check' && method === 'POST') {
      const project = requireProject(parts[1]);
      const body = await readJson(req);
      checkBody(body, me, CHECK_FIELDS);
      for (const key of CHECK_FIELDS) {
        if (body[key] != null && typeof body[key] !== 'string') throw new HttpError(400, 'bad-field', `${key} must be text.`);
      }
      const projects = store.listProjects().map((p) => ({ slug: p.slug, name: p.name, tickets: store.listTickets(p.slug) }));
      return [200, { suggest: guessProject({ name: body.name ?? '', description: body.description ?? '' }, project.slug, projects) }];
    }

    if (parts.length === 3 && parts[0] === 'projects' && parts[2] === 'tickets') {
      const project = requireProject(parts[1]);
      if (method === 'GET') {
        const status = url.searchParams.get('status');
        const tickets = store.listTickets(project.slug, {
          status: status == null || status === '' ? undefined : status,
          open: flag(url.searchParams.get('open')),
        });
        return [200, { project: project.slug, tickets }];
      }
      if (method === 'POST') {
        const body = await readJson(req);
        checkBody(body, me, FILE_FIELDS);
        const ticket = store.fileTicket({ ...pick(body, FILE_FIELDS), project: project.slug, actor: me.id });
        return [201, ticket, { ticket, changed: ['status'] }];
      }
    }

    if (parts.length === 2 && parts[0] === 'tickets') {
      if (method === 'GET') {
        const ticket = requireTicket(parts[1]);
        return [200, { ...ticket, comments: store.listComments(ticket.id) }];
      }
      if (method === 'PATCH') {
        const body = await readJson(req);
        checkBody(body, me, [...CHANGE_FIELDS, 'ifStatus', 'ifVersion']);
        const ticket = requireTicket(parts[1]);
        // The contract's hand-off signal: a ticket is assigned to its
        // project's operator or to nobody. A person's change is held to it
        // here; a loop's goes through the door, which already keeps it.
        if (me.kind === 'human' && body.assignee != null) {
          const operator = store.getProject(ticket.project)?.operator ?? null;
          if (body.assignee !== operator) {
            throw new HttpError(400, 'bad-assignee', `a ticket is assigned to its project's operator${operator == null ? '' : ` (actor ${operator})`} or to nobody, not to actor ${body.assignee}.`);
          }
        }
        const r = store.changeTicket(ticket.id, {
          ...pick(body, [...CHANGE_FIELDS, 'ifStatus', 'ifVersion']),
          actor: me.id,
        });
        if (!r.ok) {
          throw new HttpError(409, 'moved', `ticket ${r.ticket} has moved: it is "${r.status}" at version ${r.version}.`,
            { ticket: r.ticket, status: r.status, version: r.version });
        }
        return [200, { ticket: r.ticket, changed: r.changed }, { ticket: r.ticket, changed: r.changed }];
      }
      // Delete a ticket nobody has started; the store refuses any other.
      // The log line names the ticket and the actor, the deletion's record.
      if (method === 'DELETE') {
        let gone;
        try {
          gone = store.deleteTicket(parts[1], { actor: me.id });
        } catch (err) {
          if (err instanceof StoreError && err.code === 'not-deletable') {
            throw new HttpError(409, 'not-deletable', err.message, { ticket: parts[1], status: err.status });
          }
          throw err;
        }
        log(`deleted ticket ${gone.id} (was "${gone.status}") actor=${me.id}`);
        return [200, { deleted: gone.id, status: gone.status }];
      }
    }

    // A ticket's files (docs/TRACKER_MVP.md, "Attachments"): the list, one
    // upload (the raw file as the body), and one download, always saved.
    if (parts.length === 3 && parts[0] === 'tickets' && parts[2] === 'attachments') {
      if (method === 'GET') {
        const ticket = requireTicket(parts[1]);
        return [200, { ticket: ticket.id, attachments: store.listAttachments(ticket.id) }];
      }
      if (method === 'POST') {
        if (!isUpload(req, url.pathname)) {
          throw new HttpError(415, 'file-only', 'an attachment is sent as the file itself (content-type: application/octet-stream); nothing was saved.');
        }
        let name;
        try {
          name = decodeURIComponent(String(req.headers['x-file-name'] ?? ''));
        } catch {
          throw new HttpError(400, 'bad-name', "the file's name (x-file-name) is not validly encoded; nothing was saved.");
        }
        if (!name.trim()) throw new HttpError(400, 'bad-name', "say the file's name in x-file-name; nothing was saved.");
        const bytes = await readFile(req);
        const ticket = requireTicket(parts[1]);
        const made = store.addAttachment({ ticket: ticket.id, name, type: req.headers['x-file-type'], bytes, actor: me.id });
        log(`attached ${made.name} (${made.size} bytes) to ${ticket.id} actor=${me.id}`);
        return [201, made];
      }
    }
    if (parts.length === 4 && parts[0] === 'tickets' && parts[2] === 'attachments' && method === 'GET') {
      const ticket = requireTicket(parts[1]);
      const file = /^[0-9]+$/.test(parts[3]) ? store.getAttachment(ticket.id, Number(parts[3])) : null;
      if (!file) throw new HttpError(404, 'unknown-attachment', `ticket ${ticket.id} has no attachment ${parts[3]}.`);
      return [200, null, null, {
        'content-type': file.type,
        'content-length': file.bytes.length,
        'content-disposition': downloadDisposition(file.name),
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, no-cache',
        body: file.bytes,
      }];
    }

    if (parts.length === 3 && parts[0] === 'tickets' && parts[2] === 'comments' && method === 'POST') {
      const body = await readJson(req);
      checkBody(body, me, ['body', 'parent']);
      const ticket = requireTicket(parts[1]);
      if (body.parent != null && !Number.isInteger(body.parent)) {
        throw new HttpError(400, 'bad-parent', `parent must be a comment id, not "${body.parent}".`);
      }
      return [201, store.postComment({ ticket: ticket.id, author: me.id, body: body.body, parent: body.parent ?? null }), { ticket: null, changed: [] }];
    }

    // Dane's page: copy a ticket into another project, filed under the
    // caller. The original is left exactly as it was.
    if (parts.length === 3 && parts[0] === 'tickets' && parts[2] === 'clone' && method === 'POST') {
      const body = await readJson(req);
      checkBody(body, me, ['project']);
      const ticket = requireTicket(parts[1]);
      if (typeof body.project !== 'string' || !body.project) {
        throw new HttpError(400, 'bad-field', 'project must name the project to copy into.');
      }
      const copy = store.cloneTicket(ticket.id, { project: body.project, actor: me.id });
      return [201, copy, { ticket: copy, changed: ['status'] }];
    }

    // Dane's page: one ticket with each comment's author named and machine
    // comments marked.
    if (parts.length === 3 && parts[0] === 'tickets' && parts[2] === 'thread' && method === 'GET') {
      const thread = threadOf(store, parts[1]);
      if (!thread) throw new HttpError(404, 'unknown-ticket', `no ticket ${parts[1]}.`);
      return [200, { ...thread, attachments: store.listAttachments(thread.id), mergePhrase, closePhrase, goPhrase, choices: { priorities: PRIORITIES, statuses: PERSON_STATUSES } }];
    }

    if (parts.length === 3 && parts[0] === 'tickets' && parts[2] === 'events' && method === 'GET') {
      const ticket = requireTicket(parts[1]);
      return [200, { ticket: ticket.id, events: store.listEvents(ticket.id) }];
    }

    throw new HttpError(404, 'no-such-call', `no call ${method} ${url.pathname}.`);
  }

  /**
   * The calls made with no token: an emailed link's (the link is the
   * proof), signing in and out, and "Forgot password?". Each takes only a
   * JSON body, so a form on another site cannot make one. Answers
   * `[status, body, headers, after]`, or null for an address that is not
   * one of them; `after` runs once the answer has gone back.
   */
  async function accountRoute(req, url) {
    if (req.method !== 'POST') return null;
    if (!['/account/link', '/account/set-password', '/account/forgot', '/signin', '/signout'].includes(url.pathname)) return null;
    if (!saysJson(req)) throw new HttpError(415, 'json-only', 'this call takes a JSON body (content-type: application/json).');
    if (url.pathname === '/signin') {
      const body = await readJson(req);
      onlyFields(body, ['email', 'password']);
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (!email || typeof body.password !== 'string' || !body.password) {
        throw new HttpError(400, 'missing', 'type your email and your password.');
      }
      if (failures.locked(email)) {
        log('sign-in refused: that email is locked for 15 minutes after 5 failures');
        throw new HttpError(429, 'locked', 'Too many tries for that email. Wait 15 minutes, then try again.');
      }
      const person = store.checkPassword({ email, password: body.password });
      if (!person) {
        if (failures.failed(email)) log('sign-in failed 5 times for one email in 15 minutes; it is locked for 15 minutes');
        throw new HttpError(401, 'no-match', NO_MATCH);
      }
      failures.cleared(email);
      const session = store.startSession(person.id);
      log(`signed in actor=${person.id}`);
      return [200, person, { 'set-cookie': `${SESSION_COOKIE}=${session.token}; ${COOKIE_FLAGS}; Max-Age=${SESSION_MAX_AGE}` }];
    }
    if (url.pathname === '/signout') {
      await readJson(req);
      const ended = store.endSession(sessionToken(req));
      return [200, { signedOut: ended }, { 'set-cookie': `${SESSION_COOKIE}=; ${COOKIE_FLAGS}; Max-Age=0` }];
    }
    if (url.pathname === '/account/forgot') {
      const body = await readJson(req);
      onlyFields(body, ['email']);
      if (typeof body.email !== 'string' || !body.email.trim()) throw new HttpError(400, 'missing', 'type your email.');
      // The email goes out after the answer, so the answer is the same,
      // and as quick, whether or not the email has an account.
      const after = async () => {
        const { line } = await sendResetLink({
          store, email: body.email, send: accountMail?.send ?? null,
          trackerUrl: accountMail?.pageUrl ?? null, projectName: accountMail?.projectName ?? 'tracker',
        });
        log(line);
      };
      return [200, { sent: 'If that email has an account, a link to set a new password is on its way. It works for 1 hour.' }, {}, after];
    }
    if (url.pathname === '/account/link') {
      const body = await readJson(req);
      onlyFields(body, ['link']);
      return [200, store.linkInfo(body.link)];
    }
    if (url.pathname === '/account/set-password') {
      const body = await readJson(req);
      onlyFields(body, ['link', 'password', 'name']);
      const { purpose, actor } = store.useLink({ token: body.link, password: body.password, name: body.name });
      log(`password set through a ${purpose} link actor=${actor.id}`);
      // The link proved the email is theirs, so its failed sign-ins are forgiven.
      const email = store.emailOf(actor.id);
      failures.cleared(email);
      return [200, { purpose, name: actor.name, email }];
    }
    return null;
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://tracker.invalid');
    let me = null;
    let status;
    let wrote = null;
    try {
      const onward = (req.method === 'GET' || req.method === 'HEAD') ? pageRedirect(url.pathname, req.headers.accept) : null;
      if (onward) {
        status = 302;
        res.writeHead(status, { location: onward + url.search, 'cache-control': 'no-store', vary: 'accept', 'content-length': 0 });
        res.end();
        log(`${req.method} ${url.pathname} ${status} -> ${onward}`);
        return;
      }
      const page = (req.method === 'GET' || req.method === 'HEAD') ? pageFile(url.pathname, req.headers.accept) : null;
      if (page) {
        status = 200;
        sendPage(res, page);
        log(`${req.method} ${url.pathname} ${status} page`);
        return;
      }
      const account = await accountRoute(req, url);
      if (account) {
        const [code, body, headers, after] = account;
        status = code;
        send(res, status, body, headers);
        log(`${req.method} ${url.pathname} ${status} actor=-`);
        if (after) await after().catch((err) => log(`error after ${req.method} ${url.pathname}: ${err?.message ?? err}`));
        return;
      }
      // A bearer token when one is sent (every loop); otherwise a person's
      // session cookie, which never stands for a machine.
      const viaCookie = req.headers.authorization == null;
      me = viaCookie ? store.actorForSession(sessionToken(req)) : store.actorForToken(bearerToken(req));
      if (me && viaCookie && me.kind !== 'human') me = null;
      if (!me) throw new HttpError(401, 'unauthorized', 'sign in, or send a valid token.');
      if (viaCookie && req.method !== 'GET' && req.method !== 'HEAD' && !saysJson(req) && !isUpload(req, url.pathname)) {
        throw new HttpError(415, 'json-only', 'a write from the page must say content-type: application/json; nothing was written.');
      }
      const [code, body, write, file] = await route(req, me, url);
      status = code;
      if (file) {
        const { body: bytes, ...headers } = file;
        res.writeHead(code, headers);
        res.end(bytes);
      } else {
        send(res, code, body);
      }
      wrote = write ?? null;
    } catch (err) {
      if (err instanceof HttpError) {
        status = err.status;
        send(res, status, { error: err.code, message: err.message, ...err.extra });
      } else if (err instanceof StoreError) {
        status = NOT_FOUND_CODES.has(err.code) ? 404 : 400;
        send(res, status, { error: err.code, message: err.message });
      } else {
        status = 500;
        send(res, status, { error: 'internal', message: 'the tracker failed; nothing was confirmed written.' });
        log(`error ${req.method} ${url.pathname}: ${err?.message ?? err}`);
      }
    }
    log(`${req.method} ${url.pathname} ${status} actor=${me ? me.id : '-'}`);
    if (wrote && notifier) await notifier.afterWrite(wrote.ticket, wrote.changed);
  };
}

/** Start a server on `port` (0 = any free port) against an open store. Resolves to the http.Server. */
export function startServer({ store, port, host = '127.0.0.1', log, notifier, defaultProject, mergePhrase, closePhrase, goPhrase, accountMail, setup, now }) {
  const server = createServer(createHandler(store, { log, notifier, defaultProject, mergePhrase, closePhrase, goPhrase, accountMail, setup, now }));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

/** The settings a server run needs, read from the environment; a missing one is an error. */
export function settingsFromEnv(env = process.env) {
  const missing = ['TRACKER_DB', 'TRACKER_PORT'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`set ${missing.join(' and ')} to run the tracker server.`);
  const port = Number(env.TRACKER_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`TRACKER_PORT must be a port number, not "${env.TRACKER_PORT}".`);
  }
  const host = env.TRACKER_HOST || '127.0.0.1';
  return { db: env.TRACKER_DB, port, host };
}

/**
 * The tracker's address as Dane opens it, for the link in an email: the
 * project config's trackerUrl, or else this machine by name on the
 * configured port (a server listening on every address is reached by the
 * machine's name, not 0.0.0.0).
 */
export function pageUrlOf({ trackerUrl, host, port }) {
  if (trackerUrl) return trackerUrl;
  const name = host === '0.0.0.0' || host === '::' ? hostname() : host;
  return `http://${name}:${port}`;
}

/**
 * The tracker's address everyone opens, for an emailed reset link: the
 * project config FILE's trackerUrl, never Doppler's same-machine TRACKER_URL
 * override (127.0.0.1 on the Mini), which would not open from anyone else's
 * computer; or else this machine by name.
 */
function sharedPageUrl({ host, port }) {
  let trackerUrl = null;
  try { trackerUrl = loadProjectConfig({ env: { ...process.env, TRACKER_URL: '' } }).trackerUrl; } catch { /* by name below */ }
  return pageUrlOf({ trackerUrl, host, port });
}

/** The reset email's sender: Resend with the key alone (it goes to the person who asked, not to TRACKER_NOTIFY_TO). */
function accountMailOf(env, pageUrl) {
  return { send: env[MAIL_KEY] ? resendSender({ apiKey: env[MAIL_KEY], from: env[MAIL_FROM] || DEFAULT_FROM }) : null, pageUrl };
}

/**
 * The hand-over email's settings, and the reset email's as `account`.
 * launchd starts the server without Doppler, so the mail names are read
 * from the project's Doppler config here; any failure leaves the email
 * off, said in the log, and never stops the server.
 */
export async function loadMailSettings({ host, port, log = () => {} }) {
  if (process.env[MAIL_KEY]) {
    return { ...mailSettingsFromEnv(process.env, { pageUrl: pageUrlOf({ host, port }) }), account: accountMailOf(process.env, sharedPageUrl({ host, port })) };
  }
  let config;
  try {
    config = loadProjectConfig();
  } catch (err) {
    return { send: null, why: `the project config is not usable (${err.message}), so the hand-over email is off.`, account: null };
  }
  const { env, error } = await mailEnvFromDoppler({
    project: config.dopplerProject, config: config.dopplerConfig, run: promisify(execFile),
  });
  if (error) return { send: null, why: `${error}, so the hand-over email is off.`, account: null };
  const pageUrl = pageUrlOf({ trackerUrl: config.trackerUrl, host, port });
  const mail = mailSettingsFromEnv(env, { pageUrl });
  if (mail.send) log(`hand-over email: on, through Resend, linking to ${pageUrl}.`);
  return { ...mail, account: accountMailOf(env, sharedPageUrl({ host, port })) };
}

/**
 * What the "Set up a project" calls read: the settings file in the folder
 * this server runs from (it must be the tracker home's, the one that sets
 * trackerPort), that folder, and the database it opened. The answers file's
 * default checkout folder sits beside `homeRoot`, the tracker home's folder,
 * which is this one. Null, with why, when the settings file does not do.
 */
export function setupSettingsOf({ db, folder = fileURLToPath(new URL('..', import.meta.url)) }) {
  const root = folder.replace(/\/+$/, '');
  const file = findConfigFile(root);
  if (!file) return { setup: null, why: `no settings file in ${root}` };
  let homeConfig;
  try { homeConfig = loadProjectConfig({ file, env: {} }); } catch (err) {
    return { setup: null, why: err.message };
  }
  if (homeConfig.trackerPort == null) return { setup: null, why: `${file} does not set "trackerPort", so it is not the tracker home's` };
  return { setup: { homeConfig, homeRoot: root, folder: root, trackerDb: db }, why: null };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { db, port, host } = settingsFromEnv();
    const store = openStore(db);
    const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
    const mail = await loadMailSettings({ host, port, log });
    if (!mail.send) log(`hand-over email: off. ${mail.why}`);
    const text = textSettings({ run: promisify(execFile) });
    // The text's link opens on his phone: always the shared address, never this machine's own 127.0.0.1.
    const textPageUrl = sharedPageUrl({ host, port });
    log(text.sendText
      ? `hand-over text: on, through Messages on this Mac, to each project's alert phone, linking to ${textPageUrl}.`
      : `hand-over text: off. ${text.why}`);
    const notifier = mail.send || text.sendText
      ? createNotifier({ store, send: mail.send, to: mail.to, pageUrl: mail.pageUrl ?? textPageUrl, sendText: text.sendText, textPageUrl, log })
      : null;
    log(mail.account?.send ? `reset email: on, through Resend, linking to ${mail.account.pageUrl}.` : `reset email: off. ${MAIL_KEY} could not be read, so "Forgot password?" sends nothing.`);
    let defaultProject = null;
    let mergePhrase = null;
    try {
      const config = loadProjectConfig();
      defaultProject = config.projectSlug;
      mergePhrase = config.mergePhrases[0] ?? null;
    } catch (err) {
      log(`the New request form starts on the first project and the ticket page has no Merge button: the project config is not usable (${err.message}).`);
    }
    const accountMail = mail.account && { ...mail.account, projectName: store.getProject(defaultProject)?.name ?? 'tracker' };
    const { setup, why: noSetup } = setupSettingsOf({ db: resolve(db) });
    log(setup ? `set up a project: on, reading ${setup.homeConfig.logDir}/onboard.` : `set up a project: off. ${noSetup}.`);
    const server = await startServer({ store, port, host, log, notifier, defaultProject, mergePhrase, closePhrase: CLOSE_PHRASE, goPhrase: GO_PHRASE, accountMail, setup });
    console.log(`tracker listening on http://${host}:${server.address().port}/`);
  } catch (err) {
    console.error(`tracker server did not start: ${err.message}`);
    process.exit(1);
  }
}
