## 2026-10-31 — Need the ability to delete a task that hasn't been started yet (#42)

The tracker can now throw away a ticket that nobody has started yet: one
still in Requested or Queued. Until now nothing could ever be removed, so a
request filed by mistake, or one Dane changed his mind about, sat in the
queue for good. This is the first half; the second (SP-59) puts a bin icon in
the Tasks list and a Delete button on the ticket page.

The rule is strict on purpose. Once a loop has picked a ticket up, from
Building onwards, the tracker refuses to delete it and says what status it is
in, because by then there is a branch and a trail worth keeping. The check
and the delete happen in one locked step, so if a build loop grabs the ticket
at the very moment Dane deletes it, exactly one of them wins: either the
ticket is built, or it is gone and the loop finds nothing to build. A deleted
ticket goes with all its comments and history; there is no bin to restore it
from. Each deletion is written to the server's log with who did it.

Tickets that came across from ClickUp keep their place in the import's
record, so re-running the import will not bring a deleted one back.
