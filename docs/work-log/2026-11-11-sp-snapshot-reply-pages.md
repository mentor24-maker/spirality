## 2026-11-11 — StarCaster's snapshot misses a reply: page through every reply in the snapshot and import

The setup wizard's copy of StarCaster's ClickUp list stopped a second time,
safely, with StarCaster's loops still running: it found one reply fewer than
ClickUp counts. One comment on a StarCaster ticket has 26 replies, and ClickUp
hands replies over 25 at a time, the same as comments, so the copy only ever
saw the first 25. The copy and the import now ask for every page of replies,
so nothing is left behind. Nothing else changed.
