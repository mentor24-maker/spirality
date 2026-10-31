## 2026-10-30 — Add a Projects Management page (#38)

The tracker's Projects page used to show each project as a card. It is now
a table, one row per project, with the project's name, its short name (the
slug), the letters its tickets start with, how many tickets are still open,
and an Actions column. The Actions column has a View icon (an eye) that
opens a new page for that project: who its operator is, how many tickets
are open, and how many sit in each of the eight statuses, with links
straight to its board and list. An address for a project that does not
exist says so plainly instead of breaking.

Clicking a project's name still does what it did before: it picks that
project, so "Tasks" in the header opens it.

This is the first of three slices of Dane's "Projects Management page"
request. It only shows things. Adding a project (SP-50) and editing or
removing one (SP-51) come next.
