## 2026-11-16 — Hold a ticket back from building while an open pull request changes the same files (#281)

Two tickets that change the same file used to be built at the same time, and
their pull requests then clashed. Nine merge-conflict fix-up tickets were
filed on this one day. Now, before the build lane starts a new ticket, it
checks the files that ticket expects to change against the files every open
pull request changes, and against the tickets already being built. If even
one file is shared, the lane leaves that ticket for now, builds a different
one in its place, and leaves one note on the held ticket saying which work
holds it. Once that work merges or closes, the held ticket goes back to its
normal place in line. Nothing about this needs Dane.

Tickets that are fixing an existing pull request (send-backs and merge
fix-ups) are never held, because their pull request already exists and two
of them could otherwise wait on each other forever. An older ticket that
doesn't say which files it will change gets them worked out and written onto
it, with a new `likely-files` command, before it is started.
