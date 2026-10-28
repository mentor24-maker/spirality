#!/usr/bin/env node
/**
 * Give the operator and each loop its own tracker sign-in, kept in Doppler
 * (docs/TRACKER_MVP.md, "Running it"). Run it under `doppler run` (the npm
 * script does), so the tokens already stored are in the environment:
 *
 *   npm run tracker:signins -- create --name <project name> [--prefix <PREFIX>]
 *   npm run tracker:signins -- check
 *
 * create  For each seat in TRACKER_SEATS (scripts/lib/expectedSecrets.mjs):
 *         a seat whose Doppler token already signs in as it is left alone;
 *         otherwise its actor (found by kind and name, or made with
 *         tracker/admin.mjs's store calls) is given a new token, which
 *         stops any old one, and it goes straight into Doppler (`doppler secrets set`,
 *         fed on stdin), then is read back from Doppler and compared. Then
 *         the operator's actor is recorded as the one the history import
 *         (tracker/import.mjs) stands for his ClickUp seat, so the import
 *         finds him instead of making a second. Then the project (the
 *         config's productSlug, ticket prefix the config's trackerPrefix) is
 *         made, with the operator's actor as its operator, unless it exists.
 *         Running it again finishes what a failed run left, and records that
 *         mapping on a database made before it existed; it never replaces a
 *         working token.
 * check   Starts the tracker on a free local port against the same database
 *         and asks `GET /me` with each seat's token: each must answer with
 *         that seat's own name.
 *
 * No token is ever printed: only names, ids and verdicts. The database is
 * the project config's trackerDataDir/tracker.db, or TRACKER_DB.
 */
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from './store.mjs';
import { startServer } from './server.mjs';
import { loadProjectConfig } from '../lib/projectConfig.mjs';
import { TRACKER_SEATS } from '../scripts/lib/expectedSecrets.mjs';
import { operatorImportKey } from './import.mjs';

/** The seats with the operator's name filled in from the project config. */
export function seatsFor(operatorName, seats = TRACKER_SEATS) {
  return seats.map((s) => ({ ...s, name: s.name ?? operatorName }));
}

/** A message with every occurrence of `secret` blanked, for anything that came back from Doppler. */
const scrub = (text, secret) => (secret ? String(text).split(secret).join('[token]') : String(text));

/**
 * Make what is missing. `setSecret(name, value)` and `getSecret(name)` talk
 * to Doppler (injected so tests never do); each throws on failure. Returns
 * `{ ok, lines }`: one line per seat and one for the project.
 */
export function createSignins({ store, seats, env, project, operatorImport = null, setSecret, getSecret }) {
  const lines = [];
  let ok = true;
  const ids = {};
  const operatorSeat = seats.find((s) => s.kind === 'human');
  for (const seat of seats) {
    const held = env[seat.secret];
    if (held) {
      const actor = store.actorForToken(held);
      if (actor && actor.name === seat.name && actor.kind === seat.kind) {
        ids[seat.secret] = actor.id;
        lines.push(`${seat.secret}: already signs in as "${actor.name}" (actor ${actor.id}), left alone.`);
        continue;
      }
      ok = false;
      lines.push(`${seat.secret}: REFUSED. Doppler holds a token that does not sign in as "${seat.name}" here${actor ? ` (it is "${actor.name}")` : ''}. Nothing replaced; remove that secret in Doppler first if it is truly stale.`);
      continue;
    }
    // A seat keeps one actor: a later run (a lost token, a failed run) gives
    // that actor a fresh token, which also stops the old one signing in.
    // The operator an earlier import already made is the one to keep.
    const kept = (seat === operatorSeat && importedOperator(store, operatorImport, seat)) || store.actorsNamed({ kind: seat.kind, name: seat.name })[0];
    const actor = kept ?? store.createActor({ kind: seat.kind, name: seat.name });
    const token = store.issueToken(actor.id);
    try {
      setSecret(seat.secret, token);
    } catch (err) {
      ok = false;
      lines.push(`${seat.secret}: FAILED. Actor ${actor.id} ("${seat.name}") has a new token that did not reach Doppler: ${scrub(err.message, token)}. Run create again; it gives that actor another.`);
      continue;
    }
    try {
      if (getSecret(seat.secret) !== token) throw new Error('the value Doppler gives back is not the one written');
    } catch (err) {
      ok = false;
      lines.push(`${seat.secret}: FAILED. Actor ${actor.id} ("${seat.name}") has a new token, written to Doppler but not confirmed: ${scrub(err.message, token)}. Run create again; it gives that actor another.`);
      continue;
    }
    ids[seat.secret] = actor.id;
    lines.push(`${seat.secret}: actor ${actor.id} (${seat.kind}, "${seat.name}") ${kept ? 'kept, given a new token' : 'made'}; token stored in Doppler and read back.`);
  }

  const operatorId = operatorSeat ? ids[operatorSeat.secret] : null;
  if (operatorSeat && operatorId != null && operatorImport) {
    // The history import finds the operator by this key; without it, it
    // would make a second operator and file all of his history under that one.
    const { source, sourceId } = operatorImport;
    try {
      const done = store.adoptImportedActor({ source, sourceId, actor: operatorId });
      lines.push(`${operatorSeat.secret}: ${source} ${sourceId} ${done === 'recorded' ? 'now maps' : 'already maps'} to actor ${operatorId}, so the history import files the operator's history under this sign-in.`);
    } catch (err) {
      ok = false;
      const other = store.importedId({ source, kind: 'actor', sourceId });
      lines.push(`${operatorSeat.secret}: WRONG. The history import already stands actor ${other ?? '?'} for ${source} ${sourceId}, not actor ${operatorId} who signs in: ${err.message} Two operators exist; merge them by hand before importing more.`);
    }
  }

  const existing = store.getProject(project.slug);
  if (existing) {
    lines.push(`project "${existing.slug}": already exists (tickets ${existing.prefix}-…, operator ${existing.operator ?? '(none)'}), left alone.`);
    if (operatorId != null && existing.operator !== operatorId) {
      ok = false;
      lines.push(`project "${existing.slug}": WRONG. Its operator is actor ${existing.operator ?? '(none)'}, but the operator signs in as actor ${operatorId}.`);
    }
  } else if (!project.name || !project.prefix) {
    ok = false;
    lines.push(`project "${project.slug}": NOT made. Give --name and a prefix (--prefix, or trackerPrefix in the project config) to make it.`);
  } else if (operatorSeat && operatorId == null) {
    ok = false;
    lines.push(`project "${project.slug}": NOT made, because the operator has no working sign-in yet.`);
  } else {
    try {
      const made = store.createProject({ slug: project.slug, name: project.name, prefix: project.prefix, operator: operatorId });
      lines.push(`project "${made.slug}": made, "${made.name}", tickets ${made.prefix}-1 onwards, operator ${made.operator ?? '(none)'}.`);
    } catch (err) {
      ok = false;
      lines.push(`project "${project.slug}": NOT made: ${err.message}`);
    }
  }
  return { ok, lines };
}

/** The operator actor an earlier history import made, if it matches the seat. */
function importedOperator(store, operatorImport, seat) {
  if (!operatorImport) return null;
  const id = store.importedId({ source: operatorImport.source, kind: 'actor', sourceId: operatorImport.sourceId });
  const actor = id == null ? null : store.getActor(id);
  return actor && actor.kind === seat.kind && actor.name === seat.name ? actor : null;
}

/** Ask the running API who each seat's token is. Returns `{ ok, lines }`. */
export async function checkSignins({ url, seats, env }) {
  const lines = [];
  let ok = true;
  for (const seat of seats) {
    const token = env[seat.secret];
    if (!token) {
      ok = false;
      lines.push(`${seat.secret}: MISSING from this environment.`);
      continue;
    }
    let res;
    let me;
    try {
      res = await fetch(`${url}/me`, { headers: { Authorization: `Bearer ${token}` } });
      me = res.ok ? await res.json() : null;
    } catch (err) {
      ok = false;
      lines.push(`${seat.secret}: WRONG. GET /me did not answer usably: ${scrub(err.message, token)}.`);
      continue;
    }
    if (me && me.name === seat.name && me.kind === seat.kind) {
      lines.push(`${seat.secret}: GET /me answers "${me.name}" (${me.kind}, actor ${me.id}). OK`);
    } else {
      ok = false;
      lines.push(`${seat.secret}: WRONG. GET /me answered ${res.status}${me ? ` "${me.name}" (${me.kind})` : ''}, expected "${seat.name}" (${seat.kind}).`);
    }
  }
  return { ok, lines };
}

function doppler(args, input) {
  const r = spawnSync('doppler', [...args, '--no-check-version'], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (r.error) throw new Error(`could not run doppler (${r.error.code})`);
  if (r.status !== 0) throw new Error(`doppler exited ${r.status}: ${r.stderr.trim()}`);
  return r.stdout;
}

const USAGE = `usage (under doppler run, as the npm script does):
  npm run tracker:signins -- create --name <project name> [--prefix <PREFIX>]
  npm run tracker:signins -- check
--prefix defaults to trackerPrefix in the project config, and must match it.`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...rest] = process.argv.slice(2);
  let values;
  try {
    ({ values } = parseArgs({ args: rest, options: { name: { type: 'string' }, prefix: { type: 'string' } }, strict: true }));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(1);
  }
  if (command !== 'create' && command !== 'check') {
    console.error(USAGE);
    process.exit(1);
  }
  const config = loadProjectConfig();
  if (values.prefix && config.trackerPrefix && values.prefix !== config.trackerPrefix) {
    console.error(`--prefix ${values.prefix} does not match trackerPrefix "${config.trackerPrefix}" in the project config; the history import numbers tickets with that one. Leave --prefix off.`);
    process.exit(1);
  }
  const dataDir = config.trackerDataDir?.replace(/^~(?=\/|$)/, homedir());
  const db = process.env.TRACKER_DB || (dataDir && join(dataDir, 'tracker.db'));
  if (!db) {
    console.error('The project config names no trackerDataDir, and TRACKER_DB is not set: there is no tracker database to use.');
    process.exit(1);
  }
  if (!process.env.DOPPLER_PROJECT) {
    console.error(`Run this under doppler run, so the tokens already stored are seen:\n${USAGE}`);
    process.exit(1);
  }
  const seats = seatsFor(config.operatorName);
  if (!process.env.TRACKER_DB) mkdirSync(dataDir, { recursive: true });
  const store = openStore(db);
  let result;
  try {
    if (command === 'create') {
      const where = ['--project', config.dopplerProject, '--config', config.dopplerConfig];
      result = createSignins({
        store, seats, env: process.env,
        project: { slug: config.productSlug, name: values.name, prefix: values.prefix ?? config.trackerPrefix },
        operatorImport: operatorImportKey(config),
        setSecret: (name, value) => { doppler(['secrets', 'set', name, ...where, '--silent'], value); },
        getSecret: (name) => doppler(['secrets', 'get', name, ...where, '--plain']).replace(/\n$/, ''),
      });
    } else {
      const server = await startServer({ store, port: 0 });
      try {
        result = await checkSignins({ url: `http://127.0.0.1:${server.address().port}`, seats, env: process.env });
      } finally {
        await new Promise((r) => server.close(r));
      }
    }
  } finally {
    store.close();
  }
  console.log(`tracker database: ${db}`);
  for (const line of result.lines) console.log(line);
  console.log(result.ok ? `${command}: every sign-in is in order.` : `${command}: SOMETHING ABOVE FAILED.`);
  process.exit(result.ok ? 0 : 1);
}
