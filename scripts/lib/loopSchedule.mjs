#!/usr/bin/env node
/**
 * loopSchedule.mjs — how often each loop job on the Mini wakes, in one place.
 *
 *   node scripts/lib/loopSchedule.mjs interval loop-build   → 1800
 *   node scripts/lib/loopSchedule.mjs interval relay        → 600
 *
 * The installer (scripts/install_loop_runner.sh, `interval_of`) writes these
 * numbers into each job's launchd plist, and the tracker's Pipeline Status
 * pod (tracker/pipeline.mjs, SP-168) adds the relay's to its last start to
 * say when it runs next. Both read them here, so the two can never disagree.
 *
 * A job not named here wakes hourly, as the installer always did.
 */
import { fileURLToPath } from 'node:url';

/** Seconds between one pass of a job and the next. */
export const INTERVALS = Object.freeze({
  'loop-build': 1800,
  'loop-review': 1800,
  'loop-intake': 1800,
  relay: 600,
});

/** The interval for a job nobody named. */
export const DEFAULT_INTERVAL = 3600;

/** Seconds between passes of `job`. */
export function intervalOf(job) {
  return Object.hasOwn(INTERVALS, job) ? INTERVALS[job] : DEFAULT_INTERVAL;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [what, job] = process.argv.slice(2);
  if (what !== 'interval' || !job) {
    console.error('usage: node scripts/lib/loopSchedule.mjs interval <job>');
    process.exit(2);
  }
  process.stdout.write(`${intervalOf(job)}\n`);
}
