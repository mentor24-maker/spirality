#!/usr/bin/env node
/**
 * `npm run stale-answer` — the operator answered a `Needs your input` card,
 * and NOTHING MOVED (SP-267, moved from StarCaster's scripts/stale_answer.mjs).
 *
 * StarCaster's 86bbv8nvy: Dane answered at 09:40, the relay ran out of budget
 * before it could hand the ticket back, and it sat in `Needs your input` for
 * three and a half hours until he found it himself. The relay's hand-back is
 * the fix; this is the alarm for every reason it might still not happen (a
 * dead relay, a bug nobody has found yet). The reasoning is in
 * lib/staleAnswer.js.
 *
 *   npm run stale-answer                        read everything, print the report, post nothing
 *   npm run stale-answer -- --check             the same, and post to the bus if an answer sits unacted on
 *   npm run stale-answer -- --check --dry-run   say what it WOULD post, send nothing
 *   npm run stale-answer -- --check --force     ignore the 20-minute read throttle
 *
 * The threshold is three relay passes (30 minutes), derived in
 * lib/staleAnswer.js; `--stale-after-minutes` overrides it for a rehearsal,
 * and the relay never passes it.
 *
 * Exit codes are stale-ready's (scripts/stale_ready.mjs): without --check the
 * verdict (0 nothing stuck, 1 an answer sits unacted on, 2 CANNOT TELL); with
 * --check whether the job was done (0 done, 1 a bus post failed, 2 the
 * tickets could not be read or there is no bus).
 *
 * "Has he answered?" is decided by `handbackAnswer` (lib/relayLane.js), the
 * same function the relay hands a ticket back on: two readers of that
 * question would be two definitions, and the quiet way they fail is this
 * report saying all-clear about the very ticket the relay will not move.
 *
 * Spirality's relay writes no reply-thread markers (it has no party line), so
 * there is no "was it delivered" to read: StarCaster's own tracker copy
 * answered "could not check" every time, and so does this one, by never
 * asking. A finding therefore always says the hand-back is failing, never
 * that the answer went undelivered.
 */
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadProjectConfig, namedProjectFolder } from '../lib/projectConfig.mjs';
import { laneFile } from './lib/laneFiles.mjs';
import * as door from './lib/watchdogDoor.mjs';
import { fileClock, folderStamps } from './stale_ready.mjs';

const require = createRequire(import.meta.url);
const staleAnswer = require('../lib/staleAnswer.js');
const staleReady = require('../lib/staleReady.js');
const busRelayPlan = require('../lib/busRelayPlan.js');
const { handbackAnswer } = require('../lib/relayLane.js');
const { isMachineAuthored } = require('../lib/machineComment.js');

/**
 * TWENTY MINUTES between readings, tighter than stale-ready's hour on
 * purpose: the window watched is thirty minutes, so an hourly read could
 * report a thirty-minute miss an hour late. The relay wakes every ten
 * minutes, so this is one reading every other wake. A hand-run
 * `npm run stale-answer` is never throttled.
 */
export const READ_EVERY_MS = 20 * 60 * 1000;

function nodeName() {
  return String(hostname() || '').split('.')[0] || 'an unnamed machine';
}

/**
 * One pass, every read and write handed in (see runStaleReady).
 */
export function runStaleAnswer({
  argv = [], config, now = Date.now(), readTickets, paused, post, stamps, readClock,
  node = 'an unnamed machine', out = console.log,
}) {
  const flag = (name) => argv.includes(`--${name}`);
  const CHECK = flag('check');
  const DRY = flag('dry-run');
  const FORCE = flag('force');
  const i = argv.indexOf('--stale-after-minutes');
  const raw = i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : String(staleAnswer.STALE_AFTER_MINUTES);
  const staleAfterMinutes = Number(raw);
  if (!Number.isFinite(staleAfterMinutes) || staleAfterMinutes < 0) {
    out(`--stale-after-minutes must be a number of minutes, not "${raw}".`);
    return 2;
  }
  const operatorId = Number(config.operatorUserId);

  if (CHECK && !config.busProject) {
    out(`stale-answer --check: ${config.projectSlug || 'this project'} names no busProject in its project config, so there is nowhere to post. Nothing was read or posted.`);
    return 2;
  }

  if (CHECK && !FORCE && !staleReady.dueAgain({ lastAt: readClock.read(), now, everyMs: READ_EVERY_MS })) {
    out(`stale-answer: read within the last ${READ_EVERY_MS / 60000} minutes, not asking the tracker again. `
      + '(`--force` takes a fresh reading; a hand-run `npm run stale-answer` is never throttled.)');
    return 0;
  }

  let read;
  try {
    read = readTickets();
  } catch (err) {
    out(`CANNOT TELL: the tracker's tickets could not be read: ${String(err?.message || err).slice(0, 300)}`);
    out('Nothing about Needs your input is known this pass. This is not an all-clear.');
    return 2;
  }
  if (CHECK && !DRY) readClock.write(new Date(now).toISOString());

  const parked = read.tasks.filter((t) => String(t?.status?.status || '').trim().toLowerCase() === staleAnswer.ANSWER_STAGE);
  const records = [];
  for (const task of parked) {
    const id = String(task.id);
    const base = { taskId: id, name: task.name, url: task.url };
    const comments = read.commentsById.get(id);
    if (!comments) { records.push({ ...base, commentsReadable: false }); continue; }

    // The SAME derivation the relay hands the ticket back on.
    const answered = handbackAnswer({ comments, operatorId, isMachine: isMachineAuthored });

    const newest = comments.reduce(
      (best, c) => (busRelayPlan.commentAt(c) > busRelayPlan.commentAt(best) ? c : best),
      comments[0] || null,
    );
    const operatorSpokeLast = busRelayPlan
      .operatorComments(newest ? [newest] : [], { operatorId, isMachine: isMachineAuthored }).length > 0;

    const at = answered.state === 'answered'
      ? answered.answerAt
      : (operatorSpokeLast ? busRelayPlan.commentAt(newest) : 0);
    records.push({
      ...base,
      commentsReadable: true,
      state: answered.state,
      operatorSpokeLast,
      answerMinutes: at > 0 ? (now - at) / staleAnswer.MS_PER_MINUTE : NaN,
    });
  }

  const { findings, fresh } = staleAnswer.answerFindings(records, { staleAfterMinutes });
  out(staleAnswer.renderReport({ findings, fresh, staleAfterMinutes, stageCount: parked.length }));

  if (!CHECK) return staleAnswer.exitCodeFor(findings);

  // A keep-list: every stamp goes except a ticket stuck right now, so one
  // that left the stage (the normal healthy ending) is said again at once if
  // it ever sticks again.
  const all = stamps.readAll();
  if (!DRY) stamps.clear(staleAnswer.stampsToClear([...all.keys()], findings.map((f) => String(f.taskId))));

  if (!findings.length) return 0;

  const p = paused();
  if (p.paused) {
    out('');
    out(`Not posting: the Settings page has the relay paused, or could not be read (${p.why}). The findings above still stand.`);
    return 0;
  }

  const { due, held } = staleAnswer.duePosts({ findings, stamps: all, now, everyMs: staleReady.REPOST_EVERY_MS });
  if (held.length) {
    out('');
    out(`${held.length} finding(s) already said on the bus within the last ${Math.round(staleReady.REPOST_EVERY_MS / 3600000)}h; not posting those again.`);
  }
  if (!due.length) return 0;

  const text = staleAnswer.renderStalePost({ findings: due, node, staleAfterMinutes });
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
    const why = stamps.write(staleAnswer.postKey(f), new Date(now).toISOString());
    if (why) out(`Posted, but the suppression stamp for ${f.taskId} could not be written (${why}).`);
  }
  out('');
  out(`Posted ${due.length} finding(s) to the bus.`);
  return 0;
}

function main(argv) {
  const config = loadProjectConfig({ project: namedProjectFolder() });
  const code = runStaleAnswer({
    argv,
    config,
    readTickets: () => door.readTickets({ trackerUrl: config.trackerUrl }),
    paused: () => door.pausedNow(),
    post: (text) => door.postToBus(text),
    stamps: folderStamps(laneFile(config, 'answer-stale')),
    readClock: fileClock(laneFile(config, 'answer-stale-read.stamp')),
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
