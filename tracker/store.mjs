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
 *    trail the loop reads can never shift under it.
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
 *  - A stage's colour (the Settings page's pickers) is one of the eight
 *    statuses and a `#rrggbb` value, or no row at all. One set for the whole
 *    tracker, not one per project.
 */
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import loopStatuses from '../lib/loopStatuses.js';

const { DISPLAY, TERMINAL_STATUSES, PRIORITY_RANK, statusOf } = loopStatuses;

/** The eight statuses, lower-cased, as the store keeps them. */
const STATUSES = Object.freeze(Object.keys(DISPLAY));
const PRIORITIES = Object.freeze(Object.keys(PRIORITY_RANK));
const ACTOR_KINDS = Object.freeze(['human', 'machine']);
const IMPORT_KINDS = Object.freeze(['ticket', 'comment', 'actor']);

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
  token_hash  TEXT
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
CREATE UNIQUE INDEX IF NOT EXISTS actors_by_token ON actors (token_hash);
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

/** SQLite hands integers back as numbers; keep ids plain numbers. */
const num = (v) => (v == null ? null : Number(v));

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
  // A database made before actors had tokens gains the column; the unique
  // index in SCHEMA needs it, so this runs first.
  const hasActors = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'actors'").get();
  if (hasActors && !db.prepare('PRAGMA table_info(actors)').all().some((c) => c.name === 'token_hash')) {
    db.exec('ALTER TABLE actors ADD COLUMN token_hash TEXT');
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

export { STATUSES };
