## 2026-11-05 — On Tasks page, make Add Task pod darker blue background (#108)

The Add Task box at the top of the Tasks page was a thin outline on white, so
it looked like just another stage and was easy to miss. It now has a solid
background in the same blue as the "Spirality" wordmark, on both the board
and the list, whether it is closed or open. That blue is much darker than the
pale tints behind the stage headings, so the box stands out as the place to
file something new.

The words on it stay dark, because dark text on this blue is easy to read
(about 5.7 to 1, comfortably above the usual accessibility bar), while white
text would be faint. The two typing fields stay white, so filing a request
looks and feels exactly as before. A test now checks all three of those
things so a later change cannot quietly undo them.
