#!/usr/bin/env node
/**
 * workCheck.mjs — does this lane have anything to act on? Asked by
 * scripts/loop_runner.sh (through scripts/work_check.sh) before it starts a
 * Claude session, so a pass with nothing to do costs no AI (SP-292).
 *
 *   node scripts/lib/workCheck.mjs loop-build    → one line; exit 0 work / 3 none
 *
 * WHY (2026-11-13). Every lane pass used to start a Claude session even with
 * an empty queue; the session read the queue, said "nothing to do" and
 * stopped. Since 10/29 about 5,600 of 8,700 passes were like that, each one
 * counted against the weekly limit, so a short wake time on the Settings page
 * (SP-236) cost quota on every empty tick. The same questions the skills ask
 * first are asked here through the door, with no AI:
 *
 *   loop-build   `pass-reconcile` (the skill's own first step; safe to run
 *                twice), then `wip-check` (a full cap ends the pass before it
 *                reads the queue, so it is no work), then `queue --claimable`
 *                (which already leaves out a ticket whose `Waits on:` is open)
 *   loop-review  a ticket in `In review`
 *   loop-intake  a ticket in `Requested`
 *
 * IT FAILS OPEN. Exit 3 ("no work") is said only on a clean read that found
 * nothing. Anything that cannot tell (the door failing, timing out, a lane
 * this file does not know) is exit 0, so the pass starts as it always did and
 * a real ticket is never left waiting on this check. A `pass-reconcile` that
 * fails starts the pass too: the skill then stops and reports it, as before.
 *
 * The one line it prints, on stdout, says why; the runner logs it.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** How long one door call may take before it counts as "could not tell", in milliseconds. */
export const CALL_TIMEOUT_MS = 60_000;

/** The exit codes the runner reads: anything but NO_WORK starts the pass. */
export const WORK = 0;
export const NO_WORK = 3;

/** The status each queue-reading lane works from. loop-build has its own steps. */
const STATUS_OF = Object.freeze({ 'loop-review': 'In review', 'loop-intake': 'Requested' });

/** The lanes this check knows. */
export const LANES = Object.freeze(['loop-build', ...Object.keys(STATUS_OF)]);

/** The door, run from this checkout: `npm run --silent clickup -- <args>`. */
export function defaultDoor(args) {
  const r = spawnSync('npm', ['run', '--silent', 'clickup', '--', ...args], { cwd: REPO, encoding: 'utf8', timeout: CALL_TIMEOUT_MS });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ?? null };
}

/** The last line of `text` that says something, cut short; '' when none does. */
function lastSaid(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : '';
  return last.length > 200 ? `${last.slice(0, 200)}…` : last;
}

/** Why a door call did not answer cleanly, in words; null when it did. */
function failure(r, what) {
  if (r.error?.code === 'ETIMEDOUT') return `${what} took longer than ${CALL_TIMEOUT_MS / 1000}s and was stopped`;
  if (r.error) return `${what} could not run (${r.error.code || r.error.message})`;
  if (r.status !== 0) {
    const said = lastSaid(r.stderr) || lastSaid(r.stdout);
    return `${what} failed (exit ${r.status ?? 'without a code'}${said ? `: ${said}` : ''})`;
  }
  return null;
}

/** The tickets a `queue` call listed: one per non-empty stdout line. */
function ticketIds(stdout) {
  return String(stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split('\t')[0]);
}

/** What a `queue` read says: work when it lists a ticket, none when it lists nothing. */
function fromQueue(r, what, found) {
  const why = failure(r, what);
  if (why) return { code: WORK, line: `could not tell (${why}), so the pass starts` };
  const ids = ticketIds(r.stdout);
  if (!ids.length) return { code: NO_WORK, line: `no work: ${found(0)}` };
  return { code: WORK, line: `work: ${found(ids.length)} (${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''})` };
}

/**
 * The verdict for `lane`: `{ code, line }`, code WORK (start the pass) or
 * NO_WORK (skip the Claude session). `door(args)` answers `{ status, stdout,
 * stderr, error }`; tests pass a stand-in.
 */
export function workVerdict(lane, { door = defaultDoor } = {}) {
  if (lane === 'loop-build') {
    // The skill's own first step, so a ticket a dead pass left in Building is
    // handed back (and becomes claimable) before the queue is read here.
    const reconcile = door(['pass-reconcile']);
    if (reconcile.error || (reconcile.status !== 0 && reconcile.status !== 3)) {
      return { code: WORK, line: `could not tell (${failure(reconcile, 'pass-reconcile')}), so the pass starts and reports it` };
    }
    const wip = door(['wip-check']);
    if (!wip.error && wip.status === 3) {
      const said = lastSaid(wip.stdout) || lastSaid(wip.stderr);
      return { code: NO_WORK, line: `no work: the work-in-progress cap is full${said ? ` (${said})` : ''}` };
    }
    // Room, or the cap could not be read: the pass claims either way, so read the queue.
    return fromQueue(door(['queue', '--claimable']), 'the claimable queue read',
      (n) => (n ? `${n} claimable ticket(s)` : 'no claimable ticket (Rework or Queued)'));
  }
  if (Object.hasOwn(STATUS_OF, lane)) {
    const status = STATUS_OF[lane];
    return fromQueue(door(['queue', '--status', status]), `the ${status} queue read`,
      (n) => (n ? `${n} ticket(s) in ${status}` : `no ticket in ${status}`));
  }
  return { code: WORK, line: `could not tell ("${lane ?? ''}" is not a lane this check knows: ${LANES.join(', ')}), so the pass starts` };
}

/** Run as a command, also through a link to this file (a real path both sides). */
function runAsCommand() {
  try {
    return Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (runAsCommand()) {
  const lane = process.argv[2];
  if (!lane || lane === '--help') {
    console.error(`usage: node scripts/lib/workCheck.mjs <lane>\n  lanes: ${LANES.join(', ')}\n  exit 0: start the pass (work, or could not tell) / 3: no work`);
    process.exit(2);
  }
  const { code, line } = workVerdict(lane);
  console.log(line);
  process.exit(code);
}
