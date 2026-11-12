## 2026-11-12 — Nobody can see where a ticket's time goes: a time-in-status report split into working, waiting for a lane, waiting on Dane and broken (#193)

Before changing how often the loops wake up, Dane wanted to know where a
ticket's hours actually go. The Reporting page now has a section called
**Where the Time Goes** that answers that.

Every hour of every ticket's life, up to the moment it goes Live, is put in
exactly one of four piles: a loop **working** on it (Building), **waiting for
a lane** to wake and pick it up, **waiting on Dane** (in one of his two
stages with his answer not yet in), or **broken** (a loop wrote a failure
note on it and nothing has moved since). The page shows those four piles for
the last week, the last month and all time, and lists the ten tickets that
took the most time, each a link to its page.

Run against a copy of the real data, the last month came out at about 6%
working, 75% waiting for a lane, 19% waiting on Dane and under 1% broken:
most of a ticket's life is spent waiting for the next loop to wake, which is
what the companion ticket about starting the next lane straight away is for.
Two limits are written on the page so the numbers are not read as more than
they are: review's own working time counts as waiting (nothing marks when a
review starts), and a loop that failed without writing on the ticket shows as
waiting, not broken.
