#!/usr/bin/env node
/**
 * `npm run stale-answer` — Dane replied, and nothing moved.
 *
 * The FIFTH watchdog, and it watches the one stage where the thing being
 * waited on is a machine acting on words he has already written. The four
 * before it structurally cannot see this:
 *
 *   heartbeat      did a job stop firing?          the relay was healthy
 *   stale-check    has a job THIS machine owns stopped beating?   it had beaten 9m earlier
 *   throughput     the job fired — did anything come out?         days, not minutes
 *   stale-ready    `Ready to launch` has no owner                 wrong stage
 *
 * On 2026-09-06 Dane answered `C` on 86bbv8nvy at 09:40. The 09:46 relay pass
 * delivered his answer, ran out of ClickUp budget before it could return the
 * ticket to `Queued`, reported that honestly into a bus post the same rate
 * limit skipped, and every later pass read the answer as already relayed and
 * did nothing. He found it himself 3.5 hours later. The retry that stops it
 * being permanent is in `scripts/builder/busRelayPlan.js`; this is the alarm
 * for every other reason the move might still not happen.
 *
 *   npm run stale-answer                        read everything, print the report, write nothing
 *   npm run stale-answer -- --check             the same, and post to the bus if anything is stuck
 *   npm run stale-answer -- --check --dry-run   say what it WOULD post, send nothing
 *   npm run stale-answer -- --force             ignore the read throttle
 *
 * Exit codes, because scripts branch on this:
 *   0  nothing is stuck
 *   1  at least one answer of his has gone unacted on
 *   2  CANNOT TELL: a reading the verdict needed could not be taken. NEVER
 *      rendered as healthy (docs/DOCTRINE.md 3.11)
 *
 * WHERE IT RUNS. `scripts/run_bus_relay.sh` calls it BEFORE the ownership
 * check, beside its four neighbours — and here the neighbours' own reasoning
 * DOES apply, unlike stale-ready's: the failure being watched for is the relay
 * itself not completing the move, so a check that ran only where the relay
 * runs could not see the case where the relay is dead. The machine that does
 * not own the relay is already awake there doing nothing, and that idle wake
 * is the vantage point that survives the owning machine being off.
 *
 * NOTHING HERE MAY FAIL THE JOB THAT CALLS IT. run_bus_relay.sh guards the
 * call with `|| true`, exactly as it does its neighbours'.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const staleAnswer = require('../lib/staleAnswer.js');
const heartbeat = require('../lib/nodeHeartbeat.js');
const nodeRoles = require('../lib/nodeRoles.js');
const clickup = require('./lib/clickup.cjs');
// Tickets and comments from the tracker, through the ticket door (SC-794). Dane's
// seat is the TRACKER's operator id from spirality.project.json, not the old
// ClickUp id: a ClickUp id matches no comment on the tracker, so every answer
// would have read as a machine's.
const tracker = require('./lib/trackerDoor.cjs');
const busRelayPlan = require('./builder/busRelayPlan.js');
const machineComment = require('./builder/machineComment.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPERATOR_ID = tracker.OPERATOR_ID;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const arg = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const CHECK = flag('check');
const DRY = flag('dry-run');
const FORCE = flag('force');

/**
 * The threshold, overridable ONLY on the command line — the same escape hatch
 * `stale-ready` carries and for the same reason: the one claim a unit test
 * cannot make is *it actually fires against the live board*, and a rehearsal
 * that costs half an hour of waiting is a rehearsal nobody repeats.
 * `run_bus_relay.sh` passes neither flag, so the shipped number is the derived
 * one in `lib/staleAnswer.js`.
 */
const STALE_AFTER_MINUTES = Number(arg('stale-after-minutes', String(staleAnswer.STALE_AFTER_MINUTES)));
if (!Number.isFinite(STALE_AFTER_MINUTES) || STALE_AFTER_MINUTES < 0) {
  console.log(`--stale-after-minutes must be a number of minutes, not "${arg('stale-after-minutes')}".`);
  process.exit(2);
}

const NOW = Date.now();
const NODE = nodeRoles.thisNode();

// --- suppression ------------------------------------------------------------

/**
 * One stamp per ticket PER REASON, beside the other watchdogs' — a stamp
 * records what THIS MACHINE has said, which is a fact about the machine and
 * not about the code, so it must survive a worktree being removed.
 */
const STAMP_DIR = `${heartbeat.heartbeatDir()}/answer-stale`;
const stampPath = (key) => path.join(STAMP_DIR, `${String(key).replace(/[^a-z0-9:-]/gi, '-')}.stamp`);

function readStamps() {
  const stamps = new Map();
  let entries = [];
  try { entries = fs.readdirSync(STAMP_DIR); } catch { return stamps; }
  for (const file of entries) {
    if (!file.endsWith('.stamp')) continue;
    try {
      const at = fs.readFileSync(path.join(STAMP_DIR, file), 'utf8').trim();
      stamps.set(file.replace(/\.stamp$/, ''), at);
    } catch { /* an unreadable stamp reads as "never posted", which errs towards posting */ }
  }
  return stamps;
}

function writeStamp(key, at) {
  try {
    fs.mkdirSync(STAMP_DIR, { recursive: true });
    fs.writeFileSync(stampPath(key), `${at}\n`);
    return null;
  } catch (err) {
    return String(err?.message || err);
  }
}

/**
 * Clear every stamp EXCEPT the ones belonging to a ticket that is stuck right
 * now — CRITERION 4 in the ticket's own words: the alarm must clear itself so
 * the condition is re-derived rather than announced once.
 *
 * KEEP-LIST, NOT A CLEAR-LIST (2026-09-07, round 1 review). It used to be
 * handed the ids of tickets still IN `Needs your input` and not stuck, which
 * left out the normal healthy ending — a ticket that leaves the stage
 * altogether. Its stamp was therefore never cleared, so getting stuck, getting
 * fixed, and sticking again for the same reason inside six hours was silently
 * suppressed: the fire-once alarm this criterion was written against, in the
 * code written to prevent it.
 *
 * Safe to invert, because the caller only reaches this line having read the
 * whole list, and a ticket whose comments would not read is a FINDING (so it
 * is in the keep-list). A stamp that is not a current finding has no job:
 * `duePosts` reads them only to hold back a finding that already went out.
 */
function clearStampsExcept(keepTaskIds) {
  let entries = [];
  try { entries = fs.readdirSync(STAMP_DIR); } catch { return; }
  const keys = entries.filter((f) => f.endsWith('.stamp')).map((f) => f.replace(/\.stamp$/, ''));
  for (const key of staleAnswer.stampsToClear(keys, keepTaskIds)) {
    try { fs.rmSync(stampPath(key), { force: true }); } catch { /* nothing to clear */ }
  }
}

/**
 * The last time a READING was taken, which is a different question from the
 * last time one was posted.
 *
 * TWENTY MINUTES, NOT AN HOUR, and that is the one throttle in this repo that
 * is deliberately tighter than its neighbours': the window being watched is
 * THIRTY MINUTES. `stale-ready` reads hourly against a 24-hour signal, which
 * is 24 readings per window; an hourly read here would take two readings per
 * window and could report a 30-minute miss an hour late — a check that looks
 * like it works. The relay wakes every ten minutes, so this is one reading
 * every other wake. A hand-run `npm run stale-answer` is never throttled — a
 * person asking the question wants today's answer, not the last one.
 */
const READ_STAMP_FILE = `${heartbeat.heartbeatDir()}/answer-stale-read.stamp`;
const READ_EVERY_MS = 20 * 60 * 1000;

function readFileOrEmpty(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

function writeReadStamp(at) {
  try {
    fs.mkdirSync(heartbeat.heartbeatDir(), { recursive: true });
    fs.writeFileSync(READ_STAMP_FILE, `${at}\n`);
  } catch { /* a throttle that cannot be recorded costs a re-read, never a missed finding */ }
}

// --- the reads --------------------------------------------------------------

/** Every comment on a ticket, as OBJECTS — the ids, dates and authors are the
 *  whole of the question here. An incomplete read returns null: half a trail
 *  that looks whole is how a reader concludes something never happened. */
async function readComments(taskId) {
  return tracker.readComments(taskId);
}

/**
 * What this answer's reply thread says: was it relayed, and has a hand-back on
 * it already completed? Both off ONE request, and off the markers the relay
 * itself writes and reads.
 *
 * A read that FAILS returns null, not false. "I could not check" and "it was
 * not delivered" are different findings — the second names the party line as
 * the problem — and conflating them is the DOCTRINE 3.11 failure this whole
 * family of checks is written against.
 *
 * ON THE TRACKER THERE IS NOTHING TO READ (SC-794). The markers were replies
 * the old ClickUp bus-relay threaded under his answer; the tracker has no
 * reply threads and the relay that hands tickets back is Spirality's lane,
 * which writes none. So this answers null, "could not check", every time:
 * the finding falls through to the general "the hand-back is failing"
 * sentence rather than blaming the party line, which is the honest reading.
 * It does NOT answer false, which would assert a delivery failed.
 */
async function readAnswerMarkers(_commentId) {
  return null;
}

// --- the pipeline switch ----------------------------------------------------

/**
 * Has Dane taken the deck? Asked by RUNNING the one implementation rather than
 * reading the switch a second way here — two readers of a safety flag are two
 * flags, and they disagree quietly. Checked before POSTING rather than before
 * reading, because a read writes nothing and the printed report is useful
 * either way. Fails safe in the same direction the switch itself does.
 */
function pipelinePaused() {
  const out = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'pipeline.mjs'), 'check'], {
    encoding: 'utf8',
  });
  if (out.error) return { paused: true, why: `the pipeline switch could not be read (${out.error.message})` };
  if (out.status === 0) return { paused: false, why: '' };
  const said = String(out.stderr || out.stdout || '').trim().split('\n')[0];
  return { paused: true, why: said || `the pipeline check exited ${out.status}` };
}

// --- the pass ---------------------------------------------------------------

if (CHECK && !FORCE
    && !heartbeat.dueAgain({ lastAt: readFileOrEmpty(READ_STAMP_FILE), now: NOW, everyMs: READ_EVERY_MS })) {
  console.log(`Read within the last ${READ_EVERY_MS / 60000} minutes — not asking the tracker again. `
    + '(`--force` takes a fresh reading; a hand-run `npm run stale-answer` is never throttled.)');
  process.exit(0);
}

let tasks = null;
let queueError = null;
try {
  tasks = await tracker.listTasks();
} catch (err) {
  queueError = String(err?.message || err).slice(0, 200);
}

if (!tasks) {
  // No tickets, no verdict — said out loud and exited 2, never as "all quiet".
  console.log(`CANNOT TELL — the tracker's tickets could not be read: ${queueError}`);
  console.log('Nothing about Needs your input is known this pass. This is not an all-clear.');
  process.exit(2);
}

// The reading happened, so the clock restarts here whatever the verdict turns
// out to be. Stamping only on a healthy verdict would make a stuck ticket
// re-read on every relay wake, which is the load this guards against.
if (CHECK) writeReadStamp(new Date(NOW).toISOString());

const parked = tasks.filter(
  (t) => String(t?.status?.status || '').trim().toLowerCase() === staleAnswer.ANSWER_STAGE,
);

const records = [];
for (const task of parked) {
  const id = String(task.id);
  const base = { taskId: id, name: task.name, url: task.url || tracker.ticketUrl(id) };

  let comments = null;
  try { comments = await readComments(id); } catch { comments = null; }
  if (!comments) { records.push({ ...base, commentsReadable: false }); continue; }

  // The SAME derivation the relay hands the ticket back on, called through the
  // same function. Two readers of "has he answered?" would be two definitions,
  // and the quiet way they fail is the report saying all-clear about the very
  // ticket the relay is refusing to move.
  const answered = busRelayPlan.answerAwaitingHandback({
    comments,
    operatorId: OPERATOR_ID,
    isMachine: machineComment.isMachineComment,
  });

  const newest = comments.reduce(
    (best, c) => (busRelayPlan.commentAt(c) > busRelayPlan.commentAt(best) ? c : best),
    comments[0] || null,
  );
  const operatorSpokeLast = busRelayPlan
    .operatorComments(newest ? [newest] : [], {
      operatorId: OPERATOR_ID,
      isMachine: machineComment.isMachineComment,
    }).length > 0;

  const at = answered.state === 'answered'
    ? answered.answerAt
    : (operatorSpokeLast ? busRelayPlan.commentAt(newest) : 0);
  const answerMinutes = at > 0 ? (NOW - at) / staleAnswer.MS_PER_MINUTE : NaN;

  const record = {
    ...base,
    commentsReadable: true,
    state: answered.state,
    operatorSpokeLast,
    answerMinutes,
  };

  // Only spend the extra request on a ticket that is ALREADY past the
  // threshold — the delivery answer only ever changes which sentence the
  // finding prints, and a fresh ticket has no finding to be specific about.
  if (answered.state === 'answered' && Number.isFinite(answerMinutes)
      && answerMinutes > STALE_AFTER_MINUTES) {
    let markers = null;
    try { markers = await readAnswerMarkers(answered.answer.id); } catch { markers = null; }
    // null stays null: unknown delivery falls through to the general
    // "the hand-back is failing" finding rather than blaming the party line.
    if (markers && markers.delivered === false) record.delivered = false;
    // ...and an answer a hand-back already completed on means this ticket was
    // parked here again on purpose. The relay reads the same marker and will
    // not move it either, so a finding would fire every six hours about a
    // deliberate act. Quiet, through the one state both halves agree on.
    if (markers && markers.handbackDone === true) record.state = 'handled';
  }

  records.push(record);
}

const { findings, fresh } = staleAnswer.answerFindings(records, {
  staleAfterMinutes: STALE_AFTER_MINUTES,
});

console.log(staleAnswer.renderReport({
  findings, fresh, staleAfterMinutes: STALE_AFTER_MINUTES, stageCount: parked.length,
}));

// What this pass COST, in the units ClickUp throttles on — the same closing
// line the relay, reconcile and stale-ready all print. It matters here because
// the whole incident behind this check was a pass running out of that budget.
console.log('');
console.log(`Tracker reads this pass: ${tracker.requestsMade()} door command(s)`);

const code = staleAnswer.exitCodeFor(findings);

if (!CHECK) process.exit(code);

// A ticket that is no longer stuck loses its stamps — including one that has
// left `Needs your input` entirely, which is the normal healthy ending and the
// case the first cut of this missed. The next time it sticks it is announced
// at once rather than swallowed by a window an earlier finding opened.
const stuckIds = findings.map((f) => String(f.taskId));
clearStampsExcept(stuckIds);

if (!findings.length) process.exit(code);

const paused = pipelinePaused();
if (paused.paused) {
  console.log('');
  console.log(`Not posting: ${paused.why}`);
  console.log('Dane has the deck, so this stays quiet. The findings above still stand.');
  process.exit(code);
}

const { due, held } = staleAnswer.duePosts({
  findings,
  stamps: readStamps(),
  now: NOW,
  everyMs: heartbeat.REPOST_EVERY_MS,
});

if (held.length) {
  console.log('');
  console.log(`${held.length} finding(s) already reported within the last `
    + `${Math.round(heartbeat.REPOST_EVERY_MS / 3600000)}h — not posting those again.`);
}

if (!due.length) process.exit(code);

const text = staleAnswer.renderStalePost({
  findings: due,
  node: NODE.name || 'an unnamed machine',
  staleAfterMinutes: STALE_AFTER_MINUTES,
});

if (DRY) {
  console.log('');
  console.log('--dry-run — this is what would go to the bus, and nothing was sent:');
  console.log('');
  console.log(text);
  process.exit(code);
}

try {
  clickup.postBusMessage(text);
  for (const f of due) {
    // Posted but not stamped: the next pass posts a duplicate. Noisy, and far
    // better than an unwritable folder silencing the alarm outright — the same
    // trade every other watchdog here makes.
    const why = writeStamp(staleAnswer.postKey(f), new Date(NOW).toISOString());
    if (why) console.log(`Posted, but the suppression stamp for ${f.taskId} could not be written (${why}).`);
  }
  console.log('');
  console.log(`Posted ${due.length} finding(s) to the bus.`);
} catch (err) {
  console.log('');
  console.log(`Could NOT post to the bus (${String(err?.message || err).slice(0, 300)}).`);
  console.log('Not stamping it as sent, so the next pass tries again.');
}

process.exit(code);
