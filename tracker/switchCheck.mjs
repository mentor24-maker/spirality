#!/usr/bin/env node
/**
 * Is it safe to switch this product's loops from ClickUp to the tracker?
 * One read-only command for the runbook in docs/TRACKER_MVP.md, "Switching
 * a product over":
 *
 *   npm run tracker:switch-check            (Doppler supplies the tokens)
 *
 * Four checks, each OK or what is wrong:
 *
 *  1. tracker service   the tracker answers at its address (the config's
 *                       trackerUrl, else 127.0.0.1:<trackerPort>).
 *  2. sign-ins          each seat's token (TRACKER_SEATS) signs in as itself:
 *                       against the running tracker when it answers, else
 *                       against a throwaway server on a copy of the database.
 *  3. queues match      every ticket in ClickUp's Loop Queue is in the
 *                       tracker with the same status, and the tracker holds
 *                       no ticket ClickUp does not.
 *  4. dry-run import    `tracker/import.mjs` into a copy of the database
 *                       reads everything and refuses nothing.
 *
 * It writes NOTHING: ClickUp is only read (through the ClickUp tracker), and
 * the database is only ever opened as a throwaway copy, so the real file is
 * untouched. No token is printed.
 *
 * Exit codes: 0 every check passed, safe to switch; 1 something did not
 * (each one named), or the check itself could not run.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from './store.mjs';
import { startServer } from './server.mjs';
import { checkSignins, seatsFor } from './signins.mjs';
import { dryRunCopy, formatReport, importLoopQueue, readAllTasks, SOURCE } from './import.mjs';
import { createClickupTracker } from '../scripts/tracker/clickupTracker.mjs';
import { loadProjectConfig, ProjectConfigError } from '../lib/projectConfig.mjs';
import loopStatuses from '../lib/loopStatuses.js';

const { DISPLAY, TERMINAL_STATUSES, statusOf } = loopStatuses;

/** How many tickets of one kind of problem to name before summing up the rest. */
const NAMED_PER_KIND = 15;

/** How long the tracker gets to answer before it counts as not running. */
const ANSWER_TIMEOUT_MS = 3000;

const shown = (status) => DISPLAY[status] ?? `"${status}"`;

/** The address the loops will reach the tracker at, or null when the config names none. */
export function trackerAddress(config) {
  if (config.trackerUrl) return String(config.trackerUrl).replace(/\/+$/, '');
  if (config.trackerPort) return `http://127.0.0.1:${config.trackerPort}`;
  return null;
}

/** The tracker database: TRACKER_DB, else the config's trackerDataDir/tracker.db, else null. */
export function databasePath(config, env = process.env) {
  if (env.TRACKER_DB) return env.TRACKER_DB;
  const dir = config.trackerDataDir?.replace(/^~(?=\/|$)/, homedir());
  return dir ? join(dir, 'tracker.db') : null;
}

/**
 * Compare ClickUp's Loop Queue (`clickupTasks`, list-shaped) with the
 * tracker's tickets for the product (`trackerTickets`, store-shaped).
 * `importedFrom` maps a tracker ticket id to the ClickUp id it was imported
 * from. Answers `{ ok, lines, missing, extra, mismatched }`.
 */
export function compareQueues({ clickupTasks, trackerTickets, importedFrom }) {
  const byClickupId = new Map();
  const extra = [];
  for (const t of trackerTickets) {
    const src = importedFrom.get(t.id);
    if (src == null) extra.push(`${t.id} "${t.name}": in the tracker, but not imported from ClickUp`);
    else byClickupId.set(src, t);
  }
  const inClickup = new Set(clickupTasks.map((task) => String(task.id)));
  for (const [src, t] of byClickupId) {
    if (!inClickup.has(src)) extra.push(`${t.id} "${t.name}": imported from ClickUp ticket ${src}, which is no longer in the Loop Queue`);
  }

  const missing = [];
  const mismatched = [];
  for (const task of clickupTasks) {
    const t = byClickupId.get(String(task.id));
    const status = statusOf(task);
    if (!t) missing.push(`${task.id} "${task.name}" (${shown(status)}): in ClickUp, not in the tracker`);
    else if (t.status !== status) mismatched.push(`${task.id} "${task.name}": ClickUp says ${shown(status)}, the tracker (${t.id}) says ${shown(t.status)}`);
  }

  const open = clickupTasks.filter((task) => !TERMINAL_STATUSES.includes(statusOf(task))).length;
  const lines = [`ClickUp's Loop Queue: ${clickupTasks.length} ticket(s), ${open} open. The tracker: ${trackerTickets.length} ticket(s).`];
  const name = (what, list) => {
    if (!list.length) return;
    lines.push(`${what} (${list.length}):`);
    for (const l of list.slice(0, NAMED_PER_KIND)) lines.push(`  - ${l}`);
    if (list.length > NAMED_PER_KIND) lines.push(`  - and ${list.length - NAMED_PER_KIND} more`);
  };
  name('MISSING from the tracker', missing);
  name('EXTRA in the tracker', extra);
  name('STATUS DIFFERS', mismatched);
  const ok = !missing.length && !extra.length && !mismatched.length;
  if (ok) lines.push('Every ticket is in both, with the same status.');
  else if (missing.length === clickupTasks.length && !extra.length) lines.push('Nothing is imported yet: run `npm run tracker:import -- --db <database>` (the runbook, step 3).');
  return { ok, lines, missing, extra, mismatched };
}

/**
 * Is the tracker at `url`? `GET /me` with no token answers 401: the
 * tracker's own answer to a knock with no key (the installer's `--status`
 * asks the same). Answers `{ answers, why }`.
 */
async function probe(url, fetchImpl) {
  try {
    const res = await fetchImpl(`${url}/me`, { signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) });
    if (res.status === 401) return { answers: true, why: 'GET /me without a token: HTTP 401, as the tracker answers' };
    return { answers: false, why: `something answered HTTP ${res.status} to GET /me, so it is not the tracker` };
  } catch (err) {
    return { answers: false, why: err?.cause?.code || err?.name || String(err?.message || err) };
  }
}

/**
 * Run the four checks. `clickup` is a ClickUp tracker (or a fake answering
 * the same reads); `db` the real database's path, only ever copied. Answers
 * `{ ok, sections: [{ name, ok, lines }] }`.
 */
export async function runSwitchCheck({ config, env, db, clickup, fetchImpl = fetch }) {
  const sections = [];
  const section = (name, ok, lines) => { sections.push({ name, ok, lines }); return ok; };

  const url = trackerAddress(config);
  let live = false;
  if (!url) {
    section('tracker service', false, ['The project config names neither trackerUrl nor trackerPort: there is no tracker to switch to.']);
  } else {
    const p = await probe(url, fetchImpl);
    live = p.answers;
    section('tracker service', live, [live
      ? `${url} answers (${p.why}).`
      : `NOTHING ANSWERS at ${url} (${p.why}). Install and start the tracker service first (the runbook, step 1).`]);
  }
  section('config', true, [`tracker is "${config.tracker ?? 'clickup'}"${config.trackerUrl ? `, trackerUrl ${config.trackerUrl}` : ', no trackerUrl yet'}. The switch sets tracker "api" and trackerUrl "${url ?? '(none)'}".`]);

  const haveDb = Boolean(db) && existsSync(db);
  if (!haveDb) section('database', false, [`There is no tracker database at ${db ?? '(no path: set trackerDataDir)'}. Make the sign-ins first: \`npm run tracker:signins -- create --name <project name>\`.`]);

  // A copy of the database (an empty one when there is none): the real file is never opened.
  const scratch = dryRunCopy(haveDb ? db : '');
  const store = openStore(scratch.path);
  try {
    // 2. Sign-ins.
    const seats = seatsFor(config.operatorName);
    if (live) {
      const r = await checkSignins({ url, seats, env });
      section('sign-ins', r.ok, ['Checked against the running tracker.', ...r.lines]);
    } else if (haveDb) {
      const server = await startServer({ store, port: 0 });
      try {
        const r = await checkSignins({ url: `http://127.0.0.1:${server.address().port}`, seats, env });
        section('sign-ins', r.ok, ['Checked against a copy of the database, because the tracker is not running.', ...r.lines]);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    } else {
      section('sign-ins', false, ['Not checked: there is no database to check them against.']);
    }

    // 3. Queues match, before the dry run adds anything to the copy.
    try {
      const clickupTasks = await readAllTasks(clickup, config.loopQueueListId);
      const trackerTickets = store.getProject(config.productSlug) ? store.listTickets(config.productSlug) : [];
      const importedFrom = new Map(store.listImportedIds(SOURCE).filter((r) => r.kind === 'ticket').map((r) => [r.newId, r.sourceId]));
      const r = compareQueues({ clickupTasks, trackerTickets, importedFrom });
      section('queues match', r.ok, r.lines);
    } catch (err) {
      section('queues match', false, [`Could not compare: ${err.message}`]);
    }

    // 4. Dry-run import into the same copy.
    try {
      const r = await importLoopQueue({ tracker: clickup, store, config });
      section('dry-run import', r.refusals.length === 0, [
        ...formatReport(r, { dryRun: true }).split('\n'),
        r.refusals.length ? 'The real import would refuse the items above.' : 'The real import would copy all of it.',
      ]);
    } catch (err) {
      section('dry-run import', false, [`FAILED: ${err.message}`]);
    }
  } finally {
    store.close();
    scratch.cleanup();
  }
  return { ok: sections.every((s) => s.ok), sections };
}

/** The report, one block per check. */
export function formatSwitchCheck({ ok, sections }) {
  const out = [];
  for (const s of sections) {
    out.push(`${s.ok ? 'OK     ' : 'NOT OK '} ${s.name}`);
    for (const l of s.lines) out.push(`        ${l}`);
  }
  out.push('', ok ? 'switch-check: every check passed. Safe to switch.' : 'switch-check: NOT SAFE TO SWITCH yet (see NOT OK above).');
  return out.join('\n');
}

async function main() {
  let config;
  try {
    config = loadProjectConfig();
  } catch (err) {
    if (!(err instanceof ProjectConfigError)) throw err;
    console.error(`tracker:switch-check: the project config is not usable — ${err.message}`);
    return 1;
  }
  if (!process.env.CLICKUP_API_TOKEN || !process.env.DOPPLER_PROJECT) {
    console.error(`tracker:switch-check: run it as \`npm run tracker:switch-check\`, so Doppler (${config.dopplerProject}/${config.dopplerConfig}) supplies the ClickUp token and the sign-ins.`);
    return 1;
  }
  const clickup = createClickupTracker({
    token: process.env.CLICKUP_API_TOKEN,
    apiBase: process.env.CLICKUP_API_BASE,
    timeoutMs: process.env.CLICKUP_HTTP_TIMEOUT_MS,
  });
  const db = databasePath(config);
  console.log(`Switch check for ${config.productSlug}: ClickUp list ${config.loopQueueListId}, tracker database ${db ?? '(none)'} (read-only: nothing is written anywhere)\n`);
  try {
    const result = await runSwitchCheck({ config, env: process.env, db, clickup });
    console.log(formatSwitchCheck(result));
    return result.ok ? 0 : 1;
  } finally {
    clickup.reportLimits();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main();
}
