/**
 * The setup wizard's steps for a project that already runs a loop on
 * ClickUp (SP-159): WaveCenter and StarCaster, each with its own older copy
 * of the loop, its own lanes on the Mini and its tickets in a ClickUp Loop
 * Queue. One wizard run moves such a project, in the order the runbook
 * gives (docs/TRACKER_MVP.md, "Switching a project over"):
 *
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

/** The four steps, in the order they run, all before the copy step. */
export const CLICKUP_STEPS = Object.freeze(['stop', 'snapshot', 'import', 'switch-check']);

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
 * asked. The first is asked once; the other two only when it names a list.
 */
export const CLICKUP_FIELDS = Object.freeze([
  { key: 'clickupListId', question: 'Does this project already run a loop on ClickUp? Its Loop Queue list id (digits), or Enter for no' },
  { key: 'clickupOperatorId', question: 'Your own ClickUp user id, so your old comments are filed under you (the old loop\'s scripts/clickup.mjs names it)', required: true },
  { key: 'clickupExtraLists', question: 'Other ClickUp lists to keep a copy of, as list ids (comma between)', list: true, fallback: () => 'none' },
]);

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
 * log it names (`log:      <path> (...)`). StarCaster's, WaveCenter's and
 * Spirality's installers all print these lines.
 */
export function readInstallerStatus(text) {
  const jobs = [];
  let job = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const head = /^── (\S+)\s*$/.exec(line);
    if (head) { job = { name: head[1], loaded: false, label: null, log: null }; jobs.push(job); continue; }
    if (!job) continue;
    const loaded = /^loaded:\s+yes\b(.*)$/.exec(line);
    if (loaded) {
      job.loaded = true;
      const words = loaded[1].replace(/^\s*—\s*/, '').trim().split(/\s+/).filter(Boolean);
      job.label = words.length >= 3 ? words.at(-1) : null;
    }
    const log = /^log:\s+(\S+)/.exec(line);
    if (log) job.log = log[1];
  }
  return jobs;
}

/**
 * Is a pass in flight, by its lane's log? The runners write
 * `===== <time> START /<lane> ...` before a pass and `===== <time> END ...`
 * after it, so a START with no END after it is a pass still running.
 * Returns { running, started } (started: the START line's time), or null
 * when the log has no pass to read.
 */
export function passInFlight(logText) {
  const lines = String(logText || '').split('\n');
  let start = -1;
  let end = -1;
  lines.forEach((l, i) => {
    if (/^===== .* START /.test(l)) start = i;
    else if (/^===== .* END /.test(l)) end = i;
  });
  if (start < 0) return null;
  const stamp = /^===== (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(lines[start]);
  return { running: start > end, started: stamp ? stamp[1] : null };
}

/** Where the switch settings file is kept: `<logDir>/onboard/<slug>-switch/`, beside the answers file. */
export function switchDir(onboardFolder, slug) {
  return join(onboardFolder, `${slug}-switch`);
}

/**
 * The switch settings file: the project's new settings file (`settings`, as
 * read from the scratch settings file) with its ClickUp list and the
 * operator's ClickUp seat put back, which the importer files his comments
 * under, and the tracker home's data folder, where the snapshot is kept and
 * the database is. Checked by the same rules every settings file is.
 */
export function switchSettings(settings, answers, homeConfig) {
  const next = {
    ...settings,
    loopQueueListId: answers.clickupListId,
    operatorUserId: answers.clickupOperatorId,
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
