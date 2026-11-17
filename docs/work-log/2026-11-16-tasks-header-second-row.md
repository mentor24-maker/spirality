## 2026-11-16 — Move Tasks page header items below the Tasks title and view selector (#296)

The top of the Tasks page used to be crowded: the "Tasks" title, the project
and topic pickers, the search box, the Pipeline Stages box and the Board /
List / Console tabs all shared one row, and the filters sat on a row of their
own under it. The Console showed only the title and tabs, so the tabs moved
around as you switched views.

Now the top row is just "Tasks" on the left and the Board / List / Console
tabs on the right, the same on every view, so switching views no longer moves
anything. Everything else (pickers, search, Pipeline Stages and the Kind /
Started By / How It Ended filters) sits together on the row underneath, and
wraps onto another line when the window is narrow.

The written look rules for the tracker (UI_DOCTRINE) say a page's buttons go
on its title row, so the rules now name the Tasks page as the one exception,
at Dane's word. The automatic check that enforces that rule was changed to
allow only this one exception, so any other page that moves its buttons
under its title still fails.

Review found a hole in that check: it only asked whether a toolbar came
shortly after a page title, not whether the title's row was still open, so a
page could close its title row and draw its buttons on a row underneath
without the check noticing. It now counts the row's opening and closing tags
up to the toolbar, and a new test plants exactly that mistake on the Search
page and expects the check to catch it.
