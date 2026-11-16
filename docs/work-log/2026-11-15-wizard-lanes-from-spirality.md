## 2026-11-15 — Make the setup wizard install lanes from Spirality and stop copying the loop (#249)

Until now, setting up a new project meant copying about 110 of Spirality's
files into that project: the ticket door, the lane runners, the watchdogs,
the loop skills and the safety hooks. Each copy was a snapshot. A fix made
in Spirality afterwards did not reach the project until someone copied it
again, which is how StarCaster and WaveCenter drifted apart.

Now the wizard copies none of it. A new project's setup pull request holds
only what really belongs to the project: its settings file, the `verify`
check that says its code is healthy, one `.gitignore` line, and the short
rules sections in its `CLAUDE.md`. Its lanes are installed by Spirality's
own installer and run from Spirality's folder, working in the project's
checkout. The setup ticket is filed through Spirality's own ticket door.

A new script, `scripts/dry_onboard_lanes.sh`, shows this on a throwaway
project: the lanes step names Spirality's installer, not one inside the
project. Projects set up before today keep their copy until each one's own
queue removes it.
