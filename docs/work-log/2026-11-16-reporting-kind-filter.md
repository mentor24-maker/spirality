## 2026-11-16 — Add Type filter to Reporting page (#302)

Dane asked for a Type filter on the Reporting page, next to the Project
filter. When the build loop checked, the filter was already there: the
tracker calls a ticket's type its Kind, and an earlier ticket (SP-347) had
already put a Kind dropdown beside the Project one, with every figure on the
page narrowed to the kind picked. The loop said so on the ticket before
building anything.

Two small pieces were still missing, and this change adds them. The Merge
Conflicts section now says in its own explanation that the Kind dropdown does
not apply to it, because it counts pull requests rather than tickets. And the
demo tracker now gives a kind to four of its open tickets, not just its
finished ones, so picking Feature in the demo visibly changes the Open Now
table as well (it drops to two tasks), instead of showing zero.
