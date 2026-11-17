## 2026-11-16 — Turn the Loop Queue Anatomy page into a two-column table of diagram slices and copy (#294)

The Loop Queue Anatomy page explains each of the eight boxes on the Loop
Queue diagram. Until now it was a long column of text, with a heading over
each section. On the tracker it is now a table, one row per status. On the
left is that status's own box, cut from the diagram picture. On the right is
its explanation, starting level with the box. The box already shows the
status's name, so the headings are gone. Clicking a box opens the Docs page
with the whole diagram in view, so you can see where that status sits.

The cut-outs come from the one existing picture. Nothing new was drawn and no
image files were added. Every box is drawn at the same size, and they shrink
on a narrow screen. On a very narrow screen each box sits above its text. The
diagram's own links into this page still land on the right row. The file in
`docs/` is unchanged, so it still reads properly on GitHub.
