/**
 * wakeLanes.mjs — wake the lane a ticket has just been handed to (SP-231).
 *
 * The lanes wake on timers (intake, build and review every 30 minutes, the
 * relay every 10), so a ticket handed from one lane to the next used to sit
 * out the next lane's timer. SP-219 gave each lane a way to be woken
 * (`node scripts/lib/wakeLane.mjs <lane>`); this module makes the tracker use
 * it, from the server's after-write hook, the same place the hand-over email
 * hears about writes (tracker/notify.mjs):
 *
 *  - a ticket moved (or filed, or copied) into **Requested** wakes loop-intake;
 *  - into **Queued** or **Rework** wakes loop-build;
 *  - into **In review** wakes loop-review;
 *  - a comment from a person (Dane's merge word, his "go", his answer) on a
 *    **Ready to launch** or **Needs your input** ticket wakes the relay.
 *
 * The rules it keeps:
 *
 *  - **Only this tracker's own project.** A ticket of another project
 *    (StarCaster, WaveCenter) wakes nothing: their lanes are not this
 *    machine's to start from here.
 *  - **Only a status change wakes a lane.** A write that leaves the status
 *    alone (a rename, a new description) wakes nothing, and neither does a
 *    move into a status no lane picks up (Building, Live, Dane's two).
 *  - **A lane never wakes itself.** A move made by the lane that would be
 *    woken (loop-build handing a ticket back to Rework) is left to the
 *    timer, so a pass that hands back the same ticket every time cannot spin
 *    without rest.
 *  - **The lanes' locks still decide.** The wake goes only through slice 1's
 *    command, which writes the lane's wake file (the runner starts its next
 *    pass when the one running ends, never a second beside it) or kickstarts
 *    the relay without `-k` (never a second copy).
 *  - **A failed wake never fails the write.** The server answers the caller
 *    first and only then calls this; the command runs as its own process
 *    with a short time limit, so a hang never holds up the server, and a
 *    failure is one log line.
 *
 * One log line per wake: the ticket, the status and the lane, and what the
 * wake command said (or why it failed). The timers stay as the fallback.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import loopStatuses from '../lib/loopStatuses.js';

const { REQUESTED, REWORK, QUEUED, IN_REVIEW, READY_TO_LAUNCH, NEEDS_YOUR_INPUT } = loopStatuses;

export const RELAY = 'relay';

/** The lane each status hands a ticket to. Any status not here wakes nothing. */
export const LANE_FOR_STATUS = Object.freeze({
  [REQUESTED]: 'loop-intake',
  [QUEUED]: 'loop-build',
  [REWORK]: 'loop-build',
  [IN_REVIEW]: 'loop-review',
});

/** A person's comment on a ticket in one of these wakes the relay. */
export const RELAY_STATUSES = Object.freeze([READY_TO_LAUNCH, NEEDS_YOUR_INPUT]);

/** How long the wake command may take before it is stopped and said so. */
export const WAKE_TIME_LIMIT_MS = 5000;

const WAKE_COMMAND = fileURLToPath(new URL('../scripts/lib/wakeLane.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const statusOf = (s) => String(s ?? '').trim().toLowerCase();

/**
 * True when `actor` is the lane itself: a machine actor named `<lane>`, or
 * `<project> <lane>` (the names the door signs in with).
 */
function isLane(actor, lane) {
  if (!actor || actor.kind === 'human') return false;
  const name = String(actor.name ?? '').trim();
  return name === lane || name.endsWith(` ${lane}`);
}

/**
 * The wake one write calls for, or null. `write` is what the server's route
 * hands its after-write hook: `{ ticket, changed }` for a filed or changed
 * ticket, `{ comment, on }` for a comment. `actor` is who wrote it, and
 * `project` the slug of the project whose config this server loaded.
 * Answers `{ lane, ticket, status, why }`, `why` for the log line.
 */
export function laneToWake(write, { actor = null, project = null } = {}) {
  if (!write || !project) return null;
  if (write.comment) {
    const on = write.on;
    if (!on || on.project !== project) return null;
    if (!actor || actor.kind !== 'human') return null;
    const status = statusOf(on.status);
    return RELAY_STATUSES.includes(status) ? { lane: RELAY, ticket: on.id, status, why: `has a comment from ${actor.name ?? 'a person'} in "${status}"` } : null;
  }
  const t = write.ticket;
  if (!t || t.project !== project) return null;
  if (!Array.isArray(write.changed) || !write.changed.includes('status')) return null;
  const status = statusOf(t.status);
  const lane = Object.hasOwn(LANE_FOR_STATUS, status) ? LANE_FOR_STATUS[status] : null;
  if (!lane || isLane(actor, lane)) return null;
  return { lane, ticket: t.id, status, why: `entered "${status}"` };
}

/**
 * Slice 1's command, run as its own process from this checkout with a time
 * limit. Resolves `{ code, line }` and never rejects.
 */
export function runWakeCommand(lane, { timeout = WAKE_TIME_LIMIT_MS, run = execFile } = {}) {
  return new Promise((resolvePromise) => {
    run(process.execPath, [WAKE_COMMAND, lane], { cwd: REPO_ROOT, timeout, encoding: 'utf8' }, (err, stdout = '', stderr = '') => {
      const said = `${stdout}${stderr}`.trim().split('\n').filter(Boolean).pop() ?? '';
      if (!err) return resolvePromise({ code: 0, line: said || `${lane}: woken` });
      const why = err.killed || err.signal
        ? `stopped after ${timeout / 1000}s with no answer`
        : `exited ${typeof err.code === 'number' ? err.code : (err.code ?? 'without a code')}`;
      resolvePromise({ code: typeof err.code === 'number' ? err.code : 1, line: said ? `${said} (${why})` : `${lane}: NOT WOKEN — the wake command ${why}` });
    });
  });
}

/**
 * The server's lane waker. `project` is the slug of the project whose config
 * the server loaded (null: no wakes at all). `wake(lane)` resolves
 * `{ code, line }` (tests hand in a fake). `log` takes one line.
 */
export function createLaneWaker({ project, wake = runWakeCommand, log = () => {} }) {
  let last = Promise.resolve();
  return {
    /**
     * Hear one write. Resolves once its wake (if any) is done and logged;
     * never rejects, so a wake can never fail the write that caused it.
     */
    afterWrite(write, { actor = null } = {}) {
      let want;
      try {
        want = laneToWake(write, { actor, project });
      } catch (err) {
        log(`wake lanes: could not tell which lane this write wakes (${err?.message ?? err}); none woken.`);
        return Promise.resolve();
      }
      if (!want) return Promise.resolve();
      const done = Promise.resolve()
        .then(() => wake(want.lane))
        .then(
          (r) => log(`wake lanes: ${want.ticket} ${want.why} → ${want.lane}${r?.code === 0 ? '' : ' FAILED'}: ${r?.line ?? 'no answer'}`),
          (err) => log(`wake lanes: ${want.ticket} ${want.why} → ${want.lane} FAILED: ${err?.message ?? err}`),
        )
        .catch(() => {});
      last = last.then(() => done);
      return done;
    },

    /** Resolves once every wake heard so far is done. For the tests. */
    settled() {
      return last;
    },
  };
}
