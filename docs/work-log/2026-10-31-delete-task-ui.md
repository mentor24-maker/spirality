## 2026-10-31 — Dane cannot delete an unstarted task from the page: add a delete icon in the Tasks list and a Delete button on the ticket page (#49)

Last week the tracker learned to delete a ticket nobody has started yet, but
there was no button for it: Dane could only ask a session to do it. Now there
are two. In the Tasks list, every Requested or Queued row has a small bin
icon beside the other actions; on a Requested or Queued ticket's own page
there is a red Delete button under the reply box. Started tickets show
neither.

Both ask first, naming the ticket ("Delete SP-12 "…"? This cannot be
undone."), and Cancel does nothing. If the ticket was picked up by a loop in
the moment between drawing the page and clicking, the tracker refuses and the
page says so in one red sentence, leaving the ticket where it was; nothing
can delete work already under way, because the tracker itself enforces that
rule, not the button.
