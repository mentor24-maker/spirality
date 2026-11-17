## 2026-11-16 — Animate the Build area on the Tasks > Console page while the Pipeline Build stage runs (#298)

The Console's map now shows when the build lane is actually at work. While
the Pipeline Status says Build is running, the Building area's background
slowly breathes between a lighter and a slightly darker shade of its colour.
Each ticket in it drifts left to right toward In review, at a pace worked out
from how long it has been in Building, so a ticket halfway through a
three-hour build sits halfway across and reaches the far side at about the
three-hour mark. The drift is deliberately very slow, a few pixels a minute.

The page already redraws itself every minute, so the tricky part was making
each ticket carry on from where it had got to, not snap back and start
again. Tickets also must never slide on top of each other. Both are checked
by tests. When the build stops, the area goes still. Anyone whose computer
asks for less motion sees the still map, as before.
