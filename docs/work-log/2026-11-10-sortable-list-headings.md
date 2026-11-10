## 2026-11-10 — In Tasks > List make column headings sortable (#150)

On the Tasks page's List view, each stage's table can now be sorted by
clicking a column heading: Ticket, Priority, Tags, Assigned To or Last
Change. One click sorts it one way and shows ▲; a second click flips it and
shows ▼. Each stage sorts on its own, so sorting Queued doesn't move
anything in Live. Priority goes by importance (Urgent first), not
alphabetically, and Last Change goes by the real time, not the words on the
screen. The Live section under the Board view sorts the same way.

The headings on these tables are now bold and black so they stand out. Other
pages' tables, like Projects, keep their grey headings. The headings are real
buttons, so they work from the keyboard (Tab, then Enter or Space) and screen
readers announce which way a column is sorted. A reload goes back to the usual
order, because nothing is remembered.
