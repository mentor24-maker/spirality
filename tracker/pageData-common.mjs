/**
 * What the page's data files share (SP-364): the projects a reader may
 * see and a ticket's comments in the trail's shape.
 */

/**
 * The projects a reader may see: every one when `only` is null (a loop, an
 * admin), else only those whose slug `only` (a Set) holds. Every page that
 * reads across projects narrows through this, so a person who is not an
 * admin never sees a project they are not on (store.projectsVisibleTo).
 */
export function visibleProjects(store, only) {
  const all = store.listProjects();
  return only == null ? all : all.filter((p) => only.has(p.slug));
}

/** A ticket's comments in the shape the loop trail's readers take (findPullRequest, findHumanHours). */
export function trailComments(store, ticketId) {
  return store.listComments(ticketId).map((c) => ({
    id: c.id, comment_text: c.body, date: String(Date.parse(c.createdAt)),
  }));
}
