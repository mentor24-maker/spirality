## 2026-11-02 — Open tracker pages go stale until you reload: redraw them about once a minute so changes show on their own (#71)

A tracker page used to be a snapshot: it showed what was true when it was
drawn and nothing more until Dane reloaded or clicked. So after he pressed
Merge, the ticket sat in "Ready to launch" on his screen even once the relay
had merged it, and he pressed Merge again.

Now Waiting on you, a project's board and list, and a ticket page check
themselves once a minute. Each remembers what it read to draw itself, reads
it again, and redraws only when something actually changed, leaving the
scroll position and any open sections where they were. Coming back to the
tab redraws it at once. A minute is skipped while he is typing (so a
half-written reply is never wiped), while a save is in flight, or while the
tab is hidden. The one read a hidden tab still makes is the waiting count in
the tab title, so a pinned tab still shows "(N) Tracker", as before.
