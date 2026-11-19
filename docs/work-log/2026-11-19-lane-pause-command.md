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

After review, those plain settings are handed only to the pass and to the
project's pause command, never set inside the runner itself. Before, a
setting named like one of the runner's own (its lock folder, its log) could
have replaced it, and on shutdown the runner could have removed the wrong
folder. The settings are now read before every pass, so a broken settings
file holds the lane visibly as paused instead of stopping the runner, and a
longer list of shell names that would misbehave is refused up front. The
settings-file guide now says plainly that an optional new field does not
raise the file's version number, so no other project has to edit its file.
