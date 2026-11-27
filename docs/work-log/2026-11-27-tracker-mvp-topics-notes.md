## 2026-11-27 — Update the Topics notes in TRACKER_MVP to match what the tracker does (#349)

The tracker's plan still described the Topics page as it was on its first
day: a page that could only add and list topics, with editing, deleting and
tying topics to tickets "coming later". All of that has since been built, so
the plan was telling anyone who read it (a person or a build pass) to start
work that was already done. The paragraph now says what really exists: the
Topics page edits and deletes topics, tickets carry topics, and the Tasks
page shows and changes them. It also names plainly what is still missing:
topics cannot be linked to each other, and a ticket's own page does not show
its topics. While checking, one belief in the ticket itself turned out to be
wrong (the Tasks page's Topic picker narrows a search, it does not filter the
board), and the paragraph says what the code does.
