## 2026-11-19 — Run a project's heartbeat command after every lane pass (#329)

StarCaster's watchdog expects each of its lanes to check in after every
pass, even a pass that was paused or had nothing to do. StarCaster's own
runner does that; Spirality's did not. So if StarCaster's lanes had moved
onto Spirality's runner, its watchdog would have reported the build and
review lanes as silent. This was the last of the three things StarCaster's
move is waiting on.

Now a project can name its own check-in command in its manifest
(`laneHeartbeatCommand`). Spirality's runner runs it once every turn and
says what kind of turn it was: a normal pass, a pause or usage-limit wait
("stood down"), a pass that failed ("blocked") or one stopped for running too
long ("timed out"). The check-in can never break a lane: if it fails or
hangs, the runner notes it in one line and carries on. A project that names
no command sees no change at all.
