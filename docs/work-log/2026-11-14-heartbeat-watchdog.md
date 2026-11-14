## 2026-11-14 — Add the heartbeat watchdog to Spirality, so a lane that stops running is said on the bus (#239)

Until now, if one of a project's lanes stopped running (the build, review or
intake lane, or the relay), nothing said so: a dead lane looked exactly like
a quiet day. StarCaster has had a "heartbeat" for that since September, but
it only ever watched StarCaster.

This brings its decisions across. Every lane already writes a dated line to
its own log each time it wakes, so the heartbeat reads those logs and works
out when each lane last ran. A lane counts as quiet after six missed wakes,
and never less than three hours. That rule came from StarCaster's
measurements of the Mini's real logs, so an ordinary slow hour doesn't set
it off. A paused lane is never judged.

The relay now runs the check on every wake. A quiet lane gets one `ALARM:`
on the project's bus, which the tracker texts. It is said again at most once
every six hours, and when the lane runs again there is one closing line. If
the check itself breaks, the relay says so in one line and carries on.
`npm run heartbeat` shows every lane and its last pass in Mountain time,
without posting anything.
