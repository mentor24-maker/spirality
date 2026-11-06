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

Review caught one thing the first version missed: the small line beside the
File request button, which says "Filing…" while a request goes in and
"Not filed: …" in red when it fails, kept its old grey and red, and on the
blue those were nearly invisible (about 2 to 1). A failed filing is the one
message that must never be missed, so that line now sits on a small white
patch inside the box, where the red and grey read just as they do everywhere
else on the page. The test covers it too.
