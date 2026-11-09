#!/usr/bin/env node
/**
 * Which tracker ticket is this old ClickUp link? Read-only, from the
 * importer's id map (`imported_ids`, written by tracker/import.mjs):
 *
 *   npm run tracker:old-id -- 86bctjbc3
 *   npm run tracker:old-id -- https://app.clickup.com/t/86bctjbc3 86bcudhyj
 *
 * One line per id on stdout, tab-separated: the ClickUp id, the tracker id
 * and the ticket's page (`<trackerUrl>/t/<id>`), or `not imported`. Pull
 * requests, comments and `Waits on:` lines written before a project left
 * ClickUp still name the old ids; this is how they are read now that the
 * ClickUp list is only an archive (docs/TRACKER_MVP.md, "After the week").
 *
 * The database (TRACKER_DB, else the config's trackerDataDir/tracker.db) is
 * opened READ-ONLY: this never writes to it, and never talks to ClickUp.
 *
 * Exit codes: 0 every id was found; 3 at least one was not imported;
 * 1 the map could not be read; 2 nothing to look up.
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { loadProjectConfig, ProjectConfigError } from '../lib/projectConfig.mjs';
import { databasePath } from './switchCheck.mjs';
import { SOURCE } from './import.mjs';

const USAGE = 'usage: npm run tracker:old-id -- <ClickUp id or link> [...]';

/** The ClickUp task id in a bare id or a ClickUp task link, or null. */
export function clickupIdOf(text) {
  const s = String(text ?? '').trim();
  const link = s.match(/^https?:\/\/app\.clickup\.com\/t\/(?:\d+\/)?([0-9a-z]+)\/?(?:[?#].*)?$/i);
  if (link) return link[1].toLowerCase();
  return /^[0-9a-z]+$/i.test(s) ? s.toLowerCase() : null;
}

/**
 * Look each argument up in the map. `lookup(id)` returns the tracker id or
 * null. Returns one `{ input, clickupId, newId, page, problem }` per argument.
 */
export function resolveOldIds(inputs, { lookup, trackerUrl }) {
  const base = trackerUrl ? String(trackerUrl).replace(/\/+$/, '') : null;
  return inputs.map((input) => {
    const clickupId = clickupIdOf(input);
    if (!clickupId) return { input, clickupId: null, newId: null, page: null, problem: 'not a ClickUp id or link' };
    const newId = lookup(clickupId);
    if (!newId) return { input, clickupId, newId: null, page: null, problem: 'not imported' };
    return { input, clickupId, newId, page: base ? `${base}/t/${newId}` : null, problem: null };
  });
}

/** The lines `main` prints, one per result. */
export function formatOldIds(results) {
  return results.map((r) => (r.problem
    ? `${r.clickupId ?? r.input}\t${r.problem}`
    : `${r.clickupId}\t${r.newId}${r.page ? `\t${r.page}` : ''}`));
}

/** A lookup over the map in the database at `path`, opened read-only. */
export function openOldIdMap(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  const query = db.prepare('SELECT new_id FROM imported_ids WHERE source = ? AND kind = ? AND source_id = ?');
  return {
    lookup: (id) => query.get(SOURCE, 'ticket', id)?.new_id ?? null,
    close: () => db.close(),
  };
}

async function main(argv) {
  const inputs = argv.filter((a) => a !== '--');
  if (!inputs.length) {
    console.error(USAGE);
    return 2;
  }
  let config;
  try {
    config = loadProjectConfig();
  } catch (err) {
    if (!(err instanceof ProjectConfigError)) throw err;
    console.error(`tracker:old-id: the project config is not usable — ${err.message}`);
    return 1;
  }
  const db = databasePath(config);
  if (!db || !existsSync(db)) {
    console.error(`tracker:old-id: there is no tracker database at ${db ?? '(no path: set TRACKER_DB or trackerDataDir)'}.`);
    return 1;
  }
  let map;
  try {
    map = openOldIdMap(db);
  } catch (err) {
    console.error(`tracker:old-id: could not read the id map in ${db} — ${err.message}`);
    return 1;
  }
  try {
    const results = resolveOldIds(inputs, { lookup: map.lookup, trackerUrl: config.trackerUrl });
    for (const line of formatOldIds(results)) console.log(line);
    const missing = results.filter((r) => r.problem).length;
    if (missing) console.error(`${missing} of ${results.length} id(s) could not be resolved.`);
    return missing ? 3 : 0;
  } catch (err) {
    console.error(`tracker:old-id: could not read the id map in ${db} — ${err.message}`);
    return 1;
  } finally {
    map.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
