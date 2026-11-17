## 2026-11-16 — Copy the tracker's backups and the Mini's launch agents off the Mini (#292)

The tracker has made a copy of its database every night at 03:15 for weeks,
but only onto the Mini's own disk. If that disk died, the backups would die
with it, and every project's tickets would be gone at once.

Now the same nightly job also sends two things to a private GitHub
repository that Dane chose for this, `spirality-machine-backup`: that night's
database, squeezed down to about a third of its size, and the Mini's launch
agents (the small files that tell the Mac which jobs to run and when). The
newest 14 nights of the database are kept there, the same as on the Mini.

It never sends a password, key or sign-in, and it stops and says so if a job
file looks like it holds one. It checks every upload by reading it back from
GitHub, and it says plainly in its log when a night's copy failed. Tested for
real once before the pull request: the copy downloaded back from GitHub was
identical, byte for byte, to the Mini's own backup.
