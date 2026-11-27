## 2026-11-27 — Move the Console, bell, ticket page and mlist onto one whose-move helper (#346)

Six places in the tracker answer the question "is this ticket waiting on
Dane?": the Console, the bell, the Waiting on You page, the mlist page, the
ticket page and the Tasks page. Each one used to put that answer together on
its own, from the same rules but by separate code. Yesterday's Console bug
(the Console showing "You" on tickets that were not his move) came from one
of those copies reading the facts differently from the others.

Now one helper, `whoseMove`, works out each ticket's answer once, and every
page reads that one answer. A new test builds every page from the same set of
tickets: one asked and waiting, one answered, one whose merge word stands, one
already merged, one not assigned to him, and one held up by a failing relay.
The test fails if any two pages disagree. As a check, I made one page skip
the GitHub facts on purpose, and the test caught it.

No page looks or counts any differently. The change only means the pages can
no longer drift apart.
