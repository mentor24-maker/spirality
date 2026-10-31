/**
 * The data behind Dane's page (docs/TRACKER_MVP.md, "Dane's page"): what
 * waits on him, one ticket's thread with each comment's author named, the
 * projects, one project's details, and one project's board.
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
import { compareWithinStatus } from '../scripts/lib/loopStatuses.mjs';

const { OPERATOR_LANE, WAITING, CANNOT_TELL, waitingVerdict } = waitingOnOperator;
const { isMachineComment, stripMachineMarker } = machineComment;
const { STAGE_ORDER, statusOf } = loopStatuses;
const { findPullRequest } = mergeOnComment;

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
 * Every ticket in the operator's two statuses, across every project, with
 * the loop's verdict for `operatorId`. `waiting` holds the WAITING ones;
 * `unsure` holds the ones the verdict cannot decide (his status, but not
 * assigned to him), so a half-finished hand-off is shown, never dropped.
 * Both newest first, by the ticket's last change.
 */
export function waitingFor(store, operatorId) {
  const waiting = [];
  const unsure = [];
  for (const project of store.listProjects()) {
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
 * Null when there is no such ticket.
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
    comments,
    pullRequest: findPullRequest(store.listComments(ticket.id).map((c) => ({
      id: c.id, comment_text: c.body, date: String(Date.parse(c.createdAt)),
    })))?.url ?? null,
  };
}

/** An actor by id and name, or null for none; one that is gone is named by its id. */
function namedActor(store, id) {
  if (id == null) return null;
  return { id, name: store.getActor(id)?.name ?? `actor ${id}` };
}

/**
 * Every project, for the Projects screen: slug, name, ticket-id prefix, web
 * address, logo and owner by name (each null when it has none), and how many
 * of its tickets are open (any status but Live), in the store's order.
 */
export function projectsList(store) {
  return store.listProjects().map((p) => ({
    slug: p.slug,
    name: p.name,
    prefix: p.prefix,
    url: p.url,
    logo: p.logo,
    owner: namedActor(store, p.owner),
    open: store.listTickets(p.slug, { open: true }).length,
  }));
}

/**
 * One project's details page: its slug, name, ticket-id prefix, its
 * operator by name (null when it has none), its web address, logo and owner
 * by name (each null when it has none), how many tickets are open, and
 * a count for each of the eight statuses in the contract's STAGE_ORDER, the
 * board's own column order. Null when there is no such project.
 */
export function projectDetailsOf(store, slug) {
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
    open: store.listTickets(project.slug, { open: true }).length,
    statuses: STAGE_ORDER.map((name) => ({ status: name, count: counts.get(statusOf(name)) })),
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
 * act on cannot differ. Null when there is no such project.
 */
export function boardOf(store, slug) {
  const project = store.getProject(slug);
  if (!project) return null;
  const byStatus = new Map(STAGE_ORDER.map((name) => [statusOf(name), []]));
  for (const ticket of store.listTickets(project.slug)) byStatus.get(ticket.status)?.push(ticket);
  const queueShape = (t) => ({
    priority: t.priority ? { priority: t.priority } : null,
    date_created: String(Date.parse(t.createdAt)),
  });
  const inQueueOrder = (a, b) => compareWithinStatus(queueShape(a), queueShape(b));
  const pullRequestOf = (id) => findPullRequest(store.listComments(id).map((c) => ({
    id: c.id, comment_text: c.body, date: String(Date.parse(c.createdAt)),
  })))?.url ?? null;
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
      })),
    })),
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
