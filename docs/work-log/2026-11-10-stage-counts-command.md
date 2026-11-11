## 2026-11-10 — Add a stage-counts command to the door for the weekly report (#170)

Every Monday StarCaster writes a report on the week. One of its rows shows
the pipeline: how many tickets sit in each stage, and how many shipped that
week. It gets those numbers by asking its ticket command for "stage counts".
When StarCaster switches to Spirality's ticket command, that question would
have had no answer and the row would have gone blank.

Spirality's command now answers it, in exactly the shape StarCaster's report
already reads, so nothing on StarCaster's side has to change. It also adds
two things the report can use later: how many tickets were filed that week,
and how many moved into each stage that week, read from each ticket's
history.

The numbers are counted the same way the tracker's Reporting page counts
them. Checked on a copy of the real data: for the week ending November 10,
both said 96 tickets shipped and 110 were filed. If any ticket's history
cannot be read, the command prints nothing and says which ticket, rather
than a report quietly counting part of the week.
