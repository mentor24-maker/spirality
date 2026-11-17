## 2026-11-17 — Hold ticket edits on the tracker page to the ticket.edit permission (#311)

Until now anyone signed in could edit any ticket on a project they could see,
whatever their role. The tracker already had a list of who may change tickets
(admins, editors and contributors) but only used it when a ticket moved to
another project. Now editing a ticket uses the same check: a reviewer or a
viewer who tries to edit a ticket is told plainly that their role does not
allow it, and the ticket stays exactly as it was. Contributors, editors,
admins and the loops edit just as before.

Someone who is not on a project still cannot see its tickets at all, so for
them nothing changes: the tracker answers as if the ticket were not there.
The tracker's own description of roles now lists editing a ticket, next to
deleting one, as a permission the tracker enforces.
