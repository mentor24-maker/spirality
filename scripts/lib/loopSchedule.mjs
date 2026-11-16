#!/usr/bin/env node
/**
 * loopSchedule.mjs — how often each loop job on the Mini wakes, in one place.
 *
 *   node scripts/lib/loopSchedule.mjs interval loop-build   → 1800
 *   node scripts/lib/loopSchedule.mjs interval relay        → 600
 *   node scripts/lib/loopSchedule.mjs tick                  → 60
 *
 * These are the DEFAULTS: what each job wakes on when nobody has set its
 * wake time on the tracker's Settings page (SP-224), and what it falls back
 * to when the tracker cannot be read (SP-236). The installer
 * (scripts/install_loop_runner.sh, `interval_of`) hands a lane's default to
 * its runner as the first value it sleeps; before every later sleep the
 * runner asks the tracker for the set one (scripts/lib/wakeSetting.mjs).
 * The tracker's Pipeline Status pod (tracker/pipeline.mjs, SP-168) and the
 * Settings page read them here too, so none of them can disagree.
 *
 * The relay is one pass per launchd start, so a new wake time must need no
 * plist rewrite: launchd starts it every RELAY_TICK seconds, and
 * scripts/run_relay.sh skips each tick until the relay's wake time has
 * passed since its last real start.
 *
 * A job not named here wakes hourly, as the installer always did.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Seconds between one pass of a job and the next. */
export const INTERVALS = Object.freeze({
  'loop-build': 1800,
  'loop-review': 1800,
  'loop-intake': 1800,
  relay: 600,
});

/**
 * How often launchd starts the relay, in seconds: the shortest wake time it
 * can be set to (WAKE_RANGE.min), so every set value is met to within one
 * tick.
 */
export const RELAY_TICK = 60;

/**
 * The shortest and longest wake time a job may be set to, in seconds. The
 * Settings page refuses anything outside it (tracker/pipelineControls.mjs),
 * and a job never sleeps on a value outside it (scripts/lib/wakeSetting.mjs).
 */
export const WAKE_RANGE = Object.freeze({ min: 60, max: 86400 });

/** The interval for a job nobody named. */
export const DEFAULT_INTERVAL = 3600;

/** Seconds between passes of `job`. */
export function intervalOf(job) {
  return Object.hasOwn(INTERVALS, job) ? INTERVALS[job] : DEFAULT_INTERVAL;
}

/** Run as a command, also by a path through a link (a real path both sides). */
function runAsCommand() {
  try {
    return Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (runAsCommand()) {
  const [what, job] = process.argv.slice(2);
  if (what === 'tick' && !job) {
    process.stdout.write(`${RELAY_TICK}\n`);
  } else if (what === 'interval' && job) {
    process.stdout.write(`${intervalOf(job)}\n`);
  } else {
    console.error('usage: node scripts/lib/loopSchedule.mjs interval <job> | tick');
    process.exit(2);
  }
}
