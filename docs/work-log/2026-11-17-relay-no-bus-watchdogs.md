## 2026-11-17 — Stop the relay's watchdog checks reading as failures on a project with no bus (#318)

Cassidy was set up without a bus, the shared place where the relay's
watchdogs post their alarms. With nowhere to post, every watchdog said so
and stopped with an error code, so every ten minutes Cassidy's relay log
showed four "check FAILED" lines. Nothing was broken, but a log that cries
failure on every pass teaches everyone to stop reading it.

Now the relay asks once per pass whether the project has a bus. With none,
it writes one plain line saying the bus watchdogs were skipped and why; the
checks that have something useful to show (which lanes are running, whether
the queue is moving, whether the checkout is up to date) still print their
readings, and only post nothing. A watchdog that fails for a real reason
still says FAILED, and a project whose settings cannot be read is treated
as having a bus, so this can never hide a real alarm.
