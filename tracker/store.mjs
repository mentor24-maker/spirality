/**
 * The tracker's store: the database that will hold tickets and comments once the loop
 * leaves ClickUp. Design: docs/TRACKER_MVP.md, "The data".
 *
 * Plain Node, no outside packages: the built-in `node:sqlite` (SQLite, a
 * database kept in one ordinary file). Nothing reads this yet; the API, the
 * page are later tickets; the importer (tracker/import.mjs) fills it.
 *
 * What the store enforces, and only this (the contract's own rules stay in
 * the package modules and the door):
 *
 *  - Statuses are exactly the eight in lib/loopStatuses.js. Anything else is
 *    refused, never stored.
 *  - A change may carry `ifStatus` and/or `ifVersion`. The comparison and the
 *    write happen inside ONE transaction that holds the write lock from its
 *    first read, so two claims of one ticket cannot both pass the check. The
 *    loser writes nothing and gets a "moved" refusal naming the current
 *    status and version. This is the atomic claim ClickUp never had: there
 *    the read and the write were two requests, with a gap between them.
 *  - `version` goes up by one on every change, and every changed field
 *    writes one `events` row in the same transaction. Callers never write
 *    events.
 *  - Comments are append-only. No function edits or deletes one, so the
 *    trail the loop reads can never shift under it. The one exception is
 *    deleteTicket: an unstarted ticket goes with its comments and events.
 *  - A ticket is never deleted once started. deleteTicket removes only a
 *    `Requested` or `Queued` one, checking the status inside the same
 *    transaction as the delete, so a claim at that moment either wins (the
 *    delete is refused) or loses (it finds no ticket), never half of each.
 *  - Ticket ids are the project's own prefix plus a number (`<PREFIX>-1`). The
 *    prefix lives on the project row; nothing here knows any product.
 *  - Imports (tracker/import.mjs, and nothing else) file a ticket or post a
 *    comment with its ORIGINAL time, and record the old id beside the new one
 *    in `imported_ids` in the same transaction. A ticket can therefore never
 *    exist without its map row, so a re-run cannot file it twice.
 *  - An actor's sign-in token is stored only as its SHA-256 hash. The token
 *    itself is handed back once, by issueToken, and never kept.
 *  - A project's owner is a person (a `human` actor), apart from its
 *    operator, who the loops hand tickets to. Its web address and logo are
 *    http(s) addresses, or nothing.
 *  - A project's slug and ticket prefix never change once it is made: every
 *    ticket's id and its project link are built from them. updateProject
 *    changes its name, web address, logo and owner, nothing else.
 *  - A project is deleted only while it holds no tickets. deleteProject
 *    counts them inside the same transaction as the delete, so a ticket
 *    filed at that moment either lands first (the delete is refused) or
 *    finds no project, never a ticket left without one.
 *  - A stage's colour (the Settings page's pickers) is one of the eight
 *    statuses and a `#rrggbb` value, or no row at all. One set for the whole
 *    tracker, not one per project.
 *  - A person's account is an email (unique, kept lower-case) and a password
 *    of at least 12 characters, stored only as a salted scrypt hash. A
 *    machine never holds an email, a password or a session: the loops keep
 *    their tokens.
 *  - A session token and an emailed link's token are stored only as their
 *    SHA-256 hash, like a sign-in token. Each is handed back once, by
 *    startSession or makeLink. A session lasts 30 days; a setup or invite
 *    link 7 days, a reset link 1 hour. A link is used once: the check and
 *    the use are one transaction, so two uses racing cannot both pass.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import loopStatuses from '../lib/loopStatuses.js';

const { DISPLAY, TERMINAL_STATUSES, PRIORITY_RANK, statusOf } = loopStatuses;

/** The eight statuses, lower-cased, as the store keeps them. */
const STATUSES = Object.freeze(Object.keys(DISPLAY));
const PRIORITIES = Object.freeze(Object.keys(PRIORITY_RANK));
const ACTOR_KINDS = Object.freeze(['human', 'machine']);
const IMPORT_KINDS = Object.freeze(['ticket', 'comment', 'actor']);

/** How long a session lasts, and each kind of emailed link, in milliseconds. */
const HOUR = 60 * 60 * 1000;
const SESSION_LIFETIME = 30 * 24 * HOUR;
const LINK_LIFETIME = Object.freeze({ setup: 7 * 24 * HOUR, invite: 7 * 24 * HOUR, reset: HOUR });
const LINK_PURPOSES = Object.freeze(Object.keys(LINK_LIFETIME));
const MIN_PASSWORD = 12;

/** The statuses a ticket may be deleted from: nobody has started it yet. */
const DELETABLE = Object.freeze(['requested', 'queued']);

/** The ticket fields a change may touch, and their column names. */
const CHANGEABLE = Object.freeze({
  name: 'name',
  description: 'description',
  status: 'status',
  priority: 'priority',
  tags: 'tags',
  assignee: 'assignee',
  loopNote: 'loop_note',
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS actors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('human', 'machine')),
  name        TEXT NOT NULL,
  token_hash  TEXT,
  email       TEXT,
  password_hash TEXT
);
CREATE TABLE IF NOT EXISTS projects (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  prefix      TEXT NOT NULL UNIQUE,
  operator    INTEGER REFERENCES actors(id),
  next_number INTEGER NOT NULL DEFAULT 1,
  url         TEXT,
  logo        TEXT,
  owner       INTEGER REFERENCES actors(id)
);
CREATE TABLE IF NOT EXISTS tickets (
  id          TEXT PRIMARY KEY,
  project     TEXT NOT NULL REFERENCES projects(slug),
  number      INTEGER NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL,
  priority    TEXT,
  tags        TEXT NOT NULL DEFAULT '[]',
  assignee    INTEGER REFERENCES actors(id),
  loop_note   TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (project, number)
);
CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket      TEXT NOT NULL REFERENCES tickets(id),
  parent      INTEGER REFERENCES comments(id),
  author      INTEGER NOT NULL REFERENCES actors(id),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket      TEXT NOT NULL REFERENCES tickets(id),
  actor       INTEGER NOT NULL REFERENCES actors(id),
  field       TEXT NOT NULL,
  from_value  TEXT,
  to_value    TEXT,
  at          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS imported_ids (
  source      TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('ticket', 'comment', 'actor')),
  source_id   TEXT NOT NULL,
  new_id      TEXT NOT NULL,
  PRIMARY KEY (source, kind, source_id)
);
CREATE TABLE IF NOT EXISTS stage_colours (
  status      TEXT PRIMARY KEY,
  colour      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  actor       INTEGER NOT NULL REFERENCES actors(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_links (
  token_hash  TEXT PRIMARY KEY,
  purpose     TEXT NOT NULL CHECK (purpose IN ('setup', 'invite', 'reset')),
  email       TEXT NOT NULL,
  actor       INTEGER REFERENCES actors(id),
  made_by     INTEGER NOT NULL REFERENCES actors(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS actors_by_token ON actors (token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS actors_by_email ON actors (email);
CREATE INDEX IF NOT EXISTS sessions_by_actor ON sessions (actor);
CREATE INDEX IF NOT EXISTS tickets_by_project ON tickets (project, status);
CREATE INDEX IF NOT EXISTS comments_by_ticket ON comments (ticket, id);
CREATE INDEX IF NOT EXISTS events_by_ticket ON events (ticket, id);
`;

/** A refusal or a bad input, with a `code` a caller can branch on. */
export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

/** The one spelling of a status the store keeps, or a thrown refusal. */
function canonicalStatus(status) {
  const s = statusOf(String(status ?? ''));
  if (!STATUSES.includes(s)) {
    throw new StoreError('unknown-status', `"${status}" is not one of the eight statuses: ${Object.values(DISPLAY).join(', ')}.`);
  }
  return s;
}

/** A stage colour as the store keeps it: `#rrggbb`, lower-cased; null clears it. */
function canonicalColour(colour, status) {
  if (colour === null) return null;
  if (typeof colour !== 'string' || !/^#[0-9a-f]{6}$/i.test(colour)) {
    throw new StoreError('bad-colour', `the colour for ${DISPLAY[status]} must be #rrggbb (like #2b9cf2), not "${colour}".`);
  }
  return colour.toLowerCase();
}

function canonicalPriority(priority) {
  if (priority == null) return null;
  const p = String(priority).trim().toLowerCase();
  if (!PRIORITIES.includes(p)) {
    throw new StoreError('unknown-priority', `"${priority}" is not a priority: ${PRIORITIES.join(', ')}.`);
  }
  return p;
}

function canonicalTags(tags) {
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
    throw new StoreError('bad-tags', 'tags must be an array of strings.');
  }
  return JSON.stringify(tags);
}

/** An original timestamp handed to an import: a valid date, kept as ISO text. */
function requireTime(value, what) {
  const d = new Date(value);
  if (value == null || value === '' || Number.isNaN(d.getTime())) {
    throw new StoreError('bad-time', `${what} must be a date, not "${value}".`);
  }
  return d.toISOString();
}

function requireImportKey(source, kind, sourceId) {
  requireText(source, "an import's source");
  if (!IMPORT_KINDS.includes(kind)) {
    throw new StoreError('bad-import', `an imported id's kind is ${IMPORT_KINDS.join(', ')}, not "${kind}".`);
  }
  requireText(sourceId == null ? sourceId : String(sourceId), "an import's source id");
  return [source, kind, String(sourceId)];
}

function requireText(value, what) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new StoreError('missing', `${what} is required.`);
  }
  return value;
}

/** A token's SHA-256, as hex: the only form a token is ever stored in. */
function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** An email as the store keeps it: trimmed and lower-cased, or a thrown refusal. */
function canonicalEmail(email) {
  const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    throw new StoreError('bad-email', `"${email}" is not an email address.`);
  }
  return e;
}

function requirePassword(password) {
  if (typeof password !== 'string' || [...password].length < MIN_PASSWORD) {
    throw new StoreError('weak-password', `a password must be at least ${MIN_PASSWORD} characters.`);
  }
  return password;
}

/** scrypt's settings, kept in the stored hash so they can rise later without breaking old ones. */
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, length: 64 });

/** A password as it is stored: `scrypt$N$r$p$<salt>$<hash>`, a fresh random salt each time. */
function hashPassword(password) {
  const salt = randomBytes(16);
  const { N, r, p, length } = SCRYPT;
  const hash = scryptSync(password, salt, length, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

/** Whether `password` matches a stored hash, compared in constant time. */
function passwordMatches(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const actual = scryptSync(String(password), Buffer.from(salt, 'base64url'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return timingSafeEqual(actual, expected);
}

/** A stored hash nobody's password matches: checked against for an unknown email, so it takes as long as a known one. */
const NOBODY = hashPassword(randomBytes(32).toString('base64url'));

/** SQLite hands integers back as numbers; keep ids plain numbers. */
const num = (v) => (v == null ? null : Number(v));

/** The project fields updateProject may change; the slug and prefix never do. */
const PROJECT_CHANGEABLE = Object.freeze(['name', 'url', 'logo', 'owner']);

/** The columns an actor gained after the first databases were made. */
const LATER_ACTOR_COLUMNS = Object.freeze({ token_hash: 'TEXT', email: 'TEXT', password_hash: 'TEXT' });

/** The columns a project gained after the first databases were made, and their types. */
const LATER_PROJECT_COLUMNS = Object.freeze({ url: 'TEXT', logo: 'TEXT', owner: 'INTEGER REFERENCES actors(id)' });

/** An optional web address: null for none, an http(s) address, or a thrown refusal. */
function optionalAddress(value, what) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    try {
      const u = new URL(value);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && value === value.trim()) return value;
    } catch { /* refused below */ }
  }
  throw new StoreError('bad-address', `${what} must be a web address starting http:// or https://, not "${value}".`);
}

function projectFromRow(row) {
  if (!row) return null;
  return {
    slug: row.slug, name: row.name, prefix: row.prefix, operator: num(row.operator),
    url: row.url, logo: row.logo, owner: num(row.owner),
  };
}

function ticketFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    project: row.project,
    number: num(row.number),
    name: row.name,
    description: row.description,
    status: row.status,
    priority: row.priority,
    tags: JSON.parse(row.tags),
    assignee: num(row.assignee),
    loopNote: row.loop_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: num(row.version),
  };
}

function commentFromRow(row) {
  return {
    id: num(row.id),
    ticket: row.ticket,
    parent: num(row.parent),
    author: num(row.author),
    body: row.body,
    createdAt: row.created_at,
  };
}

function eventFromRow(row) {
  return {
    id: num(row.id),
    ticket: row.ticket,
    actor: num(row.actor),
    field: row.field,
    from: row.from_value,
    to: row.to_value,
    at: row.at,
  };
}

/** How a field's value is written into an event row: text, or null. */
function eventValue(column, value) {
  if (value == null) return null;
  return column === 'tags' ? value : String(value);
}

/**
 * Open (or create) the store at `path`. `now` is the clock, replaceable in
 * tests; it returns an ISO time string.
 */
export function openStore(path, { now = () => new Date().toISOString() } = {}) {
  requireText(path, 'the database path');
  const db = new DatabaseSync(path);
  // Wait for another writer's lock rather than failing at once: a second
  // claimant blocks until the first commits, then sees the moved ticket.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  // A database made before actors had tokens, emails and passwords gains the
  // columns, empty; the unique indexes in SCHEMA need them, so this runs first.
  const hasActors = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'actors'").get();
  if (hasActors) {
    const actorColumns = new Set(db.prepare('PRAGMA table_info(actors)').all().map((c) => c.name));
    for (const [column, type] of Object.entries(LATER_ACTOR_COLUMNS)) {
      if (!actorColumns.has(column)) db.exec(`ALTER TABLE actors ADD COLUMN ${column} ${type}`);
    }
  }
  db.exec(SCHEMA);
  // A database made before projects had a web address, a logo and an owner
  // gains the columns, empty; every existing row is otherwise untouched.
  const projectColumns = new Set(db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name));
  for (const [column, type] of Object.entries(LATER_PROJECT_COLUMNS)) {
    if (!projectColumns.has(column)) db.exec(`ALTER TABLE projects ADD COLUMN ${column} ${type}`);
  }

  /**
   * Run `fn` inside one transaction. IMMEDIATE takes the write lock before
   * the first read, so a compare-then-write can never interleave with
   * another connection's. Anything thrown rolls the whole thing back.
   * SQLite may already have rolled back by itself (disk full, I/O error);
   * then ROLLBACK fails with "no transaction is active", and the caller
   * must still see the real error, not that one.
   */
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // already rolled back; the original error is the one that matters
      }
      throw err;
    }
  }

  function actorExists(id) {
    return Boolean(db.prepare('SELECT 1 FROM actors WHERE id = ?').get(id));
  }

  function requireActor(id, what) {
    if (!Number.isInteger(id) || !actorExists(id)) {
      throw new StoreError('unknown-actor', `${what} ${id} is not a known actor.`);
    }
    return id;
  }

  /** A person's id, or a thrown refusal: unknown, or a machine. */
  function requirePerson(id, what) {
    requireActor(id, what);
    const row = db.prepare('SELECT kind FROM actors WHERE id = ?').get(id);
    if (row.kind !== 'human') {
      throw new StoreError('machine-account', `${what} ${id} is a machine; a machine never holds an email, a password or a session.`);
    }
    return id;
  }

  /** `now()` plus `ms`, as ISO text. */
  function later(ms) {
    return new Date(new Date(now()).getTime() + ms).toISOString();
  }

  /** Whether an ISO time has passed by the store's clock. */
  function passed(at) {
    return new Date(at).getTime() <= new Date(now()).getTime();
  }

  /** Set a person's email; inside or outside a transaction. Refuses one another person holds. */
  function writeEmail(actorId, email) {
    const holder = db.prepare('SELECT id FROM actors WHERE email = ?').get(email);
    if (holder && num(holder.id) !== actorId) {
      throw new StoreError('duplicate-email', `${email} already belongs to another person.`);
    }
    const r = db.prepare('UPDATE actors SET email = ? WHERE id = ?').run(email, actorId);
    if (num(r.changes) !== 1 || db.prepare('SELECT email FROM actors WHERE id = ?').get(actorId).email !== email) {
      throw new StoreError('write-failed', `actor ${actorId}'s email did not read back.`);
    }
  }

  /** Set a person's password (already checked for length); read back by matching it. */
  function writePassword(actorId, password) {
    const r = db.prepare('UPDATE actors SET password_hash = ? WHERE id = ?').run(hashPassword(password), actorId);
    const stored = db.prepare('SELECT password_hash FROM actors WHERE id = ?').get(actorId)?.password_hash;
    if (num(r.changes) !== 1 || !passwordMatches(password, stored)) {
      throw new StoreError('write-failed', `actor ${actorId}'s password did not read back.`);
    }
  }

  function endSessionsOf(actorId) {
    return num(db.prepare('DELETE FROM sessions WHERE actor = ?').run(actorId).changes);
  }

  function ticketRow(id) {
    return db.prepare('SELECT * FROM tickets WHERE id = ?').get(String(id));
  }

  function requireTicketRow(id) {
    const row = ticketRow(id);
    if (!row) throw new StoreError('unknown-ticket', `no ticket ${id}.`);
    return row;
  }

  function writeEvent(ticket, actor, field, from, to, at) {
    db.prepare(
      'INSERT INTO events (ticket, actor, field, from_value, to_value, at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(ticket, actor, field, from, to, at);
  }

  /** A new ticket's fields, checked before any transaction opens. */
  function checkNewTicket({ project, actor, name, description = '', status, priority = null, tags = [], assignee = null, loopNote = '' }) {
    requireText(name, "a ticket's name");
    return {
      project, actor, name, description: String(description), status: canonicalStatus(status),
      priority: canonicalPriority(priority), tags: canonicalTags(tags), assignee, loopNote: String(loopNote),
    };
  }

  /** Insert a checked ticket at `at`; call inside a transaction. */
  function insertTicket(t, at, updatedAt) {
    requireActor(t.actor, 'the filer');
    if (t.assignee != null) requireActor(t.assignee, 'the assignee');
    const proj = db.prepare('SELECT prefix, next_number FROM projects WHERE slug = ?').get(t.project);
    if (!proj) throw new StoreError('unknown-project', `no project "${t.project}".`);
    const number = num(proj.next_number);
    const id = `${proj.prefix}-${number}`;
    db.prepare('UPDATE projects SET next_number = ? WHERE slug = ?').run(number + 1, t.project);
    db.prepare(
      `INSERT INTO tickets (id, project, number, name, description, status, priority, tags, assignee, loop_note, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(id, t.project, number, t.name, t.description, t.status, t.priority, t.tags, t.assignee, t.loopNote, at, updatedAt ?? at);
    writeEvent(id, t.actor, 'created', null, t.status, at);
    return ticketFromRow(ticketRow(id));
  }

  /** Insert a comment at `at`; call inside a transaction. */
  function insertComment({ ticket, author, body, parent }, at) {
    requireActor(author, 'the author');
    const row = requireTicketRow(ticket);
    if (parent != null) {
      const p = db.prepare('SELECT ticket FROM comments WHERE id = ?').get(parent);
      if (!p || p.ticket !== row.id) {
        throw new StoreError('bad-parent', `comment ${parent} is not on ticket ${row.id}.`);
      }
    }
    const r = db.prepare('INSERT INTO comments (ticket, parent, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, parent, author, body, at);
    return commentFromRow(db.prepare('SELECT * FROM comments WHERE id = ?').get(r.lastInsertRowid));
  }

  function importedRow(source, kind, sourceId) {
    const row = db.prepare('SELECT new_id FROM imported_ids WHERE source = ? AND kind = ? AND source_id = ?')
      .get(source, kind, sourceId);
    return row ? row.new_id : null;
  }

  function refuseIfImported(source, kind, sourceId) {
    if (importedRow(source, kind, sourceId) != null) {
      throw new StoreError('already-imported', `${source} ${kind} ${sourceId} is already imported.`);
    }
  }

  /** Record a map row; refuses if this old id already maps somewhere. Inside a transaction. */
  function recordImport(source, kind, sourceId, newId) {
    refuseIfImported(source, kind, sourceId);
    db.prepare('INSERT INTO imported_ids (source, kind, source_id, new_id) VALUES (?, ?, ?, ?)')
      .run(source, kind, sourceId, String(newId));
  }

  return {
    /** A person or a machine that acts on tickets. */
    createActor({ kind, name }) {
      if (!ACTOR_KINDS.includes(kind)) {
        throw new StoreError('bad-actor', `an actor's kind is ${ACTOR_KINDS.join(' or ')}, not "${kind}".`);
      }
      requireText(name, "an actor's name");
      const r = db.prepare('INSERT INTO actors (kind, name) VALUES (?, ?)').run(kind, name);
      return { id: num(r.lastInsertRowid), kind, name };
    },

    getActor(id) {
      const row = db.prepare('SELECT * FROM actors WHERE id = ?').get(id);
      return row ? { id: num(row.id), kind: row.kind, name: row.name } : null;
    },

    /** Every actor of this kind with this name, oldest first. */
    actorsNamed({ kind, name }) {
      return db.prepare('SELECT id FROM actors WHERE kind = ? AND name = ? ORDER BY id').all(kind, name)
        .map((row) => this.getActor(num(row.id)));
    },

    /**
     * Give an actor a new sign-in token, replacing any old one. The token is
     * returned here and nowhere else: only its hash is stored.
     */
    issueToken(actorId) {
      requireActor(actorId, 'the actor');
      const token = randomBytes(32).toString('base64url');
      const r = db.prepare('UPDATE actors SET token_hash = ? WHERE id = ?').run(hashToken(token), actorId);
      if (num(r.changes) !== 1) throw new StoreError('write-failed', `actor ${actorId} was not given a token.`);
      if (this.actorForToken(token)?.id !== actorId) {
        throw new StoreError('write-failed', `actor ${actorId}'s token did not read back.`);
      }
      return token;
    },

    /**
     * Stop an actor signing in: its token, if any, no longer finds it. For a
     * token that was issued but must not be used (tracker/signins.mjs).
     */
    revokeToken(actorId) {
      requireActor(actorId, 'the actor');
      const r = db.prepare('UPDATE actors SET token_hash = NULL WHERE id = ?').run(actorId);
      if (num(r.changes) !== 1) throw new StoreError('write-failed', `actor ${actorId}'s token was not revoked.`);
    },

    /** The actor a token belongs to, or null for a missing or unknown token. */
    actorForToken(token) {
      if (typeof token !== 'string' || !token) return null;
      const row = db.prepare('SELECT id FROM actors WHERE token_hash = ?').get(hashToken(token));
      return row ? this.getActor(num(row.id)) : null;
    },

    /**
     * Set a person's email: trimmed, lower-cased, unique whatever its case.
     * A machine is refused (`machine-account`), an email another person
     * holds is refused (`duplicate-email`). Read back.
     */
    setEmail(actorId, email) {
      const e = canonicalEmail(email);
      requirePerson(actorId, 'the actor');
      transaction(() => writeEmail(actorId, e));
      return e;
    },

    /** A person's email, or null if they have none. */
    emailOf(actorId) {
      return db.prepare("SELECT email FROM actors WHERE id = ? AND kind = 'human'").get(actorId)?.email ?? null;
    },

    /** The person an email belongs to, in any case, or null. */
    actorForEmail(email) {
      if (typeof email !== 'string') return null;
      const row = db.prepare("SELECT id FROM actors WHERE email = ? AND kind = 'human'").get(email.trim().toLowerCase());
      return row ? this.getActor(num(row.id)) : null;
    },

    /**
     * Set a person's password: at least 12 characters (`weak-password`),
     * stored only as a salted scrypt hash. A machine is refused. Read back.
     */
    setPassword(actorId, password) {
      requirePassword(password);
      requirePerson(actorId, 'the actor');
      writePassword(actorId, password);
    },

    /**
     * The person this email and password belong to, or null for a wrong
     * password, an unknown email or a person with no password yet. Never says
     * which: an unknown email takes as long to refuse as a wrong password.
     */
    checkPassword({ email, password }) {
      const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
      const row = db.prepare("SELECT id, password_hash FROM actors WHERE email = ? AND kind = 'human'").get(e);
      const matches = passwordMatches(typeof password === 'string' ? password : '', row?.password_hash ?? NOBODY);
      return row?.password_hash && matches ? this.getActor(num(row.id)) : null;
    },

    /**
     * Start a 30-day session for a person. Answers `{ token, expiresAt }`;
     * the token is returned here and nowhere else, only its hash is stored.
     * A machine is refused.
     */
    startSession(actorId) {
      requirePerson(actorId, 'the actor');
      const token = randomBytes(32).toString('base64url');
      const expiresAt = later(SESSION_LIFETIME);
      db.prepare('INSERT INTO sessions (token_hash, actor, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(hashToken(token), actorId, now(), expiresAt);
      if (this.actorForSession(token)?.id !== actorId) {
        throw new StoreError('write-failed', `actor ${actorId}'s session did not read back.`);
      }
      return { token, expiresAt };
    },

    /** The person a session token belongs to, or null for a missing, unknown, ended or expired one. */
    actorForSession(token) {
      if (typeof token !== 'string' || !token) return null;
      const row = db.prepare('SELECT actor, expires_at FROM sessions WHERE token_hash = ?').get(hashToken(token));
      if (!row || passed(row.expires_at)) return null;
      return this.getActor(num(row.actor));
    },

    /** End one session (signing out). Answers whether there was one to end. */
    endSession(token) {
      if (typeof token !== 'string' || !token) return false;
      return num(db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token)).changes) === 1;
    },

    /** End every session a person has. Answers how many ended. */
    endAllSessions(actorId) {
      requireActor(actorId, 'the actor');
      return endSessionsOf(actorId);
    },

    /**
     * Make a single-use emailed link. `setup` gives an existing person
     * (`actor`) an email and a password; `invite` makes a new person at
     * `email` (which nobody may hold yet); `reset` sets a new password for
     * the person `email` belongs to (`unknown-email` if nobody). `madeBy` is
     * who asked for it (for a reset, the person themselves when omitted).
     * Answers `{ token, expiresAt }`; only the token's hash is stored.
     */
    makeLink({ purpose, email, actor = null, madeBy = null }) {
      if (!LINK_PURPOSES.includes(purpose)) {
        throw new StoreError('bad-link', `a link's purpose is ${LINK_PURPOSES.join(', ')}, not "${purpose}".`);
      }
      const e = canonicalEmail(email);
      return transaction(() => {
        const holder = this.actorForEmail(e);
        let forActor = null;
        if (purpose === 'setup') {
          forActor = requirePerson(actor, 'the person being set up');
          if (holder && holder.id !== forActor) throw new StoreError('duplicate-email', `${e} already belongs to another person.`);
        } else if (purpose === 'invite') {
          if (actor != null) throw new StoreError('bad-link', 'an invite is for a new person; it names no actor.');
          if (holder) throw new StoreError('duplicate-email', `${e} already belongs to a person.`);
        } else {
          if (!holder) throw new StoreError('unknown-email', `no person has the email ${e}.`);
          if (actor != null && actor !== holder.id) throw new StoreError('bad-link', `${e} is not actor ${actor}'s email.`);
          forActor = holder.id;
        }
        const by = requireActor(madeBy ?? (purpose === 'reset' ? forActor : null), 'the maker of the link');
        const token = randomBytes(32).toString('base64url');
        const expiresAt = later(LINK_LIFETIME[purpose]);
        db.prepare(
          'INSERT INTO account_links (token_hash, purpose, email, actor, made_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(hashToken(token), purpose, e, forActor, by, now(), expiresAt);
        if (!db.prepare('SELECT 1 FROM account_links WHERE token_hash = ? AND used_at IS NULL').get(hashToken(token))) {
          throw new StoreError('write-failed', `the ${purpose} link for ${e} did not read back.`);
        }
        return { token, expiresAt };
      });
    },

    /**
     * Use an emailed link with a new password (and, for an invite, the new
     * person's name). A setup link sets that person's email and password;
     * an invite makes the person; a reset sets the password and ends every
     * session that person had. Refused, with nothing written: `unknown-link`,
     * `used-link`, `expired-link`, and `weak-password` before the link is
     * spent. The check and the use are one transaction. Answers
     * `{ purpose, actor }`.
     */
    useLink({ token, password, name }) {
      requirePassword(password);
      return transaction(() => {
        const row = typeof token === 'string' && token
          ? db.prepare('SELECT * FROM account_links WHERE token_hash = ?').get(hashToken(token))
          : null;
        if (!row) throw new StoreError('unknown-link', 'this link is not one the tracker made.');
        if (row.used_at != null) throw new StoreError('used-link', 'this link has already been used.');
        if (passed(row.expires_at)) throw new StoreError('expired-link', 'this link has expired.');
        let actorId = num(row.actor);
        if (row.purpose === 'invite') {
          requireText(name, "the new person's name");
          actorId = this.createActor({ kind: 'human', name: name.trim() }).id;
        } else {
          requirePerson(actorId, 'the person the link is for');
        }
        if (row.purpose !== 'reset') writeEmail(actorId, row.email);
        writePassword(actorId, password);
        if (row.purpose === 'reset') endSessionsOf(actorId);
        const r = db.prepare('UPDATE account_links SET used_at = ?, actor = ? WHERE token_hash = ? AND used_at IS NULL')
          .run(now(), actorId, row.token_hash);
        if (num(r.changes) !== 1) throw new StoreError('write-failed', 'the link was not marked used.');
        return { purpose: row.purpose, actor: this.getActor(actorId) };
      });
    },

    /**
     * What an emailed link is for, without using it: `{ purpose, email,
     * expiresAt }`, for the set-password page to show. Refused as useLink
     * refuses: `unknown-link`, `used-link`, `expired-link`.
     */
    linkInfo(token) {
      const row = typeof token === 'string' && token
        ? db.prepare('SELECT purpose, email, expires_at, used_at FROM account_links WHERE token_hash = ?').get(hashToken(token))
        : null;
      if (!row) throw new StoreError('unknown-link', 'this link is not one the tracker made.');
      if (row.used_at != null) throw new StoreError('used-link', 'this link has already been used.');
      if (passed(row.expires_at)) throw new StoreError('expired-link', 'this link has expired.');
      return { purpose: row.purpose, email: row.email, expiresAt: row.expires_at };
    },

    /**
     * Withdraw an emailed link nobody has used, so it can never be used (an
     * email that did not go out). Answers whether there was one to withdraw;
     * read back.
     */
    cancelLink(token) {
      if (typeof token !== 'string' || !token) return false;
      const hash = hashToken(token);
      const gone = num(db.prepare('DELETE FROM account_links WHERE token_hash = ? AND used_at IS NULL').run(hash).changes) === 1;
      if (db.prepare('SELECT 1 FROM account_links WHERE token_hash = ? AND used_at IS NULL').get(hash)) {
        throw new StoreError('write-failed', 'the link was not withdrawn.');
      }
      return gone;
    },

    /** Every person (never a machine), oldest first: the owner a project may name. Never a token. */
    listPeople() {
      return db.prepare("SELECT id, name FROM actors WHERE kind = 'human' ORDER BY id").all()
        .map((row) => ({ id: num(row.id), name: row.name }));
    },

    /**
     * A product: its slug, its name, its ticket-id prefix, its operator, and
     * optionally its web address, its logo (an image's web address) and its
     * owner (a person). Read back before it is answered.
     */
    createProject({ slug, name, prefix, operator = null, url = null, logo = null, owner = null }) {
      requireText(slug, "a project's slug");
      requireText(name, "a project's name");
      if (typeof prefix !== 'string' || !/^[A-Z][A-Z0-9]*$/.test(prefix)) {
        throw new StoreError('bad-prefix', `a ticket prefix is capital letters and digits, starting with a letter, not "${prefix}".`);
      }
      if (operator != null) requireActor(operator, 'the operator');
      const address = optionalAddress(url, "a project's web address");
      const image = optionalAddress(logo, "a project's logo");
      if (owner != null && this.getActor(requireActor(owner, 'the owner')).kind !== 'human') {
        throw new StoreError('bad-owner', `the owner must be a person; actor ${owner} is a machine.`);
      }
      try {
        db.prepare('INSERT INTO projects (slug, name, prefix, operator, url, logo, owner) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(slug, name, prefix, operator, address, image, owner);
      } catch (err) {
        if (/UNIQUE/.test(err.message)) {
          throw new StoreError('duplicate-project', `a project with slug "${slug}" or prefix "${prefix}" already exists.`);
        }
        throw err;
      }
      const made = this.getProject(slug);
      const wanted = { slug, name, prefix, operator, url: address, logo: image, owner };
      if (!made || Object.keys(wanted).some((k) => made[k] !== wanted[k])) {
        throw new StoreError('write-failed', `project "${slug}" did not read back as written.`);
      }
      return made;
    },

    /**
     * Change a project's name, web address, logo or owner: only the fields
     * given change. Its slug, prefix and operator are refused, never
     * changed. Read back before it is answered.
     */
    updateProject(slug, changes = {}) {
      const project = this.getProject(slug);
      if (!project) throw new StoreError('unknown-project', `no project "${slug}".`);
      const fields = Object.keys(changes);
      const fixed = fields.filter((k) => !PROJECT_CHANGEABLE.includes(k));
      if (fixed.length) {
        throw new StoreError('not-changeable',
          `a project's ${fixed.join(', ')} cannot be changed; only its ${PROJECT_CHANGEABLE.join(', ')} can.`);
      }
      const wanted = { ...project };
      if ('name' in changes) {
        requireText(changes.name, "a project's name");
        wanted.name = changes.name;
      }
      if ('url' in changes) wanted.url = optionalAddress(changes.url, "a project's web address");
      if ('logo' in changes) wanted.logo = optionalAddress(changes.logo, "a project's logo");
      if ('owner' in changes) {
        const owner = changes.owner ?? null;
        if (owner != null && this.getActor(requireActor(owner, 'the owner')).kind !== 'human') {
          throw new StoreError('bad-owner', `the owner must be a person; actor ${owner} is a machine.`);
        }
        wanted.owner = owner;
      }
      const r = db.prepare('UPDATE projects SET name = ?, url = ?, logo = ?, owner = ? WHERE slug = ?')
        .run(wanted.name, wanted.url, wanted.logo, wanted.owner, slug);
      const saved = this.getProject(slug);
      if (num(r.changes) !== 1 || !saved || Object.keys(wanted).some((k) => saved[k] !== wanted[k])) {
        throw new StoreError('write-failed', `project "${slug}" did not read back as changed.`);
      }
      return saved;
    },

    /**
     * Delete a project that holds no tickets. One with tickets is refused
     * (`has-tickets`, with their count) and nothing is removed. The count and
     * the delete are one transaction. Answers `{ slug, prefix }`.
     */
    deleteProject(slug) {
      return transaction(() => {
        const project = this.getProject(slug);
        if (!project) throw new StoreError('unknown-project', `no project "${slug}".`);
        const tickets = num(db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE project = ?').get(slug).n);
        if (tickets > 0) {
          const err = new StoreError('has-tickets',
            `${project.prefix} has ${tickets} ticket${tickets === 1 ? '' : 's'}; a project with tickets cannot be deleted.`);
          err.tickets = tickets;
          throw err;
        }
        const r = db.prepare('DELETE FROM projects WHERE slug = ?').run(slug);
        if (num(r.changes) !== 1 || this.getProject(slug)) {
          throw new StoreError('write-failed', `project "${slug}" was not deleted.`);
        }
        return { slug: project.slug, prefix: project.prefix };
      });
    },

    getProject(slug) {
      return projectFromRow(db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug));
    },

    /** Every project, by slug: Dane's page lists what waits on him across all of them. */
    listProjects() {
      return db.prepare('SELECT * FROM projects ORDER BY slug').all().map(projectFromRow);
    },

    /** File a ticket. Its id is the project's prefix and next number. */
    fileTicket(fields) {
      const checked = checkNewTicket(fields);
      return transaction(() => insertTicket(checked, now(), null));
    },

    /**
     * Copy a ticket into another project: its name, description, priority
     * and tags, as a new ticket in `Requested` there, unassigned, filed by
     * `actor`, with one comment on the copy naming the ticket it came from.
     * The original is only read: no field, version, event or comment of it
     * changes. Copying into the ticket's own project is refused.
     */
    cloneTicket(id, { project, actor }) {
      return transaction(() => {
        const from = ticketFromRow(requireTicketRow(id));
        if (!this.getProject(project)) throw new StoreError('unknown-project', `no project "${project}".`);
        if (project === from.project) {
          throw new StoreError('same-project', `ticket ${from.id} is already in project "${project}"; copy it into another one.`);
        }
        const at = now();
        const copy = insertTicket(checkNewTicket({
          project, actor, name: from.name, description: from.description,
          status: 'requested', priority: from.priority, tags: from.tags,
        }), at, null);
        const source = this.getProject(from.project);
        insertComment({ ticket: copy.id, author: actor, body: `Copied from ${from.id} in ${source.name}.`, parent: null }, at);
        return copy;
      });
    },

    /** One ticket, or null. */
    getTicket(id) {
      return ticketFromRow(ticketRow(id));
    },

    /** A project's tickets in filing order; `status` filters, `open` drops Live. */
    listTickets(project, { status, open = false } = {}) {
      const where = ['project = ?'];
      const params = [project];
      if (status != null) {
        where.push('status = ?');
        params.push(canonicalStatus(status));
      }
      if (open) {
        where.push(`status NOT IN (${TERMINAL_STATUSES.map(() => '?').join(', ')})`);
        params.push(...TERMINAL_STATUSES);
      }
      return db.prepare(`SELECT * FROM tickets WHERE ${where.join(' AND ')} ORDER BY number`)
        .all(...params).map(ticketFromRow);
    },

    /**
     * Change a ticket's fields. `ifStatus` / `ifVersion` guard the write:
     * if the ticket no longer matches, nothing is written and the answer is
     * `{ ok: false, refused: 'moved', status, version }`. On success the
     * answer is `{ ok: true, ticket, changed }`, read back inside the same
     * transaction. Fields given with their current value are not changes:
     * no version bump, no event.
     */
    changeTicket(id, { actor, ifStatus, ifVersion, ...fields }) {
      const unknown = Object.keys(fields).filter((k) => !(k in CHANGEABLE));
      if (unknown.length) {
        throw new StoreError('bad-field', `cannot change ${unknown.join(', ')}; changeable: ${Object.keys(CHANGEABLE).join(', ')}.`);
      }
      const wanted = {};
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        const column = CHANGEABLE[key];
        if (column === 'status') wanted[column] = canonicalStatus(value);
        else if (column === 'priority') wanted[column] = canonicalPriority(value);
        else if (column === 'tags') wanted[column] = canonicalTags(value);
        else if (column === 'name') wanted[column] = requireText(value, "a ticket's name");
        else if (column === 'assignee') wanted[column] = value;
        else wanted[column] = String(value ?? '');
      }
      const guardStatus = ifStatus === undefined ? undefined : canonicalStatus(ifStatus);
      if (ifVersion !== undefined && !Number.isInteger(ifVersion)) {
        throw new StoreError('bad-guard', `ifVersion must be a whole number, not "${ifVersion}".`);
      }

      return transaction(() => {
        requireActor(actor, 'the actor');
        if (wanted.assignee != null) requireActor(wanted.assignee, 'the assignee');
        const row = requireTicketRow(id);
        const version = num(row.version);
        if ((guardStatus !== undefined && row.status !== guardStatus)
            || (ifVersion !== undefined && version !== ifVersion)) {
          return { ok: false, refused: 'moved', ticket: row.id, status: row.status, version };
        }
        const changed = Object.keys(wanted).filter((column) => {
          const before = column === 'assignee' ? num(row[column]) : row[column];
          return before !== wanted[column];
        });
        if (!changed.length) return { ok: true, ticket: ticketFromRow(row), changed };

        const at = now();
        const sets = changed.map((column) => `${column} = ?`);
        const r = db.prepare(
          `UPDATE tickets SET ${sets.join(', ')}, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`,
        ).run(...changed.map((c) => wanted[c]), at, row.id, version);
        if (num(r.changes) !== 1) {
          // Cannot happen while the write lock is held; if it ever does, say so.
          throw new StoreError('write-failed', `ticket ${row.id} was not updated.`);
        }
        for (const column of changed) {
          writeEvent(row.id, actor, column, eventValue(column, row[column]), eventValue(column, wanted[column]), at);
        }
        const after = ticketFromRow(ticketRow(row.id));
        if (after.version !== version + 1) {
          throw new StoreError('write-failed', `ticket ${row.id} read back at version ${after.version}, expected ${version + 1}.`);
        }
        return { ok: true, ticket: after, changed: changed.map((c) => Object.keys(CHANGEABLE).find((k) => CHANGEABLE[k] === c)) };
      });
    },

    /**
     * Delete a ticket nobody has started (`Requested` or `Queued`), with its
     * comments and events. The status check and the delete are one
     * transaction holding the write lock from its first read. Any other
     * status is refused with `not-deletable` (the error carries `status`),
     * an unknown id with `unknown-ticket`; either way nothing is removed.
     * An imported ticket's `imported_ids` rows are kept, so a re-run of the
     * importer still cannot file it again. Answers `{ id, status }`.
     */
    deleteTicket(id, { actor }) {
      return transaction(() => {
        requireActor(actor, 'the actor');
        const row = requireTicketRow(id);
        if (!DELETABLE.includes(row.status)) {
          const err = new StoreError('not-deletable',
            `ticket ${row.id} is "${row.status}": only a ticket nobody has started (${DELETABLE.join(' or ')}) can be deleted.`);
          err.status = row.status;
          throw err;
        }
        db.prepare('DELETE FROM events WHERE ticket = ?').run(row.id);
        db.prepare('DELETE FROM comments WHERE ticket = ?').run(row.id);
        const r = db.prepare('DELETE FROM tickets WHERE id = ? AND status = ?').run(row.id, row.status);
        if (num(r.changes) !== 1 || ticketRow(row.id)) {
          throw new StoreError('write-failed', `ticket ${row.id} was not deleted.`);
        }
        return { id: row.id, status: row.status };
      });
    },

    /** Post a comment, or a reply when `parent` names one on the same ticket. */
    postComment({ ticket, author, body, parent = null }) {
      requireText(body, "a comment's body");
      return transaction(() => insertComment({ ticket, author, body, parent }, now()));
    },

    /**
     * The new id an imported thing was given, or null if it was never
     * imported. Ticket ids are text (`<PREFIX>-4`); comment and actor ids come back
     * as numbers.
     */
    importedId({ source, kind, sourceId }) {
      const key = requireImportKey(source, kind, sourceId);
      const id = importedRow(...key);
      if (id == null) return null;
      return kind === 'ticket' ? id : Number(id);
    },

    /** Every map row from one source, in the order they were written. */
    listImportedIds(source) {
      return db.prepare('SELECT source, kind, source_id, new_id FROM imported_ids WHERE source = ? ORDER BY rowid')
        .all(source).map((r) => ({ source: r.source, kind: r.kind, sourceId: r.source_id, newId: r.new_id }));
    },

    /**
     * IMPORT ONLY. File a ticket with its original `createdAt` (and
     * `updatedAt`, default the same) and record `sourceId` against its new id,
     * in one transaction. A source id already imported is refused with
     * `already-imported` and nothing is written.
     */
    importTicket({ source, sourceId, createdAt, updatedAt, ...fields }) {
      const key = requireImportKey(source, 'ticket', sourceId);
      const at = requireTime(createdAt, "a ticket's original time");
      const upd = updatedAt == null ? at : requireTime(updatedAt, "a ticket's original update time");
      const checked = checkNewTicket(fields);
      return transaction(() => {
        refuseIfImported(...key);
        const ticket = insertTicket(checked, at, upd);
        recordImport(...key, ticket.id);
        return ticket;
      });
    },

    /**
     * IMPORT ONLY. Post a comment (or a reply, with `parent`) with its
     * original `createdAt`, and record `sourceId` against its new id, in one
     * transaction. The body is stored exactly as given.
     */
    importComment({ source, sourceId, createdAt, ticket, author, body, parent = null }) {
      const key = requireImportKey(source, 'comment', sourceId);
      const at = requireTime(createdAt, "a comment's original time");
      requireText(body, "a comment's body");
      return transaction(() => {
        refuseIfImported(...key);
        const comment = insertComment({ ticket, author, body, parent }, at);
        recordImport(...key, comment.id);
        return comment;
      });
    },

    /**
     * IMPORT ONLY. The actor that stands for `sourceId` (a person or a
     * machine in the old tracker), created on first use and found again on
     * every later run.
     */
    importActor({ source, sourceId, kind, name }) {
      const key = requireImportKey(source, 'actor', sourceId);
      return transaction(() => {
        const known = importedRow(...key);
        if (known != null) return this.getActor(Number(known));
        const actor = this.createActor({ kind, name });
        recordImport(...key, actor.id);
        return actor;
      });
    },

    /**
     * IMPORT ONLY. Record an actor that already exists (one made by
     * tracker/signins.mjs) as the one standing for `sourceId`, so a later
     * import finds it instead of making a second. Answers `'recorded'`, or
     * `'already'` when it is already that actor's; a key that maps to a
     * different actor is refused with `already-imported`.
     */
    adoptImportedActor({ source, sourceId, actor }) {
      const key = requireImportKey(source, 'actor', sourceId);
      return transaction(() => {
        requireActor(actor, 'the adopted actor');
        const known = importedRow(...key);
        if (known != null && Number(known) === actor) return 'already';
        recordImport(...key, actor);
        return 'recorded';
      });
    },

    /** Every stage's colour that is set, by its stored status: `{ queued: '#2b9cf2' }`. */
    stageColours() {
      return Object.fromEntries(db.prepare('SELECT status, colour FROM stage_colours ORDER BY status').all()
        .map((r) => [r.status, r.colour]));
    },

    /**
     * Set or clear stage colours: `{ Queued: '#2b9cf2', Live: null }`, any
     * spelling of a status; a stage not named is left as it is. Every value
     * is checked before anything is written, so one bad one writes nothing.
     * The result is read back in the same transaction and answered.
     */
    setStageColours(colours) {
      if (!colours || typeof colours !== 'object' || Array.isArray(colours)) {
        throw new StoreError('bad-colour', 'the colours must be an object of status to #rrggbb (or null to clear).');
      }
      const wanted = Object.entries(colours).map(([status, colour]) => {
        const s = canonicalStatus(status);
        return [s, canonicalColour(colour, s)];
      });
      return transaction(() => {
        for (const [status, colour] of wanted) {
          if (colour === null) db.prepare('DELETE FROM stage_colours WHERE status = ?').run(status);
          else db.prepare('INSERT INTO stage_colours (status, colour) VALUES (?, ?) ON CONFLICT (status) DO UPDATE SET colour = excluded.colour').run(status, colour);
        }
        const after = this.stageColours();
        for (const [status, colour] of wanted) {
          if ((after[status] ?? null) !== colour) {
            throw new StoreError('write-failed', `the colour for ${DISPLAY[status]} read back as ${after[status] ?? 'none'}, not ${colour ?? 'none'}.`);
          }
        }
        return after;
      });
    },

    /** A ticket's comments, oldest first. */
    listComments(ticket) {
      return db.prepare('SELECT * FROM comments WHERE ticket = ? ORDER BY id').all(String(ticket)).map(commentFromRow);
    },

    /** A ticket's history, oldest first. */
    listEvents(ticket) {
      return db.prepare('SELECT * FROM events WHERE ticket = ? ORDER BY id').all(String(ticket)).map(eventFromRow);
    },

    close() {
      db.close();
    },
  };
}

export { STATUSES, DELETABLE };
