## 2026-11-16 — Split the tracker's drawing code, server and page data into one file per page (#291)

The tracker page's drawing code was one big file, about 3,500 lines, that
almost every ticket about the page had to change, whichever page it was
for. While one such ticket's pull request is open, the loop holds back
every other ticket that changes the same file (SP-351), so that one file
was slowing the whole queue.

It is now one file per page (Tasks, the ticket page, Console, Add Task,
Settings, Projects, Docs, Topics), plus one for what every page shares and
one for the header, sign-in and message strip. The old file name still
works: it now only gathers the others, so nothing that used it had to
change. The Reporting page's figures and the search moved out of the
page-data file the same way.

The server file stayed in one piece. All its routes live inside one
function that shares its state with every route, so splitting it would
mean rewriting it, not moving it.

Nothing the page does changed: every line moved as it was, all the tests
pass, and the page drew identically beside `main` on 16 pages.
