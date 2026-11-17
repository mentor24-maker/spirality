## 2026-11-17 — Refuse to file or describe a ticket whose Waits on line cannot be read (#307)

A ticket can say which other tickets it waits for, on a `Waits on:` line, and
the build loop leaves it alone until those are finished. If that line held
something the loop could not read as a ticket (a few words of explanation
after the id, say), the loop played safe and held the ticket back forever,
and nobody found out until the ticket had sat unclaimed for a while.

Now the two commands that write a ticket's description, `task` and
`describe`, check the line first. If a piece of it is not a ticket, they
refuse, quote that piece, show the form that works, and write nothing. A
readable line, or no line at all, files exactly as before.
