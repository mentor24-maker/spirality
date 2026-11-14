'use strict';

/**
 * The heartbeat: making a lane that has stopped running audible (SP-266).
 *
 * Moved from StarCaster's lib/nodeHeartbeat.js (commit 0682572, its "recency
 * alarm" half) with the parts that only exist for StarCaster's several
 * machines left out: the shared roll call on a ClickUp task, the machine
 * names from lib/nodeRoles.js, the once-a-day push and the stand-down,
 * blocked and timed-out beat kinds that StarCaster's runner writes into its
 * beat stamps. Every Spirality lane runs on the Mini, so there is one machine
 * and its own lane logs are the beat: nothing extra is written by the lanes.
 *
 * WHY THIS EXISTS (StarCaster, NODES Slice E). A job that FAILS at least
 * writes a log line. A job that never fires writes nothing at all, and
 * nothing is indistinguishable from a quiet week. The Mini works overnight
 * with nobody watching; its schedule can be unloaded, its launchd job evicted
 * after an OS update, and every one of those looks exactly like "no news".
 * On 2026-09-03 StarCaster's merge lane was dead for sixteen hours while every
 * other surface said nothing or said something reassuring.
 *
 * THE BEAT IS THE LANE'S OWN LOG. Every line a runner writes with a full date
 * (`===== <date> START /<lane>`, `END`, and the `SKIP` line a runner writes
 * when its work check found nothing to do, SP-292) is a beat: the runner was
 * alive at that instant. A pass that started and has not ended is alive until
 * its own time limit (the runner kills it there), so a two-hour build pass is
 * not mistaken for a dead lane. A paused lane writes no dated line, so the
 * caller asks the Settings page and never judges a paused lane.
 *
 * FOUR ANSWERS, NEVER TWO (StarCaster docs/DOCTRINE.md §3.11): quiet, fresh,
 * unknown (no log, an unreadable log, a date in the future) and, decided by
 * the caller, paused. Nothing unmeasurable is ever reported as running.
 *
 * NOTHING HERE TOUCHES THE NETWORK OR THE DISK. Every decision is a pure
 * function over data the caller read, so `node --test` drives every branch.
 * The IO lives in scripts/heartbeat.mjs. No project, label or folder is named
 * here (CLAUDE.md engineering rule 2): lanes and intervals are passed in.
 */

/**
 * ONE rule for every lane, rather than a column of hand-picked numbers: six
 * missed runs, and never tighter than three hours. StarCaster measured it on
 * the Mini's own logs over 14 days (2026-09-04): a one-hour threshold sat on
 * the p90 beat-to-beat gap of two lanes and would have fired on roughly one
 * interval in ten for jobs that were working perfectly; the three-hour floor
 * is what protects a fast job like the relay, whose six missed passes are one
 * hour.
 */
const QUIET_AFTER_MISSES = 6;
const MIN_QUIET_AFTER_MS = 3 * 60 * 60 * 1000;

/**
 * One post per lane per 6 hours while it stays quiet (the ticket's limit,
 * StarCaster's flapping throttle). A dead lane is said again four times a day,
 * never every ten-minute relay wake.
 */
const REPOST_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * How long this lane may go without a beat before it counts as quiet, or null
 * if the lane has no declared cadence (which is not the same as "fine": the
 * caller reports it as something it could not judge).
 */
function quietAfterFor(lane, emitters = {}) {
  const entry = emitters[String(lane || '').trim().toLowerCase()];
  if (!entry || !Number.isFinite(entry.intervalMs) || entry.intervalMs <= 0) return null;
  return Math.max(entry.intervalMs * QUIET_AFTER_MISSES, MIN_QUIET_AFTER_MS);
}

/** Whole-hours-and-minutes age, for a human reading a table. */
function ageText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'in the future (check the clocks)';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m ago`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
}

/** The same, without "ago", for a window or a duration. */
function durationText(ms) {
  return ageText(ms).replace(/ ago$/, '');
}

/** Has enough time passed since the last post of this kind? A missing or unreadable stamp posts. */
function dueAgain({ lastAt, now = Date.now(), everyMs }) {
  if (!lastAt) return true;
  const then = Date.parse(lastAt);
  if (!Number.isFinite(then)) return true;
  return now - then >= everyMs;
}

// --- reading a lane's log -----------------------------------------------------

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// The runners write "YYYY-MM-DD HH:MM:SS" in the machine's own time.
function localTime(stamp) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(stamp);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

/**
 * The newest beat in a lane's log text: `{ found, at, running, startedAt }`.
 *
 * `at` is the newest dated START, END or SKIP line for this lane; `running`
 * is true when the newest START has no END after it. A running pass counts as
 * alive until `passLimitMs` after it started (the runner stops it there), so
 * `at` is moved forward to that instant, never past `now`. `found: false`
 * means the log holds no dated line for this lane at all.
 */
function lastBeatFromLog(text, lane, { now = Date.now(), passLimitMs = 0 } = {}) {
  const marker = lane === 'relay' ? 'relay' : `/${lane}`;
  const line = new RegExp(`^===== (\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}) (START|END|SKIP) ${escapeRe(marker)}(?: |=|$)`);
  let at = null;
  let startedAt = null;
  let running = false;
  for (const raw of String(text || '').split('\n')) {
    const m = line.exec(raw);
    if (!m) continue;
    const when = localTime(m[1]);
    if (!when) continue;
    if (!at || when.getTime() >= at.getTime()) at = when;
    if (m[2] === 'START') { startedAt = when; running = true; } else if (m[2] === 'END') running = false;
  }
  if (!at) return { found: false };
  let aliveAt = at.getTime();
  if (running && startedAt && Number.isFinite(passLimitMs) && passLimitMs > 0) {
    aliveAt = Math.max(aliveAt, Math.min(now, startedAt.getTime() + passLimitMs));
  }
  return {
    found: true,
    at: new Date(aliveAt).toISOString(),
    lastLineAt: at.toISOString(),
    running,
    startedAt: running && startedAt ? startedAt.toISOString() : null,
  };
}

// --- the verdict -------------------------------------------------------------

/**
 * "Is any lane not beating?" Entries are `{ role, beat }`, where `beat` is
 * `{ readable, found, why?, beat: { at } }` (the shape StarCaster's
 * `readBeat()` returned, so the moved tests read as they did); `emitters` is
 * `{ <lane>: { intervalMs, beatMeans } }`. Returns `{ quiet, fresh, unknown,
 * silent }`.
 */
function recencyReport({ entries = [], now = Date.now(), emitters = {} } = {}) {
  const quiet = [];
  const fresh = [];
  const unknown = [];

  for (const entry of entries) {
    const role = String((entry && entry.role) || '').trim().toLowerCase();
    const beat = (entry && entry.beat) || {};
    const thresholdMs = quietAfterFor(role, emitters);
    const beatMeans = (emitters[role] && emitters[role].beatMeans) || 'liveness';

    if (thresholdMs === null) {
      unknown.push({ role, why: 'no run interval is known for this lane, so there is no threshold to judge it against' });
      continue;
    }
    if (!beat.readable) {
      unknown.push({ role, why: `its log could not be read: ${beat.why || 'no reason given'}` });
      continue;
    }
    if (!beat.found) {
      unknown.push({ role, why: beat.why || 'its log has no pass in it yet, so there is nothing to judge' });
      continue;
    }
    const at = beat.beat && beat.beat.at;
    const ageMs = now - Date.parse(at);
    if (!Number.isFinite(ageMs)) {
      unknown.push({ role, why: `its last pass is recorded as "${at}", which cannot be read as a date` });
      continue;
    }
    // A beat from the FUTURE is a clock problem, not a healthy lane. Calling it
    // fresh would silence this lane for as long as the skew lasts.
    if (ageMs < 0) {
      unknown.push({ role, why: `its last pass is dated ${at}, which is in the future: check the clock on this machine` });
      continue;
    }
    // The declared cadence, NOT the threshold divided back down: the relay's
    // threshold is FLOORED at three hours, so dividing it by the miss count
    // says "expected about every 30m" about a job that runs every ten minutes.
    const intervalMs = emitters[role].intervalMs;
    const common = { role, at, ageMs, thresholdMs, intervalMs, beatMeans };
    if (ageMs > thresholdMs) {
      quiet.push({
        ...common,
        reason: `${beatMeans === 'liveness' ? 'last ran' : 'last succeeded'} ${ageText(ageMs)}, `
          + `and this lane is expected about every ${durationText(intervalMs)}`,
      });
    } else {
      fresh.push(common);
    }
  }

  return { quiet, fresh, unknown, silent: quiet.length > 0 };
}

// --- what goes on the bus ------------------------------------------------------

/**
 * The alarm for lanes that have gone quiet. It starts `ALARM:`, so the tracker
 * texts it (SP-163). `when(iso)` renders an instant for a person (Mountain
 * time in the caller); `project` names whose lanes these are.
 */
function renderStalePost({ quiet, project, now = Date.now(), when = (iso) => iso }) {
  const names = quiet.map((q) => q.role).join(', ');
  return [
    `ALARM: ${quiet.length === 1 ? 'a lane has' : `${quiet.length} lanes have`} stopped running for ${project}: ${names}.`,
    '',
    ...quiet.map((q) => `- **${q.role}**: ${q.reason} (last pass ${when(q.at)}; quiet after ${durationText(q.thresholdMs)}).`
      + (q.beatMeans === 'liveness'
        ? ' _A lane writes a dated line on every wake whatever its pass concluded, so this means the runner itself has stopped, not that its work is failing._'
        : '')),
    '',
    'The machine is awake and checking (this message comes from the relay\'s own wake), so it is the lane',
    'that has stopped, not the machine.',
    '',
    'Where to look:',
    '```',
    'scripts/install_loop_runner.sh --status   # is each lane installed and loaded?',
    'npm run heartbeat                         # every lane, with its last pass',
    '```',
    '',
    `_Noticed at ${when(new Date(now).toISOString())}. Said again at most once every `
      + `${Math.round(REPOST_EVERY_MS / 3600000)} hours per lane until it runs again._`,
  ].join('\n');
}

/**
 * The one message posted when things are GOOD, and only ever after a quiet
 * post went out about that lane, so it closes an alarm somebody already read
 * rather than announcing routine health.
 */
function renderRecoveredPost({ role, project, quietSince, when = (iso) => iso }) {
  return [
    `**${role} is running again for ${project}.**`,
    '',
    quietSince
      ? `It was reported quiet at ${when(quietSince)}, and has run a pass since.`
      : 'It was reported quiet, and has run a pass since.',
    '',
    '_This is the close of that alarm, not a routine all-clear: nothing is posted here unless a',
    'quiet report went out first._',
  ].join('\n');
}

module.exports = {
  QUIET_AFTER_MISSES,
  MIN_QUIET_AFTER_MS,
  REPOST_EVERY_MS,
  quietAfterFor,
  ageText,
  durationText,
  dueAgain,
  lastBeatFromLog,
  recencyReport,
  renderStalePost,
  renderRecoveredPost,
};
