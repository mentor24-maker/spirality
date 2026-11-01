## 2026-11-01 — Dane cannot change a task's priority, tags, assignee or status from its page: make the ticket page editable (#53)

Until now the ticket page only showed a ticket's priority, tags, who it was
assigned to, its status, its name and its description. To change any of
them Dane had to ask a session to do it. Now the page has a "Change this
ticket" panel under Details where he can change each one himself.

Each change is saved the moment he makes it. The page then reads the ticket
back from the tracker and draws it again, so what he sees is what was
actually stored. If a loop changed the ticket while he was looking at it,
the page says so in plain words and overwrites nothing, so his change can
never wipe out the loop's.

Some choices are left out on purpose. The status list never offers "Needs
your input" or "Ready to launch", because only the loop's `ask` sets those,
with its card. It never offers "Building" or "In review" either, because a
loop claims and checks those. The ticket can only be assigned to Dane or to
nobody, because the assignee is the loop's "whose turn is it" signal. The
tracker itself now refuses any other assignee from a person. Once a pull
request exists, the name is locked: the pull request's title has to match it
exactly.
