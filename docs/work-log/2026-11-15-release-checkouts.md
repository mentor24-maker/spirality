## 2026-11-15 — Run each project's lanes on the Spirality release named for it (#261)

Until now, if another project ran its loop from Spirality, it ran whatever
Spirality's `main` was at that moment, so one bad change could reach every
project at once. Now a project's lanes run on the Spirality release the
tracker names for it. Each pass asks which release that is, keeps a copy of
Spirality at that release in the log folder, and runs from that copy.
Spirality's own lanes still run `main`, so they meet every change first.

If you name a new release (or roll one back), the project's next pass picks
it up, and a pass already running is never stopped. With no release named,
the project's lanes do not run, and the log says why in one line. If the
named release can't be set up (a missing tag, a failed download or install),
the pass stays on the release that project ran last and says so once on its
bus. Copies nothing needs any more are cleaned up after a pass. The status
command now shows which release each project runs.

Nothing changes on the Mini today: only Spirality's own lanes use this
runner, and no release has been cut yet.

Review sent it back for four things, now fixed. The relay's "is this machine
on the latest code?" check had started looking at the release copy, which is
behind `main` on purpose, so it would have raised a false alarm every ten
minutes; it now looks at the project's own checkout again, and a test proves
it stays quiet. A paused or idle project lane no longer sets up a release at
all. Setting up a release in the relay now has its own five-minute limit and
counts against the relay's time, so one slow install cannot hold the relay
for half an hour. And the bus is told again when a warning turns into an
alarm, never about a busy lock, and the log keeps the release check's own
error lines.
