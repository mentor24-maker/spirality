## 2026-11-05 — A ticket's page keeps asking Dane for a move he already made: show the Your move line only while the ticket is waiting on him (#96)

The top of every ticket's page shows, in red, what the last loop card asked
Dane to do. It kept showing that line forever, even after he had answered and
the ticket had moved on: SP-112 still asked him for "go" while it sat in
Rework, and once it was Live it was still asking him to merge PR #95. That
made the page look as if it was waiting on him when it wasn't.

Now the red line appears only while the ticket really is his turn (Needs your
input or Ready to launch) and he hasn't answered yet. Everywhere else it
says, in one quiet line, where the ticket is and that nothing is needed from
him, for example "In Rework: the build loop is fixing what review found.
Nothing is needed from you." The Go, Merge and Close buttons are unchanged.
