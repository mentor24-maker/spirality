/**
 * The data behind Dane's page (docs/TRACKER_MVP.md, "Dane's page"): what
 * waits on him, and one ticket's thread with each comment's author named.
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

const { OPERATOR_LANE, WAITING, CANNOT_TELL, waitingVerdict } = waitingOnOperator;
const { isMachineComment, stripMachineMarker } = machineComment;

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
  };
}
