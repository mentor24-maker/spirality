## 2026-11-19 — Sleep a lane until a usage limit resets instead of retrying into it (#328)

When Claude's usage limit closes, a lane's pass dies in seconds with a message
saying when the limit resets. Spirality's lane runner used to ignore that and
try again at its next wake time, straight into the same closed window. That is
how StarCaster's build lane burned three passes in a row at 2am on 2026-09-02.

StarCaster had already fixed this in its own runner, so the fix moved across
with its tests. When a pass fails, the runner reads that pass's own output.
If a usage limit stopped it, the lane sleeps until the stated reset plus two
minutes, never more than eight hours. It also writes a "standing down until…"
note in the project's log folder, so the project's other lanes sleep too
instead of each finding the limit for themselves. If the guard itself breaks,
the lane carries on at its normal pace: a guard is never the reason a lane
stops.

It is off for every project until its manifest says `"usageLimitSleep": true`.
StarCaster turns it on when it moves its lanes onto Spirality (SC-869). One
change from StarCaster's copy: the stand-down note belongs to each project
(`<project>-standdown`), because Spirality never keeps a lane file that every
project reads (SP-263).
