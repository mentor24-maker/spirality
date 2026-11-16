## 2026-11-16 — Give every ticket a kind, who started it and how it ended (#284)

Dane wants to start reporting on productivity, but every ticket counted the
same: a merge-conflict fix-up the loop filed for itself, a real new feature
and a ticket that was dropped each showed up as "one finished ticket". About
one ticket in six in Spirality was a conflict fix-up, so the counts made the
loop look busier than it was.

Every ticket in the tracker now carries three answers:

- **Kind**: Feature (something new the project does), Fix (something that
  should already work and didn't), Operational (work that exists only to keep
  things running, like a merge-conflict fix-up) or Documentation.
- **Started By**: Dane, a client, or an agent session.
- **How It Ended**, once a ticket is closed: Done, Won't Do, Duplicate or Test.
  The tracker won't let an open ticket say it ended, and reopening a ticket
  clears its ending.

They can be set on the ticket page, filtered on the Tasks page, and set or
read by the loops through the ticket door (`task`, the new `classify`, `get`
and `tickets --json`). The definitions are written once in the loop contract,
so every project uses the same ones. The loop doesn't fill them in by itself
yet, and existing tickets don't have them yet: both are follow-up tickets,
along with splitting the Reporting page by kind.
