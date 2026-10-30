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
