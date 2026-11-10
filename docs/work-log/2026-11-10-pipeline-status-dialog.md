## 2026-11-10 — Dane cannot see what each loop last did from the Tasks page: open a Pipeline Status dialog from the pod (#149)

The little Pipeline Status box in the Tasks toolbar showed only when each loop
wakes next. Now it is a button: clicking it opens a Pipeline Status window
that shows, for the relay and the build, review and intake loops, when each
one runs next (or that it is running right now, and since when), when its last
run started and finished, how that run ended in plain words ("Finished", "A
step failed and said so", "Hit its time limit and was stopped", "Could not
run"), and how often it wakes. Escape or Close shuts it.

Why it matters: Dane no longer has to ask a session "what did the loops last
do?"; the answer is one click away on the page. The window still shows only
times and outcomes, never the text of the loops' logs.

Fixed after review: the page redraws itself once a minute when tickets
change, and that redraw used to close the window from under Dane (on the
Mini, where loops move tickets all the time, often). Now an open window holds
the redraw until it is closed, and the board catches up then. The button also
tells a screen reader its name ("Pipeline Status: Relay 1:08 AM, Build
running, …"), and while a loop is running, its "Last Ended" cell says
"Previous pass:", so an earlier failure no longer reads as if the running
pass had failed.
