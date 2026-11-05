#!/usr/bin/env node
/**
 * Step 0 of setting up a product on Spirality: look before touching
 * anything (docs/onboarding/SETUP_REVIEW.md, part 3). Read only.
 *
 *   npm run onboard:look -- --answers <path to answers file> [--no-check]
 *   npm run onboard:look -- --product <slug> [--no-check]
 *
 * `--product <slug>` reads `<logDir>/onboard/<slug>.answers.json`, the
 * tracker home's log folder (lib/onboardAnswers.mjs). Run it from the
 * tracker home's own folder (the product whose settings file sets
 * `trackerPort`, today Spirality), on the Mini; the npm script runs it
 * under that product's Doppler project, for its hand-run tracker sign-in.
 *
 * It prints one row per thing it checked, each naming what it checked and
 * ending `ready`, `will do` (the setup does it later), `BLOCKED: <why>` or
 * `could not tell: <why>`. A check that could not run is never `ready`.
 *
 *   GitHub   the repository exists; this Mac's gh can push to it; whether
 *            GitHub will protect its main branch (`not protected` is fine,
 *            a "403 Upgrade" is BLOCKED).
 *   The Mini the checkout folder (absent, or on a clean main of the right
 *            repository); this Mac's Node against what the product needs;
 *            `claude` and `doppler` signed in.
 *   Tracker  reachable at the tracker home's trackerApiUrl; whether the
 *            project, its prefix and its `<slug> …` loop sign-ins exist;
 *            that the prefix is not another project's; the operator found
 *            by name.
 *   Doppler  whether the product's project and config exist.
 *   Check    the product's own check, run on a clean scratch clone of its
 *            main branch (pass or fail, last lines shown). `--no-check`
 *            skips it, and says so as "could not tell".
 *
 * Writes nothing anywhere: every tracker call is a GET, every gh, git,
 * doppler and claude command only reads, and the scratch clone lives in a
 * temporary folder that is removed afterwards. The product's check runs
 * there with a short list of plain environment variables, never this
 * process's Doppler keys. No token or email is ever printed.
 *
 * Exit 0 when nothing is BLOCKED and nothing is unknown, 3 when something
 * is BLOCKED, 1 when it could not tell (or the answers file is not usable).
 */
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findConfigFile, loadProjectConfig, ProjectConfigError } from '../../lib/projectConfig.mjs';
import { AnswersError, answersFile, expandHome, loadAnswers, nodeMeets, parseNodeNeed } from '../../lib/onboardAnswers.mjs';
import { compareRepo, projectEditUrl } from '../lib/repoCheck.mjs';
import { trackerTokenEnv } from '../tracker/apiTracker.mjs';
import { seatsForConfig } from '../../tracker/signins.mjs';

export const READY = 'ready';
export const WILL_DO = 'will do';
export const BLOCKED = 'blocked';
export const UNKNOWN = 'unknown';

const row = (item, verdict, why, detail = []) => ({ item, verdict, why, detail });

/** One row as printed: what was checked, then its verdict. */
export function formatRow(r) {
  const head = {
    [READY]: `ready (${r.why})`,
    [WILL_DO]: `will do (${r.why})`,
    [BLOCKED]: `BLOCKED: ${r.why}`,
    [UNKNOWN]: `could not tell: ${r.why}`,
  }[r.verdict];
  if (!head) throw new Error(`a look row has an unknown verdict "${r.verdict}"`);
  return [`${r.item}: ${head}`, ...r.detail.map((line) => `      | ${line}`)].join('\n');
}

/** 3 when anything is BLOCKED, else 1 when anything could not be told, else 0. */
export function exitCodeFor(rows) {
  if (rows.some((r) => r.verdict === BLOCKED)) return 3;
  if (rows.some((r) => r.verdict === UNKNOWN)) return 1;
  return 0;
}

/** The closing line, matching exitCodeFor. */
export function summaryLine(rows) {
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  const code = exitCodeFor(rows);
  if (code === 3) return `look: ${count(BLOCKED)} BLOCKED (above). Nothing should be set up until they are cleared.`;
  if (code === 1) return `look: nothing BLOCKED, but ${count(UNKNOWN)} could not be told (above), so this is not a clean bill.`;
  return `look: nothing is BLOCKED. ${count(WILL_DO)} item(s) the setup will do, ${count(READY)} already ready.`;
}

/** Terminal colour and cursor codes, which a test runner prints and a log should not keep. */
const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;

/** The last `n` non-empty lines of a command's output, colour codes removed. */
export function lastLines(text, n) {
  return String(text ?? '').replace(ANSI, '').split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-n);
}

/** owner/name, lower case, from any form a git remote or GitHub address takes. */
export function normalRepo(value) {
  return String(value ?? '').trim()
    .replace(/^git@github\.com:/i, '').replace(/^(?:https?|ssh):\/\/(?:[^@/]+@)?github\.com\//i, '')
    .replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
}

/** A failed `gh api` call's HTTP status and message, from its JSON body or its "(HTTP 404)" line. */
export function ghApiFailure(r) {
  let body = null;
  try { body = JSON.parse(r.stdout); } catch { body = null; }
  const fromLine = /\(HTTP (\d{3})\)/.exec(r.stderr ?? '');
  const status = Number(body?.status) || (fromLine ? Number(fromLine[1]) : null);
  const message = body?.message || lastLines(r.stderr, 1)[0] || `gh exited ${r.status}`;
  return { status, message };
}

// --- GitHub -------------------------------------------------------------

/** `gh repo view` -> the repository row, the push row, and what later checks need. */
export function readRepo(r, repo) {
  const item = `GitHub: repository ${repo}`;
  const pushItem = "GitHub: this Mac's gh can push to it";
  if (r.error) {
    const why = `could not run gh (${r.error.code || r.error.message}); is the GitHub command line installed?`;
    return { rows: [row(item, UNKNOWN, why), row(pushItem, UNKNOWN, why)], info: null };
  }
  if (r.status !== 0) {
    const said = lastLines(r.stderr, 1)[0] || `gh exited ${r.status}`;
    if (/could not resolve to a repository/i.test(said)) {
      return {
        rows: [row(item, BLOCKED, `GitHub has no such repository, or this Mac's gh cannot see it (${said})`), row(pushItem, UNKNOWN, 'no repository to push to')],
        info: null,
      };
    }
    return { rows: [row(item, UNKNOWN, said), row(pushItem, UNKNOWN, said)], info: null };
  }
  let info;
  try { info = JSON.parse(r.stdout); } catch { info = null; }
  if (!info || typeof info !== 'object') {
    const why = 'gh answered, but not with the repository\'s details';
    return { rows: [row(item, UNKNOWN, why), row(pushItem, UNKNOWN, why)], info: null };
  }
  const branch = info.defaultBranchRef?.name || null;
  const visibility = String(info.visibility || 'unknown').toLowerCase();
  const permission = String(info.viewerPermission || 'NONE').toUpperCase();
  const rows = [row(item, READY, `exists, ${visibility}, main branch ${branch ?? '(none: the repository is empty)'}`)];
  rows.push(['ADMIN', 'MAINTAIN', 'WRITE'].includes(permission)
    ? row(pushItem, READY, `its permission is ${permission.toLowerCase()}`)
    : row(pushItem, BLOCKED, `its permission is ${permission.toLowerCase()}; pushing needs write, and protecting main needs admin`));
  return { rows, info: { branch, visibility, permission } };
}

/** `gh api repos/<repo>/branches/<branch>/protection` -> the protection row. */
export function readProtection(r, branch) {
  const item = `GitHub: protecting ${branch}`;
  if (r.error) return row(item, UNKNOWN, `could not run gh (${r.error.code || r.error.message})`);
  if (r.status === 0) {
    let body;
    try { body = JSON.parse(r.stdout); } catch { body = null; }
    if (!body) return row(item, UNKNOWN, 'GitHub answered, but not with the protection settings');
    const checks = [
      ...(body.required_status_checks?.contexts ?? []),
      ...(body.required_status_checks?.checks ?? []).map((c) => c.context),
    ];
    const named = [...new Set(checks)];
    return named.includes('verify')
      ? row(item, READY, `already protected; required checks: ${named.join(', ')}`)
      : row(item, WILL_DO, `protected, but "verify" is not a required check${named.length ? ` (it requires ${named.join(', ')})` : ''}; the setup makes it one once verify passes on ${branch}`);
  }
  const { status, message } = ghApiFailure(r);
  if (status === 404 && /not protected/i.test(message)) {
    return row(item, WILL_DO, `not protected yet, which is fine; the setup protects it once verify passes on ${branch}`);
  }
  if (status === 404 && /branch not found/i.test(message)) return row(item, BLOCKED, `GitHub has no branch ${branch}`);
  if (status === 403 && /upgrade/i.test(message)) {
    return row(item, BLOCKED, `GitHub will not protect ${branch} on this repository's plan ("${message}"). Upgrading is a billing screen; making the repository public is a decision`);
  }
  return row(item, UNKNOWN, `GitHub answered ${status ?? 'with an error'}: ${message}`);
}

// --- The Mini -------------------------------------------------------------

/** The checkout folder: absent (will do), or a clean `branch` of `repo`. */
export function readCheckout({ dir, present, head, origin, porcelain }, { repo, branch }) {
  const item = `Mini: checkout ${dir}`;
  if (!present) return row(item, WILL_DO, 'absent; the setup clones it');
  if (head.error || origin.error || porcelain.error) return row(item, UNKNOWN, `could not run git (${(head.error || origin.error || porcelain.error).code})`);
  if (head.status !== 0) return row(item, BLOCKED, 'the folder is there but is not a git checkout; move it aside or name another folder in checkoutDir');
  if (origin.status !== 0) return row(item, BLOCKED, 'the checkout has no "origin" remote, so it is not known to be this repository');
  const remote = origin.stdout.trim();
  if (normalRepo(remote) !== normalRepo(repo)) return row(item, BLOCKED, `it is a checkout of ${remote}, not ${repo}`);
  if (porcelain.status !== 0) return row(item, UNKNOWN, lastLines(porcelain.stderr, 1)[0] || `git status exited ${porcelain.status}`);
  const onBranch = head.stdout.trim();
  if (branch && onBranch !== branch) return row(item, BLOCKED, `it is on branch ${onBranch}, not ${branch}`);
  const changes = lastLines(porcelain.stdout, Infinity).length;
  if (changes) return row(item, BLOCKED, `it has ${changes} uncommitted change(s); a loop's checkout must be a clean ${onBranch}`);
  return row(item, READY, `a clean ${onBranch} of ${repo}`);
}

/**
 * What the product says it needs of Node: the answers' nodeVersion, else
 * its `.nvmrc`, else its package.json's `engines.node`, read from `root`
 * (the scratch clone, or the checkout). `{ need, source }`, need null when
 * none is written or it cannot be read.
 */
export function nodeNeedOf(answers, readText, root) {
  if (answers.nodeVersion) return { need: parseNodeNeed(answers.nodeVersion), source: 'the answers file', text: answers.nodeVersion };
  if (!root) return { need: null, source: null, text: null };
  const nvmrc = readText(join(root, '.nvmrc'));
  if (nvmrc != null && nvmrc.trim()) return { need: parseNodeNeed(nvmrc.trim()), source: 'its .nvmrc', text: nvmrc.trim() };
  const pkg = readText(join(root, 'package.json'));
  if (pkg != null) {
    let engines = null;
    try { engines = JSON.parse(pkg)?.engines?.node ?? null; } catch { engines = null; }
    if (typeof engines === 'string' && engines.trim()) return { need: parseNodeNeed(engines), source: 'its package.json engines.node', text: engines.trim() };
  }
  return { need: null, source: null, text: null };
}

export function readNode(version, found, { looked }) {
  const item = "Mini: Node";
  if (!found.text) {
    return row(item, UNKNOWN, looked
      ? `the product names no Node version (no .nvmrc, no engines.node); write one in the answers' "nodeVersion" (this Mac runs ${version})`
      : `nothing to read the product's Node version from (no checkout, no clone); write one in the answers' "nodeVersion" (this Mac runs ${version})`);
  }
  if (!found.need) return row(item, UNKNOWN, `${found.source} says "${found.text}", which this cannot read as a version`);
  return nodeMeets(version, found.need)
    ? row(item, READY, `this Mac runs ${version}; the product needs ${found.text}, from ${found.source}`)
    : row(item, BLOCKED, `this Mac runs ${version}, but the product needs ${found.text}, from ${found.source}`);
}

/** `claude auth status` -> signed in or not. Never prints the account's email. */
export function readClaude(r) {
  const item = 'Mini: claude signed in';
  if (r.error) return row(item, UNKNOWN, `could not run claude (${r.error.code || r.error.message})`);
  let s;
  try { s = JSON.parse(r.stdout); } catch { s = null; }
  if (!s || typeof s.loggedIn !== 'boolean') return row(item, UNKNOWN, `claude auth status answered ${r.status}, not with a sign-in state`);
  return s.loggedIn
    ? row(item, READY, `signed in${s.authMethod ? `, by ${s.authMethod}` : ''}`)
    : row(item, BLOCKED, 'not signed in: `claude auth login` on the Mini (a browser login)');
}

/** `doppler me --json` -> signed in or not. Prints only the workplace name. */
export function readDopplerMe(r) {
  const item = 'Mini: doppler signed in';
  if (r.error) return row(item, UNKNOWN, `could not run doppler (${r.error.code || r.error.message})`);
  let me;
  try { me = JSON.parse(r.stdout); } catch { me = null; }
  if (r.status === 0 && me && typeof me === 'object' && !me.error) {
    return row(item, READY, `signed in${me.workplace?.name ? ` to ${me.workplace.name}` : ''}`);
  }
  const said = (me && me.error) || lastLines(r.stderr, 1)[0] || `doppler exited ${r.status}`;
  return /log ?in|unauthori[sz]ed|invalid token/i.test(said)
    ? row(item, BLOCKED, `not signed in: \`doppler login\` on the Mini (a browser login) (${said})`)
    : row(item, UNKNOWN, said);
}

// --- Doppler -------------------------------------------------------------

export function readDoppler(projectsRun, configsRun, { project, config }) {
  const pItem = `Doppler: project ${project}`;
  const cItem = `Doppler: config ${project}/${config}`;
  const fail = (r) => (r.error ? `could not run doppler (${r.error.code || r.error.message})` : lastLines(r.stderr, 1)[0] || `doppler exited ${r.status}`);
  const parse = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
  const ran = !projectsRun.error && projectsRun.status === 0;
  const projects = ran ? parse(projectsRun) : null;
  if (!Array.isArray(projects)) {
    const why = ran ? 'doppler answered, but not with a list of projects' : fail(projectsRun);
    return [row(pItem, UNKNOWN, why), row(cItem, UNKNOWN, why)];
  }
  if (!projects.some((p) => p.slug === project || p.name === project)) {
    return [row(pItem, WILL_DO, 'absent; made at the setup\'s secret-store step'), row(cItem, WILL_DO, 'made with its project')];
  }
  const configs = !configsRun || configsRun.error || configsRun.status !== 0 ? null : parse(configsRun);
  if (!Array.isArray(configs)) {
    return [row(pItem, READY, 'exists'), row(cItem, UNKNOWN, configsRun ? fail(configsRun) : 'its configs were not read')];
  }
  return [
    row(pItem, READY, 'exists'),
    configs.some((c) => c.name === config) ? row(cItem, READY, 'exists') : row(cItem, WILL_DO, `absent (it has ${configs.map((c) => c.name).join(', ') || 'none'}); made at the setup's secret-store step`),
  ];
}

// --- Tracker -------------------------------------------------------------

/**
 * The tracker rows, from four GETs (`/me`, `/projects`, `/search`,
 * `/people`). `get(path)` answers `{ status, json }` or throws when the
 * tracker does not answer. `seatNames` are the product's loop sign-ins.
 */
export async function trackerRows({ get, apiUrl, pageUrl, answers, operatorName, seatNames, hasToken }) {
  const reach = `Tracker: reachable at ${apiUrl}`;
  const projectItem = `Tracker: project ${answers.productSlug}`;
  const prefixItem = `Tracker: prefix ${answers.trackerPrefix} not another project's`;
  const seatsItem = `Tracker: loop sign-ins (${seatNames.join(', ')})`;
  const operatorItem = `Tracker: the operator ${operatorName}`;
  const rest = (why) => [projectItem, prefixItem, seatsItem, operatorItem].map((i) => row(i, UNKNOWN, why));
  if (!hasToken) {
    const why = 'no tracker sign-in in this environment; run it as `npm run onboard:look`, which runs it under Doppler';
    return [row(reach, UNKNOWN, why), ...rest(why)];
  }
  const ask = async (path) => {
    try { return await get(path); } catch (err) { return { down: err.message || String(err) }; }
  };
  const me = await ask('/me');
  if (me.down) return [row(reach, BLOCKED, `it did not answer (${me.down})`), ...rest('the tracker did not answer')];
  if (me.status !== 200) {
    const why = `it answered ${me.status}${me.json?.message ? `: ${me.json.message}` : ''}`;
    return [row(reach, UNKNOWN, why), ...rest('the tracker refused this sign-in')];
  }
  const rows = [row(reach, READY, `signed in as "${me.json?.name}"`)];
  const failed = (r) => (r.down ? `it did not answer (${r.down})` : `it answered ${r.status}`);

  const projects = await ask('/projects');
  const list = !projects.down && projects.status === 200 && Array.isArray(projects.json?.projects) ? projects.json.projects : null;
  if (!list) {
    rows.push(row(projectItem, UNKNOWN, failed(projects)), row(prefixItem, UNKNOWN, failed(projects)));
  } else {
    const ours = list.find((p) => p.slug === answers.productSlug);
    if (!ours) rows.push(row(projectItem, WILL_DO, 'absent; made at the setup\'s sign-ins step'));
    else if (String(ours.prefix).toUpperCase() !== answers.trackerPrefix) {
      rows.push(row(projectItem, BLOCKED, `it exists with prefix ${ours.prefix}, but the answers say ${answers.trackerPrefix}`));
    } else {
      const repo = compareRepo({ configRepo: answers.githubRepo, trackerRepo: ours.repo, slug: ours.slug, editUrl: projectEditUrl(pageUrl, ours.slug) });
      if (repo.verdict === 'different') rows.push(row(projectItem, BLOCKED, `it records the GitHub repository ${ours.repo}, but the answers say ${answers.githubRepo}; only a person decides which is wrong`));
      else rows.push(row(projectItem, READY, `already made, prefix ${ours.prefix}${repo.verdict === 'empty' ? ', its GitHub repository field still empty (the sign-ins step fills it)' : `, repository ${ours.repo}`}`));
    }
    const taken = list.find((p) => p.slug !== answers.productSlug && String(p.prefix).toUpperCase() === answers.trackerPrefix);
    rows.push(taken
      ? row(prefixItem, BLOCKED, `${taken.prefix} is ${taken.name}'s (${taken.slug}); choose another trackerPrefix`)
      : row(prefixItem, READY, `the prefixes taken are ${list.filter((p) => p.slug !== answers.productSlug).map((p) => p.prefix).join(', ') || 'none'}`));
  }

  const search = await ask('/search');
  const options = !search.down && search.status === 200
    ? search.json?.filters?.find((f) => f.key === 'createdBy')?.options
    : null;
  if (!Array.isArray(options)) {
    rows.push(row(seatsItem, UNKNOWN, search.down || search.status !== 200 ? failed(search) : 'the tracker answered, but not with its list of actors'));
  } else {
    const names = new Set(options.map((o) => o.label));
    const have = seatNames.filter((n) => names.has(n));
    if (have.length === seatNames.length) rows.push(row(seatsItem, READY, 'every one exists'));
    else if (!have.length) rows.push(row(seatsItem, WILL_DO, 'none exists yet; made at the setup\'s sign-ins step'));
    else rows.push(row(seatsItem, WILL_DO, `${have.length} of ${seatNames.length} exist (${have.join(', ')}); the sign-ins step makes the rest`));
  }

  const people = await ask('/people');
  const persons = !people.down && people.status === 200 && Array.isArray(people.json?.people) ? people.json.people : null;
  if (!persons) rows.push(row(operatorItem, UNKNOWN, failed(people)));
  else {
    const op = persons.filter((p) => p.name === operatorName);
    if (op.length === 1) rows.push(row(operatorItem, READY, `actor ${op[0].id}`));
    else if (!op.length) rows.push(row(operatorItem, BLOCKED, `the tracker has no person named "${operatorName}" to hand tickets to`));
    else rows.push(row(operatorItem, BLOCKED, `the tracker has ${op.length} people named "${operatorName}" (actors ${op.map((p) => p.id).join(', ')}); the setup cannot tell which is the operator`));
  }
  return rows;
}

// --- The product's own check ---------------------------------------------

/** The plain environment the product's check runs with: never this process's Doppler keys. */
export const CHECK_ENV_KEYS = Object.freeze(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM']);

export function checkEnv(env) {
  const out = { CI: 'true' };
  for (const key of CHECK_ENV_KEYS) if (env[key] != null) out[key] = env[key];
  return out;
}

/** The check row, from the install and check runs (either may be null: not run). */
export function readCheck({ command, branch, clone, install, check }) {
  const item = `Check: \`${command}\` on a clean copy of ${branch}`;
  const timedOut = (r) => r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
  const tail = (r) => lastLines(`${r.stdout ?? ''}\n${r.stderr ?? ''}`, 15);
  if (clone.error || clone.status !== 0) {
    return row(item, UNKNOWN, `the scratch clone failed (${clone.error ? clone.error.code || clone.error.message : lastLines(clone.stderr, 1)[0] || `exit ${clone.status}`})`);
  }
  if (install) {
    if (timedOut(install)) return row(item, UNKNOWN, `installing its packages timed out (${install.label})`);
    if (install.error) return row(item, UNKNOWN, `could not run ${install.label} (${install.error.code || install.error.message})`);
    if (install.status !== 0) return row(item, BLOCKED, `\`${install.label}\` fails on a clean copy (exit ${install.status}), so the check cannot even start`, tail(install));
  }
  if (timedOut(check)) return row(item, UNKNOWN, 'the check timed out');
  if (check.error) return row(item, UNKNOWN, `could not run it (${check.error.code || check.error.message})`);
  if (check.status !== 0) return row(item, BLOCKED, `it fails on a clean copy (exit ${check.status}); CI must pass before the setup opens its pull request`, tail(check));
  return row(item, READY, 'it passes', lastLines(`${check.stdout ?? ''}\n${check.stderr ?? ''}`, 3));
}

// --- The whole look --------------------------------------------------------

/**
 * Every row, in the order they print. Everything outside this process is
 * reached through `deps`, so tests can see each call:
 *
 *   run(cmd, args, { cwd, env, timeoutMs }) -> { status, stdout, stderr, error, signal }
 *   fetch(url, init)                         the global fetch's shape
 *   token                                    the tracker sign-in, or null
 *   exists(path), readText(path)             reads (readText: null when absent)
 *   makeScratch() -> dir, removeScratch(dir) the temporary folder for the clone
 *   nodeVersion                              this Mac's Node ("v22.23.3")
 *   env                                      this process's environment
 *   progress(line)                           what it is doing, while it waits
 */
export async function look({ answers, homeConfig, runCheck = true, deps }) {
  const { run, exists, readText, progress = () => {} } = deps;
  const repo = answers.githubRepo;
  const rows = [];

  // GitHub.
  const repoView = readRepo(run('gh', ['repo', 'view', repo, '--json', 'name,visibility,viewerPermission,defaultBranchRef']), repo);
  rows.push(...repoView.rows);
  const branch = repoView.info?.branch ?? null;
  if (!repoView.info) rows.push(row('GitHub: protecting the main branch', UNKNOWN, 'the repository could not be read'));
  else if (!branch) rows.push(row('GitHub: protecting the main branch', BLOCKED, 'the repository has no branch at all yet'));
  else if (repoView.info.permission !== 'ADMIN') rows.push(row(`GitHub: protecting ${branch}`, BLOCKED, 'protecting a branch needs an admin of the repository, and this Mac\'s gh is not one'));
  else rows.push(readProtection(run('gh', ['api', `repos/${repo}/branches/${branch}/protection`]), branch));

  // The scratch clone, made now so the Node row can read the product's own files.
  let scratch = null;
  let cloneRoot = null;
  let checkRow = null;
  try {
    if (!runCheck) {
      checkRow = row(`Check: \`${answers.checkCommand}\` on a clean copy of ${branch ?? 'main'}`, UNKNOWN, 'skipped (--no-check)');
    } else if (!branch) {
      checkRow = row(`Check: \`${answers.checkCommand}\` on a clean copy of main`, UNKNOWN, 'there is no main branch to copy');
    } else {
      scratch = deps.makeScratch();
      cloneRoot = join(scratch, 'repo');
      progress(`cloning ${repo} (${branch}) into a scratch folder...`);
      const clone = run('gh', ['repo', 'clone', repo, cloneRoot, '--', '--depth', '1', '--branch', branch, '--quiet'], { timeoutMs: 10 * 60 * 1000 });
      if (clone.error || clone.status !== 0) {
        checkRow = readCheck({ command: answers.checkCommand, branch, clone });
        cloneRoot = null;
      } else {
        const env = checkEnv(deps.env ?? {});
        let install = null;
        if (exists(join(cloneRoot, 'package.json'))) {
          const ci = exists(join(cloneRoot, 'package-lock.json'));
          const args = ci ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
          progress(`installing its packages (npm ${args[0]}); this can take minutes...`);
          install = { ...run('npm', args, { cwd: cloneRoot, env, timeoutMs: 20 * 60 * 1000 }), label: `npm ${args[0]}` };
        }
        if (install && (install.error || install.status !== 0)) {
          checkRow = readCheck({ command: answers.checkCommand, branch, clone, install });
        } else {
          progress(`running \`${answers.checkCommand}\`; this can take minutes...`);
          const check = run('sh', ['-c', answers.checkCommand], { cwd: cloneRoot, env, timeoutMs: 30 * 60 * 1000 });
          checkRow = readCheck({ command: answers.checkCommand, branch, clone, install, check });
        }
      }
    }

    // The Mini.
    const dir = expandHome(answers.checkoutDir, deps.home ?? homedir());
    const present = exists(dir);
    const git = (...args) => run('git', ['--no-optional-locks', '-C', dir, ...args]);
    rows.push(readCheckout(present
      ? { dir, present, head: git('rev-parse', '--abbrev-ref', 'HEAD'), origin: git('remote', 'get-url', 'origin'), porcelain: git('status', '--porcelain') }
      : { dir, present }, { repo, branch }));
    const root = cloneRoot ?? (present ? dir : null);
    rows.push(readNode(deps.nodeVersion, nodeNeedOf(answers, readText, root), { looked: root != null }));
    rows.push(readClaude(run('claude', ['auth', 'status', '--json'])));
    rows.push(readDopplerMe(run('doppler', ['me', '--json', '--no-check-version'])));

    // The tracker.
    const apiUrl = homeConfig.trackerApiUrl;
    const get = async (path) => {
      const res = await deps.fetch(`${apiUrl}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${deps.token}`, Connection: 'close' },
        signal: AbortSignal.timeout(30 * 1000),
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: res.status, json };
    };
    const seatNames = seatsForConfig({ trackerPort: null, productSlug: answers.productSlug, operatorName: homeConfig.operatorName }).seats.map((s) => s.name);
    rows.push(...await trackerRows({
      get, apiUrl, pageUrl: homeConfig.trackerUrl, answers, operatorName: homeConfig.operatorName, seatNames, hasToken: Boolean(deps.token),
    }));

    // Doppler.
    const projectsRun = run('doppler', ['projects', '--json', '--no-check-version']);
    let projectList = null;
    try { projectList = projectsRun.status === 0 ? JSON.parse(projectsRun.stdout) : null; } catch { projectList = null; }
    const known = Array.isArray(projectList) && projectList.some((p) => p.slug === answers.dopplerProject || p.name === answers.dopplerProject);
    const configsRun = known ? run('doppler', ['configs', '--project', answers.dopplerProject, '--json', '--no-check-version']) : null;
    rows.push(...readDoppler(projectsRun, configsRun, { project: answers.dopplerProject, config: answers.dopplerConfig }));
  } finally {
    if (scratch) deps.removeScratch(scratch);
  }

  rows.push(checkRow);
  return rows;
}

// --- The command -----------------------------------------------------------

function realRun(cmd, args, { cwd, env, timeoutMs } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, env: env ?? process.env, encoding: 'utf8', timeout: timeoutMs ?? 2 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ?? null, signal: r.signal ?? null };
}

/**
 * The tracker home's main checkout, which the default checkout folder sits
 * beside: from a git worktree (`.claude/worktrees/<topic>`), the folder
 * that holds the shared `.git`, never the worktree itself. Not a git
 * checkout at all: the folder as given.
 */
export function mainCheckoutOf(dir, run = realRun) {
  const r = run('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  const common = r.status === 0 ? r.stdout.trim() : '';
  return /\/\.git$/.test(common) ? dirname(common) : dir;
}

const USAGE = 'usage: npm run onboard:look -- (--answers <path> | --product <slug>) [--no-check]';

async function main(argv) {
  let args;
  try {
    args = parseArgs({ args: argv, options: { answers: { type: 'string' }, product: { type: 'string' }, 'no-check': { type: 'boolean' } } }).values;
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return 1;
  }
  let homeConfig;
  let homeRoot;
  try {
    const file = findConfigFile();
    homeConfig = loadProjectConfig({ file: file ?? undefined });
    homeRoot = mainCheckoutOf(dirname(file));
  } catch (err) {
    if (!(err instanceof ProjectConfigError)) throw err;
    console.error(`look: the tracker home's settings file is not usable — ${err.message}`);
    return 1;
  }
  if (homeConfig.trackerPort == null) {
    console.error('look: run this from the folder of the product that runs the tracker (its settings file sets "trackerPort"), not a guest product\'s.');
    return 1;
  }
  if (Boolean(args.answers) === Boolean(args.product)) {
    console.error(`look: name the answers file with --answers, or the product with --product, not both and not neither.\n${USAGE}`);
    return 1;
  }
  const path = args.answers ? expandHome(args.answers) : answersFile(homeConfig, args.product);
  let answers;
  try {
    answers = loadAnswers(path, { homeConfig, homeRoot });
  } catch (err) {
    if (!(err instanceof AnswersError)) throw err;
    console.error(`look: the answers file is not usable — ${err.message}`);
    return 1;
  }
  let token = null;
  try { token = process.env[trackerTokenEnv(process.env)] || null; } catch { token = null; }

  console.log(`Setting up ${answers.productName} (${answers.githubRepo}): the read-only look. Nothing is written.\n`);
  const rows = await look({
    answers,
    homeConfig,
    runCheck: !args['no-check'],
    deps: {
      run: realRun,
      fetch: globalThis.fetch,
      token,
      exists: existsSync,
      readText: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
      makeScratch: () => mkdtempSync(join(tmpdir(), `onboard-${answers.productSlug}-`)),
      removeScratch: (dir) => rmSync(dir, { recursive: true, force: true }),
      nodeVersion: process.version,
      env: process.env,
      progress: (line) => console.error(`  ... ${line}`),
    },
  });
  for (const r of rows) console.log(formatRow(r));
  console.log(`\n${summaryLine(rows)}`);
  return exitCodeFor(rows);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`look: stopped on an unexpected error — ${err.stack || err.message}`);
    process.exit(1);
  });
}
