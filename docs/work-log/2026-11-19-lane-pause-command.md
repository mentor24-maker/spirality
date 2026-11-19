## 2026-11-19 — Spirality's lane runner lacks the guards StarCaster's has, so StarCaster cannot move its lanes onto it: add the usage-limit sleep, a heartbeat after every pass, and the project's own pause switch (#327)

StarCaster wants its loops run from Spirality's folder instead of its own
older copy, so a fix made once reaches it at once. But StarCaster's own lane
runner does a few things Spirality's does not, and switching today would
quietly lose them. This is the first of three pieces that close that gap.

A project can now name its own "are we paused?" command in its settings file.
Before every pass, Spirality's runner asks it; anything but a clear "go"
(including a command that is broken or hangs) holds the lane, logs why, and
waits for the next turn, the same way the Settings page's pause switch does.
A project can also list a few plain settings its loops should always run
with, such as StarCaster's flag that tells its scripts a pass is running in
the background. Neither does anything for a project that leaves them out, and
a test proves the runner behaves exactly as before in that case. The
usage-limit sleep and the heartbeat follow in SP-396 and SP-397.
