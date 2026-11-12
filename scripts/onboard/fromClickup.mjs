/**
 * The setup wizard's steps for a project that already runs a loop on
 * ClickUp (SP-159): WaveCenter and StarCaster, each with its own older copy
 * of the loop, its own lanes on the Mini and its tickets in a ClickUp Loop
 * Queue. One wizard run moves such a project, in the order the runbook
 * gives (docs/TRACKER_MVP.md, "Switching a project over"):
 *
 *   setup-check   SP-252: the setup branch written (`onboard:copy
 *                 --check-only`, nothing pushed) and the project's own
 *                 `verify` run on it, the old loop's tests that check the
 *                 files it replaces retired by rule. A red verify stops the
 *                 run here, while the old lanes still run.
 *   stop          its old lanes unloaded, after checking no pass is in
 *                 flight. The lanes, their labels and their logs are read
 *                 from the project's own installer (`--status`), never
 *                 guessed, and it is that installer's `--uninstall` that
 *                 stops them; read back with `--status` again.
 *   snapshot      `tracker:snapshot` (SP-158): a dry run, then the real one.
 *   import        `tracker:import`: a dry run, then the real one.
 *   switch-check  `tracker:switch-check` must end `Safe to switch.`
 *
 * They run after the sign-ins and before the copy step, so the import reads
 * the ClickUp seats before anything of the setup can merge, and nothing
 * writes to the Loop Queue between the stop and the import.
 *
 * The three tracker scripts read their project config from the folder they
 * run in, and the project's own checkout still holds its old loop. So the
 * wizard writes a "switch settings file" beside the answers file: the
 * project's new settings file with its ClickUp list and the operator's
 * ClickUp seat put back, and the tracker home's data folder, and runs the
 * scripts from Spirality's folder with that file's folder as their working
 * folder. Doppler supplies the project's own keys (its ClickUp token and,
 * after the sign-ins, its tracker seats), as `scripts/with_doppler.mjs`
 * does for every script.
 *
 * Everything here is pure; scripts/onboard/onboard.mjs runs the commands.
 */
import { join } from 'node:path';
import { CONFIG_FILE, validateProjectConfig } from '../../lib/projectConfig.mjs';

/** The five steps, in the order they run, all before the copy step. */
export const CLICKUP_STEPS = Object.freeze(['setup-check', 'stop', 'snapshot', 'import', 'switch-check']);

/** The step the ClickUp steps run before. */
export const CLICKUP_STEPS_BEFORE = 'copy';

/** `steps` with the ClickUp steps put in before the copy step. */
export function withClickupSteps(steps) {
  const at = steps.indexOf(CLICKUP_STEPS_BEFORE);
  if (at < 0) throw new Error(`there is no "${CLICKUP_STEPS_BEFORE}" step to put the ClickUp steps before`);
  return [...steps.slice(0, at), ...CLICKUP_STEPS, ...steps.slice(at)];
}

/**
 * The questions for a project already on ClickUp, in the order they are
 * asked, by the wizard in a Terminal and by the setup page's answers form
 * (tracker/setup.mjs). The first is asked once; the others only when it
 * names a list, and then the two ids are needed (`requiredWith`).
 */
export const CLICKUP_FIELDS = Object.freeze([
  { key: 'clickupListId', question: 'Does this project already run a loop on ClickUp? Its Loop Queue list id (digits), or blank for no' },
  { key: 'clickupOperatorId', question: 'Your own ClickUp user id, so your old comments are filed under you (the old loop\'s scripts/clickup.mjs names it)', requiredWith: 'clickupListId' },
  { key: 'clickupMachineUserId', question: 'The old loop\'s ClickUp machine user id, so its comments are filed under the loops (the old loop\'s scripts/clickup.mjs names it)', requiredWith: 'clickupListId' },
  { key: 'clickupExtraLists', question: 'Other ClickUp lists to keep a copy of, as list ids (comma between)', list: true, fallback: () => 'none' },
]);

/**
 * Should the ClickUp questions be asked for this project? Once they have
 * been answered (the answers file has `clickupListId`, even null), or when
 * its checkout runs a loop of its own (runsOldLoop). `raw` is the answers
 * file as written, `checkout` its checkout folder (null when not known).
 */
export function asksClickup(raw, checkout, exists) {
  if (raw && Object.hasOwn(raw, 'clickupListId')) return true;
  return Boolean(checkout) && runsOldLoop(checkout, exists);
}

/** The project's own lane installer, in its checkout. */
export function installerPath(checkout) {
  return join(checkout, 'scripts', 'install_loop_runner.sh');
}

/**
 * Does this checkout look like a project running a loop of its own, not yet
 * on Spirality's: its own lane installer is there and no Spirality settings
 * file is. Only then is the ClickUp question asked, so a new project's run
 * is unchanged. `exists(path)` is the wizard's.
 */
export function runsOldLoop(checkout, exists) {
  return Boolean(exists(installerPath(checkout))) && !exists(join(checkout, CONFIG_FILE));
}

/**
 * The jobs an installer's `--status` names, in its own words: every section
 * `── <job>`, whether it is loaded, the launchd label launchd listed it
 * under (the last word of `loaded:   yes — <pid> <code> <label>`), and the
 * log it names (`log:      <path> (...)`), and its lock (`lock:` held, stale
 * or none; null when there is no lock line). StarCaster's, WaveCenter's and
 * Spirality's installers all print these lines.
 */
export function readInstallerStatus(text) {
  const jobs = [];
  let job = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const head = /^── (\S+)\s*$/.exec(line);
    if (head) { job = { name: head[1], loaded: false, label: null, pid: null, log: null, lock: null }; jobs.push(job); continue; }
    if (!job) continue;
    const loaded = /^loaded:\s+yes\b(.*)$/.exec(line);
    if (loaded) {
      job.loaded = true;
      const words = loaded[1].replace(/^\s*—\s*/, '').trim().split(/\s+/).filter(Boolean);
      job.label = words.length >= 3 ? words.at(-1) : null;
      // launchd's PID column: a number while the job's process is alive,
      // `-` when it is not running at all; anything else is not known.
      const pid = words.length >= 3 ? words[0] : null;
      job.pid = pid === '-' ? 'none' : /^\d+$/.test(pid ?? '') ? Number(pid) : null;
    }
    // `log:      <path> (last modified ...)` or `(nothing written yet)`;
    // the path may hold spaces, so it runs up to that last bracket.
    const log = /^log:\s+(.+?)(?:\s+\((?:last modified [^)]*|nothing written yet)\))?$/.exec(line);
    if (log) job.log = log[1];
    // `lock:     held by live pid <n> ...`, `STALE (...)` or `none`; an
    // installer that prints no lock line leaves it null (not known).
    const lock = /^lock:\s+(\S+)/.exec(line);
    if (lock) job.lock = lock[1] === 'held' ? 'held' : lock[1] === 'STALE' ? 'stale' : lock[1] === 'none' ? 'none' : null;
  }
  return jobs;
}

/**
 * Is a pass in flight, by its lane's log? The runners write
 * `===== <time> START /<lane> ...` before a pass and `===== <time> END ...`
 * after it, so a START with no END after it is a pass still running.
 * But a runner killed mid-pass leaves a START with no END too. It counts as
 * gone (not running) only on proof that no runner is alive:
 * - its `--status` lock is `stale` (a lock whose runner is dead), or
 * - its lock is `none` AND launchd shows no process for the job (`pid`
 *   `none`, from `loaded: yes — -  0  <label>`).
 * A lock of `none` alone proves nothing: a job whose runner takes no lock
 * (WaveCenter's merge-on-comment) always says `none`, mid-merge included.
 * Anything else (held, a live launchd PID, or not known) leaves the log's
 * word standing.
 * Returns { running, started } (started: the START line's time), or null
 * when the log has no pass to read.
 */
export function passInFlight(logText, { lock = null, pid = null } = {}) {
  const lines = String(logText || '').split('\n');
  let start = -1;
  let end = -1;
  lines.forEach((l, i) => {
    if (/^===== .* START /.test(l)) start = i;
    else if (/^===== .* END /.test(l)) end = i;
  });
  if (start < 0) return null;
  const stamp = /^===== (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(lines[start]);
  const runnerGone = lock === 'stale' || (lock === 'none' && pid === 'none');
  return { running: start > end && !runnerGone, started: stamp ? stamp[1] : null };
}

/** Where the switch settings file is kept: `<logDir>/onboard/<slug>-switch/`, beside the answers file. */
export function switchDir(onboardFolder, slug) {
  return join(onboardFolder, `${slug}-switch`);
}

/**
 * The switch settings file: the project's new settings file (`settings`, as
 * read from the scratch settings file) with its ClickUp list and the
 * operator's and the old loop's ClickUp seats put back, which the importer
 * files their comments under, and the tracker home's data folder, where the snapshot is kept and
 * the database is. Checked by the same rules every settings file is.
 */
export function switchSettings(settings, answers, homeConfig) {
  const next = {
    ...settings,
    loopQueueListId: answers.clickupListId,
    operatorUserId: answers.clickupOperatorId,
    // The importer files a comment by the old loop's ClickUp seat under the
    // loops (tracker/import.mjs authorOf); the tracker's own machine actor
    // id would never match a ClickUp user.
    machineUserId: answers.clickupMachineUserId,
    trackerDataDir: homeConfig.trackerDataDir,
  };
  validateProjectConfig(next, { file: 'the switch settings file', env: {} });
  return next;
}

/** The snapshot's arguments: one `--list` per extra list. */
export function snapshotArgs(answers, { dryRun }) {
  return [...(dryRun ? ['--dry-run'] : []), ...answers.clickupExtraLists.flatMap((id) => ['--list', id])];
}

/** Did the switch check say it is safe? Exit 0 and its last word, `Safe to switch.` */
export function safeToSwitch(r) {
  return r.code === 0 && /Safe to switch\./.test(String(r.out || ''));
}
