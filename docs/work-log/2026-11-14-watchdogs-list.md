## 2026-11-14 — StarCaster's watchdogs only watch StarCaster: sort them into pipeline and product, and move the pipeline ones into Spirality for every project (#235)

StarCaster has about twenty small scheduled checks ("watchdogs") that notice
when something has gone wrong and say so on the bus. They were built before
Spirality had a name, so they only ever watch StarCaster; the other projects,
Spirality included, have none, and a dead lane there goes unnoticed.

This first step moves no code. It writes down every one of them in
`docs/WATCHDOGS.md`, read straight from what StarCaster's schedule actually
runs, and sorts each into two piles: the ones that watch the loop itself
(these move into Spirality so every project gets them) and the ones that
watch StarCaster's website (these stay where they are). Each loop watchdog
names the ticket that will move it, or says plainly why none exists yet so
Dane can decide. The three closest calls are listed at the end for him.
