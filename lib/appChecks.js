'use strict';

const { mountainTime, ALARM_PREFIX } = require('./trackerBus.js');

/**
 * appChecks.js — the decisions behind a project's application checks
 * (SP-264, move 3 in docs/INTEGRATION.md). Pure: no clock, no network, no
 * files. `scripts/app_checks.mjs` runs the commands and posts; this module
 * says which checks are due and what, if anything, a result posts.
 *
 * A project lists its checks in its manifest (`applicationChecks`,
 * docs/PROJECT_MANIFEST.md). Each command exits 0 when all is well, and
 * non-zero printing one line when something needs attention. It posts
 * nothing itself: Spirality posts what changed to the project's bus.
 *
 * THE POST RULES (docs/INTEGRATION.md, "3. Application checks"):
 *
 *   before   now      posts
 *   well     failing  "<name>: <line>", with "ALARM: " in front when the
 *                     check's `alarm` is true (the tracker texts an alarm)
 *   failing  failing  nothing, except a reminder at most once a day,
 *                     "<name>: still failing since <time, MT>: <line>"
 *                     (an alarm check's reminder is an alarm too, so a quiet
 *                     alarm is not forgotten)
 *   failing  well     "<name>: well again", never an alarm
 *   well     well     nothing
 *
 * A check never run before counts as well before.
 *
 * Each check's saved state is `{ well, line, since, remindedAt, ranAt }`:
 * whether it was well, the line it last failed with, when it started
 * failing, when the last post about the failure went out, and when it last
 * ran. The runner saves a check's new state only once its post has landed,
 * so a post that did not land is tried again on the next pass.
 */

/** How long a failing check stays quiet before its reminder. */
const REMIND_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * The relay ticks every 10 minutes and a pass takes some seconds, so a check
 * "every 10 minutes" last run 9 minutes 58 seconds ago is due. A minute of
 * slack keeps it from skipping every other tick.
 */
const DUE_SLACK_MS = 60 * 1000;

/** The longest line a post carries; the rest is cut, never posted. */
const LINE_LIMIT = 300;

/** Variable names whose values are never printed or posted. */
const SECRET_NAME = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|DSN|AUTH/i;

/** Values shorter than this are too common to hide without hiding words. */
const SECRET_MIN_LENGTH = 8;

/** The checks in `checks` that are due at `now`, in their listed order. */
function dueChecks(checks, state, now) {
  const saved = state && typeof state === 'object' ? state : {};
  return (Array.isArray(checks) ? checks : []).filter((c) => {
    const ranAt = Number(saved[c.name]?.ranAt);
    if (!Number.isFinite(ranAt) || ranAt <= 0) return true;
    return now - ranAt >= c.everyMinutes * 60 * 1000 - DUE_SLACK_MS;
  });
}

/** The first non-blank line of `text`, trimmed and cut to LINE_LIMIT. */
function firstLine(text) {
  const line = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT - 1)}…` : line;
}

/**
 * `line` with the value of every secret-looking variable in `env` replaced
 * by "[hidden]", so a check that prints a key never puts it on the bus.
 */
function redact(line, env = {}) {
  let out = String(line ?? '');
  const values = Object.entries(env || {})
    .filter(([k, v]) => SECRET_NAME.test(k) && typeof v === 'string' && v.length >= SECRET_MIN_LENGTH)
    .map(([, v]) => v)
    .sort((a, b) => b.length - a.length);
  for (const v of values) out = out.split(v).join('[hidden]');
  return out;
}

/**
 * What one run of a check came to: `{ well, line }`. `run` is
 * `{ code, stdout, stderr, timedOut, error }` as the runner saw it, and
 * `timeoutSeconds` the check's limit. Only the first line of what it
 * printed is kept (what it wrote to stdout, or else to stderr).
 */
function resultOf(run, { timeoutSeconds, env } = {}) {
  const r = run || {};
  if (r.timedOut) return { well: false, line: `did not finish in ${timeoutSeconds} seconds` };
  if (r.error) return { well: false, line: `could not be run (${redact(firstLine(r.error), env)})` };
  if (r.code === 0) return { well: true, line: '' };
  const said = redact(firstLine(r.stdout) || firstLine(r.stderr), env);
  const code = r.code == null ? (r.signal ? `on signal ${r.signal}` : 'with no exit code') : String(r.code);
  return { well: false, line: said || `exited ${code} with no message` };
}

/**
 * The post (or null) for one check's result, and the state to save once
 * that post has landed. `prev` is the check's saved state (undefined for a
 * check never run), `result` is `resultOf`'s, `now` milliseconds.
 */
function decide(check, prev, result, now) {
  const was = prev && typeof prev === 'object' ? prev : { well: true };
  const wasWell = was.well !== false;
  const alarm = check.alarm !== false ? `${ALARM_PREFIX} ` : '';
  if (result.well) {
    const next = { well: true, line: '', since: null, remindedAt: null, ranAt: now };
    return { post: wasWell ? null : `${check.name}: well again`, kind: wasWell ? 'well' : 'well-again', next };
  }
  if (wasWell) {
    return {
      post: `${alarm}${check.name}: ${result.line}`,
      kind: 'failing',
      next: { well: false, line: result.line, since: now, remindedAt: now, ranAt: now },
    };
  }
  const since = Number.isFinite(Number(was.since)) && was.since != null ? Number(was.since) : now;
  const remindedAt = Number.isFinite(Number(was.remindedAt)) && was.remindedAt != null ? Number(was.remindedAt) : since;
  if (now - remindedAt >= REMIND_AFTER_MS) {
    return {
      post: `${alarm}${check.name}: still failing since ${mountainTime(since)}: ${result.line}`,
      kind: 'reminder',
      next: { well: false, line: result.line, since, remindedAt: now, ranAt: now },
    };
  }
  return { post: null, kind: 'still-failing', next: { well: false, line: result.line, since, remindedAt, ranAt: now } };
}

module.exports = {
  DUE_SLACK_MS,
  LINE_LIMIT,
  REMIND_AFTER_MS,
  decide,
  dueChecks,
  firstLine,
  redact,
  resultOf,
};
