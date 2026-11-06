## 2026-11-05 — A project's settings file still names its fields 'product': accept project names alongside the old ones so each project can move over (#107)

Every project Spirality runs has a small settings file, and three of its
fields were still called "product" (`productSlug`, `productScripts`, and
`productName` in the setup's answers), though Dane calls Normie, PressPlay
and the others projects. They are now `projectSlug`, `projectScripts` and
`projectName`, and the code built on them says "project" too.

The care was in not breaking anyone. Every loop reads this file at the start
of each pass, and four other projects still use the old names. So the one
reader that every loop uses now accepts both: it quietly reads an old name as
the new one, and only refuses a file that gives the same field two
*different* values under the two names, saying which, so it never guesses. A
test loads an exact copy of Normie's settings file as it is today to prove
it still works. Spirality's own file has moved over; each other project
moves in its own small pull request, a two-line change written down in the
onboarding guide. Removing the old names is a later ticket.
