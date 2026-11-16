## 2026-11-15 — Place Suggest Tasks as checkbox in Add Task row (#253)

The Tasks page had two blue boxes stacked on top of each other: one to add a
task, one to ask for suggested next tasks. Dane asked for one box with a
switch instead. Now the Add Task bar has the word "Suggest" and a checkbox at
its right end. Leave it unticked and the box opens to the usual Add Task form;
tick it and the same box shows the Suggest Next Tasks list instead.

Switching back and forth loses nothing. Words already typed, a title already
picked, and the suggestions' order and ticks are all still there, because
both halves stay on the page and only one is hidden at a time. The browser
remembers which side was picked, so a reload or the page's once-a-minute
refresh keeps it. Clicking the checkbox opens a closed box and never folds an
open one, and it works from the keyboard too.
