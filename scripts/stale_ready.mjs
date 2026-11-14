#!/usr/bin/env node
/**
 * `npm run stale-ready` — a ticket stuck in `Ready to launch`, and WHOSE hands
 * it actually needs.
 *
 * The third watchdog, and it answers a question the other two structurally
 * cannot. `npm run heartbeat` asks "did a job stop firing?". `npm run
 * throughput` asks "the job fired, and did anything come out?". Both are about
 * the machines. This one is about a single stage that has no owner at all:
 * `Ready to launch` is operator-held, the loops never touch it on purpose, and
 * the merge step re-declines a red PR forever without ever escalating.
 *
 * 86bbkw1mn sat there for six days with Dane's approval already given, blocked
 * on one failing test out of 1,846. PR #444 the day before was the same shape.
 * The full story, and the reason the ACTOR matters more than the alarm, is in
 * lib/staleReady.js.
 *
 *   npm run stale-ready                        read everything, print the report, write nothing
 *   npm run stale-ready -- --check             the same, and post to the bus if anything is stuck
 *   npm run stale-ready -- --check --dry-run   say what it WOULD post, send nothing
 *   npm run stale-ready -- --force             ignore the hourly read throttle
 *
 * TWO CLOCKS (2026-09-02, task 86bbtqytq). A ticket sitting untouched in
 * `Ready to launch` has 24 hours. A ticket carrying Dane's own `merge` comment
 * has TWO, measured from that comment rather than from ticket age — he has
 * stated an expectation, and 86bbqw49y sat 12 hours past one while this check
 * honestly reported "nothing is stuck". `lib/staleReady.js` carries the rule
 * and the reasoning; the overrides are `--stale-after-hours` and
 * `--approved-after-hours`, and the relay passes neither.
 *
 * Exit codes, because scripts branch on this:
 *   0  nothing is stuck
 *   1  at least one ticket is stuck — whoever it turns out to be on
 *   2  CANNOT TELL: a reading the verdict needed could not be taken. NEVER
 *      rendered as healthy (docs/DOCTRINE.md 3.11)
 *
 * WHERE IT RUNS, AND WHY THAT WAS A DECISION.
 *
 * scripts/run_bus_relay.sh calls this BEFORE it asks whether it owns the
 * relay, alongside the heartbeat and throughput checks — but NOT by inheriting
 * their reasoning, which does not apply here. Theirs is "a watchdog that runs
 * only where its job runs cannot notice that machine being switched off". This
 * check watches ClickUp and GitHub, not a machine, so that argument is not
 * available to it.
 *
 * The reason it belongs there anyway is row 2 of its own table: *approved,
 * green, and still not merged* is precisely what a dead merge step looks like.
 * A check that only ran where the loops run could not see the case where the
 * loops are not running at all — the same blind spot in a different costume.
 * The non-owning machine's idle wake is the vantage point that survives that,
 * so it is where the reading is taken.
 *
 * KNOWN RESIDUAL, STATED RATHER THAN DISCOVERED: the suppression stamps are
 * local to each machine, so once BOTH machines carry the relay schedule the
 * same finding can be posted twice. That is the residual the heartbeat and
 * throughput checks already carry in the same position, and a duplicate on the
 * bus is a far cheaper failure than a silence. Today only the Mini has the
 * schedule installed, so it cannot happen yet.
 *
 * NOTHING HERE MAY FAIL THE JOB THAT CALLS IT. run_bus_relay.sh guards the
 * call with `|| true`, exactly as it does its two neighbours'.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const staleReady = require('../lib/staleReady.js');
const heartbeat = require('../lib/nodeHeartbeat.js');
const nodeRoles = require('../lib/nodeRoles.js');
const clickup = require('./lib/clickup.cjs');
// Tickets and comments from the tracker, through the ticket door (SC-794). Dane's
// seat is the TRACKER's operator id from spirality.project.json, not the old
// ClickUp id: a ClickUp id matches no comment on the tracker, so every answer
// would have read as a machine's.
const tracker = require('./lib/trackerDoor.cjs');
const { findPullRequest, mergeDecision, checkState } = require('./builder/mergeOnComment.js');

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
 * The threshold, overridable ONLY on the command line.
 *
 * It exists so the one claim this feature cannot make from a unit test can be
 * made at all: *it actually fires*. Both reasons the pulse never caught this
 * were "the logic existed and was never reached", and a green test suite is
 * not evidence that a scheduled check runs — so the DoD asks for a real ticket,
 * a real red PR and a real post. Waiting 24 hours for one is not a rehearsal
 * anybody will repeat, and a rehearsal nobody repeats is one that rots.
 *
 * The relay never passes it (`scripts/run_bus_relay.sh` calls `--check` and
 * nothing else), so the shipped threshold is still the pulse's single one.
 */
const STALE_AFTER_HOURS = Number(arg('stale-after-hours', String(staleReady.STALE_AFTER_HOURS)));
if (!Number.isFinite(STALE_AFTER_HOURS) || STALE_AFTER_HOURS < 0) {
  console.log(`--stale-after-hours must be a number of hours, not "${arg('stale-after-hours')}".`);
  process.exit(2);
}
/**
 * The SHORT fuse, same override and same reason as the one above: the claim a
 * unit test cannot make is "it actually fires against the live board", and
 * sitting for two hours to rehearse it is a rehearsal nobody repeats.
 * `run_bus_relay.sh` passes neither flag, so the shipped numbers are the two
 * derived ones.
 */
const APPROVED_AFTER_HOURS = Number(
  arg('approved-after-hours', String(staleReady.APPROVED_STALE_AFTER_HOURS)),
);
if (!Number.isFinite(APPROVED_AFTER_HOURS) || APPROVED_AFTER_HOURS < 0) {
  console.log(`--approved-after-hours must be a number of hours, not "${arg('approved-after-hours')}".`);
  process.exit(2);
}
const NOW = Date.now();
const NODE = nodeRoles.thisNode();

// --- suppression ------------------------------------------------------------

/**
 * One stamp per ticket PER REASON, beside the heartbeat's and the throughput
 * check's, for the same reason they live there: a stamp records what THIS
 * MACHINE has said, which is a fact about the machine and not about the code,
 * so it must survive a worktree being removed.
 *
 * Keying on the reason rather than on the ticket alone is what makes
 * red -> green -> red announce twice. A window keyed on the ticket would
 * swallow the second red, and a fault that returns must be announced again.
 */
const STAMP_DIR = `${heartbeat.heartbeatDir()}/ready-stale`;
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
 * Clear every stamp for a ticket that is no longer stuck, or no longer in the
 * stage at all. A stamp that is never cleared is an alarm that fires once and
 * then goes quiet forever — the exact failure the suppression design exists to
 * avoid, arriving through the thing meant to prevent noise.
 *
 * The stamp key is `<taskId>:<reasonKey>`, and the filename sanitiser leaves
 * both the id and the colon alone, so splitting on the first colon recovers
 * the ticket. `stampKeyTaskId` is shared with the module that builds the key
 * so the two can never drift apart.
 */
function clearStampsFor(taskIds) {
  const ids = new Set((taskIds || []).map(String));
  if (!ids.size) return;
  let entries = [];
  try { entries = fs.readdirSync(STAMP_DIR); } catch { return; }
  for (const file of entries) {
    const id = staleReady.stampKeyTaskId(file.replace(/\.stamp$/, ''));
    if (!ids.has(id)) continue;
    try { fs.rmSync(path.join(STAMP_DIR, file), { force: true }); } catch { /* nothing to clear */ }
  }
}

/**
 * The last time a READING was taken, which is a different question from the
 * last time one was posted — the same throttle `npm run throughput` uses, and
 * for the same arithmetic. run_bus_relay.sh wakes every ten minutes; this
 * check costs a Loop Queue read plus a comment page and a `gh pr view` per
 * stale ticket, to watch a signal whose window is 24 HOURS. Once an hour is 24
 * readings against that window, which is ample. A hand-run
 * `npm run stale-ready` is never throttled — a person asking the question
 * wants today's answer, not the last one.
 */
const READ_STAMP_FILE = `${heartbeat.heartbeatDir()}/ready-stale-read.stamp`;
const READ_EVERY_MS = 60 * 60 * 1000;

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

function gh(args) {
  const out = spawnSync('gh', args, { encoding: 'utf8' });
  if (out.error) {
    const why = out.error.code === 'ENOENT'
      ? 'the `gh` command is not installed on this machine'
      : String(out.error.message);
    return { json: null, why };
  }
  if (out.status !== 0) {
    return { json: null, why: String(out.stderr || '').trim().split('\n')[0].slice(0, 160) || 'gh failed' };
  }
  try { return { json: JSON.parse(String(out.stdout || '')), why: null }; }
  catch { return { json: null, why: 'gh returned output that is not JSON' }; }
}

/** One PR's state and every check on it. `null` means "could not tell", which
 *  the classifier turns into CANNOT TELL rather than into an answer. */
function prSnapshot(number) {
  const out = gh(['pr', 'view', String(number), '--json', 'state,statusCheckRollup']);
  if (!out.json) return { state: null, checks: null, why: out.why };
  return {
    state: String(out.json.state || '').toUpperCase() || null,
    checks: checkState(out.json.statusCheckRollup),
    why: null,
  };
}

/** Every comment on a ticket, as OBJECTS — findPullRequest and mergeDecision
 *  both need the id, date and author, which getTaskComments() drops. An
 *  incomplete read returns null: half a trail that looks whole is how a reader
 *  concludes something never happened. */
async function readComments(taskId) {
  return tracker.readComments(taskId);
}

// --- the pipeline switch ----------------------------------------------------

/**
 * Has Dane taken the deck? Every actor asks, this one included — a watchdog
 * shouting on the bus while he is working through something by hand is exactly
 * the collision the switch exists to prevent.
 *
 * Asked by RUNNING the one implementation rather than reading the switch a
 * second way here: two readers of a safety flag are two flags, and they
 * disagree quietly. Checked before POSTING rather than before reading, because
 * a read writes nothing and the printed report is useful either way.
 *
 * Fails safe in the same direction the switch itself does: if it cannot be
 * asked at all, treat it as paused and stay quiet.
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
  console.log('Read within the last hour — not asking the tracker or GitHub again. '
    + '(`--force` takes a fresh reading; a hand-run `npm run stale-ready` is never throttled.)');
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
  console.log('Nothing about Ready to launch is known this pass. This is not an all-clear.');
  process.exit(2);
}

// The reading happened, so the hourly clock restarts here whatever the verdict
// turns out to be. Stamping only on a healthy verdict would make a stuck
// ticket re-read every ten minutes, which is the load this guards against.
if (CHECK) writeReadStamp(new Date(NOW).toISOString());

const ready = tasks.filter(
  (t) => String(t?.status?.status || '').trim().toLowerCase() === staleReady.READY_STAGE,
);

const records = [];
for (const task of ready) {
  const id = String(task.id);
  const updated = Number(task.date_updated);
  const base = {
    taskId: id,
    name: task.name,
    url: task.url || tracker.ticketUrl(id),
    hours: Number.isFinite(updated) && updated > 0
      ? (NOW - updated) / staleReady.MS_PER_HOUR
      : NaN,
  };

  // THE COMMENTS ARE READ FOR EVERY TICKET IN THE STAGE NOW, not only the ones
  // already past 24h (task 86bbtqytq). The short fuse cannot be applied
  // without knowing whether he has said "merge", and that lives nowhere but
  // the comment trail — a ticket skipped as "only 12 hours old" is precisely
  // the ticket this pass exists to catch.
  //
  // WHAT IT COSTS, MEASURED RATHER THAN ASSUMED: one comment page per ticket
  // in `Ready to launch`, once an hour (the read throttle above). The stage
  // holds a handful of tickets by design — it is the one stage a human drains
  // by hand — so this is single digits of requests per reading against
  // ClickUp's ~100/minute. The figure and the method are in the ticket's
  // closing note.
  let comments = null;
  try { comments = await readComments(id); } catch { comments = null; }

  if (!comments) {
    // Unreadable at ANY age now, not just past the threshold. "He may have
    // approved this and I cannot see it" is a real gap in the stage that
    // matters most, and DOCTRINE 3.11 says a sweep reports what it could not
    // check rather than folding it into clean.
    records.push({ ...base, commentsReadable: false });
    continue;
  }

  const approvedAt = staleReady.liveApprovalAt(comments, { operatorId: OPERATOR_ID });
  if (approvedAt > 0) base.approvedHours = (NOW - approvedAt) / staleReady.MS_PER_HOUR;

  // Which clock this ticket is on, asked ONCE, from the module that owns the
  // rule. Under its own threshold there is nothing more to read: the GitHub
  // calls below are what make a finding specific, and a fresh ticket has no
  // finding to be specific about.
  const clock = staleReady.stalenessClock(base);
  if (!Number.isFinite(clock.hours) || clock.hours <= clock.thresholdHours) {
    records.push({ ...base, commentsReadable: true });
    continue;
  }

  const pr = findPullRequest(comments);
  if (!pr) { records.push({ ...base, commentsReadable: true, pr: null }); continue; }

  const snap = prSnapshot(pr.number);
  const decision = mergeDecision({ status: task.status?.status, comments, operatorId: OPERATOR_ID });

  records.push({
    ...base,
    commentsReadable: true,
    pr: { number: pr.number, url: pr.url },
    prReadable: Boolean(snap.state),
    prReadError: snap.why,
    prState: snap.state,
    checks: snap.checks,
    // 'merge' means the authorization is live and valid. 'refuse' means the
    // word is there and the merge step will not act on it — from Dane's side
    // he has spoken either way, and naming the reason is the classifier's job.
    mergeWordGiven: decision.act === 'merge' || decision.act === 'refuse',
  });
}

const { findings, fresh, unmeasured } = staleReady.readyFindings(records, {
  staleAfterHours: STALE_AFTER_HOURS,
  approvedAfterHours: APPROVED_AFTER_HOURS,
});

console.log(staleReady.renderReport({
  findings, fresh, unmeasured, readyCount: ready.length,
  staleAfterHours: STALE_AFTER_HOURS, approvedAfterHours: APPROVED_AFTER_HOURS,
}));

// What this pass COST, in the units ClickUp throttles on — the same closing
// line reconcile and the relay print. It is here because the short fuse made
// this check read a comment page for EVERY ticket in the stage rather than
// only the stale ones, and "how much did that add" must be answerable by
// looking rather than by arithmetic: the relay's own passes were measured at
// 108-114 requests on 2026-09-03 and are already retrying against ClickUp's
// ~100/minute window (tasks 86bbugbay, 86bbuebkb).
console.log('');
console.log(`Tracker reads this pass: ${tracker.requestsMade()} door command(s)`);

const code = staleReady.exitCodeFor(findings);

if (!CHECK) process.exit(code);

// A ticket that is no longer stuck loses its stamps, so the next time it does
// stick it is announced at once rather than swallowed by a window an earlier
// finding opened.
const stuckIds = new Set(findings.map((f) => String(f.taskId)));
clearStampsFor(ready.map((t) => String(t.id)).filter((id) => !stuckIds.has(id)));

if (!findings.length) process.exit(code);

const paused = pipelinePaused();
if (paused.paused) {
  console.log('');
  console.log(`Not posting: ${paused.why}`);
  console.log('Dane has the deck, so this stays quiet. The findings above still stand.');
  process.exit(code);
}

const { due, held } = staleReady.duePosts({
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

const text = staleReady.renderStalePost({
  findings: due, node: NODE.name || 'an unnamed machine',
  staleAfterHours: STALE_AFTER_HOURS, approvedAfterHours: APPROVED_AFTER_HOURS,
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
    // trade report_job_failure.mjs and the throughput check both make.
    const why = writeStamp(staleReady.postKey(f), new Date(NOW).toISOString());
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
