#!/usr/bin/env node
/**
 * The setup wizard (SP-112): set up a product on Spirality with one command,
 * which asks its questions once and runs every step in order
 * (docs/onboarding/SETUP_REVIEW.md, part 3).
 *
 *   npm run onboard -- --product <slug> [--allow-replace] [--merge-wait-minutes <n>]
 *
 * Run on the Mini, from the tracker home's own folder (the product whose
 * settings file sets `trackerPort`, today Spirality), in a Terminal that is
 * not one of that product's lanes. In order:
 *
 *   answers   the answers file, `<logDir>/onboard/<slug>.answers.json`. Only
 *             the fields that are Dane's decisions are asked, and only when
 *             the file does not have them yet; the rest take their defaults
 *             (lib/onboardAnswers.mjs) and can be changed in the file.
 *   look      SP-108's read-only look (`onboard:look`). Anything BLOCKED stops
 *             here, before anything is written.
 *   clone     SP-119: when the checkout folder does not exist, `git clone` the
 *             product's `main` into it, from the same kind of address (https
 *             or ssh) the tracker home's own origin uses, and read back that
 *             its origin is githubRepo and it is a clean `main`. A folder that
 *             is there is never touched (the look blocks one that is not a
 *             clean checkout of the repository).
 *   settings  SP-109 writes the settings file into a scratch folder beside the
 *             answers file (`onboard:settings write`).
 *   signins   STOP FOR DANE (real secret values): the commands that make the
 *             product's Doppler project if it is missing and run
 *             `tracker:signins create` against the scratch settings file with
 *             TRACKER_DB set to the tracker home's database. SP-124: the
 *             wizard shows them and asks "Run these now? [y/N]". On y it runs
 *             them itself, in order, in Dane's own Terminal with their output
 *             shown; on anything else (or no Terminal) it leaves the block
 *             printed and stops, nothing run. Then it reads back with
 *             `tracker:signins check` and fills in machineUserId
 *             (`onboard:settings fill-machine-user`).
 *   copy      SP-110's one pull request in the product's repository
 *             (`onboard:copy`), CI's verify green on it.
 *   lanes     SP-111 installs the product's lanes from the setup branch and
 *             files its setup ticket (`onboard:lanes`). First it removes
 *             onboard:copy's worktree, which still holds the setup branch
 *             (git checks a branch out in one place only), read back.
 *   merge     STOP FOR DANE (a decision): his merge phrase on the setup
 *             ticket; the product's own relay merges. The wizard waits for the
 *             merge and reads it back on the product's main.
 *   protect   main protected: the required check `verify`, up to date,
 *             admins included, no force pushes or deletion, no review
 *             required. Read back with `gh api .../branches/main/protection`.
 *
 * Every step first checks whether it is already done and skips it if so, so
 * a rerun resumes where a failed one stopped and asks nothing twice. Once the
 * setup is on the product's main (its settings file is there, with its own
 * machine id), every step up to the merge is done. Each step's outcome goes
 * to the step log, `<logDir>/<slug>-onboard.log`, in Mountain time.
 *
 * A failed step prints `FAILED: <step>: <what was seen>` and the rerun
 * command, and nothing after it runs (rule 6). A stop for Dane that is not
 * answered (no Terminal to wait in, or the merge not made in time) prints
 * `STOPPED: <step>: ...` and the same rerun command. Every product value comes
 * from the answers and settings files (rule 2); the wizard prints no secret
 * (rule 4): the paste block holds commands, never values.
 *
 * Exit 0 set up, 1 FAILED, 2 usage, 3 stopped for Dane.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { CONFIG_FILE, findConfigFile, loadProjectConfig, ProjectConfigError } from '../../lib/projectConfig.mjs';
import { AnswersError, answersFile, expandHome, loadAnswers, onboardDir, slugFromName } from '../../lib/onboardAnswers.mjs';
import { machineUserPending } from '../../lib/onboardSettings.mjs';
import { ciVerdict, SETUP_BRANCH } from '../../lib/onboardCopy.mjs';
import { LANES, parseStatus } from '../../lib/onboardLanes.mjs';
import { normalRepo } from '../lib/repoCheck.mjs';

const require = createRequire(import.meta.url);
const { findTicketId, ticketLink } = require('../../lib/clickupTicketLink.js');

export const DEFAULT_MERGE_WAIT_MINUTES = 60;

export const STEPS = Object.freeze(['answers', 'look', 'clone', 'settings', 'signins', 'copy', 'lanes', 'merge', 'protect']);

/**
 * The answers that are Dane's decisions (SETUP_REVIEW.md part 3, "What a
 * person enters", the fields marked "Dane"): the only ones the wizard asks.
 * `fallback` describes the default shown in brackets; a blank answer writes
 * null, which lib/onboardAnswers.mjs reads as "use the default", and which
 * still counts as answered, so it is not asked again.
 */
export const DANE_FIELDS = Object.freeze([
  { key: 'productName', question: 'Product name, as the tracker shows it', required: true },
  { key: 'githubRepo', question: 'GitHub repository, as owner/name', required: true },
  { key: 'trackerPrefix', question: 'Ticket prefix (the start of every ticket id)', fallback: ({ slug }) => slug.replace(/[^a-z]/g, '').slice(0, 2).toUpperCase() || null },
  { key: 'mergePhrases', question: 'Merge phrases, the words that mean "merge this" (comma between)', list: true, fallback: ({ homeConfig }) => homeConfig.mergePhrases.join(', ') },
  { key: 'autoMergeLanes', question: 'Lanes that may merge without you (comma between)', list: true, fallback: () => 'none' },
  { key: 'extraGovernancePaths', question: 'Extra protected files, beyond the usual list (comma between)', list: true, fallback: () => 'none' },
  { key: 'description', question: 'What the product is, in two or three sentences, for its CLAUDE.md', required: true },
]);

/** A typed answer as the answers file holds it: blank -> null (the default); a list split on commas; "none" -> []. */
export function answerValue(field, typed) {
  const text = String(typed ?? '').trim();
  if (!text) return null;
  if (!field.list) return text;
  if (/^none$/i.test(text)) return [];
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

/** The Dane fields an answers object has not answered yet (a field set to null is answered: it takes the default). */
export function unanswered(raw) {
  return DANE_FIELDS.filter((f) => !Object.hasOwn(raw, f.key));
}

/** The field an AnswersError message names (`"key" must ...`), or null. */
export function fieldNamed(message) {
  const m = /"([A-Za-z]+)"/.exec(String(message));
  return m ? m[1] : null;
}

/**
 * What `main` must be protected with, and whether a protection answer
 * (`gh api repos/<repo>/branches/main/protection`) has it. Returns the
 * list of what is off; empty means it matches.
 */
export function protectionGaps(body) {
  if (!body || typeof body !== 'object') return ['no protection'];
  const gaps = [];
  const rsc = body.required_status_checks;
  const checks = [...(rsc?.contexts ?? []), ...(rsc?.checks ?? []).map((c) => c.context)];
  if (!checks.includes('verify')) gaps.push('"verify" is not a required check');
  if (rsc?.strict !== true) gaps.push('branches need not be up to date before merging');
  if (body.enforce_admins?.enabled !== true) gaps.push('admins are not included');
  if (body.allow_force_pushes?.enabled !== false) gaps.push('force pushes are allowed');
  if (body.allow_deletions?.enabled !== false) gaps.push('deleting main is allowed');
  if (body.required_pull_request_reviews) gaps.push('a review is required, which the loop cannot give');
  return gaps;
}

/** The body `gh api -X PUT .../protection` takes: the rules above, keeping any other required checks already there. */
export function protectionRequest(existing) {
  const rsc = existing?.required_status_checks;
  const have = [...(rsc?.contexts ?? []), ...(rsc?.checks ?? []).map((c) => c.context)];
  return {
    required_status_checks: { strict: true, contexts: [...new Set(['verify', ...have])] },
    enforce_admins: true,
    required_pull_request_reviews: null,
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  };
}

/**
 * The settings on main the PUT above switches off, read from the protection
 * answer it replaces (GitHub's PUT sets every rule, so one not in the request
 * is turned off). The wizard says them before it writes, so nobody loses a
 * stricter setup without being told. A required review is not here: it is
 * already a gap, named as one.
 */
export function protectionDropped(before) {
  if (!before || typeof before !== 'object') return [];
  const on = (k) => before[k]?.enabled === true;
  const dropped = [];
  if (on('required_linear_history')) dropped.push('linear history required');
  if (on('required_signatures')) dropped.push('signed commits required');
  if (on('required_conversation_resolution')) dropped.push('conversations must be resolved');
  if (on('lock_branch')) dropped.push('main is locked');
  if (on('block_creations')) dropped.push('branch creation blocked');
  if (before.restrictions) dropped.push('only some people may push');
  return dropped;
}

/**
 * The worktrees of a checkout (`git worktree list --porcelain`) that hold
 * `branch`, other than the checkout itself. Git lets a branch be checked out
 * in one place only, so `onboard:lanes` cannot check out the setup branch in
 * the product's own folder while onboard:copy's worktree still holds it.
 * Git always lists the checkout itself first, and prints paths resolved
 * (/private/var for /var), so the first entry is skipped, never compared.
 */
export function worktreesOnBranch(porcelain, branch) {
  const found = [];
  const blocks = String(porcelain || '').trim().split(/\n\s*\n/).slice(1);
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim());
    const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (path && lines.includes(`branch refs/heads/${branch}`)) found.push(path);
  }
  return found;
}

/** The command that reruns this wizard as it was started (every flag that changes what it does). */
export function rerunCommand(opts) {
  return `npm run onboard -- --product ${opts.product}${opts.allowReplace ? ' --allow-replace' : ''}${opts.mergeWaitMinutes !== DEFAULT_MERGE_WAIT_MINUTES ? ` --merge-wait-minutes ${opts.mergeWaitMinutes}` : ''}`;
}

/** CI's verify on a commit, from `gh api repos/<repo>/commits/<sha>/check-runs`: pass, fail, pending or none. */
export function mainVerifyVerdict(answer) {
  const runs = (answer?.check_runs ?? []).filter((r) => r && r.name === 'verify');
  if (!runs.length) return { verdict: 'none', why: 'no verify run on it' };
  if (runs.some((r) => r.status !== 'completed')) return { verdict: 'pending', why: 'verify is still running' };
  if (runs.every((r) => r.conclusion === 'success')) return { verdict: 'pass', why: 'verify passed' };
  return { verdict: 'fail', why: `verify ended ${runs.map((r) => r.conclusion).join(', ')}` };
}

/**
 * The address to clone `repo` (owner/name) from: ssh when the tracker home's
 * own origin is an ssh address, https otherwise (and when it could not be
 * read). Only the kind is taken from the home's origin, never any part of it,
 * so a sign-in token in an https origin cannot reach the clone or a log.
 */
export function cloneAddress(homeOrigin, repo) {
  const name = normalRepo(repo);
  const origin = String(homeOrigin ?? '').trim();
  if (/^git@github\.com:/i.test(origin) || /^ssh:\/\//i.test(origin)) return `git@github.com:${name}.git`;
  return `https://github.com/${name}.git`;
}

/** A word in single quotes for the shell, so a product name with a space or a quote pastes safely. */
export function shellQuote(text) {
  const s = String(text);
  return /^[A-Za-z0-9_./:=@+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Doppler's root configs, made with every new project. Any other name is a branch config of one of them. */
const DOPPLER_ROOTS = ['dev', 'stg', 'prd'];

/**
 * The sign-ins commands, in order, each as { cmd, args, env }: the Doppler
 * project (and config) only if missing, then `tracker:signins create`
 * against the scratch settings file, with TRACKER_DB set to the tracker
 * home's database. Every one runs in the tracker home's folder. The wizard
 * runs exactly these on Dane's y; pasteBlock prints the same ones.
 */
export function signinCommands({ answers, settingsFile, trackerDb, projectExists, configExists }) {
  const cmds = [];
  if (!projectExists) cmds.push({ cmd: 'doppler', args: ['projects', 'create', answers.dopplerProject] });
  const madeWithProject = !projectExists && DOPPLER_ROOTS.includes(answers.dopplerConfig);
  if (!configExists && !madeWithProject) {
    const env = answers.dopplerConfig.split('_')[0];
    cmds.push({ cmd: 'doppler', args: ['configs', 'create', answers.dopplerConfig, '--project', answers.dopplerProject, '--environment', env] });
  }
  cmds.push({ cmd: 'npm', args: ['run', 'tracker:signins', '--', 'create', '--name', answers.productName, '--prefix', answers.trackerPrefix, '--config', settingsFile], env: { TRACKER_DB: trackerDb } });
  return cmds;
}

/** One command as a line to paste: its environment first, every word quoted for the shell. */
export function commandLine({ cmd, args, env }) {
  const pre = Object.entries(env ?? {}).map(([k, v]) => `${k}=${shellQuote(v)} `).join('');
  return `${pre}${[cmd, ...args].map(shellQuote).join(' ')}`;
}

/** The block for the sign-ins as it is printed: `cd` to the tracker home, then each command. */
export function pasteBlock({ spiralityDir, ...rest }) {
  return [`cd ${shellQuote(spiralityDir)}`, ...signinCommands(rest).map(commandLine)];
}

/** Dane's answer to "Run these now? [y/N]": only y or yes runs anything. */
export function saidYes(typed) {
  return /^(y|yes)$/i.test(String(typed ?? '').trim());
}

/** "2026-11-04 22:51:03 MT": the step log's clock, Mountain time. */
export function mountainStamp(date = new Date()) {
  return `${date.toLocaleString('sv-SE', { timeZone: 'America/Denver', hour12: false })} MT`;
}

/** Has the step log recorded `step` as done? */
export function loggedDone(logText, step) {
  return String(logText || '').split('\n').some((line) => {
    const parts = line.split(' | ');
    return parts[1] === step && parts[2] === 'done';
  });
}

class Stop extends Error {
  constructor(kind, step, seen) { super(seen); this.kind = kind; this.step = step; }
}

const last = (text, n = 4) => String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' | ');

/**
 * The wizard. `opts`: product, allowReplace, mergeWaitMinutes. `deps`:
 *   homeConfig, homeRoot, spiralityDir   the tracker home
 *   run(cmd, args, { cwd, input, show, env }) -> { code, out, err }; `show`
 *                                         lets Dane watch a step script's own
 *                                         lines; `env` adds to the environment
 *   ask(question) -> string, or null when there is no Terminal to ask in
 *   print(line), exists(path), readText(path) -> text|null, writeText(path, text),
 *   appendText(path, text), mkdir(dir), sleep(ms), now() -> ms
 * Returns the exit code.
 */
export async function onboard(opts, deps) {
  const { homeConfig, spiralityDir } = deps;
  const slug = opts.product;
  const rerun = rerunCommand(opts);
  const logFile = join(expandHome(homeConfig.logDir), `${slug}-onboard.log`);
  const say = (step, line) => deps.print(`${step.padEnd(9)} ${line}`);
  const record = (step, outcome, text) => {
    try { deps.appendText(logFile, `${mountainStamp(new Date(deps.now()))} | ${step} | ${outcome} | ${text}\n`); } catch (err) {
      deps.print(`(could not write the step log ${logFile}: ${err.code || err.message})`);
    }
  };
  const done = (step, line) => { say(step, line); record(step, 'done', line); };
  const skip = (step, why) => { say(step, `already done (${why})`); record(step, 'skip', why); };
  const fail = (step, seen) => { throw new Stop('FAILED', step, seen); };
  const stop = (step, seen) => { throw new Stop('STOPPED', step, seen); };
  const run = (cmd, args, o = {}) => deps.run(cmd, args, { cwd: spiralityDir, ...o });
  const npm = (script, args, o) => run('npm', ['run', '--silent', script, '--', ...args], o);
  const gh = (...args) => run('gh', args);
  const ghJson = (...args) => {
    const r = gh(...args);
    if (r.code !== 0) return { ok: false, r };
    try { return { ok: true, json: JSON.parse(r.out || 'null') }; } catch { return { ok: false, r: { ...r, err: 'not JSON' } }; }
  };

  let step = 'answers';
  try {
    // ── answers ──────────────────────────────────────────────────────────
    const aFile = answersFile(homeConfig, slug);
    let raw = {};
    const text = deps.readText(aFile);
    if (text != null) {
      try { raw = JSON.parse(text); } catch (err) { fail(step, `${aFile} is not valid JSON (${err.message}); fix or remove it`); }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(step, `${aFile} does not hold one JSON object`);
    }
    if (Object.hasOwn(raw, 'productSlug') && raw.productSlug !== slug) fail(step, `${aFile} is for "${raw.productSlug}", not ${slug}`);
    const missing = unanswered(raw);
    if (!missing.length) {
      skip(step, `every answer that is yours is in ${aFile}`);
    } else {
      say(step, `${missing.length} question(s) for you, Dane (decisions only you can make). Press Enter to take the default in brackets.`);
      const typed = {};
      for (const field of missing) {
        const fallback = field.fallback ? field.fallback({ slug, homeConfig }) : null;
        let value = null;
        for (let tries = 0; ; tries += 1) {
          const got = await deps.ask(`${field.question}${fallback ? ` [${fallback}]` : ''}: `);
          if (got == null) {
            stop(step, `no Terminal to ask in; still to answer: ${missing.filter((f) => !Object.hasOwn(typed, f.key)).map((f) => f.key).join(', ')}. Write them in ${aFile}, or run this in a Terminal`);
          }
          value = answerValue(field, got);
          if (value != null || !field.required) break;
          if (tries >= 2) fail(step, `"${field.key}" has no default and was left blank three times`);
          deps.print('  That one has no default; it needs an answer.');
        }
        typed[field.key] = value;
      }
      const next = { ...raw, productSlug: slug, ...typed };
      const written = `${JSON.stringify(next, null, 2)}\n`;
      try {
        deps.mkdir?.(dirname(aFile));
        deps.writeText(aFile, written);
      } catch (err) { fail(step, `could not write ${aFile}: ${err.code || err.message}`); }
      if (deps.readText(aFile) !== written) fail(step, `${aFile} did not read back as written`);
      raw = next;
      say(step, `wrote ${aFile}, read back`);
    }
    let answers;
    try {
      answers = loadAnswers(aFile, { homeConfig, homeRoot: deps.homeRoot });
    } catch (err) {
      if (!(err instanceof AnswersError)) throw err;
      // A field typed just now that does not check out is taken out again,
      // so the rerun asks that one, and only that one.
      const key = fieldNamed(err.message);
      if (key && missing.some((f) => f.key === key)) {
        const { [key]: _drop, ...rest } = raw;
        const kept = `${JSON.stringify(rest, null, 2)}\n`;
        let why = null;
        try { deps.writeText(aFile, kept); } catch (e) { why = e.code || e.message; }
        if (why == null && deps.readText(aFile) !== kept) why = 'it did not read back as written';
        if (why != null) fail(step, `${err.message}. Taking "${key}" out of ${aFile} failed too (${why}): fix it there by hand`);
        fail(step, `${err.message}. The rerun asks "${key}" again`);
      }
      fail(step, `${err.message}. Fix it in ${aFile}`);
    }
    if (missing.length) record(step, 'done', `answers in ${aFile}`);

    const checkout = expandHome(answers.checkoutDir);
    const sameRepo = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    // Once the product's main has its settings file, with its own machine id,
    // the setup pull request has merged: every step up to the merge is done.
    const onMain = () => {
      if (deps.readText(join(checkout, '.git', 'HEAD')) == null && deps.readText(join(checkout, '.git')) == null) return { on: false, why: `${checkout} is not cloned yet` };
      const f = run('git', ['fetch', '-q', 'origin'], { cwd: checkout });
      if (f.code !== 0) return { on: false, why: `git fetch in ${checkout} failed: ${last(f.err)}` };
      const shown = run('git', ['show', `origin/main:${CONFIG_FILE}`], { cwd: checkout });
      if (shown.code !== 0) return { on: false, why: `${answers.githubRepo}'s main has no ${CONFIG_FILE} yet` };
      let s;
      try { s = JSON.parse(shown.out); } catch { return { on: false, why: `${answers.githubRepo}'s main has a ${CONFIG_FILE} that is not JSON` }; }
      if (s.productSlug !== slug || !sameRepo(s.githubRepo, answers.githubRepo)) return { on: false, why: `the ${CONFIG_FILE} on ${answers.githubRepo}'s main is not ${slug}'s` };
      if (machineUserPending(s)) return { on: false, why: `the ${CONFIG_FILE} on ${answers.githubRepo}'s main has no machine id yet` };
      return { on: true, why: `${answers.githubRepo}'s main has ${slug}'s settings file` };
    };
    let setup = onMain();

    // ── look ─────────────────────────────────────────────────────────────
    step = 'look';
    if (setup.on) skip(step, `the setup is merged: ${setup.why}`);
    else if (loggedDone(deps.readText(logFile), step)) skip(step, `it passed before (${logFile})`);
    else {
      say(step, `running the read-only look (onboard:look); nothing is written`);
      const r = npm('onboard:look', ['--answers', aFile], { show: true });
      if (r.code === 3) fail(step, 'something is BLOCKED (the look\'s lines above say what); nothing was written');
      if (r.code !== 0) fail(step, `the look could not tell everything (exit ${r.code}; its lines above say what)`);
      done(step, 'nothing is BLOCKED');
    }

    // ── clone ────────────────────────────────────────────────────────────
    step = 'clone';
    if (deps.exists(checkout)) skip(step, `${checkout} is there`);
    else {
      const home = run('git', ['remote', 'get-url', 'origin']);
      const address = cloneAddress(home.code === 0 ? home.out : null, answers.githubRepo);
      const kind = address.startsWith('git@') ? 'ssh' : 'https';
      say(step, `${checkout} does not exist; cloning ${answers.githubRepo}'s main into it over ${kind}${home.code === 0 ? ' (as the tracker home\'s origin is)' : ' (the tracker home\'s origin could not be read)'}`);
      try { deps.mkdir?.(dirname(checkout)); } catch (err) { fail(step, `could not make ${dirname(checkout)}: ${err.code || err.message}`); }
      const c = run('git', ['clone', '--quiet', '--branch', 'main', address, checkout], { cwd: dirname(checkout) });
      if (c.code !== 0) fail(step, `git clone of ${answers.githubRepo} into ${checkout} failed: ${last(c.err || c.out) || `exit ${c.code}`}`);
      const inCheckout = (...args) => run('git', args, { cwd: checkout });
      const origin = inCheckout('remote', 'get-url', 'origin');
      if (origin.code !== 0 || normalRepo(origin.out) !== normalRepo(answers.githubRepo)) fail(step, `the clone at ${checkout} does not read back with origin ${answers.githubRepo}`);
      const head = inCheckout('rev-parse', '--abbrev-ref', 'HEAD');
      if (head.code !== 0 || head.out.trim() !== 'main') fail(step, `the clone at ${checkout} reads back on ${head.code === 0 ? head.out.trim() : 'no branch'}, not main`);
      const status = inCheckout('status', '--porcelain');
      if (status.code !== 0 || status.out.trim()) fail(step, `the clone at ${checkout} does not read back as a clean main`);
      done(step, `${answers.githubRepo} cloned into ${checkout}, read back: origin ${answers.githubRepo}, a clean main`);
      setup = onMain();
    }

    // ── settings ─────────────────────────────────────────────────────────
    step = 'settings';
    const scratch = join(onboardDir(homeConfig), `${slug}-settings`);
    const settingsFile = join(scratch, CONFIG_FILE);
    const readSettings = () => {
      try { return loadProjectConfig({ file: settingsFile, env: {} }); } catch (err) {
        if (err instanceof ProjectConfigError) return null;
        throw err;
      }
    };
    let config = null;
    if (setup.on) skip(step, `the setup is merged: ${setup.why}`);
    else {
      const have = deps.readText(settingsFile) != null ? readSettings() : null;
      if (have && have.productSlug === slug && sameRepo(have.githubRepo, answers.githubRepo)) {
        config = have;
        skip(step, `${settingsFile} is ${slug}'s and reads`);
      } else {
        const r = npm('onboard:settings', ['write', '--answers', aFile, '--out', scratch], { show: true });
        if (r.code !== 0) fail(step, `onboard:settings write exit ${r.code} (its FAILED line is above)`);
        config = readSettings();
        if (!config || config.productSlug !== slug) fail(step, `${settingsFile} does not read back as ${slug}'s settings file`);
        done(step, `${settingsFile} written and read back`);
      }
    }

    // ── signins ──────────────────────────────────────────────────────────
    step = 'signins';
    if (setup.on) skip(step, `the setup is merged: ${setup.why}`);
    else {
      const check = () => npm('tracker:signins', ['check', '--config', settingsFile]);
      const fillMachine = () => {
        if (!machineUserPending(config)) return;
        const r = npm('onboard:settings', ['fill-machine-user', '--config', settingsFile]);
        if (r.code !== 0) fail(step, `filling in machineUserId: ${last(r.err || r.out)}`);
        config = readSettings();
        if (!config || machineUserPending(config)) fail(step, `${settingsFile} still has no machineUserId after fill-machine-user`);
        say(step, `machineUserId ${config.machineUserId} written into ${settingsFile}, read back`);
      };
      if (check().code === 0) {
        fillMachine();
        skip(step, `every ${slug} sign-in answers as itself (tracker:signins check)`);
      } else {
        const exists = (args) => run('doppler', [...args, '--json', '--no-check-version']).code === 0;
        const projectExists = exists(['projects', 'get', answers.dopplerProject]);
        const configExists = projectExists && exists(['configs', 'get', answers.dopplerConfig, '--project', answers.dopplerProject]);
        const trackerDb = join(expandHome(homeConfig.trackerDataDir), 'tracker.db');
        const block = { answers, settingsFile, trackerDb, projectExists, configExists };
        deps.print('');
        deps.print(`Your move, Dane (real secret values): these commands ${projectExists ? '' : `make the Doppler project "${answers.dopplerProject}", then `}make ${answers.productName}'s tracker project and its sign-ins, and write their keys into Doppler. No key is shown.`);
        deps.print('');
        for (const line of pasteBlock({ spiralityDir, ...block })) deps.print(`  ${line}`);
        deps.print('');
        // Only y runs them. A blank answer (an Enter pressed while a step ran
        // and held by the Terminal) is a no: it stops, and nothing is run.
        const typed = await deps.ask('Run these now, here, in this Terminal? [y/N] ');
        if (typed == null) stop(step, 'the block above is not run (no Terminal here to ask in); paste it into a Terminal on the Mini, then rerun');
        if (!saidYes(typed)) stop(step, 'the block above is not run (you did not answer y); run it, or rerun and answer y');
        for (const c of signinCommands(block)) {
          const line = commandLine(c);
          say(step, `running: ${line}`);
          const r = run(c.cmd, c.args, { show: true, env: c.env });
          if (r.code !== 0) fail(step, `${line} ended with exit ${r.code} (its lines above say what); nothing after it ran`);
        }
        const after = check();
        if (after.code !== 0) fail(step, `tracker:signins check does not pass yet: ${last(after.err || after.out)}`);
        fillMachine();
        done(step, `every ${slug} sign-in answers as itself (tracker:signins check), machineUserId ${config.machineUserId}`);
      }
    }

    // ── copy ─────────────────────────────────────────────────────────────
    step = 'copy';
    const openPr = () => {
      const l = ghJson('pr', 'list', '--repo', answers.githubRepo, '--head', SETUP_BRANCH, '--state', 'open', '--json', 'url');
      if (!l.ok) fail(step, `could not list ${answers.githubRepo}'s pull requests: ${last(l.r.err || l.r.out)}`);
      return Array.isArray(l.json) && l.json[0] ? l.json[0].url : null;
    };
    const ciOn = (url) => {
      const c = ghJson('pr', 'checks', url, '--json', 'name,bucket,state');
      return c.ok ? ciVerdict(c.json) : { verdict: 'none', why: last(c.r.err || c.r.out) || 'gh gave no answer' };
    };
    let prUrl = null;
    if (setup.on) skip(step, `the setup is merged: ${setup.why}`);
    else {
      prUrl = openPr();
      const ci = prUrl ? ciOn(prUrl) : null;
      if (prUrl && ci.verdict === 'pass') skip(step, `${prUrl} is open and its verify passed`);
      else {
        const r = npm('onboard:copy', ['--answers', aFile, '--config', settingsFile, ...(opts.allowReplace ? ['--allow-replace'] : [])], { show: true });
        if (r.code !== 0) fail(step, `onboard:copy exit ${r.code} (its FAILED line is above)`);
        prUrl = openPr();
        if (!prUrl) fail(step, `onboard:copy finished, but ${answers.githubRepo} has no open pull request from ${SETUP_BRANCH}`);
        const v = ciOn(prUrl);
        if (v.verdict !== 'pass') fail(step, `${prUrl}: ${v.why}`);
        done(step, `${prUrl} open, its verify passed`);
      }
    }

    // ── lanes ────────────────────────────────────────────────────────────
    step = 'lanes';
    const linkOpts = config ? { tracker: config.tracker, trackerPrefix: config.trackerPrefix, trackerUrl: config.trackerUrl } : null;
    const linkedTicket = () => {
      const v = ghJson('pr', 'view', prUrl, '--json', 'body');
      if (!v.ok) fail(step, `could not read ${prUrl}: ${last(v.r.err || v.r.out)}`);
      return findTicketId(v.json?.body || '', linkOpts);
    };
    const lanesLoaded = () => {
      const s = run('bash', [join(checkout, 'scripts', 'install_loop_runner.sh'), '--status'], { cwd: checkout });
      const jobs = parseStatus(s.out);
      return LANES.filter((l) => !jobs[l]?.installed || !jobs[l]?.loaded);
    };
    let ticket = null;
    if (setup.on) skip(step, `the setup is merged: ${setup.why}`);
    else {
      ticket = linkedTicket();
      const notLoaded = ticket ? lanesLoaded() : LANES;
      if (ticket && !notLoaded.length) skip(step, `${prUrl} links ${ticket}, and every lane is loaded`);
      else {
        // onboard:copy keeps its worktree on the setup branch; git lets a
        // branch be checked out in one place only, so it goes before lanes
        // checks the branch out in the product's own folder. Its work is
        // pushed and the branch stays; git refuses if anything is unsaved.
        const holders = () => {
          const l = run('git', ['worktree', 'list', '--porcelain'], { cwd: checkout });
          if (l.code !== 0) fail(step, `git worktree list in ${checkout}: ${last(l.err || l.out)}`);
          return worktreesOnBranch(l.out, SETUP_BRANCH);
        };
        for (const wt of holders()) {
          const rm = run('git', ['worktree', 'remove', wt], { cwd: checkout });
          if (rm.code !== 0) fail(step, `the setup worktree ${wt} holds ${SETUP_BRANCH}, and git would not remove it: ${last(rm.err || rm.out)}. Look at it, remove it, then rerun`);
          say(step, `removed onboard:copy's worktree ${wt} (its work is pushed), so ${SETUP_BRANCH} can be checked out in ${checkout}`);
        }
        const left = holders();
        if (left.length) fail(step, `${SETUP_BRANCH} is still held by the worktree at ${left.join(', ')} after removing it`);
        const r = npm('onboard:lanes', ['--checkout', checkout, '--branch', SETUP_BRANCH, '--pr', prUrl], { show: true });
        if (r.code !== 0) fail(step, `onboard:lanes exit ${r.code} (its FAILED line is above)`);
        ticket = linkedTicket();
        if (!ticket) fail(step, `onboard:lanes finished, but ${prUrl} does not link a ticket`);
        const still = lanesLoaded();
        if (still.length) fail(step, `onboard:lanes finished, but these lanes are not loaded: ${still.join(', ')}`);
        done(step, `${slug}'s lanes are loaded and ${ticket} is its setup ticket`);
      }
    }

    // ── merge ────────────────────────────────────────────────────────────
    step = 'merge';
    if (setup.on) skip(step, setup.why);
    else {
      const link = ticketLink(ticket, linkOpts);
      deps.print('');
      deps.print(`Your move, Dane (a decision): if you are happy with ${prUrl}, write your merge phrase (${config.mergePhrases.map((p) => `"${p}"`).join(', ')}) as a comment on ${ticket}: ${link}`);
      deps.print(`${slug}'s own relay merges it through the usual checks. This waits up to ${opts.mergeWaitMinutes} minutes for it.`);
      deps.print('');
      const deadline = deps.now() + opts.mergeWaitMinutes * 60 * 1000;
      let pr;
      for (;;) {
        const v = ghJson('pr', 'view', prUrl, '--json', 'state,mergeCommit');
        if (!v.ok) fail(step, `could not read ${prUrl}: ${last(v.r.err || v.r.out)}`);
        pr = v.json;
        if (pr.state === 'MERGED') break;
        if (pr.state !== 'OPEN') fail(step, `${prUrl} is ${pr.state}, not merged`);
        if (deps.now() >= deadline) stop(step, `${prUrl} is not merged yet; it waits on your merge phrase on ${ticket} (${link})`);
        await deps.sleep(30 * 1000);
      }
      setup = onMain();
      const sha = pr.mergeCommit?.oid;
      if (!sha || run('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { cwd: checkout }).code !== 0) {
        fail(step, `${prUrl} says merged, but ${checkout}'s origin/main does not hold its merge commit ${sha || '(none given)'}`);
      }
      if (!setup.on) fail(step, `${prUrl} is merged, but ${setup.why}`);
      done(step, `${prUrl} merged as ${sha.slice(0, 7)}, on ${answers.githubRepo}'s main`);
    }

    // ── protect ──────────────────────────────────────────────────────────
    step = 'protect';
    const protection = () => {
      const r = gh('api', `repos/${answers.githubRepo}/branches/main/protection`);
      if (r.code === 0) {
        try { return JSON.parse(r.out); } catch { fail(step, 'GitHub answered, but not with the protection settings'); }
      }
      if (/not protected/i.test(`${r.out} ${r.err}`)) return null;
      fail(step, `could not read main's protection: ${last(r.err || r.out)}`);
    };
    const before = protection();
    const gaps = protectionGaps(before);
    if (!gaps.length) skip(step, `main requires verify, up to date, admins included, no force pushes or deletion`);
    else {
      // verify must have passed on main first (part 3, step 6).
      const sha = run('git', ['rev-parse', 'origin/main'], { cwd: checkout }).out;
      const finishBy = deps.now() + 30 * 60 * 1000;
      let verify;
      for (;;) {
        const c = ghJson('api', `repos/${answers.githubRepo}/commits/${sha}/check-runs`);
        verify = c.ok ? mainVerifyVerdict(c.json) : { verdict: 'fail', why: `could not read its checks: ${last(c.r.err || c.r.out)}` };
        if (verify.verdict !== 'pending' || deps.now() >= finishBy) break;
        await deps.sleep(20 * 1000);
      }
      if (verify.verdict === 'pending') fail(step, `verify on main (${sha.slice(0, 7)}) is still running after 30 minutes`);
      if (verify.verdict === 'fail') fail(step, `verify on main (${sha.slice(0, 7)}) did not pass: ${verify.why}`);
      say(step, verify.verdict === 'pass' ? `verify passed on main (${sha.slice(0, 7)})` : `main's newest commit ${sha.slice(0, 7)} has ${verify.why}; the setup pull request's verify passed`);
      const dropped = protectionDropped(before);
      if (dropped.length) {
        say(step, `main's protection has more than the setup sets, and this switches it off: ${dropped.join('; ')}. Set it again on GitHub if you want it`);
        record(step, 'note', `switched off: ${dropped.join('; ')}`);
      }
      const put = run('gh', ['api', '-X', 'PUT', `repos/${answers.githubRepo}/branches/main/protection`, '--input', '-'], { input: JSON.stringify(protectionRequest(before)) });
      if (put.code !== 0) fail(step, `protecting main: ${last(put.err || put.out)}`);
      const still = protectionGaps(protection());
      if (still.length) fail(step, `main's protection reads back without: ${still.join('; ')}`);
      done(step, `main protected (was: ${gaps.join('; ')}), read back`);
    }
  } catch (err) {
    if (!(err instanceof Stop)) throw err;
    deps.print('');
    deps.print(`${err.kind}: ${err.step}: ${err.message}`);
    deps.print(`Nothing after this step ran. ${err.kind === 'FAILED' ? 'Fix it, then rerun' : 'Rerun when it is done'}; the steps already done are skipped:`);
    deps.print(`  ${rerun}`);
    record(err.step, err.kind, err.message);
    return err.kind === 'FAILED' ? 1 : 3;
  }
  const trackerUrl = String(homeConfig.trackerUrl).replace(/\/+$/, '');
  deps.print('');
  deps.print(`Done: ${slug} is set up. Its tickets: ${trackerUrl}/list/${slug}`);
  record('done', 'done', `${slug} is set up`);
  return 0;
}

// --- The command -----------------------------------------------------------

export const USAGE = 'usage: npm run onboard -- --product <slug> [--allow-replace] [--merge-wait-minutes <n>]';

/** Reads `--product`, `--allow-replace` and `--merge-wait-minutes`. Returns { opts } or { error }. */
export function parseOnboardArgs(argv) {
  const opts = { product: null, allowReplace: false, mergeWaitMinutes: DEFAULT_MERGE_WAIT_MINUTES };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--product') opts.product = argv[++i];
    else if (a === '--allow-replace') opts.allowReplace = true;
    else if (a === '--merge-wait-minutes') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) return { error: `--merge-wait-minutes needs a number of minutes greater than 0 (got ${JSON.stringify(argv[i] ?? null)})` };
      opts.mergeWaitMinutes = n;
    } else return { error: `unknown argument ${JSON.stringify(a)}` };
  }
  if (!opts.product) return { error: 'name the product with --product <slug>' };
  if (slugFromName(opts.product) !== opts.product) return { error: `--product "${opts.product}" is not a slug (lower-case letters, digits and dashes)` };
  return { opts };
}

function realRun(cmd, args, { cwd, input, show, env } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, input, encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
    stdio: show ? ['inherit', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
  });
  return { code: r.status ?? 1, out: String(r.stdout || '').trim(), err: String(r.stderr || r.error?.message || '').trim() };
}

async function main(argv) {
  const parsed = parseOnboardArgs(argv);
  if (parsed.error) { console.error(`${parsed.error}\n${USAGE}`); return 2; }
  const file = findConfigFile(process.cwd());
  let homeConfig;
  try { homeConfig = loadProjectConfig({ file: file ?? undefined, env: {} }); } catch (err) {
    if (!(err instanceof ProjectConfigError)) throw err;
    console.error(`FAILED: start: the tracker home's settings file is not usable — ${err.message}`);
    return 1;
  }
  if (homeConfig.trackerPort == null) {
    console.error('FAILED: start: run this from the folder of the product that runs the tracker (its settings file sets "trackerPort"), not a guest product\'s.');
    return 1;
  }
  const spiralityDir = dirname(file);
  const common = realRun('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: spiralityDir }).out;
  const homeRoot = common ? common.replace(/\/\.git$/, '') : spiralityDir;
  const tty = Boolean(process.stdin.isTTY);
  return onboard(parsed.opts, {
    homeConfig, homeRoot, spiralityDir,
    run: realRun,
    ask: (q) => (tty ? askOnce(q) : null),
    print: (line) => console.log(line),
    exists: (p) => existsSync(p),
    readText: (p) => { try { return readFileSync(p, 'utf8'); } catch (err) { if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EISDIR') return null; throw err; } },
    writeText: (p, t) => writeFileSync(p, t),
    appendText: (p, t) => { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, t); },
    mkdir: (d) => mkdirSync(d, { recursive: true }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  });
}

/**
 * One question in the Terminal. The prompt is opened for that question only
 * and closed straight after, so between questions the Terminal is not held
 * and Ctrl-C stops the wizard as it stops any command.
 */
async function askOnce(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => {
    rl.close();
    console.log('\nStopped (Ctrl-C). Rerun the same command to pick up where it stopped.');
    process.exit(130);
  });
  try { return await rl.question(question); } finally { rl.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`FAILED: onboard stopped on an unexpected error — ${err.stack || err.message}`);
    process.exit(1);
  });
}
