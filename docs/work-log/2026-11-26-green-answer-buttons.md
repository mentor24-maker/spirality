## 2026-11-26 — Make Merge and Go buttons green (#343)

The buttons Dane presses to answer a ticket that is waiting on him (Merge,
Go, Approve and Close on the ticket page; Merge, Close, Go and the pick
list's Send on the phone page) were blue, the colour for "start something
new". They are now the same bright green as Save, the colour for "yes, do
the thing I am expected to do", so the step he is waiting to take stands out
the same way everywhere.

The style guide had said the opposite since the button clean-up of 11/15; it
now says answers are green and why. A check draws every one of those buttons
and fails the build if any turns blue again. A sweep of every other button on
the tracker found one more out of line, the ticket page's Close, which was
white though it gives the same answer as the phone page's green Close; it is
green now too.
