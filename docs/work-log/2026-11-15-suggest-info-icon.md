## 2026-11-15 — Add an info icon to each row on the Suggest New Tasks screen (#254)

When the tracker suggests next tasks, each suggestion used to show only its
title. To read why it was suggested you had to unfold its **More** line, one
row at a time. Now each row has a small round **i** beside the title. Pressing
it opens a box with the suggestion's title, **Why It Matters** and
**Description**. **Close**, Escape or a click outside shuts the box, and the
keyboard focus goes back to the i you pressed, so you can carry on down the
list.

Each i belongs to its suggestion, not its place in the list. Drag a row to
the top or pick a new place from its dropdown, and its i still opens that same
suggestion's box. A test checks this, along with one that proves a suggestion
containing `<` or `&` shows as plain text, never as page code.

This is the first of two parts. The second (SP-305) adds what Dane also asked
for: related tickets, topics, tags, links and a 100-word description. The
suggester has to start supplying those first.
