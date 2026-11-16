#!/usr/bin/env node
/**
 * Report a failed scheduled job to the bus (SP-268).
 *
 *   npm run report:failure -- --job loop-build --status 1 --log <path> [--tail 12] [--dry-run]
 *
 * Moved from StarCaster's scripts/report_job_failure.mjs (commit 0682572).
 * scripts/loop_runner.sh calls it (through scripts/lib/lane_failure.sh) when
 * a lane's pass exits non-zero, so a lane that keeps failing is said on the
 * bus instead of only in a log nobody reads. One `ALARM:` post (texted)
 * naming the job, this machine, its exit and the end of its log, at most once
 * every 6 hours per job. The runner clears the reminder when the job next
 * succeeds (`failed-<job>.stamp`, in lib/watchdogPosts.js `failureStampFile`),
 * so a fault that is fixed and comes back is said again at once.
 *
 * KNOWN RESIDUAL, BY DESIGN (carried from StarCaster). This alert shares the
 * job's own dependencies (node, Doppler, the network, the tracker), so a
 * failure in one of those can stop the job and the alert together. The
 * heartbeat (SP-266) notices the silence instead.
 *
 * EXIT CODES. 0 posted, already said within the window, or a dry run. 1 the
 * post did not land (said in one line, not stamped, so the next failure tries
 * again). 2 asked wrongly (no --job), nothing posted. StarCaster's always
 * exited 0; here a failed post says so (CLAUDE.md rule 6). The runner never
 * lets this exit change its own or block its next pass.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { watchdogSettings, nodeName, postToBus } from './lib/watchdogDoorCalls.mjs';

const require = createRequire(import.meta.url);
const posts = require('../lib/watchdogPosts.js');

const argv = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const DRY = argv.includes('--dry-run');

const job = arg('job');
const status = arg('status', '?');
const logPath = arg('log');
const tailLines = Number(arg('tail', '12')) || 12;

if (!job) {
  console.error('report_job_failure: --job <name> is required. Nothing reported.');
  process.exit(2);
}

let settings;
try {
  settings = watchdogSettings();
} catch (err) {
  console.error(`report_job_failure: the project config could not be read (${String(err?.message || err)}). Nothing reported.`);
  process.exit(1);
}

const node = nodeName();
const at = new Date().toISOString();
const stampFile = posts.failureStampFile({ logDir: settings.logDir, slug: settings.slug, job });

function readStamp() {
  try { return fs.readFileSync(stampFile, 'utf8').trim(); } catch { return ''; }
}

if (!posts.dueAgain({ lastAt: readStamp(), now: Date.now(), everyMs: posts.REPOST_EVERY_MS })) {
  console.error(`report_job_failure: ${job} already reported within the last `
    + `${Math.round(posts.REPOST_EVERY_MS / 3600000)}h — not posting again. The log still records this run.`);
  process.exit(0);
}

let logTail = '';
if (logPath) {
  try {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n');
    logTail = lines.slice(-tailLines).join('\n');
  } catch (err) {
    // "No log lines" and "the log could not be read" are different findings.
    logTail = `(could not read ${logPath}: ${String(err && err.message)})`;
  }
}

const text = posts.renderFailurePost({ job, node, status, at, logTail, logPath, when: posts.mountainTime });

if (DRY) {
  console.log('--dry-run — this is what would go to the bus, and nothing was sent:');
  console.log('');
  console.log(text);
  process.exit(0);
}

const sent = postToBus(text);
if (!sent.ok) {
  console.error(`report_job_failure: could NOT post ${job}'s failure to the bus (${String(sent.why).slice(0, 300)}). Not stamping it as sent, so the next failure tries again.`);
  process.exit(1);
}
try {
  fs.mkdirSync(posts.stampDir({ logDir: settings.logDir, slug: settings.slug }), { recursive: true });
  fs.writeFileSync(stampFile, `${at}\n`);
} catch (err) {
  // Posted but not stamped: the next failure inside the window posts again.
  // Noisy, and better than an unwritable folder silencing the alarm.
  console.error(`report_job_failure: posted, but the reminder stamp could not be written (${String(err && err.message)}).`);
}
console.error(`report_job_failure: ${job} failure (exit ${status}) on ${node} posted to the bus.`);
process.exit(0);
