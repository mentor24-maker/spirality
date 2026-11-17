## 2026-11-17 — Mark Queued tiles on the Console that wait on another ticket (#309)

Some Queued tickets cannot be built yet because they wait on another ticket that is still open. Until now the Console map drew them exactly like the ticket the build loop will take next, so Dane could not tell from the map which was which.

Now a held ticket's tile carries a small amber "Waiting" mark in its top corner, and hovering it says why, for example "waits on sp-378 (still open)". The page works out the hold with the same rule the build loop uses when it refuses to claim, so the map and the loop always agree. The orange ring that means "waiting on you" is unchanged and separate.
