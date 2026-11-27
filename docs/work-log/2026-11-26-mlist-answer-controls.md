## 2026-11-26 — Answer tickets from the mlist page with buttons and dropdowns (#341)

The phone page (`/mlist`) used to show a ticket's question but not let Dane
answer it. Now, under the red question, the page draws the answer the card
asks for: a dropdown of the lettered choices with a Send button, a Go
button, or the same Merge and Close buttons as the full ticket page. A
folded "Something Else" box is there for any other reply, so by default
there is nothing to type.

Each button posts exactly the words he would have typed, through the same
route the full ticket page already uses, so nothing new can go wrong on the
tracker's side. After a send the page goes back to the list, and the
answered ticket is gone from Waiting on You. If a send fails, the red
message strip at the top says so and the ticket stays open.

After review: the first version showed a one-tap Go button on any reply
question without lettered choices, including one that asked "Reply A (the
Mini) or B (a hosted server)". One tap would have answered an A-or-B
question with "go". Now the phone page offers Go only where the full ticket
page does (the question quotes the go word), and choices written inside a
sentence like that one become the same dropdown as a lettered list.
