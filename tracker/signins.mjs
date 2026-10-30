#!/usr/bin/env node
/**
 * Give the operator and each loop its own tracker sign-in, kept in Doppler
 * (docs/TRACKER_MVP.md, "Running it"). Run it under `doppler run` (the npm
 * script does), so the tokens already stored are in the environment:
 *
 *   npm run tracker:signins -- create --name <project name> [--prefix <PREFIX>] [--new-database]
 *   npm run tracker:signins -- check [--local]
 *
 * Run both on the machine the tracker runs on: Doppler is shared by every
 * machine, but the database is that machine's alone.
 *
 * create  Refuses when the database file does not exist, unless
 *         --new-database is given (the first-ever setup, before the tracker
 *         has run): a missing database means the wrong machine, not a
 *         database to make.
 *         For each seat in TRACKER_SEATS (scripts/lib/expectedSecrets.mjs):
 *         a seat whose Doppler token already signs in as it, here and at
 *         the tracker (the config's trackerUrl, which Doppler's TRACKER_URL
 *         overrides), is left alone;
 *         otherwise its actor (found by kind and name, or made with
 *         tracker/admin.mjs's store calls) is given a new token, which
 *         stops any old one. Before that token goes anywhere, `GET /me` at
 *         the tracker must answer with the seat's own name and kind: if it
 *         does not, this database is not the one the tracker serves, so the
 *         token is revoked, nothing reaches Doppler, and no later seat is
 *         tried. A proven token goes straight into Doppler (`doppler secrets set`,
 *         fed on stdin), then is read back from Doppler and compared. Then
 *         the operator's actor is recorded as the one the history import
 *         (tracker/import.mjs) stands for his ClickUp seat, so the import
 *         finds him instead of making a second. Then the project (the
 *         config's productSlug, ticket prefix the config's trackerPrefix) is
 *         made, with the operator's actor as its operator, unless it exists.
 *         Running it again finishes what a failed run left, and records that
 *         mapping on a database made before it existed; it never replaces a
 *         working token.
 * check   Asks `GET /me` at the tracker with each seat's token: each must
 *         answer with that seat's own name. --local asks a private server on
 *         this machine's database instead, which says nothing about the
 *         tracker everyone uses.
 *
 * No token is ever printed: only names, ids and verdicts. The database is
 * the project config's trackerDataDir/tracker.db, or TRACKER_DB.
 */
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
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
 * Ask the tracker at `url` who a token is: `GET /me`. Returns
 * `{ status, me }` (`me` null unless it answered 200); throws, with the
 * token blanked, when it does not answer at all.
 */
export async function whoIs(url, token) {
  try {
    const res = await fetch(`${url}/me`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, me: res.ok ? await res.json() : null };
  } catch (err) {
    throw new Error(scrub(err.message, token));
  }
}

/** Why the tracker's answer is not this seat, or null when it is. */
async function notThisSeat(proveToken, token, seat) {
  let answer;
  try {
    answer = await proveToken(token);
  } catch (err) {
    return `did not answer usably (${scrub(err.message, token)})`;
  }
  const { status, me } = answer;
  if (me && me.name === seat.name && me.kind === seat.kind) return null;
  return `answered ${status}${me ? ` "${me.name}" (${me.kind})` : ''}, not "${seat.name}" (${seat.kind})`;
}

/**
 * Make what is missing. `setSecret(name, value)` and `getSecret(name)` talk
 * to Doppler (injected so tests never do); each throws on failure.
 * `proveToken(token)` asks the tracker who a token is (`whoIs`), and
 * `tracker` is `{ url, home }`: its address and the machine to run this on,
 * for the messages. Returns `{ ok, lines }`: one line per seat and one for
 * the project.
 */
export async function createSignins({ store, seats, env, project, operatorImport = null, setSecret, getSecret, proveToken, tracker }) {
  const lines = [];
  let ok = true;
  const ids = {};
  const operatorSeat = seats.find((s) => s.kind === 'human');
  const elsewhere = `this database is not the one the tracker at ${tracker.url} serves. Run this on the machine the tracker runs on${tracker.home ? ` (${tracker.home})` : ''}`;
  // Once the tracker has turned one seat down, every other seat would be
  // turned down too: stop, rather than issue tokens nobody can use.
  let stopped = false;
  for (const seat of seats) {
    if (stopped) {
      lines.push(`${seat.secret}: NOT tried, because the tracker did not accept the seat above. Nothing changed.`);
      continue;
    }
    const held = env[seat.secret];
    if (held) {
      const actor = store.actorForToken(held);
      if (actor && actor.name === seat.name && actor.kind === seat.kind) {
        const why = await notThisSeat(proveToken, held, seat);
        if (why) {
          ok = false;
          stopped = true;
          lines.push(`${seat.secret}: WRONG. Doppler's token signs in as "${seat.name}" in this database, but the tracker at ${tracker.url} ${why}: ${elsewhere}. Nothing changed.`);
          continue;
        }
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
    const why = await notThisSeat(proveToken, token, seat);
    if (why) {
      ok = false;
      stopped = true;
      let revoked = 'revoked';
      try { store.revokeToken(actor.id); } catch (err) { revoked = `NOT revoked (${err.message})`; }
      lines.push(`${seat.secret}: REFUSED. Actor ${actor.id} ("${seat.name}") was given a new token here, but the tracker at ${tracker.url} ${why}: ${elsewhere}. Nothing was written to Doppler; the new token is ${revoked}.`);
      continue;
    }
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
    let answer;
    try {
      answer = await whoIs(url, token);
    } catch (err) {
      ok = false;
      lines.push(`${seat.secret}: WRONG. GET /me did not answer usably: ${err.message}.`);
      continue;
    }
    const { status, me } = answer;
    if (me && me.name === seat.name && me.kind === seat.kind) {
      lines.push(`${seat.secret}: GET /me answers "${me.name}" (${me.kind}, actor ${me.id}). OK`);
    } else {
      ok = false;
      lines.push(`${seat.secret}: WRONG. GET /me answered ${status}${me ? ` "${me.name}" (${me.kind})` : ''}, expected "${seat.name}" (${seat.kind}).`);
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

const USAGE = `usage (under doppler run, as the npm script does), on the machine the tracker runs on:
  npm run tracker:signins -- create --name <project name> [--prefix <PREFIX>] [--new-database]
  npm run tracker:signins -- check [--local]
--prefix defaults to trackerPrefix in the project config, and must match it.
--new-database lets create make the database, for the first-ever setup only.
--local makes check ask a private server on this machine's database, not the tracker.`;

/** Start a private tracker on `store` at a free local port: `{ url, close }`. */
async function privateTracker(store) {
  const server = await startServer({ store, port: 0 });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...rest] = process.argv.slice(2);
  let values;
  try {
    ({ values } = parseArgs({
      args: rest, strict: true,
      options: { name: { type: 'string' }, prefix: { type: 'string' }, 'new-database': { type: 'boolean' }, local: { type: 'boolean' } },
    }));
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
  // The machine to run this on: the network name the config FILE holds, not
  // Doppler's same-machine TRACKER_URL override.
  let home = null;
  try {
    const filed = loadProjectConfig({ env: { ...process.env, TRACKER_URL: '' } }).trackerUrl;
    home = filed ? new URL(filed).hostname : null;
  } catch { /* the message just names no machine */ }
  const runOn = `Run it on the machine the tracker runs on${home ? ` (${home})` : ''}.`;
  const makeNew = command === 'create' && values['new-database'] && !existsSync(db);
  const usePrivate = makeNew || (command === 'check' && values.local);
  // check asks the tracker itself, which needs no database here.
  const needsDb = command === 'create' || usePrivate;
  if (needsDb && !existsSync(db) && !makeNew) {
    console.error(`There is no tracker database at ${db}, so this is not the machine the tracker runs on. Nothing was made or written. ${runOn}${command === 'create' ? ' Only for the first-ever setup, before the tracker has run anywhere, give --new-database.' : ''}`);
    process.exit(1);
  }
  const trackerUrl = config.trackerUrl?.replace(/\/+$/, '');
  if (!usePrivate && !trackerUrl) {
    console.error('Neither TRACKER_URL nor the project config\'s trackerUrl names the tracker, so no token can be proven. Nothing was made or written.');
    process.exit(1);
  }
  const seats = seatsFor(config.operatorName);
  if (makeNew && !process.env.TRACKER_DB) mkdirSync(dataDir, { recursive: true });
  const store = needsDb ? openStore(db) : null;
  let result;
  let asked = trackerUrl;
  try {
    // A brand-new database has no tracker serving it yet, so its tokens can
    // only be proven against a private server on it; --local asks for that.
    const own = usePrivate ? await privateTracker(store) : null;
    if (own) asked = own.url;
    try {
      if (command === 'create') {
        const where = ['--project', config.dopplerProject, '--config', config.dopplerConfig];
        result = await createSignins({
          store, seats, env: process.env,
          project: { slug: config.productSlug, name: values.name, prefix: values.prefix ?? config.trackerPrefix },
          operatorImport: operatorImportKey(config),
          setSecret: (name, value) => { doppler(['secrets', 'set', name, ...where, '--silent'], value); },
          getSecret: (name) => doppler(['secrets', 'get', name, ...where, '--plain']).replace(/\n$/, ''),
          proveToken: (token) => whoIs(asked, token),
          tracker: { url: asked, home },
        });
      } else {
        result = await checkSignins({ url: asked, seats, env: process.env });
      }
    } finally {
      await own?.close();
    }
  } finally {
    store?.close();
  }
  if (needsDb) console.log(`tracker database: ${db}${makeNew ? ' (made new by --new-database)' : ''}`);
  console.log(`tokens asked of: ${usePrivate ? `a private server on that database (${asked}), not the tracker everyone uses` : `the tracker at ${asked}`}`);
  for (const line of result.lines) console.log(line);
  console.log(result.ok ? `${command}: every sign-in is in order.` : `${command}: SOMETHING ABOVE FAILED.`);
  process.exit(result.ok ? 0 : 1);
}
