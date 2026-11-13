#!/usr/bin/env node
/**
 * app_checks.mjs — run a project's application checks and post what changed
 * to its bus (SP-264, move 3 in docs/INTEGRATION.md).
 *
 *   npm run app-checks                 run the checks that are due, post, save
 *   npm run app-checks -- --dry-run    print what it would post; write nothing
 *   npm run app-checks -- --config <path to spirality.project.json>
 *
 * The checks are the manifest's `applicationChecks` (docs/PROJECT_MANIFEST.md).
 * Each command runs through `/bin/sh -c` from the folder holding the manifest
 * that was read. This script runs outside Doppler; only the post runs under
 * the project's Doppler project (`scripts/with_doppler.mjs`), so a check
 * never holds the tracker's sign-in (and any `TRACKER_TOKEN*` left in the
 * environment is taken out of a check's): a check posts nothing itself. `lib/appChecks.js` decides which are due and
 * what a result posts; the post goes through `scripts/clickup.mjs bus-post`,
 * the same read-back post every bus message uses, so a post that did not
 * land exits non-zero there and is named here.
 *
 * The state is `<logDir>/<projectSlug>-app-checks.json`. A check's new state
 * is saved only once its post landed (or it needed none), so a post that did
 * not land is tried again on the next pass.
 *
 * Exit 0 when every post that was needed landed (a failing check is not a
 * failing pass). Exit 1 naming any post that did not land, or a state file
 * that could not be read or written. Exit 2 for a bad argument or manifest.
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { loadProjectConfig, findConfigFile, ProjectConfigError } from '../lib/projectConfig.mjs';
import { laneFile } from './lib/laneFiles.mjs';

const require = createRequire(import.meta.url);
const appChecks = require('../lib/appChecks.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const DOOR = resolve(HERE, 'clickup.mjs');
const WITH_DOPPLER = resolve(HERE, 'with_doppler.mjs');

/** The most a check's output is kept in memory; only its first line is used. */
const OUTPUT_LIMIT = 64 * 1024;

/** How long a stopped check gets to exit before it is killed outright. */
const KILL_GRACE_MS = 5000;

/** The environment a check runs with: the tracker's sign-in taken out. */
export function checkEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!/^TRACKER_TOKEN/.test(k)) out[k] = v;
  return out;
}

/** The state file's name in the log folder: `<projectSlug>-app-checks.json`. */
export function stateFile(config, opts) {
  return laneFile(config, 'app-checks.json', opts);
}

/**
 * Run one check's command; resolves `{ code, signal, stdout, stderr,
 * timedOut, error }`, never rejects.
 */
export function runCommand(command, { cwd, env, timeoutSeconds }) {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(killer); done({ stdout, stderr, timedOut, ...r }); } };
    let child;
    try {
      child = spawn('/bin/sh', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      finish({ code: null, error: err.message });
      return;
    }
    const keep = (which) => (chunk) => {
      if (which === 'out' && stdout.length < OUTPUT_LIMIT) stdout += chunk;
      if (which === 'err' && stderr.length < OUTPUT_LIMIT) stderr += chunk;
    };
    child.stdout.setEncoding('utf8').on('data', keep('out'));
    child.stderr.setEncoding('utf8').on('data', keep('err'));
    // The whole process group: a check's own children stop with it.
    const signal = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* already gone */ } } };
    let killer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      signal('SIGTERM');
      killer = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS);
    }, timeoutSeconds * 1000);
    child.on('error', (err) => finish({ code: null, error: err.message }));
    child.on('close', (code, sig) => finish({ code, signal: sig }));
  });
}

/** Post `text` to the bus through the door's read-back `bus-post`. Resolves `{ ok, why }`. */
export function busPost(text, { cwd, env = process.env } = {}) {
  return new Promise((done) => {
    // Under the project's own Doppler project (with_doppler reads the
    // manifest found from `cwd`), so the sign-in exists only for the post.
    const child = spawn(process.execPath, [WITH_DOPPLER, process.execPath, DOOR, 'bus-post', '--body-file', '-'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (c) => { out += c; });
    child.stderr.setEncoding('utf8').on('data', (c) => { out += c; });
    child.on('error', (err) => done({ ok: false, why: `could not start the door (${err.message})` }));
    child.on('close', (code) => done(code === 0
      ? { ok: true, why: appChecks.firstLine(out) }
      : { ok: false, why: `bus-post exited ${code}: ${appChecks.firstLine(out.split('\n').filter((l) => !/^\s*tracker: \d+ request/.test(l)).join('\n')) || 'no message'}` }));
    child.stdin.end(text);
  });
}

/** The saved state, `{}` when there is none yet. Throws naming the file when it cannot be read. */
export function readState(path) {
  if (!existsSync(path)) return {};
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (err) {
    throw new Error(`the saved state ${path} could not be read (${err.message}); nothing was run, so no check posts twice. Fix or move the file aside`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`the saved state ${path} is not an object; nothing was run`);
  return raw;
}

function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * One pass. Everything that touches the world comes in as an option, so the
 * tests run it with no tracker and no clock. Returns the exit code.
 */
export async function runAppChecks({
  config, repoDir, statePath, dryRun = false, now = Date.now(), env = process.env,
  run = runCommand, post = busPost, log = console.log, warn = console.error,
}) {
  const checks = config.applicationChecks || [];
  if (!checks.length) { log('app-checks: none listed'); return 0; }

  let state;
  try { state = readState(statePath); } catch (err) { warn(`app-checks: FAILED: ${err.message}.`); return 1; }

  const due = appChecks.dueChecks(checks, state, now);
  const runEnv = checkEnv(env);
  const next = { ...state };
  const counts = { run: 0, failing: 0, posted: 0, notLanded: [] };

  for (const check of due) {
    counts.run += 1;
    const ran = await run(check.command, { cwd: repoDir, env: runEnv, timeoutSeconds: check.timeoutSeconds });
    const result = appChecks.resultOf(ran, { timeoutSeconds: check.timeoutSeconds, env });
    const decision = appChecks.decide(check, state[check.name], result, now);
    if (!result.well) counts.failing += 1;
    const said = result.well ? 'well' : `failing: ${result.line}`;
    if (!decision.post) {
      log(`${check.name}: ${said} (nothing to post)`);
      next[check.name] = decision.next;
      continue;
    }
    if (dryRun) {
      log(`${check.name}: ${said}; would post: ${decision.post}`);
      continue;
    }
    const landed = await post(decision.post, { cwd: repoDir, env });
    if (landed.ok) {
      counts.posted += 1;
      log(`${check.name}: ${said}; posted: ${decision.post}`);
      next[check.name] = decision.next;
    } else {
      counts.notLanded.push(check.name);
      warn(`${check.name}: ${said}; the post did NOT land (${landed.why}). Its saved state is unchanged, so the next pass tries again.`);
    }
  }

  // A check no longer listed is forgotten, so a name used again starts fresh.
  for (const name of Object.keys(next)) if (!checks.some((c) => c.name === name)) delete next[name];

  const later = checks.length - due.length;
  const summary = `${counts.run} run, ${later} not due yet, ${counts.failing} failing, ${dryRun ? 'nothing posted or saved (dry run)' : `${counts.posted} posted`}`;
  if (!dryRun) {
    try { writeState(statePath, next); } catch (err) {
      warn(`app-checks: FAILED: ${summary}, but the saved state ${statePath} could not be written (${err.message}); the next pass may post again.`);
      return 1;
    }
  }
  if (counts.notLanded.length) {
    warn(`app-checks: FAILED: ${summary}; ${counts.notLanded.length} post(s) did NOT land: ${counts.notLanded.join(', ')}.`);
    return 1;
  }
  log(`app-checks: ${summary}.`);
  return 0;
}

function argValue(argv, name) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

async function main(argv) {
  const known = new Set(['--dry-run', '--config']);
  const unknown = argv.find((a, i) => a.startsWith('--') && !known.has(a) && !a.startsWith('--config=') && argv[i - 1] !== '--config');
  if (unknown || argv.includes('--help')) {
    console.error('usage: npm run app-checks [-- --dry-run] [-- --config <path to spirality.project.json>]');
    return 2;
  }
  const given = argValue(argv, 'config');
  const file = given ? resolve(given) : findConfigFile(process.cwd());
  let config;
  try {
    config = loadProjectConfig({ file: file || undefined });
  } catch (err) {
    if (!(err instanceof ProjectConfigError)) throw err;
    console.error(`app-checks: the project config is not usable: ${err.message}`);
    return 2;
  }
  return runAppChecks({
    config,
    repoDir: dirname(file),
    statePath: config.applicationChecks.length ? stateFile(config) : null,
    dryRun: argv.includes('--dry-run'),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
