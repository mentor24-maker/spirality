#!/usr/bin/env node
/**
 * clickup.mjs — Spirality's one door into ClickUp: read the Loop Queue,
 * claim a ticket, move statuses, hand work to Dane and record the PR and
 * review trails. It talks to ClickUp's own REST API, never the claude.ai
 * connector (whose shared budget starves under loop traffic).
 *
 * A seed-sized copy of StarCaster's scripts/clickup_direct.mjs: the same
 * commands, the same guards, the same ids, with the StarCaster-only machinery
 * (bus relay, auto-merge lanes, pacing, heartbeat) left out until Spirality
 * needs it.
 *
 * Every ClickUp web address lives in scripts/tracker/clickupTracker.mjs, and
 * every address of the tracker's own API in scripts/tracker/apiTracker.mjs;
 * this file talks to the one the project config names (`tracker`, default
 * "clickup"), so the commands and their guards do not know which one it is.
 *
 * The token comes from the environment, never printed and never logged.
 * package.json wraps this in `doppler run` for the project config's
 * dopplerProject and dopplerConfig (scripts/with_doppler.mjs), so no agent or
 * human handles the value:
 *
 *   npm run clickup -- whoami
 *
 * Run `npm run clickup` bare for the command list. Data goes to stdout
 * (tab-separated where a caller would parse it); counts and diagnostics go to
 * stderr, so piping stdout is always safe.
 */

import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';
import { join as joinPath, basename, extname, resolve as resolvePath } from 'node:path';
import {
  DISPLAY, STAGE_ORDER, CLAIMABLE_BY_BUILD, OPERATOR_STATUSES, BUILDING, NEEDS_YOUR_INPUT, QUEUED, LIVE, PRIORITY_VALUE,
  isClaimableByBuild, isOperatorStatus, isReadyToLaunch, claimOrder, compareWithinStatus, statusOf, TERMINAL_STATUSES,
} from './lib/loopStatuses.mjs';
import {
  prOpenedComment, verdictComment, prTrailLanded, bodyNamesTicket,
  readyToLaunchGate, nextRound, wouldEscalate, roundSummaryLines, sendBackRounds, operatorSpokeLast,
  findPullRequest, newestFirst, ESCALATE_AT_ROUND,
} from './lib/loopTrail.mjs';
import { buildCard, cardSurvived, findBlockquoteLines, findBranchLinks, branchLinkRefusal, CONTEXT_MIN_WORDS, CONTEXT_MAX_WORDS } from './lib/operatorCard.mjs';
import { isMachineAuthored, isOperatorAuthored, stripMachineMarker } from './lib/machineComment.mjs';
import { parseHumanHours, findHumanHours } from '../lib/humanHours.js';
import { createClickupTracker } from './tracker/clickupTracker.mjs';
import { createApiTracker, trackerTokenEnv } from './tracker/apiTracker.mjs';
import { projectSeats } from './lib/expectedSecrets.mjs';
import { compareRepo, projectEditUrl } from './lib/repoCheck.mjs';
import { filedTrackerUrl, machineSenderTag } from '../lib/substrateConfig.js';
// The auto-merge lanes (SP-202): the pass, and the ledger's file IO.
import { runLanePass } from '../lib/relayAutoMerge.js';
import { readLedgerFile, saveLedgerIfReadable } from '../lib/autoMergeLedgerFile.js';
import { readLeaseFile, saveLeaseIfReadable } from '../lib/mergeWindowLeaseFile.js';
import { windowDecision } from '../lib/mergeWindowLease.js';

import { loadProjectConfig, ProjectConfigError } from '../lib/projectConfig.mjs';
// Spirality's releases (SP-265): what one is, and reading the tags.
import { isReleaseName, OWN_PROJECT_RELEASE, readReleaseTags, releaseRemote } from '../lib/releases.mjs';
// The merge lane's decisions (task 86bchpkxz). `mergeDecision` says whether
// Dane's word authorizes a merge, `githubGate` whether GitHub allows it; the
// notices pair the words he reads with the marker the next pass reads. All
// from the package, so every project's relay decides the same way.
import {
  mergeDecision, githubGate, isMergeCommand, MERGE_MARKER, parseMergeMarker,
  refusalNotice, refusalBusLine, conflictHandOffNotice, mergedNotice, alreadyMergedPlan, filesMadeLines, REFUSAL_CODES,
} from '../lib/mergeOnComment.js';
import {
  PR_VIEW_FIELDS, markerBookkeeping, recordBookkeeping, emptyBooks, mergeDestination, relayLine,
  handbackAnswer, handbackPlan, closePlan, conflictFilingPlan, CATCH_UP_WORKED_STATUSES,
  mergeWithPreMergeStep, commandLine, mergedBusLine, conflictBusLine, busAnnouncer, stalledHandOffPlan, remindStalledHandOff,
} from '../lib/relayLane.js';
import {
  conflictTicketName, conflictTicketBody, conflictTicketFiledComment, findConflictTicket, unstuckPullRequest, aheadConflictVerdict,
  stalledSummaryHeadline, catchUpClosePlan, fixupLiveNote,
} from '../lib/conflictWork.js';
import {
  handbackDoneText, handbackFailureText, repliesShowHandbackDone, repliesShowHandbackFailure, HANDBACK_FAILURE_MARKER,
  isCloseCommand, closeRefusedText, latestCloseRefusal,
} from '../lib/busRelayPlan.js';
// The bus, in the tracker (SP-24): StarCaster's alarm channel.
import trackerBus from '../lib/trackerBus.js';
import { FALLBACK_TASK_NAME } from '../lib/busFallback.js';
// Tickets as data for scheduled checks (SP-205).
import ticketsJson from '../lib/ticketsJson.js';
// Stage counts for StarCaster's weekly report (SP-206).
import stageCounts from '../lib/stageCounts.js';
// A ticket's `Waits on:` line (task 86bctfun6): the claim leaves it alone
// until every ticket it names is closed.
import { waitsOn, waitsOnText, holdReasons } from '../lib/waitsOn.js';
import waitingOnOperator from '../lib/waitingOnOperator.js';
import { ticketLine } from '../lib/clickupTicketLink.js';
// Telling in-flight tickets that main moved under them (task 86bctjffu).
import {
  checkBranch, branchContains, tellTickets, latestMainMoved,
} from '../lib/mainMoved.js';
import { parseRepoFromRemoteUrl } from '../lib/branchCatchUp.js';
// Keeping Ready to launch pull requests current after a merge (SP-294).
import { catchUpReadyTickets } from '../lib/readyCatchUp.js';
// A ticket left in Building by a build pass that died (SP-101).
import passClaim from '../lib/passClaim.js';
import { settingsPauseVerdict } from '../lib/pipelinePause.js';
import { capInForce, wipCheckVerdict, unknownVerdict } from '../lib/wipCheck.js';
import {
  BUILD_SKILL, buildLockPath, lockState, writesMarker, seatGate, handbackDestination, leftoverWorktrees, markerBlocksClaim, handbackNote,
} from '../lib/passHandback.js';

// ── The ids, written down once ───────────────────────────────────────────────
// They live in spirality.project.json at the repository root (see
// lib/projectConfig.mjs). Each is still overridable from the environment
// (CLICKUP_LOOP_QUEUE_LIST, CLICKUP_OPERATOR_ID, ...), so a moved list or a
// renamed seat is a one-line change in Doppler, not a code change.
let project;
try {
  project = loadProjectConfig();
} catch (err) {
  if (!(err instanceof ProjectConfigError)) throw err;
  console.error(`clickup: the project config is not usable — ${err.message}`);
  process.exit(1);
}
export const WORKSPACE = project.workspaceId;
export const SPACE = project.spaceId;                // the project's SPACE
export const LOOP_QUEUE_LIST = project.loopQueueListId; // the Loop Queue LIST
/** Dane's seat. Every handoff assigns this id. The token ALSO acts as this
 *  seat (`whoami` says so), which is why every comment this script posts is
 *  stamped with the machine marker — see lib/machineComment.mjs. */
export const OPERATOR_ID = Number(project.operatorUserId);
/** The workspace's service account. NEVER assign it. */
export const MACHINE_ID = Number(project.machineUserId);

// ── The tracker ──────────────────────────────────────────────────────────────
// The project config names it (lib/projectConfig.mjs refuses any other value
// before we get here); this table is the door's half of that agreement.
// `tokenEnv` names the environment variable that holds the token: Doppler
// supplies it, and the door never prints it. Each loop's runner names its
// own tracker token (trackerTokenEnv), so the tracker knows which loop wrote.
const TRACKERS = {
  clickup: {
    tokenEnv: () => 'CLICKUP_API_TOKEN',
    make: (token) => createClickupTracker({
      token,
      apiBase: process.env.CLICKUP_API_BASE,
      timeoutMs: process.env.CLICKUP_HTTP_TIMEOUT_MS,
    }),
  },
  api: {
    tokenEnv: () => trackerTokenEnv(process.env, projectSeats(project)),
    make: (token) => createApiTracker({
      token,
      baseUrl: project.trackerApiUrl,
      project: project.projectSlug,
      listId: LOOP_QUEUE_LIST,
      timeoutMs: process.env.TRACKER_HTTP_TIMEOUT_MS,
    }),
  },
};
if (!Object.hasOwn(TRACKERS, project.tracker)) {
  console.error(`clickup: the project config is not usable — "tracker" is ${JSON.stringify(project.tracker)}, and this door knows only: ${Object.keys(TRACKERS).join(', ')}`);
  process.exit(1);
}
let TOKEN_ENV;
try {
  TOKEN_ENV = TRACKERS[project.tracker].tokenEnv();
} catch (err) {
  console.error(`clickup: ${err.message}`);
  process.exit(1);
}
const TOKEN = process.env[TOKEN_ENV];
const tracker = TRACKERS[project.tracker].make(TOKEN);

const PRIORITY = PRIORITY_VALUE;

// ── Argument helpers ─────────────────────────────────────────────────────────
function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes(`--${name}`); }
function readBody(spec) { return spec === '-' ? readFileSync(0, 'utf8') : readFileSync(spec, 'utf8'); }

// ── Failures ─────────────────────────────────────────────────────────────────
function reportLimits() { tracker.reportLimits(); }

function die(label, { res, json, text }) {
  console.error(`\n${label} FAILED — HTTP ${res.status}`);
  console.error(json?.err || json?.error || String(text || '').slice(0, 500));
  if (res.status === 401) {
    if (/team not authorized/i.test(String(json?.err || json?.error || text))) {
      console.error('\n"Team not authorized" usually means the ID is the wrong KIND of thing — a space id where a');
      console.error(`list id belongs (the SPACE is ${SPACE}; the Loop Queue LIST is ${LOOP_QUEUE_LIST}).`);
      console.error('Run `npm run clickup -- lists` to resolve list ids by name before blaming the token.');
    } else if (project.tracker === 'api') {
      console.error(`\n401 means the tracker refused ${TOKEN_ENV}: it is wrong, or not this loop's — not that the tracker is down.`);
      console.error(`The token lives in Doppler (${project.dopplerProject}/${project.dopplerConfig}, ${TOKEN_ENV}).`);
      console.error('Run through `npm run clickup -- ...` so Doppler supplies it.');
    } else {
      console.error('\n401 means the token is wrong or expired — not that ClickUp is down.');
      console.error(`The token lives in Doppler (${project.dopplerProject}/${project.dopplerConfig}, ${TOKEN_ENV}).`);
      console.error('Run through `npm run clickup -- ...` so Doppler supplies it.');
    }
  }
  if (res.status === 429) console.error('\n429 is ClickUp throttling; wait 60s and run the same command again.');
  if (res.status === 0) console.error('\nHTTP 0: the request never left this machine or never arrived. Check the network and run it again.');
  process.exit(1);
}

function usage(code = 2) {
  console.error(`
npm run clickup -- <command> [flags]      (Loop Queue: list ${LOOP_QUEUE_LIST}, space ${SPACE})

  whoami                                          prove the token works and say who it acts as
  repo-check                                      does the tracker project's GitHub repository agree with githubRepo? (exit 1 if not)
  lists [--space <id>]                            resolve list ids by name (default: the project's space)
  queue [--list <id>] [--claimable | --status S]  the tickets, one per line: id, status, priority, created, name
  pass-reconcile                                  FIRST in every build pass: the ticket the last runner pass claimed and left
                                                  in Building goes back (Rework if it has a PR, else Queued), with a note.
                                                  Exit 0 nothing to do / 3 handed one back / 1 a write failed / 2 could not tell
  get --task <id>                                 header + body, with one attachments: line per file on the ticket
  attachments --task <id> --to <folder>           save every file on the ticket into the folder, each checked against its
                                                  size; exit 1 if any did not save (or the tracker keeps no files)
  task-name --task <id>                           the name and nothing else (for a PR title)
  comments --task <id>                            the comments, oldest first
  waiting [--task <id>]                           read-only: is this ACTUALLY waiting on Dane? exit 0 no / 3 yes / 1 could not tell
  task --name "..." --body-file <f|-> [--list <id>] [--status S] [--priority p] [--tags a,b] [--id-out <file>]
  describe --task <id> --body-file <f|->          REPLACE the description (the left column)
  comment --task <id> --body-file <f|->           a plain note
  claim --task <id>                               safe claim: reads the status and guards the write on it
  status --task <id> --status S [--if-status S] [--assign <uid>] [--clear-assignees] [--no-auto-assign] [--no-card]
  ask --task <id> [--status "Needs your input"|"Ready to launch"] --body-file <f|-> [--no-move] [--after-his-answer]
                                                  [--ask-anyway] [--ask-again]
  fixup-live --task <id> [--if-status S]         a catch-up ticket ("Find out why PR #N ... will not merge") whose PR already
                                                  merged: move it to Live with a note, never ask Dane (SP-288). Exit 0 moved /
                                                  4 not one (its own PR, none named, or not merged): carry on / 3 moved meanwhile /
                                                  1 a read or write failed
  pr-opened --task <id> --pr <url|number> [--repo owner/name] [--if-missing] [--human-hours <N>] [--body-file <f|->]
  verdict --task <id> --pass|--fail --if-status "In review" [--body-file <f|->] [--no-guard] [--fourth-round-anyway]
  priority --task <id> --priority urgent|high|normal|low [--operator-asked]
  tag --task <id> --add <name> | --remove <name>  e.g. wont-do, deferred, an epic name
  relay [--list <id>] [--dry-run]                 the merge lane: act on Dane's merge phrase on every "Ready to launch"
                                                  ticket (re-check every gate, merge, move the ticket, write the record),
                                                  and the hand-back: his answer to the question card on a "Needs your input"
                                                  ticket moves it to Queued, Rework or Live by the contract's table.
                                                  With "autoMergeLanes" in the project config, the auto-merge lanes run too, up to
                                                  a "would merge" note: nothing merges without his word yet (SP-202).
                                                  One line per ticket he holds. --dry-run prints what it would do, writes nothing
  tickets --json [--include-closed] [--project <slug>] [--comments]
                                                  read-only: the tickets as JSON for a scheduled check, one object each (id,
                                                  name, status, priority, tags, created, updated, statusSince; --comments adds
                                                  the top-level comments). Exit 1 naming what failed, printing nothing, on any failed read
  stage-counts [--project <slug> | --list <id>] [--since YYYY-MM-DD [--until YYYY-MM-DD]]
                                                  read-only: one JSON object for the weekly report: tickets per status now
                                                  (byStatus, total) and, in the window (whole UTC days), how many shipped
                                                  (closedInWindow), were filed (startedInWindow) and entered each status
                                                  (enteredInWindow). Exit 2 on a bad date; 1, printing nothing, on any failed read
  bus-post --body-file <f|-> [--from <name>]      post an alarm or report to the bus project's "Team chat" ticket, read back; a message starting ALARM: is texted
  bus-read [--operator] [--since <time>]          the bus's comments, oldest first: time (ISO, UTC: feeds --since), ticket, operator|machine, author, first line
  settings                                        read-only: this project's pipeline controls (the Settings page), one
                                                  name=value line each, defaults included. Exit 1 saying why when they cannot be read
  pause-check --lane <lane>                       read-only: may this lane start a pass? One line; exit 0 run, 3 paused (the Settings
                                                  page's switches, SP-237). Settings that cannot be read count as paused (exit 3)
  wip-check                                       read-only: may loop-build claim another ticket? One line, "room: N of CAP in flight"
                                                  (exit 0) or "full: N of CAP in flight (<ids>)" (exit 3), the cap from the Settings page
                                                  (SP-238). Exit 1 when it could not tell: the pass goes on without the cap
  release list                                    Spirality's releases: each project and the release it runs (tab-separated), Spirality's own
                                                  as "${OWN_PROJECT_RELEASE}", then the newest release. Exit 1 saying why on a failed read
  release name --project <slug> --to release-<n>  name the release a project runs, read back. Refused (exit 2) for a release with no tag
                                                  and for Spirality's own project; exit 1 when the write did not stick
  release back --project <slug>                   roll a project back: name the release it ran before this one again, read back.
                                                  Exit 2 when there is none; 1 when the write did not stick
                                                  (cut a release with \`npm run release -- cut\`)
  main-moved --pr <merged #> [--list <id>] [--dry-run]
                                                  tell every Building / In review / Rework ticket with an open PR whether
                                                  that merge moved main under it: no-overlap, same-files, conflict or
                                                  cannot-tell (the relay runs this after each merge it makes)

Statuses (matched case-insensitively): ${STAGE_ORDER.join(' / ')}.
Two are Dane's and only \`ask\` may set them: ${OPERATOR_STATUSES.map((s) => DISPLAY[s]).join(', ')}.
`);
  process.exit(code);
}

// ── Readers ──────────────────────────────────────────────────────────────────
async function fetchAllTasks(list, { includeClosed = false, markdown = false, strict = false } = {}) {
  const tasks = [];
  for (let page = 0; page < 50; page += 1) {
    const out = await tracker.listTasksPage(list, page, { includeClosed, markdown });
    if (!out.res.ok) die('list tasks', out);
    if (!out.json || !Array.isArray(out.json.tasks)) die('list tasks (the response body was not the expected JSON)', out);
    tasks.push(...out.json.tasks);
    if (out.json.last_page !== false || out.json.tasks.length === 0) return tasks;
  }
  console.error('Stopped after 50 pages — treat this output as INCOMPLETE.');
  // A caller that prints the list as whole cannot carry on with half of it.
  if (strict) process.exit(1);
  return tasks;
}

async function readTask(task) {
  const out = await tracker.getTask(task, { markdown: true });
  if (!out.res.ok) die('read the task', out);
  return out.json;
}

/** The ticket, or null when it could not be read: for a caller that reports
 *  a failed read on one ticket and carries on with the rest. */
async function readTaskOrNull(task) {
  const out = await tracker.getTask(task);
  return out.res.ok && out.json && out.json.status ? out.json : null;
}

/** 'open', 'closed' or 'unreadable' for every ticket the given tickets'
 *  `Waits on:` lines name (lib/waitsOn.js). Ids in `openIds` are known open
 *  without a read; every other one is read, once. */
async function prerequisiteStates(tickets, openIds = []) {
  const open = new Set(openIds.map((id) => String(id).toLowerCase()));
  const states = new Map();
  for (const t of tickets) {
    for (const id of waitsOn(waitsOnText(t))) {
      if (states.has(id)) continue;
      if (open.has(id)) { states.set(id, 'open'); continue; }
      const pre = await readTaskOrNull(id);
      if (!pre) states.set(id, 'unreadable');
      else states.set(id, ['closed', 'done'].includes(pre.status?.type) || TERMINAL_STATUSES.includes(statusOf(pre)) ? 'closed' : 'open');
    }
  }
  return states;
}

/** Every comment on the ticket, newest first, across ALL pages: ClickUp
 *  returns only the newest 25 per request (lib/commentPages.js). Half a
 *  trail that looks whole is how a reader concludes something never
 *  happened, so an incomplete read stops the command. */
async function readComments(task) {
  const { paged, bad } = await tracker.listComments(task);
  if (bad) die(bad.res.ok ? 'read comments (no comment list in the body)' : 'read comments', bad);
  if (!paged.complete) {
    console.error(`\nread comments FAILED — stopped after ${paged.comments.length} comment(s) without reaching the oldest; the trail is INCOMPLETE`);
    process.exit(1);
  }
  return paged.comments;
}

/** readComments for a caller that must carry on: { comments } or { problem }, never an exit. */
async function readCommentsOrProblem(task) {
  try {
    const { paged, bad } = await tracker.listComments(task);
    if (bad) return { problem: bad.res.ok ? 'no comment list in the body' : `HTTP ${bad.res.status}` };
    if (!paged.complete) return { problem: `stopped after ${paged.comments.length} comment(s) without reaching the oldest` };
    return { comments: paged.comments };
  } catch (err) {
    return { problem: String(err?.message || err) };
  }
}

/**
 * The ticket's attachments: { files } or { problem, unsupported }, never an
 * exit. `unsupported` means this tracker keeps no files at all (ClickUp).
 */
async function readAttachments(task) {
  const out = await tracker.listAttachments(task);
  if (out.unsupported) return { unsupported: true, problem: out.json?.err || 'this tracker keeps no attachments' };
  if (!out.res.ok) return { problem: `HTTP ${out.res.status}: ${out.json?.err || String(out.text || '').slice(0, 300)}`, out };
  return { files: out.json.attachments };
}

/** One attachment as `get` lists it. */
function attachmentLine(a) {
  return `${a.name} (${a.size} bytes, attachment ${a.id})`;
}

/**
 * A name to save `name` under in `folder` that nothing else there has, nor
 * any name in `taken`: the name itself, then `stem-2.ext`, `stem-3.ext`, ...
 * Only the file name's last part is used, so a name can never leave the folder.
 */
function freeFileName(folder, name, taken) {
  let base = basename(String(name).replace(/\\/g, '/'));
  if (!base || base === '.' || base === '..') base = 'attachment';
  const ext = extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? base : `${stem}-${n}${ext}`;
    if (!taken.has(candidate) && !existsSync(joinPath(folder, candidate))) return candidate;
  }
}

function assigneeNames(t) {
  return (t.assignees || []).map((a) => `${a.username} (${a.id})`).join(', ') || '(nobody)';
}

function clock(ms) {
  return new Date(Number(ms)).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function gh(args) {
  const out = spawnSync('gh', args, { encoding: 'utf8' });
  return { ok: out.status === 0, stdout: String(out.stdout || ''), stderr: String(out.stderr || '') };
}

/**
 * A recorded PR's live state, as waitingVerdict reads it (SP-217): null for
 * no PR recorded, else { number, state } with state OPEN, MERGED or CLOSED,
 * or null when GitHub could not be read or the PR is in another repository.
 * A failed read is null, never a guess.
 */
function livePrState(found, repo) {
  if (!found) return null;
  if (`${found.owner}/${found.repo}`.toLowerCase() !== String(repo).toLowerCase()) return { number: found.number, state: null };
  const view = gh(['pr', 'view', String(found.number), '--repo', repo, '--json', 'state']);
  if (!view.ok) return { number: found.number, state: null };
  try { return { number: found.number, state: String(JSON.parse(view.stdout).state || '') || null }; } catch { return { number: found.number, state: null }; }
}

/**
 * Every file a pull request changed, as GitHub lists them (SP-166), all pages.
 * GitHub answers 100 a page and stops at 3000 files. Any page that fails or is
 * not a list makes the whole answer null: half a list is never passed on.
 */
function readPrFiles(repo, number) {
  const all = [];
  for (let page = 1; page <= 30; page++) {
    const out = gh(['api', `repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`]);
    if (!out.ok) return null;
    let got;
    try { got = JSON.parse(out.stdout); } catch { return null; }
    if (!Array.isArray(got)) return null;
    all.push(...got);
    if (got.length < 100) return all;
  }
  return all;
}

// ── Guards shared by `status` and `ask` ──────────────────────────────────────
/** A ticket may not reach Ready to launch without a passing review on it. */
async function readyToLaunchRefused(task, status) {
  if (!isReadyToLaunch(status)) return false;
  if (flag('operator-asked')) {
    console.error('Review gate bypassed on your say-so (--operator-asked). Recorded in this transcript.');
    return false;
  }
  const gate = readyToLaunchGate(await readComments(task));
  if (gate.ok) return false;
  console.error(`\n"Ready to launch" is Dane's safe-to-merge signal, and ${gate.why}.`);
  console.error('Nothing was moved. If review really did pass, record the verdict first:');
  console.error(`  npm run clickup -- verdict --task ${task} --pass --if-status "In review" --body-file -\n`);
  return true;
}

/** Dane must not be asked for something he has already answered. */
async function alreadyAnsweredRefused(task, status) {
  if (!isOperatorStatus(status)) return null;
  if (flag('after-his-answer')) {
    console.error('Handing this back although he spoke last (--after-his-answer). Recorded in this transcript.');
    return null;
  }
  const comments = await readComments(task);
  if (operatorSpokeLast(comments, OPERATOR_ID)) {
    console.error(`\nREFUSED — Dane's own comment is the NEWEST one on ${task}, so a machine owes the next move.`);
    console.error('Handing it back now asks him to answer twice. Read what he said:');
    console.error(`  npm run clickup -- waiting --task ${task}`);
    console.error('If this really is a NEW question, say so on the record: ... --after-his-answer');
    console.error('Nothing was posted and the status has NOT moved.');
    return 2;
  }
  return null;
}

/**
 * A catch-up ticket and whether its work already landed (SP-288): the
 * ticket, its comments, the PR it was filed to unstick and catchUpClosePlan's
 * answer. GitHub is asked only when the answer turns on it.
 */
async function catchUpReading(task) {
  const t = await readTask(task);
  const comments = await readComments(task);
  const ownPr = findPullRequest(comments);
  const unstuck = ownPr ? null : unstuckPullRequest(t.markdown_description || t.description || '');
  const status = t.status?.status ?? '';
  let live = null;
  let plan = catchUpClosePlan({ status, ownPr, unstuck, live });
  if (plan.act === 'cannot-tell') {
    live = { state: null, mergedAt: null };
    if (`${unstuck.owner}/${unstuck.repo}`.toLowerCase() === String(project.githubRepo).toLowerCase()) {
      const view = gh(['pr', 'view', String(unstuck.number), '--repo', project.githubRepo, '--json', 'state,mergedAt']);
      if (view.ok) {
        try {
          const got = JSON.parse(view.stdout);
          live = { state: String(got.state || '') || null, mergedAt: got.mergedAt || null };
        } catch { /* non-JSON: left unread */ }
      }
    }
    plan = catchUpClosePlan({ status, ownPr, unstuck, live });
  }
  return { t, comments, unstuck, live, plan };
}

/** A merge time from GitHub, in Mountain time, or '' when there is none. */
function mergedAtText(iso) {
  const ms = Date.parse(String(iso || ''));
  return Number.isFinite(ms) ? `${clock(ms)} MT` : '';
}

/**
 * `ask` must not hand Dane a catch-up ticket whose pull request already
 * merged (SP-288): there is nothing for him to do, and `fixup-live` closes it.
 * Returns the exit code, or null to carry on. A failed GitHub read carries on:
 * the ask stands as it did before this guard.
 */
async function catchUpMergedRefused(task) {
  if (flag('ask-anyway')) {
    console.error('Asking although its pull request may already be merged (--ask-anyway). Recorded in this transcript.');
    return null;
  }
  const r = await catchUpReading(task);
  if (r.plan.act !== 'close') return null;
  console.error(`\nREFUSED — ${task} is a catch-up ticket and ${r.plan.why}${r.live?.mergedAt ? ` (${mergedAtText(r.live.mergedAt)})` : ''}.`);
  console.error('Its work is already live, so there is nothing to ask Dane. Close it yourself, with a note:');
  console.error(`  npm run clickup -- fixup-live --task ${task} --if-status "${r.t.status?.status ?? ''}"`);
  console.error('Nothing was posted and the status has NOT moved.');
  return 2;
}

/**
 * One question, one card (SP-288): a ticket already in that status of his,
 * with a machine card he has not answered yet, has been asked. A second card
 * posts the same question twice on his list.
 */
async function alreadyAskedRefused(task, status) {
  if (flag('ask-again')) {
    console.error('Posting a second card on an unanswered one (--ask-again). Recorded in this transcript.');
    return null;
  }
  const t = await readTask(task);
  if (statusOf(t.status?.status ?? '') !== statusOf(status)) return null;
  const comments = await readComments(task);
  const verdict = handbackAnswer({ comments, operatorId: OPERATOR_ID, isMachine: isMachineAuthored });
  if (verdict.state !== 'none') return null;
  console.error(`\nREFUSED — ${task} is already in "${t.status?.status}" with a card Dane has not answered yet, so he has been asked.`);
  console.error('A second card puts the same question in front of him twice. To add something, post a plain note:');
  console.error(`  npm run clickup -- comment --task ${task} --body-file -`);
  console.error('If this really is a different question, say so on the record: ... --ask-again');
  console.error('Nothing was posted and the status has NOT moved.');
  return 2;
}

/** Exit 2, before any write, when `text` links a GitHub file by branch (SP-178). */
function refuseBranchLinks(text, nothing) {
  const links = findBranchLinks(text);
  if (!links.length) return;
  console.error(`\n${branchLinkRefusal(links, nothing)}\n`);
  process.exit(2);
}

async function postComment(task, body) {
  // Every loop comment (comment, ask, verdict, pr-opened, bus-post) comes through here.
  // A card arrives as rich-text pieces; its code blocks (his own words) are quoted, not links.
  const text = Array.isArray(body.comment)
    ? body.comment.filter((p) => !p.attributes?.['code-block']).map((p) => p.text ?? '').join('')
    : String(body.comment_text ?? body.comment ?? '');
  refuseBranchLinks(text, 'Nothing was posted.');
  const out = await tracker.postComment(task, body);
  if (!out.res.ok) die('post comment', out);
  const id = String(out.json?.id ?? '');
  const stored = (await readComments(task)).find((c) => String(c.id) === id);
  if (!stored || !(stored.comment_text || '').trim()) {
    console.error(`Comment did NOT land intact: id ${id || '(none)'} ${stored ? 'saved empty' : 'not found on the task'}.`);
    process.exit(1);
  }
  return { id, stored };
}

// ── The auto-merge lanes' reads and writes (SP-202) ──────────────────────────
// lib/relayAutoMerge.js decides; these are its hands, each returning
// { ok, ... } or { ok: false, why }, never an exit, because the relay has
// other tickets to get through.

/** h:mm am/pm, Mountain time, the clock Dane reads. */
function clockAt(ms) {
  const d = new Date(Number(ms));
  const time = d.toLocaleTimeString('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(/\s/g, '');
  return `${time} MT`;
}

/**
 * The ledger lives beside the repository's git data, so every checkout of
 * one project shares one, and nothing in it is committed. Absolute, so a
 * relay started from a subfolder finds the same file (review note 4, SP-199).
 */
function autoMergeLedgerPath() {
  const out = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  const dir = out.status === 0 ? String(out.stdout || '').trim() : '';
  return dir ? joinPath(dir, 'auto-merge-ledger.json') : null;
}

/** Every message on the bus project, or why it could not be read. One unread ticket is unreadable. */
async function readBusMessages() {
  if (project.tracker !== 'api') return { ok: false, why: `the bus is a tracker project, and this project's tracker is "${project.tracker}"` };
  const bus = project.busProject;
  if (!bus) return { ok: false, why: 'this project has no bus ("busProject" in the project config)' };
  const listed = await tracker.listTasksPage(bus, 0, { includeClosed: true });
  if (!listed.res.ok || !Array.isArray(listed.json?.tasks)) return { ok: false, why: `the bus project ${bus} could not be listed (HTTP ${listed.res.status})` };
  const messages = [];
  for (const t of listed.json.tasks) {
    const read = await readCommentsOrProblem(t.id);
    if (read.problem) return { ok: false, why: `the comments on ${t.id} "${t.name}" could not be read (${read.problem})` };
    for (const c of read.comments) {
      messages.push({ id: String(c.id), at: Number(c.date) || 0, authorId: c.user?.id == null ? null : Number(c.user.id), authorKind: c.user?.kind ?? null, ticket: String(t.id), text: String(c.comment_text ?? '') });
    }
  }
  return { ok: true, messages };
}

/** Post to the bus's Team chat ticket and read it back. Never creates it: `bus-post` does that. */
async function postBusMessage(text) {
  if (project.tracker !== 'api' || !project.busProject) return { ok: false, why: 'this project has no bus' };
  const bus = project.busProject;
  const listed = await tracker.listTasksPage(bus, 0, { includeClosed: true });
  if (!listed.res.ok || !Array.isArray(listed.json?.tasks)) return { ok: false, why: `the bus project ${bus} could not be listed (HTTP ${listed.res.status})` };
  const chat = trackerBus.pickTeamChat(listed.json.tasks);
  if (!chat) return { ok: false, why: `there is no "${FALLBACK_TASK_NAME}" ticket in ${bus} (npm run clickup -- bus-post makes one)` };
  const post = trackerBus.renderBusPost({ text, node: hostname(), at: trackerBus.mountainTime(Date.now()) });
  if (!post) return { ok: false, why: 'the message was empty' };
  const out = await tracker.postComment(chat.id, { comment_text: post });
  if (!out.res.ok) return { ok: false, why: `HTTP ${out.res.status}` };
  const id = String(out.json?.id ?? '');
  const back = await readCommentsOrProblem(chat.id);
  if (back.problem || !back.comments.some((c) => String(c.id) === id)) return { ok: false, why: `comment ${id || '(no id)'} did not read back` };
  return { ok: true, id };
}

/** Post a lane notice on a ticket and read it back, returning the tracker's own time for it. */
async function postLaneNotice(taskId, body) {
  const out = await tracker.postComment(taskId, { comment_text: body });
  if (!out.res.ok) return { ok: false, why: `the notice did not post (HTTP ${out.res.status})` };
  const id = String(out.json?.id ?? '');
  const back = await readCommentsOrProblem(taskId);
  if (back.problem) return { ok: false, why: `the notice posted but could not be read back (${back.problem})` };
  const found = back.comments.find((c) => String(c.id) === id);
  if (!found || !Number(found.date)) return { ok: false, why: 'the notice did not read back' };
  return { ok: true, at: Number(found.date), commentId: String(found.id) };
}

/** The merge window's file, beside the ledger in the repository's git folder (absolute, as the ledger's is). */
function mergeWindowPath() {
  const ledger = autoMergeLedgerPath();
  return ledger ? joinPath(ledger, '..', 'merge-window-lease.json') : null;
}

function laneIo(repo) {
  return {
    readLedger: () => readLedgerFile(autoMergeLedgerPath()),
    saveLedger: (read, ledger) => saveLedgerIfReadable(read, ledger),
    readWindow: () => readLeaseFile(mergeWindowPath()),
    saveWindow: (read, lease) => saveLeaseIfReadable(read, lease),
    // GitHub's own catch-up of a branch that is behind main: never a force push.
    updateBranch: (number) => {
      const out = gh(['pr', 'update-branch', String(number), '--repo', repo]);
      return out.ok ? { ok: true } : { ok: false, why: out.stderr.trim().slice(0, 200) || 'gh failed' };
    },
    readBus: readBusMessages,
    postBus: postBusMessage,
    prFiles: (number) => {
      const files = readPrFiles(repo, number);
      return files ? { ok: true, files: files.map((f) => f.filename) } : { ok: false, why: 'GitHub did not list them all' };
    },
    prView: (number) => {
      const view = gh(['pr', 'view', String(number), '--repo', repo, '--json', PR_VIEW_FIELDS.join(',')]);
      if (!view.ok) return { ok: false, why: view.stderr.trim().slice(0, 200) || 'gh failed' };
      try { return { ok: true, pr: JSON.parse(view.stdout) }; } catch { return { ok: false, why: 'gh returned non-JSON' }; }
    },
    postNotice: postLaneNotice,
    mainBuildIsRed: (onRepo) => {
      const out = gh(['run', 'list', '--repo', onRepo, '--branch', 'main', '--limit', '1', '--json', 'conclusion,status,createdAt']);
      if (!out.ok) return { known: false, red: false, why: 'could not read the build history for main' };
      try {
        const last = JSON.parse(out.stdout)[0];
        if (!last) return { known: true, red: false };
        // A run still going is not a red run.
        if (String(last.status || '').toUpperCase() !== 'COMPLETED') return { known: true, red: false };
        const c = String(last.conclusion || '').toUpperCase();
        return { known: true, red: !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c), at: Number(new Date(last.createdAt)) || 0 };
      } catch {
        return { known: false, red: false, why: 'the build history for main was unparseable' };
      }
    },
  };
}

// ── Main moved: tell every ticket still in flight (task 86bctjffu) ───────────
// The checkout this script lives in. The relay runs from the main checkout;
// the git reads here are a fetch and an in-memory merge, so nothing in it moves.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * After PR `mergedNumber` merged: one `MAIN MOVED:` note on every ticket in a
 * machine status whose recorded PR is still open against the same base, each
 * read back. Never exits: the relay calls this after a merge it has already
 * recorded, so a failure — even a failed comment read on one ticket — is
 * returned in `problems` and the pass carries on (lib/mainMoved.js tellTickets).
 *
 * @param tasks the list's open tickets when the caller already has them
 * @returns {{ lines: string[], problems: string[], told: number, ctx }}
 *   `ctx` ({ merge, base, openPrs }) is set only when the merge, the fetch and
 *   the open PRs all read, so the Ready to launch catch-up (SP-294) reuses
 *   them instead of reading them again.
 */
async function tellMainMoved({ mergedNumber, list, dryRun, tasks = null }) {
  const lines = [], problems = [];
  let told = 0;
  const repo = project.githubRepo;
  const view = gh(['pr', 'view', String(mergedNumber), '--repo', repo, '--json', 'number,url,state,baseRefName,mergeCommit']);
  let merged = null;
  try { merged = view.ok ? JSON.parse(view.stdout) : null; } catch { merged = null; }
  if (!merged || String(merged.state).toUpperCase() !== 'MERGED' || !merged.mergeCommit?.oid) {
    problems.push(`PR #${mergedNumber} ${merged ? `is ${merged.state || 'in no readable state'}, not merged` : `could not be read (${view.stderr.trim().slice(0, 200)})`} — no ticket was told`);
    return { lines, problems, told };
  }
  const base = String(merged.baseRefName || '');
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const here = parseRepoFromRemoteUrl(remote.status === 0 ? remote.stdout : '');
  if (here.toLowerCase() !== String(repo).toLowerCase()) {
    problems.push(`this checkout is ${here || 'an unknown repo'}, not ${repo} — no ticket was told`);
    return { lines, problems, told };
  }
  const fetched = spawnSync('git', ['fetch', '--quiet', '--prune', 'origin'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (fetched.status !== 0) {
    problems.push(`git fetch failed (${String(fetched.stderr || '').trim().slice(0, 200)}) — no ticket was told`);
    return { lines, problems, told };
  }
  const listed = gh(['pr', 'list', '--repo', repo, '--state', 'open', '--base', base, '--json', 'number,headRefName', '--limit', '200']);
  let openPrs;
  try { openPrs = new Map(JSON.parse(listed.stdout).map((p) => [Number(p.number), String(p.headRefName)])); } catch { openPrs = null; }
  if (!listed.ok || !openPrs) {
    problems.push(`the open PRs could not be listed (${listed.stderr.trim().slice(0, 200)}) — no ticket was told`);
    return { lines, problems, told };
  }

  const merge = { number: Number(merged.number), url: merged.url, oid: merged.mergeCommit.oid };
  const io = {
    readComments: readCommentsOrProblem,
    readStatus: async (id) => (await readTaskOrNull(id))?.status?.status ?? null,
    postNote: async (id, text) => {
      const out = await tracker.postComment(id, { comment_text: text });
      return out.res.ok ? { ok: true, id: String(out.json?.id ?? '') } : { ok: false, problem: `HTTP ${out.res.status}` };
    },
    findPullRequest,
    contains: ({ branch }) => branchContains({ branch, mergeCommit: merge.oid, cwd: REPO_ROOT }),
    check: ({ branch }) => checkBranch({ base, branch, mergeCommit: merge.oid, cwd: REPO_ROOT }),
  };
  // The relay passes its own list; the standalone command reads it here.
  const result = await tellTickets({ tasks: tasks || await fetchAllTasks(list), merge, base, repo, openPrs, dryRun, io });
  return { ...result, ctx: { merge, base, openPrs } };
}

// ── Building tickets a dead pass left behind (SP-101) ────────────────────────
/** The build runner's lock as it is on disk now (scripts/loop_runner.sh writes it). */
function readBuildLock(dir) {
  if (!existsSync(dir)) return { exists: false };
  let pid = null;
  try { pid = readFileSync(joinPath(dir, 'pid'), 'utf8').trim(); } catch { pid = null; }
  let alive = false;
  if (/^\d+$/.test(String(pid))) {
    try { process.kill(Number(pid), 0); alive = true; } catch (err) { alive = err?.code === 'EPERM'; }
  }
  return { exists: true, pid, alive, ancestors: ancestorPids(), runnerPid: process.env.LOOP_RUNNER_PID || null };
}

/** What the build lane's lock says about this process (lib/passHandback.js lockState). */
function buildLock() {
  const dir = buildLockPath({ logDir: project.logDir, projectSlug: project.projectSlug, home: homedir() });
  return { dir, ...lockState(readBuildLock(dir)) };
}

/** This process's parent, its parent, and so on up to launchd. */
function ancestorPids() {
  const pids = [];
  let pid = process.pid;
  for (let i = 0; i < 64 && pid > 1; i += 1) {
    const out = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
    const parent = Number(String(out.stdout || '').trim());
    if (out.status !== 0 || !Number.isInteger(parent) || parent <= 0) break;
    pids.push(parent);
    pid = parent;
  }
  return pids;
}

/** Every linked worktree of the checkout the door runs in: path, branch, when it was made, pushed?, dirty? */
function listWorktrees() {
  const out = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  if (out.status !== 0) return { problem: String(out.stderr || '').trim().slice(0, 200) || 'git worktree list failed', worktrees: [] };
  const entries = String(out.stdout).split(/\n\n+/).map((block) => {
    const e = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) e.path = line.slice(9);
      else if (line.startsWith('branch ')) e.branch = line.slice(7).replace(/^refs\/heads\//, '');
    }
    return e;
  }).filter((e) => e.path);
  // The first entry is the main checkout itself, never a pass's worktree.
  const worktrees = entries.slice(1).map((e) => {
    let createdMs = NaN;
    try { const st = statSync(joinPath(e.path, '.git')); createdMs = st.birthtimeMs || st.mtimeMs; } catch { /* gone or unreadable */ }
    const pushed = Boolean(e.branch) && spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${e.branch}`]).status === 0;
    const st = spawnSync('git', ['-C', e.path, 'status', '--porcelain'], { encoding: 'utf8' });
    return { path: e.path, branch: e.branch || '', createdMs, pushed, dirty: st.status === 0 && String(st.stdout).trim() !== '' };
  });
  return { worktrees };
}

/**
 * Where this checkout's claim marker lives (lib/passClaim.js): the checkout
 * the door runs in, which `npm run` makes the project's own. Asked of git,
 * because the claim happens in the main checkout and the hand-off inside the
 * pass's worktree, where plain `.git` is a FILE pointing elsewhere.
 */
function passMarkerPath() {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  const out = r.status === 0 ? String(r.stdout || '').trim() : '';
  return passClaim.markerPath(out || '.git');
}

/** Written BEFORE the status write, never after: a pass that dies in between
 *  must leave a marker naming the ticket it was about to take. A claim whose
 *  guard is then refused clears it again (clearRefusedClaimMarker): the ticket
 *  may have gone to a hand-run session, whose claim no pass may take back. */
function writePassMarker(task, skill) {
  const file = passMarkerPath();
  try {
    writeFileSync(file, `${JSON.stringify(passClaim.newClaimRecord({ task, skill, pid: process.pid }), null, 2)}\n`);
    console.error(`  (pass marker written for ${task}: the next ${skill} pass hands it back if this one does not finish)`);
  } catch (err) {
    // Not fatal, and said out loud: the claim is what matters.
    console.error(`  (WARNING: the pass marker could not be written (${err?.message || err}). If this pass dies, its ticket strands in Building.)`);
  }
}

/** Set by a claim that wrote the marker: the task its status write is for. */
let claimMarkerTask = '';

/** A claim refused at its guard (someone else moved the ticket first) took
 *  nothing, so the marker it wrote must not survive to name that ticket. */
function clearRefusedClaimMarker() {
  if (!claimMarkerTask) return;
  const file = passMarkerPath();
  const m = passClaim.readMarker(file);
  if (!m.found || !m.record || String(m.record.task) !== String(claimMarkerTask)) return;
  try {
    unlinkSync(file);
    console.error(`  (pass marker cleared: the claim of ${claimMarkerTask} was refused, so this pass holds nothing)`);
  } catch (err) {
    console.error(`  (WARNING: the pass marker for the refused claim of ${claimMarkerTask} could not be cleared (${err?.message || err}). The next pass may hand that ticket back while someone else builds it: remove ${file}.)`);
  }
}

/** Cleared whenever the marked ticket leaves Building by a verified write. */
function clearPassMarkerFor(task, newStatus) {
  if (statusOf(newStatus) === BUILDING) return;
  const file = passMarkerPath();
  const m = passClaim.readMarker(file);
  if (!m.found || !m.record || String(m.record.task) !== String(task)) return;
  try {
    unlinkSync(file);
    console.error(`  (pass marker cleared: ${task} was handed on)`);
  } catch { /* the next reconcile sees the ticket has moved and clears it */ }
}

// ── Commands ─────────────────────────────────────────────────────────────────
if (!TOKEN) {
  console.error(`${TOKEN_ENV} is not set in this environment.\n`);
  console.error('The sanctioned route is Doppler, which holds the token:  npm run clickup -- <command> ...');
  console.error(`(package.json wraps this script in \`doppler run --project ${project.dopplerProject} --config ${project.dopplerConfig}\`.)`);
  process.exit(2);
}

let cmd = process.argv[2];
if (!cmd || cmd === 'help' || cmd === '--help') usage(0);

if (cmd === 'claim') {
  const task = arg('task');
  if (!task) usage();
  const seen = await readTask(task);
  const now = seen.status?.status ?? '';
  if (!isClaimableByBuild(now)) {
    console.error(`NOT claimed: "${task}" is "${now || '?'}", which loop-build may not claim.`);
    console.error(`Claimable statuses, in drain order: ${CLAIMABLE_BY_BUILD.map((x) => DISPLAY[x]).join(', ')}. Take the next task.`);
    process.exit(3);
  }
  const states = await prerequisiteStates([seen]);
  const held = holdReasons(seen, (id) => states.get(id));
  if (held.reasons.length) {
    console.error(`NOT claimed: "${task}" ${held.reasons.join('; ')}. Nothing was written.${held.unreadable ? '' : ' Take the next task.'}`);
    process.exit(held.unreadable ? 1 : 3);
  }
  // Only a claim made under the build runner arms the marker (SP-101): a
  // hand-run session never does, so no loop pass can take its ticket back.
  const lock = buildLock();
  if (writesMarker(lock)) {
    // Never over a marker still owed a hand-back: it is the only record of
    // the ticket a dead pass stranded, and pass-reconcile keeps it after a
    // failed or unsure try so the next pass tries again.
    const existing = passClaim.readMarker(passMarkerPath());
    let markedStatus = '';
    if (existing.found && existing.record && String(existing.record.task) !== String(task)) {
      const marked = await readTaskOrNull(existing.record.task);
      if (marked) markedStatus = statusOf(marked);
    }
    const blocked = markerBlocksClaim({ marker: existing, task, status: markedStatus });
    if (blocked) {
      console.error(`NOT claimed: ${blocked}. Nothing was written.`);
      console.error('Stop this pass: run `npm run clickup -- pass-reconcile` and fix what it reports first, or a person clears the marker. Claiming now would lose that ticket for good.');
      process.exit(1);
    }
    writePassMarker(task, BUILD_SKILL);
    claimMarkerTask = task;
  } else console.error(`  (no pass marker: ${lock.why}, so this is not a build runner's pass)`);
  process.argv = [...process.argv.slice(0, 2), 'status', ...process.argv.slice(3), '--status', DISPLAY[BUILDING], '--if-status', now];
  console.error(`claiming ${task} out of "${now}" (guarded on that exact status)`);
  cmd = 'status';
}

if (cmd === 'whoami') {
  const out = await tracker.whoAmI();
  if (!out.res.ok) die('whoami', out);
  console.log(`Token valid. Acting as: ${out.json.user.username} <${out.json.user.email}> (id ${out.json.user.id})`);
  if (Number(out.json.user.id) === OPERATOR_ID) console.error("  (This is Dane's own seat, as on ClickUp. The ClickUp door stamps every comment it posts with the [machine] marker so readers can tell; on the tracker each loop signs in as its own machine actor instead.)");
  reportLimits();

} else if (cmd === 'repo-check') {
  // Read-only: the tracker project's GitHub repository field (SP-80) against
  // the githubRepo the loops use. Empty is reported, different fails.
  if (project.tracker !== 'api') {
    console.log(`repository: not checked; the "${project.tracker}" tracker has no GitHub repository field. The loops use githubRepo ${project.githubRepo}.`);
  } else {
    const out = await tracker.projectDetails();
    if (!out.res.ok || !out.json) die(`read the tracker project "${project.projectSlug}"`, out);
    if (!Object.hasOwn(out.json, 'repo')) {
      console.error(`repo-check: the tracker's answer for project "${project.projectSlug}" has no repo field at all, so this check cannot tell. Is the tracker older than SP-80?`);
      process.exit(1);
    }
    const { ok, line } = compareRepo({
      configRepo: project.githubRepo, trackerRepo: out.json.repo, slug: project.projectSlug, editUrl: projectEditUrl(filedTrackerUrl() || project.trackerUrl, project.projectSlug),
    });
    console.log(line);
    reportLimits();
    if (!ok) process.exit(1);
  }

} else if (cmd === 'lists') {
  const space = arg('space') || SPACE;
  const [folderless, folders] = await Promise.all([
    tracker.listsInSpace(space),
    tracker.foldersInSpace(space),
  ]);
  if (!folderless.res.ok || !folderless.json) die('list folderless lists', folderless);
  if (!folders.res.ok || !folders.json) die('list folders', folders);
  for (const l of folderless.json.lists) console.log(`${l.id}\t${l.name}`);
  for (const f of folders.json.folders) for (const l of f.lists || []) console.log(`${l.id}\t${f.name} / ${l.name}`);
  reportLimits();

} else if (cmd === 'queue') {
  const list = arg('list') || LOOP_QUEUE_LIST;
  const status = arg('status');
  const claimable = flag('claimable');
  if (claimable && status) {
    console.error('--claimable and --status are two different questions; pass one.');
    process.exit(2);
  }
  // --claimable reads the markdown description, as claim does (waitsOnText).
  const tasks = await fetchAllTasks(list, { markdown: claimable });
  let wanted;
  if (claimable) {
    // A ticket from this (open-only) list is open; any other prerequisite
    // is read on its own, so queue and claim apply the same rule.
    const ordered = claimOrder(tasks);
    const states = await prerequisiteStates(ordered, tasks.map((t) => t.id));
    wanted = ordered.filter((t) => {
      const held = holdReasons(t, (id) => states.get(id));
      if (held.reasons.length) console.error(`skipped ${t.id}: ${held.reasons.join('; ')}`);
      return !held.reasons.length;
    });
  } else {
    wanted = status ? tasks.filter((t) => (t.status?.status ?? '').toLowerCase() === status.toLowerCase()) : tasks.slice();
    wanted.sort(compareWithinStatus);
  }
  for (const t of wanted) {
    const created = new Date(Number(t.date_created)).toISOString().slice(0, 10);
    console.log([t.id, t.status?.status ?? '?', t.priority?.priority ?? 'none', created, t.name].join('\t'));
  }
  const scope = claimable ? ` claimable by loop-build (${CLAIMABLE_BY_BUILD.join(' then ')})` : (status ? ` with status "${status}"` : '');
  console.error(`${wanted.length} task(s)${scope} in list ${list} (first line is the one to take)`);
  if (claimable && wanted.length) console.error(`  claim it: npm run clickup -- claim --task ${wanted[0].id}`);
  reportLimits();

} else if (cmd === 'pass-reconcile') {
  // THE FIRST THING A LOOP-BUILD PASS DOES (SP-101; StarCaster's command of
  // the same name, task 86bbtmbpc). A build pass that dies leaves its ticket
  // in Building, which no loop claims from. Nothing in a killed session runs
  // again, so the repair is done by the next pass: the claim left a marker
  // (lib/passClaim.js), and only a claim under the build runner writes one.
  // Run once, BEFORE this pass claims: after, the marker is this pass's own.
  const file = passMarkerPath();
  const marker = passClaim.readMarker(file);
  const lock = buildLock();
  console.error(`build lock ${lock.dir}: ${lock.state} (${lock.why})`);

  let status = '';
  let seen = null;
  if (marker.found && marker.record) {
    // An unreadable status is NOT a hand-back: moving a ticket on a reading
    // not taken is how a live build gets yanked out from under its pass.
    seen = await readTaskOrNull(marker.record.task);
    if (seen) status = statusOf(seen);
  }
  // The pass seat's inference (a new pass means the old one ended) holds only
  // under the runner, or with no runner at all; seatGate refuses it otherwise.
  const decision = seatGate(lock, marker)
    || passClaim.reconcileDecision({ marker, status, trigger: passClaim.TRIGGER_PASS });
  let ok = true;
  let destination = '';

  if (decision.action === 'handback') {
    const task = decision.task;
    const read = await readCommentsOrProblem(task);
    const dest = handbackDestination(read.problem ? null : Boolean(findPullRequest(read.comments)));
    destination = dest.status;
    // Guarded on Building: a ticket that moved since the read is not moved again.
    const out = await tracker.updateTask(task, {
      status: dest.status,
      assignees: { add: [], rem: (seen.assignees || []).map((a) => a.id) },
    }, { ifStatus: DISPLAY[BUILDING] });
    const now = out.json?.status?.status ?? '';
    if (out.moved || !out.res.ok || now.toLowerCase() !== dest.status.toLowerCase()) {
      ok = false;
      console.error(`  ${task}: NOT moved (${out.moved ? 'it moved underneath this pass' : out.res.ok ? `the write came back "${now || '?'}"` : `HTTP ${out.res.status}`}). The marker stays, so the next pass tries again.`);
    } else {
      const worktrees = listWorktrees();
      if (worktrees.problem) console.error(`  the worktrees could not be listed (${worktrees.problem}); the note says so`);
      const claimedMs = Date.parse(marker.record.at);
      const leftovers = Number.isFinite(claimedMs) ? leftoverWorktrees(worktrees.worktrees, { claimedMs }) : [];
      const text = handbackNote({ when: Number.isFinite(claimedMs) ? clock(claimedMs) : '', destination: dest, leftovers, unlisted: worktrees.problem || '' });
      const posted = await tracker.postComment(task, { comment_text: text });
      const id = String(posted.json?.id ?? '');
      const back = posted.res.ok ? await readCommentsOrProblem(task) : { problem: `HTTP ${posted.res.status}` };
      if (back.problem || !back.comments.some((c) => String(c.id) === id && String(c.comment_text || '').trim())) {
        // The move stuck, so the marker is spent; the missing note is the failure.
        console.error(`  ${task}: moved to ${dest.status}, but its note did NOT save (${back.problem || `comment ${id || '(no id)'} not found on read-back`}).`);
        try { unlinkSync(file); } catch { /* it reads as resolved next pass */ }
        console.log(passClaim.reconcileMessage(decision, { destination }));
        process.exit(1);
      }
      console.error(`  ${task}: note ${id} read back`);
    }
  }

  // Removed for every outcome that RESOLVED it, kept for every one that did
  // not: a failure is retried next pass, an unreadable marker stays for a person.
  if (decision.action === 'resolved' || (decision.action === 'handback' && ok)) {
    try { unlinkSync(file); } catch { /* it will read as resolved next pass */ }
  }
  console.log(passClaim.reconcileMessage(decision, { destination }));
  reportLimits();
  process.exit(passClaim.reconcileExitCode({ action: decision.action, ok }));

} else if (cmd === 'get') {
  const task = arg('task');
  if (!task) usage();
  const t = await readTask(task);
  const comments = await readComments(task);
  const pr = findPullRequest(comments);
  console.log(`id:       ${t.id}`);
  console.log(`name:     ${t.name}`);
  console.log(`status:   ${t.status?.status ?? '?'}`);
  console.log(`priority: ${t.priority?.priority ?? 'none'}`);
  console.log(`assigned: ${assigneeNames(t)}`);
  console.log(`tags:     ${(t.tags || []).map((x) => x.name).join(', ') || '(none)'}`);
  console.log(`list:     ${t.list?.name} (${t.list?.id})`);
  console.log(`pr:       ${pr ? pr.url : '(none recorded)'}`);
  console.log(`rounds:   ${sendBackRounds(comments)} send-back(s) so far`);
  const moved = pr ? latestMainMoved(comments, pr.number) : null;
  console.log(`main:     ${moved ? `moved — newest note: PR #${moved.merged} merged, this branch ${moved.kind} (comment ${moved.commentId})` : '(no MAIN MOVED note)'}`);
  // Dane's files shape the spec and the build, so a list that could not be
  // read says so on its own line, never "(none)". It does not stop `get`:
  // every pass reads the ticket through it, and a tracker still running from
  // before attachments existed answers 404 for the list.
  const files = await readAttachments(t.id ?? task);
  if (files.unsupported) console.log('attachments: (not kept on ClickUp)');
  else if (files.problem) {
    console.log(`attachments: COULD NOT BE READ (${files.problem}); this ticket's files are unknown`);
    console.error(`\nread the attachments FAILED — ${files.problem.replace(/\.$/, '')}. The ticket may have files this pass cannot see; say so before speccing or building from it.`);
  } else if (!files.files.length) console.log('attachments: (none)');
  else for (const a of files.files) console.log(`attachments: ${attachmentLine(a)}`);
  console.log(`url:      ${t.url}`);
  console.log('---');
  console.log(t.markdown_description || t.description || '(no body)');
  reportLimits();

} else if (cmd === 'attachments') {
  const task = arg('task');
  const to = arg('to');
  if (!task || !to) usage();
  const listed = await readAttachments(task);
  if (listed.unsupported) {
    console.error(listed.problem);
    process.exit(1);
  }
  if (listed.problem) die('read the attachments', listed.out);
  if (!listed.files.length) {
    console.log(`no attachments on ${task}; nothing to save`);
    reportLimits();
    process.exit(0);
  }
  const folder = resolvePath(to);
  try {
    mkdirSync(folder, { recursive: true });
  } catch (err) {
    console.error(`could not make the folder ${folder} (${err.message}); nothing was saved.`);
    process.exit(1);
  }
  const taken = new Set();
  const failed = [];
  for (const a of listed.files) {
    const got = await tracker.downloadAttachment(task, a.id);
    if (!got.res.ok || !got.bytes) {
      failed.push(a.name);
      console.error(`NOT saved ${a.name} (attachment ${a.id}): HTTP ${got.res.status} ${got.json?.err || String(got.text || '').slice(0, 300)}`);
      continue;
    }
    if (got.bytes.length !== Number(a.size)) {
      failed.push(a.name);
      console.error(`NOT saved ${a.name} (attachment ${a.id}): ${got.bytes.length} bytes arrived, the tracker lists ${a.size}`);
      continue;
    }
    const name = freeFileName(folder, a.name, taken);
    const path = joinPath(folder, name);
    try {
      // `wx`: never over a file already there, even one made since the name was chosen.
      writeFileSync(path, got.bytes, { flag: 'wx' });
      taken.add(name);
      const onDisk = statSync(path).size;
      if (onDisk !== Number(a.size)) throw new Error(`${onDisk} bytes on disk, the tracker lists ${a.size}`);
    } catch (err) {
      failed.push(a.name);
      console.error(`NOT saved ${a.name} (attachment ${a.id}) to ${path}: ${err.message}`);
      continue;
    }
    console.log(`saved ${path} (${a.size} bytes)`);
  }
  reportLimits();
  if (failed.length) {
    console.error(`\n${failed.length} of ${listed.files.length} attachment(s) on ${task} did NOT save: ${failed.join(', ')}`);
    process.exit(1);
  }
  console.error(`${listed.files.length} attachment(s) on ${task} saved to ${folder}`);

} else if (cmd === 'task-name') {
  const task = arg('task');
  if (!task) usage();
  const t = await readTask(task);
  const name = String(t.name ?? '');
  if (!name.trim()) { console.error(`Task ${task} has an empty name.`); process.exit(1); }
  process.stdout.write(`${name}\n`);

} else if (cmd === 'comments') {
  const task = arg('task');
  if (!task) usage();
  const comments = newestFirst(await readComments(task)).reverse();
  for (const c of comments) {
    const who = isMachineAuthored(c) ? `${c.user?.username ?? '?'} [machine]` : (c.user?.username ?? '?');
    console.log(`[${clock(c.date)} MT] ${who} (${c.user?.id ?? '?'}, comment ${c.id}):`);
    console.log(stripMachineMarker(c.comment_text) || '(empty)');
    console.log('---');
  }
  console.error(`${comments.length} comment(s) on task ${task}`);
  reportLimits();

} else if (cmd === 'waiting') {
  // The verdict is waitingOnOperator's, the same module the tracker page
  // uses, so the door and the page cannot disagree (SP-217). This command
  // only does the reads: the ticket, its comments and, in his two lanes, the
  // recorded PR's live state on GitHub.
  const { waitingVerdict, verdictLine, prLabel, exitCodeFor, sweepSummary, WAITING, CANNOT_TELL } = waitingOnOperator;
  const task = arg('task');
  const tasks = task ? [await readTask(task)] : (await fetchAllTasks(LOOP_QUEUE_LIST)).filter((t) => isOperatorStatus(t.status?.status));
  const verdicts = [];
  for (const t of tasks) {
    const comments = await readComments(t.id);
    const newest = newestFirst(comments)[0];
    const assigned = (t.assignees || []).some((a) => a.id === OPERATOR_ID);
    const status = t.status?.status ?? '?';
    // GitHub is asked only in his two lanes; a machine status settles it.
    const recorded = findPullRequest(comments);
    const pr = isOperatorStatus(status) ? livePrState(recorded, project.githubRepo) : null;
    const prText = !isOperatorStatus(status) && recorded ? `PR #${recorded.number} not checked (machine status)` : prLabel(pr);
    const result = waitingVerdict({ task: t, comments, pr }, { operatorId: OPERATOR_ID });
    verdicts.push(result.verdict);
    const lastWord = newest ? `${isMachineAuthored(newest) ? 'a loop' : (newest.user?.username ?? '?')} ${clock(newest.date)} MT` : '(no comments)';
    console.log(`${t.id}\t${status}\tassigned: ${assigned ? 'Dane' : 'not Dane'}\tlast word: ${lastWord}\t${prText}\t${verdictLine(result)}\t${t.name}`);
  }
  console.error(sweepSummary({
    checked: tasks.length,
    waiting: verdicts.filter((v) => v === WAITING).length,
    cannotTell: verdicts.filter((v) => v === CANNOT_TELL).length,
    lists: task ? [] : [`list ${LOOP_QUEUE_LIST}`],
  }));
  process.exit(exitCodeFor(verdicts));

} else if (cmd === 'task') {
  const list = arg('list') || LOOP_QUEUE_LIST;
  const name = arg('name');
  const bodyFile = arg('body-file');
  if (!name || !bodyFile) usage();
  if (String(arg('priority', '')).toLowerCase() === 'urgent' && !flag('operator-asked')) {
    console.error('\nUrgent is reserved for Dane, not something an agent sets on its own. File at High or below.');
    console.error('If he explicitly asked for Urgent, add --operator-asked — your written claim, visible in the transcript.\n');
    process.exit(1);
  }
  const body = readBody(bodyFile);
  const quoted = findBlockquoteLines(body);
  if (quoted.length) {
    console.error(`The body has "> " blockquote lines (${quoted.join(', ')}). ClickUp DELETES them silently. Use a fenced block. Nothing was created.`);
    process.exit(2);
  }
  refuseBranchLinks(body, 'Nothing was created.');
  const tags = arg('tags') ? arg('tags').split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const out = await tracker.createTask(list, {
    name,
    markdown_description: body,
    status: arg('status') || undefined,
    priority: PRIORITY[String(arg('priority', '')).toLowerCase()] || undefined,
    tags,
  });
  if (!out.res.ok) die('create task', out);
  const id = out.json.id;
  if (arg('id-out')) writeFileSync(arg('id-out'), id);
  console.log(`\nCreated task ${id}\n  ${out.json.url}`);
  const t = await readTask(id);
  const chars = (t.description || '').length;
  console.log('\nVerified by reading the task back:');
  console.log(`  name:        ${t.name}`);
  console.log(`  list:        ${t.list?.name} (${t.list?.id})`);
  console.log(`  status:      ${t.status?.status}`);
  console.log(`  priority:    ${t.priority?.priority ?? '(none)'}`);
  console.log(`  tags:        ${(t.tags || []).map((x) => x.name).join(', ') || '(none)'}`);
  console.log(`  description: ${chars} characters`);
  if (tags && tags.length) {
    const landed = new Set((t.tags || []).map((x) => String(x.name || '').toLowerCase()));
    const missing = tags.filter((w) => !landed.has(w.toLowerCase()));
    if (missing.length) { console.error(`\n  TAGS DID NOT STICK: [${missing.join(', ')}]`); process.exit(1); }
  }
  if (chars === 0) { console.error('\n  BODY IS EMPTY — the description did not save. The task exists but is a shell.'); process.exit(1); }
  if (arg('status') && String(t.status?.status).toLowerCase() !== String(arg('status')).toLowerCase()) {
    console.error(`\n  STATUS DID NOT STICK: asked "${arg('status')}", got "${t.status?.status}". The list may not have that status yet (docs/CLICKUP_SETUP.md).`);
    process.exit(1);
  }
  reportLimits();

} else if (cmd === 'describe') {
  const task = arg('task'), bodyFile = arg('body-file');
  if (!task || !bodyFile) usage();
  const body = readBody(bodyFile);
  if (!body.trim()) { console.error('Refusing to replace the description with an empty body.'); process.exit(2); }
  const quoted = findBlockquoteLines(body);
  if (quoted.length) { console.error(`The body has "> " blockquote lines (${quoted.join(', ')}). ClickUp DELETES them. Nothing was written.`); process.exit(2); }
  refuseBranchLinks(body, 'Nothing was written.');
  const out = await tracker.updateTask(task, { markdown_description: body });
  if (!out.res.ok) die('replace description', out);
  const t = await readTask(task);
  const chars = (t.description || '').length;
  if (chars === 0) { console.error('The description came back EMPTY after the write.'); process.exit(1); }
  console.log(`Task ${task}: description replaced (${chars} characters, read back).`);
  reportLimits();

} else if (cmd === 'comment') {
  const task = arg('task'), bodyFile = arg('body-file');
  if (!task || !bodyFile) usage();
  const sent = readBody(bodyFile);
  const quoted = findBlockquoteLines(sent);
  if (quoted.length) { console.error(`The comment has "> " blockquote lines (${quoted.join(', ')}). ClickUp DELETES them. Nothing was posted.`); process.exit(2); }
  refuseBranchLinks(sent, 'Nothing was posted.');
  const { id, stored } = await postComment(task, { comment_text: sent });
  console.log(`Comment ${id} added to task ${task} (${stored.comment_text.length} characters, verified by reading it back).`);
  reportLimits();

} else if (cmd === 'status') {
  const task = arg('task'), status = arg('status');
  if (!task || !status) usage();
  const assignId = arg('assign') ? Number(arg('assign')) : null;
  if (assignId !== null && !Number.isInteger(assignId)) { console.error('--assign needs a numeric ClickUp user id.'); process.exit(2); }
  if (assignId === MACHINE_ID) { console.error('Refusing to assign the machine account (Pulse). Handoffs go to Dane.'); process.exit(2); }
  if (isOperatorStatus(status) && !flag('no-card')) {
    console.error(`\n"${status}" is a handoff to Dane, not just a status. Use \`ask\`, which posts the operator card and moves the status together:`);
    console.error(`  npm run clickup -- ask --task ${task} --status "${status}" --body-file -\n`);
    console.error(`The card: @@ASKED (his words, verbatim) / @@WHEN (optional) / @@CONTEXT (${CONTEXT_MIN_WORDS}-${CONTEXT_MAX_WORDS} words) / @@NEEDED (the ask, ending "Your move: Merge|Close|Reply — why") / @@EVIDENCE (costly asks only).`);
    console.error('If this really is a status move with no ask attached, pass --no-card — your written claim that a card is not owed.\n');
    process.exit(2);
  }
  if (await readyToLaunchRefused(task, status)) process.exit(2);
  const answered = await alreadyAnsweredRefused(task, status);
  if (answered !== null) process.exit(answered);

  const before = await readTask(task);
  const was = before.status?.status ?? '?';
  const ifStatus = arg('if-status');
  if (ifStatus && was.toLowerCase() !== ifStatus.toLowerCase()) {
    console.error(`NOT moved: expected status "${ifStatus}" but the task is "${was}" — another loop or Dane got there first. Take the next task.`);
    clearRefusedClaimMarker();
    process.exit(3);
  }
  const toOperator = isOperatorStatus(status);
  let add = assignId !== null ? [assignId] : [];
  let clearing = flag('clear-assignees');
  if (!flag('no-auto-assign')) {
    if (toOperator && add.length === 0) add = [OPERATOR_ID];
    if (!toOperator && !clearing && add.length === 0) clearing = true;
  }
  const rem = clearing ? (before.assignees || []).map((a) => a.id).filter((id) => !add.includes(id)) : [];
  const body = { status };
  if (add.length || rem.length) body.assignees = { add, rem };
  // The same guard, handed to the tracker: the tracker's own store refuses a
  // raced write atomically (ClickUp cannot, and ignores it).
  const out = await tracker.updateTask(task, body, { ifStatus: ifStatus || undefined });
  if (out.moved) {
    console.error(`NOT moved: expected status "${ifStatus}" but the tracker refused the write — ${String(out.json?.err || 'the ticket moved').replace(/\.$/, '')}. Another loop or Dane got there first. Take the next task.`);
    clearRefusedClaimMarker();
    process.exit(3);
  }
  if (!out.res.ok) die('set status', out);
  const t = out.json;
  const now = t.status?.status ?? '?';
  if (now.toLowerCase() !== status.toLowerCase()) {
    console.error(`Status did NOT stick: asked for "${status}", the write came back "${now}".`);
    console.error('Usually the list does not have that status — statuses are per-list in ClickUp (docs/CLICKUP_SETUP.md).');
    process.exit(1);
  }
  const finalIds = (t.assignees || []).map((a) => a.id);
  for (const id of add) if (!finalIds.includes(id)) { console.error(`Assignee did NOT stick: asked to assign ${id}, the task carries [${finalIds.join(', ')}].`); process.exit(1); }
  if (clearing && finalIds.some((id) => !add.includes(id))) { console.error(`Assignees did NOT clear: [${finalIds.join(', ')}] still on the task.`); process.exit(1); }
  console.log(`Task ${task}: "${was}" -> "${now}", assigned: ${assigneeNames(t)} (verified from the write response).`);
  clearPassMarkerFor(task, now);
  reportLimits();

} else if (cmd === 'priority') {
  const task = arg('task'), wanted = String(arg('priority', '')).toLowerCase();
  if (!task || !(wanted in PRIORITY)) usage();
  if (wanted === 'urgent' && !flag('operator-asked')) { console.error('Urgent is reserved for Dane. Add --operator-asked only if he explicitly asked.'); process.exit(1); }
  const before = await readTask(task);
  const out = await tracker.updateTask(task, { priority: PRIORITY[wanted] });
  if (!out.res.ok) die('set priority', out);
  const now = out.json.priority?.priority ?? '(none)';
  if (now !== wanted) { console.error(`Priority did NOT stick: asked "${wanted}", got "${now}".`); process.exit(1); }
  console.log(`Task ${task}: priority "${before.priority?.priority ?? '(none)'}" -> "${now}".`);
  reportLimits();

} else if (cmd === 'tag') {
  const task = arg('task'), add = arg('add'), remove = arg('remove');
  if (!task || (!add && !remove) || (add && remove)) usage();
  const out = await tracker.setTag(task, add || remove, Boolean(add));
  if (!out.res.ok) die(add ? 'add tag' : 'remove tag', out);
  const t = await readTask(task);
  const has = (t.tags || []).some((x) => String(x.name).toLowerCase() === String(add || remove).toLowerCase());
  if (add && !has) { console.error(`Tag "${add}" did NOT stick.`); process.exit(1); }
  if (remove && has) { console.error(`Tag "${remove}" is still on the task.`); process.exit(1); }
  console.log(`Task ${task}: tags now [${(t.tags || []).map((x) => x.name).join(', ')}].`);
  reportLimits();

} else if (cmd === 'pr-opened') {
  const task = arg('task'), prArg = arg('pr');
  if (!task || !prArg) usage();
  // Checked before anything is read or written: a bad estimate writes nothing (SP-78).
  let humanHours = null;
  if (flag('human-hours')) {
    const parsed = parseHumanHours(arg('human-hours'));
    if (!parsed.ok) { console.error(`--human-hours: ${parsed.why}. Nothing was written.`); process.exit(2); }
    humanHours = parsed.hours;
  }
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(prArg.trim());
  let repo = arg('repo'), prNumber;
  if (m) { repo = repo || `${m[1]}/${m[2]}`; prNumber = Number(m[3]); } else if (/^\d+$/.test(prArg.trim())) {
    if (!repo) { console.error('--pr got a bare number, so --repo owner/name is needed.'); process.exit(2); }
    prNumber = Number(prArg.trim());
  } else { console.error(`--pr got "${prArg}", which is neither a GitHub pull-request URL nor a number.`); process.exit(2); }
  const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
  const view = gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'body,url']);
  if (!view.ok) { console.error(`Could not read PR #${prNumber} from ${repo}: ${view.stderr.slice(0, 300)}\nNothing was written.`); process.exit(1); }
  let prJson;
  try { prJson = JSON.parse(view.stdout); } catch { console.error('gh returned non-JSON. Nothing was written.'); process.exit(1); }
  if (!bodyNamesTicket(prJson.body, task, project)) {
    console.error(`\nPR #${prNumber} has no link back to this ticket in its body, so nothing was written.`);
    // No `project` here: the line people paste uses the config FILE's address, not TRACKER_URL (SP-32).
    console.error(`Add this line to the PR body and run again:\n  ${ticketLine(task)}\n`);
    process.exit(4);
  }
  let already = false;
  if (flag('if-missing') && prTrailLanded(await readComments(task), prNumber).ok) {
    already = true;
    console.log(`Task ${task}: PR #${prNumber} is already recorded — nothing written.`);
  }
  if (!already) {
    const text = prOpenedComment(prUrl, arg('body-file') ? readBody(arg('body-file')) : '', { humanHours });
    await postComment(task, { comment_text: text });
    const after = await readComments(task);
    const landed = prTrailLanded(after, prNumber);
    if (!landed.ok) { console.error(`\nThe "PR opened" trail did NOT land: ${landed.why}. Fix the comment by hand before handing this to review.\n`); process.exit(1); }
    if (humanHours != null && findHumanHours(after) !== humanHours) {
      console.error(`\nThe PR was recorded, but the human-hours estimate (${humanHours}) does NOT read back from it. Fix the comment by hand.\n`);
      process.exit(1);
    }
    console.log(`Task ${task}: PR #${prNumber} recorded (${prUrl}), read back and parsed by the gate's own reader.`);
    if (humanHours != null) console.log(`Task ${task}: human-hours estimate ${humanHours} recorded and read back.`);
  }
  reportLimits();

} else if (cmd === 'verdict') {
  const task = arg('task');
  const passed = flag('pass'), failed = flag('fail');
  if (!task || passed === failed) { console.error('verdict needs --task <id> and exactly one of --pass or --fail.'); process.exit(2); }
  const ifStatus = arg('if-status');
  if (!ifStatus && !flag('no-guard')) {
    console.error('\nverdict needs --if-status "<the status you claimed>" — normally --if-status "In review".');
    console.error('It refuses to write if the ticket moved while you were reviewing. Pass --no-guard only as a written claim.\n');
    process.exit(2);
  }
  if (ifStatus) {
    const was = (await readTask(task)).status?.status ?? '?';
    if (was.toLowerCase() !== ifStatus.toLowerCase()) {
      console.error(`\nNOTHING WRITTEN: expected "${ifStatus}", the ticket is now "${was}". It moved while you were reviewing.`);
      console.error(`Stand down: re-read with \`comments --task ${task}\` and \`get --task ${task}\`, then take the next task.\n`);
      process.exit(3);
    }
  }
  const note = arg('body-file') ? readBody(arg('body-file')).trim() : '';
  if (!passed) {
    const history = await readComments(task);
    const round = nextRound(history);
    if (wouldEscalate(history) && !flag('fourth-round-anyway')) {
      console.error(`\nNOTHING WRITTEN: this would be send-back round ${round}, and the loop escalates at ${ESCALATE_AT_ROUND}.`);
      console.error('Three rounds means the spec is wrong, not the build. Ask Dane instead:');
      for (const line of roundSummaryLines(history)) console.error(`  ${line}`);
      console.error(`\n  npm run clickup -- ask --task ${task} --status "Needs your input" --body-file -`);
      console.error('Offer him named options (respec / split / drop). --fourth-round-anyway overrides, on the record.\n');
      process.exit(3);
    }
    if (!note) { console.error('\nNOTHING WRITTEN: a send-back needs a reason (--body-file -). Its first line is what the board shows.\n'); process.exit(2); }
  }
  const { id } = await postComment(task, { comment_text: verdictComment(passed, note) });
  const after = await readComments(task);
  const gate = readyToLaunchGate(after);
  if (passed && !gate.ok) { console.error(`\nThe PASS verdict posted but does NOT read back as a pass: ${gate.why}.\n`); process.exit(1); }
  if (!passed && gate.ok) { console.error('\nA send-back posted, but the newest verdict still reads as a PASS. Check the ticket by eye.\n'); process.exit(1); }
  const rounds = sendBackRounds(after);
  console.log(`Task ${task}: verdict ${passed ? 'PASSED' : `sent back (round ${rounds})`} recorded as comment ${id}, verified through the Ready-to-launch gate itself.`);
  if (!passed) {
    console.log(`Next: npm run clickup -- status --task ${task} --status Rework --if-status "In review"`);
    if (rounds + 1 >= ESCALATE_AT_ROUND) console.log(`NOTE: a further send-back would be round ${rounds + 1} — the loop escalates to Dane at ${ESCALATE_AT_ROUND}.`);
  }
  reportLimits();

} else if (cmd === 'ask') {
  const task = arg('task'), bodyFile = arg('body-file');
  if (!task || !bodyFile) usage();
  const noMove = flag('no-move');
  const status = arg('status') || DISPLAY['needs your input'];
  if (!noMove && !isOperatorStatus(status)) {
    console.error(`\`ask\` hands work to Dane, so --status must be one of: ${OPERATOR_STATUSES.map((s) => DISPLAY[s]).join(', ')}. For a machine status use \`status\`.`);
    process.exit(2);
  }
  if (!noMove && await readyToLaunchRefused(task, status)) process.exit(2);
  let card, commentBody;
  try { ({ card, comment: commentBody } = buildCard(readBody(bodyFile))); } catch (err) { console.error(`\n${err.message}\n`); process.exit(2); }
  // @@ASKED is exempt: it is his own words, fenced on the card.
  refuseBranchLinks([card.context, card.needed, card.evidence].join('\n'), 'Nothing was posted and the status has NOT moved.');
  if (!noMove) { const stop = await alreadyAnsweredRefused(task, status); if (stop !== null) process.exit(stop); }
  if (!noMove) { const stop = await catchUpMergedRefused(task); if (stop !== null) process.exit(stop); }
  if (!noMove) { const stop = await alreadyAskedRefused(task, status); if (stop !== null) process.exit(stop); }
  const { id: cardId, stored } = await postComment(task, { comment: commentBody });
  const lost = cardSurvived(card, stored.comment_text);
  if (lost) { console.error(`\n${lost}\nComment ${cardId} is on the task. The status has NOT been moved.`); process.exit(1); }
  if (noMove) { console.log(`Task ${task}: card ${cardId} posted (status untouched, --no-move).`); reportLimits(); process.exit(0); }
  const was = (await readTask(task)).status?.status ?? '?';
  const moved = await tracker.updateTask(task, { status, assignees: { add: [OPERATOR_ID], rem: [] } });
  if (!moved.res.ok) { console.error(`The card posted (comment ${cardId}) but the status did NOT move.`); die('set status', moved); }
  const now = moved.json.status?.status ?? '?';
  if (now.toLowerCase() !== status.toLowerCase()) { console.error(`Card posted (comment ${cardId}), but the status did NOT stick: asked "${status}", got "${now}".`); process.exit(1); }
  if (!(moved.json.assignees || []).some((a) => a.id === OPERATOR_ID)) { console.error(`Card posted and status moved to "${now}", but Dane is NOT assigned — the handoff is incomplete.`); process.exit(1); }
  console.log(`Task ${task}: card ${cardId} posted, "${was}" -> "${now}", assigned: ${assigneeNames(moved.json)}.`);
  clearPassMarkerFor(task, now);
  reportLimits();

} else if (cmd === 'fixup-live') {
  // A catch-up ticket whose PR already merged closes itself (SP-288): the
  // pass that finds it moves it to Live with one note, and Dane is never asked.
  const task = arg('task');
  if (!task) usage();
  const ifStatus = arg('if-status');
  const r = await catchUpReading(task);
  const was = r.t.status?.status ?? '?';
  if (ifStatus && statusOf(was) !== statusOf(ifStatus)) {
    console.error(`NOT moved: expected status "${ifStatus}" but the task is "${was}" — another loop or Dane got there first.`);
    process.exit(3);
  }
  if (r.plan.act === 'cannot-tell') { console.error(`${task}: NOT moved — ${r.plan.why}. Try again, or carry on as before.`); process.exit(1); }
  if (r.plan.act !== 'close') { console.log(`${task}: left as it is — ${r.plan.why}. Carry on as before.`); process.exit(4); }
  const rem = (r.t.assignees || []).map((a) => a.id);
  const out = await tracker.updateTask(task, { status: DISPLAY[LIVE], assignees: { add: [], rem } }, { ifStatus: was });
  if (out.moved) { console.error(`NOT moved: the tracker refused the write — ${String(out.json?.err || 'the ticket moved').replace(/\.$/, '')}. Another loop or Dane got there first.`); process.exit(3); }
  if (!out.res.ok) die('set status', out);
  const back = await readTask(task);
  const now = back.status?.status ?? '?';
  if (statusOf(now) !== LIVE) { console.error(`Status did NOT stick: asked for "${DISPLAY[LIVE]}", the ticket reads back "${now}". No note was posted.`); process.exit(1); }
  if ((back.assignees || []).length) { console.error(`Moved to "${now}", but assignees did NOT clear: ${assigneeNames(back)}.`); process.exit(1); }
  clearPassMarkerFor(task, now);
  const note = fixupLiveNote({ unstuck: r.unstuck, mergedAt: mergedAtText(r.live?.mergedAt), from: was });
  const { id } = await postComment(task, { comment_text: note });
  console.log(`Task ${task}: "${was}" -> "${now}" (read back), note ${id} posted (read back): ${r.plan.why}.`);
  reportLimits();

} else if (cmd === 'relay') {
  // ── The merge lane (task 86bchpkxz) ───────────────────────────────────────
  // Dane's merge phrase on a `Ready to launch` ticket IS the merge
  // authorization the loop contract requires; this pass is the hands. It is
  // the same shape as StarCaster's bus-relay merge step, built on the
  // package's mergeOnComment: only his user id authorizes, only a ticket in
  // Ready to launch NOW, only with a PASS verdict his word is not older than,
  // only a PR the ticket recorded, and only when GitHub's own reading of that
  // PR is open, green, current and conflict-free. Every refusal is written on
  // the ticket once, naming the gate, and leaves his word unspent so the next
  // pass merges on it the moment the reason clears. A merged PR's marker is
  // spent forever. A script never resolves a conflict.
  //
  // The `Needs your input` hand-back (slice 2): his answer to the newest
  // machine-written question card releases the ticket to Queued, Rework or
  // Live by the contract's table (`handbackPlan` in lib/relayLane.js, on
  // busRelayPlan's rules). The move is read back, then his answer is marked
  // spent so a ticket he parks there again by hand stays put.
  const list = arg('list') || LOOP_QUEUE_LIST;
  const dryRun = flag('dry-run');
  const repo = project.githubRepo;
  const who = project.operatorName;
  const unchecked = [];
  const say = (task, outcome, detail) => console.log(relayLine({ task, status: task.status?.status, outcome, detail }));
  // Every ticket read this pass, for the auto-merge lanes' stop switch, and
  // the Ready to launch ones this pass merged or closed, which no lane judges.
  const seen = new Map();
  const settled = new Set();

  // The project's bus hears each merge and each refusal the first time it is
  // written on the ticket (SP-207). No `busProject`, nothing new is written.
  const busTag = machineSenderTag('bus-relay');
  const ticketUrl = (task) => task.url || `${filedTrackerUrl() || project.trackerUrl}/t/${task.id}`;
  const announce = busAnnouncer({ busProject: project.busProject, dryRun, postBus: postBusMessage, say, unchecked });
  // Conflict hand-offs a day old with nothing cleared (stalledHandOffPlan),
  // listed at the end of the pass. A stuck ticket is not a failed step, so
  // they do not change the exit code.
  const stalledHandOffs = [];

  /** Write the dedup marker as a threaded reply on his comment, and read it back.
   *  An unverified marker means the next pass may act on the same word again,
   *  which is reported, never assumed away. Returns true only when it stuck. */
  const markMergeHandled = async (commentId, task, what) => {
    const wanted = parseMergeMarker(`${MERGE_MARKER} ${what}`);
    const out = await tracker.replyToComment(commentId, { comment_text: `${MERGE_MARKER} ${what} — ${new Date().toISOString()}` });
    if (!out.res.ok) {
      unchecked.push(`${task.id} comment ${commentId}: acted on the merge command (${what}) but could NOT write the dedup marker (HTTP ${out.res.status}: ${String(out.json?.err || out.text || 'no reason given').slice(0, 300)}) — the NEXT pass will see this authorization as unhandled`);
      return false;
    }
    const verify = await tracker.listReplies(commentId);
    const replies = verify.res.ok ? (verify.json?.comments || verify.json?.replies || []) : [];
    const stuck = replies.some((r) => {
      const got = parseMergeMarker(r?.comment_text);
      return got && got.kind === wanted.kind && got.reason === wanted.reason;
    });
    if (!stuck) unchecked.push(`${task.id} comment ${commentId}: the merge marker did not read back — the NEXT pass may act on this authorization again`);
    return stuck;
  };

  /** Post a plain comment on the ticket and read it back. Returns the id, or null. */
  const postNote = async (task, body, about) => {
    const out = await tracker.postComment(task.id, { comment_text: body });
    if (!out.res.ok) { unchecked.push(`${task.id}: ${about}, but the note FAILED to post (HTTP ${out.res.status}) — ${who} has not been told`); return null; }
    const id = String(out.json?.id ?? '');
    const stored = (await readComments(task.id)).find((c) => String(c.id) === id);
    if (!stored || !(stored.comment_text || '').trim()) { unchecked.push(`${task.id}: ${about}, but the note did not read back intact (id ${id || 'none'})`); return null; }
    return id;
  };

  /** Move a merged ticket to its destination and read the move back. */
  // `nextPassRetries` (SP-216): the caller left his word open, so the next
  // pass makes the move again; nobody has to make it by hand.
  const moveMergedTicket = async (task, prNumber, dest, { nextPassRetries = false } = {}) => {
    const then = nextPassRetries ? 'the next pass tries again' : 'move it by hand';
    const rem = (task.assignees || []).map((a) => a.id);
    const out = await tracker.updateTask(task.id, { status: dest.status, assignees: { add: [], rem } });
    if (!out.res.ok) { unchecked.push(`${task.id}: PR #${prNumber} MERGED but the ticket did NOT move to ${dest.status} (HTTP ${out.res.status}) — ${then}`); return false; }
    const back = await readTaskOrNull(task.id);
    const now = back?.status?.status ?? '?';
    if (!back || now.toLowerCase() !== dest.status.toLowerCase()) { unchecked.push(`${task.id}: PR #${prNumber} MERGED but the move to ${dest.status} did not stick (${back ? `reads back "${now}"` : 'could not be read back'}) — ${then}`); return false; }
    const leftover = (back.assignees || []).map((a) => a.id);
    if (leftover.length) unchecked.push(`${task.id}: moved to ${dest.status} but assignees did not clear ([${leftover.join(', ')}])`);
    return true;
  };

  /** File the catch-up ticket for a conflicting PR in the Loop Queue, as
   *  Queued, and read it back. Returns { id, url } only when the ticket reads
   *  back with that name, in Queued, with a description; otherwise null, with
   *  the reason in `unchecked`. */
  // `ahead` ({ mergedNumber, files }): filed when main moved, before his
  // merge word (SP-294), so the body does not claim he has given it.
  const fileCatchUp = async (task, prRef, branch, name, commentId, ahead = null) => {
    const body = conflictTicketBody({ task, pr: prRef, branch, localVerdict: ahead ? aheadConflictVerdict(ahead) : null, commentId, ahead });
    const out = await tracker.createTask(list, {
      name, markdown_description: body, status: DISPLAY[QUEUED], priority: PRIORITY.high,
    });
    const id = out.res.ok && out.json?.id ? String(out.json.id) : '';
    if (!id) {
      unchecked.push(`${task.id}: PR #${prRef.number} conflicts, and filing the catch-up ticket FAILED (HTTP ${out.res.status}) — the next pass tries again`);
      return null;
    }
    const back = await readTaskOrNull(id);
    const now = String(back?.status?.status ?? '');
    if (!back || back.name !== name || now.toLowerCase() !== QUEUED || !String(back.description || '').trim()) {
      const why = !back ? 'it could not be read back' : `it reads back as "${back.name}" in "${now || '?'}"${String(back.description || '').trim() ? '' : ' with an empty description'}`;
      unchecked.push(`${task.id}: PR #${prRef.number} conflicts; catch-up ticket ${id} was created but ${why} — not counted as filed, a session must look`);
      return null;
    }
    return { id, url: out.json.url || back.url || `https://app.clickup.com/t/${id}` };
  };

  /** Write the `CONFLICT TICKET FILED:` trail on the waiting ticket — the
   *  line the next pass reads so it never files twice — and read it back
   *  through the same parser. Returns true only when it reads back. */
  const recordCatchUp = async (task, filed, prNumber, refiledFrom = null, localVerdict = null) => {
    const body = conflictTicketFiledComment({ id: filed.id, url: filed.url, prNumber, localVerdict, refiledFrom });
    const noteId = await postNote(task, body, `catch-up ticket ${filed.id} filed for PR #${prNumber}`);
    if (!noteId) return false;
    const found = findConflictTicket(await readComments(task.id), prNumber);
    if (!found || found.id !== filed.id) {
      unchecked.push(`${task.id}: the "CONFLICT TICKET FILED" line for ${filed.id} posted but does not read back — the next pass finds the ticket by name instead`);
      return false;
    }
    return true;
  };

  /** File the catch-up ticket for a `Ready to launch` PR that conflicts with
   *  the main a merge just made, before his merge word (SP-294). The same
   *  plan, ticket and trail the merge step uses at his word, so that step
   *  finds it on file and never files a second. */
  const fileConflictAhead = async ({ task, comments, pr, branch, verdict }, mergedNumber) => {
    // merge-tree found the overlap: a finding, so the real-conflict words.
    const ahead = { mergedNumber, files: verdict.files };
    const localVerdict = aheadConflictVerdict(ahead);
    const ticketName = conflictTicketName({ pr, branch, localVerdict });
    const trail = findConflictTicket(comments, pr.number);
    let filedStatus = null;
    if (trail) {
      const listed = tasks.find((t) => String(t.id).toLowerCase() === String(trail.id).toLowerCase());
      const read = listed || await readTaskOrNull(trail.id);
      filedStatus = read ? String(read.status?.status ?? '') : null;
    }
    const plan = conflictFilingPlan({ comments, prNumber: pr.number, queueTasks: tasks, ticketName, localVerdict, filedStatus });
    if (plan.act === 'cannot-tell') return { ok: false, problem: `the catch-up ticket on file (${plan.filed.id}) could not be read` };
    if (plan.act === 'none') return { ok: false, problem: 'the filing plan filed nothing' };
    let filed = plan.filed;
    if (plan.act === 'file') {
      filed = await fileCatchUp(task, pr, branch, ticketName, null, ahead);
      if (!filed) return { ok: false, problem: 'filing it failed (the reason is listed with the unchecked lines)' };
    }
    // A trail that does not read back is in `unchecked` already; the ticket
    // exists, and the merge step finds it by name.
    if (!plan.recorded) await recordCatchUp(task, filed, pr.number, plan.refiledFrom, localVerdict);
    return { ok: true, filed, already: plan.act !== 'file' };
  };

  /** main just moved: tell every ticket still in flight (task 86bctjffu),
   *  then keep each Ready to launch PR current, or file its fix-up (SP-294). */
  const afterMainMoved = async (task, mergedNumber) => {
    const news = await tellMainMoved({ mergedNumber, list, dryRun: false, tasks });
    for (const l of news.lines) console.log(`  main-moved\t${l}`);
    unchecked.push(...news.problems.map((p) => `main-moved after PR #${mergedNumber}: ${p}`));
    say(task, 'main-moved', `${news.told} in-flight ticket(s) told that PR #${mergedNumber} moved main`);
    if (!news.ctx) {
      unchecked.push(`ready-catch-up after PR #${mergedNumber}: not run, because main-moved could not read the merge, fetch or the open PRs (above) — no Ready to launch PR was checked`);
      return;
    }
    const { merge, base, openPrs } = news.ctx;
    const io = {
      readComments: readCommentsOrProblem,
      readStatus: async (id) => (await readTaskOrNull(id))?.status?.status ?? null,
      findPullRequest,
      contains: ({ branch }) => branchContains({ branch, mergeCommit: merge.oid, cwd: REPO_ROOT }),
      check: ({ branch }) => checkBranch({ base, branch, mergeCommit: merge.oid, cwd: REPO_ROOT }),
      // A catch-up ticket on file for this PR, still with the loops, owns
      // the branch (the newest trail; its status read from this pass's list).
      catchUpBeingWorked: async ({ comments, prNumber }) => {
        const trail = findConflictTicket(comments, prNumber);
        if (!trail) return null;
        const listed = tasks.find((t) => String(t.id).toLowerCase() === String(trail.id).toLowerCase());
        const read = listed || await readTaskOrNull(trail.id);
        const status = read ? statusOf(read) : '';
        if (!status) return { id: trail.id, cannotTell: true };
        return CATCH_UP_WORKED_STATUSES.includes(status) ? { id: trail.id, status: DISPLAY[status] || status } : null;
      },
      window: ({ pr: n }) => windowDecision({ read: readLeaseFile(mergeWindowPath()), repo, pr: n, now: new Date().toISOString() }),
      updateBranch: (n) => {
        const out = gh(['pr', 'update-branch', String(n), '--repo', repo]);
        return out.ok ? { ok: true } : { ok: false, why: out.stderr.trim().slice(0, 200) || 'gh failed' };
      },
      fileConflict: (args) => fileConflictAhead(args, mergedNumber),
    };
    const ready = await catchUpReadyTickets({ tasks, merge, base, repo, openPrs, dryRun: false, io });
    for (const l of ready.lines) console.log(`  ready-catch-up\t${l}`);
    unchecked.push(...ready.problems.map((p) => `ready-catch-up after PR #${mergedNumber}: ${p}`));
    say(task, 'ready-catch-up', `${ready.caughtUp} Ready to launch PR(s) caught up and ${ready.filed} catch-up ticket(s) filed after PR #${mergedNumber} moved main`);
  };

  /** Read a comment's reply thread, or null when it could not be read. */
  const readReplies = async (commentId) => {
    const out = await tracker.listReplies(commentId);
    return out.res.ok ? (out.json?.comments || out.json?.replies || []) : null;
  };

  /** The ticket's recorded PR, as handbackDestination wants it: null for no
   *  `PR opened:` line, else { number, state }, with state '' and a `why`
   *  when GitHub could not be read. A reading that failed is never a guess. */
  const handbackPr = (comments) => prStateOf(findPullRequest(comments));

  /** { owner, repo, number } -> { number, state }, the same way: null for
   *  none, state '' with a `why` when it could not be read. */
  const prStateOf = (found) => {
    if (!found) return null;
    if (`${found.owner}/${found.repo}`.toLowerCase() !== String(repo).toLowerCase()) {
      return { number: found.number, state: '', why: `the recorded PR is in ${found.owner}/${found.repo}, not ${repo}` };
    }
    const view = gh(['pr', 'view', String(found.number), '--repo', repo, '--json', 'state,number']);
    if (!view.ok) return { number: found.number, state: '', why: view.stderr.trim().slice(0, 200) || 'gh failed' };
    try { return { number: found.number, state: String(JSON.parse(view.stdout).state || '') }; } catch { return { number: found.number, state: '', why: 'gh returned non-JSON' }; }
  };

  // ── His close word on a Ready to launch ticket (SP-68) ──────────────────
  // Live once its work is merged (its own PR, or the PR a catch-up ticket
  // was filed to unstick); otherwise the reason, said once under his word.
  // The decision is closePlan's (lib/relayLane.js). Returns true when it
  // decided this ticket, so the merge step does not also act on it.
  const relayCloseReadyToLaunch = async (task, comments) => {
    const verdict = handbackAnswer({ comments, operatorId: OPERATOR_ID, isMachine: isMachineAuthored });
    if (verdict.state !== 'answered' || !isCloseCommand(verdict.answer?.comment_text)) return false;
    const answerId = verdict.answer.id;
    const replies = await readReplies(answerId);
    if (replies === null) {
      unchecked.push(`${task.id}: ${who} said to close it, but the replies under comment ${answerId} could not be read — not closed this pass`);
      say(task, 'unchecked', `could not read the replies under comment ${answerId}`);
      return true;
    }
    if (repliesShowHandbackDone(replies)) return false;
    const ownPr = handbackPr(comments);
    let unstuckPr = null;
    if (!ownPr) {
      const out = await tracker.getTask(task.id, { markdown: true });
      if (!out.res.ok || !out.json) {
        unchecked.push(`${task.id}: ${who} said to close it, but the description could not be read (HTTP ${out.res.status}) to find the PR it was filed to unstick — not closed this pass`);
        say(task, 'unchecked', `could not read the description (HTTP ${out.res.status})`);
        return true;
      }
      unstuckPr = prStateOf(unstuckPullRequest(out.json.markdown_description || out.json.description || ''));
    }
    const plan = closePlan({ verdict, answerReplies: replies, ownPr, unstuckPr });
    if (plan.act === 'not-close') return false;
    if (plan.act === 'cannot-tell') {
      unchecked.push(`${task.id}: ${who} said to close it, but ${plan.why}`);
      say(task, 'unchecked', plan.why);
      return true;
    }
    if (plan.act === 'refused-quiet') { say(task, 'close-refused-quiet', plan.why); return true; }

    if (plan.act === 'refuse') {
      if (dryRun) { say(task, 'would-refuse-close', plan.why); return true; }
      const note = await tracker.replyToComment(answerId, { comment_text: closeRefusedText({ why: plan.why, pending: plan.pending, at: new Date().toISOString() }) });
      const back = note.res.ok ? await readReplies(answerId) : null;
      if (!(back && latestCloseRefusal(back) === plan.why)) {
        unchecked.push(`${task.id}: did not close it (${plan.why}), and the reply saying so ${note.res.ok ? 'did not read back' : `FAILED (HTTP ${note.res.status})`} under comment ${answerId}`);
        say(task, 'unchecked', `close refused (${plan.why}); the reply did not stick`);
        return true;
      }
      say(task, 'close-refused', `${plan.why} — said under ${who}'s comment ${answerId}`);
      return true;
    }

    // plan.act === 'move'
    const target = plan.target;
    if (dryRun) { say(task, 'would-close', `-> "${target}" on ${who}'s comment ${answerId}: ${plan.why}`); return true; }
    // Re-read right before the write: if he moved it meanwhile, his move stands.
    const fresh = await readTaskOrNull(task.id);
    const before = String(fresh?.status?.status ?? '');
    if (!fresh || !isReadyToLaunch(before)) {
      if (!fresh) unchecked.push(`${task.id}: ${who} said to close it, but the ticket could not be re-read before the move — not closed this pass`);
      say(task, fresh ? 'skip' : 'unchecked', fresh ? `it moved to "${before || '?'}" during this pass — left where it is` : 'could not re-read the ticket before the move');
      return true;
    }
    const rem = (fresh.assignees || []).map((a) => a.id);
    const out = await tracker.updateTask(task.id, { status: target, assignees: { add: [], rem } });
    const back = out.res.ok ? await readTaskOrNull(task.id) : null;
    const now = String(back?.status?.status ?? '');
    if (!out.res.ok || now.toLowerCase() !== target.toLowerCase()) {
      const why = !out.res.ok ? `HTTP ${out.res.status}` : back ? `the ticket reads back as "${now || '?'}"` : 'the ticket could not be read back';
      // No done marker was written, so the next pass re-derives this and tries again.
      unchecked.push(`${task.id}: ${who} said to close it and its work is merged, but the move to "${target}" FAILED (${why}) — the next pass tries again`);
      say(task, 'unchecked', `move to "${target}" failed (${why})`);
      return true;
    }
    const leftover = (back.assignees || []).map((a) => a.id);
    if (leftover.length) unchecked.push(`${task.id}: closed to "${now}" but assignees did not clear ([${leftover.join(', ')}])`);
    const done = await tracker.replyToComment(answerId, { comment_text: handbackDoneText({ target: now, at: new Date().toISOString() }) });
    const doneBack = done.res.ok ? await readReplies(answerId) : null;
    const stuck = Boolean(doneBack && repliesShowHandbackDone(doneBack));
    if (!stuck) unchecked.push(`${task.id}: closed to "${now}", but the reply saying so under comment ${answerId} ${done.res.ok ? 'did not read back' : `FAILED (HTTP ${done.res.status})`}`);
    say(task, 'closed', `-> "${now}" on ${who}'s comment ${answerId}, reply ${stuck ? 'verified' : 'UNVERIFIED'}: ${plan.why}`);
    return true;
  };

  const relayReadyToLaunch = async (task) => {
    const comments = await readComments(task.id);
    seen.set(task.id, { task, comments });
    if (await relayCloseReadyToLaunch(task, comments)) { settled.add(task.id); return; }
    // Only his merge phrases need their reply threads read — that is where an
    // earlier pass left its marker. Everything else costs a request and says nothing.
    const books = emptyBooks();
    const hisPhrases = comments.filter((c) => isOperatorAuthored(c, OPERATOR_ID) && isMergeCommand(c.comment_text));
    for (const c of hisPhrases) {
      const out = await tracker.listReplies(c.id);
      if (!out.res.ok) {
        unchecked.push(`${task.id} comment ${c.id}: could not read its replies (HTTP ${out.res.status}) — NOT eligible to merge this pass`);
        books.handled.add(String(c.id));
        continue;
      }
      recordBookkeeping(books, c.id, markerBookkeeping(out.json?.comments || out.json?.replies || []));
    }
    const decision = mergeDecision({ status: task.status?.status, comments, operatorId: OPERATOR_ID, ...books });
    if (decision.act === 'ignore') { say(task, 'nothing', decision.reason); return; }

    // A refusal already given, for a reason that is still the true one, is not
    // news: quiet. Anything else is written on the ticket once, with its marker.
    const refuse = async (why, plainEnglish, refusalCode) => {
      if (decision.priorRefusal === why) { say(task, 'refused-quiet', `${why} (already said; nothing posted)`); return; }
      if (dryRun) { say(task, 'would-refuse', why); return; }
      let notice;
      try {
        notice = refusalNotice({ commentId: decision.commentId, why, plainEnglish, refusalCode });
      } catch (err) {
        // An unclassified code is a defect in the relay, not in the PR. Nothing
        // is invented for him to read; his word stays unspent; the pass goes on.
        unchecked.push(`${task.id}: merge refused (${why}) but the reason could not be classified (${err.message}) — nothing was posted; this is a defect in the relay`);
        say(task, 'unchecked', why);
        return;
      }
      const noteId = await postNote(task, notice.body, `merge refused (${why})`);
      if (!noteId) { say(task, 'unchecked', why); return; }
      const stuck = await markMergeHandled(decision.commentId, task, notice.marker);
      say(task, 'refused', `${why} — explained in comment ${noteId}, marker ${stuck ? 'verified' : 'UNVERIFIED'}`);
      await announce(task, refusalBusLine({ label: `"${task.name}" (${task.id})`, url: ticketUrl(task), why, kind: notice.kind }), `merge refused (${why})`);
    };

    if (decision.act === 'refuse') { await refuse(decision.reason, 'This ticket is not in a state a script may merge from.', decision.refusalCode); return; }

    const pr = decision.pr;
    if (`${pr.owner}/${pr.repo}`.toLowerCase() !== String(repo).toLowerCase()) {
      unchecked.push(`${task.id}: the recorded PR ${pr.url} is in ${pr.owner}/${pr.repo}, not this project's ${repo} — not merged; an agent session has to look`);
      say(task, 'unchecked', `PR #${pr.number} is in another repository (${pr.owner}/${pr.repo})`);
      return;
    }
    const view = gh(['pr', 'view', String(pr.number), '--repo', repo, '--json', PR_VIEW_FIELDS.join(',')]);
    if (!view.ok) {
      unchecked.push(`${task.id}: could not read PR #${pr.number} from GitHub (${view.stderr.trim().slice(0, 200)}) — merge authorization still pending`);
      say(task, 'unchecked', `could not read PR #${pr.number}`);
      return;
    }
    let prJson;
    try { prJson = JSON.parse(view.stdout); } catch { unchecked.push(`${task.id}: gh returned non-JSON for PR #${pr.number} — merge authorization still pending`); say(task, 'unchecked', `PR #${pr.number} unreadable`); return; }

    let gate = githubGate(prJson);

    // Already merged (SP-216): an earlier pass merged it and could not read
    // the result back, or it was merged by hand on GitHub. Nothing is left to
    // merge, so this is not a refusal: write the record the merge path below
    // writes after its own merge, move the ticket on, and tell the in-flight
    // tickets main moved (an earlier merge that never read back never did).
    // A ticket that already got the old "the PR is already merged" refusal
    // carries a re-decidable marker, so it lands here on its next pass too.
    {
      let dest = null;
      if (gate.refusalCode === REFUSAL_CODES.prAlreadyMerged) {
        // Where it goes hangs on the description's "Next slice:" line; never guess it.
        const out = await tracker.getTask(task.id, { markdown: true });
        if (!out.res.ok || !out.json) {
          unchecked.push(`${task.id}: PR #${pr.number} is already merged, but the description could not be read (HTTP ${out.res.status}) to see whether a next slice remains — nothing recorded this pass; the next pass tries again`);
          say(task, 'unchecked', `could not read the description (HTTP ${out.res.status})`);
          return;
        }
        dest = mergeDestination(out.json.markdown_description || out.json.description);
      }
      const plan = alreadyMergedPlan({ gate, prJson, pr, commentId: decision.commentId, priorRefusal: decision.priorRefusal, dest, verdictDate: decision.verdictDate });
      if (plan.act === 'stale') say(task, 'stale-merged', `${plan.reason} — refused as before`);
      if (plan.act === 'finish') {
        if (dryRun) {
          say(task, 'would-finish-merged', `PR #${pr.number} is already merged${plan.mergedAt ? ` (at ${plan.mergedAt})` : ''}; would move the ticket to "${dest.status}" because ${dest.why}, then record it and tell in-flight tickets main moved`);
          return;
        }
        // MOVE FIRST. The merge is already done, so nothing irreversible waits
        // on his word: it is spent only once the move has read back. A move
        // that fails writes nothing else, leaves his word open, and the next
        // pass finishes the job instead of leaving the ticket on the bell.
        settled.add(task.id);
        const moved = await moveMergedTicket(task, pr.number, dest, { nextPassRetries: true });
        if (!moved) {
          say(task, 'unchecked', `PR #${pr.number} is already merged, but the move to "${dest.status}" FAILED — nothing recorded, ${who}'s comment ${decision.commentId} left open; the next pass tries again`);
          return;
        }
        const noteId = await postNote(task, plan.body, `PR #${pr.number} already merged and the ticket moved to ${dest.status}`);
        const stuck = await markMergeHandled(decision.commentId, task, plan.marker);
        const failed = [!noteId && 'note FAILED', !stuck && 'marker UNVERIFIED'].filter(Boolean);
        say(task, 'already-merged', `PR #${pr.number}${plan.mergedAt ? ` merged at ${plan.mergedAt}` : ''}; ticket -> ${dest.status} (verified); recorded on ${who}'s comment ${decision.commentId}${failed.length ? ` (${failed.join(', ')}, see below)` : ''} (${dest.why})${plan.healed ? '; replaces the old "already merged" refusal' : ''}`);
        await announce(task, mergedBusLine({ tag: busTag, task, url: ticketUrl(task), pr, dest, already: true }), `PR #${pr.number} already merged`);
        await afterMainMoved(task, pr.number);
        return;
      }
    }

    // Behind main: the machine's own job. Catch it up through GitHub, let the
    // checks re-run, and decide on a later pass against the new run — never
    // merge on a green that described an older branch.
    if (gate.action === 'update-branch') {
      if (dryRun) { say(task, 'would-update-branch', `PR #${pr.number}: ${gate.reason}`); return; }
      const upd = gh(['pr', 'update-branch', String(pr.number), '--repo', repo]);
      if (upd.ok) { say(task, 'caught-up', `PR #${pr.number} was behind main; caught up, its checks re-run, the next pass decides`); return; }
      gate = { action: 'conflict', cannotTell: false, reason: `the branch could not be caught up with main (${upd.stderr.trim().slice(0, 200)})` };
    }

    if (gate.action === 'wait') { say(task, 'waiting', `PR #${pr.number}: ${gate.reason}`); return; }

    // A conflict is never resolved by a script. This pass does no local
    // cross-check (no scratch checkout on the relay machine yet), so the
    // notice says exactly that: GitHub reported it and nothing confirmed it.
    // What it does do is file the work (task 86bctbev9): a Queued ticket the
    // build loop drains, recorded on this ticket so no later pass files a
    // second one. The marker is re-decidable, so his word merges the branch
    // once it is fixed.
    if (gate.action === 'conflict' || gate.action === 'catch-up-locally') {
      const localVerdict = null;
      const prRef = { number: pr.number, url: pr.url };
      const branch = String(prJson.headRefName || '');
      const ticketName = conflictTicketName({ pr: prRef, branch, localVerdict });
      // The catch-up ticket on file counts only while a loop still works it
      // (SP-100), so read its status: from this pass's queue read, or by id
      // when it is not there (a Live ticket is not in the open list).
      const trail = findConflictTicket(comments, pr.number);
      let filedStatus = null;
      if (trail) {
        const listed = tasks.find((t) => String(t.id).toLowerCase() === String(trail.id).toLowerCase());
        const read = listed || await readTaskOrNull(trail.id);
        filedStatus = read ? String(read.status?.status ?? '') : null;
      }
      const plan = conflictFilingPlan({ comments, prNumber: pr.number, queueTasks: tasks, ticketName, localVerdict, filedStatus });
      if (plan.act === 'cannot-tell') {
        unchecked.push(`${task.id}: PR #${pr.number} conflicts, and the catch-up ticket on file (${plan.filed.id}) could not be read — not counted as on file and nothing filed; a session must look`);
        say(task, 'unchecked', `PR #${pr.number}: ${gate.reason} — catch-up ticket ${plan.filed.id} could not be read`);
        return;
      }
      const again = plan.refiledFrom ? ` (the earlier catch-up ${plan.refiledFrom.id} is in ${plan.refiledFrom.status}; main moved again)` : '';
      const reason = conflictHandOffNotice({ commentId: decision.commentId, pr: prRef, localVerdict, filed: null }).marker.replace(/^refused:\s*/i, '');
      const alreadySaid = decision.priorRefusal === reason;
      // Said before and nothing new filed: quiet, unless it is a day old (or
      // nothing was ever filed), and then it is news again.
      const stall = alreadySaid && plan.act !== 'file'
        ? stalledHandOffPlan({ priorRefusalAt: decision.priorRefusalAt, now: Date.now(), filed: plan.filed || null, localVerdict, tag: busTag, task, pr: prRef })
        : { act: 'quiet' };
      if (stall.act === 'stalled') stalledHandOffs.push({ line: stall.line, kind: stall.kind });

      // Filing comes BEFORE the "already said" check: a hand-off written
      // before this fix (or one whose filing failed) still gets its ticket
      // on the next pass, instead of staying quiet forever.
      if (dryRun) {
        const filing = plan.act === 'file' ? `would file "${ticketName}" as Queued in list ${list}${again}`
          : plan.act === 'already-filed' ? `catch-up ticket ${plan.filed.id} already on file${plan.recorded ? '' : ' (would record it on this ticket)'}${again}`
            : 'no catch-up ticket needed';
        const stuck = stall.act === 'stalled' ? `; STUCK: ${stall.why}${project.busProject ? ' — would post it to the bus' : ''}` : '';
        say(task, plan.act === 'file' ? 'would-file-catch-up' : stall.act === 'stalled' ? 'would-report-stalled' : alreadySaid ? 'refused-quiet' : 'would-refuse', `PR #${pr.number}: ${gate.reason} — ${filing}${alreadySaid ? '; hand-off already said' : ''}${stuck}`);
        return;
      }
      let filed = plan.filed;
      if (plan.act === 'file') filed = await fileCatchUp(task, prRef, branch, ticketName, decision.commentId);
      let recordedNow = false;
      if (filed && !plan.recorded) recordedNow = await recordCatchUp(task, filed, pr.number, plan.refiledFrom);

      if (alreadySaid && !recordedNow && stall.act === 'stalled') {
        say(task, 'stalled', `PR #${pr.number}: ${stall.why}`);
        // The bus is told, and only a reminder that landed restamps the
        // marker: that stamp is the clock, so a post nobody saw must not buy
        // a quiet day. No bus: the end-of-pass list below is the only place
        // it is said, as before.
        await remindStalledHandOff({ announce, task, stall, prNumber: pr.number,
          restamp: () => markMergeHandled(decision.commentId, task, conflictHandOffNotice({ commentId: decision.commentId, pr: prRef, localVerdict, filed }).marker) });
        return;
      }
      if (alreadySaid) {
        say(task, recordedNow ? 'filed' : 'refused-quiet', recordedNow
          ? `PR #${pr.number}: ${gate.reason} — catch-up ticket ${filed.id} filed and recorded${again} (hand-off already said)`
          : `${gate.reason} (already said; nothing posted)${filed ? '' : ' — the catch-up ticket could NOT be filed, see below'}`);
        return;
      }
      const notice = conflictHandOffNotice({ commentId: decision.commentId, pr: prRef, localVerdict, filed });
      const noteId = await postNote(task, notice.body, `merge refused (${gate.reason})`);
      if (!noteId) { say(task, 'unchecked', gate.reason); return; }
      const stuck = await markMergeHandled(decision.commentId, task, notice.marker);
      say(task, 'refused', `PR #${pr.number}: ${gate.reason} — explained in comment ${noteId}, marker ${stuck ? 'verified' : 'UNVERIFIED'}${filed ? `, catch-up ticket ${filed.id}${again}` : ', NO catch-up ticket'}`);
      await announce(task, conflictBusLine({ tag: busTag, task, url: ticketUrl(task), pr: prRef, filed, branch, operatorName: who }), `PR #${pr.number} conflict handed off`);
      return;
    }

    if (gate.action === 'refuse') { await refuse(gate.reason, `PR #${pr.number} is not in a state that can be merged safely.`, gate.refusalCode); return; }

    // gate.action === 'merge'. Where the ticket goes afterwards is decided
    // from the description BEFORE merging, so the dry run can say it too.
    const fresh = await readTask(task.id);
    const dest = mergeDestination(fresh.markdown_description || fresh.description);
    const preMerge = project.preMergeCommand;
    if (dryRun) {
      const step = preMerge ? `would first run the pre-merge step \`${commandLine(preMerge)}\` for ${String(prJson.headRefOid || '').slice(0, 12) || 'an unknown commit'} (not run in a dry run), then merge ` : '';
      say(task, 'would-merge', `${step}PR #${pr.number} (${gate.reason}); then "${dest.status}" because ${dest.why}`);
      return;
    }

    // --squash, never --admin, never any force: a convenience command does not
    // get to route around a standing decision. With a project pre-merge step
    // (SP-185), the step runs first and the merge is pinned to the commit it
    // saw; a step that fails merges nothing and is refused like any gate.
    const outcome = mergeWithPreMergeStep({
      command: preMerge,
      pr,
      repo,
      headSha: String(prJson.headRefOid || ''),
      baseBranch: String(prJson.baseRefName || ''),
      ticketId: task.id,
      runStep: (command, env, timeoutMs) => spawnSync(command[0], command.slice(1), {
        cwd: REPO_ROOT, env: { ...process.env, ...env }, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
      }),
      runGh: gh,
    });
    if (outcome.stage === 'pre-merge') {
      await refuse(outcome.refusal.why, outcome.refusal.plainEnglish, outcome.refusal.refusalCode);
      return;
    }
    const merged = outcome.merged;
    if (!merged.ok) { await refuse(`the merge command itself failed (${merged.stderr.trim().slice(0, 300)})`, `PR #${pr.number} could not be merged.`, REFUSAL_CODES.mergeCommandFailed); return; }

    // `gh` exiting 0 is not a merge. Read the PR back; only MERGED earns the record.
    const after = gh(['pr', 'view', String(pr.number), '--repo', repo, '--json', 'state,mergedAt,baseRefName']);
    let afterJson = null;
    try { afterJson = after.ok ? JSON.parse(after.stdout) : null; } catch { afterJson = null; }
    const state = String(afterJson?.state || '').toUpperCase();
    if (state !== 'MERGED') {
      unchecked.push(`${task.id}: \`gh pr merge\` exited 0 but PR #${pr.number} reads back as "${state || 'unreadable'}", not MERGED — nothing recorded on the ticket; the next pass re-decides`);
      say(task, 'unchecked', `PR #${pr.number} merge not observed`);
      return;
    }
    const mergedAt = afterJson.mergedAt || new Date().toISOString();

    // Spent forever, FIRST: if anything after this fails, the one thing that
    // must never happen (a second decision on a merged PR) still cannot.
    const record = mergedNotice({ commentId: decision.commentId, pr: { number: pr.number, url: pr.url }, mergedAt });
    await markMergeHandled(decision.commentId, task, record.marker);

    // The files the pull request made, linked on the branch it merged into
    // (SP-166). Read AFTER the merge is confirmed, so it can never stop or
    // change one; a list that cannot be read says so instead of guessing.
    const made = filesMadeLines({ repo, branch: afterJson.baseRefName, files: readPrFiles(repo, pr.number) });
    if (made.problem) unchecked.push(`${task.id}: PR #${pr.number} merged, but ${made.problem} — the merge note says so`);

    const body = [
      `Merged: PR #${pr.number} (${pr.url}) squash-merged into main at ${mergedAt}, on your comment ${decision.commentId}.`,
      'Checks were green and the branch was up to date at merge time; the branch has been deleted.',
      '',
      dest.status.toLowerCase() === 'live'
        ? `This ticket is now Live (${dest.why}).`
        : `This ticket goes back to ${dest.status} for the next build pass, because ${dest.why}.`,
      '',
      ...(outcome.step ? [`The project's pre-merge step (\`${commandLine(preMerge)}\`) passed first.${outcome.step.tail ? ' Its last lines of output:' : ' It printed nothing.'}`, ...(outcome.step.tail ? ['', '```', outcome.step.tail, '```'] : []), ''] : []),
      ...(made.lines.length ? [...made.lines, ''] : []),
      '(Automatic — relay merge step.)',
    ].join('\n');
    await postNote(task, body, `PR #${pr.number} MERGED`);
    const moved = await moveMergedTicket(task, pr.number, dest);
    settled.add(task.id);
    say(task, 'merged', `PR #${pr.number} at ${mergedAt}; ticket -> ${dest.status}${moved ? '' : ' (MOVE FAILED, see below)'} (${dest.why})`);
    await announce(task, mergedBusLine({ tag: busTag, task, url: ticketUrl(task), pr, dest }), `PR #${pr.number} merged`);

    // main just moved: tell every ticket still in flight, so its next pass
    // catches up before review instead of after (task 86bctjffu).
    await afterMainMoved(task, pr.number);
  };

  const tasks = await fetchAllTasks(list);
  const ready = tasks.filter((t) => isReadyToLaunch(t.status?.status)).sort(compareWithinStatus);
  const asked = tasks.filter((t) => statusOf(t) === NEEDS_YOUR_INPUT).sort(compareWithinStatus);
  console.error(`relay${dryRun ? ' — DRY RUN, nothing will be written' : ''}: ${ready.length} "Ready to launch", ${asked.length} "Needs your input" in list ${list}`);

  for (const t of ready) {
    // One ticket's crash must not end the pass for the tickets after it.
    try { await relayReadyToLaunch(t); } catch (err) {
      unchecked.push(`${t.id}: the relay stopped on this ticket (${err.message}) — nothing more was written for it`);
      say(t, 'unchecked', `the relay stopped on this ticket: ${err.message}`);
    }
  }
  const relayNeedsYourInput = async (task) => {
    const comments = await readComments(task.id);
    seen.set(task.id, { task, comments });
    const verdict = handbackAnswer({ comments, operatorId: OPERATOR_ID, isMachine: isMachineAuthored });
    let replies = [];
    if (verdict.state === 'answered') {
      replies = await readReplies(verdict.answer.id);
      if (replies === null) {
        unchecked.push(`${task.id}: could not read the replies under ${who}'s answer (comment ${verdict.answer.id}) — not moved this pass`);
        say(task, 'unchecked', `could not read the replies under comment ${verdict.answer.id}`);
        return;
      }
    }
    const pr = verdict.state === 'answered' ? handbackPr(comments) : null;
    // A merged PR goes to Live unless the description's "Next slice:" line
    // names more work (task 86bcrvwam) — the list read carries no markdown
    // description, so read the ticket itself, and never guess when it fails.
    let description;
    if (String(pr?.state || '').toUpperCase() === 'MERGED') {
      const out = await tracker.getTask(task.id, { markdown: true });
      if (!out.res.ok || !out.json) {
        unchecked.push(`${task.id}: ${who} answered and PR #${pr.number} is merged, but the description could not be read (HTTP ${out.res.status}) to see whether a next slice remains — not moved this pass`);
        say(task, 'unchecked', `could not read the description (HTTP ${out.res.status})`);
        return;
      }
      description = out.json.markdown_description || out.json.description || '';
    }
    const plan = handbackPlan({ status: task.status?.status, verdict, answerReplies: replies, pr, description });
    if (plan.act === 'waiting') { say(task, 'waiting', `waiting on ${who}: ${plan.why}`); return; }
    if (plan.act === 'cannot-tell') {
      unchecked.push(`${task.id}: ${who} answered, but ${plan.why}`);
      say(task, 'unchecked', plan.why);
      return;
    }
    if (plan.act !== 'move') { say(task, plan.act, plan.why); return; }

    const target = plan.target;
    const answerId = verdict.answer.id;
    if (dryRun) { say(task, 'would-hand-back', `-> "${target}" on ${who}'s comment ${answerId}: ${plan.why}`); return; }

    // The status above came from the list read at the start of the pass, and
    // the merge lane may have spent minutes since. Read it again right before
    // the write, the guard --if-status gives every other writer: if he moved
    // or re-parked it meanwhile, his move stands.
    const fresh = await readTaskOrNull(task.id);
    if (!fresh) {
      unchecked.push(`${task.id}: ${who} answered, but the ticket could not be re-read before the move — not moved this pass`);
      say(task, 'unchecked', 'could not re-read the ticket before the move');
      return;
    }
    const before = fresh.status?.status ?? '';
    if (before.toLowerCase() !== 'needs your input') {
      say(task, 'skip', `it moved to "${before || '?'}" during this pass — left where it is`);
      return;
    }

    // A machine status carries no assignees (the handoff rule): clear them in
    // the same write, then read the ticket back before believing either half.
    const rem = (fresh.assignees || []).map((a) => a.id);
    const out = await tracker.updateTask(task.id, { status: target, assignees: { add: [], rem } });
    const back = out.res.ok ? await readTaskOrNull(task.id) : null;
    const now = back?.status?.status ?? '';
    if (!out.res.ok || now.toLowerCase() !== target.toLowerCase()) {
      const why = !out.res.ok ? `HTTP ${out.res.status}`
        : back ? `the ticket reads back as "${now || '?'}"` : 'the ticket could not be read back';
      // Still in his status (or unreadable): the next pass re-derives it and
      // retries. Anywhere else: no pass reads it again, and the note says so.
      const stillHis = !back || now.toLowerCase() === 'needs your input';
      unchecked.push(stillHis
        ? `${task.id}: ${who} answered, but the move to "${target}" FAILED (${why}) — still in "${before}"; the next pass re-derives it and tries again`
        : `${task.id}: ${who} answered; the move to "${target}" was accepted but the ticket reads back as "${now}" — a session must look, no later pass will retry`);
      // Noted on his answer ONCE, not once per pass: a status write that keeps
      // failing would otherwise write the same note every ten minutes. Read
      // back like every other write.
      if (!plan.failureNoted) {
        const at = new Date().toISOString();
        const text = stillHis
          ? handbackFailureText({ target, status: before, why, at })
          : `${HANDBACK_FAILURE_MARKER} Your answer was delivered, but returning this ticket to "${target}" `
            + `did not stick: it reads back as "${now}". The relay only reads tickets in "Needs your input", `
            + `so no later pass will retry this; a session needs to look. (Automatic — bus-relay, ${at}.)`;
        const note = await tracker.replyToComment(answerId, { comment_text: text });
        const noteBack = note.res.ok ? await readReplies(answerId) : null;
        if (!(noteBack && repliesShowHandbackFailure(noteBack))) {
          unchecked.push(`${task.id}: could not record the failed move on comment ${answerId} either (${note.res.ok ? 'it did not read back' : `HTTP ${note.res.status}`})`);
        }
      }
      say(task, 'unchecked', `move to "${target}" failed (${why})`);
      return;
    }
    const leftover = (back.assignees || []).map((a) => a.id);
    if (leftover.length) unchecked.push(`${task.id}: moved to "${now}" but assignees did not clear ([${leftover.join(', ')}])`);

    // The move stuck, so his answer is spent. Written AFTER the read-back,
    // never before: a marker on a move that did not happen would stop the
    // retry. If it does not stick, the cost is that re-parking this ticket by
    // hand could release it again, and that is said out loud.
    const done = await tracker.replyToComment(answerId, {
      comment_text: handbackDoneText({ target: now, at: new Date().toISOString() }),
    });
    const doneBack = done.res.ok ? await readReplies(answerId) : null;
    const stuck = Boolean(doneBack && repliesShowHandbackDone(doneBack));
    if (!stuck) unchecked.push(`${task.id}: moved to "${now}", but the hand-back marker on comment ${answerId} ${done.res.ok ? 'did not read back' : `FAILED (HTTP ${done.res.status})`} — parking this ticket here again by hand could release it again`);
    say(task, 'handed-back', `-> "${now}" on ${who}'s comment ${answerId}, marker ${stuck ? 'verified' : 'UNVERIFIED'}: ${plan.why}`);
  };

  for (const t of asked) {
    try { await relayNeedsYourInput(t); } catch (err) {
      unchecked.push(`${t.id}: the relay stopped on this ticket (${err.message}) — nothing more was written for it`);
      say(t, 'unchecked', `the relay stopped on this ticket: ${err.message}`);
    }
  }

  // ── The auto-merge lanes: announce, wait the hour, merge (SP-202, SP-203) ─
  // StarCaster's Lanes A and B (docs/LOOP_CONTRACT.md, "StarCaster's
  // auto-merge lanes"), run only for the lanes the project config lists; with
  // none listed nothing below reads or writes anything. They run AFTER both
  // loops above, so the self-disable judges the whole pass's account of what
  // it could not check. At the end of an unopposed hour they merge
  // (SP-203), through laneMerge and recordLaneMerge above.
  // SP-203: the lane's merge and its bookkeeping are the phrase merge's own
  // steps above (the pre-merge step, `gh pr merge --squash` pinned to the
  // commit, the MERGED read-back, the Live move, MAIN MOVED), so the two
  // paths cannot drift. Only the authorization differs: the hour, not his word.
  const laneMerge = async ({ task, pr, view }) => {
    const outcome = mergeWithPreMergeStep({
      command: project.preMergeCommand,
      pr,
      repo,
      headSha: String(view.headRefOid || ''),
      baseBranch: String(view.baseRefName || ''),
      ticketId: task.id,
      runStep: (command, env, timeoutMs) => spawnSync(command[0], command.slice(1), {
        cwd: REPO_ROOT, env: { ...process.env, ...env }, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
      }),
      runGh: gh,
    });
    if (outcome.stage === 'pre-merge') return { outcome: 'refused', why: outcome.refusal.why };
    if (!outcome.merged.ok) return { outcome: 'refused', why: `the merge command itself failed (${outcome.merged.stderr.trim().slice(0, 300)})` };
    // `gh` exiting 0 is not a merge. Only MERGED, read back, is one.
    const after = gh(['pr', 'view', String(pr.number), '--repo', repo, '--json', 'state,mergedAt']);
    let afterJson = null;
    try { afterJson = after.ok ? JSON.parse(after.stdout) : null; } catch { afterJson = null; }
    const state = String(afterJson?.state || '').toUpperCase();
    if (state !== 'MERGED') return { outcome: 'not-observed', why: `\`gh pr merge\` exited 0 but PR #${pr.number} reads back as "${state || 'unreadable'}", not MERGED` };
    return { outcome: 'merged', mergedAt: afterJson.mergedAt || new Date().toISOString(), base: String(view.baseRefName || '') };
  };

  /** After a lane merge: the note, the Live (or Queued) move, MAIN MOVED. Problems are returned, never thrown. */
  const recordLaneMerge = async ({ task, pr, laneName, mergedAt, base = '', alreadyMerged = false }) => {
    const fresh = await readTaskOrNull(task.id);
    if (!fresh) return { ok: false, dest: null, problems: [`${task.id}: PR #${pr.number} is merged, but the ticket could not be read to move it on — move it by hand`] };
    const dest = mergeDestination(fresh.markdown_description || fresh.description);
    const made = alreadyMerged ? { lines: [], problem: '' } : filesMadeLines({ repo, branch: base || 'main', files: readPrFiles(repo, pr.number) });
    if (made.problem) unchecked.push(`${task.id}: PR #${pr.number} merged, but ${made.problem} — the merge note says so`);
    const body = [
      alreadyMerged
        ? `PR #${pr.number} (${pr.url}) is already merged${mergedAt ? ` (at ${mergedAt})` : ''}, so Lane ${laneName} has nothing left to merge.`
        : `Merged by Lane ${laneName}: PR #${pr.number} (${pr.url}) squash-merged into ${base || 'main'} at ${mergedAt}. The hour announced on this ticket ended with no comment from ${who}.`,
      ...(alreadyMerged ? [] : ['A review PASS was on file, checks were green and the branch was up to date at merge time.']),
      '',
      dest.status.toLowerCase() === 'live'
        ? `This ticket is now Live (${dest.why}).`
        : `This ticket goes back to ${dest.status} for the next build pass, because ${dest.why}.`,
      '',
      ...(made.lines.length ? [...made.lines, ''] : []),
      `(Automatic — Lane ${laneName}, relay auto-merge.)`,
    ].join('\n');
    await postNote(task, body, `PR #${pr.number} MERGED by Lane ${laneName}`);
    const moved = await moveMergedTicket(task, pr.number, dest);
    settled.add(task.id);
    say(task, alreadyMerged ? 'already-merged' : 'merged', `Lane ${laneName}: PR #${pr.number}; ticket -> ${dest.status}${moved ? '' : ' (MOVE FAILED, see below)'} (${dest.why})`);
    if (!alreadyMerged) {
      await afterMainMoved(task, pr.number);
    }
    // postNote, moveMergedTicket and tellMainMoved report into `unchecked` themselves.
    return { ok: moved, dest, problems: [] };
  };

  const lanes = Array.isArray(project.autoMergeLanes) ? project.autoMergeLanes : [];
  if (lanes.length) {
    const candidates = ready
      .filter((t) => !settled.has(t.id) && seen.has(t.id))
      .map((t) => seen.get(t.id));
    let laneOut;
    try {
      laneOut = await runLanePass({
        lanes,
        governancePaths: Array.isArray(project.governancePaths) ? project.governancePaths : null,
        candidates,
        switchTickets: [...seen.values()],
        operatorId: OPERATOR_ID,
        operatorName: who,
        mergePhrase: (project.mergePhrases || [])[0] || 'merge',
        repo,
        unchecked,
        dryRun,
        clock: clockAt,
        tag: machineSenderTag('relay'),
        io: { ...laneIo(repo), merge: laneMerge, recordMerge: recordLaneMerge },
        log: (line) => console.error(line),
      });
    } catch (err) {
      unchecked.push(`the auto-merge lanes stopped (${err.message}) — nothing more was written for them this pass`);
    }
    if (laneOut?.ran) {
      console.log(laneOut.line);
      if (laneOut.busSkipped.length) {
        console.error(`\nBUS — ${laneOut.busSkipped.length} post(s) or read(s) did not land:`);
        for (const line of laneOut.busSkipped) console.error(`  - ${line}`);
      }
    }
  }

  if (stalledHandOffs.length) {
    console.error(`\n${stalledSummaryHeadline(stalledHandOffs.map((h) => h.kind))} — ${stalledHandOffs.length} approved merge(s) are not moving:`);
    for (const h of stalledHandOffs) console.error(`  - ${h.line}`);
  }
  if (unchecked.length) {
    console.error(`\nUNCHECKED — ${unchecked.length} step(s) failed and say so:`);
    for (const line of unchecked) console.error(`  - ${line}`);
  }
  console.error(`relay done: ${ready.length + asked.length} ticket(s) looked at${dryRun ? ', nothing written (dry run)' : ''}.`);
  reportLimits();
  process.exit(unchecked.length ? 1 : 0);

} else if (cmd === 'bus-post' || cmd === 'bus-read') {
  // The bus (SP-24, lib/trackerBus.js): the project's alarm channel, a
  // tracker project of its own named in the project config. ClickUp has its
  // own bus in StarCaster's code; this door does not pretend to be it.
  if (project.tracker !== 'api') {
    console.error(`${cmd}: the bus is a tracker project, and this project's tracker is "${project.tracker}". Nothing was ${cmd === 'bus-post' ? 'posted' : 'read'}.`);
    process.exit(2);
  }
  const bus = project.busProject;
  if (!bus) {
    console.error(`${cmd}: this project has no bus. Name its tracker project as "busProject" in the project config (docs/TRACKER_MVP.md, "The bus"). Nothing was ${cmd === 'bus-post' ? 'posted' : 'read'}.`);
    process.exit(2);
  }
  const listed = await tracker.listTasksPage(bus, 0, { includeClosed: true });
  if (!listed.res.ok || !Array.isArray(listed.json?.tasks)) {
    if (listed.res.status === 404) {
      console.error(`${cmd}: the tracker has no project "${bus}" that this loop can see. Create it on the tracker's Projects page (or put this loop on it). Nothing was ${cmd === 'bus-post' ? 'posted' : 'read'}.`);
      process.exit(1);
    }
    die(`read the bus project ${bus}`, listed);
  }

  if (cmd === 'bus-post') {
    const bodyFile = arg('body-file');
    if (!bodyFile) usage();
    const post = trackerBus.renderBusPost({ text: readBody(bodyFile), node: arg('from') || hostname(), at: trackerBus.mountainTime(Date.now()) });
    if (!post) { console.error('bus-post: the message is empty. Nothing was posted.'); process.exit(2); }
    let chat = trackerBus.pickTeamChat(listed.json.tasks);
    if (!chat) {
      const made = await tracker.createTask(bus, {
        name: FALLBACK_TASK_NAME, markdown_description: trackerBus.renderTeamChatSeed(), status: trackerBus.TEAM_CHAT_STATUS,
      });
      if (!made.res.ok) die(`create the "${FALLBACK_TASK_NAME}" ticket in ${bus}`, made);
      chat = await readTask(made.json.id);
      if (String(chat.name) !== FALLBACK_TASK_NAME) {
        console.error(`bus-post: created ${made.json.id}, but it read back named ${JSON.stringify(chat.name)}. Nothing was posted.`);
        process.exit(1);
      }
      // Live is the only thing keeping a loop from claiming it (rule 5: read it back).
      if (statusOf(chat) !== trackerBus.TEAM_CHAT_STATUS.toLowerCase()) {
        console.error(`bus-post: created ${chat.id} "${chat.name}", but it read back in status ${JSON.stringify(statusOf(chat))}, not "${trackerBus.TEAM_CHAT_STATUS}", so a loop could claim it. Nothing was posted; move it to ${trackerBus.TEAM_CHAT_STATUS} on the page.`);
        process.exit(1);
      }
      console.error(`bus-post: there was no "${FALLBACK_TASK_NAME}" ticket in ${bus}; created ${chat.id} in ${trackerBus.TEAM_CHAT_STATUS} (read back).`);
    }
    const { id } = await postComment(chat.id, { comment_text: post });
    console.log(`Posted to the bus: comment ${id} on ${chat.id} "${chat.name}" in ${bus} (verified by reading it back).`);
    console.log(`  ${filedTrackerUrl() || project.trackerUrl}/t/${chat.id}`);
    // How loud it is (SP-163): the tracker sends the text, so this says what it will do, not that it did.
    console.log(trackerBus.isAlarmPost(post)
      ? `  It starts with ${trackerBus.ALARM_PREFIX}, so the tracker texts it to ${bus}'s alert phone (none set: no text; the tracker's log says which).`
      : `  Not an alarm (no ${trackerBus.ALARM_PREFIX} at the start), so no text: it counts in the page's "New on the Bus" number.`);
  } else {
    const since = trackerBus.parseSince(arg('since'));
    if (since && typeof since === 'object') { console.error(`bus-read: ${since.error}. Nothing was read.`); process.exit(2); }
    // One unreadable ticket must not hide the rest (Dane's stop word on Team
    // chat above all): name it, carry on, and fail at the end.
    const tickets = [];
    const unread = [];
    for (const t of listed.json.tasks) {
      const read = await readCommentsOrProblem(t.id);
      if (read.problem) { unread.push(t); console.error(`bus-read: could NOT read the comments on ${t.id} "${t.name}" (${read.problem}); its messages are missing below.`); continue; }
      tickets.push({ id: t.id, name: t.name, comments: read.comments });
    }
    const messages = trackerBus.busMessages(tickets, { operatorId: OPERATOR_ID, operatorOnly: flag('operator'), since });
    for (const m of messages) console.log(trackerBus.busLine(m));
    console.error(`${messages.length} message(s) on the bus (${bus}, ${tickets.length} ticket(s) read in full)${flag('operator') ? ', the operator\'s only' : ''}${since != null ? ` after ${trackerBus.mountainTime(since)}` : ''}.`);
    if (unread.length) {
      console.error(`bus-read FAILED on ${unread.length} ticket(s): ${unread.map((t) => t.id).join(', ')}. The list above is incomplete.`);
      reportLimits();
      process.exit(1);
    }
  }
  reportLimits();

} else if (cmd === 'tickets') {
  // Tickets as data (SP-205, lib/ticketsJson.js): what StarCaster's scheduled
  // checks read instead of ClickUp's API. Read-only. Every read must come
  // back, or nothing is printed: a check that counts half a list as the whole
  // reports a quiet queue that is not quiet.
  if (!flag('json')) {
    console.error('tickets: say --json (the one format it prints). Nothing was read.');
    usage();
  }
  const slug = arg('project');
  if (process.argv.includes('--project') && !slug) usage();
  const list = slug || LOOP_QUEUE_LIST;
  const withComments = flag('comments');
  const listed = await fetchAllTasks(list, { includeClosed: flag('include-closed'), strict: true });
  const out = [];
  const problems = [];
  for (const t of listed) {
    const since = await tracker.getTimeInStatus(t.id);
    const statusSince = since.res.ok ? ticketsJson.statusSinceFrom(since.json) : null;
    if (!since.res.ok || !statusSince) {
      problems.push({ id: t.id, what: 'status history', problem: since.res.ok ? 'no time it entered its status' : `HTTP ${since.res.status}${since.json?.err ? `: ${since.json.err}` : ''}` });
    }
    let comments;
    if (withComments) {
      const read = await readCommentsOrProblem(t.id);
      if (read.problem) problems.push({ id: t.id, what: 'comments', problem: read.problem });
      else comments = read.comments;
    }
    out.push(ticketsJson.ticketJson(t, { statusSince, comments, operatorId: OPERATOR_ID }));
  }
  const failed = ticketsJson.failedReadsLine(problems);
  if (failed) {
    console.error(failed);
    reportLimits();
    process.exit(1);
  }
  console.log(JSON.stringify(out, null, 2));
  console.error(`${out.length} ticket(s) in ${slug || (project.tracker === 'api' ? project.projectSlug : `list ${LOOP_QUEUE_LIST}`)}${flag('include-closed') ? ', Live included' : ', open only'}${withComments ? ', with their comments' : ''}.`);
  reportLimits();

} else if (cmd === 'stage-counts') {
  // Every stage counted, as JSON, for StarCaster's weekly report
  // (lib/stageCounts.js holds the shape and the counting). Read-only. `--list`
  // is StarCaster's spelling and means the same as `--project`.
  for (const name of ['project', 'list', 'since', 'until']) {
    if (process.argv.includes(`--${name}`) && !arg(name)) usage();
  }
  if (arg('project') && arg('list') && arg('project') !== arg('list')) {
    console.error(`stage-counts: --project "${arg('project')}" and --list "${arg('list')}" name two different places; give one. Nothing was read.`);
    process.exit(2);
  }
  const since = arg('since');
  const until = arg('until');
  // The dates are checked before anything is read: a typo is found for free.
  const window = stageCounts.parseWindow(since, until);
  if (window.error) {
    console.error(`stage-counts: ${window.error} Nothing was read.`);
    process.exit(2);
  }
  const list = arg('project') || arg('list') || LOOP_QUEUE_LIST;
  // On the tracker the configured list id stands for this project: say its name.
  const where = String(list) === String(LOOP_QUEUE_LIST) && project.tracker === 'api' ? project.projectSlug : list;
  const tickets = await fetchAllTasks(list, { includeClosed: true, strict: true });
  // Each ticket's history only when there is a window to count in it. Every
  // one must come back, or nothing is printed: a report that counts half the
  // history as the whole of it prints a quiet week that was not quiet.
  const histories = new Map();
  const problems = [];
  if (window.cutoff != null) {
    for (const t of tickets) {
      const read = await tracker.getStatusHistory(t.id);
      if (read.res.ok && Array.isArray(read.json?.moves)) histories.set(String(t.id), read.json.moves);
      else problems.push({ id: t.id, problem: read.res.ok ? 'no status moves in the answer' : `HTTP ${read.res.status}${read.json?.err ? `: ${read.json.err}` : ''}` });
    }
  }
  const failed = stageCounts.failedHistoryLine(problems);
  if (failed) {
    console.error(failed);
    reportLimits();
    process.exit(1);
  }
  console.log(JSON.stringify(stageCounts.countStages(tickets, { list: where, since, until, window, histories }), null, 2));
  console.error(`stage-counts: ${tickets.length} ticket(s) in ${where}${window.cutoff == null ? ', no window' : `, window ${since} to ${until || 'now'} (UTC days)`}.`);
  reportLimits();

} else if (cmd === 'settings') {
  // The pipeline controls Dane sets on the Settings page (SP-224), for the
  // lanes to read: this project's, as the project config names it, never a
  // literal. Every control is printed, defaults included, or nothing is: a
  // lane that reads half a list would run on a default it was told to drop.
  const out = await tracker.pipelineSettings();
  if (!out.res.ok) die('read the pipeline controls', out);
  const lines = out.json.controls.map((c) => `${c.key}=${c.value}`);
  if (out.json.controls.some((c) => typeof c.key !== 'string' || c.value == null)) {
    console.error('read the pipeline controls FAILED — the tracker answered a control without a name or a value. Nothing was printed.');
    process.exit(1);
  }
  for (const l of lines) console.log(l);
  const changed = out.json.controls.filter((c) => !c.isDefault).length;
  console.error(`settings: ${lines.length} pipeline control(s) for ${project.projectSlug}, ${changed} changed from the default.`);
  reportLimits();

} else if (cmd === 'wip-check') {
  // Asked by loop-build before it claims (its SKILL.md, SP-238): is the
  // number of tickets in flight at the cap Dane set on the Settings page?
  // Read-only. The deciding is lib/wipCheck.js; this block only reads the
  // three facts it needs. Any fact that cannot be read is exit 1, "could not
  // tell", and the pass goes on and says so (the cap fails open, as
  // lib/wipCap.js explains).
  const stop = (why) => {
    const v = unknownVerdict(why);
    console.log(v.line);
    reportLimits();
    process.exit(v.code);
  };
  let settings;
  try {
    const out = await tracker.pipelineSettings();
    if (out.unsupported) settings = { unsupported: true };
    else if (!out.res.ok) settings = { ok: false, why: `HTTP ${out.res.status}${out.json?.err ? `: ${out.json.err}` : ''}` };
    else settings = { ok: true, controls: out.json.controls };
  } catch (err) {
    settings = { ok: false, why: err.message };
  }
  const cap = capInForce({ settings, env: process.env });
  if (cap.cap == null) stop(cap.why);
  // Every ticket, closed ones too: a pull request whose ticket is Live must
  // be known as that, not as "no ticket found".
  const tickets = [];
  try {
    for (let page = 0; ; page += 1) {
      if (page >= 50) stop('the ticket list ran past 50 pages, so the count would be a guess');
      const out = await tracker.listTasksPage(LOOP_QUEUE_LIST, page, { includeClosed: true });
      if (!out.res.ok || !Array.isArray(out.json?.tasks)) stop(`the tickets could not be listed (HTTP ${out.res.status})`);
      tickets.push(...out.json.tasks);
      if (out.json.last_page !== false || out.json.tasks.length === 0) break;
    }
  } catch (err) {
    stop(`the tickets could not be listed: ${err.message}`);
  }
  const prs = gh(['pr', 'list', '--repo', project.githubRepo, '--state', 'open', '--json', 'number,state,body', '--limit', '500']);
  if (!prs.ok) stop(`GitHub's open pull requests for ${project.githubRepo} could not be listed: ${prs.stderr.trim().split('\n')[0] || 'gh failed'}`);
  let openPrs;
  try { openPrs = JSON.parse(prs.stdout); } catch { openPrs = null; }
  if (!Array.isArray(openPrs)) stop('GitHub answered the pull request list with something that is not a list');
  const verdict = wipCheckVerdict({ tickets, prs: openPrs, cap: cap.cap });
  console.log(verdict.line);
  console.error(`wip-check: cap ${cap.cap} from ${cap.source}; ${verdict.detail}`);
  reportLimits();
  process.exit(verdict.code);

} else if (cmd === 'pause-check') {
  // Asked by a lane's runner before every pass (scripts/pause_check.sh,
  // SP-237): is the whole pipeline, or this lane, paused on the Settings
  // page? One line on stdout, which the runner logs. It fails safe: a read
  // that did not work is exit 3, paused, in words that say so; only a project
  // whose tickets are not on the tracker (no controls exist) runs unasked.
  // A lane the controls do not list is not refused here: the verdict finds
  // no switch for it and counts it as paused, saying which setting is missing.
  const lane = arg('lane');
  if (!lane || !/^[a-z][a-z-]*$/.test(lane)) {
    console.error(`pause-check: refused — --lane names the lane asking, e.g. loop-build or relay; got ${lane == null ? 'none' : `"${lane}"`}.`);
    process.exit(2);
  }
  let read;
  try {
    const out = await tracker.pipelineSettings();
    if (out.unsupported) read = { unsupported: true, why: out.json?.err };
    else if (!out.res.ok) read = { ok: false, why: `HTTP ${out.res.status}${out.json?.err ? `: ${out.json.err}` : ''}` };
    else read = { ok: true, controls: out.json.controls, changes: out.json.changes };
  } catch (err) {
    read = { ok: false, why: err.message };
  }
  const verdict = settingsPauseVerdict(read, lane);
  console.log(verdict.line);
  reportLimits();
  process.exit(verdict.code);

} else if (cmd === 'release') {
  // Spirality's releases (SP-265, docs/INTEGRATION.md "How a change reaches
  // the projects"). A release is a tag on Spirality's main; which one each
  // project runs is the tracker's record. The tags are read from the remote
  // of the Spirality checkout this door runs from, never a local copy.
  const sub = process.argv[3];
  const git = (args) => spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 });
  const remote = releaseRemote();
  const refuse = (why) => { console.error(`release ${sub}: refused — ${why}`); reportLimits(); process.exit(2); };
  const fail = (why) => { console.error(`release ${sub} FAILED — ${why}`); reportLimits(); process.exit(1); };
  const all = await tracker.releases();
  if (!all.res.ok) {
    if (all.unsupported) refuse(all.json.err);
    die('read the releases', all);
  }
  const ownProject = all.json.ownProject ?? null;

  if (sub === 'list') {
    for (const p of all.json.projects) {
      console.log(`${p.slug}\t${p.own ? OWN_PROJECT_RELEASE : p.release ?? 'none named'}`);
    }
    const read = readReleaseTags({ git, remote });
    if (read.problem) fail(`the projects are above, but the newest release could not be read: ${read.problem}`);
    console.error(`release list: ${all.json.projects.length} project(s); the newest release is ${read.tags[0]?.name ?? 'none (no release cut yet: npm run release -- cut)'}.`);
    if (!ownProject) console.error('  (the tracker could not say which project is Spirality\'s own: its project config was not usable when it started.)');
    reportLimits();

  } else if (sub === 'name' || sub === 'back') {
    const slug = arg('project');
    const to = sub === 'name' ? arg('to') : null;
    if (!slug || (sub === 'name' && !to)) usage();
    if (!ownProject) fail('the tracker cannot say which project is Spirality\'s own (its project config was not usable when it started), so no release can be named.');
    const target = all.json.projects.find((p) => p.slug === slug);
    if (!target) refuse(`no project "${slug}" that this sign-in can see.`);
    if (slug === ownProject) refuse(`${slug} is Spirality's own project: Spirality's own lanes always run main, so no release is named for it.`);
    if (sub === 'name') {
      if (!isReleaseName(to)) refuse(`"${to}" is not a release name; a release is named release-<n>, n a whole number from 1.`);
      const read = readReleaseTags({ git, remote });
      if (read.problem) fail(`could not check that ${to} exists: ${read.problem}`);
      if (!read.tags.some((t) => t.name === to)) {
        refuse(`${to} has no tag on ${remote}${read.tags.length ? `; the newest release is ${read.tags[0].name}` : '; no release has been cut yet (npm run release -- cut)'}.`);
      }
    }
    const out = sub === 'name' ? await tracker.nameRelease(slug, to) : await tracker.rollBackRelease(slug);
    if (!out.res.ok) {
      const why = out.json?.err || out.json?.message || String(out.text || '').slice(0, 300);
      if (out.res.status >= 400 && out.res.status < 500) refuse(why);
      fail(`HTTP ${out.res.status}: ${why}`);
    }
    const saved = out.json.saved;
    const back = await tracker.projectRelease(slug);
    if (!back.res.ok) fail(`the tracker answered, but the record could not be read back (HTTP ${back.res.status}); treat it as not saved.`);
    if (back.json.release !== saved.to) fail(`${slug}'s release read back as ${back.json.release ?? 'none'}, not ${saved.to}; treat it as not saved.`);
    console.log(`${slug}\t${back.json.release}`);
    console.error(saved.changed
      ? `release ${sub}: ${slug} now runs ${saved.to} (it ran ${saved.from ?? 'none named'}), read back.`
      : `release ${sub}: ${slug} already runs ${saved.to}; nothing written.`);
    reportLimits();

  } else {
    usage();
  }

} else if (cmd === 'main-moved') {
  // The relay runs this step after every merge it makes; a session that
  // merged by hand runs it with the PR it merged.
  const mergedNumber = Number(String(arg('pr', '')).replace(/^#/, ''));
  if (!Number.isInteger(mergedNumber) || mergedNumber <= 0) usage();
  const list = arg('list') || LOOP_QUEUE_LIST;
  const dryRun = flag('dry-run');
  const { lines, problems, told } = await tellMainMoved({ mergedNumber, list, dryRun });
  for (const l of lines) console.log(l);
  if (!lines.length && !problems.length) console.error(`No ticket in Building, In review or Rework in list ${list} — nobody to tell.`);
  for (const p of problems) console.error(`FAILED: ${p}`);
  console.error(`main-moved: PR #${mergedNumber}, ${dryRun ? 'DRY RUN, nothing written' : `${told} ticket(s) told`}.`);
  reportLimits();
  process.exit(problems.length ? 1 : 0);

} else {
  console.error(`Unknown command "${cmd}".`);
  usage();
}
