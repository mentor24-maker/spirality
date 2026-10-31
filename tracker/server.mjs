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
 *   404  an unknown project, ticket or address
 *   409  a guarded move found the ticket moved: `{ error, status, version }`
 *   400  a bad field, or a body that names another author
 * A refused write writes nothing. A token never appears in an answer or a
 * log line: the log names the actor id, never the header.
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
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStore, StoreError } from './store.mjs';
import { boardOf, projectDetailsOf, projectsList, threadOf, waitingFor } from './pageData.mjs';
import { createNotifier, MAIL_KEY, mailEnvFromDoppler, mailSettingsFromEnv } from './notify.mjs';
import { loadProjectConfig } from '../lib/projectConfig.mjs';

/** The largest request body accepted, in bytes. A ticket description fits easily. */
const MAX_BODY = 1024 * 1024;

/** Store refusals that mean "no such thing", answered 404 rather than 400. */
const NOT_FOUND_CODES = new Set(['unknown-ticket', 'unknown-project']);

/** The fields a new ticket may carry. */
const FILE_FIELDS = Object.freeze(['name', 'description', 'status', 'priority', 'tags', 'assignee', 'loopNote']);

/** The fields a change may carry, besides its guards. */
const CHANGE_FIELDS = Object.freeze(['name', 'description', 'status', 'priority', 'tags', 'assignee', 'loopNote']);

/**
 * Dane's page (tracker/web/): the only files served without a token, and the
 * only ones served at all, by name. The page holds no data; everything it
 * shows comes through the API below with his token. `/`, `/t/<id>`, `/board`,
 * `/board/<project>`, `/list`, `/list/<project>` and `/new` (the New request
 * form) all answer the page itself, so each address opens its own view;
 * `/projects` and `/projects/<project>` do too, for a browser opening them.
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
 * The page may run only its own scripts and talk only to this server. With
 * every ticket's text escaped before it is drawn, this is the second lock: an
 * injected script would not run even if escaping ever missed one.
 */
const PAGE_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-cache',
});

/**
 * The page file a GET of `pathname` answers with, or null when it is not a
 * page address. `/projects` is both the Projects screen and the call that
 * lists them, and `/projects/<project>` both a project's details page and
 * the call that reads them: a browser opening the address asks for HTML and
 * gets the page; the page's own call asks for anything and gets the data.
 */
function pageFile(pathname, accept = '') {
  if (/^\/projects(?:\/[^/]+)?$/.test(pathname)) return /\btext\/html\b/.test(accept) ? 'index.html' : null;
  if (pathname === '/' || /^\/(?:tasks|board|list|new)$/.test(pathname) || /^\/(?:t|board|list)\/[^/]+$/.test(pathname)) return 'index.html';
  const m = /^\/web\/([^/]+)$/.exec(pathname);
  return m && Object.hasOwn(WEB_FILES, m[1]) ? m[1] : null;
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

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function bearerToken(req) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
  return m ? m[1] : null;
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
 * config's productSlug, never a literal here. One the store does not hold
 * is answered as null, and the page falls back to the first project.
 */
export function createHandler(store, { log = () => {}, notifier = null, defaultProject = null } = {}) {
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

    // Dane's page: one project's details page.
    if (parts.length === 2 && parts[0] === 'projects' && method === 'GET') {
      const details = projectDetailsOf(store, parts[1]);
      if (!details) throw new HttpError(404, 'unknown-project', `no project "${parts[1]}".`);
      return [200, details];
    }

    // Dane's page: one project's board, the eight statuses in the contract's
    // order, each column in `queue` order.
    if (parts.length === 3 && parts[0] === 'projects' && parts[2] === 'board' && method === 'GET') {
      const board = boardOf(store, parts[1]);
      if (!board) throw new HttpError(404, 'unknown-project', `no project "${parts[1]}".`);
      return [200, board];
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

    // Dane's page: one ticket with each comment's author named and machine
    // comments marked.
    if (parts.length === 3 && parts[0] === 'tickets' && parts[2] === 'thread' && method === 'GET') {
      const thread = threadOf(store, parts[1]);
      if (!thread) throw new HttpError(404, 'unknown-ticket', `no ticket ${parts[1]}.`);
      return [200, thread];
    }

    if (parts.length === 3 && parts[0] === 'tickets' && parts[2] === 'events' && method === 'GET') {
      const ticket = requireTicket(parts[1]);
      return [200, { ticket: ticket.id, events: store.listEvents(ticket.id) }];
    }

    throw new HttpError(404, 'no-such-call', `no call ${method} ${url.pathname}.`);
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://tracker.invalid');
    let me = null;
    let status;
    let wrote = null;
    try {
      const page = (req.method === 'GET' || req.method === 'HEAD') ? pageFile(url.pathname, req.headers.accept) : null;
      if (page) {
        status = 200;
        sendPage(res, page);
        log(`${req.method} ${url.pathname} ${status} page`);
        return;
      }
      me = store.actorForToken(bearerToken(req));
      if (!me) throw new HttpError(401, 'unauthorized', 'a valid token is required.');
      const [code, body, write] = await route(req, me, url);
      status = code;
      send(res, code, body);
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
export function startServer({ store, port, host = '127.0.0.1', log, notifier, defaultProject }) {
  const server = createServer(createHandler(store, { log, notifier, defaultProject }));
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
 * The hand-over email's settings. launchd starts the server without Doppler,
 * so the mail names are read from the project's Doppler config here; any
 * failure leaves the email off, said in the log, and never stops the server.
 */
export async function loadMailSettings({ host, port, log = () => {} }) {
  if (process.env[MAIL_KEY]) return mailSettingsFromEnv(process.env, { pageUrl: pageUrlOf({ host, port }) });
  let config;
  try {
    config = loadProjectConfig();
  } catch (err) {
    return { send: null, why: `the project config is not usable (${err.message}), so the hand-over email is off.` };
  }
  const { env, error } = await mailEnvFromDoppler({
    project: config.dopplerProject, config: config.dopplerConfig, run: promisify(execFile),
  });
  if (error) return { send: null, why: `${error}, so the hand-over email is off.` };
  const pageUrl = pageUrlOf({ trackerUrl: config.trackerUrl, host, port });
  const mail = mailSettingsFromEnv(env, { pageUrl });
  if (mail.send) log(`hand-over email: on, through Resend, linking to ${pageUrl}.`);
  return mail;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { db, port, host } = settingsFromEnv();
    const store = openStore(db);
    const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
    const mail = await loadMailSettings({ host, port, log });
    const notifier = mail.send ? createNotifier({ store, ...mail, log }) : null;
    if (!notifier) log(`hand-over email: off. ${mail.why}`);
    let defaultProject = null;
    try {
      defaultProject = loadProjectConfig().productSlug;
    } catch (err) {
      log(`the New request form starts on the first project: the project config is not usable (${err.message}).`);
    }
    const server = await startServer({ store, port, host, log, notifier, defaultProject });
    console.log(`tracker listening on http://${host}:${server.address().port}/`);
  } catch (err) {
    console.error(`tracker server did not start: ${err.message}`);
    process.exit(1);
  }
}
