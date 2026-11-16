## 2026-11-15 — Give tracker tables and dialogs StarCaster's look and sizing (#264)

Every table on the tracker page now has the same look as StarCaster's: a black
row of column names in bold white along the top. Each table sits in its own
box that stops before the bottom of the screen and scrolls inside itself, and
the row of column names stays put at the top while the rows move under it, so
on a long list you never lose track of which column is which. Sorting still
works by clicking a column name.

The pop-up windows (Pipeline Status, a suggestion's info box, the project
check, a command's details) used to have fixed widths. Now each is as wide as
what is in it, never narrower than a sensible minimum and never wider than
three quarters of the screen, the rule StarCaster follows. The Pipeline Status
window no longer needs sideways scrolling.

A new automatic check fails the build if a table loses its box or a pop-up
gets a fixed width again, so the look cannot quietly drift back.
