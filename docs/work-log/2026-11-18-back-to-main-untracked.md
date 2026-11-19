## 2026-11-18 — A project's lanes keep running a merged setup branch when its folder has untracked files: the back-to-main step treats them as uncommitted work and says nothing (#325)

When a new project's setup pull request merges, its branch is deleted, and the
project's lanes are meant to notice and move the project's folder back onto
`main` so they run the latest loop scripts. That check gave up whenever the
folder held any file git was not tracking, and it gave up silently. PressPlay's
folder held one such thing, a scratch-work folder, so its lanes ran a
13-day-old copy of the scripts and no log said so.

Now files git does not track no longer block the move; only a change to a file
git does track does, since that is someone's work. When the step stays put on a
branch that is gone, it writes one line saying why and naming the file. An
untracked file that would be overwritten by moving still stops the move, and
that is said too. Nothing is ever stashed or deleted.

Review caught that the fix sat behind a second, identical check: both runners
(the lanes' runner and the relay) only called the step at all when the folder
had no untracked files, so PressPlay's case would never have reached it. Both
runners now leave that judgement to the step, and a new test runs each
runner's real check against a folder holding only untracked files.
