## 2026-11-12 — Show a merged or closed pull request on the tracker page instead of a Merge button (#198)

The tracker page decided whether something was waiting on Dane from the
ticket's status alone. The status can lag behind GitHub. On SP-207 the pull
request had already been merged, but the yellow bell, the Waiting on You list
and the green Merge button all kept saying the merge was his move.

Now the tracker asks GitHub what state each pull request is in, for tickets in
Dane's two statuses only, and remembers the answer for a minute so it doesn't
keep asking. If the pull request is merged or closed, the ticket leaves the
bell and Waiting on You, and its page says so in one plain line where the
Merge button was ("PR #14 is merged… that is the relay's job, not yours").
If GitHub can't be reached, nothing is hidden: the page works as before and
says it could not check.

The demo has a new ticket, "Merged on GitHub but not yet Live", to try it on.
