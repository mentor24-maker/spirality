## 2026-11-06 — Dane cannot give anyone a role: add roles and permissions to the Users page, as WaveCenter has them (#116)

The tracker treated everyone who could sign in exactly the same: there was
no way to say "this person runs the place" or "this person only looks".
This is slice 2 of Dane's user-management request, and it gives every user
a role, the same five WaveCenter uses: admin, editor, contributor, reviewer
and viewer. Each role comes with a list of what it is meant to be allowed to
do (see users, change roles, read, add, change and delete tickets).

On the Users page each person now shows their role. Dane, as the admin, gets
a drop-down on each row to change it; the page checks the change really
saved before it says so. The tracker will not let its last admin be turned
into anything else, so nobody can lock everyone out by accident, and it says
why in plain words. A table under the list shows which role has which
permission.

Dane is made admin automatically, because he runs the projects; everyone
else starts as a contributor. The roles are only recorded for now: nobody is
stopped from doing anything because of their role. Making them count is a
later ticket, once Dane has seen them.
