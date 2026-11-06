## 2026-11-06 — Every user sees every project: show a user only the projects they belong to, as StarCaster does (#119)

Until now the tracker wrote down who belongs to which project but let
everyone see everything anyway. Now it means it: someone who is not an admin
sees only the projects they are a member of, and only those projects'
tickets, on every page, in search, in reporting and in the box that files a
new task. If they open the address of a ticket on another project, they get
a plain "You Are Not on This Project" page instead of the ticket.

The tracker gives the same answer whether that ticket exists or not, so
nobody can learn what another project is working on by guessing ticket
numbers. Admins still see every project, so Dane can never lock himself out
of one, and the loops, which are not people, read and write their queues
exactly as before. This finishes the four-part user-management request:
the Users page, roles, project members, and now members only.
