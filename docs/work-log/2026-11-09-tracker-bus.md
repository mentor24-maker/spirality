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

Review sent it back once, and it was right. The table said a steward's
question needs one command to file it, but a question filed that way sits
in Queued, where Dane never sees it: it reaches his Waiting on You list only
after a second command, `ask`. The table now says both, so the StarCaster
switch-over cannot copy a path that hides his questions. The time on each
post is now Mountain time, the time Dane reads, not UTC. A new Team chat
ticket's status is checked after it is made, because being in Live is the
only thing that keeps a loop from trying to build it. And if one bus ticket
cannot be read, `bus-read` names it, still reads the rest, then fails, so
one bad ticket cannot hide Dane's "stop" on Team chat.
