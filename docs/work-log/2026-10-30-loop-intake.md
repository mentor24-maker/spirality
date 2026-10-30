## 2026-10-30 — Dane's requests sit in Requested until someone specs them by hand: add a spec pass that turns each into tickets for him to approve (#37)

A request filed from the tracker page used to wait in **Requested** until
someone opened Claude Code and wrote it up. Now a fourth job on the Mini,
**loop-intake**, does that every half hour: it takes the oldest request,
turns it into a proper plan (what it does, what it leaves alone, which files,
how to tell it is done, how to test it), keeps Dane's own words word for
word at the top, and splits it into several tickets when it is too big for
one change. Every ticket it writes goes to **Needs your input** with a card
asking him to reply "go" or say what to change, so nothing reaches the
builder without his say-so. A request it cannot understand gets a question
instead of a guess. The job has its own log, its own lock and its own
tracker sign-in, which has to be made once on the Mini before it runs.

After review, three ways it could jam were closed. A request with a quoted
line in it (a pasted email, say) used to fail the same way every half hour
and hold up every request behind it; now the card's own "code box" round
Dane's words is always bigger than any code box inside them, and the checker
lets a quoted line through there, and a request that fails once gets one
plain card telling him what went wrong, then is set aside so the others keep
moving. A pass that stopped halfway through splitting a request now leaves a
note of the pieces it filed, so the next pass finishes the job instead of
filing them twice. And the checker, and the tracker page, now understand a
code box that itself contains a smaller code box, so his text shows exactly
as he wrote it.

A second review found the first fix made things worse: the intake job put
his words in a code box, and the card puts that whole section in a code box
too, so on the tracker page the box closed early and the red "needed from
Dane" banner showed as code he could not read. Now the job hands his words
over as they are, and the card and the tracker size their own box to fit
whatever is inside. A test posts a card with a quoted line and a code box in
his words through the real tracker, draws the page, and checks the banner
is outside the box.
