## 2026-11-11 — The relay refuses a merge it already made: finish the job and move the ticket to Live (#186)

On 11/11 SP-207 sat on Dane's bell for hours after he had said "merge". The
relay had in fact merged it, the moment the Mini's internet came back, but the
check it makes straight afterwards could not read GitHub's answer, so it wrote
nothing down. Every pass after that saw a merged pull request, said "the PR is
already merged", and asked for someone to move the ticket by hand.

Now, when Dane's merge word meets a pull request that is already merged (by
the relay's own earlier pass, or by hand on GitHub), the relay simply finishes
the job: it marks his word as used, writes the merge note, moves the ticket to
Live (or back to Queued when the ticket says another slice is coming), and
tells the other tickets in flight that main moved. Tickets that already got
the old refusal are finished the same way on the next pass. Every other reason
the relay will not merge works exactly as before.

Review sent the first version back for one real hole: it wrote "this ticket
is now Live" and used up Dane's word *before* moving the ticket. If the move
failed, the note was wrong and no later pass would ever try again, which is
the very problem this ticket exists to end. Now the relay moves the ticket
first. Only when the move reads back does it write the note, use up his word,
and announce it. A failed move writes nothing else and says so, and the next
pass (ten minutes later) finishes the job. It also now refuses, as before, a
pull request that was merged before the newest review pass: that one belongs
to an earlier slice, and finishing it would mark unbuilt work Live.
