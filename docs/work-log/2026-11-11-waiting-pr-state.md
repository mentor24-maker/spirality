## 2026-11-11 — The bell and the Merge button show a merged ticket as waiting on Dane: check the pull request's live state (#189)

On November 11 SP-207's pull request had already merged, but the ticket still
sat in "Ready to launch", and the "is this waiting on Dane?" check said yes.
It went by the ticket's status column, and the status was behind GitHub.

Now the check asks GitHub too. A ticket waiting for Dane's merge word whose
pull request is already merged (or was closed) is no longer counted as his,
and the reason names the pull request: "PR #169 is merged; a machine owes the
move to Live, not Dane". If GitHub cannot be read, the check says so and does
not guess, so a real wait is never hidden. A question in "Needs your input"
is still his to answer whatever happened to the pull request.

The `waiting` command now uses the same rules as the tracker page, instead
of its own copy, so the two cannot give different answers. Each line shows
the pull request's state. The bell, the Waiting on You page and the Merge
button get the same check in the next slice (SP-226).
