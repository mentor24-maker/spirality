/**
 * The Pipeline Status pod's answer (SP-168): for each loop stage on this
 * machine, whether a pass is running now, when the last one started, and
 * when the next is due. GET /pipeline serves it; the Tasks page shows it.
 *
 * It reads the same log files `scripts/install_loop_runner.sh --status`
 * reads, named the way the installer names them (`log_of`):
 * `<logDir>/<projectSlug>-<job>.log`, both from the project config. Only
 * the end of each log is read (they grow without limit), and only times and
 * flags leave here, never a line of log text.
 *
 * The lines it reads, each written by one runner:
 *
 *   ===== 2026-11-09 18:22:34 START /loop-review =====          scripts/loop_runner.sh
 *   ===== 2026-11-13 14:02:10 START /loop-review (model: claude-sonnet-5-5) =====   since SP-239
 *   ===== 2026-11-09 18:25:36 END /loop-review (exit 0 ...) =====
 *   [loop-runner] 18:25:36 sleeping 1800s before the next /loop-review (a wake ends it early)
 *   ===== 2026-11-09 18:37:36 START relay — <repo> =====       scripts/run_relay.sh
 *   ===== 2026-11-09 18:37:52 END relay — pass complete ... =====
 *
 * A lane's next pass is its last "sleeping" line's time plus its seconds;
 * that line carries a time of day only, so its date is the date of the
 * dated line before it (the next day if the clock went past midnight). The
 * relay has no such line: launchd starts it on a one-minute tick and a tick
 * runs a pass once its wake time is up (scripts/run_relay.sh, SP-236), so its
 * next pass is its last start plus the wake time its tick goes by, the one
 * it keeps in `<logDir>/<projectSlug>-relay.interval` (the default in
 * scripts/lib/loopSchedule.mjs until it has read one).
 *
 * Each stage also carries the wake time set on the Settings page (`set`,
 * SP-224) and the one the job last actually used (`used`): a lane's newest
 * sleeping line, the relay's kept wake time. They differ for a while after a
 * change, until the job's next pass reads the new value; until then the
 * next run shown is when the job will really wake, on the value it is using.
 *
 * A lane's START line names the model its pass ran on (SP-239): `model` is
 * the newest START's, an id or `default` (Claude's default), and null when
 * that line names none (a pass from before SP-239, or the relay, which runs
 * no model). Only a value shaped like a model id leaves here.
 *
 * Log times are this machine's own clock, the one the runners wrote them
 * with; the tracker runs on the same machine, so they are read as local time.
 *
 * A stage is **failing** (SP-218) when its newest FAILING_AFTER finished
 * passes all failed, so the page can say so in its header even when the
 * outage is this machine's own network: the logs are read here, locally. A
 * relay pass failed when its END line's exit is not 0 (scripts/run_relay.sh
 * writes an honest code). A lane's exit is "not a verdict"
 * (scripts/loop_runner.sh), so a lane pass failed when its exit is not 0 or
 * its report, between START and END, has a line starting `FAILED:`. The
 * reason is one of FAILING_REASONS, matched in the newest failed pass's text
 * and never copied from it.
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { intervalOf } from '../scripts/lib/loopSchedule.mjs';

/** The stages the pod shows, in its order, each with the job that runs it. */
export const STAGES = Object.freeze([
  { name: 'Relay', job: 'relay' },
  { name: 'Build', job: 'loop-build' },
  { name: 'Review', job: 'loop-review' },
  { name: 'Intake', job: 'loop-intake' },
]);

/** How much of the end of each log is read. A pass's own report is a few thousand bytes. */
export const TAIL_BYTES = 256 * 1024;

/** The log folder from the project config, with a leading `~/` as the home folder (as scripts/project_config.mjs does). */
export function logFolderOf(logDir, home = homedir()) {
  return /^~(\/|$)/.test(logDir) ? logDir.replace(/^~/, home) : logDir;
}

/** The last `bytes` of `file` as text, starting at a whole line; null when there is no such file. */
export function readTail(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    // Cut part way into the file: the first line is a fragment, never read.
    return size > length ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    closeSync(fd);
  }
}

/** Failed passes in a row that make a stage failing: 30 minutes of the relay, 90 of a lane. */
export const FAILING_AFTER = 3;

/** The words the page may say about a failing stage: the only text from a pass that leaves here. */
export const FAILING_REASONS = Object.freeze({
  offline: "can't reach the internet",
  failing: 'keeps failing',
});

/** A name lookup that failed: the machine has lost its connection (or its DNS). */
const NO_INTERNET = /Could not resolve host|ENOTFOUND|getaddrinfo/;
/** A lane's report line that says a step failed (the skills print it). */
const REPORT_FAILED = /^FAILED:/;

const DATED = /^===== (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) (START|END) (\S+)/;
const EXIT = /\(exit (\d+)/;
// The model a lane's START line names (SP-239): `default` or an id, nothing else.
const MODEL = /\(model: ([a-z0-9.-]{1,60})\)/;
// The runner adds "(a wake ends it early)" after the lane's name (SP-219).
const SLEEPING = /^\[loop-runner\] (\d{2}):(\d{2}):(\d{2}) sleeping (\d+)s before the next \/(\S+)(?: .*)?$/;

/** The job a START or END line names: `/loop-build` or `relay`. */
const jobOf = (word) => word.replace(/^\//, '');

/**
 * What a log's last lines say about `job`: `{ logged, running, lastStart,
 * lastEnd, lastExit, interval, nextDue, failing, failedPasses, failingSince,
 * failingReason }`, times as Date objects or null.
 * `lastEnd` and `lastExit` are the newest END line's time and exit code
 * (while a pass runs, the one before it); the code is the number in its
 * "(exit N)", null when it has none. `interval` (seconds) is how often the
 * job wakes: the newest sleeping line's own seconds (a lane), else the one
 * given (the relay, which has no such line). `slept` is that sleeping
 * line's seconds alone, null when none is in view. `model` is the model
 * the newest START line names, null when it names none.
 *
 * `failedPasses` counts the newest finished passes that failed, one after
 * another (a pass under way neither adds to it nor breaks it), and
 * `failingSince` is when the first of them started (its END, when its START
 * is out of view). `failing` is that count reaching FAILING_AFTER, and only
 * then is `failingReason` one of FAILING_REASONS rather than null.
 */
export function readStage(text, job, { interval = null } = {}) {
  let lastStart = null;
  let lastEnd = null;
  let model = null;
  let sleep = null;
  let lastDated = null;
  let index = 0;
  // The passes in view, oldest first: when each started, and whether it failed and why.
  const passes = [];
  let open = null; // the pass between its START and its END
  for (const line of String(text ?? '').split('\n')) {
    index += 1;
    const dated = DATED.exec(line);
    if (dated) {
      const [, y, mo, d, h, mi, s, kind, word] = dated;
      const at = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
      lastDated = at;
      if (jobOf(word) !== job) continue;
      if (kind === 'START') {
        lastStart = { at, index };
        model = MODEL.exec(line)?.[1] ?? null;
        open = { start: at, reportFailed: false, offline: false };
      } else {
        const code = EXIT.exec(line);
        lastEnd = { at, index, exit: code ? Number(code[1]) : null };
        const pass = open ?? { start: null, reportFailed: false, offline: false };
        const badExit = lastEnd.exit != null && lastEnd.exit !== 0;
        passes.push({ start: pass.start ?? at, failed: badExit || (job !== 'relay' && pass.reportFailed), offline: pass.offline });
        open = null;
      }
      continue;
    }
    if (open) {
      if (REPORT_FAILED.test(line)) open.reportFailed = true;
      if (NO_INTERNET.test(line)) open.offline = true;
    }
    const sleeping = SLEEPING.exec(line);
    if (sleeping && sleeping[5] === job && lastDated) {
      const [, h, mi, s, seconds] = sleeping;
      const at = new Date(lastDated);
      at.setHours(Number(h), Number(mi), Number(s), 0);
      if (at < lastDated) at.setDate(at.getDate() + 1);
      sleep = { at, seconds: Number(seconds), index };
    }
  }
  const every = sleep ? sleep.seconds : interval;
  let failedPasses = 0;
  while (failedPasses < passes.length && passes[passes.length - 1 - failedPasses].failed) failedPasses += 1;
  const failing = failedPasses >= FAILING_AFTER;
  const health = {
    failing,
    failedPasses,
    failingSince: failedPasses ? passes[passes.length - failedPasses].start : null,
    failingReason: failing ? (passes[passes.length - 1].offline ? FAILING_REASONS.offline : FAILING_REASONS.failing) : null,
  };
  const slept = sleep ? sleep.seconds : null;
  if (!lastStart && !sleep && !lastEnd) return { logged: false, running: false, lastStart: null, lastEnd: null, lastExit: null, interval: every, slept, nextDue: null, model: null, ...NOT_FAILING };
  const running = Boolean(lastStart && (!lastEnd || lastStart.index > lastEnd.index));
  let nextDue = null;
  if (!running) {
    if (sleep && sleep.index > (lastStart?.index ?? 0)) nextDue = new Date(sleep.at.getTime() + sleep.seconds * 1000);
    else if (interval != null && lastStart) nextDue = new Date(lastStart.at.getTime() + interval * 1000);
  }
  return { logged: true, running, lastStart: lastStart?.at ?? null, lastEnd: lastEnd?.at ?? null, lastExit: lastEnd?.exit ?? null, interval: every, slept, nextDue, model, ...health };
}

/** A stage with nothing failing, or nothing known: the health fields' quiet values. */
const NOT_FAILING = Object.freeze({ failing: false, failedPasses: 0, failingSince: null, failingReason: null });

const iso = (d) => (d ? d.toISOString() : null);

/** A whole number of seconds a job could wake on, or null. */
const seconds = (v) => {
  const n = /^[0-9]+$/.test(String(v ?? '').trim()) ? Number(String(v).trim()) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * The wake time the relay's tick goes by (scripts/run_relay.sh), kept beside
 * its log, or null when there is none yet (it then goes by the default).
 */
export function relayIntervalOf(folder, slug) {
  try {
    return seconds(readFileSync(join(folder, `${slug}-relay.interval`), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Whether a stage is paused on the Settings page (SP-237), from the
 * project's pipeline controls (`[{ key, value }]`, tracker/
 * pipelineControls.mjs): 'pipeline' when the whole pipeline is, 'lane' when
 * only this one is, null when neither (or the controls are not known). The
 * same two switches the runners ask before every pass (lib/pipelinePause.js
 * settingsPauseVerdict).
 */
export function pausedBy(controls, job) {
  if (!Array.isArray(controls)) return null;
  const on = (key) => controls.some((c) => c && c.key === key && c.value === 'on');
  if (on('paused')) return 'pipeline';
  if (on(`paused.${job}`)) return 'lane';
  return null;
}

/**
 * GET /pipeline's answer: `{ stages: [{ name, job, logged, running,
 * lastStart, lastEnd, lastExit, interval, set, used, nextDue, failing,
 * failedPasses, failingSince, failingReason, paused, model }] }`, `model`
 * the model the lane's last pass ran on (readStage; null when not known), times as ISO
 * strings, the exit code and the seconds as numbers or null, the reason one
 * of FAILING_REASONS or null, `paused` pausedBy's answer from `controls` (the
 * project's pipeline controls; null leaves every stage unpaused).
 *
 * `wake` is `{ job: seconds }`, the wake times set on the Settings page for
 * this project (wakeTimesOf); a job missing from it is on its default.
 * `set` is that value; `used` the one the job last used (a lane's newest
 * sleeping line, null when none is in view; the relay's kept wake time, or
 * its default); `interval` is how often it wakes now: `used`, else `set`
 * (a lane with no sleeping line in view sleeps the set value next).
 * A stage whose log is
 * missing, or has no pass in it yet, answers `logged: false`; one whose log
 * cannot be read answers that too, with `unreadable: true`. One stage never
 * fails the others.
 */
export function pipelineOf({ logDir, slug }, { tailBytes = TAIL_BYTES, wake = {}, controls = null } = {}) {
  const folder = logFolderOf(logDir);
  return {
    stages: STAGES.map(({ name, job }) => {
      const paused = pausedBy(controls, job);
      const set = seconds(wake?.[job]) ?? intervalOf(job);
      // The relay's next start comes from the wake time its tick goes by; the lanes write theirs as a sleeping line.
      const relayUsed = job === 'relay' ? (relayIntervalOf(folder, slug) ?? intervalOf(job)) : null;
      let text;
      try {
        text = readTail(join(folder, `${slug}-${job}.log`), tailBytes);
      } catch {
        return { name, job, logged: false, running: false, lastStart: null, lastEnd: null, lastExit: null, interval: relayUsed ?? set, set, used: relayUsed, nextDue: null, ...NOT_FAILING, paused, model: null, unreadable: true };
      }
      const stage = readStage(text, job, { interval: relayUsed ?? set });
      const used = job === 'relay' ? relayUsed : stage.slept;
      return {
        name, job, logged: stage.logged, running: stage.running,
        lastStart: iso(stage.lastStart), lastEnd: iso(stage.lastEnd), lastExit: stage.lastExit,
        interval: used ?? set, set, used,
        nextDue: iso(stage.nextDue),
        failing: stage.failing, failedPasses: stage.failedPasses,
        failingSince: iso(stage.failingSince), failingReason: stage.failingReason,
        paused,
        model: stage.model,
      };
    }),
  };
}

/**
 * The wake times set on the Settings page for `slug`, as pipelineOf takes
 * them: `{ job: seconds }` from the store's pipeline controls, `{}` when the
 * project is not in this tracker (every job then on its default).
 */
export function wakeTimesOf(store, slug) {
  if (!slug || !store.getProject(slug)) return {};
  const out = {};
  for (const c of store.pipelineSettings(slug)) {
    if (c.key.startsWith('wake.')) out[c.key.slice('wake.'.length)] = Number(c.value);
  }
  return out;
}
