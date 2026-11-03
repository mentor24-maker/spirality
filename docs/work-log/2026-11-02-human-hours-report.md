## 2026-11-02 — Dane cannot see how many human programmer hours the loops' work adds up to: add the human-hours report to the Reporting page (#77)

Dane asked for a productivity report: how many hours of human programmer
work the loops' finished tasks add up to. Since SP-78, every pull request
the build loop opens carries its estimate of how long an experienced
programmer would take to do the same job. Nothing added those estimates up.

The Reporting page now has a **Human hours of work done** section. For the
last 7 days, the last 30 days and all time it shows the total of those
estimates for the tasks finished in that time, how many of those tasks had
an estimate ("5 of 7 estimated", because tasks finished before SP-78 have
none), and the total per day. When a range has no estimates it says so in
words instead of showing "0 hours", which would look like no work was done.
A line under the heading says plainly that the number is an estimate, not a
measurement.
