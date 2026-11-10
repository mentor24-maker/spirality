## 2026-11-09 — Projects cannot add their own step to a merge: add one (#146)

When Dane says "merge" on a ticket, the relay checks the pull request and then
merges it. Until now a project could not slip anything of its own in between.
WaveCenter needs to: when a pull request changes its database, that change has
to be applied to the live database right before the merge, and if applying it
fails, nothing should merge.

A project can now name one command in its settings file (`preMergeCommand`).
The relay runs it after every check passes and just before merging, and tells
it which pull request and which exact commit are about to go in. If the
command succeeds, the merge goes ahead, locked to that same commit so nothing
pushed in the meantime slips through, and the command's last lines of output
are written in the "Merged:" note. If it fails, takes too long, or cannot
start, nothing is merged. The ticket gets one note saying what happened and
quoting the output. Dane's "merge" still counts, so the merge goes through on
its own once the problem is fixed.

A project that sets nothing sees no change at all.
