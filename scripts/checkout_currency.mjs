/**
 * Is this machine running the code on `main`, and if not, why not?
 *
 * The reasoning, the incident and the rules live in lib/checkoutCurrency.js.
 * This file is the IO: the git readings, the suppression stamp, the bus post
 * and the one repair that is safe to perform without a person.
 *
 * Moved from StarCaster's scripts/checkout_currency.mjs (commit 0682572) for
 * SP-268. One difference matters: in StarCaster this script made the pull. In
 * Spirality the relay (scripts/run_relay.sh) and the lane runners already
 * pull `main`, under a shared lock, and restart the tracker when a pull
 * changes its files (SP-150). A second puller here would skip that restart
 * and race the lock, so THIS SCRIPT NEVER PULLS. It reads the checkout after
 * the relay's pull and says what it finds.
 *
 *   npm run checkout:current               report only
 *   npm run checkout:current -- --check    report, and post an ALARM to the bus if stale
 *   npm run checkout:current -- --fix      displace untracked files that block the update
 *                                          (only ones origin/main tracks), never deletes;
 *                                          by hand only, never from the schedule
 *
 * Flags the relay passes after its own pull (scripts/lib/relay_queue_watchdogs.sh):
 *   --before <sha>         where main was before the pull: moved and now level is "behind, pulled"
 *   --pull-output <file>   what a refused pull said, so the reason named is git's own
 *   --dry-run              print what would be posted, post and write nothing
 *
 * The first line is always one of: `current`, `behind, pulled`,
 * `behind, could not pull: <reason and files>`, `behind, not pulled yet: <why>`
 * or `cannot tell: <why>`.
 *
 * Exit 0 whatever the checkout's state: the relay must not be failed by its
 * own watchdog. Exit 1 only when an alarm was due and its post did not land,
 * or the project config could not be read (a step that fails says so).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { watchdogSettings, nodeName, postToBus } from './lib/watchdogDoorCalls.mjs';

const require = createRequire(import.meta.url);
const currency = require('../lib/checkoutCurrency.js');
const posts = require('../lib/watchdogPosts.js');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
};
const CHECK = flag('check');
const FIX = flag('fix');
const DRY = flag('dry-run');
const BEFORE = arg('before');
const PULL_OUTPUT_FILE = arg('pull-output');
const NOW = Date.now();
const NODE = nodeName();
// The checkout being watched: the folder this command runs in (the relay
// runs it from the project's checkout), so a named project's checkout is
// read, not Spirality's.
const REPO = (() => {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return top.status === 0 ? String(top.stdout).trim() : process.cwd();
})();

let SETTINGS;
try {
  SETTINGS = watchdogSettings();
} catch (err) {
  console.error(`checkout:current: the project config could not be read (${String(err?.message || err)}). Nothing was read or posted.`);
  process.exit(1);
}
const STAMP_DIR = posts.stampDir({ logDir: SETTINGS.logDir, slug: SETTINGS.slug });

const ESC = String.fromCharCode(27);
const tty = process.stdout.isTTY;
const paint = (code, text) => (tty ? ESC + '[' + code + 'm' + text + ESC + '[0m' : text);
const red = (t) => paint('31', t);
const green = (t) => paint('32', t);
const yellow = (t) => paint('33', t);

// --- git, read-only unless asked otherwise ----------------------------------

function git(args, { cwd = REPO } = {}) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    ok: !out.error && out.status === 0,
    stdout: String(out.stdout || '').trim(),
    stderr: String(out.stderr || out.stdout || '').trim(),
  };
}

/** Commits each side of origin/main, or nulls when it cannot be counted. */
function distance() {
  const out = git(['rev-list', '--left-right', '--count', 'origin/main...HEAD']);
  if (!out.ok) return { behind: null, ahead: null };
  const [b, a] = out.stdout.split(/\s+/).map((n) => Number(n));
  return { behind: Number.isFinite(b) ? b : null, ahead: Number.isFinite(a) ? a : null };
}

const lines = (text) => String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);

// --- the stamps -------------------------------------------------------------
//
// Facts about THIS MACHINE, not about the code, so they live beside the lane
// logs (posts.stampDir), not in the checkout, and outlive any worktree.

const alarmStamp = path.join(STAMP_DIR, 'stale-checkout.stamp');
const successStamp = path.join(STAMP_DIR, 'checkout-updated.stamp');

function readStamp(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}
function writeStamp(file, at) {
  try {
    fs.mkdirSync(STAMP_DIR, { recursive: true });
    fs.writeFileSync(file, at + '\n');
    return null;
  } catch (err) { return String(err?.message || err); }
}
function clearStamp(file) {
  try { fs.rmSync(file, { force: true }); } catch { /* nothing to clear */ }
}

// --- the reading ------------------------------------------------------------

function reading() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '?';
  // TRACKED changes only, as in StarCaster: untracked files are the
  // recoverable case, and are read separately below.
  const dirty = git(['status', '--porcelain', '--untracked-files=no']).stdout !== '';
  const fetched = git(['fetch', '--quiet', 'origin', 'main']).ok;
  const { behind, ahead } = fetched ? distance() : { behind: null, ahead: null };
  const head = git(['rev-parse', 'HEAD']).stdout;

  // What the caller's refused pull said, if it said anything.
  let mergeStderr = '';
  if (PULL_OUTPUT_FILE) {
    try { mergeStderr = fs.readFileSync(PULL_OUTPUT_FILE, 'utf8').trim(); } catch { mergeStderr = ''; }
  }

  // Worked out without pulling: the files origin/main adds that sit here
  // untracked (what git would refuse to overwrite), and every untracked
  // file (any at all stop the runners' pull).
  let blocking = [];
  let untracked = [];
  if (fetched && behind > 0 && branch === 'main' && !dirty && ahead === 0) {
    const added = git(['diff', '--name-only', '--no-renames', '--diff-filter=A', 'HEAD', 'origin/main']);
    const others = git(['ls-files', '--others', '--exclude-standard']);
    untracked = others.ok ? lines(others.stdout) : [];
    blocking = added.ok ? currency.untrackedBlockers(lines(added.stdout), untracked) : [];
  }

  return currency.classify({
    branch, dirty, fetched, behind, ahead, mergeStderr,
    merged: Boolean(BEFORE && head && BEFORE !== head),
    pullRefused: Boolean(mergeStderr),
    blocking,
    untracked,
    lastSuccessAt: Date.parse(readStamp(successStamp)) || null,
    now: NOW,
  });
}

let state = reading();

// --- the one repair that may run without a person, and only by hand ---------

if (FIX && state.state === currency.STATES.BLOCKED_UNTRACKED) {
  const tracked = git(['ls-tree', '-r', '--name-only', 'origin/main']);
  const safe = currency.autoRepairable(state.blocking, new Set(tracked.ok ? tracked.stdout.split('\n') : []));
  if (!safe.ok) {
    console.log(yellow('Not repairing: ' + safe.why));
  } else if (DRY) {
    console.log('--dry-run -- would displace ' + safe.paths.length + ' file(s):');
    for (const p of safe.paths) console.log('  ' + p);
  } else {
    // DISPLACE, NEVER DELETE. A move whose destination it prints is not a
    // rewrite of someone's work. The relay's next pull then goes through.
    const dest = path.join(STAMP_DIR, 'displaced', new Date(NOW).toISOString().replace(/[:.]/g, '-'));
    let moved = 0;
    for (const p of safe.paths) {
      try {
        const to = path.join(dest, p);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(path.join(REPO, p), to);
        moved += 1;
      } catch (err) {
        console.log(red('Could not displace ' + p + ': ' + String(err?.message || err)));
      }
    }
    if (moved) {
      console.log('Displaced ' + moved + ' file(s) to ' + dest + ' -- nothing was deleted. The relay\'s next pull brings the checkout level.');
      state = reading();
    }
  }
}

// --- report -----------------------------------------------------------------

const summary = currency.summaryLine(state);
console.log(state.alarm ? red(summary) : state.cannotTell ? yellow(summary) : green(summary));
const text = currency.report(state, { node: NODE });
console.log(text);

// Level with main is what "this machine is current" means: it stamps, so the
// age quoted in an alarm is the age of the last time this machine was
// genuinely on main's code, and it clears the alarm's reminder.
if (!state.alarm && !state.cannotTell && !state.behind) {
  if (!DRY) {
    writeStamp(successStamp, new Date(NOW).toISOString());
    clearStamp(alarmStamp);
  }
  process.exit(0);
}

if (!CHECK || !state.alarm) process.exit(0);

// --- the alert --------------------------------------------------------------

const post = [
  `ALARM: STALE CHECKOUT on ${NODE}: this machine is running old code and cannot update itself.`,
  '',
  text,
  '',
  'Until this clears, every scheduled job here runs the tooling from the older commit, '
  + 'while loop worktrees are still cut from a fresh origin/main. Nothing errors; it just '
  + 'runs an older set of rules.',
].join('\n');

if (DRY) {
  console.log('');
  console.log('--dry-run -- this is what would go to the bus, and nothing was sent:');
  console.log('');
  console.log(post);
  process.exit(0);
}

if (!posts.dueAgain({ lastAt: readStamp(alarmStamp), now: NOW, everyMs: posts.REPOST_EVERY_MS })) {
  console.log('Already reported within the last ' + Math.round(posts.REPOST_EVERY_MS / 3600000) + 'h -- not posting again.');
  process.exit(0);
}

const sent = postToBus(post);
if (!sent.ok) {
  console.log(red('Could NOT post to the bus (' + String(sent.why).slice(0, 300) + ').'));
  console.log('Not stamping it as sent, so the next pass tries again.');
  process.exit(1);
}
const why = writeStamp(alarmStamp, new Date(NOW).toISOString());
if (why) console.log('Posted, but the suppression stamp could not be written (' + why + ').');
console.log('Posted to the bus.');
process.exit(0);
