## 2026-11-02 — Dane's merge word is ignored for hours when a PR conflicts a second time: the relay waits on a finished catch-up ticket (#72)

When a pull request clashes with newer work on `main`, the relay files a
"catch-up" ticket so the build loop can fix the clash, and notes that it did
so. The trouble was that it only ever checked whether that note existed. On
PR #64 the first catch-up (SP-90) was done and parked waiting for Dane, then
`main` moved again and #64 clashed again. Every relay pass for five hours
answered "SP-90 is already on file", even though no loop would ever work on
SP-90 again, so Dane's "merge" did nothing.

Now the relay looks at where the catch-up ticket actually is. If a loop is
still working it, nothing new is filed. If it has finished, a new catch-up
ticket is filed, and the note says the first one landed but `main` moved
again. If the ticket can't be read, the relay says so instead of guessing.
A test replays the SP-84/SP-90 sequence and checks that the second ticket is
filed exactly once.
