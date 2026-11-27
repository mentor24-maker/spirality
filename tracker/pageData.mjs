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
import prFiles from '../lib/prFiles.js';
import waitsOnLine from '../lib/waitsOn.js';
import { compareWithinStatus } from '../scripts/lib/loopStatuses.mjs';
import { GROUPS, MODELS, DEFAULT_MODEL, RELEASE_GROUP } from './pipelineControls.mjs';
import { OWN_RELEASE_LINE, rollBackTarget } from '../lib/releases.mjs';
import { STAGES } from './pipeline.mjs';
import { CLASS_FIELDS } from '../lib/ticketClass.js';
import { trailComments, visibleProjects } from './pageData-common.mjs';

// The Reporting page's figures and the search live in files of their own
// (SP-364), so a ticket for one page does not edit another's file; every
// importer still names pageData.mjs.
export * from './pageData-reporting.mjs';
export * from './pageData-search.mjs';

/**
 * The Tasks page's class filters (SP-345, lib/ticketClass.js): each field's
 * key, label and choices, `{ value, label }`, in the contract's order.
 */
const CLASS_FILTERS = Object.freeze(Object.entries(CLASS_FIELDS).map(([key, spec]) => Object.freeze({
  key, label: spec.label, options: spec.values.map((v) => ({ value: v, label: spec.labels[v] })),
})));

const { OPERATOR_LANE, WAITING, CANNOT_TELL, waitingVerdict, answeredLast, standingMergeWord } = waitingOnOperator;
const { isMachineComment, stripMachineMarker } = machineComment;
const { STAGE_ORDER, LIVE, QUEUED, BUILDING, REWORK, OPERATOR_HELD_STATUSES, TERMINAL_STATUSES, DISPLAY, PRIORITY_RANK, statusOf } = loopStatuses;
const { findPullRequest, isMergeCommand, isReviewVerdict, isReviewPassed } = mergeOnComment;
const { findHumanHours } = humanHours;
const { isTeamChatTask } = busFallback;

/**
 * Each actor's kind ('human' or 'machine'), read once per store: an actor is
 * created with its kind and it never changes.
 */
const actorKinds = new WeakMap();
function kindOfActor(store, id) {
  if (!actorKinds.has(store)) actorKinds.set(store, new Map());
  const kinds = actorKinds.get(store);
  if (!kinds.has(id)) kinds.set(id, store.getActor(id)?.kind ?? null);
  return kinds.get(id);
}

/**
 * A ticket's comments, each with its author's kind as `authorKind` (SP-26).
 * "Machine or Dane" is read off the author, never off a stamp, so every
 * comment the waiting verdict reads comes through here.
 */
function commentsOf(store, ticketId) {
  return store.listComments(ticketId).map((c) => ({ ...c, authorKind: kindOfActor(store, c.author) }));
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
      // A reply's thread, so a spent answer (the relay's done reply under
      // it) is read here the way the relay reads it (SP-302).
      parent: c.parent ?? null,
      user: { id: c.author, kind: c.authorKind ?? null },
      comment_text: c.body,
      date: String(Date.parse(c.createdAt)),
    })),
  };
}

/**
 * Is his answer in? The ticket sits in one of his two statuses and his own
 * comment is the newest word on it, so the relay owes the next move (SP-93).
 * In Needs your input a teammate's reply counts too (SP-302). The same rule
 * the Waiting on you list drops a ticket by (answeredLast, rules 1 and 1b of
 * waitingVerdict), so the page and that list cannot disagree.
 * `operatorId` is the project's operator; with none, never.
 */
function answerIsIn(ticket, comments, operatorId) {
  if (operatorId == null || !OPERATOR_LANE.includes(ticket.status)) return false;
  return answeredLast(verdictInput(ticket, comments).comments, { operatorId, status: ticket.status });
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
  return verdictOf(ticket, comments, viewerId, prStates) === WAITING;
}

/**
 * The loop's own verdict (waitingVerdict) on whether the ticket waits on
 * `viewerId`: WAITING, NOT_WAITING or CANNOT_TELL; null for a ticket in
 * none of the operator's two statuses, or with no viewer.
 */
function verdictOf(ticket, comments, viewerId, prStates = null) {
  if (viewerId == null || !OPERATOR_LANE.includes(ticket.status)) return null;
  return waitingVerdict(verdictInput(ticket, comments, prStates), { operatorId: viewerId }).verdict;
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
 *   newest word (answeredLast: a teammate's, too, in Needs your input,
 *   SP-302), so the relay owes the next move. A
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
    if (!answeredLast(input.comments, { operatorId, status: ticket.status })
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
        const comments = commentsOf(store, ticket.id);
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
    // Machine or not is the author's kind (SP-26). A stamp line on a comment
    // imported from ClickUp is history, and is only taken off for display.
    return {
      id: c.id,
      parent: c.parent,
      author,
      machine: author.kind === 'machine',
      body: isMachineComment(c.body) ? stripMachineMarker(c.body) : c.body,
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
    answerIn: answerIsIn(ticket, commentsOf(store, ticket.id), project?.operator),
    mergeStands: mergeStands(ticket, commentsOf(store, ticket.id), project?.operator),
    heldUp: heldUpBy(ticket, commentsOf(store, ticket.id), project?.operator, lanesOf(pipeline, ticket.project), prStates),
    pullRequest: findPullRequest(trailComments(store, ticket.id))?.url ?? null,
    // SP-226: its live state on GitHub, for the Merge button. Absent when it was not asked.
    ...(prStates?.has(ticket.id) ? { pullRequestState: prStates.get(ticket.id) } : {}),
    sharedFiles: sharedFilesOf(store, ticket),
  };
}

/**
 * The other open pull requests on the ticket's project that change any of
 * the files its own open pull request changes (lib/prFiles.js), as
 * `[{ ticket, ticketName, number, url, files }]`, files being the shared
 * ones; empty when it has no record or shares nothing.
 */
export function sharedFilesOf(store, ticket) {
  const records = store.prFiles(ticket.project);
  const seen = new Map();
  for (const own of records.filter((r) => r.ticket === ticket.id)) {
    for (const s of prFiles.sharedWith(records, own.files, { ticket: ticket.id })) {
      const had = seen.get(s.number);
      if (had) { had.files = [...new Set([...had.files, ...s.files])].sort(); continue; }
      const other = records.find((r) => r.number === s.number);
      seen.set(s.number, {
        ticket: s.ticket,
        ticketName: store.getTicket(s.ticket)?.name ?? null,
        number: s.number,
        url: `https://github.com/${other.repo}/pull/${s.number}`,
        files: s.files,
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.number - b.number);
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
 * comparator (compareWithinStatus: priority, then place, then oldest), fed each ticket
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
    place: t.place ?? null,
  });
  const inQueueOrder = (a, b) => compareWithinStatus(queueShape(a), queueShape(b));
  const pullRequestOf = (id) => findPullRequest(trailComments(store, id))?.url ?? null;
  const names = new Map();
  const nameOf = (id) => {
    if (id == null) return null;
    if (!names.has(id)) names.set(id, store.getActor(id)?.name ?? `actor ${id}`);
    return names.get(id);
  };
  // SP-247: each ticket's topics, and the project's own to pick from.
  const topicsOf = store.ticketTopicsOf(project.slug);
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
        answerIn: answerIsIn(t, commentsOf(store, t.id), project.operator),
        mergeStands: mergeStands(t, commentsOf(store, t.id), project.operator),
        waiting: waitsOn(t, commentsOf(store, t.id), viewerId, prStates),
        // SP-208: the List view's priority dropdown saves with it (ifVersion).
        version: t.version,
        // SP-244: the List view's Assigned To dropdown selects by id; `assignee` stays a name.
        assigneeId: t.assignee ?? null,
        // SP-247: the ticket's topics, `{ id, name }`, alphabetical.
        topics: topicsOf.get(t.id) ?? [],
        // The ticket's class (lib/ticketClass.js), each a value or null: the Tasks page filters on them.
        kind: t.kind ?? null,
        startedBy: t.startedBy ?? null,
        outcome: t.outcome ?? null,
      })),
    })),
    // SP-244: the one person a ticket may be assigned to, for the List view's dropdown.
    operator: project.operator == null ? null : { id: project.operator, name: nameOf(project.operator) },
    // SP-247: the project's topics, `{ id, name }`, alphabetical, for the List view's Add Topic dropdown.
    topics: store.listTopics(project.slug)
      .map((t) => ({ id: t.id, name: t.name }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id - b.id),
    // SP-309: the project's tags, saved or in use, by name, for the List view's Add Tag dropdown.
    tags: store.listTags(project.slug).map((t) => t.name),
    // SP-345: the Tasks page's Kind, Started By and How It Ended filters, each with its choices.
    classes: CLASS_FILTERS,
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
/** The lane that moves a ticket in one of his statuses once it no longer waits on him: the relay merges, sends back or goes Live. */
const OPERATOR_NEXT_LANE = 'Relay';

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
 *  - the operator's two statuses: `{ kind: 'operator' }` only when the
 *    loop's own verdict (`verdict`, waitingVerdict, the rule Waiting on You
 *    lists by) is WAITING; on any other answer (his word is in, his merge
 *    word stands, the pull request merged or closed) the relay moves it
 *    next, so it gets the Relay's pass as below; CANNOT_TELL, or no verdict,
 *    gets null, never a ring and never a guessed time;
 *  - Requested, Queued, Rework, In review: `{ kind: 'lane', lane, job,
 *    running, due }`, the lane that acts on it, whether a pass of it runs
 *    now, and when its next pass is due (ISO, null while one runs);
 *  - null when that lane's time cannot be read (no logs for this project,
 *    a lane with no pass logged, or one idle with no next time), never a guess.
 */
function nextChangeOf(status, lanes, verdict = null) {
  if (OPERATOR_LANE.includes(status)) {
    if (verdict === WAITING) return { kind: 'operator' };
    if (verdict == null || verdict === CANNOT_TELL) return null;
  }
  if (status === BUILDING) return { kind: 'running', ...laneOf(BUILDING_LANE) };
  const next = OPERATOR_LANE.includes(status) ? OPERATOR_NEXT_LANE : NEXT_LANE.get(status);
  if (!next || !lanes) return null;
  const { lane, job } = laneOf(next);
  const stage = lanes.get(job);
  if (!stage || !stage.logged) return null;
  if (stage.running) return { kind: 'lane', lane, job, running: true, due: null };
  if (!stage.nextDue) return null;
  return { kind: 'lane', lane, job, running: false, due: stage.nextDue };
}

/** How long a launched ticket stays on the Console's map, fading (render.mjs LIVE_SHOWN_MS). */
export const CONSOLE_LIVE_MS = 24 * 3_600_000;

/**
 * The Console view's answer (SP-221): every ticket in flight on every project `only` lets through (visibleProjects), with the
 * facts a Console tile shows, so the page works nothing out itself. Since
 * SP-333 it carries the tickets that went Live in the last CONSOLE_LIVE_MS
 * too (`now`, milliseconds, given so a test can fix the clock), for the
 * map's Live area.
 *
 * `{ projects: [{ slug, name, prefix, logo }], tickets: [{ id, project,
 * name, status, tags, priority, assignee, updatedAt, stageSince,
 * waitingOnOperator, answerIn, pullRequest, nextChange, hold }] }`. Tickets go
 * in the contract's STAGE_ORDER, then `queue` order within a status (as
 * boardOf). `status` is the contract's own spelling; `assignee` is by name;
 * `waitingOnOperator` is the loop's own verdict (waitingVerdict) for the
 * ticket's project operator, the same rule his Waiting on You page lists by;
 * `answerIn` says his answer is in (answerIsIn); `pullRequest` is the merge
 * step's own answer (findPullRequest), or null; `hold` is what keeps a
 * Queued ticket from the build loop (holdOf), or null.
 *
 * `pipeline` is `{ slug, stages }`: GET /pipeline's answer (pipelineOf) and
 * the project whose logs it read. Only that project's tickets get a lane's
 * time (nextChangeOf); null, or another project, gets none. `prStates` is
 * the server's GitHub read (SP-226), as waitingFor takes it.
 */
/**
 * What holds a Queued ticket back from the build loop (SP-377): its Waits on:
 * line, read by lib/waitsOn.js holdReasons with each named ticket looked up
 * in this store, `closed` when it is in a TERMINAL_STATUSES status, `open` in
 * any other, `unreadable` when the store has no such ticket. The same three
 * answers `claim` and `queue --claimable` give, so the Console and the build
 * loop agree. `{ reasons }` when anything holds it, else null; null for every
 * ticket not in Queued.
 */
function holdOf(store, ticket) {
  if (ticket.status !== QUEUED) return null;
  const { reasons } = waitsOnLine.holdReasons(ticket, (id) => {
    const pre = store.getTicket(String(id).toUpperCase());
    if (!pre) return 'unreadable';
    return TERMINAL_STATUSES.includes(pre.status) ? 'closed' : 'open';
  });
  return reasons.length ? { reasons } : null;
}

export function consoleOf(store, { only = null, pipeline = null, prStates = null, now = Date.now() } = {}) {
  const projects = visibleProjects(store, only);
  const lanes = pipeline?.stages ? new Map(pipeline.stages.map((s) => [s.job, s])) : null;
  const rank = new Map(STAGE_ORDER.map((name, i) => [statusOf(name), i]));
  const spelled = new Map(STAGE_ORDER.map((name) => [statusOf(name), name]));
  const queueShape = (t) => ({
    priority: t.priority ? { priority: t.priority } : null,
    date_created: String(Date.parse(t.createdAt)),
    place: t.place ?? null,
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
      if (!rank.has(t.status)) continue;
      const done = TERMINAL_STATUSES.includes(t.status);
      // A ticket last edited before the window cannot have gone Live inside it: skip it before reading its events.
      if (done && (t.status !== LIVE || now - Date.parse(t.updatedAt) > CONSOLE_LIVE_MS)) continue;
      const stageSince = stageSinceOf(store, t);
      // The map's Live area shows the last day's launches only (SP-333).
      if (done && !(now - Date.parse(stageSince) <= CONSOLE_LIVE_MS)) continue;
      const comments = commentsOf(store, t.id);
      // One verdict for the ring and the next change, so a tile says "You" exactly when Waiting on You lists it.
      const verdict = verdictOf(t, comments, project.operator, prStates);
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
          stageSince,
          waitingOnOperator: verdict === WAITING,
          answerIn: answerIsIn(t, comments, project.operator),
          pullRequest: findPullRequest(trailComments(store, t.id))?.url ?? null,
          nextChange: nextChangeOf(t.status, projectLanes, verdict),
          hold: holdOf(store, t),
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
 * operator, signed in as a person), `own`, true for the tracker's home
 * project (`ownProject`), whose page leaves out the groups marked
 * `notOnOwnProject`, `release`, its release group
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
    own: ownProject != null && project.slug === ownProject,
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
