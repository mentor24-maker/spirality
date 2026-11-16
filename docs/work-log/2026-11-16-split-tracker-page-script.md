## 2026-11-16 — Split the tracker's page script and its tests into one file per page (#286)

Almost every ticket that changes the tracker page edited the same two very
large files: the page's script (4,609 lines) and its tests (6,541 lines).
Two tickets built at the same time therefore clashed, even when one changed
the Reporting page and the other the Topics page. That is where most of
the day's merge-conflict fix-up tickets came from.

Now each page has its own file: Tasks, the ticket page, the Console, the Add
Task box, Reporting, Settings, Projects, Users, Docs and Topics. The tests
are split the same way. What every page shares (signing in, the header,
moving between pages, the message strip) stays in the one file the page
loads first. It is the same cure that ended the clashes on the work log and
the prompt log: one file per thing, so two pieces of work stop editing the
same file.

Nothing about the page changed. The code was moved statement by statement by
a tool that checked that nothing was lost. Every one of the 323 tests is
still there under its own name, and the page was opened page by page, beside
the version on `main`, to make sure it draws the same. Three other large
tracker files (the drawing code, the server and the Reporting figures) were
looked at. The drawing code clashes nearly as often, so it gets its own
ticket rather than making this change twice as large.
