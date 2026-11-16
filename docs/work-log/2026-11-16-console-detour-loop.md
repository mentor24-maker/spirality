## 2026-11-16 — The Console's map does not show Needs your input and Rework as detours: draw them as a side loop with arrows back onto the main path (#288)

The Console's map showed every stage as a coloured area, but nothing showed
how tickets move between them. In particular, nothing showed that Needs your
input and Rework are side trips off the main path. Now dashed arrows show
every way a ticket gets into those two areas and every way it gets back out:
amber for Needs your input, red for Rework. A line under the map says why
they matter: each ticket there costs a round trip, so a healthy board keeps
them small.

The arrows come from what the loops actually do, not from a sketch. We
checked each one against the code that moves tickets: intake asking for a go,
a question in the middle of a build or a review, the relay acting on Dane's
answer, review sending work back, and the build loop taking Rework first.
They sit under the tiles, so they never hide a ticket, and they are left off
on a phone, where the areas stack in a column.
