#!/usr/bin/env node
/**
 * heartbeat.mjs — is each of this project's lanes still running? (SP-266)
 *
 *   npm run heartbeat              one line per lane: its last pass, in Mountain
 *                                  time, and running / QUIET / paused / not
 *                                  installed / cannot tell. Posts nothing.
 *   npm run heartbeat -- --check   the same, then one alarm on the bus per lane
 *                                  that has gone quiet (at most once every 6
 *                                  hours per lane), and one closing line when a
 *                                  lane reported quiet runs again.
 *
 * scripts/run_relay.sh runs `--check` after the relay part of every pass.
 *
 * The decisions are lib/heartbeat.js (pure, moved from StarCaster's
 * lib/nodeHeartbeat.js). This file is the IO: it reads each lane's log in the
 * project's log folder, asks the Settings page (through the door's `settings`
 * command) for each lane's wake time and pause switches, and posts through the
 * door's `bus-post`. Every name comes from the project config: the lanes from
 * lib/onboardLanes.mjs LANES, the log folder and slug, the launchd prefix that
 * says whether a lane is installed, and the bus project (CLAUDE.md rule 2).
 *
 * Exit codes:
 *   0  done (every lane read; with --check, every post that was due landed)
 *   1  a post to the bus did not land (said by name; the next wake tries again)
 *   2  --check with no `busProject` in the project config: nowhere to post
 *   3  without --check: at least one lane is QUIET
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, realpathSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectConfig, namedProjectFolder } from '../lib/projectConfig.mjs';
import { LANES } from '../lib/onboardLanes.mjs';
import { laneFile } from './lib/laneFiles.mjs';
import { intervalOf } from './lib/loopSchedule.mjs';
import { defaultRead as readSettingsFromDoor, wakeFrom } from './lib/wakeSetting.mjs';

const require = createRequire(import.meta.url);
const hb = require('../lib/heartbeat.js');
const { mountainTime } = require('../lib/trackerBus.js');
const { settingsPauseVerdict } = require('../lib/pipelinePause.js');

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** How long a pass may run before its runner stops it, as the runners set it. */
export function passLimitMs(lane, env = process.env) {
  const raw = lane === 'relay' ? env.RELAY_PASS_LIMIT_SECONDS : env.LOOP_PASS_LIMIT_SECONDS;
  const n = /^[0-9]+$/.test(String(raw ?? '')) ? Number(raw) : (lane === 'relay' ? 480 : 7200);
  return n * 1000;
}

/**
 * The Settings page's answer for one lane, from the `settings` command's
 * `name=value` lines: `{ intervalMs, intervalFrom, paused, pausedWhy }`.
 *
 * `paused` is the runners' own verdict (lib/pipelinePause.js
 * settingsPauseVerdict, which scripts/pause_check.sh asks through the door),
 * so the heartbeat and the lane never disagree: a page that cannot be read,
 * or that lacks a lane's switch, is PAUSED to the runner (it fails safe), so
 * the lane is deliberately not starting and is never called quiet here. A
 * lane the project config names in `projectLanes` (pass them in) obeys the
 * whole-pipeline switch alone while it has no switch of its own, as the
 * runner's pause-check reads it. Bus
 * posts go through the same tracker, so an outage that hides the page could
 * not carry an alarm either. The interval falls back to the lane's default
 * (scripts/lib/loopSchedule.mjs), as the lanes themselves do.
 */
export function laneSettings(settings, lane, { projectLanes = [] } = {}) {
  const ok = Boolean(settings && settings.ok);
  const controls = ok
    ? String(settings.text).split('\n').map((l) => l.trim()).filter((l) => l.includes('='))
      .map((l) => ({ key: l.slice(0, l.indexOf('=')), value: l.slice(l.indexOf('=') + 1) }))
    : [];
  const verdict = settingsPauseVerdict(ok ? { ok: true, controls } : { ok: false, why: (settings && settings.why) || 'the Settings page could not be read' }, lane, { projectLanes });
  const pause = { paused: verdict.paused, pausedWhy: verdict.paused ? verdict.line : null };
  const { seconds } = ok ? wakeFrom(settings.text, lane) : {};
  return seconds
    ? { intervalMs: seconds * 1000, intervalFrom: 'the Settings page', ...pause }
    : { intervalMs: intervalOf(lane) * 1000, intervalFrom: 'the default', ...pause };
}

/** How much of the end of a lane log is read first: the newest dated line is near the end. */
export const LOG_TAIL_BYTES = 512 * 1024;

/**
 * A lane's log, the end of it first (SP-266 review): the build and review
 * logs are never rotated, and the heartbeat runs every relay wake. When the
 * tail holds no dated line for the lane (a long pass's output pushed its
 * START further back), the whole file is read, so a running pass is never
 * missed for being long.
 */
export function readLaneLog(file, lane, { tailBytes = LOG_TAIL_BYTES } = {}) {
  if (!existsSync(file)) return { readable: true, text: '' };
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    if (size > tailBytes) {
      const buf = Buffer.alloc(tailBytes);
      const got = readSync(fd, buf, 0, tailBytes, size - tailBytes);
      const tail = buf.subarray(0, got).toString('utf8');
      // The first line of the tail may be cut part-way; drop it.
      const text = tail.slice(tail.indexOf('\n') + 1);
      if (hb.lastBeatFromLog(text, lane).found) return { readable: true, text };
    }
    return { readable: true, text: readFileSync(file, 'utf8') };
  } catch (e) {
    return { readable: false, why: e.code || e.message };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Forget a lane's "said quiet" stamp. Only "already gone" is fine: a stamp
 * that stays would repeat the "running again" post on every wake, so any
 * other error is thrown for the caller to report as a failure.
 */
export function clearStamp(file) {
  try { unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

/** A stamp file's ISO time, or null (missing or empty). */
function readStamp(file) {
  try { return readFileSync(file, 'utf8').trim() || null; } catch { return null; }
}

/**
 * One heartbeat run. Every piece of IO is passed in, so the tests drive it
 * with a fixture log folder and a stand-in for the bus.
 *
 *   config     the project config (projectSlug, logDir, launchdPrefix, busProject)
 *   check      true for --check
 *   now        the clock, in milliseconds
 *   readLog    (lane) -> { readable, text, why }
 *   installed  (lane) -> boolean
 *   settings   { ok, text } | { ok: false, why }
 *   post       (text) -> { ok, why }
 *   stamps     { read(lane), write(lane, iso), clear(lane) }
 *   env        for the pass limits
 *   out, err   line printers
 */
export function runHeartbeat({ config, check = false, now = Date.now(), readLog, installed, settings, post, stamps, env = process.env, out = console.log, err = console.error }) {
  const project = config.projectSlug;
  const when = (iso) => mountainTime(Date.parse(iso));
  const rows = [];
  const emitters = {};
  const entries = [];
  for (const lane of LANES) {
    const set = laneSettings(settings, lane, { projectLanes: config.projectLanes ?? [] });
    if (!installed(lane)) { rows.push({ lane, word: 'not installed', note: `no launchd job ${config.launchdPrefix}.${lane}` }); continue; }
    if (set.paused) { rows.push({ lane, word: 'paused', note: `${set.pausedWhy}; a quiet log is expected` }); continue; }
    const log = readLog(lane);
    const beat = !log.readable
      ? { readable: false, found: false, why: log.why }
      : (() => {
        const b = hb.lastBeatFromLog(log.text, lane, { now, passLimitMs: passLimitMs(lane, env) });
        return b.found ? { readable: true, found: true, beat: b } : { readable: true, found: false };
      })();
    emitters[lane] = { intervalMs: set.intervalMs, beatMeans: 'liveness' };
    entries.push({ role: lane, beat, set });
    rows.push({ lane, entry: entries[entries.length - 1] });
  }
  const report = hb.recencyReport({ entries, now, emitters });
  const verdictOf = (lane) => report.quiet.find((q) => q.role === lane)
    || report.fresh.find((f) => f.role === lane)
    || report.unknown.find((u) => u.role === lane);

  const width = Math.max(...LANES.map((l) => l.length));
  for (const row of rows) {
    const name = row.lane.padEnd(width);
    if (!row.entry) { out(`${name}  ${row.word} (${row.note})`); continue; }
    const v = verdictOf(row.lane);
    const b = row.entry.beat.beat;
    const last = b ? `last pass ${when(b.lastLineAt)}` : 'no pass yet';
    if (report.quiet.includes(v)) {
      out(`${name}  ${last}  QUIET (${v.reason}; quiet after ${hb.durationText(v.thresholdMs)})`);
    } else if (report.fresh.includes(v)) {
      out(`${name}  ${last}  running${b.running ? ' (a pass is under way)' : ''}`);
    } else {
      out(`${name}  ${last}  cannot tell (${v.why})`);
    }
  }
  if (!config.busProject) out(`${project} has no busProject in its project config, so there is nowhere to post an alarm.`);

  if (!check) return report.quiet.length ? 3 : 0;
  if (!config.busProject) {
    err(`heartbeat --check: ${project} names no busProject in its project config, so it has nowhere to post. Nothing was posted.`);
    return 2;
  }

  let failed = 0;
  // Closing an alarm: only a lane that was reported quiet, and has written a
  // dated line since that report, gets one line saying it runs again.
  for (const f of report.fresh) {
    const since = stamps.read(f.role);
    if (!since) continue;
    const lineAt = entries.find((e) => e.role === f.role).beat.beat.lastLineAt;
    if (!(Date.parse(lineAt) > Date.parse(since)) && Number.isFinite(Date.parse(since))) continue;
    const said = post(hb.renderRecoveredPost({ role: f.role, project, quietSince: since, when }));
    if (said.ok) {
      try {
        stamps.clear(f.role);
        out(`heartbeat: ${f.role} was reported quiet at ${when(since)} and runs again: said so on the bus.`);
      } catch (e) {
        failed++;
        err(`heartbeat: ${f.role} runs again and the bus was told, but forgetting its quiet report FAILED (${e.code || e.message}), so the next wake will say it again.`);
      }
    } else {
      failed++;
      err(`heartbeat: ${f.role} runs again, but the bus post saying so FAILED (${said.why}); its quiet report stands and the next wake tries again.`);
    }
  }
  // One alarm per quiet lane, at most once every 6 hours per lane. The stamp
  // is written only after the post read back, so a post that did not land
  // never silences the alarm.
  for (const q of report.quiet) {
    if (!hb.dueAgain({ lastAt: stamps.read(q.role), now, everyMs: hb.REPOST_EVERY_MS })) {
      out(`heartbeat: ${q.role} is still quiet; already said on the bus at ${when(stamps.read(q.role))}, not again until 6 hours after that.`);
      continue;
    }
    const said = post(hb.renderStalePost({ quiet: [q], project, now, when }));
    if (said.ok) {
      out(`heartbeat: ${q.role} is quiet: posted the alarm to the bus.`);
      try {
        stamps.write(q.role, new Date(now).toISOString());
      } catch (e) {
        failed++;
        err(`heartbeat: the alarm about ${q.role} was posted, but marking it as said FAILED (${e.code || e.message}), so the next wake will post it again.`);
      }
    } else {
      failed++;
      err(`heartbeat: ${q.role} is quiet, and the bus post FAILED (${said.why}). Not marked as said, so the next wake tries again.`);
    }
  }
  return failed ? 1 : 0;
}

/** The real IO, for the command. */
function main(argv) {
  const check = argv.includes('--check');
  const config = loadProjectConfig({ project: namedProjectFolder() });
  const home = homedir();
  const logOf = (lane) => laneFile(config, `${lane}.log`, { home });
  const stampOf = (lane) => laneFile(config, `heartbeat-quiet-${lane}`, { home });
  const read = readSettingsFromDoor();
  const settings = read.status === 0 ? { ok: true, text: read.stdout } : { ok: false, why: `the settings read exited ${read.status}` };
  if (!settings.ok) console.error(`heartbeat: could not read the Settings page (${settings.why}): the lanes treat that as paused (they fail safe), so no lane is judged this wake.`);
  const code = runHeartbeat({
    config,
    check,
    readLog: (lane) => readLaneLog(logOf(lane), lane),
    installed: (lane) => existsSync(join(home, 'Library', 'LaunchAgents', `${config.launchdPrefix}.${lane}.plist`)),
    settings,
    post: (text) => {
      const r = spawnSync('npm', ['run', '--silent', 'clickup', '--', 'bus-post', '--body-file', '-'], { cwd: REPO, input: text, encoding: 'utf8', timeout: 60_000 });
      if (r.status === 0) return { ok: true };
      const said = String(r.stderr || r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
      return { ok: false, why: `bus-post exited ${r.status ?? (r.error && r.error.code) ?? 'without a code'}${said ? `: ${said.slice(0, 200)}` : ''}` };
    },
    stamps: {
      read: (lane) => readStamp(stampOf(lane)),
      write: (lane, iso) => { mkdirSync(dirname(stampOf(lane)), { recursive: true }); writeFileSync(stampOf(lane), `${iso}\n`); },
      clear: (lane) => clearStamp(stampOf(lane)),
    },
  });
  process.exit(code);
}

function runAsCommand() {
  try {
    return Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (runAsCommand()) main(process.argv.slice(2));
