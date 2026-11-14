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

Review sent it back for one real problem: a lane that had been paused for
more than a few hours would have been called dead the moment Dane unpaused
it, because its last dated line was from before the pause, and he would have
been texted a false alarm for every lane. Now a paused lane's runner writes
a dated `PAUSED` line each time it wakes and holds off, and the heartbeat
counts that as the lane being alive. The heartbeat also now asks "is this
lane paused?" the same way the lanes do, so a Settings page that cannot be
read means "paused" to both, never "paused" to one and "dead" to the other.
Two smaller fixes rode along: a stamp file that cannot be removed is now
reported as a failure instead of quietly repeating the "running again" post,
and only the end of each lane log is read on every wake, not the whole file.
