## 2026-11-22 — Add 'All projects' option to filter on Tasks > List and > Board views (#334)

The Board and List views on the Tasks page could only show one project at a
time, while the Console could already show every project at once. Now the
Project dropdown on Board and List starts with **All Projects**: pick it and
you see every project's tickets together, in the same eight stages, each card
and row naming the project it belongs to.

Behind it is one new read on the tracker that puts every project's board
together, in the same order each project's own board uses. It only includes
the projects the person signed in may see, so someone given one project never
sees another's tickets.

The List view's dropdowns still work on every row, offering that row's own
project's people, tags and topics. The Topic dropdown lists every project's
topics, each with its project's name. The page remembers the choice, so
"Tasks" in the header brings you back to All Projects. The Add Task box asks
which project a new task is for before filing it, rather than guessing.
