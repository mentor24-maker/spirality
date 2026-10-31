## 2026-10-31 — Dane cannot fix or remove a project from the tracker page: add Edit and Delete to the projects table, for people only (#47)

The Projects page could list projects and add new ones, but a typo in a
project's name or a test project left behind could only be fixed by hand
in the database. Now each row has a pencil (Edit) and a bin (Delete),
shown only to a person signed in, never to a loop.

Edit opens the same form used to add a project, already filled in. The
name, web address, logo and owner can change. The short name in the
address (the slug) and the ticket prefix (the "SP" in SP-12) are shown
but locked, because every ticket's id is built from them, and changing
them would break every link to every ticket.

Delete asks "Delete <name>?" first. It only works on a project with no
tickets. Press it on Spirality and the page refuses in plain words ("SP
has N tickets; a project with tickets cannot be deleted") and nothing
is removed. That rule is checked in the same step as the delete itself,
so a ticket filed at that exact moment can never be left without its
project. If a save or a delete is refused, the page says so in red,
never a success line.
