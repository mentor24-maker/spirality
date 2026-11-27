## 2026-11-26 — The Console shows "You" on tickets that are not waiting on Dane: ring a tile only when the loop's waiting verdict says so (#342)

The Console on the Tasks page rings a ticket orange and writes "You" on it
when it is Dane's move. It decided that from the ticket's status alone, so a
ticket he had already answered, one whose merge word was still standing, and
one whose pull request had already merged all said "You" while his Waiting
on You list was rightly empty.

Now the Console asks the same question the list asks: the loop's own
"is this waiting on him?" check. When the answer is yes, the tile is ringed
and says "You" as before. When it is no, the tile says when the relay, the
job that merges and moves tickets on, will next look at it ("in 3 min", or
"Now"). When the check cannot tell, the tile is not ringed and shows a dash
rather than a guess. A new test builds both views from the same tickets and
fails if they ever disagree about what is his.
