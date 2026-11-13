## 2026-11-13 — Show each project's Spirality release on the Settings page, with Move to Newest and Roll Back (#207)

SP-265 gave every project a written record of which Spirality release it
runs, but the only way to see or change it was a command. Now each
project's section on the Settings page shows it: the release it runs, when
and who named it, the one it ran before, and the newest release there is.

The project's operator gets two buttons. **Move to Newest** moves the
project onto the newest release, checking which release is newest at the
moment of the click. **Roll Back** puts it back on the release it ran before.
Both make the same change the commands make, and the page reads the record
again before it says "Saved"; if the change was refused or failed, it says
why instead.

Spirality's own project shows that it always runs the newest release, since
its own lanes are the first to meet every change, and has no buttons. Nothing
on the Mini runs from the named release yet; SP-276 does that, and the page
says so under the group.
