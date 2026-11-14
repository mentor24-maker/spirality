#!/usr/bin/env node
/**
 * `npm run stale-ready` — a ticket stuck in `Ready to launch`, and WHOSE hands
 * it actually needs (SP-267, moved from StarCaster's scripts/stale_ready.mjs).
 *
 * `Ready to launch` is operator-held: the loops never touch it on purpose,
 * and the merge step re-declines a red pull request forever without ever
 * escalating. StarCaster's 86bbkw1mn sat there six days with the merge word
 * already given, blocked on one failing test out of 1,846. The full story,
 * and why the ACTOR matters more than the alarm, is in lib/staleReady.js.
 *
 *   npm run stale-ready                        read everything, print the report, post nothing
 *   npm run stale-ready -- --check             the same, and post to the bus if anything is stuck
 *   npm run stale-ready -- --check --dry-run   say what it WOULD post, send nothing
 *   npm run stale-ready -- --check --force     ignore the hourly read throttle
 *
 * TWO CLOCKS. A ticket untouched in `Ready to launch` has 24 hours (the
 * pulse's own threshold, lib/pulse.js). A ticket carrying the operator's own
 * merge word has two, measured from that comment rather than from ticket
 * age. `--stale-after-hours` and `--approved-after-hours` override them for a
 * rehearsal; the relay passes neither.
 *
 * Exit codes. Without --check, the verdict (StarCaster's ladder):
 *   0  nothing is stuck
 *   1  at least one ticket is stuck, whoever it turns out to be on
 *   2  CANNOT TELL: a reading the verdict needed could not be taken
 * With --check, whether the check did its job, so the relay can tell a
 * stuck ticket (said on the bus, the job done) from a failure:
 *   0  read, and every finding due was posted (or was already said)
 *   1  a bus post failed (not stamped, so the next pass tries again)
 *   2  the tickets could not be read at all, or the project has no bus
 *
 * Tickets and comments come through Spirality's door (scripts/lib/
 * watchdogDoor.mjs), pull requests through `gh` against the config's
 * `githubRepo`, the operator's seat and name from the project config. The
 * suppression stamps live in the project's log folder, named for the project
 * (`<logDir>/<slug>-ready-stale/`), because a stamp records what THIS
 * machine has said, which must survive a worktree being removed.
 *
 * Run by scripts/run_relay.sh on every wake (scripts/lib/relay_watchdogs.sh);
 * nothing here can fail the relay.
 */
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectConfig, namedProjectFolder } from '../lib/projectConfig.mjs';
import { laneFile } from './lib/laneFiles.mjs';
import * as door from './lib/watchdogDoor.mjs';

const require = createRequire(import.meta.url);
const staleReady = require('../lib/staleReady.js');
const { findPullRequest, mergeDecision, checkState } = require('../lib/mergeOnComment.js');

/**
 * The last time a READING was taken, which is a different question from the
 * last time one was posted. The relay wakes every ten minutes; this check
 * costs a full ticket read plus a `gh pr view` per stale ticket, to watch a
 * signal whose window is 24 HOURS. Once an hour is ample. A hand-run
 * `npm run stale-ready` is never throttled.
 */
export const READ_EVERY_MS = 60 * 60 * 1000;

/** The node a finding is reported by: this machine's short name. */
function nodeName() {
  return String(hostname() || '').split('.')[0] || 'an unnamed machine';
}

/** One PR's state and every check on it. `state: null` means "could not tell". */
export function prSnapshot(number, { repo, run = spawnSync } = {}) {
  const args = ['pr', 'view', String(number), '--json', 'state,statusCheckRollup'];
  if (repo) args.push('--repo', repo);
  const out = run('gh', args, { encoding: 'utf8', timeout: 60_000 });
  if (out.error) {
    const why = out.error.code === 'ENOENT' ? 'the `gh` command is not installed on this machine' : String(out.error.message);
    return { state: null, checks: null, why };
  }
  if (out.status !== 0) {
    return { state: null, checks: null, why: String(out.stderr || '').trim().split('\n')[0].slice(0, 160) || 'gh failed' };
  }
  try {
    const json = JSON.parse(String(out.stdout || ''));
    return { state: String(json.state || '').toUpperCase() || null, checks: checkState(json.statusCheckRollup), why: null };
  } catch {
    return { state: null, checks: null, why: 'gh returned output that is not JSON' };
  }
}

/** Suppression stamps in one folder, one file per `<ticket>:<reason>` key. */
export function folderStamps(dir) {
  const fileOf = (key) => join(dir, `${String(key).replace(/[^a-z0-9:-]/gi, '-')}.stamp`);
  return {
    readAll() {
      const stamps = new Map();
      let entries = [];
      try { entries = readdirSync(dir); } catch { return stamps; }
      for (const file of entries) {
        if (!file.endsWith('.stamp')) continue;
        // An unreadable stamp reads as "never posted", which errs towards posting.
        try { stamps.set(file.replace(/\.stamp$/, ''), readFileSync(join(dir, file), 'utf8').trim()); } catch { /* see above */ }
      }
      return stamps;
    },
    write(key, at) {
      try { mkdirSync(dir, { recursive: true }); writeFileSync(fileOf(key), `${at}\n`); return null; } catch (err) { return String(err?.message || err); }
    },
    clear(keys) {
      for (const key of keys || []) {
        try { rmSync(fileOf(key), { force: true }); } catch { /* nothing to clear */ }
      }
    },
  };
}

/** A one-line file holding an ISO time: the read throttle. */
export function fileClock(file) {
  return {
    read() { try { return readFileSync(file, 'utf8').trim(); } catch { return ''; } },
    // A throttle that cannot be recorded costs a re-read, never a missed finding.
    write(at) { try { writeFileSync(file, `${at}\n`); } catch { /* see above */ } },
  };
}

function numberFlag(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  const raw = i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : String(fallback);
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * One pass. Every read and write is handed in, so a test drives the whole
 * of it without a tracker, GitHub or the bus.
 *
 *   config        the project config (operatorUserId, busProject, githubRepo)
 *   readTickets   () => { tasks, commentsById }, throws on a failed read
 *   prSnapshot    (number) => { state, checks, why }
 *   paused        () => { paused, why }
 *   post          (text) => { ok, why }
 *   stamps        folderStamps(...)-shaped
 *   readClock     fileClock(...)-shaped
 */
export function runStaleReady({
  argv = [], config, now = Date.now(), readTickets, prSnapshot: snapshot, paused, post, stamps, readClock,
  node = 'an unnamed machine', out = console.log,
}) {
  const flag = (name) => argv.includes(`--${name}`);
  const CHECK = flag('check');
  const DRY = flag('dry-run');
  const FORCE = flag('force');
  const staleAfterHours = numberFlag(argv, 'stale-after-hours', staleReady.STALE_AFTER_HOURS);
  if (staleAfterHours == null) { out('--stale-after-hours must be a number of hours.'); return 2; }
  const approvedAfterHours = numberFlag(argv, 'approved-after-hours', staleReady.APPROVED_STALE_AFTER_HOURS);
  if (approvedAfterHours == null) { out('--approved-after-hours must be a number of hours.'); return 2; }
  const operatorId = Number(config.operatorUserId);

  if (CHECK && !config.busProject) {
    out(`stale-ready --check: ${config.projectSlug || 'this project'} names no busProject in its project config, so there is nowhere to post. Nothing was read or posted.`);
    return 2;
  }

  if (CHECK && !FORCE && !staleReady.dueAgain({ lastAt: readClock.read(), now, everyMs: READ_EVERY_MS })) {
    out('stale-ready: read within the last hour, not asking the tracker or GitHub again. '
      + '(`--force` takes a fresh reading; a hand-run `npm run stale-ready` is never throttled.)');
    return 0;
  }

  let read;
  try {
    read = readTickets();
  } catch (err) {
    // No tickets, no verdict: said out loud and exited 2, never as "all quiet".
    out(`CANNOT TELL: the tracker's tickets could not be read: ${String(err?.message || err).slice(0, 300)}`);
    out('Nothing about Ready to launch is known this pass. This is not an all-clear.');
    return 2;
  }

  // The reading happened, so the hourly clock restarts here whatever the
  // verdict: stamping only on a healthy one would re-read a stuck ticket on
  // every wake.
  if (CHECK && !DRY) readClock.write(new Date(now).toISOString());

  const ready = read.tasks.filter((t) => String(t?.status?.status || '').trim().toLowerCase() === staleReady.READY_STAGE);
  const records = [];
  for (const task of ready) {
    const id = String(task.id);
    const updated = Number(task.date_updated);
    const base = {
      taskId: id,
      name: task.name,
      url: task.url,
      hours: Number.isFinite(updated) && updated > 0 ? (now - updated) / staleReady.MS_PER_HOUR : NaN,
    };
    // The comments are read for EVERY ticket in the stage: the short fuse
    // cannot be applied without knowing whether the merge word was given.
    const comments = read.commentsById.get(id);
    if (!comments) { records.push({ ...base, commentsReadable: false }); continue; }

    const approvedAt = staleReady.liveApprovalAt(comments, { operatorId });
    if (approvedAt > 0) base.approvedHours = (now - approvedAt) / staleReady.MS_PER_HOUR;

    const clock = staleReady.stalenessClock(base, { staleAfterHours, approvedAfterHours });
    if (!Number.isFinite(clock.hours) || clock.hours <= clock.thresholdHours) {
      records.push({ ...base, commentsReadable: true });
      continue;
    }

    const pr = findPullRequest(comments);
    if (!pr) { records.push({ ...base, commentsReadable: true, pr: null }); continue; }

    const snap = snapshot(pr.number);
    const decision = mergeDecision({ status: task.status?.status, comments, operatorId });
    records.push({
      ...base,
      commentsReadable: true,
      pr: { number: pr.number, url: pr.url },
      prReadable: Boolean(snap.state),
      prReadError: snap.why,
      prState: snap.state,
      checks: snap.checks,
      // 'merge' means the word is live and valid; 'refuse' means it is there
      // and the merge step will not act on it. Either way the operator spoke.
      mergeWordGiven: decision.act === 'merge' || decision.act === 'refuse',
    });
  }

  const { findings, fresh, unmeasured } = staleReady.readyFindings(records, { staleAfterHours, approvedAfterHours });
  out(staleReady.renderReport({ findings, fresh, unmeasured, readyCount: ready.length, staleAfterHours, approvedAfterHours }));

  if (!CHECK) return staleReady.exitCodeFor(findings);

  // A ticket that is no longer stuck (or no longer in the stage) loses its
  // stamps, so the next time it sticks it is said at once.
  const stuckIds = new Set(findings.map((f) => String(f.taskId)));
  const all = stamps.readAll();
  const stale = [...all.keys()].filter((key) => !stuckIds.has(staleReady.stampKeyTaskId(key)));
  if (!DRY) stamps.clear(stale);

  if (!findings.length) return 0;

  const p = paused();
  if (p.paused) {
    out('');
    out(`Not posting: the Settings page has the relay paused, or could not be read (${p.why}). The findings above still stand.`);
    return 0;
  }

  const { due, held } = staleReady.duePosts({ findings, stamps: all, now, everyMs: staleReady.REPOST_EVERY_MS });
  if (held.length) {
    out('');
    out(`${held.length} finding(s) already said on the bus within the last ${Math.round(staleReady.REPOST_EVERY_MS / 3600000)}h; not posting those again.`);
  }
  if (!due.length) return 0;

  const text = staleReady.renderStalePost({ findings: due, node, staleAfterHours, approvedAfterHours });
  if (DRY) {
    out('');
    out('--dry-run: this is what would go to the bus, and nothing was sent:');
    out('');
    out(text);
    return 0;
  }

  const sent = post(text);
  if (!sent.ok) {
    out('');
    out(`Could NOT post to the bus (${sent.why}). Not stamping it as sent, so the next pass tries again.`);
    return 1;
  }
  for (const f of due) {
    // Posted but not stamped: the next pass posts a duplicate. Noisy, and far
    // better than an unwritable folder silencing the alarm outright.
    const why = stamps.write(staleReady.postKey(f), new Date(now).toISOString());
    if (why) out(`Posted, but the suppression stamp for ${f.taskId} could not be written (${why}).`);
  }
  out('');
  out(`Posted ${due.length} finding(s) to the bus.`);
  return 0;
}

function main(argv) {
  const config = loadProjectConfig({ project: namedProjectFolder() });
  const code = runStaleReady({
    argv,
    config,
    readTickets: () => door.readTickets({ trackerUrl: config.trackerUrl }),
    prSnapshot: (n) => prSnapshot(n, { repo: config.githubRepo }),
    paused: () => door.pausedNow(),
    post: (text) => door.postToBus(text),
    stamps: folderStamps(laneFile(config, 'ready-stale')),
    readClock: fileClock(laneFile(config, 'ready-stale-read.stamp')),
    node: nodeName(),
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
