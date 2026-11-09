## 2026-11-09 — StarCaster's alarms live in a ClickUp list: give the tracker the bus (#130)

StarCaster says something is wrong (a scheduled job stopped, the queue
stalled, two records disagree) by posting on "the bus". In ClickUp that is
a chat channel the free plan refuses, so in practice a standing "Team chat"
ticket, plus a second list where the steward asks Dane questions. StarCaster
could not move to the tracker without somewhere for those alarms to go.

Now it has one. A project can name a tracker project as its bus. Machines
post an alarm with one command, `bus-post`, which lands as a comment on that
project's "Team chat" ticket and is read back. They read the bus with
`bus-read`, which can keep only Dane's own words: the tracker knows who
wrote each comment, so a machine quoting "stop" can never be mistaken for
Dane saying it. No loop ever builds a bus ticket.

The pull request lists every way StarCaster uses the bus today beside its
tracker equivalent, and a test keeps that list and the plan document in
step. Moving StarCaster's scripts onto these commands is the next ticket.
How loudly an alarm should reach Dane (the page only, or an email or text)
is his decision and is asked on its own ticket.
