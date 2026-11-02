## 2026-11-01 — Make buttons on Task Details page green (#59)

The buttons on a ticket's own page were the browser's plain grey, except
Delete, which had a red outline. They are now all green (`#00AA00`), with a
darker green border (`#006600`), corners rounded by 10px, and white text
that stays easy to read. That covers the command Copy, Merge, Close, Post
reply, Delete, the Save, Edit and Cancel buttons in "Change this ticket", and
the Copy under "Copy to another project". Delete still asks before it
deletes; it just no longer looks different. Buttons on every other page are
unchanged, and a test checks the green so it cannot slip back quietly.
