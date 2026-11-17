## 2026-11-17 — Refuse ticket deletion by people whose role lacks ticket.delete (#310)

The tracker has had roles (admin, editor, contributor, reviewer, viewer) for a
while, but deleting a ticket ignored them: anyone signed in could delete any
ticket nobody had started. Now only people whose role includes "Delete
Tickets" (admins and editors) can. Anyone else is told plainly that their role
does not allow it, and the ticket stays exactly as it was. The loops still
delete as they did. This is the first role permission the tracker actually
enforces; the rest are still recorded only, and the tracker's design notes now
say so.
