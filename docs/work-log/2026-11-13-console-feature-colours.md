## 2026-11-13 — Colour Console tiles by feature (#216)

The Console page shows every ticket in flight as a tile. Now each tile takes
the colour of the feature it belongs to, so all the tickets of one feature
share a background and can be spotted at a glance, whichever stage or project
they sit in.

A ticket's feature is its first tag, the epic name the loops give it (the
`request-form` tag only says where a request came from, so it is skipped).
Each feature's colour is picked from ten light colours by a fixed rule on its
name, so it never changes from one visit to the next, and every colour is
checked to keep the ticket number easy to read. Tickets with no feature stay
white.

Above the stages, a small Features key lists each feature on screen with its
colour and how many tickets it has. Clicking one fades every other tile, so
that feature's tickets stand out; clicking it again brings them all back.
The choice stays put when the page redraws itself each minute.
