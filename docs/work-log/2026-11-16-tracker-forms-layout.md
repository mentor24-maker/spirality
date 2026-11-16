## 2026-11-16 — Lay out tracker forms the StarCaster way, with Title Case field labels (#266)

Every form on the tracker page now works the way StarCaster's admin screens
do. Boxes you type into all look the same: a light border, rounded corners and
a pale background that turns to a black border while you type. Each box is
about as wide as what goes in it: short for a name or an email, longer for a
title, an address or a description. Before, every box ran the full width of
the page, however little went in it.

Short settings, such as a dropdown or a file picker, now have their name
beside them, so a column of settings reads like a list. Text boxes keep their
name above them.

The words that name a box are now in Title Case, like the buttons and headings
already were: "Invite Someone", "Assigned To", "Ticket Prefix". Where a name
was really a whole sentence, the sentence moved to a small line of help under
the box. The setup form, for example, now says "Project Name" with the
wizard's question under it.

The grey text inside an empty box used to give the instruction ("Add a tag,
then Enter"). That text vanishes as soon as you type, so the instruction now
sits under the box and the grey text shows an example instead. The search
boxes have a visible name for the same reason.

`npm run verify` now checks all of this: a box with no name, grey text that
gives an instruction, a box stretched to full width or a box name not in Title
Case fails the pull request.
