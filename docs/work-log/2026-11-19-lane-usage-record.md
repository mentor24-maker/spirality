## 2026-11-19 — Record every lane pass's Claude usage on the API Usage report (#331)

The API Usage report under Reporting (built in #330) only showed a run once
something told it about that run. Now the lanes tell it themselves. Each time
a lane starts Claude, it gives that run its own name tag (a session id), and
when the run ends it asks the tracker to read what that run used, per model,
and put it on the report with the lane and the ticket it worked on.

If that last step fails, for example on an older copy that does not know the
command yet, the lane writes the answer in its log and carries on exactly as
before: recording usage can never stop or change a pass.
