## 2026-11-13 — Every lane pass with nothing to do still starts a Claude session: check the queue without AI first and skip the session when it is empty (SP-292)

Dane wants to turn the wake times down so work moves faster, but every pass
of the build, review and intake lanes started a Claude session, even when
there was nothing to do. The session looked at the queue, said "nothing to
do" and stopped, and each one counted against the weekly limit. Since 10/29
about 5,600 of 8,700 passes were like that. At a 5-minute wake time the
build lane alone would have started about 288 of those a day.

Now the runner asks the tracker first, with no AI, whether the lane has
anything to do: a ticket to build (after handing back anything a dead pass
left in Building, and only if the work-in-progress cap has room), a ticket
in review, or a request to write up. If not, it writes one dated `SKIP` line
saying why and goes back to sleep without starting Claude. If the check
can't tell, the pass runs as before, so a ticket is never held up by it.

Two passes always run anyway: the first one after a lane starts, and one at
least every 6 hours. That way an expired Claude sign-in still shows up on
the Pipeline Status pod within hours instead of waiting for real work to
stall on it, and the setup wizard still sees a new project's first pass.
The pod dates its times from the new `SKIP` lines too, so days of skipped
passes don't throw off when it says a lane runs next.
