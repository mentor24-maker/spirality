## 2026-11-12 — Every project carries its own copy of the loop: run its lanes, door, skills and hooks from Spirality's folder, with pauses scoped to one project (#202)

This is the first, safest slice of moving each project's loop into Spirality.
Soon one Spirality folder will run the lanes of several projects on the same
Mac, and they all keep their working files (locks, wake files, logs) in one
shared folder, `~/loop-logs`. If any of those files had a name without the
project in it, one project's pause or stand-down would quietly stop every
project.

Almost every file was already named for its project. This change adds a check
that reads the runners, the relay, the installer and the code that names those
files, and fails the build if any name is missing the project's name.

It also adds the piece that will keep the pipeline's pause switch per project:
a lookup that finds the switch only in the project's own tracker project, so
pausing StarCaster can never pause Spirality. No lane asks the pause switch
yet; that wiring is SP-237, which must use this lookup. When the lookup cannot
read the switch (a failed read, or one that came back in the wrong shape) it
answers "paused", never "running", because guessing "running" is the one
mistake a pause switch must not make. Along the way it fixed one note that
pointed Dane at a log file that does not exist.
