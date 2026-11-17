## 2026-11-16 — Animate icons in the In Review area of Tasks > Console (#300)

The Console page draws every ticket in flight as a tile on a map of the loop's
stages. Since SP-365, the tiles in Building creep right toward In review while
the build lane is actually working. Now the tiles in In review do the same
while the review lane is working: they creep down toward Ready to launch.

The pace is set so a ticket reaches the bottom of In review at the six-hour
mark, which is when the map already treats a review as stuck. So a ticket three
hours into review sits halfway down, and the motion is a slow drift of a few
pixels a minute, not a slide. When the review lane is asleep, or the page
cannot tell, the tiles stay still exactly where they were before. Building's
background still breathes while it works; In review's does not, because only
the moving icons were asked for. People who ask their computer for less motion
see no movement at all.

This reuses Building's own pace code rather than copying it, so a later fix to
one fixes both. The demo tracker now shows the review lane mid-pass, so both
areas can be seen moving there.
