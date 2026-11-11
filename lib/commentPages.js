'use strict';

/**
 * Moved from StarCaster's scripts/lib/clickup.cjs (pageComments and
 * COMMENT_PAGE_SIZE), unchanged, for task 86bchpkxz: Spirality read only
 * ClickUp's first page of comments, so on a ticket with more than 25 the
 * oldest lines (a `PR opened:` record among them) were never seen.
 *
 * The PAGING RULE for a task's comments — the rule only, with no transport and
 * no failure policy of its own.
 *
 * The endpoint returns ~25 comments, newest first, and a chatty task scrolls
 * its own history off page one. `start`/`start_id`, seeded from the OLDEST
 * comment of each page, walks backwards through the rest.
 *
 * It lives here, injected rather than hard-wired, because a second copy of
 * this rule is not a second copy of some code — it is a second answer to
 * "have I read the whole trail", and the two disagree silently. The pipeline
 * pause switch learned that the expensive way on 2026-08-25: its state is one
 * comment on a task that also gets an hourly reminder comment, so after about
 * 25 hours the PAUSE record scrolled off page one, an unpaged read found no
 * state, and the pause reported itself as RUNNING — the one feature whose
 * whole premise is failing safe, failing open.
 *
 * `get(path)` answers `{ ok, json }` and MUST NOT throw; what a failed read
 * means is the caller's decision.
 *
 *   complete: true   the whole trail is in `comments`, newest-first.
 *   complete: false  it is NOT all there — `failed` carries the bad response,
 *                    or `capped` says it ran past `maxPages`.
 */
const COMMENT_PAGE_SIZE = 25;

// The limit for one-off archive reads (the ClickUp snapshot and import), which
// must take a ticket's whole trail: StarCaster's "Team chat" ticket, the old
// bus, holds more than the everyday 40 pages (SP-235). Still finite, so a
// cursor that never ends cannot loop forever: 2,000 pages, 50,000 comments.
const ARCHIVE_MAX_PAGES = 2000;

// `path` pages something other than a ticket's comments: a comment's replies
// (`/api/v2/comment/<id>/reply`) page the same way, 25 at a time, newest first
// (SP-242: StarCaster's comment 90140250837932 has 26).
async function pageComments({ get, taskId, path = `/api/v2/task/${taskId}/comment`, maxPages = 40 }) {
  const comments = [];
  let query = '';
  for (let page = 0; page < maxPages; page += 1) {
    const out = await get(`${path}${query}`);
    if (!out || out.ok !== true) return { complete: false, comments, failed: out || null, capped: false };
    const batch = Array.isArray(out.json && out.json.comments) ? out.json.comments : [];
    comments.push(...batch);
    // A short page is the end of the trail. There is no `last_page` on this
    // endpoint, so the page size IS the terminator.
    if (batch.length < COMMENT_PAGE_SIZE) return { complete: true, comments, failed: null, capped: false };
    const oldest = batch[batch.length - 1];
    // No cursor to seed the next page with: stop rather than re-request the
    // same page forever. Reported as INCOMPLETE, because it is.
    if (!oldest || !oldest.id || !oldest.date) return { complete: false, comments, failed: null, capped: true };
    query = `?start=${encodeURIComponent(oldest.date)}&start_id=${encodeURIComponent(oldest.id)}`;
  }
  return { complete: false, comments, failed: null, capped: true };
}

module.exports = { COMMENT_PAGE_SIZE, ARCHIVE_MAX_PAGES, pageComments };
