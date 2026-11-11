#!/usr/bin/env node
/**
 * The setup wizard (SP-112): set up a project on Spirality with one command,
 * which asks its questions once and runs every step in order
 * (docs/onboarding/SETUP_REVIEW.md, part 3).
 *
 *   npm run onboard -- --project <slug> [--allow-replace] [--merge-wait-minutes <n>] [--no-prompt]
 *
 * Run on the Mini, from the tracker home's own folder (the project whose
 * settings file sets `trackerPort`, today Spirality), in a Terminal that is
 * not one of that project's lanes. In order:
 *
 *   answers   the answers file, `<logDir>/onboard/<slug>.answers.json`. Only
 *             the fields that are Dane's decisions are asked, and only when
 *             the file does not have them yet; the rest take their defaults
 *             (lib/onboardAnswers.mjs) and can be changed in the file.
 *   look      SP-108's read-only look (`onboard:look`). Anything BLOCKED stops
 *             here, before anything is written.
 *   start     SP-154: only when the GitHub repository is empty (made with no
 *             files, so it has no main branch), push ONE first commit to main
 *             from scripts/onboard/templates/starter/ (lib/onboardStarter.mjs):
 *             package.json whose `verify` passes, package-lock.json, .nvmrc,
 *             .gitignore, a README and one placeholder test. Made in a scratch
 *             folder beside the answers file, pushed without force (so a
 *             repository that gained history meanwhile refuses it), and read
 *             back from GitHub: no longer empty, default branch main, its one
 *             commit the one pushed. A repository with any commit is never
 *             written to here (skipped: it already has a main branch).
 *   clone     SP-119: when the checkout folder does not exist, `git clone` the
 *             project's `main` into it, from the same kind of address (https
 *             or ssh) the tracker home's own origin uses, and read back that
 *             its origin is githubRepo and it is a clean `main`. A folder that
 *             is there is never touched (the look blocks one that is not a
 *             clean checkout of the repository).
 *   settings  SP-109 writes the settings file into a scratch folder beside the
 *             answers file (`onboard:settings write`).
 *   signins   STOP FOR DANE (real secret values): the commands that make the
 *             project's Doppler project if it is missing and run
 *             `tracker:signins create` against the scratch settings file with
 *             TRACKER_DB set to the tracker home's database. SP-124: the
 *             wizard shows them and asks "Run these now? [y/N]". On y it runs
 *             them itself, in order, in Dane's own Terminal with their output
 *             shown; on anything else (or no Terminal) it leaves the block
 *             printed and stops, nothing run. Then it reads back with
 *             `tracker:signins check` and fills in machineUserId
 *             (`onboard:settings fill-machine-user`).
 *   bus       SP-204: only for a project whose answers say it has a bus
 *             (`hasBus`, so its settings file names `busProject`,
 *             "<slug>-bus"): make that tracker project if it is missing
 *             (`tracker:bus`, with TRACKER_DB set to the tracker home's
 *             database), read back, and check each of the project's loop
 *             sign-ins sees it. A bus project that is there already is
 *             left alone; a project with no bus skips this step, and so
 *             does a merged setup (a bus added later comes with the
 *             project's own pull request and `tracker:bus` by hand).
 *   stop, snapshot, import, switch-check
 *             SP-159: only for a project that already runs a loop on ClickUp
 *             (its answers name a `clickupListId`): its old lanes stopped,
 *             its ClickUp list saved and imported into the tracker, and the
 *             switch checked safe, all before the copy step's pull request
 *             can merge (scripts/onboard/fromClickup.mjs). A new project's
 *             run never has these steps.
 *   copy      SP-110's one pull request in the project's repository
 *             (`onboard:copy`), CI's verify green on it.
 *   lanes     SP-111 installs the project's lanes from the setup branch and
 *             files its setup ticket (`onboard:lanes`). First it removes
 *             onboard:copy's worktree, which still holds the setup branch
 *             (git checks a branch out in one place only), read back.
 *   merge     STOP FOR DANE (a decision): his merge phrase on the setup
 *             ticket; the project's own relay merges. The wizard waits for the
 *             merge and reads it back on the project's main.
 *   protect   main protected: the required check `verify`, up to date,
 *             admins included, no force pushes or deletion, no review
 *             required. Read back with `gh api .../branches/main/protection`.
 *
 * Every step first checks whether it is already done and skips it if so, so
 * a rerun resumes where a failed one stopped and asks nothing twice. Once the
 * setup is on the project's main (its settings file is there, with its own
 * machine id), every step up to the merge is done. Each step's outcome goes
 * to the step log, `<logDir>/<slug>-onboard.log`, in Mountain time.
 *
 * A failed step prints `FAILED: <step>: <what was seen>` and the rerun
 * command, and nothing after it runs (rule 6). A stop for Dane that is not
 * answered (no Terminal to wait in, or the merge not made in time) prints
 * `STOPPED: <step>: ...` and the same rerun command. Every project value comes
 * from the answers and settings files (rule 2); the wizard prints no secret
 * (rule 4): the paste block holds commands, never values.
 *
 * `--no-prompt` (SP-125): the wizard never reads the Terminal, so a page can
 * drive it with nobody typing. Answers still missing stop it (`STOPPED`)
 * instead of being asked; the sign-ins stop it with the paste block instead
 * of waiting for "done" (the rerun after the paste finds them and goes on);
 * a setup not merged yet stops it with the setup ticket's link instead of
 * waiting for the merge (the rerun after the merge goes on to protect).
 *
 * The state file, `<logDir>/onboard/<slug>.state.json`, beside the answers
 * file, is what the tracker's setup page reads: every step in STEPS order
 * with its outcome, the stop (what Dane does next), and `finished`. It is
 * written after every step starts and ends and at every stop, beside then
 * renamed (so the page never reads half a file), and read back. Under
 * `--no-prompt` it is the only way anyone sees where the setup stands, so a
 * write that fails there fails the run; in a Terminal it is a warning, as the
 * step log is. It holds no secret: the paste block is commands only.
 *
 * Exit 0 set up, 1 FAILED, 2 usage, 3 stopped for Dane.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { CONFIG_FILE, findConfigFile, loadProjectConfig, ProjectConfigError, withProjectNames } from '../../lib/projectConfig.mjs';
import { AnswersError, answersFile, expandHome, loadAnswers, onboardDir, resolveAnswers, slugFromName } from '../../lib/onboardAnswers.mjs';
import { machineUserPending } from '../../lib/onboardSettings.mjs';
import { ciVerdict, SETUP_BRANCH } from '../../lib/onboardCopy.mjs';
import { LANES, parseStatus } from '../../lib/onboardLanes.mjs';
import { normalRepo } from '../lib/repoCheck.mjs';
import { readEmptiness, starterFiles, starterMessage } from '../../lib/onboardStarter.mjs';
import {
  CLICKUP_FIELDS, CLICKUP_STEPS, installerPath, passInFlight, readInstallerStatus, runsOldLoop, safeToSwitch,
  snapshotArgs, switchDir, switchSettings, withClickupSteps,
} from './fromClickup.mjs';

const require = createRequire(import.meta.url);
const { findTicketId, ticketLink } = require('../../lib/clickupTicketLink.js');

export const DEFAULT_MERGE_WAIT_MINUTES = 60;

export const STEPS = Object.freeze(['answers', 'look', 'start', 'clone', 'settings', 'signins', 'bus', 'copy', 'lanes', 'merge', 'protect']);

/** The steps of a project already on ClickUp (SP-159): STEPS with stop, snapshot, import and switch-check before copy. */
export const CLICKUP_RUN_STEPS = Object.freeze(withClickupSteps(STEPS));

/** Every step a state file may name. */
export const ALL_STEPS = CLICKUP_RUN_STEPS;

/**
 * The answers that are Dane's decisions (SETUP_REVIEW.md part 3, "What a
 * person enters", the fields marked "Dane"): the only ones the wizard asks.
 * `fallback` describes the default shown in brackets; a blank answer writes
 * null, which lib/onboardAnswers.mjs reads as "use the default", and which
 * still counts as answered, so it is not asked again.
 */
export const DANE_FIELDS = Object.freeze([
  { key: 'projectName', question: 'Project name, as the tracker shows it', required: true },
  { key: 'githubRepo', question: 'GitHub repository, as owner/name', required: true },
  { key: 'trackerPrefix', question: 'Ticket prefix (the start of every ticket id)', fallback: ({ slug }) => slug.replace(/[^a-z]/g, '').slice(0, 2).toUpperCase() || null },
  { key: 'mergePhrases', question: 'Merge phrases, the words that mean "merge this" (comma between)', list: true, fallback: ({ homeConfig }) => homeConfig.mergePhrases.join(', ') },
  { key: 'autoMergeLanes', question: 'Lanes that may merge without you (comma between)', list: true, fallback: () => 'none' },
  { key: 'extraGovernancePaths', question: 'Extra protected files, beyond the usual list (comma between)', list: true, fallback: () => 'none' },
  // SP-204. `added`: a question added after setups were already under way,
  // so an answers file that has every other answer is not stopped for it
  // (its default, no bus, stands); it is asked whenever anything else is.
  { key: 'hasBus', question: 'Does it raise its alarms on a bus, a tracker project of its own? (yes or no)', yesNo: true, added: true, fallback: () => 'no' },
  { key: 'description', question: 'What the project is, in two or three sentences, for its CLAUDE.md', required: true },
]);

/**
 * A typed answer as the answers file holds it: blank -> null (the default);
 * a list split on commas; "none" -> []; a yes-or-no answer true or false
 * (anything else is kept as typed, so the answers check refuses it by name).
 */
export function answerValue(field, typed) {
  const text = String(typed ?? '').trim();
  if (!text) return null;
  if (field.yesNo) {
    if (/^(y|yes|true)$/i.test(text)) return true;
    if (/^(n|no|false)$/i.test(text)) return false;
    return text;
  }
  if (!field.list) return text;
  if (/^none$/i.test(text)) return [];
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * The Dane fields an answers object has not answered yet (a field set to
 * null is answered: it takes the default). A field marked `added` is only
 * missing alongside another one, so a setup begun before it was asked is
 * never stopped for it alone.
 */
export function unanswered(raw) {
  const missing = DANE_FIELDS.filter((f) => !Object.hasOwn(raw, f.key));
  return missing.some((f) => !f.added) ? missing : [];
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
 * the project's own folder while onboard:copy's worktree still holds it.
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
  return `npm run onboard -- --project ${opts.project}${opts.allowReplace ? ' --allow-replace' : ''}${opts.mergeWaitMinutes !== DEFAULT_MERGE_WAIT_MINUTES ? ` --merge-wait-minutes ${opts.mergeWaitMinutes}` : ''}${opts.noPrompt ? ' --no-prompt' : ''}`;
}

/** Where the setup page reads a project's setup state: `<logDir>/onboard/<slug>.state.json`, beside its answers file. */
export function stateFile(homeConfig, slug) {
  return join(onboardDir(homeConfig), `${slug}.state.json`);
}

/** The outcomes a step can have in the state file. */
export const OUTCOMES = Object.freeze(['done', 'skip', 'failed', 'stopped', 'running', 'pending']);

/** The kinds of stop: what Dane does next. */
export const STOP_KINDS = Object.freeze(['answers', 'paste', 'merge', 'failed']);

/** A fresh state: every step pending, no stop, not finished. */
export function initialState(project, at) {
  return {
    project,
    updatedAt: at,
    steps: STEPS.map((step) => ({ step, outcome: 'pending', at: null, why: null })),
    stop: null,
    finished: false,
  };
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

/** A word in single quotes for the shell, so a project name with a space or a quote pastes safely. */
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
  cmds.push({ cmd: 'npm', args: ['run', 'tracker:signins', '--', 'create', '--name', answers.projectName, '--prefix', answers.trackerPrefix, '--config', settingsFile], env: { TRACKER_DB: trackerDb } });
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
  /** `kind` FAILED or STOPPED; `next` the state file's stop: { kind, commands, link }. */
  constructor(kind, step, seen, next = {}) {
    super(seen);
    this.kind = kind;
    this.step = step;
    this.next = { kind: kind === 'FAILED' ? 'failed' : next.kind, commands: next.commands ?? [], link: next.link ?? null };
  }
}

const last = (text, n = 4) => String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' | ');

/**
 * The wizard. `opts`: project, allowReplace, mergeWaitMinutes, noPrompt. `deps`:
 *   homeConfig, homeRoot, spiralityDir   the tracker home
 *   run(cmd, args, { cwd, input, show, env }) -> { code, out, err }; `show`
 *                                         lets Dane watch a step script's own
 *                                         lines; `env` adds to the environment
 *   ask(question) -> string, or null when there is no Terminal to ask in
 *   print(line), exists(path), readText(path) -> text|null, writeText(path, text),
 *   appendText(path, text), mkdir(dir), rename(from, to), remove(path),
 *   removeTree(dir), sleep(ms), now() -> ms
 *   nodeVersion                          this Mac's Node ("v22.23.3"), for the start step
 * Returns the exit code.
 */
export async function onboard(opts, deps) {
  const { homeConfig, spiralityDir } = deps;
  const slug = opts.project;
  const rerun = rerunCommand(opts);
  const logFile = join(expandHome(homeConfig.logDir), `${slug}-onboard.log`);
  const say = (step, line) => deps.print(`${step.padEnd(9)} ${line}`);
  const record = (step, outcome, text) => {
    try { deps.appendText(logFile, `${mountainStamp(new Date(deps.now()))} | ${step} | ${outcome} | ${text}\n`); } catch (err) {
      deps.print(`(could not write the step log ${logFile}: ${err.code || err.message})`);
    }
  };
  // The state file the setup page reads. Every write goes beside the file,
  // is renamed over it, and is read back (rule 5).
  const sFile = stateFile(homeConfig, slug);
  const iso = () => new Date(deps.now()).toISOString();
  const state = initialState(slug, iso());
  let stateBroken = null;
  let stateWarned = false;
  const saveState = () => {
    state.updatedAt = iso();
    const written = `${JSON.stringify(state, null, 2)}\n`;
    const temp = `${sFile}.${process.pid}.tmp`;
    try {
      deps.mkdir?.(dirname(sFile));
      deps.writeText(temp, written);
      deps.rename(temp, sFile);
      if (deps.readText(sFile) !== written) throw new Error('it did not read back as written');
    } catch (err) {
      // Never leave a half-written file beside it.
      try { deps.remove?.(temp); } catch { /* the warning below names the real failure */ }
      const why = `could not write the state file ${sFile}: ${err.code || err.message}`;
      if (opts.noPrompt) { stateBroken = why; return false; }
      // In a Terminal it is a warning, said once, not on every step.
      if (!stateWarned) deps.print(`(${why}; the setup page will not see this run)`);
      stateWarned = true;
    }
    return true;
  };
  const mark = (step, outcome, why) => {
    const entry = state.steps.find((s) => s.step === step);
    if (entry) Object.assign(entry, { outcome, at: iso(), why: why ?? null });
    if (!saveState()) throw new Stop('FAILED', 'state', stateBroken);
  };
  const begin = (step) => mark(step, 'running', null);
  const done = (step, line) => { say(step, line); record(step, 'done', line); mark(step, 'done', line); };
  const skip = (step, why) => { say(step, `already done (${why})`); record(step, 'skip', why); mark(step, 'skip', why); };
  const fail = (step, seen) => { throw new Stop('FAILED', step, seen); };
  const stop = (step, seen, next) => { throw new Stop('STOPPED', step, seen, next); };
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
    begin(step);
    const aFile = answersFile(homeConfig, slug);
    let raw = {};
    const text = deps.readText(aFile);
    if (text != null) {
      try { raw = JSON.parse(text); } catch (err) { fail(step, `${aFile} is not valid JSON (${err.message}); fix or remove it`); }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(step, `${aFile} does not hold one JSON object`);
      // An answers file from before SP-130 uses the old names (productSlug and the others).
      try { raw = withProjectNames(raw, { file: aFile }); } catch (err) {
        if (!(err instanceof ProjectConfigError)) throw err;
        fail(step, err.message);
      }
    }
    if (Object.hasOwn(raw, 'projectSlug') && raw.projectSlug !== slug) fail(step, `${aFile} is for "${raw.projectSlug}", not ${slug}`);
    const missing = unanswered(raw);
    if (!missing.length) {
      skip(step, `every answer that is yours is in ${aFile}`);
    } else if (opts.noPrompt) {
      stop(step, `still to answer: ${missing.map((f) => f.key).join(', ')}. Fill them in on the setup page, or write them in ${aFile}`, { kind: 'answers' });
    } else {
      say(step, `${missing.length} question(s) for you, Dane (decisions only you can make). Press Enter to take the default in brackets.`);
      const typed = {};
      for (const field of missing) {
        const fallback = field.fallback ? field.fallback({ slug, homeConfig }) : null;
        let value = null;
        for (let tries = 0; ; tries += 1) {
          const got = await deps.ask(`${field.question}${fallback ? ` [${fallback}]` : ''}: `);
          if (got == null) {
            stop(step, `no Terminal to ask in; still to answer: ${missing.filter((f) => !Object.hasOwn(typed, f.key)).map((f) => f.key).join(', ')}. Write them in ${aFile}, or run this in a Terminal`, { kind: 'answers' });
          }
          value = answerValue(field, got);
          if (value != null || !(field.required || field.requiredWith)) break;
          if (tries >= 2) fail(step, `"${field.key}" has no default and was left blank three times`);
          deps.print('  That one has no default; it needs an answer.');
        }
        typed[field.key] = value;
      }
      const next = { ...raw, projectSlug: slug, ...typed };
      const written = `${JSON.stringify(next, null, 2)}\n`;
      try {
        deps.mkdir?.(dirname(aFile));
        deps.writeText(aFile, written);
      } catch (err) { fail(step, `could not write ${aFile}: ${err.code || err.message}`); }
      if (deps.readText(aFile) !== written) fail(step, `${aFile} did not read back as written`);
      raw = next;
      say(step, `wrote ${aFile}, read back`);
    }
    const loadAnswersFrom = (obj) => resolveAnswers(obj, { homeConfig, homeRoot: deps.homeRoot, file: aFile });
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
    const checkout = expandHome(answers.checkoutDir);
    // SP-159: a checkout here with a loop installer of its own and no
    // Spirality settings file is a project already running a loop, maybe on
    // ClickUp. Asked once: the answer, even "no", is kept in the answers file.
    let askedClickup = false;
    if (!Object.hasOwn(raw, 'clickupListId') && runsOldLoop(checkout, deps.exists)) {
      if (opts.noPrompt) {
        // The setup page's answers form asks these once it sees the same
        // old loop (tracker/setup.mjs, asksClickup), so this stop is answered there.
        stop(step, `${checkout} already runs a loop of its own (${installerPath(checkout)}), so it needs the ClickUp answers: its Loop Queue list id (blank if it is not on ClickUp), your ClickUp user id and the old loop's ClickUp machine user id. Fill them in on its setup page's answers form`, { kind: 'answers' });
      }
      say(step, `${checkout} already runs a loop of its own (${installerPath(checkout)}), so one more question.`);
      const typed = {};
      for (const field of CLICKUP_FIELDS) {
        if (field.key !== 'clickupListId' && typed.clickupListId == null) break;
        const fallback = field.fallback ? field.fallback() : null;
        let value = null;
        for (let tries = 0; ; tries += 1) {
          const got = await deps.ask(`${field.question}${fallback ? ` [${fallback}]` : ''}: `);
          if (got == null) stop(step, `no Terminal to ask in; write "clickupListId" in ${aFile} (null if it is not on ClickUp), or run this in a Terminal`, { kind: 'answers' });
          value = answerValue(field, got);
          if (value != null || !(field.required || field.requiredWith)) break;
          if (tries >= 2) fail(step, `"${field.key}" has no default and was left blank three times`);
          deps.print('  That one has no default; it needs an answer.');
        }
        typed[field.key] = value;
      }
      const next = { ...raw, projectSlug: slug, ...typed };
      try {
        answers = loadAnswersFrom(next);
      } catch (err) {
        if (!(err instanceof AnswersError)) throw err;
        // Nothing is written, so the rerun asks the ClickUp question again.
        fail(step, `${err.message}. The rerun asks it again`);
      }
      const written = `${JSON.stringify(next, null, 2)}\n`;
      try { deps.writeText(aFile, written); } catch (err) { fail(step, `could not write ${aFile}: ${err.code || err.message}`); }
      if (deps.readText(aFile) !== written) fail(step, `${aFile} did not read back as written`);
      raw = next;
      askedClickup = true;
      say(step, answers.clickupListId ? `on ClickUp, list ${answers.clickupListId}: the stop, snapshot, import and switch-check steps run before the copy` : 'not on ClickUp: set up as a new project');
    }
    if (missing.length || askedClickup) { record(step, 'done', `answers in ${aFile}`); mark(step, 'done', `answers in ${aFile}`); }
    const onClickup = answers.clickupListId != null;
    if (onClickup) {
      // The state file shows this run's own steps, the ClickUp ones included.
      const had = new Map(state.steps.map((s) => [s.step, s]));
      state.steps = CLICKUP_RUN_STEPS.map((s) => had.get(s) ?? { step: s, outcome: 'pending', at: null, why: null });
      if (!saveState()) throw new Stop('FAILED', 'state', stateBroken);
    }
    const sameRepo = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    // Once the project's main has its settings file, with its own machine id,
    // the setup pull request has merged: every step up to the merge is done.
    const onMain = () => {
      if (deps.readText(join(checkout, '.git', 'HEAD')) == null && deps.readText(join(checkout, '.git')) == null) return { on: false, why: `${checkout} is not cloned yet` };
      const f = run('git', ['fetch', '-q', 'origin'], { cwd: checkout });
      if (f.code !== 0) return { on: false, why: `git fetch in ${checkout} failed: ${last(f.err)}` };
      const shown = run('git', ['show', `origin/main:${CONFIG_FILE}`], { cwd: checkout });
      if (shown.code !== 0) return { on: false, why: `${answers.githubRepo}'s main has no ${CONFIG_FILE} yet` };
      let s;
      try { s = JSON.parse(shown.out); } catch { return { on: false, why: `${answers.githubRepo}'s main has a ${CONFIG_FILE} that is not JSON` }; }
      // A settings file on main may still use the old names (SP-130).
      try { s = withProjectNames(s, { file: `${answers.githubRepo}'s main ${CONFIG_FILE}` }); } catch (err) {
        if (!(err instanceof ProjectConfigError)) throw err;
        return { on: false, why: err.message };
      }
      if (s.projectSlug !== slug || !sameRepo(s.githubRepo, answers.githubRepo)) return { on: false, why: `the ${CONFIG_FILE} on ${answers.githubRepo}'s main is not ${slug}'s` };
      if (machineUserPending(s)) return { on: false, why: `the ${CONFIG_FILE} on ${answers.githubRepo}'s main has no machine id yet` };
      return { on: true, why: `${answers.githubRepo}'s main has ${slug}'s settings file` };
    };
    let setup = onMain();

    // ── look ─────────────────────────────────────────────────────────────
    step = 'look';
    begin(step);
    if (setup.on) skip(step, `the setup is merged: ${setup.why}`);
    else if (loggedDone(deps.readText(logFile), step)) skip(step, `it passed before (${logFile})`);
    else {
      say(step, `running the read-only look (onboard:look); nothing is written`);
      const r = npm('onboard:look', ['--answers', aFile], { show: true });
      if (r.code === 3) fail(step, 'something is BLOCKED (the look\'s lines above say what); nothing was written');
      if (r.code !== 0) fail(step, `the look could not tell everything (exit ${r.code}; its lines above say what)`);
      done(step, 'nothing is BLOCKED');
    }

    // ── start ────────────────────────────────────────────────────────────
    step = 'start';
    begin(step);
    const readRepo = () => {
      const v = gh('repo', 'view', answers.githubRepo, '--json', 'isEmpty,defaultBranchRef');
      if (v.code !== 0) return { error: `gh repo view ${answers.githubRepo} failed: ${last(v.err || v.out) || `exit ${v.code}`}` };
      const seen = readEmptiness(v.out);
      return seen ?? { error: `gh repo view ${answers.githubRepo} did not answer with whether it is empty` };
    };
    if (setup.on) skip(step, `the setup is merged: ${setup.why}`);
    else {
      const before = readRepo();
      if (before.error) fail(step, before.error);
      if (!before.empty) skip(step, `${answers.githubRepo} already has a main branch (${before.branch ?? 'its default branch could not be read'}); a repository with history is never written to here`);
      else {
        let files;
        try { files = starterFiles(answers, deps.nodeVersion ?? process.version); } catch (err) { fail(step, err.message); }
        const work = join(onboardDir(homeConfig), `${slug}-start`);
        say(step, `${answers.githubRepo} is empty; making its first commit on main in ${work}`);
        // A folder left by a failed run is made again from nothing.
        try { deps.removeTree(work); deps.mkdir(work); } catch (err) { fail(step, `could not make ${work}: ${err.code || err.message}`); }
        for (const f of files) {
          const at = join(work, f.path);
          try { deps.mkdir(dirname(at)); deps.writeText(at, f.text); } catch (err) { fail(step, `could not write ${at}: ${err.code || err.message}`); }
          if (deps.readText(at) !== f.text) fail(step, `${at} did not read back as written`);
        }
        const g = (...args) => run('git', args, { cwd: work });
        const must = (r, what) => { if (r.code !== 0) fail(step, `${what} in ${work} failed: ${last(r.err || r.out) || `exit ${r.code}`}`); return r; };
        must(g('init', '--quiet', '--initial-branch=main'), 'git init');
        must(g('add', '--all'), 'git add');
        must(g('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', starterMessage(answers)), 'git commit');
        const sha = must(g('rev-parse', 'HEAD'), 'git rev-parse HEAD').out.trim();
        const tracked = must(g('ls-files'), 'git ls-files').out.split('\n').map((l) => l.trim()).filter(Boolean).sort();
        const meant = files.map((f) => f.path).sort();
        if (tracked.join('\n') !== meant.join('\n')) fail(step, `the first commit in ${work} holds ${tracked.join(', ') || 'nothing'}, not ${meant.join(', ')}`);
        const home = run('git', ['remote', 'get-url', 'origin']);
        const address = cloneAddress(home.code === 0 ? home.out : null, answers.githubRepo);
        // No --force, ever: a push onto history is refused by git itself.
        must(g('push', '--quiet', address, 'main:main'), `git push to ${answers.githubRepo}`);
        // GitHub can take a moment to stop calling a repository empty.
        let after = null;
        let commit = null;
        for (let tries = 0; tries < 6; tries += 1) {
          if (tries) await deps.sleep(5000);
          after = readRepo();
          const c = ghJson('api', `repos/${answers.githubRepo}/commits/main`);
          commit = c.ok ? c.json : null;
          if (!after.error && !after.empty && after.branch === 'main' && commit?.sha === sha) break;
        }
        if (after.error) fail(step, `pushed, but reading it back failed: ${after.error}`);
        if (after.empty || after.branch !== 'main') fail(step, `pushed, but GitHub reads ${answers.githubRepo} back as ${after.empty ? 'still empty' : `on default branch ${after.branch ?? '(none)'}`}, not main`);
        if (commit?.sha !== sha) fail(step, `pushed, but main on GitHub is ${commit?.sha ?? 'unreadable'}, not the commit made (${sha})`);
        if ((commit.parents ?? []).length !== 0) fail(step, `pushed, but main's newest commit on GitHub has a parent: it is not the one first commit`);
        try { deps.removeTree(work); } catch { /* the scratch folder is remade on the next run */ }
        done(step, `${answers.githubRepo}'s first commit ${sha.slice(0, 7)} pushed to main, read back: not empty, default branch main (${meant.join(', ')})`);
      }
    }

    // ── clone ────────────────────────────────────────────────────────────
    step = 'clone';
    begin(step);
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
      // SP-159: the ClickUp question is asked only once the checkout is
      // there. A clone that brings an old loop's installer with it stops
      // here, before the sign-ins, so the rerun's answers step (or the
      // setup page's form, which sees the same checkout) asks it.
      if (!Object.hasOwn(raw, 'clickupListId') && runsOldLoop(checkout, deps.exists)) {
        stop(step, `the clone at ${checkout} already runs a loop of its own (${installerPath(checkout)}), so it needs the ClickUp answers before anything else is set up: ${opts.noPrompt ? 'fill them in on its setup page\'s answers form' : 'rerun, and the answers step asks them'}`, { kind: 'answers' });
      }
      setup = onMain();
    }

    // ── settings ─────────────────────────────────────────────────────────
    step = 'settings';
    begin(step);
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
      if (have && have.projectSlug === slug && sameRepo(have.githubRepo, answers.githubRepo) && (have.busProject ?? null) === answers.busProject) {
        config = have;
        skip(step, `${settingsFile} is ${slug}'s and reads`);
      } else {
        const r = npm('onboard:settings', ['write', '--answers', aFile, '--out', scratch], { show: true });
        if (r.code !== 0) fail(step, `onboard:settings write exit ${r.code} (its FAILED line is above)`);
        config = readSettings();
        if (!config || config.projectSlug !== slug) fail(step, `${settingsFile} does not read back as ${slug}'s settings file`);
        done(step, `${settingsFile} written and read back`);
      }
    }

    // ── signins ──────────────────────────────────────────────────────────
    step = 'signins';
    begin(step);
    if (setup.on) skip(step, `the setup is merged: ${setup.why}`);
    else {
      // A project that does not host the tracker names no trackerDataDir, so
      // the check is given the home's database, as the paste block's create is.
      const trackerDb = join(expandHome(homeConfig.trackerDataDir), 'tracker.db');
      const check = () => npm('tracker:signins', ['check', '--config', settingsFile], { env: { TRACKER_DB: trackerDb } });
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
        const block = { answers, settingsFile, trackerDb, projectExists, configExists };
        const lines = pasteBlock({ spiralityDir, ...block });
        deps.print('');
        deps.print(`Your move, Dane (real secret values): these commands ${projectExists ? '' : `make the Doppler project "${answers.dopplerProject}", then `}make ${answers.projectName}'s tracker project and its sign-ins, and write their keys into Doppler. No key is shown.`);
        deps.print('');
        for (const line of lines) deps.print(`  ${line}`);
        deps.print('');
        // The stop carries the block, so the setup page can show it.
        const paste = { kind: 'paste', commands: lines };
        if (opts.noPrompt) stop(step, 'waiting on you to run the block above; the rerun after it finds the sign-ins and goes on', paste);
        // Only y runs them. A blank answer (an Enter pressed while a step ran
        // and held by the Terminal) is a no: it stops, and nothing is run.
        const typed = await deps.ask('Run these now, here, in this Terminal? [y/N] ');
        if (typed == null) stop(step, 'the block above is not run (no Terminal here to ask in); paste it into a Terminal on the Mini, then rerun', paste);
        if (!saidYes(typed)) stop(step, 'the block above is not run (you did not answer y); run it, or rerun and answer y', paste);
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

    // ── bus (SP-204) ─────────────────────────────────────────────────────
    step = 'bus';
    begin(step);
    if (setup.on) skip(step, `the setup is merged: ${setup.why}`);
    else if (!answers.busProject) skip(step, `${slug} has no bus (hasBus is not true in ${aFile})`);
    else {
      const busFile = settingsFile;
      const busConfig = config ?? readSettings();
      if (!busConfig) fail(step, `${busFile} does not read, so the bus cannot be checked against it`);
      if (busConfig.busProject !== answers.busProject) fail(step, `${busFile} names busProject ${JSON.stringify(busConfig.busProject)}, not "${answers.busProject}"`);
      const trackerDb = join(expandHome(homeConfig.trackerDataDir), 'tracker.db');
      const r = npm('tracker:bus', ['--config', busFile, '--name', answers.projectName], { env: { TRACKER_DB: trackerDb } });
      for (const line of `${r.out}\n${r.err}`.split('\n').map((l) => l.trim()).filter(Boolean)) say(step, line);
      if (r.code !== 0) fail(step, `tracker:bus exit ${r.code}: ${last(r.err || r.out)}`);
      if (/: made, /.test(r.out)) done(step, `bus project "${answers.busProject}" made on the tracker, read back, and every ${slug} loop sees it`);
      else skip(step, `bus project "${answers.busProject}" is on the tracker and every ${slug} loop sees it`);
    }

    // ── stop, snapshot, import, switch-check (SP-159) ────────────────────
    // Only for a project already on ClickUp; a new project's run has none
    // of these steps. Each is skipped once the step log has it done (its
    // lanes are loaded again by the lanes step, from the setup branch, so
    // "nothing loaded" cannot tell on a rerun), or once the setup is merged.
    if (onClickup) {
      const doneBefore = (s) => setup.on ? `the setup is merged: ${setup.why}` : loggedDone(deps.readText(logFile), s) ? `it was done before (${logFile})` : null;
      const trackerDb = join(expandHome(homeConfig.trackerDataDir), 'tracker.db');
      // The switch settings file, written (and read back) the first time a
      // tracker script needs it, from the scratch settings file.
      let switchFolder = null;
      const switchConfig = () => {
        if (switchFolder) return switchFolder;
        const folder = switchDir(onboardDir(homeConfig), slug);
        const file = join(folder, CONFIG_FILE);
        let settings;
        try { settings = JSON.parse(deps.readText(settingsFile) ?? 'null'); } catch { settings = null; }
        if (!settings || typeof settings !== 'object') fail(step, `${settingsFile} does not read, so the switch settings file cannot be made from it`);
        let next;
        try { next = switchSettings(settings, answers, homeConfig); } catch (err) {
          if (!(err instanceof ProjectConfigError)) throw err;
          fail(step, `the switch settings file would not be usable: ${err.message}`);
        }
        const written = `${JSON.stringify(next, null, 2)}\n`;
        try { deps.mkdir(folder); deps.writeText(file, written); } catch (err) { fail(step, `could not write ${file}: ${err.code || err.message}`); }
        if (deps.readText(file) !== written) fail(step, `${file} did not read back as written`);
        say(step, `the tracker scripts read ${file}: ${slug}'s settings with ClickUp list ${answers.clickupListId}, your ClickUp seat ${answers.clickupOperatorId} and the old loop's ${answers.clickupMachineUserId}`);
        switchFolder = folder;
        return folder;
      };
      // A tracker script, run from Spirality's folder under the project's
      // own Doppler keys, in the switch settings file's folder (it reads its
      // project config from the folder it runs in).
      const trackerScript = (script, args, o = {}) => {
        const cwd = switchConfig();
        return run('node', [join(spiralityDir, 'scripts', 'with_doppler.mjs'), 'node', '--no-warnings', join(spiralityDir, 'tracker', script), ...args], { cwd, ...o });
      };

      // ── stop ─────────────────────────────────────────────────────────
      step = 'stop';
      begin(step);
      const installer = installerPath(checkout);
      const status = () => {
        const r = run('bash', [installer, '--status'], { cwd: checkout });
        if (r.code !== 0) fail(step, `${installer} --status ended with exit ${r.code}: ${last(r.err || r.out)}`);
        const jobs = readInstallerStatus(r.out);
        if (!jobs.length) fail(step, `${installer} --status names no lanes, so they cannot be read from it`);
        return jobs;
      };
      let snapshotDryRan = false;
      const skipStop = doneBefore(step);
      if (skipStop) skip(step, skipStop);
      else if (!deps.exists(installer)) fail(step, `${installer} is not there, so its lanes cannot be read from it`);
      else {
        const loaded = status().filter((j) => j.loaded);
        if (!loaded.length) done(step, `none of ${slug}'s old lanes is loaded (${installer} --status)`);
        else {
          // Before anything is stopped, the snapshot's dry run proves the
          // next step can read ClickUp under the project's own keys (its
          // CLICKUP_API_TOKEN in Doppler, the lists answering). If it
          // cannot, the old loop keeps running until that is fixed. It reads
          // every ticket, so it can take minutes: it goes first, and the
          // in-flight check comes after it, right before the unload.
          say(step, 'before stopping anything, the snapshot\'s dry run checks ClickUp can be read under this project\'s keys (it only reads)');
          const pre = trackerScript('clickupSnapshot.mjs', snapshotArgs(answers, { dryRun: true }), { show: true });
          if (pre.code !== 0) fail(step, `the snapshot's dry run ended with exit ${pre.code} (its lines above say what), so the old lanes were left running: fix that, then rerun. Nothing was stopped`);
          snapshotDryRan = true;
          // No pass may be cut off mid-way, so the lanes are read again now,
          // with nothing slow between this check and the unload. A lane
          // whose log ends on a START with no END is mid-pass, unless its
          // --status proves the runner is gone: a STALE lock, or no lock
          // AND launchd showing no process (so that START is a pass killed
          // mid-way). A lock of none alone is not proof: a job that takes
          // no lock always says none (passInFlight). A lane
          // with no pass in its log is idle. (A log not there yet has no
          // pass: the runner writes START into it before a pass begins.) A
          // loaded lane whose --status names no log cannot be checked at
          // all, so nothing is stopped.
          const now = status().filter((j) => j.loaded);
          for (const job of now) {
            if (!job.log) fail(step, `${job.name} is loaded, but ${installer} --status names no log for it, so whether a pass is in flight cannot be checked. Nothing was stopped`);
            const seen = passInFlight(deps.readText(expandHome(job.log)), job);
            if (seen?.running) fail(step, `a ${job.name} pass is in flight (started ${seen.started ?? 'at a time its log does not say'}, ${job.log}); wait for it to end, then rerun. Nothing was stopped`);
          }
          if (!now.length) done(step, `none of ${slug}'s old lanes is loaded any more (${installer} --status)`);
          else {
            const labels = now.map((j) => j.label ?? j.name);
            say(step, `no pass is in flight; stopping ${labels.join(', ')} with ${installer} --uninstall`);
            const u = run('bash', [installer, '--uninstall'], { cwd: checkout, show: true });
            if (u.code !== 0) fail(step, `${installer} --uninstall ended with exit ${u.code} (its lines above say what)`);
            const still = status().filter((j) => j.loaded);
            if (still.length) fail(step, `after ${installer} --uninstall these are still loaded: ${still.map((j) => j.label ?? j.name).join(', ')}`);
            done(step, `stopped ${labels.join(', ')}; ${installer} --status reads back every one not loaded`);
          }
        }
      }

      // ── snapshot ─────────────────────────────────────────────────────
      step = 'snapshot';
      begin(step);
      const skipSnap = doneBefore(step);
      if (skipSnap) skip(step, skipSnap);
      else {
        const lists = [answers.clickupListId, ...answers.clickupExtraLists].join(', ');
        if (snapshotDryRan) say(step, `saving a full copy of ClickUp list(s) ${lists} on this Mac (tracker:snapshot); its dry run passed before the stop`);
        else {
          say(step, `saving a full copy of ClickUp list(s) ${lists} on this Mac (tracker:snapshot), a dry run first; it only reads ClickUp`);
          const dry = trackerScript('clickupSnapshot.mjs', snapshotArgs(answers, { dryRun: true }), { show: true });
          if (dry.code !== 0) fail(step, `the snapshot's dry run ended with exit ${dry.code} (its lines above say what); nothing was saved`);
        }
        const real = trackerScript('clickupSnapshot.mjs', snapshotArgs(answers, { dryRun: false }), { show: true });
        if (real.code === 3) fail(step, 'the snapshot was saved, but a count DIFFERS from what ClickUp reports (its lines above name it)');
        if (real.code !== 0) fail(step, `the snapshot ended with exit ${real.code} (its lines above say what); there is no snapshot`);
        done(step, `ClickUp list(s) ${lists} saved and packed under ${homeConfig.trackerDataDir}, every count OK`);
      }

      // ── import ───────────────────────────────────────────────────────
      step = 'import';
      begin(step);
      // The import is skipped only once switch-check has said Safe to
      // switch. Until then a rerun imports again: switch-check's NOT YET
      // IMPORTED and STATUS DIFFERS both mean "run the real import again",
      // and the import is safe to rerun (it carries on where it was).
      const skipImport = setup.on ? `the setup is merged: ${setup.why}`
        : loggedDone(deps.readText(logFile), 'switch-check') ? `switch-check said Safe to switch before (${logFile})` : null;
      if (skipImport) skip(step, skipImport);
      else {
        if (loggedDone(deps.readText(logFile), step)) say(step, 'imported before, but switch-check has not said Safe to switch yet, so the import runs again (it is safe to rerun)');
        say(step, `importing ClickUp list ${answers.clickupListId} into ${trackerDb} (tracker:import), a dry run first`);
        const dry = trackerScript('import.mjs', ['--db', trackerDb, '--dry-run'], { show: true });
        if (dry.code === 3) fail(step, 'the import\'s dry run refused something (its lines above name it); nothing was written');
        if (dry.code !== 0) fail(step, `the import's dry run ended with exit ${dry.code} (its lines above say what); nothing was written`);
        const real = trackerScript('import.mjs', ['--db', trackerDb], { show: true });
        if (real.code === 3) fail(step, 'the import finished, but refused something (its lines above name it)');
        if (real.code !== 0) fail(step, `the import ended with exit ${real.code} (its lines above say what); it is safe to rerun, and carries on`);
        done(step, `ClickUp list ${answers.clickupListId} imported into ${trackerDb}, nothing refused`);
      }

      // ── switch-check ─────────────────────────────────────────────────
      step = 'switch-check';
      begin(step);
      const skipCheck = doneBefore(step);
      if (skipCheck) skip(step, skipCheck);
      else {
        // Read, not shown: its last line is what decides.
        const r = trackerScript('switchCheck.mjs', [], { env: { TRACKER_DB: trackerDb } });
        for (const line of String(r.out || '').split('\n')) deps.print(`  ${line}`);
        if (r.err) for (const line of String(r.err).split('\n')) deps.print(`  ${line}`);
        if (!safeToSwitch(r)) fail(step, `tracker:switch-check did not say "Safe to switch." (exit ${r.code}; its NOT OK lines above say what)`);
        done(step, 'tracker:switch-check: Safe to switch.');
      }
    }

    // ── copy ─────────────────────────────────────────────────────────────
    step = 'copy';
    begin(step);
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
        // A project on ClickUp has an old copy of the loop that the setup
        // replaces, so it always runs with --allow-replace (SP-159).
        const r = npm('onboard:copy', ['--answers', aFile, '--config', settingsFile, ...(opts.allowReplace || onClickup ? ['--allow-replace'] : [])], { show: true });
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
    begin(step);
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
        // checks the branch out in the project's own folder. Its work is
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
    begin(step);
    if (setup.on) skip(step, setup.why);
    else {
      const link = ticketLink(ticket, linkOpts);
      deps.print('');
      deps.print(`Your move, Dane (a decision): if you are happy with ${prUrl}, write your merge phrase (${config.mergePhrases.map((p) => `"${p}"`).join(', ')}) as a comment on ${ticket}: ${link}`);
      deps.print(opts.noPrompt
        ? `${slug}'s own relay merges it through the usual checks. Rerun once it has merged.`
        : `${slug}'s own relay merges it through the usual checks. This waits up to ${opts.mergeWaitMinutes} minutes for it.`);
      deps.print('');
      // With --no-prompt there is no wait: one look, and a stop if it is not merged.
      const deadline = opts.noPrompt ? deps.now() : deps.now() + opts.mergeWaitMinutes * 60 * 1000;
      let pr;
      for (;;) {
        const v = ghJson('pr', 'view', prUrl, '--json', 'state,mergeCommit');
        if (!v.ok) fail(step, `could not read ${prUrl}: ${last(v.r.err || v.r.out)}`);
        pr = v.json;
        if (pr.state === 'MERGED') break;
        if (pr.state !== 'OPEN') fail(step, `${prUrl} is ${pr.state}, not merged`);
        if (deps.now() >= deadline) stop(step, `${prUrl} is not merged yet; it waits on your merge phrase on ${ticket} (${link})`, { kind: 'merge', link });
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
    begin(step);
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
  } catch (thrown) {
    let err = thrown;
    // Any other error is the running step failing (rule 6): the state file
    // must not go on saying "running" over a run that died.
    if (!(err instanceof Stop)) {
      deps.print('');
      deps.print(String(thrown?.stack || thrown));
      err = new Stop('FAILED', step, `unexpected error — ${thrown?.message ?? String(thrown)}`);
    }
    deps.print('');
    deps.print(`${err.kind}: ${err.step}: ${err.message}`);
    deps.print(`Nothing after this step ran. ${err.kind === 'FAILED' ? 'Fix it, then rerun' : 'Rerun when it is done'}; the steps already done are skipped:`);
    deps.print(`  ${rerun}`);
    record(err.step, err.kind, err.message);
    // The state file's own write failing is the one stop it cannot record.
    if (err.step !== 'state') {
      const entry = state.steps.find((s) => s.step === err.step);
      if (entry) Object.assign(entry, { outcome: err.kind === 'FAILED' ? 'failed' : 'stopped', at: iso(), why: err.message });
      state.stop = { step: err.step, kind: err.next.kind, why: err.message, commands: err.next.commands, link: err.next.link };
      if (!saveState()) {
        deps.print(`FAILED: state: ${stateBroken}`);
        return 1;
      }
    }
    return err.kind === 'FAILED' ? 1 : 3;
  }
  state.finished = true;
  if (!saveState()) {
    deps.print('');
    deps.print(`FAILED: state: ${stateBroken}`);
    deps.print(`Every step is done, but the setup page cannot see it. Fix it, then rerun:`);
    deps.print(`  ${rerun}`);
    return 1;
  }
  const trackerUrl = String(homeConfig.trackerUrl).replace(/\/+$/, '');
  deps.print('');
  deps.print(`Done: ${slug} is set up. Its tickets: ${trackerUrl}/list/${slug}`);
  record('done', 'done', `${slug} is set up`);
  return 0;
}

// --- The command -----------------------------------------------------------

export const USAGE = 'usage: npm run onboard -- --project <slug> [--allow-replace] [--merge-wait-minutes <n>] [--no-prompt]';

/** Reads `--project` (`--product`, its old name, still works), `--allow-replace`, `--merge-wait-minutes` and `--no-prompt`. Returns { opts } or { error }. */
export function parseOnboardArgs(argv) {
  const opts = { project: null, allowReplace: false, mergeWaitMinutes: DEFAULT_MERGE_WAIT_MINUTES, noPrompt: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    // --product is the option's old name, kept so a saved command still runs (SP-156).
    if (a === '--project' || a === '--product') opts.project = argv[++i];
    else if (a === '--allow-replace') opts.allowReplace = true;
    else if (a === '--no-prompt') opts.noPrompt = true;
    else if (a === '--merge-wait-minutes') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) return { error: `--merge-wait-minutes needs a number of minutes greater than 0 (got ${JSON.stringify(argv[i] ?? null)})` };
      opts.mergeWaitMinutes = n;
    } else return { error: `unknown argument ${JSON.stringify(a)}` };
  }
  if (!opts.project) return { error: 'name the project with --project <slug>' };
  if (slugFromName(opts.project) !== opts.project) return { error: `--project "${opts.project}" is not a slug (lower-case letters, digits and dashes)` };
  return { opts };
}

function realRun(cmd, args, { cwd, input, show, env, noPrompt } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, input, encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
    // A shown step inherits the Terminal's output, never its input under
    // --no-prompt (`input` is still piped when given).
    stdio: show ? [input != null ? 'pipe' : (noPrompt ? 'ignore' : 'inherit'), 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
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
    console.error('FAILED: start: run this from the folder of the project that runs the tracker (its settings file sets "trackerPort"), not a guest project\'s.');
    return 1;
  }
  const spiralityDir = dirname(file);
  const common = realRun('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: spiralityDir }).out;
  const homeRoot = common ? common.replace(/\/\.git$/, '') : spiralityDir;
  // --no-prompt never reads the Terminal, even when there is one.
  const tty = !parsed.opts.noPrompt && Boolean(process.stdin.isTTY);
  return onboard(parsed.opts, {
    homeConfig, homeRoot, spiralityDir,
    run: (cmd, args, o = {}) => realRun(cmd, args, { ...o, noPrompt: parsed.opts.noPrompt }),
    ask: (q) => (tty ? askOnce(q) : null),
    print: (line) => console.log(line),
    exists: (p) => existsSync(p),
    readText: (p) => { try { return readFileSync(p, 'utf8'); } catch (err) { if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EISDIR') return null; throw err; } },
    writeText: (p, t) => writeFileSync(p, t),
    appendText: (p, t) => { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, t); },
    mkdir: (d) => mkdirSync(d, { recursive: true }),
    rename: (from, to) => renameSync(from, to),
    remove: (p) => rmSync(p, { force: true }),
    removeTree: (p) => rmSync(p, { recursive: true, force: true }),
    nodeVersion: process.version,
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
