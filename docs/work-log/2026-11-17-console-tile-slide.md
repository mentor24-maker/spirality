## 2026-11-17 — A ticket's tile on the Console jumps to its new stage without showing the move: slide it from one area to the next when its status changes (#306)

The Console draws every ticket in flight as a tile on a map of the loop, and
redraws itself every minute. Until now a ticket whose status had changed just
appeared in its new area, so you could not see the work move. Now, just before
each redraw, the page notes where every tile is. Afterwards, a tile that moved
glides from its old spot to its new one in under half a second. A ticket new to
the board fades in, and one that left fades out where it was.

Nothing moves when you first open the page or reload it. Nothing moves at all
if your computer is set to reduce motion: tiles just appear in their new
places, as before. The page keeps your place through the redraw (your Features
pick and how far you have scrolled), because each tile's position is measured
from the map itself, not from the window.

The small part that decides which tiles moved, which are new and which are
gone is a plain function with its own tests. The rest was checked by driving
the page in a headless browser against the demo tracker.
