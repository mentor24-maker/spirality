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
 *   ===== 2026-11-09 18:25:36 END /loop-review (exit 0 ...) =====
 *   [loop-runner] 18:25:36 sleeping 1800s before the next /loop-review
 *   ===== 2026-11-09 18:37:36 START relay — <repo> =====       scripts/run_relay.sh
 *   ===== 2026-11-09 18:37:52 END relay — pass complete ... =====
 *
 * A lane's next pass is its last "sleeping" line's time plus its seconds;
 * that line carries a time of day only, so its date is the date of the
 * dated line before it (the next day if the clock went past midnight). The
 * relay has no such line: launchd starts it every interval, so its next pass
 * is its last start plus the interval in scripts/lib/loopSchedule.mjs, the
 * one the installer writes into its plist.
 *
 * Log times are this machine's own clock, the one the runners wrote them
 * with; the tracker runs on the same machine, so they are read as local time.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
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

const DATED = /^===== (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) (START|END) (\S+)/;
const SLEEPING = /^\[loop-runner\] (\d{2}):(\d{2}):(\d{2}) sleeping (\d+)s before the next \/(\S+)$/;

/** The job a START or END line names: `/loop-build` or `relay`. */
const jobOf = (word) => word.replace(/^\//, '');

/**
 * What a log's last lines say about `job`: `{ logged, running, lastStart,
 * nextDue }`, times as Date objects or null. `interval` (seconds) is used
 * when the log has no sleeping line for the job (the relay).
 */
export function readStage(text, job, { interval = null } = {}) {
  let lastStart = null;
  let lastEnd = null;
  let sleep = null;
  let lastDated = null;
  let index = 0;
  for (const line of String(text ?? '').split('\n')) {
    index += 1;
    const dated = DATED.exec(line);
    if (dated) {
      const [, y, mo, d, h, mi, s, kind, word] = dated;
      const at = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
      lastDated = at;
      if (jobOf(word) !== job) continue;
      if (kind === 'START') lastStart = { at, index };
      else lastEnd = { at, index };
      continue;
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
  if (!lastStart && !sleep) return { logged: false, running: false, lastStart: null, nextDue: null };
  const running = Boolean(lastStart && (!lastEnd || lastStart.index > lastEnd.index));
  let nextDue = null;
  if (!running) {
    if (sleep && sleep.index > (lastStart?.index ?? 0)) nextDue = new Date(sleep.at.getTime() + sleep.seconds * 1000);
    else if (interval != null && lastStart) nextDue = new Date(lastStart.at.getTime() + interval * 1000);
  }
  return { logged: true, running, lastStart: lastStart?.at ?? null, nextDue };
}

const iso = (d) => (d ? d.toISOString() : null);

/**
 * GET /pipeline's answer: `{ stages: [{ name, job, logged, running,
 * lastStart, nextDue }] }`, times as ISO strings. A stage whose log is
 * missing, or has no pass in it yet, answers `logged: false`; one whose log
 * cannot be read answers that too, with `unreadable: true`. One stage never
 * fails the others.
 */
export function pipelineOf({ logDir, slug }, { tailBytes = TAIL_BYTES } = {}) {
  const folder = logFolderOf(logDir);
  return {
    stages: STAGES.map(({ name, job }) => {
      // Only the relay's next start comes from its interval: the lanes write theirs as a sleeping line.
      const interval = job === 'relay' ? intervalOf(job) : null;
      let text;
      try {
        text = readTail(join(folder, `${slug}-${job}.log`), tailBytes);
      } catch {
        return { name, job, logged: false, running: false, lastStart: null, nextDue: null, unreadable: true };
      }
      const stage = readStage(text, job, { interval });
      return { name, job, logged: stage.logged, running: stage.running, lastStart: iso(stage.lastStart), nextDue: iso(stage.nextDue) };
    }),
  };
}
