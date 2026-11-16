## 2026-11-16 — The Console lines tickets up in stage columns, which hides how work flows: draw it as a map of coloured stage areas with each tile placed by its status (#282)

The Console used to put every ticket in a column per stage, which made the
loop look like a straight conveyor belt. It is now a map of the loop itself.
Each stage is an area of the screen tinted in its own colour, and the main
path runs round the edge, Requested to Queued to Building to In review to
Ready to launch to Live, with Live sitting under Requested where the loop
closes. The two detours, Needs your input (where every new ticket waits once
for Dane's "go") and Rework, sit inside the ring.

Where a tile sits now means something. In Queued, the next ticket to be built
sits nearest the way into Building. In Building and In review, a ticket drifts
toward the exit the longer it sits, so a stuck one ends up pressed against the
edge where it is easy to spot. A crowded area shrinks its tiles and, past what
fits, gathers the rest behind a "+N More" tile, so one busy stage can never
spill over another. Live shows the last day's launches, fading as they age.
The same tickets always land in the same places, so the minute's refresh does
not shuffle the board. On a phone-width screen the areas stack in loop order.

Walking the page in a headless browser before opening the pull request caught
one real fault: rounding laid one area ten pixels over its neighbour. That is
fixed, and a test now checks the areas never overlap.

Review sent it back once. The "+N More" list in Requested opened off the left
edge of the screen, so its hidden tickets could not be read or clicked. Each
list now opens toward the middle of the map: rightward from a tile on the left
half, upward from a tile low on the map. A browser walk at full width and at
the map's narrowest opened every "+N More" list and found each one whole and
clickable. The same pass made the Live window follow the tracker's own clock,
dropped the meaningless "next change" from finished Live tiles, and stopped
the Console reading the history of every ticket ever launched on each minute's
refresh.
