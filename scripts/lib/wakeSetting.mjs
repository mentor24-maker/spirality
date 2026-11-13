#!/usr/bin/env node
/**
 * wakeSetting.mjs — a loop job's wake time as Dane set it on the tracker's
 * Settings page (SP-224, SP-236), for the job itself to sleep on.
 *
 *   node scripts/lib/wakeSetting.mjs loop-build   → 600       (exit 0)
 *   node scripts/lib/wakeSetting.mjs relay        → 300       (exit 0)
 *                                                 → one line saying why (exit 1)
 *
 * It asks the door (`npm run --silent clickup -- settings`, which talks to
 * the tracker the project config names, with the sign-in the caller's
 * TRACKER_TOKEN_NAME names) and prints the one number. Anything short of a
 * whole number in the Settings page's own range (WAKE_RANGE) is a failure,
 * never a number: a lane told to sleep 0 would spin, and one told nothing
 * would stop. On a failure the ONE line it prints, on stdout so a caller
 * can log it as it is, says why; the caller keeps the last good value.
 *
 * scripts/loop_runner.sh runs it before every sleep between passes;
 * scripts/run_relay.sh after every pass started by its launchd tick.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { INTERVALS, WAKE_RANGE } from './loopSchedule.mjs';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** How long the read may take before it counts as failed, in milliseconds. */
export const READ_TIMEOUT_MS = 60_000;

/**
 * `job`'s wake time in the `settings` command's output (`name=value` lines):
 * `{ seconds }`, or `{ problem }` in words when there is none or it is not a
 * whole number from WAKE_RANGE.min to WAKE_RANGE.max.
 */
export function wakeFrom(text, job) {
  const key = `wake.${job}=`;
  const line = String(text ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith(key));
  if (line == null) return { problem: `the tracker's settings have no wake.${job} line` };
  const value = line.slice(key.length);
  const n = /^[0-9]+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < WAKE_RANGE.min || n > WAKE_RANGE.max) {
    return { problem: `the tracker answered wake.${job}=${value}, not a whole number from ${WAKE_RANGE.min} to ${WAKE_RANGE.max} seconds` };
  }
  return { seconds: n };
}

/** The door's own `settings` command, run from this checkout. */
function defaultRead() {
  const r = spawnSync('npm', ['run', '--silent', 'clickup', '--', 'settings'], { cwd: REPO, encoding: 'utf8', timeout: READ_TIMEOUT_MS });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ?? null };
}

/** The last line of `text` that says something, cut short; null when none does. */
function lastSaid(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const last = lines[lines.length - 1];
  return last.length > 200 ? `${last.slice(0, 200)}…` : last;
}

/**
 * Read `job`'s wake time: `{ code: 0, line: '<seconds>' }`, or `{ code: 1,
 * line }` naming why it could not. `read()` is a stand-in for tests.
 */
export function readWake(job, { read = defaultRead } = {}) {
  if (!Object.hasOwn(INTERVALS, job)) return { code: 2, line: `wakeSetting: "${job ?? ''}" is not a loop job — one of: ${Object.keys(INTERVALS).join(', ')}` };
  const r = read();
  if (r.error?.code === 'ETIMEDOUT') return { code: 1, line: `the settings read took longer than ${READ_TIMEOUT_MS / 1000}s and was stopped` };
  if (r.error) return { code: 1, line: `the settings read could not run (${r.error.code || r.error.message})` };
  if (r.status !== 0) return { code: 1, line: `the settings read failed (exit ${r.status ?? 'without a code'}${lastSaid(r.stderr) ? `: ${lastSaid(r.stderr)}` : ''})` };
  const { seconds, problem } = wakeFrom(r.stdout, job);
  if (problem) return { code: 1, line: problem };
  return { code: 0, line: String(seconds) };
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
  const job = process.argv[2];
  if (!job || job === '--help') {
    console.error(`usage: node scripts/lib/wakeSetting.mjs <job>\n  jobs: ${Object.keys(INTERVALS).join(', ')}`);
    process.exit(2);
  }
  const { code, line } = readWake(job);
  console.log(line);
  process.exit(code);
}
