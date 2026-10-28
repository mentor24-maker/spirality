#!/usr/bin/env node
/**
 * The tracker's nightly backup: a consistent copy of its database into a
 * dated file, keeping the newest few. Design: docs/TRACKER_MVP.md, "Running it".
 *
 *   TRACKER_DB=<db> TRACKER_BACKUP_DIR=<folder> node tracker/backup.mjs
 *
 * A plain file copy of a live SQLite database can catch it half-written (and
 * misses whatever still sits in its write-ahead log), so the copy is made by
 * SQLite itself: `VACUUM INTO` reads the whole database inside one read
 * transaction and writes a fresh file from that snapshot. Writers carry on
 * while it runs; the copy is exactly the database as it stood at one moment.
 * (node:sqlite's `backup()` does the same job but needs Node 22.16; this works
 * on every Node the package supports.)
 *
 * The copy is written beside its final name, checked (it opens, SQLite's own
 * integrity check says "ok", it is a standalone file with no log beside it),
 * and only then renamed into place. A copy that fails a check is deleted and
 * the run fails saying why; older backups are only pruned after a good one.
 */
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/** How many dated backups are kept when nothing else is said. */
export const DEFAULT_KEEP = 14;

/** A date as YYYY-MM-DD in the machine's own time zone (the Mini's is Mountain). */
function localDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The name stem backups of `db` share: `tracker.db` -> `tracker`. */
function stemOf(db) {
  const name = basename(db);
  return extname(name) ? name.slice(0, -extname(name).length) : name;
}

/** The dated backups of `db` in `dir`, oldest first. */
export function listBackups(db, dir) {
  const stem = stemOf(db);
  const pattern = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{4}-\\d{2}-\\d{2}\\.db$`);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => pattern.test(f)).sort().map((f) => join(dir, f));
}

function removeWithSidecars(path) {
  for (const p of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(p, { force: true });
}

/**
 * Copy `db` into `dir` as `<stem>-<YYYY-MM-DD>.db` and keep the newest `keep`.
 * A second run on the same day replaces that day's file. Returns
 * `{ file, tickets, removed }`; throws, having left no partial file and
 * pruned nothing, if any step fails.
 */
export function backupDatabase({ db, dir, keep = DEFAULT_KEEP, now = new Date() }) {
  if (!db) throw new Error('no database path given (TRACKER_DB).');
  if (!dir) throw new Error('no backup folder given (TRACKER_BACKUP_DIR).');
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`keep must be a whole number of at least 1, not ${keep}.`);
  // Opening a missing path would quietly create an empty database and back
  // THAT up; refuse instead.
  if (!existsSync(db)) throw new Error(`there is no database at ${db}.`);
  if (!existsSync(dir)) throw new Error(`the backup folder ${dir} does not exist.`);

  const file = join(dir, `${stemOf(db)}-${localDate(now)}.db`);
  const partial = `${file}.partial`;
  removeWithSidecars(partial);

  const source = new DatabaseSync(db);
  try {
    source.exec('PRAGMA busy_timeout = 5000');
    source.prepare('VACUUM INTO ?').run(partial);
  } finally {
    source.close();
  }

  let tickets;
  try {
    const copy = new DatabaseSync(partial);
    try {
      const check = copy.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
      if (check.length !== 1 || check[0] !== 'ok') {
        throw new Error(`the copy failed SQLite's integrity check: ${check.slice(0, 3).join('; ')}`);
      }
      // A standalone file: no write-ahead log that would have to travel with it.
      copy.exec('PRAGMA journal_mode = DELETE');
      tickets = copy.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'tickets'").get().n
        ? copy.prepare('SELECT count(*) AS n FROM tickets').get().n
        : 0;
    } finally {
      copy.close();
    }
    renameSync(partial, file);
  } catch (err) {
    removeWithSidecars(partial);
    throw err;
  }

  const removed = listBackups(db, dir).slice(0, -keep);
  for (const old of removed) removeWithSidecars(old);
  return { file, tickets, removed };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const stamp = () => new Date().toString();
  try {
    const keepText = process.env.TRACKER_BACKUP_KEEP;
    const keep = keepText ? Number(keepText) : DEFAULT_KEEP;
    const { file, tickets, removed } = backupDatabase({
      db: process.env.TRACKER_DB,
      dir: process.env.TRACKER_BACKUP_DIR,
      keep,
    });
    console.log(`${stamp()} backup OK: ${file} (${tickets} ticket(s)); kept the newest ${keep}, removed ${removed.length}.`);
  } catch (err) {
    console.error(`${stamp()} backup FAILED: ${err.message} No new backup was made; older ones are untouched.`);
    process.exit(1);
  }
}
