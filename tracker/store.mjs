/**
 * The tracker's store: the database that will hold tickets and comments once the loop
 * leaves ClickUp. Design: docs/TRACKER_MVP.md, "The data".
 *
 * Plain Node, no outside packages: the built-in `node:sqlite` (SQLite, a
 * database kept in one ordinary file). Nothing reads this yet; the API, the
 * page and the importer are later tickets.
 *
 * What the store enforces, and only this (the contract's own rules stay in
 * the package modules and the door):
 *
 *  - Statuses are exactly the seven in lib/loopStatuses.js. Anything else is
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
 */
import { DatabaseSync } from 'node:sqlite';
import loopStatuses from '../lib/loopStatuses.js';

const { DISPLAY, TERMINAL_STATUSES, PRIORITY_RANK, statusOf } = loopStatuses;

/** The seven statuses, lower-cased, as the store keeps them. */
const STATUSES = Object.freeze(Object.keys(DISPLAY));
const PRIORITIES = Object.freeze(Object.keys(PRIORITY_RANK));
const ACTOR_KINDS = Object.freeze(['human', 'machine']);

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
  name        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  prefix      TEXT NOT NULL UNIQUE,
  operator    INTEGER REFERENCES actors(id),
  next_number INTEGER NOT NULL DEFAULT 1
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
    throw new StoreError('unknown-status', `"${status}" is not one of the seven statuses: ${Object.values(DISPLAY).join(', ')}.`);
  }
  return s;
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

function requireText(value, what) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new StoreError('missing', `${what} is required.`);
  }
  return value;
}

/** SQLite hands integers back as numbers; keep ids plain numbers. */
const num = (v) => (v == null ? null : Number(v));

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
  db.exec(SCHEMA);

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

    /** A product: its slug, its name, its ticket-id prefix, its operator. */
    createProject({ slug, name, prefix, operator = null }) {
      requireText(slug, "a project's slug");
      requireText(name, "a project's name");
      if (typeof prefix !== 'string' || !/^[A-Z][A-Z0-9]*$/.test(prefix)) {
        throw new StoreError('bad-prefix', `a ticket prefix is capital letters and digits, starting with a letter, not "${prefix}".`);
      }
      if (operator != null) requireActor(operator, 'the operator');
      try {
        db.prepare('INSERT INTO projects (slug, name, prefix, operator) VALUES (?, ?, ?, ?)')
          .run(slug, name, prefix, operator);
      } catch (err) {
        if (/UNIQUE/.test(err.message)) {
          throw new StoreError('duplicate-project', `a project with slug "${slug}" or prefix "${prefix}" already exists.`);
        }
        throw err;
      }
      return this.getProject(slug);
    },

    getProject(slug) {
      const row = db.prepare('SELECT slug, name, prefix, operator FROM projects WHERE slug = ?').get(slug);
      return row ? { slug: row.slug, name: row.name, prefix: row.prefix, operator: num(row.operator) } : null;
    },

    /** File a ticket. Its id is the project's prefix and next number. */
    fileTicket({ project, actor, name, description = '', status, priority = null, tags = [], assignee = null, loopNote = '' }) {
      requireText(name, "a ticket's name");
      const s = canonicalStatus(status);
      const p = canonicalPriority(priority);
      const t = canonicalTags(tags);
      return transaction(() => {
        requireActor(actor, 'the filer');
        if (assignee != null) requireActor(assignee, 'the assignee');
        const proj = db.prepare('SELECT prefix, next_number FROM projects WHERE slug = ?').get(project);
        if (!proj) throw new StoreError('unknown-project', `no project "${project}".`);
        const number = num(proj.next_number);
        const id = `${proj.prefix}-${number}`;
        const at = now();
        db.prepare('UPDATE projects SET next_number = ? WHERE slug = ?').run(number + 1, project);
        db.prepare(
          `INSERT INTO tickets (id, project, number, name, description, status, priority, tags, assignee, loop_note, created_at, updated_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        ).run(id, project, number, name, String(description), s, p, t, assignee, String(loopNote), at, at);
        writeEvent(id, actor, 'created', null, s, at);
        return ticketFromRow(ticketRow(id));
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
      return transaction(() => {
        requireActor(author, 'the author');
        const row = requireTicketRow(ticket);
        if (parent != null) {
          const p = db.prepare('SELECT ticket FROM comments WHERE id = ?').get(parent);
          if (!p || p.ticket !== row.id) {
            throw new StoreError('bad-parent', `comment ${parent} is not on ticket ${row.id}.`);
          }
        }
        const r = db.prepare('INSERT INTO comments (ticket, parent, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(row.id, parent, author, body, now());
        return commentFromRow(db.prepare('SELECT * FROM comments WHERE id = ?').get(r.lastInsertRowid));
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
