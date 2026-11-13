## 2026-11-13 — Make each lane wake on the interval set on the Settings page (#211)

Last night's change put wake times on the Settings page, but nothing on the
Mini read them: the lanes still slept the numbers written in code. Now they
do. Before each sleep between passes, the build, review and intake lanes ask
the tracker how long to sleep, so a new value takes effect at the next sleep
with nothing restarted. If the tracker can't be reached, or answers something
that makes no sense (like 0), the lane keeps the last value that worked and
writes one line in its log saying why. It never stops and never races.

The relay works differently, because launchd starts it fresh each time
instead of keeping it running. It now starts every minute and checks whether
its wake time is up. If not, it stops at once and writes nothing. A wake sent
to the relay still runs a pass straight away. This needs the installer rerun
once on the Mini.

The Settings page now shows, beside each wake time, what the lane last
actually used, and says "Waiting for the lane's next pass to pick this up"
until the two agree, so it never claims a change has taken effect when it
hasn't. While building this I found the Pipeline Status pod would have
stopped showing when each lane runs next as soon as the runners restarted on
yesterday's code, because a line it reads got longer. That is fixed too.
