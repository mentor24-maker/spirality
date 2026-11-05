#!/usr/bin/env node
/**
 * Give the operator and each loop its own tracker sign-in, kept in Doppler
 * (docs/TRACKER_MVP.md, "Running it"). Run it under `doppler run` (the npm
 * script does), so the tokens already stored are in the environment:
 *
 *   npm run tracker:signins -- create --name <project name> [--prefix <PREFIX>] [--new-database] [--config <path>]
 *   npm run tracker:signins -- check [--local] [--config <path>]
 *
 * Run both on the machine the tracker runs on: Doppler is shared by every
 * machine, but the database is that machine's alone. --config names the
 * project's settings file (spirality.project.json) wherever it is, so the
 * command runs from any folder; without it, the file is found from the
 * current folder up, as before.
 *
 * create  Refuses when the database file does not exist, unless
 *         --new-database is given (the first-ever setup, before the tracker
 *         has run): a missing database means the wrong machine, not a
 *         database to make.
 *         For each seat in TRACKER_SEATS (scripts/lib/expectedSecrets.mjs):
 *         a seat whose Doppler token already signs in as it, here and at
 *         the tracker (found from the config file's trackerUrl, never
 *         Doppler's TRACKER_URL override: trackerAddress), is left alone.
 *         A held token that works in one place but not the other means this
 *         database is not the tracker's: nothing changes and no later seat
 *         is tried. Nor when the tracker does not answer.
 *         Otherwise its actor (found by kind and name, or made with
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
 *         Its GitHub repository is the config's githubRepo: a new project
 *         is made with it, and an existing project whose repository is
 *         empty has it filled in, so nobody types it on the project's Edit
 *         page. An existing project that records a DIFFERENT repository is
 *         left alone: both are printed and the run fails, because only a
 *         person decides which is wrong. Either write is read back from
 *         the database and compared with githubRepo.
 *         Running it again finishes what a failed run left, and records that
 *         mapping on a database made before it existed; it never replaces a
 *         working token.
 * check   Asks `GET /me` at the tracker (the same address) with each seat's token: each must
 *         answer with that seat's own name. --local asks a private server on
 *         this machine's database instead, which says nothing about the
 *         tracker everyone uses.
 *
 * Each project signs in with its own seats (seatsForConfig): the project
 * that runs the tracker (trackerPort set) keeps the bare lane names and the
 * operator's seat; any other project's loops are named for it
 * (`normie loop-build`) and it has no operator seat, so its create never
 * re-issues, replaces or stops another project's token. Both commands
 * refuse unless `doppler run` is for the config's own dopplerProject, the
 * only one create writes into.
 *
 * No token is ever printed: only names, ids and verdicts. The database is
 * the project config's trackerDataDir/tracker.db, or TRACKER_DB (which a
 * project that does not run the tracker must give).
 */
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from './store.mjs';
import { startServer } from './server.mjs';
import { loadProjectConfig } from '../lib/projectConfig.mjs';
import { TRACKER_SEATS } from '../scripts/lib/expectedSecrets.mjs';
import { operatorImportKey } from './import.mjs';
import { compareRepo } from '../scripts/lib/repoCheck.mjs';

/** The seats with the operator's name filled in from the project config. */
export function seatsFor(operatorName, seats = TRACKER_SEATS) {
  return seats.map((s) => ({ ...s, name: s.name ?? operatorName }));
}

/**
 * The seats one project signs in with, from its project config. Every
 * project's loops share one tracker, so they must never share an actor:
 * `create` gives a found actor a fresh token, which stops the old one.
 *
 * The project that runs the tracker service (`trackerPort` set) is its
 * home: its loops sign in under their bare lane names (`loop-build`), as
 * the first project's always have, and it holds the operator's own seat.
 * Any other project is a guest: each machine seat is named for the project
 * and the lane (`normie loop-build`), with its token in that project's own
 * Doppler project, and it has no operator seat, because the operator's
 * sign-in belongs to the home project and a guest never re-issues it
 * (docs/ONBOARDING_A_PROJECT.md, item 4). Returns `{ seats, guest }`.
 */
export function seatsForConfig(config, seats = TRACKER_SEATS) {
  if (config.trackerPort != null) return { seats: seatsFor(config.operatorName, seats), guest: false };
  return {
    seats: seats.filter((s) => s.kind === 'machine').map((s) => ({ ...s, name: `${config.productSlug} ${s.name}` })),
    guest: true,
  };
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

/**
 * Ask the tracker whether `token` signs in as `seat`. Returns `{ me }`
 * when it does, else `{ why }`, with `down` set when the tracker did not
 * answer at all or failed (a 5xx): that says nothing about the token, or
 * about which database it serves.
 */
async function askTracker(proveToken, token, seat) {
  let answer;
  try {
    answer = await proveToken(token);
  } catch (err) {
    return { down: true, why: `did not answer (${scrub(err.message, token)})` };
  }
  const { status, me } = answer;
  if (status >= 500) return { down: true, why: `did not answer usably (${status})` };
  if (me && me.name === seat.name && me.kind === seat.kind) return { me };
  return { why: `answered ${status}${me ? ` "${me.name}" (${me.kind})` : ''}, not "${seat.name}" (${seat.kind})` };
}

/**
 * Where to prove tokens: the tracker everyone uses, found from the network
 * address the config FILE holds (`filedUrl`), never from Doppler's
 * same-machine TRACKER_URL override, which on any machine asks whatever
 * tracker runs THERE. On the tracker's own machine (`ownNames` holds its
 * host name) it is asked at 127.0.0.1 on the filed port, which no other
 * tracker can hold, because Node cannot look up the machine's own `.local`
 * name (#28). Anywhere else it is asked by that name, so a dev tracker on
 * a laptop is never the one asked. Returns `{ url, home, onHome }`.
 */
export function trackerAddress(filedUrl, ownNames) {
  const filed = new URL(filedUrl);
  const home = filed.hostname.toLowerCase();
  const own = new Set(ownNames.filter(Boolean).map((n) => n.toLowerCase()));
  const onHome = own.has(home) || ['localhost', '127.0.0.1', '[::1]'].includes(home);
  const url = onHome ? `${filed.protocol}//127.0.0.1${filed.port ? `:${filed.port}` : ''}` : filed.origin;
  return { url, home, onHome };
}

/** The names this machine answers to: `mac-mini`, `mac-mini.local`, and macOS's own Bonjour name. */
export function ownHostNames() {
  const names = [hostname()];
  if (process.platform === 'darwin') {
    const r = spawnSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) names.push(r.stdout.trim());
  }
  return names.flatMap((n) => (n.includes('.') ? [n, n.split('.')[0]] : [n, `${n}.local`]));
}

/**
 * Make what is missing. `setSecret(name, value)` and `getSecret(name)` talk
 * to Doppler (injected so tests never do); each throws on failure.
 * `proveToken(token)` asks the tracker who a token is (`whoIs`), and
 * `tracker` is `{ url, home }`: its address and the machine to run this on,
 * for the messages. Returns `{ ok, lines }`: one line per seat and one for
 * the project.
 */
/**
 * The project's GitHub repository, read back from the store after a write
 * and compared with `wanted` (GitHub ignores case). Returns a FAILED line
 * when they disagree, else null.
 */
function repoReadBack(store, slug, wanted) {
  const saved = store.getProject(slug)?.repo ?? null;
  if (compareRepo({ configRepo: wanted, trackerRepo: saved }).verdict === 'same') return null;
  return `project "${slug}": FAILED. Its GitHub repository was written as ${wanted}, but reads back as ${saved ?? '(none)'}.`;
}

export async function createSignins({ store, seats, env, project, guest = false, operatorImport = null, operatorName = null, setSecret, getSecret, proveToken, tracker }) {
  const lines = [];
  let ok = true;
  const ids = {};
  const operatorSeat = seats.find((s) => s.kind === 'human');
  // A guest's seats carry its own project's name, so an actor found under
  // one is its own. A seat under a bare lane name belongs to the project
  // that runs the tracker, and with another project's tracker project on the
  // tracker it may not be this run's: a new token would stop that
  // project's sign-in. Only the home's Doppler holds the operator's own
  // token (a guest has no operator seat), so a held operator token that
  // signs in proves this run is the home's, whichever projects exist and
  // in whatever order they were made.
  const others = guest ? [] : store.listProjects().map((p) => p.slug).filter((slug) => slug !== project.slug);
  let home = false;
  const elsewhere = `this database is not the one the tracker at ${tracker.url} serves. Run this on the machine the tracker runs on${tracker.home ? ` (${tracker.home})` : ''}`;
  const down = (why) => `the tracker at ${tracker.url} ${why}, so no token can be proven. Run it again once the tracker is up`;
  // Once the tracker has turned one seat down, every other seat would be
  // turned down too: stop, rather than issue tokens nobody can use.
  let stopped = false;
  for (const seat of seats) {
    if (stopped) {
      lines.push(`${seat.secret}: NOT tried, because of the seat above. Nothing changed.`);
      continue;
    }
    const held = env[seat.secret];
    if (held) {
      const actor = store.actorForToken(held);
      const here = actor && actor.name === seat.name && actor.kind === seat.kind;
      const there = await askTracker(proveToken, held, seat);
      if (there.down) {
        ok = false;
        stopped = true;
        lines.push(`${seat.secret}: NOT checked: ${down(there.why)}. Nothing changed.`);
        continue;
      }
      if (here && there.me) {
        ids[seat.secret] = actor.id;
        if (seat === operatorSeat) home = true;
        lines.push(`${seat.secret}: already signs in as "${actor.name}" (actor ${actor.id}), left alone.`);
        continue;
      }
      ok = false;
      if (here || there.me) {
        // It works in one place and not the other: two databases, and this
        // one is not the tracker's. Every other seat would say the same.
        stopped = true;
        lines.push(here
          ? `${seat.secret}: WRONG. Doppler's token signs in as "${seat.name}" in this database, but the tracker at ${tracker.url} ${there.why}: ${elsewhere}. Nothing changed.`
          : `${seat.secret}: WRONG. Doppler's token signs in as "${seat.name}" at the tracker at ${tracker.url}, so it is good, but not in this database${actor ? ` (here it is "${actor.name}")` : ''}: ${elsewhere}. Nothing changed; keep that secret.`);
        continue;
      }
      lines.push(`${seat.secret}: REFUSED. Doppler holds a token that signs in as "${seat.name}" neither here${actor ? ` (it is "${actor.name}")` : ''} nor at the tracker at ${tracker.url} (it ${there.why}). Nothing replaced; it is stale, so remove that secret in Doppler and run create again.`);
      continue;
    }
    // A seat keeps one actor: a later run (a lost token, a failed run) gives
    // that actor a fresh token, which also stops the old one signing in.
    // The operator an earlier import already made is the one to keep.
    const kept = (seat === operatorSeat && importedOperator(store, operatorImport, seat)) || store.actorsNamed({ kind: seat.kind, name: seat.name })[0];
    if (kept && others.length && !home) {
      ok = false;
      lines.push(`${seat.secret}: REFUSED. Actor ${kept.id} ("${seat.name}") already exists, this tracker also holds project${others.length > 1 ? 's' : ''} ${others.map((o) => `"${o}"`).join(', ')}, and this Doppler project holds no working operator sign-in to show this is the project that runs the tracker: that actor may be another project's, and a new token would stop its sign-in. Nothing changed. If this project does not run the tracker, its config must not set trackerPort, so its seats get names of their own; if it does, put the operator's working token back in ${operatorSeat?.secret ?? 'its Doppler project'} and run create again.`);
      continue;
    }
    const actor = kept ?? store.createActor({ kind: seat.kind, name: seat.name });
    const token = store.issueToken(actor.id);
    const proof = await askTracker(proveToken, token, seat);
    if (!proof.me) {
      ok = false;
      stopped = true;
      let revoked = 'revoked';
      try { store.revokeToken(actor.id); } catch (err) { revoked = `NOT revoked (${err.message})`; }
      lines.push(`${seat.secret}: REFUSED. Actor ${actor.id} ("${seat.name}") was given a new token here, but ${proof.down ? down(proof.why) : `the tracker at ${tracker.url} ${proof.why}: ${elsewhere}`}. Nothing was written to Doppler; the new token is ${revoked}.`);
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

  // A guest project has no operator seat: its project's operator is the
  // operator's existing actor, found by name, never given a token here.
  let operatorId = operatorSeat ? ids[operatorSeat.secret] : null;
  let noOperator = operatorSeat && operatorId == null ? 'because the operator has no working sign-in yet' : null;
  if (!operatorSeat && operatorName) {
    const named = store.actorsNamed({ kind: 'human', name: operatorName });
    if (named.length === 1) operatorId = named[0].id;
    else noOperator = named.length ? `because ${named.length} people are named "${operatorName}" and it cannot tell which is the operator` : `because nobody named "${operatorName}" signs in to this tracker yet: run create for the project that runs the tracker first`;
  }
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
  const repo = project.repo || null;
  if (existing) {
    lines.push(`project "${existing.slug}": already exists (tickets ${existing.prefix}-…, operator ${existing.operator ?? '(none)'}), left alone.`);
    if (operatorId != null && existing.operator !== operatorId) {
      ok = false;
      lines.push(`project "${existing.slug}": WRONG. Its operator is actor ${existing.operator ?? '(none)'}, but the operator signs in as actor ${operatorId}.`);
    }
    if (repo) {
      const { verdict } = compareRepo({ configRepo: repo, trackerRepo: existing.repo });
      if (verdict === 'same') {
        lines.push(`project "${existing.slug}": GitHub repository already ${existing.repo}, as githubRepo says.`);
      } else if (verdict === 'different') {
        ok = false;
        lines.push(`project "${existing.slug}": REFUSED. It records the GitHub repository ${existing.repo}, but githubRepo in the settings file is ${repo}. Nothing was written; correct whichever is wrong.`);
      } else {
        let failed = null;
        try {
          store.updateProject(existing.slug, { repo });
          failed = repoReadBack(store, existing.slug, repo);
        } catch (err) {
          failed = `project "${existing.slug}": FAILED. Its GitHub repository could not be filled in with ${repo}: ${err.message}`;
        }
        if (failed) {
          ok = false;
          lines.push(failed);
        } else {
          lines.push(`project "${existing.slug}": GitHub repository was empty, now ${repo} (read back).`);
        }
      }
    }
  } else if (!project.name || !project.prefix) {
    ok = false;
    lines.push(`project "${project.slug}": NOT made. Give --name and a prefix (--prefix, or trackerPrefix in the project config) to make it.`);
  } else if (noOperator) {
    ok = false;
    lines.push(`project "${project.slug}": NOT made, ${noOperator}.`);
  } else {
    try {
      const made = store.createProject({ slug: project.slug, name: project.name, prefix: project.prefix, operator: operatorId, repo });
      lines.push(`project "${made.slug}": made, "${made.name}", tickets ${made.prefix}-1 onwards, operator ${made.operator ?? '(none)'}, GitHub repository ${made.repo ?? '(none)'}.`);
      const failed = repo && repoReadBack(store, made.slug, repo);
      if (failed) {
        ok = false;
        lines.push(failed);
      }
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
    const { me, why } = await askTracker((t) => whoIs(url, t), token, seat);
    if (me) {
      lines.push(`${seat.secret}: GET /me answers "${me.name}" (${me.kind}, actor ${me.id}). OK`);
    } else {
      ok = false;
      lines.push(`${seat.secret}: WRONG. GET /me ${why}.`);
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
  npm run tracker:signins -- create --name <project name> [--prefix <PREFIX>] [--new-database] [--config <path>]
  npm run tracker:signins -- check [--local] [--config <path>]
--config names the project's settings file, from any folder (default: found from this folder up).
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
      options: { name: { type: 'string' }, prefix: { type: 'string' }, 'new-database': { type: 'boolean' }, local: { type: 'boolean' }, config: { type: 'string' } },
    }));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(1);
  }
  if (command !== 'create' && command !== 'check') {
    console.error(USAGE);
    process.exit(1);
  }
  // --config names the settings file wherever it is; without it, it is
  // found from the current folder up.
  const file = values.config;
  let config;
  try {
    config = loadProjectConfig({ file });
  } catch (err) {
    console.error(`${err.message}. Nothing was made or written.${file ? '' : ' Give --config <path to spirality.project.json> to run from another folder.'}`);
    process.exit(1);
  }
  if (values.prefix && config.trackerPrefix && values.prefix !== config.trackerPrefix) {
    console.error(`--prefix ${values.prefix} does not match trackerPrefix "${config.trackerPrefix}" in the project config; the history import numbers tickets with that one. Leave --prefix off.`);
    process.exit(1);
  }
  const dataDir = config.trackerDataDir?.replace(/^~(?=\/|$)/, homedir());
  const db = process.env.TRACKER_DB || (dataDir && join(dataDir, 'tracker.db'));
  if (!db) {
    console.error('The project config names no trackerDataDir, and TRACKER_DB is not set: there is no tracker database to use. A project that does not run the tracker sets TRACKER_DB to the tracker\'s own database, on the machine it runs on.');
    process.exit(1);
  }
  if (!process.env.DOPPLER_PROJECT) {
    console.error(`Run this under doppler run, so the tokens already stored are seen:\n${USAGE}`);
    process.exit(1);
  }
  // The tracker everyone uses, from the network address the config FILE
  // holds, not Doppler's same-machine TRACKER_URL override (trackerAddress).
  const filed = loadProjectConfig({ file, env: { ...process.env, TRACKER_URL: '' } }).trackerUrl;
  const tracker = filed ? trackerAddress(filed, ownHostNames()) : null;
  const home = tracker?.home ?? null;
  const runOn = `Run it on the machine the tracker runs on${home ? ` (${home})` : ''}.`;
  const makeNew = command === 'create' && values['new-database'] && !existsSync(db);
  const usePrivate = makeNew || (command === 'check' && values.local);
  // check asks the tracker itself, which needs no database here.
  const needsDb = command === 'create' || usePrivate;
  if (needsDb && !existsSync(db) && !makeNew) {
    console.error(`There is no tracker database at ${db}, so this is not the machine the tracker runs on. Nothing was made or written. ${runOn}${command === 'create' ? ' Only for the first-ever setup, before the tracker has run anywhere, give --new-database.' : ''}`);
    process.exit(1);
  }
  const trackerUrl = tracker?.url;
  if (!usePrivate && !trackerUrl) {
    console.error('The project config file names no trackerUrl, so there is no tracker to prove a token at. Nothing was made or written.');
    process.exit(1);
  }
  if (process.env.DOPPLER_PROJECT !== config.dopplerProject) {
    console.error(`This runs under Doppler project "${process.env.DOPPLER_PROJECT}", but the project config names "${config.dopplerProject}": the tokens seen and written would be another project's. Nothing was made or written. Run it under doppler run --project ${config.dopplerProject}.`);
    process.exit(1);
  }
  const { seats, guest } = seatsForConfig(config);
  if (guest && makeNew) {
    console.error('This project does not run the tracker (its config sets no trackerPort), so it never makes the tracker\'s database. Nothing was made or written. Run create for the project that runs the tracker first.');
    process.exit(1);
  }
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
          project: { slug: config.productSlug, name: values.name, prefix: values.prefix ?? config.trackerPrefix, repo: config.githubRepo },
          guest,
          operatorImport: guest ? null : operatorImportKey(config),
          operatorName: guest ? config.operatorName : null,
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
  console.log(`tokens asked of: ${usePrivate ? `a private server on that database (${asked}), not the tracker everyone uses` : `the tracker at ${asked} (${tracker.onHome ? `this machine is ${home}, where it runs` : `it runs on ${home}, not this machine`})`}`);
  for (const line of result.lines) console.log(line);
  console.log(result.ok ? `${command}: every sign-in is in order.` : `${command}: SOMETHING ABOVE FAILED.`);
  process.exit(result.ok ? 0 : 1);
}
