## 2026-11-08 — Tickets imported from ClickUp are never built: their Waits on line names ClickUp ids the tracker cannot read (#125)

Tickets brought over from ClickUp say which ticket they wait for by its old
ClickUp id, like "Waits on: 86bctjbc3". The tracker only knew its own ids
(SP-21), so it answered "no such ticket", and the build loop set those
tickets aside as "could not be read" every time it looked. Five tickets
(SP-22 to SP-26) sat that way for ten days, until someone edited one by hand.

The importer already writes down, for every ticket it brings over, which old
ClickUp id became which new tracker id. The tracker now uses that list: asked
for an id it never gave out, it looks the id up there and answers with the
ticket it became. So the loop sees the real answer, "done, go ahead" or
"still open, wait", and the next WaveCenter and StarCaster imports will not
strand tickets the same way. An id that is in neither place is still "no such
ticket", exactly as before.
