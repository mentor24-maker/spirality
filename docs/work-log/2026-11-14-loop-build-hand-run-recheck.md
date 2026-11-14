## 2026-11-14 — loop-build keeps skipping a hand-run ticket on reasons that are no longer true: re-check its blockers and hand it to Dane when they clear (#247)

Some tickets may only be built by a session Dane starts by hand. The build
lane skips those, and it used to give the same reason every time, copied from
the ticket's last comment. When SP-25's two blockers cleared on the evening of
11/12, nothing on SP-25 itself changed, so the lane kept saying "still waiting"
for about 31 hours and Dane was never told it was ready.

The build lane's instructions now say: every pass, look up each thing the
ticket waits on afresh. If all of it has cleared, send Dane a card saying the
ticket is ready for a hand-run session. If some is still open, the skip note
names only what is still open and how it was checked; anything that could not
be checked is named as such, never treated as done; and the same note is not
posted again every pass. A new test fails if any of those instructions is
removed.
