## 2026-11-05 — The ticket page pops up a Your reply was posted box after every post: drop the box and keep the page at the top (#110)

After Dane posted a reply, or clicked Merge, Close or Go on a ticket page, a
"Your reply was posted. OK" box popped up and had to be clicked away. He asked
for it to go. Now the box is gone: the page simply redraws, scrolled to the
top with Details open, and the redrawn page is the confirmation. A post that
fails still shows its "Not posted" line and does not move the page, and the
"are you sure?" question before Merge, Close and Go is unchanged.

The first version's test banned every pop-up box on the page, which also
caught the separate "right project?" question on Add Task, a box that is
meant to stay. The test now checks only for the posted box.
