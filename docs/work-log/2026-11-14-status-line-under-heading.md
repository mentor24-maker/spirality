## 2026-11-14 — Task Details page updates (#244)

A ticket's page now says where the ticket is right under its heading:
"Status: Queued", in the same type as the rest of the page, with a small "i"
beside it. Pointing at the "i", tapping it, or tabbing to it and pressing
Enter shows what that status means for Dane, such as "It waits for the build
loop to pick it up. Nothing is needed from you." Before this, the same words
sat in light grey small print at the bottom of the top section, where they
were easy to miss, and Dane's own two statuses had no line at all. Now they
have one too: Needs your input says the loop is waiting on his answer, and
Ready to launch says the work waits on his Merge. This is the first of two
slices of his request. The second (SP-291) changes the right-hand column
while a loop has the ticket.

Review sent it back once: on a ticket where Dane had already answered (or
already said Merge), the "i" still told him the loop was waiting on him. Now,
once his answer is in, it says "Your answer is in; the loop takes it from
here. Nothing is needed from you.", and once his merge word stands, "Your
merge word is in; the relay merges it on its next pass. Nothing is needed
from you." So the icon never asks for a move he has already made.

Review sent it back a second time for the same kind of slip: on a Ready to
launch ticket whose pull request was already merged on GitHub (waiting only
for the relay to mark it Live), the "i" still said the work waited on his
Merge, while the page beneath it said the merge was done. Now the "i" reads
the same live GitHub check the page already uses: merged says "The pull
request is merged; the relay moves this to Live on its next pass. Nothing is
needed from you.", and closed without merging says so and points to the note
below.

Review sent it back a third time, and asked for the slips to stop being fixed
one at a time. A Ready to launch ticket whose card asks Dane to Close (the
pull request has already landed) showed a Close button, while the "i" still
said the work waited on his Merge. Now, on his two statuses, the "i" no
longer reads the bare status: it asks the very same questions the page asks
before drawing the Merge and Close buttons (one shared check for each), so
the two cannot disagree. When the page offers Close, the "i" says "It waits
on your Close; the card below says why." When a Ready to launch ticket has no
Merge to offer at all, it says "It waits on your reply below." A new test
walks every ticket in the demo and fails if the "i" ever names a move the
page does not offer.
