## 2026-11-17 — Hand Dane SQL to run as a clickable GitHub link block in every project (#312)

When a loop needs Dane to run a database file, it now has one written way to
hand it over, in every project: the block he asked for on 2026-08-12, one per
file, holding a link to the file on GitHub that he can click. Until now only
StarCaster had that rule, so a StarCaster pass on SC-826 handed him a list of
bare file names instead, and he sent it back.

The rule (doctrine §6.5) came across from StarCaster with his template word
for word, and two holes fixed. The link now points at a saved version of the
file (a commit) instead of the work-in-progress branch, because a branch is
deleted when its work merges and the link stops working; the loop's own
ticket commands already refuse branch links for that reason. And the rule now
covers the cards a loop posts on a ticket, not only messages in a chat window,
since cards are how the unattended loops reach him. The build loop's
instructions point to it and show a whole example card.

Nothing checks a card for the block yet; that is the next ticket, SP-381.
