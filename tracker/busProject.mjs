#!/usr/bin/env node
/**
 * Give a project its bus (SP-204): the tracker project its alarms and
 * reports go to (docs/TRACKER_MVP.md, "The bus"), named as `busProject` in
 * its settings file. The setup wizard's `bus` step runs it; it can be run on
 * its own too:
 *
 *   TRACKER_DB=<the tracker's database> npm run tracker:bus -- --config <settings file> --name <project name>
 *
 * Run it on the machine the tracker runs on: the database is that machine's
 * alone. It writes the database directly, as `tracker:signins create` does,
 * because a loop's token may not add a project (only a person may, on the
 * Projects page).
 *
 * When the settings file names no busProject, the project has no bus and
 * nothing is done. Otherwise:
 *
 *   - The bus project is made unless it is there: slug busProject, name
 *     "<project name> bus", ticket prefix "<trackerPrefix>BUS", operator the
 *     settings file's operatorUserId (so the operator is its member and sees
 *     it), no GitHub repository (nothing on the bus is ever built). It is
 *     read back.
 *   - One that is there is left alone. It must be a bus for this operator:
 *     a different operator is refused, because it may be another project's.
 *   - Every loop sign-in of the project (seatsForConfig) must already exist
 *     (the sign-ins step makes them) and see the bus project. A machine sees
 *     every project, so there is nothing to grant; this is the read-back that
 *     the loops can read and write it.
 *
 * Running it again changes nothing. Exit 0 in order (or no bus), 1 a step
 * failed or a check did not pass, 2 usage.
 */
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from './store.mjs';
import { loadProjectConfig } from '../lib/projectConfig.mjs';
import { seatsForConfig } from './signins.mjs';

/** The bus project's name and ticket prefix, made from the project's own. */
export function busShape(config, projectName) {
  return { slug: config.busProject, name: `${projectName} bus`, prefix: `${config.trackerPrefix}BUS` };
}

/**
 * Make the bus project if it is missing, and check the loops can use it.
 * `config` is the project's checked settings (loadProjectConfig);
 * `projectName` what the tracker shows for the project. Returns
 * `{ ok, made, lines }`: `made` true only when this run made the project.
 */
export function ensureBusProject({ store, config, projectName }) {
  const lines = [];
  if (!config.busProject) return { ok: true, made: false, lines: [`${config.projectSlug} has no bus (its settings name no busProject); nothing to do.`] };
  const want = busShape(config, projectName);
  const operator = Number(config.operatorUserId);
  const person = Number.isInteger(operator) ? store.getActor(operator) : null;
  if (!person || person.kind !== 'human') {
    return { ok: false, made: false, lines: [`bus project "${want.slug}": NOT made. operatorUserId ${config.operatorUserId} is not a person on this tracker.`] };
  }
  let made = false;
  const there = store.getProject(want.slug);
  if (there) {
    if (there.operator !== operator) {
      return { ok: false, made, lines: [`bus project "${want.slug}": REFUSED. It is there, but its operator is actor ${there.operator ?? '(none)'}, not ${person.name} (actor ${operator}): it may be another project's. Nothing changed; give this project another busProject, or correct it on the Projects page.`] };
    }
    lines.push(`bus project "${there.slug}": already there ("${there.name}", tickets ${there.prefix}-…, operator ${person.name}), left alone.`);
  } else {
    if (!projectName) return { ok: false, made, lines: [`bus project "${want.slug}": NOT made. Give --name, the project's name, to name it.`] };
    try {
      store.createProject({ slug: want.slug, name: want.name, prefix: want.prefix, operator });
    } catch (err) {
      return { ok: false, made, lines: [`bus project "${want.slug}": NOT made: ${err.message}`] };
    }
    const back = store.getProject(want.slug);
    if (!back || back.name !== want.name || back.prefix !== want.prefix || back.operator !== operator) {
      return { ok: false, made: true, lines: [`bus project "${want.slug}": FAILED. It was written, but reads back as ${back ? `"${back.name}", ${back.prefix}, operator ${back.operator}` : 'missing'}.`] };
    }
    made = true;
    lines.push(`bus project "${back.slug}": made, "${back.name}", tickets ${back.prefix}-1 onwards, operator ${person.name} (read back).`);
  }
  let ok = true;
  if (!store.projectsVisibleTo(operator).includes(want.slug)) {
    ok = false;
    lines.push(`bus project "${want.slug}": WRONG. ${person.name} (actor ${operator}) does not see it.`);
  }
  for (const seat of seatsForConfig(config).seats.filter((s) => s.kind === 'machine')) {
    const found = store.actorsNamed({ kind: 'machine', name: seat.name });
    if (found.length !== 1) {
      ok = false;
      lines.push(`${seat.name}: ${found.length ? `${found.length} sign-ins have this name` : 'no such sign-in yet (the sign-ins step makes it)'}, so it cannot be shown to reach the bus.`);
    } else if (!store.projectsVisibleTo(found[0].id).includes(want.slug)) {
      ok = false;
      lines.push(`${seat.name}: WRONG. Actor ${found[0].id} does not see "${want.slug}".`);
    } else {
      lines.push(`${seat.name}: sees "${want.slug}" (actor ${found[0].id}).`);
    }
  }
  return { ok, made, lines };
}

const USAGE = 'usage: TRACKER_DB=<database> npm run tracker:bus -- --config <settings file> --name <project name>';

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let values;
  try {
    ({ values } = parseArgs({ args: process.argv.slice(2), strict: true, options: { config: { type: 'string' }, name: { type: 'string' } } }));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(2);
  }
  if (!values.config) { console.error(USAGE); process.exit(2); }
  let config;
  try {
    config = loadProjectConfig({ file: values.config, env: {} });
  } catch (err) {
    console.error(`${err.message}. Nothing was made.`);
    process.exit(1);
  }
  if (!config.busProject) {
    console.log(`${config.projectSlug} has no bus (its settings name no busProject); nothing to do.`);
    process.exit(0);
  }
  const dataDir = config.trackerDataDir?.replace(/^~(?=\/|$)/, homedir());
  const db = process.env.TRACKER_DB || (dataDir && join(dataDir, 'tracker.db'));
  if (!db || !existsSync(db)) {
    console.error(`There is no tracker database at ${db ?? '(none named: set TRACKER_DB)'}, so this is not the machine the tracker runs on. Nothing was made.`);
    process.exit(1);
  }
  const store = openStore(db);
  let result;
  try {
    result = ensureBusProject({ store, config, projectName: values.name });
  } finally {
    store.close();
  }
  console.log(`tracker database: ${db}`);
  for (const line of result.lines) console.log(line);
  console.log(result.ok ? 'bus: in order.' : 'bus: SOMETHING ABOVE FAILED.');
  process.exit(result.ok ? 0 : 1);
}
