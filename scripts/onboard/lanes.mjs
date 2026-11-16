#!/usr/bin/env node
/**
 * The setup wizard's lanes step (SP-111): a new project's lanes run BEFORE
 * its setup pull request merges, so its own relay merges that pull request on
 * Dane's merge phrase like any other ticket, and nothing sits overnight
 * waiting for a relay that is not installed yet (SETUP_REVIEW.md hold-ups 5,
 * 6 and 12).
 *
 *   npm run onboard:lanes -- --checkout <dir> --branch <name> --pr <url> \
 *     [--asked-file <file>] [--wait-minutes <n>] [--dry-run]
 *
 * Run on the Mini, from Spirality's folder, in a session that is not one of
 * the project's lanes. In order, each step skipped when already done, so a
 * rerun picks up where a failed one stopped:
 *
 *   1. checkout  the project's MAIN checkout (never a worktree: the runners
 *                refuse one) moves to the setup branch, clean and up to date.
 *   2. ticket    one ticket in the project's own tracker project, named as
 *                the pull request is (one already filed under that name is
 *                reused, never a second); the PR body gets its `Ticket:` line;
 *                `pr-opened` records the PR; the ticket goes to In review.
 *                All before any lane exists, so no lane sees it half-filed.
 *   3. install   Spirality's own scripts/install_loop_runner.sh, with
 *                --project <checkout> (SP-271): the project's lanes run
 *                Spirality's runner from Spirality's folder, working in the
 *                project's checkout. The project holds no installer (SP-273).
 *                A project whose own copy of the lanes is still installed is
 *                refused by the installer (switching it over is Dane's step,
 *                --take-over), and this step fails saying so.
 *   4. lanes     `--status` shows every lane loaded, and each lane's first
 *                pass did its lane's work rather than stand down
 *                (lib/onboardLanes.mjs, hold-up 14). On a rerun with every
 *                lane already loaded, each lane's newest pass is judged.
 *
 * The branch and pull request come from SP-110's copy step; SP-112's wizard
 * passes them in. When the pull request merges, the runners put the checkout
 * back on main (scripts/lib/back_to_main.sh).
 *
 * Every project value comes from the project's settings file on the setup
 * branch (rule 2). Every write is read back (rule 5). A failed step prints
 * `FAILED: <step>: <what was seen>` and the rerun command, and nothing after
 * it runs (rule 6). Doppler supplies the token and none is ever printed
 * (rule 4).
 *
 * Ticket writes go through Spirality's door, run from Spirality's folder
 * with SPIRALITY_PROJECT naming the checkout (SP-270), so it reads the
 * project's settings file and Doppler project: the project has no door of
 * its own (SP-273).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadProjectConfig, CONFIG_FILE } from '../../lib/projectConfig.mjs';
import { expandHome } from '../../lib/onboardAnswers.mjs';
import { LANES, spiralityInstallerPath, installerCommand, parseStatus, readPasses, judgeFirstPass, rerunSince, ticketsNamed, waitMinutesFrom, setupTicketBody, withLine } from '../../lib/onboardLanes.mjs';

const require = createRequire(import.meta.url);
const { findTicketId, ticketLine } = require('../../lib/clickupTicketLink.js');

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (name) => argv.includes(`--${name}`);

const checkoutArg = arg('checkout'), branch = arg('branch'), prArg = arg('pr');
if (!checkoutArg || !branch || !prArg) {
  console.error('usage: npm run onboard:lanes -- --checkout <dir> --branch <name> --pr <url> [--asked-file <file>] [--wait-minutes <n>] [--dry-run]');
  process.exit(2);
}
const dryRun = flag('dry-run');
const waitArg = arg('wait-minutes');
const waitMinutes = flag('wait-minutes') && (waitArg === undefined || waitArg.startsWith('--')) ? null : waitMinutesFrom(waitArg);
if (waitMinutes === null) {
  console.error(`--wait-minutes needs a number of minutes greater than 0 (got ${waitArg === undefined || waitArg.startsWith('--') ? 'no value' : `"${waitArg}"`})`);
  process.exit(2);
}
const checkout = resolve(expandHome(checkoutArg));
const rerun = `npm run onboard:lanes -- ${argv.join(' ')}`;

function fail(step, seen) {
  console.error(`\nFAILED: ${step}: ${seen}`);
  console.error(`Nothing after this step ran. Fix it, then rerun:\n  ${rerun}`);
  process.exit(1);
}
const say = (step, line) => console.log(`${step.padEnd(8)} ${line}`);

function run(cmd, args, { cwd = checkout, input, env } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', input, env });
  return { ok: r.status === 0, code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || r.error || '').trim() };
}
const git = (...args) => run('git', args);
// Spirality's folder: this script's, two up. Its installer and door act for the project.
const SPIRALITY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Spirality's door, for the checkout: its config, its Doppler project, its hand-run seat (SP-270).
const door = (...args) => run('npm', ['run', '--silent', 'clickup', '--', ...args], { cwd: SPIRALITY, env: { ...process.env, SPIRALITY_PROJECT: checkout } });
const last = (text, n = 6) => String(text || '').split('\n').filter(Boolean).slice(-n).join(' | ');

const pr = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)\/?$/.exec(prArg.trim());
if (!pr) fail('start', `--pr "${prArg}" is not a GitHub pull-request URL`);
const [, prRepo, prNumber] = pr;
const prUrl = `https://github.com/${prRepo}/pull/${prNumber}`;
if (dryRun) console.log('Dry run: every check runs and nothing is changed (git fetch only refreshes what this checkout knows of origin).\n');

// ── 1. checkout ────────────────────────────────────────────────────────────
if (!existsSync(checkout)) fail('checkout', `${checkout} does not exist (clone the project there first)`);
const top = git('rev-parse', '--show-toplevel');
if (!top.ok) fail('checkout', `${checkout} is not a git checkout: ${top.err}`);
if (realpathSync(top.out) !== realpathSync(checkout)) fail('checkout', `${checkout} is inside the checkout at ${top.out}, not the top of one`);
if (!statSync(join(checkout, '.git')).isDirectory()) fail('checkout', `${checkout} is a worktree; the lanes must run from the main checkout (the runners refuse a worktree)`);
const dirty = git('status', '--porcelain');
if (dirty.out) fail('checkout', `${checkout} has uncommitted changes: ${last(dirty.out, 4)}`);
const fetched = git('fetch', '-q', 'origin');
if (!fetched.ok) fail('checkout', `git fetch origin failed: ${last(fetched.err)}`);
const remote = git('rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`);
if (!remote.ok) fail('checkout', `origin has no branch ${branch}`);
let onBranch = git('rev-parse', '--abbrev-ref', 'HEAD').out;
if (onBranch === branch && git('rev-parse', 'HEAD').out === remote.out) {
  say('checkout', `already on ${branch}, at origin's ${remote.out.slice(0, 7)}`);
} else if (dryRun) {
  say('checkout', onBranch === branch
    ? `would fast-forward ${checkout}'s ${branch} to origin's ${remote.out.slice(0, 7)}`
    : `would move ${checkout} from ${onBranch} to ${branch} (origin's ${remote.out.slice(0, 7)})`);
} else {
  const co = onBranch === branch ? git('merge', '-q', '--ff-only', `origin/${branch}`) : git('checkout', '-q', branch);
  if (!co.ok) fail('checkout', `could not move to ${branch}: ${last(co.err)}`);
  if (onBranch !== branch) {
    const ff = git('merge', '-q', '--ff-only', `origin/${branch}`);
    if (!ff.ok) fail('checkout', `${branch} here cannot fast-forward to origin's: ${last(ff.err)}`);
  }
  onBranch = git('rev-parse', '--abbrev-ref', 'HEAD').out;
  const head = git('rev-parse', 'HEAD').out;
  if (onBranch !== branch || head !== remote.out) fail('checkout', `read back ${onBranch} at ${head.slice(0, 7)}, wanted ${branch} at ${remote.out.slice(0, 7)}`);
  say('checkout', `on ${branch} at ${head.slice(0, 7)}, read back`);
}

// The settings file is read from the setup branch: in a dry run, through git, so nothing moves.
let config;
try {
  const file = join(checkout, CONFIG_FILE);
  if (dryRun && onBranch !== branch) {
    const shown = git('show', `origin/${branch}:${CONFIG_FILE}`);
    if (!shown.ok) throw new Error(`${branch} has no ${CONFIG_FILE}`);
    const scratch = mkdtempSync(join(tmpdir(), 'onboard-lanes-'));
    writeFileSync(join(scratch, CONFIG_FILE), shown.out);
    try { config = loadProjectConfig({ file: join(scratch, CONFIG_FILE), env: {} }); } finally { rmSync(scratch, { recursive: true, force: true }); }
  } else {
    config = loadProjectConfig({ file, env: {} });
  }
} catch (e) { fail('checkout', `the settings file on ${branch} does not read: ${e.message}`); }
if (config.githubRepo.toLowerCase() !== prRepo.toLowerCase()) fail('checkout', `the settings file names ${config.githubRepo}, the pull request is in ${prRepo}`);
const linkOpts = { tracker: config.tracker, trackerPrefix: config.trackerPrefix, trackerUrl: config.trackerUrl };

// ── 2. ticket ──────────────────────────────────────────────────────────────
const view = () => {
  const v = run('gh', ['pr', 'view', prNumber, '--repo', prRepo, '--json', 'title,body,headRefName,state']);
  if (!v.ok) fail('ticket', `could not read PR #${prNumber} in ${prRepo}: ${last(v.err)}`);
  return JSON.parse(v.out);
};
const prNow = view();
if (prNow.state !== 'OPEN') fail('ticket', `PR #${prNumber} is ${prNow.state}, not open`);
if (prNow.headRefName !== branch) fail('ticket', `PR #${prNumber} is from ${prNow.headRefName}, not ${branch}`);

let ticket = findTicketId(prNow.body, linkOpts);
// A rerun after the Ticket: line failed to reach the PR: the ticket is
// already filed, under the PR's exact name. Find it rather than file a second.
let existing = [];
if (!ticket && dryRun && onBranch !== branch) {
  // The checkout is still on the project's own main, which has no settings file for the door to read yet.
  say('ticket', `would look in ${config.projectSlug}'s project for a ticket already named "${prNow.title}" (the settings file is on ${branch}, not checked out in a dry run)`);
} else if (!ticket) {
  const listed = door('queue');
  if (!listed.ok) fail('ticket', `could not list ${config.projectSlug}'s tickets to look for one already filed: ${last(listed.err || listed.out)}`);
  existing = ticketsNamed(listed.out, prNow.title);
  if (existing.length > 1) fail('ticket', `${config.projectSlug}'s project already has ${existing.length} tickets named "${prNow.title}" (${existing.join(', ')}); close the extra ones, then rerun`);
}
if (ticket) {
  say('ticket', `${ticket} is already linked from PR #${prNumber}`);
} else if (dryRun) {
  say('ticket', existing.length
    ? `would add ${existing[0]}'s Ticket: line to PR #${prNumber} (already filed as "${prNow.title}")`
    : `would file "${prNow.title}" in ${config.projectSlug}'s project and add its Ticket: line to PR #${prNumber}`);
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'onboard-lanes-'));
  try {
    if (existing.length) {
      ticket = existing[0];
      say('ticket', `${ticket} is already filed as "${prNow.title}"; not filing a second`);
    } else {
      const askedFile = arg('asked-file') ? expandHome(arg('asked-file')) : null;
      if (askedFile && !existsSync(askedFile)) fail('ticket', `--asked-file ${askedFile} does not exist`);
      const asked = askedFile ? readFileSync(askedFile, 'utf8') : '';
      writeFileSync(join(scratch, 'body.md'), setupTicketBody({ projectSlug: config.projectSlug, githubRepo: config.githubRepo, prUrl, branch, asked, spiralityDir: SPIRALITY, checkout }));
      // Filed straight into In review: no lane is installed yet (that is the
      // next step), so nothing can take it half-filed, and it is never moved
      // again by this script. A rerun finds it in whatever status a lane has
      // since put it: Dane's Ready to launch, or Rework with a send-back.
      const made = door('task', '--name', prNow.title, '--body-file', join(scratch, 'body.md'), '--status', 'In review', '--id-out', join(scratch, 'id'));
      if (!made.ok || !existsSync(join(scratch, 'id'))) fail('ticket', `filing the setup ticket failed: ${last(made.err || made.out)}`);
      ticket = readFileSync(join(scratch, 'id'), 'utf8').trim();
      say('ticket', `filed ${ticket}, "${prNow.title}", in In review, read back`);
    }
    writeFileSync(join(scratch, 'pr-body.md'), withLine(prNow.body, ticketLine(ticket, linkOpts)));
    const edited = run('gh', ['pr', 'edit', prNumber, '--repo', prRepo, '--body-file', join(scratch, 'pr-body.md')]);
    if (!edited.ok) fail('ticket', `${ticket} is filed, but adding its Ticket: line to PR #${prNumber} failed: ${last(edited.err)}`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  if (findTicketId(view().body, linkOpts).toLowerCase() !== ticket.toLowerCase()) fail('ticket', `PR #${prNumber}'s body does not read back a link to ${ticket}`);
  say('ticket', `PR #${prNumber}'s body links ${ticket}, read back`);
}

if (!dryRun) {
  const recorded = door('pr-opened', '--task', ticket, '--pr', prUrl, '--if-missing');
  if (!recorded.ok) fail('ticket', `pr-opened on ${ticket}: ${last(recorded.err || recorded.out)}`);
  say('ticket', `${ticket} records PR #${prNumber} (pr-opened read it back)`);
  const got = door('get', '--task', ticket);
  if (!got.ok) fail('ticket', `could not read ${ticket} back: ${last(got.err)}`);
  const status = ((/^status:\s+(.+)$/m.exec(got.out) || [])[1] || '').trim();
  // Never moved here: a lane may already have reviewed it, and Ready to launch is Dane's.
  say('ticket', status.toLowerCase() === 'in review'
    ? `${ticket} is In review`
    : `${ticket} is in "${status}", where a lane has put it since; left there`);
}

// ── 3. install ─────────────────────────────────────────────────────────────
const installer = spiralityInstallerPath(SPIRALITY);
if (!existsSync(installer)) fail('install', `Spirality's installer ${installer} is not there`);
if (dryRun && onBranch !== branch) {
  // The installer reads the checkout's settings file, which is on the branch, not checked out yet.
  say('install', `would run Spirality's installer ${installerCommand(SPIRALITY, checkout).join(' ')}, then read back --status and each lane's first pass`);
  console.log('\nDry run done: nothing was changed.');
  process.exit(0);
}
const statusNow = () => {
  const s = run('bash', installerCommand(SPIRALITY, checkout, '--status'), { cwd: SPIRALITY });
  return { text: s.out, jobs: parseStatus(s.out) };
};
const notLoaded = (jobs) => LANES.filter((l) => !jobs[l]?.installed || !jobs[l]?.loaded);
const installedAt = new Date();
const before = notLoaded(statusNow().jobs);
if (dryRun) {
  say('install', before.length
    ? `would install the lanes with Spirality's installer ${installerCommand(SPIRALITY, checkout).join(' ')} (not loaded now: ${before.join(', ')})`
    : 'every lane is already loaded; would leave them');
  console.log('\nDry run done: nothing was changed.');
  process.exit(0);
}
if (!before.length) {
  say('install', 'every lane is already installed and loaded; not reinstalling (judging each lane\'s newest pass instead)');
} else {
  const inst = run('bash', installerCommand(SPIRALITY, checkout), { cwd: SPIRALITY });
  if (!inst.ok) fail('install', `Spirality's install_loop_runner.sh --project ${checkout} exit ${inst.code}: ${last(inst.err || inst.out)}`);
  say('install', `Spirality's install_loop_runner.sh --project ${checkout} finished`);
}

// ── 4. lanes ───────────────────────────────────────────────────────────────
const after = statusNow();
const missing = notLoaded(after.jobs);
if (missing.length) fail('lanes', `--status shows these lanes not installed or not loaded: ${missing.join(', ')}`);
say('lanes', `--status: ${LANES.join(', ')} all loaded`);

const logDir = expandHome(config.logDir);
const logOf = (lane) => join(logDir, `${config.projectSlug}-${lane}.log`);
const passesOf = (lane) => readPasses(existsSync(logOf(lane)) ? readFileSync(logOf(lane), 'utf8') : '', lane);
// Fresh install: each lane's first pass after it. Rerun with every lane
// already loaded: each lane's newest pass, so a lane that stood down before
// is checked again rather than taken on trust (rule 6).
const sinceOf = Object.fromEntries(LANES.map((l) => [l, before.length ? installedAt : rerunSince(passesOf(l))]));
const deadline = Date.now() + waitMinutes * 60 * 1000;
const verdicts = {};
for (;;) {
  for (const lane of LANES) {
    if (verdicts[lane]?.verdict === 'ok' || verdicts[lane]?.verdict === 'failed') continue;
    verdicts[lane] = judgeFirstPass(passesOf(lane), lane, { since: sinceOf[lane] });
    if (verdicts[lane].verdict !== 'waiting') say('lanes', `${lane}: ${verdicts[lane].verdict === 'ok' ? 'ok' : 'FAILED'}: ${verdicts[lane].why}`);
  }
  const failed = LANES.filter((l) => verdicts[l].verdict === 'failed');
  if (failed.length) fail('lanes', failed.map((l) => `${l}: ${verdicts[l].why} (log ${logOf(l)})`).join('; '));
  if (LANES.every((l) => verdicts[l].verdict === 'ok')) break;
  if (Date.now() > deadline) {
    const waiting = LANES.filter((l) => verdicts[l].verdict === 'waiting');
    fail('lanes', `after ${waitMinutes} minutes, no word yet from: ${waiting.map((l) => `${l} (${verdicts[l].why}; log ${logOf(l)})`).join(', ')}`);
  }
  await new Promise((r) => setTimeout(r, 15000));
}

console.log(`\nDone: ${config.projectSlug}'s lanes are running from Spirality's folder, working in ${checkout} on ${branch}, and ${ticket} is In review in its project.`);
console.log(`Its review lane reviews PR #${prNumber} and asks Dane to merge it; its relay merges it on his merge phrase.`);
