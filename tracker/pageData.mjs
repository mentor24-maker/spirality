/**
 * The data behind Dane's page (docs/TRACKER_MVP.md, "Dane's page"): what
 * waits on him, one ticket's thread with each comment's author named, the
 * projects, one project's details, one project's board, the Reporting
 * page's figures, and a search across every ticket.
 *
 * The page never decides anything itself. "Is this waiting on him?" is the
 * loop's own verdict, lib/waitingOnOperator.js, the same module `npm run
 * clickup -- waiting` reads, fed the tracker's rows in the ClickUp shape it
 * expects. "Did a machine write this?" is lib/machineComment.js, the same
 * check the relay makes. Two answers from two definitions would drift, and
 * a page that says "waiting on you" when `waiting` says otherwise is the
 * failure that module exists to remove.
 */
import waitingOnOperator from '../lib/waitingOnOperator.js';
import machineComment from '../lib/machineComment.js';
import loopStatuses from '../lib/loopStatuses.js';
import mergeOnComment from '../lib/mergeOnComment.js';
import humanHours from '../lib/humanHours.js';
import busFallback from '../lib/busFallback.js';
import { compareWithinStatus } from '../scripts/lib/loopStatuses.mjs';
import { searchPattern } from './web/render.mjs';
import { STAGES } from './pipeline.mjs';

const { OPERATOR_LANE, WAITING, CANNOT_TELL, waitingVerdict, operatorSpokeLast } = waitingOnOperator;
const { isMachineComment, stripMachineMarker } = machineComment;
const { STAGE_ORDER, LIVE, QUEUED, REWORK, OPERATOR_HELD_STATUSES, TERMINAL_STATUSES, DISPLAY, PRIORITY_RANK, statusOf } = loopStatuses;
const { findPullRequest } = mergeOnComment;
const { findHumanHours } = humanHours;
const { isTeamChatTask } = busFallback;

/**
 * The projects a reader may see: every one when `only` is null (a loop, an
 * admin), else only those whose slug `only` (a Set) holds. Every page that
 * reads across projects narrows through this, so a person who is not an
 * admin never sees a project they are not on (store.projectsVisibleTo).
 */
function visibleProjects(store, only) {
  const all = store.listProjects();
  return only == null ? all : all.filter((p) => only.has(p.slug));
}

/** A ticket's comments in the shape the loop trail's readers take (findPullRequest, findHumanHours). */
function trailComments(store, ticketId) {
  return store.listComments(ticketId).map((c) => ({
    id: c.id, comment_text: c.body, date: String(Date.parse(c.createdAt)),
  }));
}

/**
 * A ticket and its comments in the shape waitingVerdict reads. Comments go
 * newest first: the verdict sorts by date, and two comments in the same
 * millisecond must resolve to the later one, not the earlier.
 */
function verdictInput(ticket, comments) {
  return {
    task: {
      status: { status: ticket.status },
      assignees: ticket.assignee == null ? [] : [{ id: ticket.assignee }],
    },
    comments: comments.slice().reverse().map((c) => ({
      user: { id: c.author },
      comment_text: c.body,
      date: String(Date.parse(c.createdAt)),
    })),
  };
}

/**
 * Is his answer in? The ticket sits in one of his two statuses and his own
 * comment is the newest word on it, so the relay owes the next move (SP-93).
 * The same rule the Waiting on you list drops a ticket by (operatorSpokeLast,
 * rule 1 of waitingVerdict), so the page and that list cannot disagree.
 * `operatorId` is the project's operator; with none, never.
 */
function answerIsIn(ticket, comments, operatorId) {
  if (operatorId == null || !OPERATOR_LANE.includes(ticket.status)) return false;
  return operatorSpokeLast(verdictInput(ticket, comments).comments, { operatorId });
}

/**
 * Does the ticket wait on `viewerId`? Exactly the test waitingFor lists a
 * ticket by: one of the operator's two statuses and a WAITING verdict for
 * that person. With no viewer, never.
 */
function waitsOn(ticket, comments, viewerId) {
  if (viewerId == null || !OPERATOR_LANE.includes(ticket.status)) return false;
  return waitingVerdict(verdictInput(ticket, comments), { operatorId: viewerId }).verdict === WAITING;
}

/**
 * The bus count in the page's header (Dane's choice D on the bus ticket): every
 * "Team chat" ticket (lib/busFallback.js, by its name) on a project `only`
 * lets through, with how many of its comments `actorId` has not seen
 * (store.unseenCount: newer than their seen mark, never their own). Only
 * tickets with something unseen are listed, most unseen first; `total` adds
 * them up.
 */
export function busUnseen(store, actorId, { only = null } = {}) {
  const unseen = [];
  for (const project of visibleProjects(store, only)) {
    for (const ticket of store.listTickets(project.slug)) {
      if (!isTeamChatTask(ticket)) continue;
      const count = store.unseenCount({ actor: actorId, ticket: ticket.id });
      if (count > 0) unseen.push({ id: ticket.id, name: ticket.name, project: project.slug, projectName: project.name, count });
    }
  }
  unseen.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  return { total: unseen.reduce((n, t) => n + t.count, 0), unseen };
}

/**
 * Every ticket in the operator's two statuses, across every project `only`
 * lets through (visibleProjects), with the loop's verdict for `operatorId`. `waiting` holds the WAITING ones;
 * `unsure` holds the ones the verdict cannot decide (his status, but not
 * assigned to him), so a half-finished hand-off is shown, never dropped.
 * Both newest first, by the ticket's last change.
 */
export function waitingFor(store, operatorId, { only = null } = {}) {
  const waiting = [];
  const unsure = [];
  for (const project of visibleProjects(store, only)) {
    for (const status of OPERATOR_LANE) {
      for (const ticket of store.listTickets(project.slug, { status })) {
        const result = waitingVerdict(verdictInput(ticket, store.listComments(ticket.id)), { operatorId });
        const row = {
          id: ticket.id,
          project: project.slug,
          projectName: project.name,
          status: ticket.status,
          name: ticket.name,
          updatedAt: ticket.updatedAt,
          why: result.why,
        };
        if (result.verdict === WAITING) waiting.push(row);
        else if (result.verdict === CANNOT_TELL) unsure.push(row);
      }
    }
  }
  const newestFirst = (a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);
  return { waiting: waiting.sort(newestFirst), unsure: unsure.sort(newestFirst) };
}

/**
 * One ticket with its comments oldest first, each carrying its author's name
 * and kind, and `machine`: true when a machine actor wrote it, or when it
 * carries the machine stamp (a loop posting under Dane's own token). The
 * stamp line itself is taken off the shown text; `machine` says it instead.
 * `answerIn` says his answer is in (answerIsIn). Null when there is no such ticket.
 */
export function threadOf(store, ticketId) {
  const ticket = store.getTicket(ticketId);
  if (!ticket) return null;
  const project = store.getProject(ticket.project);
  const actors = new Map();
  const actor = (id) => {
    if (!actors.has(id)) actors.set(id, store.getActor(id) ?? { id, kind: 'unknown', name: `actor ${id}` });
    return actors.get(id);
  };
  const comments = store.listComments(ticket.id).map((c) => {
    const author = actor(c.author);
    const stamped = isMachineComment(c.body);
    return {
      id: c.id,
      parent: c.parent,
      author,
      machine: author.kind === 'machine' || stamped,
      body: stamped ? stripMachineMarker(c.body) : c.body,
      createdAt: c.createdAt,
    };
  });
  return {
    ...ticket,
    projectName: project?.name ?? ticket.project,
    assignee: ticket.assignee == null ? null : actor(ticket.assignee),
    // The one person the ticket may be assigned to, for the ticket page's picker.
    operator: namedActor(store, project?.operator),
    comments,
    answerIn: answerIsIn(ticket, store.listComments(ticket.id), project?.operator),
    pullRequest: findPullRequest(trailComments(store, ticket.id))?.url ?? null,
  };
}

/** An actor by id and name, or null for none; one that is gone is named by its id. */
function namedActor(store, id) {
  if (id == null) return null;
  return { id, name: store.getActor(id)?.name ?? `actor ${id}` };
}

/**
 * Every project, for the Projects screen: slug, name, ticket-id prefix, web
 * address, logo, owner by name and GitHub repository (each null when it has none), and how many
 * of its tickets are open (any status but Live), its operator by name
 * (null when it has none) and its members `{ id, name }`, in the store's order.
 * `only` narrows it to the projects the reader may see (visibleProjects).
 */
export function projectsList(store, { only = null } = {}) {
  return visibleProjects(store, only).map((p) => ({
    slug: p.slug,
    name: p.name,
    prefix: p.prefix,
    url: p.url,
    logo: p.logo,
    owner: namedActor(store, p.owner),
    repo: p.repo,
    open: store.listTickets(p.slug, { open: true }).length,
    // The Projects page's Members column: who is on it, and who may not be taken off.
    operator: namedActor(store, p.operator),
    members: (store.listMembers(p.slug) ?? []).map(({ id, name }) => ({ id, name })),
  }));
}

/**
 * One project's details page: its slug, name, ticket-id prefix, its
 * operator by name (null when it has none), its web address, logo, owner
 * by name and GitHub repository (each null when it has none), how many tickets are open, and
 * a count for each of the eight statuses in the contract's STAGE_ORDER, the
 * board's own column order. Null when there is no such project.
 *
 * `withAlerts` adds its alert email and phone (each null when it has none),
 * for a person's Edit project form; a loop's answer never carries them.
 */
export function projectDetailsOf(store, slug, { withAlerts = false } = {}) {
  const project = store.getProject(slug);
  if (!project) return null;
  const counts = new Map(STAGE_ORDER.map((name) => [statusOf(name), 0]));
  for (const ticket of store.listTickets(project.slug)) {
    if (counts.has(ticket.status)) counts.set(ticket.status, counts.get(ticket.status) + 1);
  }
  return {
    slug: project.slug,
    name: project.name,
    prefix: project.prefix,
    operator: namedActor(store, project.operator),
    url: project.url,
    logo: project.logo,
    owner: namedActor(store, project.owner),
    repo: project.repo,
    open: store.listTickets(project.slug, { open: true }).length,
    statuses: STAGE_ORDER.map((name) => ({ status: name, count: counts.get(statusOf(name)) })),
    members: store.listMembers(project.slug),
    ...(withAlerts ? { alertEmail: project.alertEmail, alertPhone: project.alertPhone } : {}),
  };
}

/**
 * One project's board: the eight statuses as columns, left to right in the
 * contract's STAGE_ORDER, each holding its tickets in the order `npm run
 * clickup -- queue --status <S>` prints them. The order is the door's own
 * comparator (compareWithinStatus: priority, then oldest), fed each ticket
 * in the ClickUp shape it reads, so the board and `queue` cannot disagree.
 * The list view draws the same object as rows, so each ticket also carries
 * its assignee's name, its last change, and its pull request's address (or
 * null). The pull request is the merge step's own answer, findPullRequest
 * over the ticket's comments, so the list's link and the PR a "merge" would
 * act on cannot differ. `answerIn` says his answer is in (answerIsIn, the
 * same as the ticket page). `waiting` says the ticket waits on `viewerId`,
 * the person signed in: the same verdict, for the same person, that puts it
 * on their Waiting on You page (waitingFor), so the list's clock and that
 * page cannot disagree (SP-201). With no `viewerId`, never. Null when there
 * is no such project.
 */
export function boardOf(store, slug, { viewerId = null } = {}) {
  const project = store.getProject(slug);
  if (!project) return null;
  const byStatus = new Map(STAGE_ORDER.map((name) => [statusOf(name), []]));
  for (const ticket of store.listTickets(project.slug)) byStatus.get(ticket.status)?.push(ticket);
  const queueShape = (t) => ({
    priority: t.priority ? { priority: t.priority } : null,
    date_created: String(Date.parse(t.createdAt)),
  });
  const inQueueOrder = (a, b) => compareWithinStatus(queueShape(a), queueShape(b));
  const pullRequestOf = (id) => findPullRequest(trailComments(store, id))?.url ?? null;
  const names = new Map();
  const nameOf = (id) => {
    if (id == null) return null;
    if (!names.has(id)) names.set(id, store.getActor(id)?.name ?? `actor ${id}`);
    return names.get(id);
  };
  return {
    project: project.slug,
    projectName: project.name,
    columns: STAGE_ORDER.map((name) => ({
      status: name,
      tickets: byStatus.get(statusOf(name)).slice().sort(inQueueOrder).map((t) => ({
        id: t.id,
        name: t.name,
        priority: t.priority,
        tags: t.tags,
        assignee: nameOf(t.assignee),
        updatedAt: t.updatedAt,
        pullRequest: pullRequestOf(t.id),
        answerIn: answerIsIn(t, store.listComments(t.id), project.operator),
        waiting: waitsOn(t, store.listComments(t.id), viewerId),
        // SP-208: the List view's priority dropdown saves with it (ifVersion).
        version: t.version,
      })),
    })),
  };
}

/**
 * Which loop lane acts next on a ticket in each in-flight status, by its
 * name in tracker/pipeline.mjs's STAGES. A status not named
 * here is either Building (a build pass has it now) or one of the
 * operator's two (OPERATOR_LANE: it waits on him, no lane is due).
 */
const NEXT_LANE = new Map([
  [statusOf('Requested'), 'Intake'],
  [statusOf('Queued'), 'Build'],
  [statusOf('Rework'), 'Build'],
  [statusOf('In review'), 'Review'],
]);
const BUILDING = statusOf('Building');
const BUILDING_LANE = 'Build';

/** A lane by its name in STAGES: `{ lane, job }`. */
function laneOf(name) {
  const stage = STAGES.find((s) => s.name === name);
  return { lane: stage.name, job: stage.job };
}

/**
 * When a ticket entered its present status: the newest event in its
 * history that set its status (or filed it) to that status. Its last change
 * (`updatedAt`) when the history records no such step.
 */
function stageSinceOf(store, ticket) {
  let at = null;
  for (const e of store.listEvents(ticket.id)) {
    if ((e.field === 'status' || e.field === 'created') && e.to === ticket.status) at = e.at;
  }
  return at ?? ticket.updatedAt;
}

/**
 * A ticket's next change, from the Pipeline Status answer for the project
 * whose loop logs this tracker reads (`lanes`, keyed by job, or null for
 * any other project or when the logs cannot be read):
 *  - Building: `{ kind: 'running', lane, job }`, a build pass has it now;
 *  - the operator's two statuses: `{ kind: 'operator' }`, no lane is due;
 *  - Requested, Queued, Rework, In review: `{ kind: 'lane', lane, job,
 *    running, due }`, the lane that acts on it, whether a pass of it runs
 *    now, and when its next pass is due (ISO, null while one runs);
 *  - null when that lane's time cannot be read (no logs for this project,
 *    a lane with no pass logged, or one idle with no next time), never a guess.
 */
function nextChangeOf(status, lanes) {
  if (OPERATOR_LANE.includes(status)) return { kind: 'operator' };
  if (status === BUILDING) return { kind: 'running', ...laneOf(BUILDING_LANE) };
  if (!NEXT_LANE.has(status) || !lanes) return null;
  const { lane, job } = laneOf(NEXT_LANE.get(status));
  const stage = lanes.get(job);
  if (!stage || !stage.logged) return null;
  if (stage.running) return { kind: 'lane', lane, job, running: true, due: null };
  if (!stage.nextDue) return null;
  return { kind: 'lane', lane, job, running: false, due: stage.nextDue };
}

/**
 * The Console view's answer (SP-221): every ticket in flight (any status but
 * Live) on every project `only` lets through (visibleProjects), with the
 * facts a Console tile shows, so the page works nothing out itself.
 *
 * `{ projects: [{ slug, name, prefix, logo }], tickets: [{ id, project,
 * name, status, tags, priority, assignee, updatedAt, stageSince,
 * waitingOnOperator, answerIn, pullRequest, nextChange }] }`. Tickets go
 * in the contract's STAGE_ORDER, then `queue` order within a status (as
 * boardOf). `status` is the contract's own spelling; `assignee` is by name;
 * `waitingOnOperator` is the loop's own verdict (waitingVerdict) for the
 * ticket's project operator, the same rule his Waiting on You page lists by;
 * `answerIn` says his answer is in (answerIsIn); `pullRequest` is the merge
 * step's own answer (findPullRequest), or null.
 *
 * `pipeline` is `{ slug, stages }`: GET /pipeline's answer (pipelineOf) and
 * the project whose logs it read. Only that project's tickets get a lane's
 * time (nextChangeOf); null, or another project, gets none.
 */
export function consoleOf(store, { only = null, pipeline = null } = {}) {
  const projects = visibleProjects(store, only);
  const lanes = pipeline?.stages ? new Map(pipeline.stages.map((s) => [s.job, s])) : null;
  const rank = new Map(STAGE_ORDER.map((name, i) => [statusOf(name), i]));
  const spelled = new Map(STAGE_ORDER.map((name) => [statusOf(name), name]));
  const queueShape = (t) => ({
    priority: t.priority ? { priority: t.priority } : null,
    date_created: String(Date.parse(t.createdAt)),
  });
  const names = new Map();
  const nameOf = (id) => {
    if (id == null) return null;
    if (!names.has(id)) names.set(id, store.getActor(id)?.name ?? `actor ${id}`);
    return names.get(id);
  };
  const rows = [];
  for (const project of projects) {
    const projectLanes = pipeline && project.slug === pipeline.slug ? lanes : null;
    for (const t of store.listTickets(project.slug)) {
      if (TERMINAL_STATUSES.includes(t.status) || !rank.has(t.status)) continue;
      const comments = store.listComments(t.id);
      rows.push({
        ticket: t,
        out: {
          id: t.id,
          project: project.slug,
          name: t.name,
          status: spelled.get(t.status),
          tags: t.tags,
          priority: t.priority,
          assignee: nameOf(t.assignee),
          updatedAt: t.updatedAt,
          stageSince: stageSinceOf(store, t),
          waitingOnOperator: waitsOn(t, comments, project.operator),
          answerIn: answerIsIn(t, comments, project.operator),
          pullRequest: findPullRequest(trailComments(store, t.id))?.url ?? null,
          nextChange: nextChangeOf(t.status, projectLanes),
        },
      });
    }
  }
  rows.sort((a, b) => (rank.get(a.ticket.status) - rank.get(b.ticket.status))
    || compareWithinStatus(queueShape(a.ticket), queueShape(b.ticket)));
  return {
    projects: projects.map((p) => ({ slug: p.slug, name: p.name, prefix: p.prefix, logo: p.logo ?? null })),
    tickets: rows.map((r) => r.out),
  };
}

/**
 * The Settings page's stage colours: the eight statuses in the contract's
 * STAGE_ORDER, each with its `#rrggbb` colour, or null when it has none.
 * The page lists exactly these, so it never types the stages out itself.
 */
export function stageColoursOf(store) {
  const colours = store.stageColours();
  return { stages: STAGE_ORDER.map((name) => ({ status: name, colour: colours[statusOf(name)] ?? null })) };
}

/** The Reporting page's time ranges, newest first; `days: null` is all time. */
export const REPORT_RANGES = Object.freeze([
  Object.freeze({ key: 'week', label: 'Last 7 Days', days: 7 }),
  Object.freeze({ key: 'month', label: 'Last 30 Days', days: 30 }),
  Object.freeze({ key: 'all', label: 'All Time', days: null }),
]);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When a ticket last entered Live, from its history: the newest event that
 * moved its status to Live (or filed it there). Null when it is not Live
 * now, so a ticket moved to Live and back out counts nowhere, and one moved
 * there twice counts once, at its latest move. A ticket that arrived already
 * Live (an import from ClickUp) has only its filing event, at its original
 * time, to go by.
 */
function finishedAt(store, ticket) {
  if (ticket.status !== LIVE) return null;
  let at = null;
  for (const e of store.listEvents(ticket.id)) {
    if ((e.field === 'status' || e.field === 'created') && e.to === LIVE) at = e.at;
  }
  return at;
}

/**
 * A ticket's status history as [time in ms, status] steps, oldest first: its
 * filing, then every status change. Steps whose time cannot be read are
 * left out.
 */
function statusSteps(store, ticket) {
  const steps = [];
  for (const e of store.listEvents(ticket.id)) {
    if (e.field !== 'status' && e.field !== 'created') continue;
    const at = Date.parse(e.at);
    if (!Number.isNaN(at)) steps.push([at, e.to]);
  }
  return steps;
}

/**
 * How a finished ticket's work flowed, from its status steps up to `doneAt`
 * (ms, when it last entered Live):
 *  - toFinish: ms from first entering Queued to doneAt, or null when it
 *    never entered Queued (an import, or a ticket filed straight past it);
 *  - sentBack: whether it ever entered Rework;
 *  - waited: ms spent in the operator's two stages (Needs your input,
 *    Ready to launch) before doneAt.
 */
function flowOf(steps, doneAt) {
  const queued = steps.find(([, status]) => status === QUEUED);
  let waited = 0;
  steps.forEach(([at, status], i) => {
    if (at >= doneAt || !OPERATOR_HELD_STATUSES.includes(status)) return;
    const until = i + 1 < steps.length ? Math.min(steps[i + 1][0], doneAt) : doneAt;
    waited += Math.max(0, until - at);
  });
  return {
    toFinish: queued && queued[0] <= doneAt ? doneAt - queued[0] : null,
    sentBack: steps.some(([at, status]) => status === REWORK && at <= doneAt),
    waited,
  };
}

/** The middle of a list of numbers (the mean of the middle two when even); null when empty. */
function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * One range's flow figures from the flows of the tickets finished in it.
 * Durations are in ms; a figure with nothing to count is null, never 0.
 */
function flowFigures(flows) {
  const timed = flows.map((f) => f.toFinish).filter((ms) => ms != null);
  const waits = flows.map((f) => f.waited);
  const sentBack = flows.filter((f) => f.sentBack).length;
  return {
    finished: flows.length,
    timeToFinish: {
      counted: timed.length,
      leftOut: flows.length - timed.length,
      median: median(timed),
      longest: timed.length ? Math.max(...timed) : null,
    },
    sentBack: { count: sentBack, share: flows.length ? sentBack / flows.length : null },
    waiting: { total: flows.length ? waits.reduce((a, b) => a + b, 0) : null, median: median(waits) },
  };
}

/**
 * One range's human-hours figures from the estimates (null where a finished
 * ticket has none) of the tickets finished in it, over `days` days. With no
 * estimate in the range the hours and the per-day figure are null, never 0:
 * "no estimates yet" is not "no work". Per day is rounded to one decimal.
 */
function humanHoursFigures(estimates, days) {
  const known = estimates.filter((h) => h != null);
  const hours = known.length ? known.reduce((a, b) => a + b, 0) : null;
  return {
    finished: estimates.length,
    estimated: known.length,
    notEstimated: estimates.length - known.length,
    hours,
    days,
    perDay: hours == null ? null : Math.round((hours / days) * 10) / 10,
  };
}

/**
 * The Reporting page's figures for one project (`project`, a slug) or, with
 * none, every project:
 *  - finished: how many tickets entered Live in each REPORT_RANGES range,
 *    by their latest move there (finishedAt);
 *  - started: how many tickets were filed in each range;
 *  - open: a count for every stage that is not terminal (not Live), in the
 *    contract's STAGE_ORDER, with the colour chosen for it in Settings (or
 *    null);
 *  - flow: per range, for the tickets finished in it (flowOf, flowFigures):
 *    time from first Queued to Live (median and longest, leaving out and
 *    counting those never Queued), how many went to Rework at least once
 *    and their share, and total and median time in the operator's stages;
 *  - humanHours: per range (humanHoursFigures), the build loop's
 *    human-hours estimates (lib/humanHours.js, the newest `PR opened:`
 *    comment's) of the tickets finished in it added up, how many had one
 *    and how many did not, and the total per day of the range; all time
 *    runs from the first ticket filed in scope, at least one day;
 *  - waitingNow: how many tickets sit in the operator's stages now.
 * A range counts what happened in the last `days` days before `now`.
 * Null when `project` names no project. `only` narrows "every project" to
 * the ones the reader may see (visibleProjects), and a `project` outside it
 * is answered as no project, the same as one that does not exist.
 */
export function reportsOf(store, { project = null, now = Date.now(), only = null } = {}) {
  let projects = visibleProjects(store, only);
  if (project != null) {
    projects = projects.filter((p) => p.slug === project);
    if (!projects.length) return null;
  }
  const zero = () => Object.fromEntries(REPORT_RANGES.map((r) => [r.key, 0]));
  const finished = zero();
  const started = zero();
  const inRange = (r, when) => r.days == null || (when > now - r.days * DAY_MS && when <= now);
  const tally = (counts, at) => {
    const when = Date.parse(at);
    if (Number.isNaN(when)) return;
    for (const r of REPORT_RANGES) {
      if (inRange(r, when)) counts[r.key] += 1;
    }
  };
  const flows = Object.fromEntries(REPORT_RANGES.map((r) => [r.key, []]));
  const estimates = Object.fromEntries(REPORT_RANGES.map((r) => [r.key, []]));
  let firstFiled = null;
  let waitingNow = 0;
  const colours = store.stageColours();
  const openStages = STAGE_ORDER.filter((name) => !TERMINAL_STATUSES.includes(statusOf(name)));
  const open = new Map(openStages.map((name) => [statusOf(name), 0]));
  for (const p of projects) {
    for (const ticket of store.listTickets(p.slug)) {
      tally(started, ticket.createdAt);
      const filed = Date.parse(ticket.createdAt);
      if (!Number.isNaN(filed) && (firstFiled == null || filed < firstFiled)) firstFiled = filed;
      const done = finishedAt(store, ticket);
      if (done) {
        tally(finished, done);
        const doneAt = Date.parse(done);
        if (!Number.isNaN(doneAt)) {
          const flow = flowOf(statusSteps(store, ticket), doneAt);
          const hours = findHumanHours(trailComments(store, ticket.id));
          for (const r of REPORT_RANGES) {
            if (!inRange(r, doneAt)) continue;
            flows[r.key].push(flow);
            estimates[r.key].push(hours);
          }
        }
      }
      if (open.has(ticket.status)) open.set(ticket.status, open.get(ticket.status) + 1);
      if (OPERATOR_HELD_STATUSES.includes(ticket.status)) waitingNow += 1;
    }
  }
  return {
    project: project == null ? null : projects[0].slug,
    projectName: project == null ? null : projects[0].name,
    ranges: REPORT_RANGES.map(({ key, label }) => ({ key, label })),
    finished,
    started,
    open: openStages.map((name) => ({ status: name, count: open.get(statusOf(name)), colour: colours[statusOf(name)] ?? null })),
    flow: Object.fromEntries(REPORT_RANGES.map((r) => [r.key, flowFigures(flows[r.key])])),
    humanHours: Object.fromEntries(REPORT_RANGES.map((r) => {
      const days = r.days ?? (firstFiled == null ? 1 : Math.max(1, Math.ceil((now - firstFiled) / DAY_MS)));
      return [r.key, humanHoursFigures(estimates[r.key], days)];
    })),
    waitingNow,
  };
}

/**
 * Where a search looks, most weight first, in the order Dane gave them: the
 * title, the description, the discussion (comments people wrote), and the
 * development (comments the loops wrote: build and review notes, pull
 * request links, operator cards). Each weight is more than all the lighter
 * ones together, so a title match always outranks any mix of the others.
 */
export const SEARCH_WEIGHTS = Object.freeze({ title: 8, description: 4, discussion: 2, development: 1 });

/** About how many characters an excerpt shows, and how many of them come before the match. */
const EXCERPT_LENGTH = 160;
const EXCERPT_LEAD = 60;

/** Some text on one line, about EXCERPT_LENGTH characters around the first match of `pattern`. */
function excerptOf(text, pattern) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const at = flat.search(pattern);
  if (at < 0) return null;
  const start = Math.max(0, Math.min(at - EXCERPT_LEAD, flat.length - EXCERPT_LENGTH));
  const end = Math.min(flat.length, start + EXCERPT_LENGTH);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/** The priorities the store keeps, most urgent first: the ticket page's picker and the search's filter. */
export const PRIORITIES = Object.freeze(Object.keys(PRIORITY_RANK).sort((a, b) => PRIORITY_RANK[a] - PRIORITY_RANK[b]));

/** A status or priority as the page writes it: "urgent" -> "Urgent". */
const capital = (s) => String(s).replace(/^./, (c) => c.toUpperCase());

/**
 * The search's five filters, in the order the page shows them, each with
 * the query parameter that carries it, its label, and its choices as
 * `{ value, label }` (the value is what the address holds): the projects
 * the reader may see (visibleProjects, `only`) by name, the eight
 * statuses in the contract's STAGE_ORDER, the store's priorities plus
 * "none", and every actor, people and loops, by name ("Assigned to" also
 * takes "nobody"). "Created by" is the actor on a ticket's `created` event.
 */
export function searchFilterChoices(store, { only = null } = {}) {
  const actors = store.listActors().map((a) => ({ value: String(a.id), label: a.name }));
  return [
    { key: 'project', label: 'Project', options: visibleProjects(store, only).map((p) => ({ value: p.slug, label: p.name })) },
    { key: 'status', label: 'Status', options: STAGE_ORDER.map((name) => ({ value: name, label: name })) },
    { key: 'priority', label: 'Priority', options: [...PRIORITIES.map((p) => ({ value: p, label: capital(p) })), { value: 'none', label: 'None' }] },
    { key: 'createdBy', label: 'Created by', options: actors },
    { key: 'assignee', label: 'Assigned to', options: [{ value: 'nobody', label: 'Nobody' }, ...actors] },
  ];
}

/** What a filter's value is called in a refusal. */
const FILTER_NOUNS = Object.freeze({ project: 'project', status: 'status', priority: 'priority', createdBy: 'actor', assignee: 'actor' });

/**
 * Read the search's filters from `get(key)` (the address's query
 * parameters): each one absent or empty is "Any". A status or priority is
 * matched ignoring case. Answers `{ filters }`, each filter with the value
 * chosen (as its choice writes it) or null, or `{ problem }`, a plain
 * sentence naming the value that is not one of the choices. A project the
 * reader may not see (`only`) is not one of them: it is refused word for
 * word as one that does not exist, never answered.
 */
export function readSearchFilters(store, get, { only = null } = {}) {
  const filters = searchFilterChoices(store, { only }).map((f) => ({ ...f, value: null }));
  for (const f of filters) {
    const raw = String(get(f.key) ?? '').trim();
    if (!raw) continue;
    const hit = f.options.find((o) => (f.key === 'status' || f.key === 'priority' ? o.value.toLowerCase() === raw.toLowerCase() : o.value === raw));
    if (!hit) {
      const known = f.key === 'status' || f.key === 'priority' ? ` ${f.label} is one of: ${f.options.map((o) => o.label).join(', ')}.` : '';
      return { problem: `There is no ${FILTER_NOUNS[f.key]} "${raw}" to filter ${f.label} by.${known}` };
    }
    f.value = hit.value;
  }
  return { filters };
}

/** Does `ticket` pass every chosen filter? Created by is read from its events only when that filter is on. */
function passesFilters(store, ticket, chosen) {
  if (chosen.status != null && ticket.status !== statusOf(chosen.status)) return false;
  if (chosen.priority != null && (ticket.priority ?? 'none') !== chosen.priority) return false;
  if (chosen.assignee != null && String(ticket.assignee ?? 'nobody') !== chosen.assignee) return false;
  if (chosen.createdBy != null) {
    const created = store.listEvents(ticket.id).find((e) => e.field === 'created');
    if (String(created?.actor) !== chosen.createdBy) return false;
  }
  return true;
}

/**
 * The tickets the Search page's "Ticket number" field offers (SP-192):
 * every ticket of `project` (a slug, or null for every project), `Live`
 * ones too, each as `{ id, name }`, project by project in the order the
 * store lists them, then by number. Only the projects the reader may see
 * (visibleProjects, `only`) are read, so a project they may not see offers
 * nothing even when named. Reads only.
 */
export function lookupTickets(store, project = null, { only = null } = {}) {
  const tickets = [];
  for (const p of visibleProjects(store, only)) {
    if (project != null && p.slug !== project) continue;
    for (const t of store.listTickets(p.slug)) tickets.push({ id: t.id, name: t.name });
  }
  return tickets;
}

/**
 * Every ticket in every project (or the one the Project filter names), closed ones too, that matches `query` as
 * one phrase, ignoring case (render.mjs searchPattern, the same pattern the
 * page bolds with). A ticket scores the SEARCH_WEIGHTS of each place it
 * matched in; results go highest score first, then most recently changed.
 * Each carries its id, title, project, status (as the contract shows it),
 * score, and one excerpt from the heaviest place it matched outside the
 * title, with that place named (both null for a title-only match). Whether
 * a comment is a loop's is the relay's own check, as on the ticket page
 * (threadOf). `filters` (readSearchFilters) narrow the tickets before any
 * are scored; the answer carries them back, with their choices, for the
 * page to draw. `only` narrows the projects searched to the ones the
 * reader may see (visibleProjects). Reads only. An empty query finds nothing.
 */
export function searchTickets(store, query, filters = null, { only = null } = {}) {
  filters ??= searchFilterChoices(store, { only }).map((f) => ({ ...f, value: null }));
  const term = String(query ?? '').trim();
  const pattern = searchPattern(term);
  if (!pattern) return { query: term, filters, results: [] };
  const chosen = Object.fromEntries(filters.map((f) => [f.key, f.value]));
  const kinds = new Map();
  const isMachine = (c) => {
    if (!kinds.has(c.author)) kinds.set(c.author, store.getActor(c.author)?.kind);
    return kinds.get(c.author) === 'machine' || isMachineComment(c.body);
  };
  const results = [];
  for (const project of visibleProjects(store, only)) {
    if (chosen.project != null && project.slug !== chosen.project) continue;
    for (const ticket of store.listTickets(project.slug)) {
      if (!passesFilters(store, ticket, chosen)) continue;
      const discussion = [];
      const development = [];
      for (const c of store.listComments(ticket.id)) {
        if (isMachine(c)) development.push(isMachineComment(c.body) ? stripMachineMarker(c.body) : c.body);
        else discussion.push(c.body);
      }
      const places = [
        ['title', [ticket.name]],
        ['description', [ticket.description ?? '']],
        ['discussion', discussion],
        ['development', development],
      ];
      let score = 0;
      let place = null;
      let excerpt = null;
      for (const [name, texts] of places) {
        const hit = texts.find((text) => pattern.test(text));
        if (hit == null) continue;
        score += SEARCH_WEIGHTS[name];
        if (name !== 'title' && place == null) {
          place = name;
          excerpt = excerptOf(hit, pattern);
        }
      }
      if (!score) continue;
      results.push({
        id: ticket.id,
        name: ticket.name,
        project: project.slug,
        projectName: project.name,
        status: DISPLAY[ticket.status] ?? ticket.status,
        score,
        place,
        excerpt,
        updatedAt: ticket.updatedAt,
      });
    }
  }
  results.sort((a, b) => b.score - a.score || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return { query: term, filters, results };
}
