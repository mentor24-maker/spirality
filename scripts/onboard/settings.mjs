#!/usr/bin/env node
/**
 * Step 1 of setting up a product on Spirality: write the product's settings
 * file (`spirality.project.json`) from its answers file
 * (docs/onboarding/SETUP_REVIEW.md, part 3). The settings come from
 * lib/onboardSettings.mjs; this is the part that reads the tracker and
 * touches the disk.
 *
 *   npm run onboard:settings -- write --answers <answers file> --out <folder>
 *   npm run onboard:settings -- fill-machine-user --config <settings file>
 *
 * `write` runs from the tracker home's own folder (the product whose
 * settings file sets `trackerPort`, today Spirality). It finds the
 * operator's tracker actor by the home's operatorName, and the product's
 * build-loop sign-in (`<slug> loop-build`) if the sign-ins step has already
 * made it; if not, machineUserId is the placeholder "0" and the line says
 * so. It writes `<folder>/spirality.project.json`, making the folder if
 * need be. It never writes over a settings file of another product (so
 * never the tracker home's own), and it is meant for a scratch folder: the
 * copy into the product's repository is a later step.
 *
 * `fill-machine-user` runs after the sign-ins step. It reads the settings
 * file it is given, finds `<slug> loop-build` at the tracker that file
 * names, and writes its id in as machineUserId, changing nothing else.
 * The npm script runs it under the PRODUCT's Doppler project
 * (scripts/with_doppler.mjs reads `--config`), which the sign-ins step
 * makes; run before that step, Doppler stops it with "Could not find
 * requested project".
 *
 * Every write is read back through the reader every loop uses
 * (loadProjectConfig) and compared, field by field, with what was meant. A
 * step that did not stick prints `FAILED: <step>: <what was seen>` and
 * names the field. Only GETs go to the tracker; no token is printed.
 *
 * Exit 0 written (or already so), 1 FAILED, 2 usage, 3 the build-loop
 * sign-in does not exist yet (fill-machine-user only: run the sign-ins
 * step first).
 */
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_FILE, findConfigFile, loadProjectConfig, ProjectConfigError, validateProjectConfig } from '../../lib/projectConfig.mjs';
import { AnswersError, expandHome, loadAnswers } from '../../lib/onboardAnswers.mjs';
import {
  SettingsError, actorNamed, fieldsThatDiffer, machineUserPending, settingsFromAnswers, settingsText, withMachineUser,
} from '../../lib/onboardSettings.mjs';
import { trackerTokenEnv } from '../tracker/apiTracker.mjs';
import { seatsForConfig } from '../../tracker/signins.mjs';
import { TRACKER_SEATS } from '../lib/expectedSecrets.mjs';
import { mainCheckoutOf } from './look.mjs';

export const USAGE = [
  'usage: npm run onboard:settings -- write --answers <answers file> --out <folder>',
  '       npm run onboard:settings -- fill-machine-user --config <settings file>',
].join('\n');

const WRITE = 'write the settings file';
const FILL = 'fill in machineUserId';

/** The product's build-loop sign-in's name: `<slug> loop-build` (seatsForConfig). */
export function buildSeatName(productSlug, operatorName) {
  const buildSecret = TRACKER_SEATS.find((s) => s.kind === 'machine' && s.name === 'loop-build')?.secret;
  const seat = seatsForConfig({ trackerPort: null, productSlug, operatorName }).seats.find((s) => s.secret === buildSecret);
  if (!seat) throw new SettingsError('the sign-ins list names no build-loop seat');
  return seat.name;
}

/**
 * The tracker's actors, read with GETs only: the people (`/people`) for the
 * operator, and every actor, loops too, from `/search`'s "Created by"
 * choices. `get(path)` answers `{ status, json }` or throws when the
 * tracker does not answer. Throws SettingsError saying which read failed.
 */
export async function readActors(get, apiUrl) {
  const ask = async (path) => {
    let r;
    try { r = await get(path); } catch (err) { throw new SettingsError(`the tracker at ${apiUrl} did not answer ${path} (${err.message || err})`); }
    if (r.status !== 200) throw new SettingsError(`the tracker at ${apiUrl} answered ${path} with ${r.status}${r.json?.message ? `: ${r.json.message}` : ''}`);
    return r.json;
  };
  const people = (await ask('/people'))?.people;
  if (!Array.isArray(people)) throw new SettingsError(`the tracker at ${apiUrl} answered /people, but not with its list of people`);
  const options = (await ask('/search'))?.filters?.find((f) => f.key === 'createdBy')?.options;
  if (!Array.isArray(options)) throw new SettingsError(`the tracker at ${apiUrl} answered /search, but not with its list of actors`);
  return {
    people: people.map((p) => ({ id: p.id, name: p.name })),
    actors: options.map((o) => ({ id: o.value, name: o.label })),
  };
}

/**
 * Write `settings` to `file` and read it back through loadProjectConfig,
 * the reader every loop uses. Returns the fields where what was read back
 * differs from what was meant, both checked the same way (empty: it stuck).
 */
export function writeAndReadBack(file, settings, { write = writeFileSync, mkdir = mkdirSync, load = loadProjectConfig } = {}) {
  mkdir(dirname(file), { recursive: true });
  write(file, settingsText(settings));
  // `env: {}`: the read-back is of the file, never an environment override.
  const back = load({ file, env: {} });
  return fieldsThatDiffer(validateProjectConfig(settings, { file, env: {} }), back);
}

/** The settings file a `--out` folder already holds, parsed, or null. Throws SettingsError when unreadable. */
function existingSettings(file, readText) {
  const text = readText(file);
  if (text == null) return null;
  try { return JSON.parse(text); } catch (err) { throw new SettingsError(`${file} is already there and is not valid JSON (${err.message}); move it away first`); }
}

/**
 * `write`: answers + tracker -> `<out>/spirality.project.json`. Returns
 * `{ code, lines }`. `deps`: get(path), homeConfig, homeRoot, readText,
 * and optionally write, mkdir, load (writeAndReadBack's).
 */
export async function runWrite({ answersPath, outDir }, deps) {
  const lines = [];
  const failed = (why) => ({ code: 1, lines: [...lines, `FAILED: ${WRITE}: ${why}`] });
  const { homeConfig } = deps;
  let answers;
  try {
    answers = loadAnswers(answersPath, { homeConfig, homeRoot: deps.homeRoot });
  } catch (err) {
    if (err instanceof AnswersError) return failed(`the answers file is not usable — ${err.message}`);
    throw err;
  }
  const file = join(outDir, CONFIG_FILE);
  try {
    const before = existingSettings(file, deps.readText);
    if (before && before.productSlug !== answers.productSlug) {
      return failed(`${file} is ${before.productSlug ? `the settings file of "${before.productSlug}"` : 'another settings file'}, not ${answers.productSlug}'s; it is left alone. Name an empty scratch folder with --out.`);
    }
    const { people, actors } = await readActors(deps.get, homeConfig.trackerApiUrl);
    const operatorUserId = actorNamed(people, homeConfig.operatorName);
    if (!operatorUserId) return failed(`the tracker has no person named "${homeConfig.operatorName}" (the tracker home's operatorName) to hand tickets to`);
    const seat = buildSeatName(answers.productSlug, homeConfig.operatorName);
    const machineUserId = actorNamed(actors, seat);
    const settings = settingsFromAnswers(answers, homeConfig, { operatorUserId, machineUserId });
    if (before) {
      const changed = fieldsThatDiffer(before, settings);
      lines.push(changed.length ? `${file} was already there; rewriting ${changed.join(', ')}` : `${file} was already there, with the same settings`);
    }
    const off = writeAndReadBack(file, settings, deps);
    if (off.length) return failed(`${file} read back different from what was written, in ${off.join(', ')}`);
    lines.push(`Wrote ${file} for ${answers.productName} (${answers.githubRepo}), checked by the settings reader every loop uses.`);
    lines.push(`  operatorUserId ${operatorUserId}: the tracker's person "${homeConfig.operatorName}"`);
    lines.push(machineUserPending(settings)
      ? `  machineUserId ${settings.machineUserId}: a placeholder. "${seat}" is not in the tracker yet; after the sign-ins step, run: npm run onboard:settings -- fill-machine-user --config ${file}`
      : `  machineUserId ${machineUserId}: the tracker's "${seat}"`);
    return { code: 0, lines };
  } catch (err) {
    if (err instanceof SettingsError || err instanceof ProjectConfigError) return failed(err.message);
    if (err?.code) return failed(`${file}: ${err.code} (${err.message})`);
    throw err;
  }
}

/**
 * `fill-machine-user`: find `<slug> loop-build` at the tracker the settings
 * file names and write its id in. Returns `{ code, lines }`. `deps`: get,
 * readText, and optionally write, mkdir, load.
 */
export async function runFill({ configPath }, deps) {
  const lines = [];
  const load = deps.load ?? loadProjectConfig;
  const failed = (why) => ({ code: 1, lines: [...lines, `FAILED: ${FILL}: ${why}`] });
  try {
    const config = load({ file: configPath, env: {} });
    if (config.trackerPort != null) return failed(`${configPath} runs the tracker itself (it sets "trackerPort"); its machine id is its own "loop-build" sign-in, never filled in by the setup`);
    if (config.tracker !== 'api') return failed(`${configPath} does not use the tracker ("tracker" is "${config.tracker}")`);
    const raw = existingSettings(configPath, deps.readText);
    if (!raw) return failed(`${configPath} could not be read`);
    const seat = buildSeatName(config.productSlug, config.operatorName);
    const { actors } = await readActors(deps.get, config.trackerApiUrl);
    const id = actorNamed(actors, seat);
    if (!id) {
      return { code: 3, lines: [`"${seat}" is not in the tracker at ${config.trackerApiUrl} yet, so ${configPath} is unchanged (machineUserId ${config.machineUserId}). Run the sign-ins step first.`] };
    }
    if (String(raw.machineUserId) === id) {
      return { code: 0, lines: [`${configPath} already has machineUserId ${id}, the tracker's "${seat}"; unchanged.`] };
    }
    const was = raw.machineUserId;
    const next = withMachineUser(raw, id);
    const off = writeAndReadBack(configPath, next, deps);
    if (off.length) return failed(`${configPath} read back different from what was written, in ${off.join(', ')}`);
    return { code: 0, lines: [`Wrote machineUserId ${id} (the tracker's "${seat}", was ${JSON.stringify(was)}) into ${configPath}, checked by the settings reader every loop uses.`] };
  } catch (err) {
    if (err instanceof SettingsError || err instanceof ProjectConfigError) return failed(err.message);
    if (err?.code) return failed(`${configPath}: ${err.code} (${err.message})`);
    throw err;
  }
}

// --- The command -----------------------------------------------------------

/**
 * The tracker home's settings, as its FILE says, and its main checkout. No
 * environment override is applied (`env: {}`): Doppler sets TRACKER_URL to
 * the Mini's own address for the loops it runs, and that address must never
 * be copied into another product's settings file as its page address.
 */
export function loadHome(cwd = process.cwd(), checkoutOf = mainCheckoutOf) {
  const file = findConfigFile(cwd);
  const homeConfig = loadProjectConfig({ file: file ?? undefined, cwd, env: {} });
  return { homeConfig, homeRoot: checkoutOf(dirname(file)) };
}

function trackerGet(apiUrl, token) {
  return async (path) => {
    const res = await fetch(`${apiUrl}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', Connection: 'close' },
      signal: AbortSignal.timeout(30 * 1000),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json };
  };
}

const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; } };

async function main(argv) {
  const [command, ...rest] = argv;
  let args;
  try {
    args = parseArgs({ args: rest, options: { answers: { type: 'string' }, out: { type: 'string' }, config: { type: 'string' } } }).values;
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return 2;
  }
  let token = null;
  try { token = process.env[trackerTokenEnv(process.env)] || null; } catch { token = null; }
  const noToken = 'no tracker sign-in in this environment; run it as `npm run onboard:settings`, which runs it under Doppler';
  const print = ({ code, lines }) => {
    for (const line of lines) (line.startsWith('FAILED') ? console.error : console.log)(line);
    return code;
  };

  if (command === 'write') {
    if (!args.answers || !args.out || args.config) { console.error(USAGE); return 2; }
    let homeConfig;
    let homeRoot;
    try {
      ({ homeConfig, homeRoot } = loadHome());
    } catch (err) {
      if (!(err instanceof ProjectConfigError)) throw err;
      console.error(`FAILED: ${WRITE}: the tracker home's settings file is not usable — ${err.message}`);
      return 1;
    }
    if (homeConfig.trackerPort == null) {
      console.error(`FAILED: ${WRITE}: run this from the folder of the product that runs the tracker (its settings file sets "trackerPort"), not a guest product's.`);
      return 1;
    }
    if (!token) { console.error(`FAILED: ${WRITE}: ${noToken}`); return 1; }
    return print(await runWrite(
      { answersPath: expandHome(args.answers), outDir: resolve(expandHome(args.out)) },
      { homeConfig, homeRoot, get: trackerGet(homeConfig.trackerApiUrl, token), readText },
    ));
  }
  if (command === 'fill-machine-user') {
    if (!args.config || args.answers || args.out) { console.error(USAGE); return 2; }
    if (!token) { console.error(`FAILED: ${FILL}: ${noToken}`); return 1; }
    const configPath = resolve(expandHome(args.config));
    if (!existsSync(configPath)) { console.error(`FAILED: ${FILL}: ${configPath} does not exist`); return 1; }
    let apiUrl;
    try { apiUrl = loadProjectConfig({ file: configPath, env: {} }).trackerApiUrl; } catch (err) {
      if (!(err instanceof ProjectConfigError)) throw err;
      console.error(`FAILED: ${FILL}: ${err.message}`);
      return 1;
    }
    return print(await runFill({ configPath }, { get: trackerGet(apiUrl, token), readText }));
  }
  console.error(USAGE);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`FAILED: onboard settings stopped on an unexpected error — ${err.stack || err.message}`);
    process.exit(1);
  });
}
