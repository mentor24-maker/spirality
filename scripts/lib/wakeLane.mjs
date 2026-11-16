#!/usr/bin/env node
/**
 * wakeLane.mjs — start a loop job's next pass now, instead of at its timer
 * (SP-219).
 *
 *   node scripts/lib/wakeLane.mjs loop-build    → writes the lane's wake file
 *   node scripts/lib/wakeLane.mjs relay         → launchctl kickstart (no -k)
 *
 * The build, review and intake lanes are one long-lived runner each
 * (scripts/loop_runner.sh) that sleeps between passes. Killing it to start a
 * pass would kill a pass in the middle, so a lane is woken by a file,
 * `<logDir>/<projectSlug>-<lane>.wake`, named like its lock: the runner's
 * sleep looks for it every few seconds and starts the next pass when it
 * appears. A wake sent during a pass is kept, and the next pass starts as
 * soon as that one ends.
 *
 * The relay is one pass per launchd start, so it is woken with
 * `launchctl kickstart` WITHOUT `-k`, which never starts a second copy of a
 * running job. A relay pass already holding its lock (scripts/run_relay.sh)
 * is left alone and said so; that pass reads the tracker afresh anyway.
 * launchd starts the relay on a one-minute tick that skips until its wake
 * time is up (SP-236), so the kickstart is preceded by the relay's own wake
 * file, `<logDir>/<projectSlug>-relay.wake`: the tick it starts sees the file
 * and runs a pass, and should the kickstart fail, the next tick does.
 *
 * The timers stay as they are, as the fallback. Every name comes from the
 * project config (CLAUDE.md engineering rule 2).
 *
 * Exit 0 woken (one line saying how), 1 the wake could not be sent (one line
 * saying why), 2 not a job this knows.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { INTERVALS } from './loopSchedule.mjs';
import { loadProjectConfig, ProjectConfigError } from '../../lib/projectConfig.mjs';

export const RELAY = 'relay';
/** Every job with a schedule, the lanes and the relay. */
export const JOBS = Object.freeze(Object.keys(INTERVALS));

const expandHome = (p) => (/^~(\/|$)/.test(p) ? p.replace(/^~/, homedir()) : p);

/** The live pid holding `<lock>/pid`, or null. */
function lockHolder(lock, isAlive) {
  let pid;
  try {
    pid = Number(readFileSync(join(lock, 'pid'), 'utf8').trim());
  } catch {
    return null;
  }
  return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : null;
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function defaultLaunchctl(args) {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' });
  return { status: r.status, output: `${r.stdout || ''}${r.stderr || ''}${r.error ? r.error.message : ''}`.trim() };
}

/**
 * Wake `job`. Returns { code, line }: the exit code and the one line to print.
 * `launchctl(args)` and `isAlive(pid)` are stand-ins for tests.
 */
export function wakeLane(job, {
  config, now = new Date(), uid = process.getuid?.(), launchctl = defaultLaunchctl, isAlive = defaultIsAlive,
} = {}) {
  if (!JOBS.includes(job)) {
    return { code: 2, line: `wakeLane: "${job ?? ''}" is not a loop job — one of: ${JOBS.join(', ')}` };
  }
  const logDir = expandHome(config.logDir);
  const slug = config.projectSlug;

  if (job === RELAY) {
    const lock = join(logDir, `${slug}-${RELAY}.lock`);
    const pid = lockHolder(lock, isAlive);
    if (pid) return { code: 0, line: `relay: a pass is already running (pid ${pid}) — not starting a second; it reads the tracker afresh` };
    const relayWake = join(logDir, `${slug}-${RELAY}.wake`);
    try {
      writeFileSync(relayWake, `${now.toISOString()}\n`);
    } catch (err) {
      return { code: 1, line: `relay: NOT WOKEN — the wake file ${relayWake} could not be written (${err.code || err.message}), so a kickstart's tick would skip` };
    }
    const target = `gui/${uid}/${config.launchdPrefix}.${RELAY}`;
    const r = launchctl(['kickstart', target]);
    if (r.status !== 0) {
      return { code: 1, line: `relay: NOT WOKEN — launchctl kickstart ${target} exited ${r.status ?? 'without a code'}${r.output ? ` (${r.output.split('\n')[0]})` : ''}; the wake file ${relayWake} is written, so the next tick runs a pass` };
    }
    return { code: 0, line: `relay: woken — launchctl kickstart ${target} started a pass` };
  }

  const wake = join(logDir, `${slug}-${job}.wake`);
  try {
    writeFileSync(wake, `${now.toISOString()}\n`);
  } catch (err) {
    return { code: 1, line: `${job}: NOT WOKEN — the wake file ${wake} could not be written (${err.code || err.message})` };
  }
  const runner = lockHolder(join(logDir, `${slug}-${job}.lock`), isAlive);
  // Read back (engineering rule 5): a running runner may already have taken
  // it, which is a wake that worked, so only a write that never landed fails.
  if (!existsSync(wake) && !runner) {
    return { code: 1, line: `${job}: NOT WOKEN — the wake file ${wake} is not there after writing it, and no runner holds the lane's lock` };
  }
  if (!runner) {
    return { code: 0, line: `${job}: wake file written (${wake}), but no runner holds the lane's lock — the lane's next start will run it` };
  }
  return { code: 0, line: `${job}: woken — wake file ${wake} written; runner pid ${runner} starts its next pass within seconds, or as soon as the one running ends` };
}

/** Run as a command, also through a link to this file (a real path both sides). */
function runAsCommand() {
  try {
    return Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (runAsCommand()) {
  const job = process.argv[2];
  if (!job || job === '--help') {
    console.error(`usage: node scripts/lib/wakeLane.mjs <job>\n  jobs: ${JOBS.join(', ')}`);
    process.exit(2);
  }
  let config;
  try {
    config = loadProjectConfig();
  } catch (err) {
    if (!(err instanceof ProjectConfigError)) throw err;
    console.error(`${job}: NOT WOKEN — the project config is not usable (${err.message})`);
    process.exit(1);
  }
  const { code, line } = wakeLane(job, { config });
  (code === 0 ? console.log : console.error)(line);
  process.exit(code);
}
