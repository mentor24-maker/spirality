## 2026-11-04 — Spirality's build lane skips every pass because it mistakes its own runner for a second builder: tell a lane's pass how to know it is the lane (#94)

Spirality's build skill told a pass not to build by hand while the build lane
was running, but never told it how to know that it *was* the build lane. So
each pass had to guess. That evening two passes in a row guessed wrong: each
saw its own runner holding the build lock, took it for another builder, and
stopped. Two tickets waiting for rework sat untouched.

Normie had the same problem and fixed it in its own copy (NO-7). The runner
already gives every pass it starts a mark, `LOOP_RUNNER_PID`. Spirality's
build and review skills now say to check that mark first: if it is there, you
are the lane, so carry on. Two stale lines saying Spirality has no scheduled
runner are gone too.
