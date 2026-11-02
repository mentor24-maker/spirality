## 2026-11-01 — Remove New request from menu. Add Task in Tasks page. (#57)

Filing a new request used to mean leaving the Tasks page for a separate
New request page and picking a project there. Now the box to file one sits
at the top of the Tasks page itself, folded shut until Dane clicks **Add
Task**, and it files into whichever project the page is already showing.
The New request link is gone from the header.

The safety net came along: whatever he types is kept in his browser, so a
refusal, being signed out or reloading the page never loses it, and the box
opens on its own when there is kept text. Once a request is filed the page
redraws with the new ticket under Requested and a line naming it. The old
`/new` address still works for a bookmark: it opens the Tasks page with the
box already open.
