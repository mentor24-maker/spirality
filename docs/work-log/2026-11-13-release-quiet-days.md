## 2026-11-13 — Move a project to the newest Spirality release after a quiet period (#213)

Until now, a project moved to a new Spirality release only when someone
named it by hand. Each project now has a setting on the Settings page,
**Quiet Days Before Moving**. At 0, the default, nothing changes. Set it to,
say, 3, and once a new release has run for 3 days on Spirality's own lanes
with no alarm on Spirality's bus, the project moves to it by itself. Its bus
then gets one line saying so and how to go back.

There are safeguards. A project never moves by itself onto a release it was
rolled back from, and its first release is always named by hand. When
Spirality can't tell whether things were quiet (the bus can't be read, or the
release's time can't), nothing moves and the relay says so as a failed step.
Spirality's own project has no such setting, because it always runs the
newest code.

Built on 11/13, then held, on Dane's word, until the three things it needed
had landed: Spirality's own bus (SP-281), the door acting for another
project (SP-270) and each project's lanes running on their release (SP-276).
On 11/15 it was brought up to date with all of them. The setting now sits
just under the Spirality Release group on the Settings page, the release it
moves, and since Spirality now has a bus, the alarm check is a real one.
