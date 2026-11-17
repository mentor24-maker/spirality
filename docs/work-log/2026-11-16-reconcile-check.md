## 2026-11-16 — Report open tickets whose pull request was merged or closed on GitHub (#289)

When a pull request is merged or closed straight on GitHub, rather than
through the relay, nothing told its ticket. The ticket sat in `Ready to
launch` or `In review` as if the work were still waiting, and nobody was told.

There is now a small check, `npm run reconcile`, that the relay runs every
time it wakes (reading at most once an hour). It looks at every open ticket's
pull request and asks GitHub whether it is still open. A ticket whose pull
request has been merged, or closed without merging, is named on the bus, once
every six hours until it is sorted out. If GitHub cannot be asked, the ticket
is named as "could not check" rather than passed as fine.

It only reports. It never moves a ticket or writes on one: Dane or the loop
does that. This was Dane's answer to the fourth of the seven watchdog
questions (SP-330).
