## 2026-10-31 — Dane has to leave the ticket page to close a finished ticket: add a Close button and a one-line Your move (#51)

When a ticket's work was already finished, its card used to tell Dane to
"move this ticket to Live yourself". The tracker page has no way to do that,
so he had to go to another app. Now every card a loop writes ends with one
short line saying his move: **Your move: Merge**, **Your move: Close** or
**Your move: Reply**. The page reads that line and shows the matching button.

The new **Close** button works like the Merge button. It asks once, then posts
"close" as his reply, and the relay (the background job that acts on his
words) closes the ticket a few minutes later. On a Ready to launch ticket the
relay only closes it once its work has actually landed: either the ticket's
own pull request, or the one it was filed to unstick, must be merged. If not,
it leaves the ticket alone and replies once to say why. His same word then
closes it as soon as the work does land. On a Needs your input ticket, where
closing was already allowed, it closes on the relay's next pass, and the note
under the button says so.

The **Merge** button now only appears when the ticket has a pull request of
its own. A ticket with none, like one filed to unstick another pull request,
no longer shows it.

Loops can no longer post a card that is missing the "Your move" line, or one
that tells him to move a ticket himself. The instructions every loop follows
were updated to match.
