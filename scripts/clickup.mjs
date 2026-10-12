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
 * The token comes from the environment, never printed and never logged.
 * package.json wraps this in `doppler run --project spirality --config dev`,
 * so no agent or human handles the value:
 *
 *   npm run clickup -- whoami
 *
 * Run `npm run clickup` bare for the command list. Data goes to stdout
 * (tab-separated where a caller would parse it); counts and diagnostics go to
 * stderr, so piping stdout is always safe.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  DISPLAY, STAGE_ORDER, CLAIMABLE_BY_BUILD, OPERATOR_STATUSES, BUILDING, PRIORITY_VALUE,
  isClaimableByBuild, isOperatorStatus, isReadyToLaunch, claimOrder, compareWithinStatus,
} from './lib/loopStatuses.mjs';
import {
  prOpenedComment, verdictComment, commentsReadable, prTrailLanded, bodyNamesTicket,
  readyToLaunchGate, nextRound, wouldEscalate, roundSummaryLines, sendBackRounds, operatorSpokeLast,
  findPullRequest, newestFirst, ESCALATE_AT_ROUND,
} from './lib/loopTrail.mjs';
import { buildCard, cardSurvived, findBlockquoteLines, CONTEXT_MIN_WORDS, CONTEXT_MAX_WORDS } from './lib/operatorCard.mjs';
import { stampCommentBody, isCommentPostPath, isMachineComment, stripMachineMarker } from './lib/machineComment.mjs';

import { loadProjectConfig, ProjectConfigError } from '../lib/projectConfig.mjs';

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
const TOKEN = process.env.CLICKUP_API_TOKEN;
export const WORKSPACE = project.workspaceId;
export const SPACE = project.spaceId;                // the product's SPACE
export const LOOP_QUEUE_LIST = project.loopQueueListId; // the Loop Queue LIST
/** Dane's seat. Every handoff assigns this id. The token ALSO acts as this
 *  seat (`whoami` says so), which is why every comment this script posts is
 *  stamped with the machine marker — see lib/machineComment.mjs. */
export const OPERATOR_ID = Number(project.operatorUserId);
/** The workspace's service account. NEVER assign it. */
export const MACHINE_ID = Number(project.machineUserId);
const API = process.env.CLICKUP_API_BASE || 'https://api.clickup.com';
const HTTP_TIMEOUT_MS = Number(process.env.CLICKUP_HTTP_TIMEOUT_MS) || 60 * 1000;

const PRIORITY = PRIORITY_VALUE;

// ── Argument helpers ─────────────────────────────────────────────────────────
function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes(`--${name}`); }
function readBody(spec) { return spec === '-' ? readFileSync(0, 'utf8') : readFileSync(spec, 'utf8'); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── The HTTP door ────────────────────────────────────────────────────────────
let requests = 0;
const limits = { limit: null, remaining: null, reset: null };

function unreachable(err) {
  return { res: { ok: false, status: 0, headers: { get: () => null } }, json: null, text: `the request never reached ClickUp (${err?.message || err})` };
}

async function callOnce(method, path, body) {
  requests += 1;
  // THE ONE PLACE A MACHINE COMMENT IS MARKED. The loops post under Dane's own
  // seat, so a reader cannot tell their writing from his by author alone.
  const sendBody = (method === 'POST' && isCommentPostPath(path)) ? stampCommentBody(body) : body;
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: TOKEN, 'Content-Type': 'application/json' },
      body: sendBody ? JSON.stringify(sendBody) : undefined,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    return unreachable(err);
  }
  limits.limit = res.headers.get('x-ratelimit-limit') ?? limits.limit;
  limits.remaining = res.headers.get('x-ratelimit-remaining') ?? limits.remaining;
  limits.reset = res.headers.get('x-ratelimit-reset') ?? limits.reset;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { res, json, text };
}

/** A 429 is ClickUp itself throttling; it clears within a minute and is safe to repeat. */
async function call(method, path, body) {
  for (let attempt = 1; ; attempt += 1) {
    const out = await callOnce(method, path, body);
    if (out.res.status !== 429 || attempt >= 3) return out;
    const reset = Number(out.res.headers.get('x-ratelimit-reset'));
    const waitMs = Number.isFinite(reset) && reset > 0 ? Math.max(1000, reset * 1000 - Date.now()) : 15000;
    console.error(`  ClickUp rate limit (attempt ${attempt}) — waiting ${Math.round(waitMs / 1000)}s and trying again`);
    await sleep(Math.min(waitMs, 65000));
  }
}

function reportLimits() {
  if (limits.limit == null && limits.remaining == null) return;
  console.error(`  ClickUp's own limit: ${limits.remaining ?? '?'} of ${limits.limit ?? '?'} left this minute (${requests} request(s) this run)`);
}

function die(label, { res, json, text }) {
  console.error(`\n${label} FAILED — HTTP ${res.status}`);
  console.error(json?.err || json?.error || String(text || '').slice(0, 500));
  if (res.status === 401) {
    if (/team not authorized/i.test(String(json?.err || json?.error || text))) {
      console.error('\n"Team not authorized" usually means the ID is the wrong KIND of thing — a space id where a');
      console.error(`list id belongs (the SPACE is ${SPACE}; the Loop Queue LIST is ${LOOP_QUEUE_LIST}).`);
      console.error('Run `npm run clickup -- lists` to resolve list ids by name before blaming the token.');
    } else {
      console.error('\n401 means the token is wrong or expired — not that ClickUp is down.');
      console.error(`The token lives in Doppler (${project.dopplerProject}/${project.dopplerConfig}, CLICKUP_API_TOKEN).`);
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
  lists [--space <id>]                            resolve list ids by name (default: the project's space)
  queue [--list <id>] [--claimable | --status S]  the tickets, one per line: id, status, priority, created, name
  get --task <id>                                 header + body
  task-name --task <id>                           the name and nothing else (for a PR title)
  comments --task <id>                            the comments, oldest first
  waiting [--task <id>]                           read-only: is this ACTUALLY waiting on Dane? exit 0 no / 3 yes / 1 could not tell
  task --name "..." --body-file <f|-> [--list <id>] [--status S] [--priority p] [--tags a,b] [--id-out <file>]
  describe --task <id> --body-file <f|->          REPLACE the description (the left column)
  comment --task <id> --body-file <f|->           a plain note
  claim --task <id>                               safe claim: reads the status and guards the write on it
  status --task <id> --status S [--if-status S] [--assign <uid>] [--clear-assignees] [--no-auto-assign] [--no-card]
  ask --task <id> [--status "Needs your input"|"Ready to launch"] --body-file <f|-> [--no-move] [--after-his-answer]
  pr-opened --task <id> --pr <url|number> [--repo owner/name] [--if-missing] [--body-file <f|->]
  verdict --task <id> --pass|--fail --if-status "In review" [--body-file <f|->] [--no-guard] [--fourth-round-anyway]
  priority --task <id> --priority urgent|high|normal|low [--operator-asked]
  tag --task <id> --add <name> | --remove <name>  e.g. wont-do, deferred, an epic name

Statuses (matched case-insensitively): ${STAGE_ORDER.join(' / ')}.
Two are Dane's and only \`ask\` may set them: ${OPERATOR_STATUSES.map((s) => DISPLAY[s]).join(', ')}.
`);
  process.exit(code);
}

// ── Readers ──────────────────────────────────────────────────────────────────
async function fetchAllTasks(list, { includeClosed = false } = {}) {
  const tasks = [];
  const closed = includeClosed ? '&include_closed=true' : '';
  for (let page = 0; page < 50; page += 1) {
    const out = await call('GET', `/api/v2/list/${list}/task?archived=false${closed}&page=${page}`);
    if (!out.res.ok) die('list tasks', out);
    if (!out.json || !Array.isArray(out.json.tasks)) die('list tasks (the response body was not the expected JSON)', out);
    tasks.push(...out.json.tasks);
    if (out.json.last_page !== false || out.json.tasks.length === 0) return tasks;
  }
  console.error('Stopped after 50 pages — treat this output as INCOMPLETE.');
  return tasks;
}

async function readTask(task) {
  const out = await call('GET', `/api/v2/task/${task}?include_markdown_description=true`);
  if (!out.res.ok) die('read the task', out);
  return out.json;
}

async function readComments(task) {
  const out = await call('GET', `/api/v2/task/${task}/comment`);
  if (!out.res.ok) die('read comments', out);
  if (!commentsReadable(out.json)) die('read comments (no comment list in the body)', out);
  return out.json.comments;
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

async function postComment(task, body) {
  const out = await call('POST', `/api/v2/task/${task}/comment`, body);
  if (!out.res.ok) die('post comment', out);
  const id = String(out.json?.id ?? '');
  const stored = (await readComments(task)).find((c) => String(c.id) === id);
  if (!stored || !(stored.comment_text || '').trim()) {
    console.error(`Comment did NOT land intact: id ${id || '(none)'} ${stored ? 'saved empty' : 'not found on the task'}.`);
    process.exit(1);
  }
  return { id, stored };
}

// ── Commands ─────────────────────────────────────────────────────────────────
if (!TOKEN) {
  console.error('CLICKUP_API_TOKEN is not set in this environment.\n');
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
  process.argv = [...process.argv.slice(0, 2), 'status', ...process.argv.slice(3), '--status', DISPLAY[BUILDING], '--if-status', now];
  console.error(`claiming ${task} out of "${now}" (guarded on that exact status)`);
  cmd = 'status';
}

if (cmd === 'whoami') {
  const out = await call('GET', '/api/v2/user');
  if (!out.res.ok) die('whoami', out);
  console.log(`Token valid. Acting as: ${out.json.user.username} <${out.json.user.email}> (id ${out.json.user.id})`);
  if (Number(out.json.user.id) === OPERATOR_ID) console.error("  (This is Dane's own seat, as on StarCaster. Every comment this script posts carries the [machine] marker so readers can tell.)");
  reportLimits();

} else if (cmd === 'lists') {
  const space = arg('space') || SPACE;
  const [folderless, folders] = await Promise.all([
    call('GET', `/api/v2/space/${space}/list?archived=false`),
    call('GET', `/api/v2/space/${space}/folder?archived=false`),
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
  const tasks = await fetchAllTasks(list);
  let wanted;
  if (claimable) wanted = claimOrder(tasks);
  else {
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
  console.log(`url:      ${t.url}`);
  console.log('---');
  console.log(t.markdown_description || t.description || '(no body)');
  reportLimits();

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
    const who = isMachineComment(c.comment_text) ? `${c.user?.username ?? '?'} [machine]` : (c.user?.username ?? '?');
    console.log(`[${clock(c.date)} MT] ${who} (${c.user?.id ?? '?'}, comment ${c.id}):`);
    console.log(stripMachineMarker(c.comment_text) || '(empty)');
    console.log('---');
  }
  console.error(`${comments.length} comment(s) on task ${task}`);
  reportLimits();

} else if (cmd === 'waiting') {
  const task = arg('task');
  const tasks = task ? [await readTask(task)] : (await fetchAllTasks(LOOP_QUEUE_LIST)).filter((t) => isOperatorStatus(t.status?.status));
  let his = 0;
  for (const t of tasks) {
    const comments = await readComments(t.id);
    const newest = newestFirst(comments)[0];
    const assigned = (t.assignees || []).some((a) => a.id === OPERATOR_ID);
    const status = t.status?.status ?? '?';
    let verdict;
    if (!isOperatorStatus(status)) verdict = `NOT HIS — status "${status}" is a machine status`;
    else if (operatorSpokeLast(comments, OPERATOR_ID)) verdict = 'ANSWERED — his comment is the newest; a machine owes the next move';
    else { verdict = `WAITING ON DANE — "${status}"${assigned ? '' : ' (but he is NOT assigned — fix the handoff)'}`; his += 1; }
    const lastWord = newest ? `${isMachineComment(newest.comment_text) ? 'a loop' : (newest.user?.username ?? '?')} ${clock(newest.date)} MT` : '(no comments)';
    console.log(`${t.id}\t${status}\tassigned: ${assigned ? 'Dane' : 'not Dane'}\tlast word: ${lastWord}\t${verdict}\t${t.name}`);
  }
  console.error(`${his} ticket(s) actually waiting on Dane${task ? '' : ` in list ${LOOP_QUEUE_LIST}`}.`);
  process.exit(his ? 3 : 0);

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
  const tags = arg('tags') ? arg('tags').split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const out = await call('POST', `/api/v2/list/${list}/task`, {
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
  const out = await call('PUT', `/api/v2/task/${task}`, { markdown_description: body });
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
    console.error(`The card: @@ASKED (his words, verbatim) / @@WHEN (optional) / @@CONTEXT (${CONTEXT_MIN_WORDS}-${CONTEXT_MAX_WORDS} words) / @@NEEDED (the ask) / @@EVIDENCE (costly asks only).`);
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
  const out = await call('PUT', `/api/v2/task/${task}`, body);
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
  reportLimits();

} else if (cmd === 'priority') {
  const task = arg('task'), wanted = String(arg('priority', '')).toLowerCase();
  if (!task || !(wanted in PRIORITY)) usage();
  if (wanted === 'urgent' && !flag('operator-asked')) { console.error('Urgent is reserved for Dane. Add --operator-asked only if he explicitly asked.'); process.exit(1); }
  const before = await readTask(task);
  const out = await call('PUT', `/api/v2/task/${task}`, { priority: PRIORITY[wanted] });
  if (!out.res.ok) die('set priority', out);
  const now = out.json.priority?.priority ?? '(none)';
  if (now !== wanted) { console.error(`Priority did NOT stick: asked "${wanted}", got "${now}".`); process.exit(1); }
  console.log(`Task ${task}: priority "${before.priority?.priority ?? '(none)'}" -> "${now}".`);
  reportLimits();

} else if (cmd === 'tag') {
  const task = arg('task'), add = arg('add'), remove = arg('remove');
  if (!task || (!add && !remove) || (add && remove)) usage();
  const name = encodeURIComponent(add || remove);
  const out = await call(add ? 'POST' : 'DELETE', `/api/v2/task/${task}/tag/${name}`);
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
  if (!bodyNamesTicket(prJson.body, task)) {
    console.error(`\nPR #${prNumber} has no link back to this ticket in its body, so nothing was written.`);
    console.error(`Add this line to the PR body and run again:\n  ClickUp: https://app.clickup.com/t/${task}\n`);
    process.exit(4);
  }
  let already = false;
  if (flag('if-missing') && prTrailLanded(await readComments(task), prNumber).ok) {
    already = true;
    console.log(`Task ${task}: PR #${prNumber} is already recorded — nothing written.`);
  }
  if (!already) {
    const text = prOpenedComment(prUrl, arg('body-file') ? readBody(arg('body-file')) : '');
    await postComment(task, { comment_text: text });
    const landed = prTrailLanded(await readComments(task), prNumber);
    if (!landed.ok) { console.error(`\nThe "PR opened" trail did NOT land: ${landed.why}. Fix the comment by hand before handing this to review.\n`); process.exit(1); }
    console.log(`Task ${task}: PR #${prNumber} recorded (${prUrl}), read back and parsed by the gate's own reader.`);
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
  if (!noMove) { const stop = await alreadyAnsweredRefused(task, status); if (stop !== null) process.exit(stop); }
  const { id: cardId, stored } = await postComment(task, { comment: commentBody });
  const lost = cardSurvived(card, stored.comment_text);
  if (lost) { console.error(`\n${lost}\nComment ${cardId} is on the task. The status has NOT been moved.`); process.exit(1); }
  if (noMove) { console.log(`Task ${task}: card ${cardId} posted (status untouched, --no-move).`); reportLimits(); process.exit(0); }
  const was = (await readTask(task)).status?.status ?? '?';
  const moved = await call('PUT', `/api/v2/task/${task}`, { status, assignees: { add: [OPERATOR_ID], rem: [] } });
  if (!moved.res.ok) { console.error(`The card posted (comment ${cardId}) but the status did NOT move.`); die('set status', moved); }
  const now = moved.json.status?.status ?? '?';
  if (now.toLowerCase() !== status.toLowerCase()) { console.error(`Card posted (comment ${cardId}), but the status did NOT stick: asked "${status}", got "${now}".`); process.exit(1); }
  if (!(moved.json.assignees || []).some((a) => a.id === OPERATOR_ID)) { console.error(`Card posted and status moved to "${now}", but Dane is NOT assigned — the handoff is incomplete.`); process.exit(1); }
  console.log(`Task ${task}: card ${cardId} posted, "${was}" -> "${now}", assigned: ${assigneeNames(moved.json)}.`);
  reportLimits();

} else {
  console.error(`Unknown command "${cmd}".`);
  usage();
}
