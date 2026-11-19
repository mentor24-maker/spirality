'use strict';

/**
 * ONE CLAUDE LIMIT, FIVE USERS: may a loop start a pass right now?
 *
 * WHY THIS EXISTS (2026-10-11, task 86bcgjbfk). Dane, the two StarCaster loops
 * and the two WaveCenter loops on the Mac Mini all draw on ONE Claude account
 * with ONE usage limit, first come first served. Nothing gave Dane's own
 * session priority, and nothing passed news of a hit limit between lanes: the
 * StarCaster runner learned it only by dying on it (loopRunnerGuard.js), and
 * WaveCenter's runner retried into the closed window every 30 minutes. Four
 * runners knocking on the same closed door, each finding out for itself.
 *
 * Two rules, both read from files every lane on the machine can see — both
 * repos' runners keep their logs in ~/loop-logs, so that folder is the shared
 * place, not either repo:
 *
 *   QUIET WINDOW   ~/loop-logs/loops.policy (JSON). Hours, in Mountain time,
 *                  during which no loop STARTS a pass — Dane's share. A pass
 *                  already running finishes; this is read only before a start.
 *   STAND-DOWN     ~/loop-logs/loops.standdown (JSON). When any lane reads a
 *                  usage-limit reset time, it writes it here, and every other
 *                  lane sleeps until then instead of discovering it.
 *
 * FAILURE-OPEN, AND IT SAYS SO. A bug here silences every lane in two repos,
 * which is worse than the problem it solves. So an unreadable policy file or
 * marker means "run as today" — and the verdict carries a note saying what
 * could not be read, which the runner writes to its log. A stand-down marker
 * whose time has passed is STALE and ignored: the limit it recorded is over.
 *
 * IN SPIRALITY (SP-396) the two files are named for the project, in its log
 * folder (`<logDir>/<projectSlug>-loops.policy`, `<projectSlug>-standdown`), as
 * every lane file is (scripts/lib/laneFiles.mjs): the lanes of one project share
 * them, and no project's file is read by another's. This module never names a
 * path; scripts/loop_policy.mjs does.
 *
 * This module is pure — file text and a clock in, a verdict out — so every
 * branch is testable without a runner. The IO is scripts/loop_policy.mjs.
 */

const DEFAULT_ZONE = 'America/Denver';

/**
 * THE QUIET WINDOW IN FORCE WHEN NO POLICY FILE SAYS OTHERWISE.
 *
 * null = no window: the loops run around the clock, exactly as before this
 * module existed. This is Dane's answer, not a placeholder: asked on task
 * 86bcgjbfk (2026-10-11) to pick A (8am-6pm MT weekdays), B (no quiet hours,
 * keep only the shared stand-down) or C (other hours), he replied "B". If he
 * names hours later, they go HERE (and a policy file still overrides it).
 *
 * Shape: { days: 'weekdays' | 'all', start: 'HH:MM', end: 'HH:MM', zone }
 */
const DEFAULT_QUIET_WINDOW = null;

/**
 * How long a lane sleeps before re-reading the rule. A window can be hours
 * long and a stand-down up to eight, and sleeping the whole stretch in one go
 * would mean an edit to the policy file (Dane wants the deck back early, or
 * the marker was written by mistake) waits for the end of it. Fifteen minutes
 * is the build loop's own fallback interval.
 */
const RECHECK_SECONDS = 15 * 60;

/** A marker further out than this is a mis-read, not a limit (same cap the
 *  guard uses for a single lane). Obeying it would silence four lanes for a
 *  day on a guess, so it is ignored and the note says why. */
const MAX_STAND_DOWN_SECONDS = 8 * 60 * 60;

const DAY_SETS = {
  all: [0, 1, 2, 3, 4, 5, 6],
  weekdays: [1, 2, 3, 4, 5],
};

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Minutes past midnight for 'HH:MM' (24h), or null. */
function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

/** Day of week and minute of day of `nowMs` in `zone`, or null. */
function zonedClock(nowMs, zone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }).formatToParts(new Date(nowMs));
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const day = WEEKDAY_INDEX[get('weekday')];
    const h = Number(get('hour'));
    const m = Number(get('minute'));
    if (day === undefined || !Number.isFinite(h) || !Number.isFinite(m)) return null;
    return { day, minute: h * 60 + m };
  } catch {
    return null;
  }
}

/** '6:00pm' from minutes past midnight — the way Dane reads a clock. */
function clockText(minute) {
  const h24 = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  const half = h24 < 12 ? 'am' : 'pm';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${half}` : `${h12}${half}`;
}

/** 'Oct 11 2:50am MT' for an instant — how a stand-down's end is shown. */
function instantText(ms, zone = DEFAULT_ZONE) {
  try {
    const s = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(ms));
    return `${s.replace(/\s?([AP])M$/, (_, x) => `${x.toLowerCase()}m`).replace(',', '')} MT`;
  } catch {
    return new Date(ms).toISOString();
  }
}

/**
 * Turn a window description into a checked one, or say why it is not one.
 * Returns { window } or { window: null, note } — never throws.
 */
function normalizeWindow(raw) {
  if (raw === null || raw === undefined) return { window: null, note: '' };
  if (typeof raw !== 'object') return { window: null, note: `the quiet window is not an object (${JSON.stringify(raw)}) — ignoring it` };
  const days = String(raw.days || 'all');
  const start = minutesOf(raw.start);
  const end = minutesOf(raw.end);
  const zone = String(raw.zone || DEFAULT_ZONE);
  if (!DAY_SETS[days]) return { window: null, note: `the quiet window's days "${days}" is not "weekdays" or "all" — ignoring it` };
  if (start === null || end === null) {
    return { window: null, note: `the quiet window's hours ("${raw.start}"–"${raw.end}") are not HH:MM — ignoring it` };
  }
  if (start === end) return { window: null, note: 'the quiet window starts and ends at the same minute — ignoring it' };
  if (!zonedClock(Date.now(), zone)) return { window: null, note: `the quiet window names a zone this machine cannot resolve ("${zone}") — ignoring it` };
  return { window: { days, start, end, zone }, note: '' };
}

/**
 * Read the policy file's text. Absent → the committed default. Unreadable →
 * the committed default too, with a note: failure-open.
 *
 * @param {string|null} text  the file's contents, or null when it does not exist
 */
function readPolicy(text) {
  if (text === null || text === undefined) {
    return { ...normalizeWindow(DEFAULT_QUIET_WINDOW), source: 'default' };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch (err) {
    return { window: null, source: 'file', note: `the policy file is not valid JSON (${err.message}) — running as if it had no quiet window` };
  }
  if (!parsed || typeof parsed !== 'object' || !('quietWindow' in parsed)) {
    return { window: null, source: 'file', note: 'the policy file has no "quietWindow" key — running as if it had no quiet window' };
  }
  return { ...normalizeWindow(parsed.quietWindow), source: 'file' };
}

/**
 * Is `nowMs` inside the window, and if so how long until it ends?
 * Returns { inside: false } or { inside: true, secondsLeft, endText }.
 * A window may cross midnight (start 22:00, end 06:00).
 */
function windowState(window, nowMs) {
  if (!window) return { inside: false };
  const now = zonedClock(nowMs, window.zone);
  if (!now) return { inside: false };
  const days = DAY_SETS[window.days];
  const crosses = window.end < window.start;
  let inside;
  if (!crosses) {
    inside = days.includes(now.day) && now.minute >= window.start && now.minute < window.end;
  } else if (now.minute >= window.start) {
    inside = days.includes(now.day); // the evening half belongs to today
  } else {
    inside = now.minute < window.end && days.includes((now.day + 6) % 7); // the morning half belongs to yesterday
  }
  if (!inside) return { inside: false };
  let left = window.end - now.minute;
  if (left <= 0) left += 24 * 60;
  return { inside: true, secondsLeft: left * 60, endText: `${clockText(window.end)} MT` };
}

/**
 * Read the stand-down marker's text.
 * Returns { marker: { untilMs, setBy, reason } } or { marker: null, note }.
 */
function readMarker(text) {
  if (text === null || text === undefined) return { marker: null, note: '' };
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch (err) {
    return { marker: null, note: `the stand-down marker is not valid JSON (${err.message}) — ignoring it` };
  }
  const untilMs = Date.parse(String(parsed?.until || ''));
  if (!Number.isFinite(untilMs)) {
    return { marker: null, note: `the stand-down marker's "until" (${JSON.stringify(parsed?.until)}) is not a time — ignoring it` };
  }
  return {
    marker: { untilMs, setBy: String(parsed.setBy || 'an unnamed lane'), reason: String(parsed.reason || '') },
    note: '',
  };
}

/**
 * THE VERDICT: may this lane start a pass now?
 *
 *   run         yes. `notes` lists anything that could not be read.
 *   stand-down  a lane recorded a usage limit that has not reset yet.
 *   quiet       inside Dane's quiet window.
 *
 * A stand-down outranks the window: it is the harder fact (the door is shut
 * for everybody, Dane included), and it names a time the window does not.
 *
 * `sleepSeconds` is how long to wait before asking again — the time left,
 * capped at RECHECK_SECONDS so an edited file is noticed.
 *
 * @param {object} opts
 * @param {string|null} opts.policyText  loops.policy contents, null if absent
 * @param {string|null} opts.markerText  loops.standdown contents, null if absent
 * @param {number} opts.nowMs
 */
function policyVerdict({ policyText = null, markerText = null, nowMs } = {}) {
  const notes = [];
  const policy = readPolicy(policyText);
  if (policy.note) notes.push(policy.note);
  const { marker, note: markerNote } = readMarker(markerText);
  if (markerNote) notes.push(markerNote);

  if (marker) {
    const left = Math.ceil((marker.untilMs - nowMs) / 1000);
    if (left > MAX_STAND_DOWN_SECONDS) {
      notes.push(`the stand-down marker (set by ${marker.setBy}) runs to ${instantText(marker.untilMs)}, past the `
        + `${MAX_STAND_DOWN_SECONDS / 3600}h sanity cap — ignoring it rather than silencing every lane on a guess`);
    } else if (left > 0) {
      return {
        action: 'stand-down',
        sleepSeconds: Math.min(left, RECHECK_SECONDS),
        line: `standing down until ${instantText(marker.untilMs)} (set by ${marker.setBy}) — not starting a pass`,
        notes,
      };
    }
    // left <= 0: stale — the limit it recorded is over. Ignored silently,
    // because a stale marker is the normal state the morning after.
  }

  const w = windowState(policy.window, nowMs);
  if (w.inside) {
    return {
      action: 'quiet',
      sleepSeconds: Math.min(w.secondsLeft, RECHECK_SECONDS),
      line: `quiet window until ${w.endText} — not starting a pass (Dane's share of the Claude limit)`,
      notes,
    };
  }
  return { action: 'run', sleepSeconds: 0, line: '', notes };
}

/** One line describing the rule, for `--status`. */
function describePolicy({ policyText = null, markerText = null, nowMs } = {}) {
  const policy = readPolicy(policyText);
  const w = policy.window;
  const where = policy.source === 'file' ? 'from the project loops.policy file' : 'the committed default';
  const windowText = w
    ? `quiet ${clockText(w.start)}–${clockText(w.end)} MT ${w.days === 'weekdays' ? 'weekdays' : 'every day'} (${where})`
    : `no quiet window (${where})`;
  const v = policyVerdict({ policyText, markerText, nowMs });
  const nowText = v.action === 'run' ? 'may start a pass now' : v.line.replace(/ — not starting a pass.*$/, '');
  const extra = v.notes.length ? ` — NOTE: ${v.notes.join('; ')}` : '';
  return `policy:   ${windowText}; ${nowText}${extra}`;
}

/**
 * The marker a lane writes when a usage limit stops it. Returns the JSON text
 * to write, or null when an existing marker already runs as late or later —
 * a lane must never SHORTEN another lane's stand-down.
 *
 * @param {object} opts
 * @param {string} opts.lane          e.g. 'starcaster/loop-build'
 * @param {number} opts.sleepSeconds  what the guard said to sleep
 * @param {string} [opts.reason]
 * @param {string|null} [opts.existingText]
 * @param {number} opts.nowMs
 */
function standDownText({ lane, sleepSeconds, reason = '', existingText = null, nowMs } = {}) {
  const secs = Number(sleepSeconds);
  if (!Number.isFinite(secs) || secs <= 0) return null;
  const untilMs = nowMs + Math.min(secs, MAX_STAND_DOWN_SECONDS) * 1000;
  const { marker } = readMarker(existingText);
  if (marker && marker.untilMs >= untilMs && marker.untilMs - nowMs <= MAX_STAND_DOWN_SECONDS * 1000) return null;
  return `${JSON.stringify({
    until: new Date(untilMs).toISOString(),
    setBy: String(lane || 'an unnamed lane'),
    reason: String(reason || '').replace(/\s+/g, ' ').trim(),
    writtenAt: new Date(nowMs).toISOString(),
  }, null, 2)}\n`;
}

module.exports = {
  DEFAULT_ZONE,
  DEFAULT_QUIET_WINDOW,
  RECHECK_SECONDS,
  MAX_STAND_DOWN_SECONDS,
  readPolicy,
  readMarker,
  windowState,
  policyVerdict,
  describePolicy,
  standDownText,
  instantText,
};
