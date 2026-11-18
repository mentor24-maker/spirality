#!/usr/bin/env node
/**
 * `npm run throughput` — is the queue getting shorter?
 *
 * Moved from StarCaster's scripts/loop_throughput.mjs (commit 0682572) for
 * SP-268, with its IO swapped for Spirality's door: the tickets come from
 * `npm run clickup -- tickets --json --include-closed`, the pull requests
 * from `gh pr list --repo <githubRepo>`, and a post goes through
 * `bus-post`, read back (scripts/lib/watchdogDoorCalls.mjs). The stamps live
 * in `<logDir>/<projectSlug>-watchdogs/`. Nothing here names a project.
 * scripts/run_relay.sh runs `--check` on every wake (scripts/lib/relay_queue_watchdogs.sh).
 *
 * The counterpart to `npm run heartbeat`. That one reports LIVENESS: did a job
 * stop firing? This one reports THROUGHPUT: the job fired, and did anything
 * come out the other end?
 *
 * A heartbeat structurally cannot answer the second question. On 2026-08-31
 * the build loop fired every hour, exited 0 every time, and the queue did not
 * move — 52 queued, 1 in review, the oldest rework PR sitting since Aug 25.
 * Every gate was green and every green was honest. Finding it took a morning
 * of reading logs by hand (ticket 86bbqrw3p).
 *
 *   npm run throughput                  read everything, print the report, write nothing
 *   npm run throughput -- --check       the same, and post to the bus on STALLED or UNKNOWN
 *   npm run throughput -- --check --dry-run   say what it WOULD post, send nothing
 *   npm run throughput -- --check --no-post   for a project with no bus (SP-386):
 *      read on the hourly limit and print the verdict, post nothing. Unlike
 *      --dry-run it keeps the hourly read stamp, so the relay's ten-minute
 *      wake still reads at most once an hour; it writes or clears no post stamp.
 *
 * Exit codes, because scripts branch on this:
 *   0  MOVING or IDLE — the pipeline is fine, or had nothing to do
 *   1  STALLED
 *   2  UNKNOWN — a reading needed for the verdict could not be taken. NEVER
 *      rendered as healthy
 *   3  a post to the bus did not land (Spirality's addition: a step that
 *      fails says so, CLAUDE.md rule 6). The lines above say which.
 *   4  the project config could not be read, so nothing was read or posted
 *      (kept apart from 2 so the relay names it as a failure, SP-268)
 *
 * UNKNOWN POSTS TOO, SINCE 2026-09-01 (task 86bbr2jpq). It did not, and that
 * was the quietest failure in the file: StarCaster's relay discarded this
 * exit code with `|| true`, so the one state whose entire purpose is "a
 * monitor must not fail quietly" reached nobody. A rotated token left the
 * stall detector permanently dead with every other job looking fine.
 *
 * The decisions live in lib/loopThroughput.js (pure, no network, fully tested).
 * This file is the IO: the tracker read, the `gh` read, the suppression stamp
 * and the bus post.
 *
 * WHERE IT RUNS. On the relay's wake (StarCaster ran it from its relay too).
 * Spirality runs every lane on one machine, so StarCaster's trick of reading
 * from the other machine's idle wake-up does not arise here.
 *
 * NOTHING HERE MAY FAIL THE JOB THAT CALLS IT. scripts/lib/relay_queue_watchdogs.sh
 * runs it under a time limit and never lets its exit change the relay's verdict.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { watchdogSettings, nodeName, readAllTickets, postToBus } from './lib/watchdogDoorCalls.mjs';

const require = createRequire(import.meta.url);
const throughput = require('../lib/loopThroughput.js');
const heartbeat = require('../lib/watchdogPosts.js');

let SETTINGS;
try {
  SETTINGS = watchdogSettings();
} catch (err) {
  console.error(`throughput: the project config could not be read (${String(err?.message || err)}). Nothing was read or posted.`);
  // 4, not 2: 2 is an UNKNOWN verdict, which the relay treats as a reading.
  // A watchdog that cannot start is a failure and must be named (rule 6).
  process.exit(4);
}
const STAMP_DIR = heartbeat.stampDir({ logDir: SETTINGS.logDir, slug: SETTINGS.slug });

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const arg = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const CHECK = flag('check');
const DRY = flag('dry-run');
// No bus to post to (SP-386): every post path behaves as a dry run, but the
// hourly READ stamp is still written (writeStamp only refuses under DRY), so
// the read limit holds. NOT_POSTING covers both, for every post-stamp path.
const NO_POST = flag('no-post');
const NOT_POSTING = DRY || NO_POST;
const NOT_POSTING_LINE = DRY
  ? '--dry-run — this is what would go to the bus, and nothing was sent:'
  : '--no-post — this project has no bus, so this was not sent anywhere:';
const DAYS = Number(arg('days', String(throughput.REPORT_DAYS))) || throughput.REPORT_DAYS;
const NOW = Date.now();
const NODE = { name: nodeName() };
// Name `npm run heartbeat` in a post only where this checkout has it (SP-266
// brings it); before that it would be a dead first step in an alarm.
const HAS_HEARTBEAT = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return Boolean(pkg && pkg.scripts && pkg.scripts.heartbeat);
  } catch { return false; }
})();
// A post that did not land: the pass still exits with its verdict's code
// unless this is set, and then exits 3 (see the exit codes above).
let POST_FAILED = false;
const exitWith = (code) => process.exit(POST_FAILED ? 3 : code);

const tty = process.stdout.isTTY;
const paint = (code, text) => (tty ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const yellow = (t) => paint('33', t);

// --- the two reads ----------------------------------------------------------

/**
 * Every ticket in the project's queue, FINISHED ONES INCLUDED.
 *
 * `--include-closed` is not optional here and its absence would be silent:
 * without it the door returns only the open work and the headline number —
 * tickets closed per day — is a confident zero on a week where 67 things
 * shipped. That is the same trap `stage-counts` documents. The door's objects
 * are turned into the shape lib/loopThroughput.js reads (`fromTicketsJson`).
 */
async function readQueue() {
  const read = readAllTickets();
  if (!read.rows) return { tasks: null, why: read.why };
  // An empty list is a reading: a new project's queue with nothing in it is
  // IDLE, not "could not take a reading" (SP-268, review round 1).
  return { tasks: throughput.fromTicketsJson(read.rows), why: null };
}

/**
 * Open pull requests, with the fields `wipCap.classifyPrs` needs.
 *
 * `body` is REQUIRED and its absence is silent too: that is how a PR is matched
 * to its ticket, and without it every PR falls into "no ticket found" and the
 * rework bucket reads empty. `createdAt` is this file's own addition — the
 * bucket comes from classifyPrs, the ages are looked up beside it.
 */
function readOpenPrs() {
  const out = spawnSync('gh', [
    'pr', 'list', '--repo', SETTINGS.githubRepo, '--state', 'open', '--limit', '200', '--json', 'number,state,body,createdAt',
  ], { encoding: 'utf8' });
  if (out.error) {
    const why = out.error.code === 'ENOENT'
      ? 'the `gh` command is not installed on this machine'
      : String(out.error.message);
    return { prs: null, why };
  }
  if (out.status !== 0) return { prs: null, why: String(out.stderr || '').trim().slice(0, 200) || 'gh failed' };
  try {
    const prs = JSON.parse(String(out.stdout || ''));
    return Array.isArray(prs) ? { prs, why: null } : { prs: null, why: 'gh returned something that is not a list' };
  } catch {
    return { prs: null, why: 'gh returned output that is not JSON' };
  }
}

// --- suppression ------------------------------------------------------------

/**
 * One post per 6 hours, cleared by the next non-stalled run — the same
 * discipline scripts/report_job_failure.mjs uses, and the stamp lives beside
 * its stamps (in STAMP_DIR) for the same reason: it is a fact about this MACHINE's posting,
 * not about the code, so it must not vanish when a worktree is removed.
 *
 * Cleared by a recovery rather than by a timer, so a stall that is fixed and
 * returns is announced again straight away instead of being swallowed by a
 * window the earlier stall opened.
 */
const stampFile = `${STAMP_DIR}/stalled-loop-queue.stamp`;

/**
 * The last time a reading was TAKEN, which is a different question from the
 * last time one was posted.
 *
 * The relay wakes every ten minutes. This check costs a full read of the
 * queue (in Spirality, one request per ticket for its status history) plus a
 * `gh pr list`, to watch a signal whose window is 24 HOURS. That is 144 times
 * more often than the thing it measures can meaningfully change.
 *
 * So `--check` takes a fresh reading at most once an hour. Still 24 readings a
 * day against a 24-hour window, which is ample, and a stall that is real at
 * 2pm is still real at 3pm. A hand-run `npm run throughput` is never throttled
 * — a person asking the question wants today's answer, not the last one.
 */
const readStampFile = `${STAMP_DIR}/throughput-read.stamp`;
const READ_EVERY_MS = 60 * 60 * 1000;

/**
 * One post per 6 hours for an UNKNOWN verdict, cleared by the next pass that
 * CAN take a reading — the same discipline the stall stamp above uses, and the
 * same folder, for the same reason.
 *
 * WHY THERE IS A SECOND STAMP RATHER THAN ONE SHARED ONE. A stall and a
 * cannot-read are different findings with different repairs, and they can
 * follow each other: the token is rotated on Monday (UNKNOWN), fixed on
 * Tuesday, and the queue turns out to have been stalled the whole time. One
 * stamp would swallow the second announcement inside the first one's window.
 *
 * AND WHY THERE IS ONE PER KIND OF UNKNOWN (2026-09-03, review round 2). That
 * argument does not stop at the stall boundary: the two UNKNOWNs are also
 * different findings with different repairs — one is "ClickUp is unreachable",
 * the other is "one ticket in Live needs a closure date filled in" — so a
 * single shared stamp let either one swallow the other for six hours. The
 * damaging direction is concrete rather than theoretical: 86bb4uyvp is a real
 * ticket that is never going to grow a closure date, so the undated post is
 * the one likely to fire first, and it could then silence "nothing is watching
 * whether the queue is getting shorter" — the most serious sentence in this
 * file. Keyed on `v.kind`, which `verdict` already returns.
 */
const UNKNOWN_KINDS = ['unreadable', 'undated-closure'];
const unknownStampFileFor = (kind) => `${STAMP_DIR}/unknown-${kind}-loop-queue.stamp`;

function readFileOrEmpty(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

function readStamp() {
  return readFileOrEmpty(stampFile);
}

// A dry run reads and prints, and writes nothing: no stamp is written or
// cleared (Spirality's addition, so a relay --dry-run leaves no trace).
function clearStamp() {
  if (NOT_POSTING) return;
  try { fs.rmSync(stampFile, { force: true }); } catch { /* nothing to clear */ }
}

function writeStamp(file, at) {
  if (DRY) return null;
  try {
    fs.mkdirSync(STAMP_DIR, { recursive: true });
    fs.writeFileSync(file, `${at}\n`);
    return null;
  } catch (err) {
    return String(err?.message || err);
  }
}

// Taken BEFORE either read, so a throttled pass costs nothing at all. `--force`
// is the escape hatch, and it is the flag a break test would reach for.
if (CHECK && !flag('force')
    && !throughput.dueAgain({ lastAt: readFileOrEmpty(readStampFile), now: NOW, everyMs: READ_EVERY_MS })) {
  console.log('Read within the last hour — not asking the tracker or GitHub again. '
    + '(`--force` takes a fresh reading; a hand-run `npm run throughput` is never throttled.)');
  process.exit(0);
}

// One definition of "tear this window up", so the two callers below cannot
// drift apart on what clearing a stamp means.
function clearUnknownStamp(kind) {
  if (NOT_POSTING) return;
  try { fs.rmSync(unknownStampFileFor(kind), { force: true }); } catch { /* nothing to clear */ }
}

// BOTH kinds clear together. The thing that clears an unknown is a pass that
// took a full, readable, non-unknown reading, and such a pass is evidence
// against either cause — leaving one behind would suppress an announcement the
// system is once again able to make.
//
// This is NOT the only place a window is torn up, and it must not become one:
// it sits below the UNKNOWN exit, so it is only ever reached by a pass that is
// neither unreadable nor otherwise unknown. The `unreadable` window clears
// earlier, on the read itself — see the note at that line.
function clearUnknownStamps() {
  for (const kind of UNKNOWN_KINDS) clearUnknownStamp(kind);
}

/**
 * An UNKNOWN verdict reaching the bus — the alarm this check did not have
 * until 2026-09-01 (task 86bbr2jpq, finding 1).
 *
 * `run_bus_relay.sh` guards this whole call with `|| true`, so exiting 2 told
 * nobody anything: a rotated token or a sustained rate limit left the stall
 * detector permanently dead while every other job on the board looked fine.
 * It printed UNKNOWN to a launchd log, which is honest and unread.
 *
 * KNOWN RESIDUAL, SAID OUT LOUD. When the cause IS ClickUp being unreachable,
 * this post travels the same wire that just failed, so it will very likely
 * fail too — the same residual `scripts/report_job_failure.mjs` documents, and
 * the same answer: the heartbeat notices the absence of success from the OTHER
 * machine, which is the only vantage point that survives this one. The post is
 * still worth attempting, because the other UNKNOWN — an undated closure
 * inside the window — happens while ClickUp is perfectly healthy.
 */
function announceUnknown(v, evidence = null) {
  if (!CHECK) return;
  const text = throughput.renderUnknownPost({
    verdict: v, now: NOW, node: NODE.name || 'an unnamed machine', evidence, hasHeartbeat: HAS_HEARTBEAT,
  });
  if (NOT_POSTING) {
    console.log('');
    console.log(NOT_POSTING_LINE);
    console.log('');
    console.log(text);
    return;
  }
  // Per KIND, so the other UNKNOWN is never swallowed by this one's window.
  const stampFileForThis = unknownStampFileFor(v.kind || 'unreadable');
  if (!throughput.dueAgain({
    lastAt: readFileOrEmpty(stampFileForThis), now: NOW, everyMs: heartbeat.REPOST_EVERY_MS,
  })) {
    console.log('');
    console.log(`Already reported as unknown (${v.kind || 'unreadable'}) within the last `
      + `${Math.round(heartbeat.REPOST_EVERY_MS / 3600000)}h — not posting again. `
      + '(The other kind of unknown has its own window and is unaffected.)');
    return;
  }
  const posted = postToBus(text);
  if (posted.ok) {
    const why = writeStamp(stampFileForThis, new Date(NOW).toISOString());
    if (why) console.log(`Posted, but the suppression stamp could not be written (${why}).`);
    console.log('');
    console.log('Posted to the bus.');
  } else {
    POST_FAILED = true;
    console.log('');
    console.log(red(`Could NOT post the unknown-reading alert to the bus `
      + `(${String(posted.why).slice(0, 300)}).`));
    console.log('Not stamping it as sent, so the next pass tries again.');
  }
}

// --- the pass ---------------------------------------------------------------

// THE HOURLY CLOCK RESTARTS ON THE ATTEMPT, NOT ON A SUCCESS (task 86bbr2jpq,
// finding 2). This used to be stamped after the reads had come back, so a
// ClickUp 429 skipped it — and the relay wakes every ten minutes, so a rate
// limit made the check hammer the very limit that broke it, six times an hour
// instead of once, keeping itself broken. Stamped here, a failed pass costs
// the same hour a successful one does.
if (CHECK) writeStamp(readStampFile, new Date(NOW).toISOString());

const queueRead = await readQueue();
const prRead = readOpenPrs();

if (!queueRead.tasks) {
  // No tickets, no verdict. Said out loud and exited 2 — never as "all quiet".
  const v = throughput.verdict({ unreadable: `the queue could not be read (${queueRead.why})` });
  console.log(`${yellow(v.state)}\n${v.why}`);
  announceUnknown(v);
  exitWith(v.exitCode);
}

// THE QUEUE WAS READ, SO THE OUTAGE IS OVER — and that is recorded HERE, above
// every exit below it, not at the bottom of the file (2026-09-03, review round
// 3). `clearUnknownStamps()` further down is only reached by a pass that is
// neither unreadable nor UNKNOWN. So a pass that read ClickUp perfectly and
// then landed on the `undated-closure` verdict exited without clearing the
// `unreadable` window — while its own bus post said, in as many words, "the
// reading itself SUCCEEDED". Reproduced: 9am outage posts and stamps; 10am
// reads fine and posts the undated alert; 11am outage is swallowed until 3pm.
// The sentence being silenced is the most serious one in this file — "nothing
// in the system is watching whether the queue is getting shorter."
//
// ONE DIRECTION ONLY, AND THE ASYMMETRY IS DELIBERATE — do not tidy it into a
// pair. The unreadable branch above must NOT clear the `undated-closure`
// window, because a pass that could not read the queue is evidence of nothing
// at all, least of all that a ticket in `Live` has grown a closure date.
// Reading the queue is direct evidence that the queue can be read; it is no
// evidence about anything else.
if (CHECK) clearUnknownStamp('unreadable');

// WORK ONLY — the standing noticeboards are not tickets (task 86bbwab1n).
// The lib readers exclude them for themselves, so this line is not what makes
// the counts right. It is here because two derivations BELOW never pass
// through the lib at all — `queueTouched` and `ticketStatusById` are computed
// from this array directly — and `queueTouched` is the one that matters: an
// alarm comment bumps the noticeboard's `date_updated`, so without this the
// answer to "was the Loop Queue touched in the last 24 hours?" could be yes
// on the strength of the watchdog writing to itself.
const tasks = throughput.workTickets(queueRead.tasks);
const queue = throughput.queueShape(tasks);
const closed = throughput.closedPerDay({ tasks, now: NOW, days: DAYS });
const closedLast24h = throughput.closedSince({ tasks, now: NOW });
const curve = throughput.depthPerDay({ tasks, now: NOW, days: DAYS });
const plateau = throughput.depthPlateau(curve);
// A FACT for the reader, not an input to any rule — `sinceLastClose` says why.
const lastClose = throughput.sinceLastClose({ tasks, now: NOW });
const trend = throughput.depthTrend(curve);

// The rework bucket, from classifyPrs. An unreadable `gh` is NOT fatal: the
// stall verdict does not depend on it, and refusing to report a stall because
// GitHub was briefly unreachable would be this feature failing in the exact
// direction it exists to prevent.
const ticketStatusById = Object.create(null);
for (const t of tasks) ticketStatusById[String(t.id)] = t.status?.status ?? '';
const rework = prRead.prs
  ? throughput.reworkPrs({ prs: prRead.prs, ticketStatusById, now: NOW })
  : { rows: [], oldest: null, groups: null };

/**
 * WAS ANYTHING IN THE LOOP QUEUE EDITED INSIDE THE WINDOW? A plain fact about
 * the list, and the verdict is told only that.
 *
 * THIS USED TO BE CALLED `loopsFiring` AND IT CLAIMED TOO MUCH (2026-09-01,
 * task 86bbr2jpq, finding 3). The evidence is `date_updated`, which ClickUp
 * bumps on ANY edit — a comment from Dane, a relay note, a priority change —
 * so "a ticket touched inside the window proves a pass ran", which is what the
 * old docstring said, is simply not true. It sent the reader hunting a
 * pipeline bug in the case where the loop lanes were not running at all, and
 * that case is arguably the likeliest cause of a stall, because the lanes live
 * inside long-lived agent sessions that somebody has to open.
 *
 * Naming it after the evidence makes `false` answerable, which the old
 * question never was: "no loop pass ran" could not be concluded from silence
 * (a pass that finds the WIP cap full writes nothing), but "nothing edited the
 * Loop Queue for 24 hours" is exactly what an empty list of recent updates
 * shows. `null` is kept for the case where no ticket carries a readable
 * timestamp at all — a shape ClickUp should never return, and not one to
 * report as a confident `false`.
 */
const withTimestamps = tasks.filter((t) => throughput.updatedAt(t) !== null);
const queueTouched = withTimestamps.length
  ? withTimestamps.some((t) => throughput.updatedAt(t) > NOW - throughput.STALL_WINDOW_MS)
  : null;

// A finished ticket carrying no closure date is invisible to `closedSince`, so
// one edited inside the window could be a closure this run cannot see. It
// makes the verdict UNKNOWN rather than STALLED — see `recentUndatedClosures`.
const undated = throughput.undatedClosures(tasks);
const undatedRecent = throughput.recentUndatedClosures({ tasks, now: NOW });
// The ids as well as the count. The repair for that verdict is "give this
// ticket a closure date", and a message that says so without naming which
// ticket sends the reader to read a whole column by hand (2026-09-02, review
// round 1).
const undatedRecentIds = throughput
  .recentUndatedClosureTasks({ tasks, now: NOW })
  .map((t) => String(t?.id ?? '')).filter(Boolean);

const v = throughput.verdict({
  closedLast24h, queue, queueTouched, trend, lastClose, undatedRecent, hasHeartbeat: HAS_HEARTBEAT,
});

const colour = v.state === 'STALLED' ? red : v.state === 'UNKNOWN' ? yellow : green;
console.log(throughput.renderReport({
  verdict: { ...v, state: colour(v.state) }, closed, curve, plateau, rework, queue, now: NOW, lastClose, trend,
  undated,
}));

if (prRead.why) {
  console.log('');
  console.log(yellow(`Rework pull requests could NOT be read (${prRead.why}) — that section is missing, not empty.`));
}

// --- the alert --------------------------------------------------------------

if (!CHECK) exitWith(v.exitCode);

// A READING THAT COULD NOT BE TAKEN IS ITSELF THE ALARM. The queue read
// succeeded here, so this is the other UNKNOWN: an undated closure inside the
// window, which means the zero the stall rests on cannot be trusted. It is
// neither a stall nor health, and — see below — it is not a recovery either.
if (v.state === 'UNKNOWN') {
  // THE STALL SUPPRESSION IS LEFT EXACTLY AS IT WAS — neither cleared nor
  // refreshed — and that is the deliberate answer to a disagreement between
  // these two paths (2026-09-03, review round 2). This branch used to call
  // `clearStamp()`; the unreadable-queue branch above never has, because it
  // exits before reaching here. So the same verdict state meant two different
  // things about the stall alarm depending on which cause produced it.
  //
  // "Could not tell" is not a recovery, so clearing is the wrong half to make
  // them agree on. Clearing let a stall re-announce inside its own six-hour
  // window: a real stall posts and stamps, an edit to an undated `Live` ticket
  // flips the next pass to UNKNOWN and wipes the stamp, the ticket is then
  // given a date or moved, the verdict returns to STALLED, and the identical
  // alert posts again. Only a reading that is BOTH complete and not stalled is
  // evidence the stall ended, and that reading clears the stamp further down.
  //
  // The cost of this direction is a stall alert deferred to the end of its
  // original window rather than re-posted — no alarm is lost, because the
  // stamp expires on its own after six hours.
  //
  // WITH THE STALL EVIDENCE, because `verdict` returns UNKNOWN before it can
  // reach STALLED — so a genuine stall coinciding with one recently-edited
  // undated closure comes out of THIS branch, and used to arrive with none of
  // the numbers that make an alert worth acting on (2026-09-02, review round
  // 1, finding 2). A stall is still the likelier reading here.
  announceUnknown(v, {
    closed, plateau, rework, queue, undated,
    reworkUnreadable: prRead.why, undatedIds: undatedRecentIds,
  });
  exitWith(v.exitCode);
}

// A reading WAS taken, so an earlier unknown has cleared — the next one is
// announced at once rather than being swallowed by that window. Both kinds,
// because this pass is evidence against both causes.
clearUnknownStamps();

if (!v.stalled) {
  // A recovery clears the suppression, so the next stall is announced at once.
  clearStamp();
  exitWith(v.exitCode);
}

const text = throughput.renderStallPost({
  verdict: v, closed, plateau, rework, queue, now: NOW, lastClose, undated,
  reworkUnreadable: prRead.why, node: NODE.name || 'an unnamed machine', hasHeartbeat: HAS_HEARTBEAT,
});

if (NOT_POSTING) {
  console.log('');
  console.log(NOT_POSTING_LINE);
  console.log('');
  console.log(text);
  exitWith(v.exitCode);
}

if (!throughput.dueAgain({ lastAt: readStamp(), now: NOW, everyMs: heartbeat.REPOST_EVERY_MS })) {
  console.log('');
  console.log(`Already reported within the last ${Math.round(heartbeat.REPOST_EVERY_MS / 3600000)}h — not posting again.`);
  exitWith(v.exitCode);
}

const posted = postToBus(text);
if (posted.ok) {
  // Posted but not stamped: the next stall inside the window posts a duplicate.
  // Noisy, and far better than an unwritable folder silencing the alarm
  // outright — the same trade report_job_failure.mjs makes.
  const why = writeStamp(stampFile, new Date(NOW).toISOString());
  if (why) console.log(`Posted, but the suppression stamp could not be written (${why}).`);
  console.log('');
  console.log('Posted to the bus.');
} else {
  POST_FAILED = true;
  console.log('');
  console.log(red(`Could NOT post to the bus (${String(posted.why).slice(0, 300)}).`));
  console.log('Not stamping it as sent, so the next pass tries again.');
}

exitWith(v.exitCode);
