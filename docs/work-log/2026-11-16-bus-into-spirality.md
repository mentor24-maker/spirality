## 2026-11-16 — Move Spirality's bus into the Spirality project (#301)

Spirality's "bus" is the place the loops post their running notes: every
merge the relay makes, and every alarm a watchdog raises. Until now it was a
separate project on the tracker, "Spirality Bus", with one ticket in it,
"Team chat". Dane asked for each bus to live inside its own project, so the
project list holds one Spirality, not two.

This change points Spirality's settings at its own project as the bus, and
updates the three documents that still used Spirality as the example of the
old way. Moving the Team chat ticket itself has to wait until this is on
`main`, so those steps (a backup first, then the move, then a test post read
back) are their own ticket, SP-370, which the queue holds until this merges.
