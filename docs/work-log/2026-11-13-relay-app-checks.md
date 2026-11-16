## 2026-11-13 — Run a project's application checks on every relay pass (#205)

A project can list its own health checks in its manifest (for example "is the
disk nearly full?"), and since SP-264 Spirality could run them and post what
changed to the project's message board, but only when someone started it by
hand. Now the relay, the job that wakes every ten minutes to merge what Dane
approved, runs them at the end of every pass. Each check still runs only as
often as its own setting says.

The relay's merges always come first. The checks get their own slice of the
pass's time (at most three of its eight minutes), so a check that hangs is
stopped, and the log says so; it can never hold up a merge. A check pass that
fails makes the relay's log say a step failed, never "pass complete", and the
lanes' status report (`scripts/install_loop_runner.sh --status`) shows the last thing the checks said.

Review sent it back once. The status report stopped dead on the new line
when the relay log had no checks line yet, which is every log today; it now
says "(none yet)" and carries on, and a test runs the real report to prove
it. And the relay now sets time aside for the checks only when the project
actually lists one, so a project with none (Spirality today) keeps the whole
eight minutes for its merges, as before.
