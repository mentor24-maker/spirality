## 2026-11-14 — Autosuggest next tasks (#232)

The first of three steps towards the tracker suggesting what to work on
next. Before the page can offer a list of suggested tasks to drag into
order, a ticket needs somewhere to keep its place in that order. Now it has
one: a ticket can be number 1, 2, 3 ... in its queue.

The rule for which ticket comes first is now: the most urgent first, then
by place, then the oldest. Urgency always wins, so a High ticket with no
place still comes before a Normal ticket placed first. Tickets sent back for
rework are still taken oldest first, because finishing work beats starting it.

Nothing changes today: no ticket has a place yet, so every list comes out
exactly as before. The build loop, the `queue` command and the Tasks page all
use the same rule, so they cannot disagree. A new tracker call sets the
places for a whole list at once; the third step, the suggestions list on the
page, is what will use it.

Review sent it back once: putting a few tickets in order left the tickets
already placed where they were, so two tickets could both be number 1. Now
the others move down to make room, keeping the order they had, so every place
is held by one ticket, as "the others adjust" asks.
