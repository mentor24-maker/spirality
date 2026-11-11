## 2026-11-10 — Add a JSON ticket read to the door for scheduled checks (#167)

StarCaster runs a handful of scheduled checks: how much got merged this
week, which tickets have sat waiting too long, whether Dane answered
something, and so on. Each one reads the queue straight from ClickUp. Once
StarCaster moves to the tracker, nothing writes to ClickUp any more, so
those checks would quietly report on an empty list.

The door now has one read made for them: `npm run clickup -- tickets
--json`. It prints every ticket as data a script can read: its name,
status, priority, tags, when it was filed and changed, and when it moved
into the status it is in now. It can add Live tickets, read another project
(the bus), and add each ticket's comments, marked as Dane's or a loop's.

The important part is what it does when something goes wrong: if any part
of the read fails, it prints nothing and says which part failed. A check
that counted half the queue as the whole of it would say "all quiet" when
it isn't. Moving StarCaster's checks onto this is StarCaster's own work.
