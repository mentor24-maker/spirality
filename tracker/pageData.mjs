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
import pipelinePause from '../lib/pipelinePause.js';
import { compareWithinStatus } from '../scripts/lib/loopStatuses.mjs';
import { searchPattern } from './web/render.mjs';
import { GROUPS, MODELS, DEFAULT_MODEL, RELEASE_GROUP } from './pipelineControls.mjs';
import { OWN_RELEASE_LINE, rollBackTarget } from '../lib/releases.mjs';
import { STAGES } from './pipeline.mjs';

const { OPERATOR_LANE, WAITING, CANNOT_TELL, waitingVerdict, operatorSpokeLast, standingMergeWord } = waitingOnOperator;
const { isMachineComment, stripMachineMarker } = machineComment;
const { STAGE_ORDER, LIVE, QUEUED, BUILDING, REWORK, OPERATOR_HELD_STATUSES, TERMINAL_STATUSES, DISPLAY, PRIORITY_RANK, statusOf } = loopStatuses;
const { findPullRequest, isMergeCommand, isReviewVerdict, isReviewPassed } = mergeOnComment;
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
 * millisecond must resolve to the later one, not the earlier. `prStates`
 * (a Map, ticket id to `{ number, state }`, from the server's GitHub read,
 * SP-226) adds the ticket's pull request as the verdict's fourth fact; a
 * ticket it does not hold is judged exactly as before.
 */
function verdictInput(ticket, comments, prStates = null) {
  const pr = prStates?.get(ticket.id);
  return {
    ...(pr ? { pr } : {}),
    task: {
      status: { status: ticket.status },
      assignees: ticket.assignee == null ? [] : [{ id: ticket.assignee }],
    },
    comments: comments.slice().reverse().map((c) => ({
      id: c.id,
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
 * Does his merge word still stand (SP-285)? A Ready to launch ticket on
 * which he has said a merge phrase since the newest review PASS: the relay
 * keeps re-trying that merge on every pass, so the page shows no Merge
 * button and no "Your move" for it, even after a machine note (a conflict
 * hand-off) has become the newest comment. The same rule the verdict drops
 * the ticket from Waiting on You by (standingMergeWord, rule 3b of
 * waitingVerdict), so the page and that list cannot disagree.
 */
function mergeStands(ticket, comments, operatorId) {
  if (operatorId == null || ticket.status !== 'ready to launch') return false;
  return Boolean(standingMergeWord(verdictInput(ticket, comments).comments, { operatorId }));
}

/**
 * Does the ticket wait on `viewerId`? Exactly the test waitingFor lists a
 * ticket by: one of the operator's two statuses and a WAITING verdict for
 * that person. With no viewer, never.
 */
function waitsOn(ticket, comments, viewerId, prStates = null) {
  if (viewerId == null || !OPERATOR_LANE.includes(ticket.status)) return false;
  return waitingVerdict(verdictInput(ticket, comments, prStates), { operatorId: viewerId }).verdict === WAITING;
}

/**
 * The pull request the page asks GitHub about for one ticket (SP-226), or
 * null: only a ticket in the operator's two statuses, and only the PR its
 * trail records (findPullRequest, the one a merge would act on). `repo` is
 * the repository to ask, `owner/name`: the PR address's own, when it is the
 * project's repository or the project names none. A PR in another
 * repository than the project's gets `repo: null`, which is never asked and
 * reads as "could not check", the door's rule (scripts/clickup.mjs,
 * livePrState).
 */
export function prToCheck(store, ticket) {
  if (!ticket || !OPERATOR_LANE.includes(ticket.status)) return null;
  const found = findPullRequest(trailComments(store, ticket.id));
  if (!found) return null;
  const own = `${found.owner}/${found.repo}`;
  const projectRepo = store.getProject(ticket.project)?.repo ?? null;
  const same = !projectRepo || projectRepo.toLowerCase() === own.toLowerCase();
  return { ticket: ticket.id, number: found.number, repo: same ? own : null };
}

/** Every pull request prToCheck names, across every project `only` lets through. */
export function prsToCheck(store, { only = null } = {}) {
  const out = [];
  for (const project of visibleProjects(store, only)) {
    for (const status of OPERATOR_LANE) {
      for (const ticket of store.listTickets(project.slug, { status })) {
        const pr = prToCheck(store, ticket);
        if (pr) out.push(pr);
      }
    }
  }
  return out;
}

/**
 * Is this ticket held up by a lane that keeps failing (SP-228)? On 11/11
 * SP-207 showed "Your move: Merge" for 12.5 hours after Dane had said
 * "merge", because the relay could not reach GitHub.
 *
 * `lanes` maps a job (`relay`, `loop-build`, ...) to its stage in GET
 * /pipeline's answer (tracker/pipeline.mjs, SP-218), for the ticket's own
 * project; null when this tracker reads no logs for it, and then never.
 *
 * - One of his two statuses: held up only when the loop's own verdict
 *   (waitingVerdict) says it is NOT waiting on him and his comment is the
 *   newest word (operatorSpokeLast), so the relay owes the next move. A
 *   ticket that truly waits on him is never held up, whatever is failing:
 *   hiding a real wait would be worse than today.
 * - Requested, Queued, Rework, In review: held up when the lane that acts
 *   next (NEXT_LANE, the Console view's table) is failing. Building is not
 *   one: a pass is on it, and one that died is handed back by the next.
 *
 * Answers `{ stage, job, reason, since }` (the stage's name, its job, one
 * of pipeline.mjs's FAILING_REASONS, and when its first failed pass began,
 * as given), or null. `prStates` is the same live pull-request map the
 * verdict takes elsewhere (SP-226), so both read one answer.
 */
export function heldUpBy(ticket, comments, operatorId, lanes, prStates = null) {
  if (!lanes || !ticket) return null;
  let job;
  if (OPERATOR_LANE.includes(ticket.status)) {
    if (operatorId == null) return null;
    const input = verdictInput(ticket, comments, prStates);
    if (waitingVerdict(input, { operatorId }).verdict === WAITING) return null;
    if (!operatorSpokeLast(input.comments, { operatorId })
      && !(ticket.status === 'ready to launch' && standingMergeWord(input.comments, { operatorId }))) return null;
    job = 'relay';
  } else {
    job = NEXT_LANE.has(ticket.status) ? laneOf(NEXT_LANE.get(ticket.status)).job : null;
  }
  const stage = job ? lanes.get(job) : null;
  if (!stage || stage.failing !== true) return null;
  return { stage: stage.name, job, reason: stage.failingReason ?? 'keeps failing', since: stage.failingSince ?? null };
}

/** `pipeline` (`{ slug, stages }`) as heldUpBy's lanes for `slug`; null for another project or none. */
function lanesOf(pipeline, slug) {
  if (!pipeline?.stages || pipeline.slug !== slug) return null;
  return new Map(pipeline.stages.map((s) => [s.job, s]));
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
 * lets through (visibleProjects), with the loop's verdict for `operatorId`.
 * `prStates` is the server's read of each one's pull request (SP-226,
 * verdictInput), so a ticket whose PR is merged or closed drops off.
 * `waiting` holds the WAITING ones;
 * `unsure` holds the ones the verdict cannot decide (his status, but not
 * assigned to him), so a half-finished hand-off is shown, never dropped.
 * Both newest first, by the ticket's last change.
 *
 * `pipeline` (`{ slug, stages }`, GET /pipeline's answer and the project
 * whose logs it read) leaves out a ticket held up by a failing lane
 * (heldUpBy, SP-228), so the bell does not count it while the lane fails.
 */
export function waitingFor(store, operatorId, { only = null, pipeline = null, prStates = null } = {}) {
  const waiting = [];
  const unsure = [];
  for (const project of visibleProjects(store, only)) {
    const lanes = lanesOf(pipeline, project.slug);
    for (const status of OPERATOR_LANE) {
      for (const ticket of store.listTickets(project.slug, { status })) {
        const comments = store.listComments(ticket.id);
        if (heldUpBy(ticket, comments, project.operator, lanes, prStates)) continue;
        const result = waitingVerdict(verdictInput(ticket, comments, prStates), { operatorId });
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
 * `answerIn` says his answer is in (answerIsIn). `heldUp` says a failing
 * lane owes the next move (heldUpBy, SP-228), from `pipeline` (`{ slug,
 * stages }`), or null. `pullRequestState`, there only when `prStates` holds
 * the ticket (SP-226), is `{ number, state }`, state OPEN, MERGED, CLOSED or
 * null for could not check. Null when there is no such ticket.
 */
export function threadOf(store, ticketId, { pipeline = null, prStates = null } = {}) {
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
    mergeStands: mergeStands(ticket, store.listComments(ticket.id), project?.operator),
    heldUp: heldUpBy(ticket, store.listComments(ticket.id), project?.operator, lanesOf(pipeline, ticket.project), prStates),
    pullRequest: findPullRequest(trailComments(store, ticket.id))?.url ?? null,
    // SP-226: its live state on GitHub, for the Merge button. Absent when it was not asked.
    ...(prStates?.has(ticket.id) ? { pullRequestState: prStates.get(ticket.id) } : {}),
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
 * page cannot disagree (SP-201); `prStates` is the same GitHub read that page
 * gets (SP-226). With no `viewerId`, never. Null when there is no such project.
 */
export function boardOf(store, slug, { viewerId = null, prStates = null } = {}) {
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
        mergeStands: mergeStands(t, store.listComments(t.id), project.operator),
        waiting: waitsOn(t, store.listComments(t.id), viewerId, prStates),
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
 * time (nextChangeOf); null, or another project, gets none. `prStates` is
 * the server's GitHub read (SP-226), as waitingFor takes it.
 */
export function consoleOf(store, { only = null, pipeline = null, prStates = null } = {}) {
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
          waitingOnOperator: waitsOn(t, comments, project.operator, prStates),
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

/**
 * The Settings page's Pipeline Controls for one project (SP-224): every
 * control with its value and whether that is its default, the groups they
 * fall in (each naming the ticket that makes the lanes use it), the models
 * a lane may choose, the change log newest first with each changer's name,
 * and `canChange`: whether this reader may change them (the project's
 * operator, signed in as a person), `release`, its release group
 * (releaseGroupOf; `ownProject` and `newest` come from the server), and
 * `inFlight`: the tickets a lane is working on now,
 * `[{ id, name, status, kind }]` (in Building, or in review under a review
 * pass's claim note: lib/pipelinePause.js classifyTicket), which a pause
 * waits on to drain (SP-237), and `capInFlight`, `{ count, ids }`: the
 * tickets in Building or In review, which the cap row shows beside the cap
 * (SP-238; loop-build's `wip-check` counts the same tickets, by their open
 * pull requests). Null for a project that does not exist.
 *
 * `lanes` is this machine's Pipeline Status stages for the project
 * (pipelineOf), or null when it reads no logs of it. With them, each wake
 * time carries `used`, the seconds its job last actually woke on (null when
 * its log does not say yet), and `inEffect`, whether that is the set value;
 * without them both are null, never a guess (SP-236). Each model carries
 * `lastModel`, the model its lane's last pass ran on (the lane's START line:
 * an id or `default`), null when the log does not say (SP-239).
 */
export function pipelineControlsOf(store, slug, { reader = null, lanes = null, ownProject = null, newest = null } = {}) {
  const project = store.getProject(slug);
  if (!project) return null;
  const nameOf = (id) => store.getActor(id)?.name ?? `actor ${id}`;
  const who = reader == null ? null : store.getActor(reader);
  const canChange = who != null && who.kind === 'human' && who.id === project.operator;
  return {
    project: { slug: project.slug, name: project.name },
    operator: project.operator == null ? null : { id: project.operator, name: nameOf(project.operator) },
    canChange,
    release: releaseGroupOf(store, project, { canChange, ownProject, newest, nameOf }),
    groups: GROUPS.map((g) => ({ ...g })),
    models: [{ id: DEFAULT_MODEL, label: "Claude's default" }, ...MODELS.map((m) => ({ ...m }))],
    controls: store.pipelineSettings(project.slug).map((c) => {
      if (c.group === 'model') return { ...c, lastModel: lanes?.find((l) => `model.${l.job}` === c.key)?.model ?? null };
      if (c.group !== 'wake') return { ...c };
      const used = lanes?.find((l) => `wake.${l.job}` === c.key)?.used ?? null;
      return { ...c, used, inEffect: used == null ? null : String(used) === c.value };
    }),
    changes: store.pipelineSettingChanges(project.slug).map((c) => ({ ...c, actorName: nameOf(c.actor) })),
    inFlight: store.listTickets(project.slug)
      .map((t) => pipelinePause.classifyTicket(t))
      .filter(Boolean)
      .map(({ id, name, status, kind }) => ({ id, name, status, kind })),
    capInFlight: capInFlightOf(store.listTickets(project.slug)),
  };
}

/** The tickets the work-in-progress cap counts (SP-238): in Building or In review, `{ count, ids }`. */
function capInFlightOf(tickets) {
  const counted = [loopStatuses.BUILDING, loopStatuses.IN_REVIEW];
  const ids = tickets
    .filter((t) => counted.includes(String(t.status?.status ?? t.status ?? '').trim().toLowerCase()))
    .map((t) => String(t.id));
  return { count: ids.length, ids };
}

/**
 * The Settings page's release group (SP-275) for one project:
 * the release it runs (`current`, with when and who named it), the one
 * named before it (`previous`), the release Roll Back would name
 * (`rollBackTo`, lib/releases.mjs rollBackTarget) and the newest release
 * cut (`newest`, from `newest`: the server's newestRelease answer, or null
 * when it reads none, with `newestProblem` saying why). `own` is true for
 * the tracker's home project, which always runs main and has no buttons;
 * `known` is false when the tracker cannot tell which project that is, and
 * then nothing can be named. `canChange` is the operator, signed in as a
 * person, on a project a release can be named for.
 */
function releaseGroupOf(store, project, { canChange, ownProject, newest, nameOf }) {
  const known = typeof ownProject === 'string' && ownProject !== '';
  const own = known && project.slug === ownProject;
  const history = own ? [] : store.projectReleases(project.slug);
  const entry = (h) => (h ? { release: h.release, at: h.at, actor: h.actor, actorName: nameOf(h.actor) } : null);
  return {
    ...RELEASE_GROUP,
    known,
    own,
    ownLine: OWN_RELEASE_LINE,
    current: entry(history[0]),
    previous: entry(history[1]),
    rollBackTo: rollBackTarget(history),
    newest: newest?.newest?.name ?? null,
    newestProblem: newest == null ? 'this tracker does not read the release tags.' : newest.problem ?? null,
    canChange: canChange && known && !own,
  };
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

/**
 * The four buckets a ticket's time goes into (SP-220), in the order the
 * Reporting page lists them: a loop working on it (Building), waiting for
 * the next lane to wake, waiting on the operator, and broken (a lane's
 * failure note sits on it).
 */
export const TIME_BUCKETS = Object.freeze(['working', 'lane', 'operator', 'broken']);

/**
 * A lane's failure note: a line that starts `FAILED:`, `<lane> FAILED:` or
 * `<lane> GAVE UP:` (an optional `**` in front, for one written in bold).
 * Line-anchored on purpose: a note that mentions "FAILED:" mid-sentence is
 * talking about a failure, not reporting one.
 */
const FAILURE_NOTE = /^[ \t]*(?:\*\*)?(?:FAILED:|[a-z][\w-]* (?:FAILED|GAVE UP):)/m;

/** Does this text carry a lane's failure note? */
export function isFailureNote(text) {
  return FAILURE_NOTE.test(String(text ?? ''));
}

/**
 * Cut one ticket's life into stretches and put each in exactly one of the
 * TIME_BUCKETS, by these rules, in order:
 *  1. broken: from a machine comment carrying a failure note until the next
 *     status change or the next comment from the operator, whichever first;
 *  2. operator: in Needs your input or Ready to launch while the newest
 *     comment is not the operator's own (the contract's "Is this waiting on
 *     Dane?" rule, operatorSpokeLast), and, in Ready to launch, his merge
 *     word does not still stand (SP-285: said since the newest review PASS;
 *     the relay holds it while a conflict is worked, standingMergeWord);
 *  3. working: in Building;
 *  4. lane: every other stage but Live (Requested, Queued, Rework, In
 *     review, and the operator's two once his reply is the newest word).
 * Live time is not counted; an open ticket counts up to `now`.
 *
 * `steps` are the ticket's [ms, status] steps oldest first (statusSteps);
 * `comments` are `{ at, byMachine, byOperator }`, `at` in ms, and
 * `failure` when it is a machine's failure note, `verdict` ('pass' or
 * 'fail') when it is a review verdict, `mergeWord` when it is his merge
 * phrase. Answers the stretches as
 * `{ from, to, bucket }`, oldest first, touching end to end; none before the
 * ticket's first step.
 */
export function timeSplitOf(steps, comments, { now }) {
  if (!steps.length) return [];
  const events = [
    ...steps.map(([at, status]) => ({ at, status })),
    ...comments.filter((c) => Number.isFinite(c.at)).map((c) => ({ at: c.at, comment: c })),
  ].filter((e) => e.at <= now);
  // Same moment: the status change first, so a failure note written with a move counts from it.
  const rank = (e) => (e.status !== undefined ? 0 : 1);
  events.sort((a, b) => a.at - b.at || rank(a) - rank(b));
  const stretches = [];
  let status = null;
  let broken = false;
  let operatorLast = false;
  let passed = false;
  let mergeStanding = false;
  const bucketNow = () => {
    if (status == null || status === LIVE) return null;
    if (broken) return 'broken';
    const merging = status === 'ready to launch' && mergeStanding;
    if (OPERATOR_HELD_STATUSES.includes(status) && !operatorLast && !merging) return 'operator';
    if (status === BUILDING) return 'working';
    return 'lane';
  };
  let from = null;
  let bucket = null;
  const close = (at) => {
    if (bucket != null && at > from) {
      const last = stretches[stretches.length - 1];
      if (last && last.bucket === bucket && last.to === from) last.to = at;
      else stretches.push({ from, to: at, bucket });
    }
    from = at;
    bucket = bucketNow();
  };
  for (const e of events) {
    close(e.at);
    if (e.status !== undefined) {
      status = e.status;
      broken = false;
    } else {
      const c = e.comment;
      operatorLast = Boolean(c.byOperator);
      if (c.verdict) {
        passed = c.verdict === 'pass';
        mergeStanding = false;
      }
      if (c.byOperator && c.mergeWord && passed) mergeStanding = true;
      if (c.byOperator) broken = false;
      else if (c.byMachine && c.failure) broken = true;
    }
    bucket = bucketNow();
  }
  close(now);
  return stretches;
}

/** How many ms of `stretches` fall in each bucket between `start` (or the beginning, null) and `end`. */
function bucketTotals(stretches, start, end) {
  const totals = Object.fromEntries(TIME_BUCKETS.map((b) => [b, 0]));
  for (const s of stretches) {
    const from = start == null ? s.from : Math.max(s.from, start);
    const to = Math.min(s.to, end);
    if (to > from) totals[s.bucket] += to - from;
  }
  return totals;
}

/** How many tickets the Where the Time Goes section lists per range, most time first. */
export const TIME_SPLIT_TICKETS = 10;

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
 *  - waitingNow: how many tickets sit in the operator's stages now;
 *  - timeSplit: per range, where every ticket's time in it went (open ones
 *    too, timeSplitOf), as `total` ms and, per TIME_BUCKETS bucket, its `ms`
 *    and `share` of the total (null when the total is 0), and `tickets`: the
 *    TIME_SPLIT_TICKETS with the most time in the range, each with its id,
 *    exact name, project, `total` and its ms per bucket. A stretch that
 *    starts before the range counts only its part inside it.
 * A range counts what happened in the last `days` days before `now`.
 * Null when `project` names no project. `only` narrows "every project" to
 * the ones the reader may see (visibleProjects), and a `project` outside it
 * is answered as no project, the same as one that does not exist.
 *
 * `custom` (SP-240), `{ from, to }` in ms, is the Task Productivity table's
 * own date range: the answer then carries `custom: { from, to, started,
 * finished }` (times as ISO strings), counted the same way as the fixed
 * ranges, with both ends included. Without it the answer has no `custom`.
 */
export function reportsOf(store, { project = null, now = Date.now(), only = null, custom = null } = {}) {
  let projects = visibleProjects(store, only);
  if (project != null) {
    projects = projects.filter((p) => p.slug === project);
    if (!projects.length) return null;
  }
  const zero = () => Object.fromEntries(REPORT_RANGES.map((r) => [r.key, 0]));
  const finished = zero();
  const started = zero();
  const inRange = (r, when) => r.days == null || (when > now - r.days * DAY_MS && when <= now);
  const customCounts = { started: 0, finished: 0 };
  const tally = (counts, at, kind) => {
    const when = Date.parse(at);
    if (Number.isNaN(when)) return;
    for (const r of REPORT_RANGES) {
      if (inRange(r, when)) counts[r.key] += 1;
    }
    if (custom && when >= custom.from && when <= custom.to) customCounts[kind] += 1;
  };
  const flows = Object.fromEntries(REPORT_RANGES.map((r) => [r.key, []]));
  const estimates = Object.fromEntries(REPORT_RANGES.map((r) => [r.key, []]));
  let firstFiled = null;
  let waitingNow = 0;
  const colours = store.stageColours();
  const openStages = STAGE_ORDER.filter((name) => !TERMINAL_STATUSES.includes(statusOf(name)));
  const open = new Map(openStages.map((name) => [statusOf(name), 0]));
  const split = Object.fromEntries(REPORT_RANGES.map((r) => [r.key, []]));
  const machineActor = new Map();
  const isMachineActor = (id) => {
    if (!machineActor.has(id)) machineActor.set(id, store.getActor(id)?.kind === 'machine');
    return machineActor.get(id);
  };
  for (const p of projects) {
    for (const ticket of store.listTickets(p.slug)) {
      const comments = store.listComments(ticket.id).map((c) => {
        const byMachine = isMachineActor(c.author) || isMachineComment(c.body);
        const byOperator = p.operator != null && c.author === p.operator && !byMachine;
        return {
          at: Date.parse(c.createdAt),
          byMachine,
          byOperator,
          failure: byMachine && isFailureNote(c.body),
          verdict: isReviewVerdict(c.body) ? (isReviewPassed(c.body) ? 'pass' : 'fail') : null,
          mergeWord: byOperator && isMergeCommand(c.body),
        };
      });
      const stretches = timeSplitOf(statusSteps(store, ticket), comments, { now });
      for (const r of REPORT_RANGES) {
        const totals = bucketTotals(stretches, r.days == null ? null : now - r.days * DAY_MS, now);
        const total = TIME_BUCKETS.reduce((n, b) => n + totals[b], 0);
        if (total > 0) split[r.key].push({ id: ticket.id, name: ticket.name, project: p.slug, total, ...totals });
      }
      tally(started, ticket.createdAt, 'started');
      const filed = Date.parse(ticket.createdAt);
      if (!Number.isNaN(filed) && (firstFiled == null || filed < firstFiled)) firstFiled = filed;
      const done = finishedAt(store, ticket);
      if (done) {
        tally(finished, done, 'finished');
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
    ...(custom ? { custom: { from: new Date(custom.from).toISOString(), to: new Date(custom.to).toISOString(), ...customCounts } } : {}),
    timeSplit: Object.fromEntries(REPORT_RANGES.map((r) => {
      const rows = split[r.key];
      const total = rows.reduce((n, t) => n + t.total, 0);
      const buckets = Object.fromEntries(TIME_BUCKETS.map((b) => {
        const ms = rows.reduce((n, t) => n + t[b], 0);
        return [b, { ms, share: total > 0 ? ms / total : null }];
      }));
      const tickets = rows.slice()
        .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id, undefined, { numeric: true }))
        .slice(0, TIME_SPLIT_TICKETS);
      return [r.key, { total, buckets, tickets }];
    })),
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
