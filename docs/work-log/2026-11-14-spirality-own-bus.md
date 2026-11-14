## 2026-11-14 — Give Spirality its own bus (#237)

Spirality had nowhere to post its own warnings. StarCaster has a "bus", a
tracker project whose "Team chat" ticket collects alarms and the relay's
notes about merges and stuck work, but Spirality's settings named none, so
those notes went nowhere. The planned check that moves projects to a new
Spirality release after a quiet period (SP-277) needs that bus to read.

This change names the bus, `spirality-bus`, in Spirality's settings file and
corrects the three documents that said Spirality had no bus. The bus project
itself has to exist on the tracker before this merges, or every relay pass
would fail trying to post to it. The build session was not allowed to write
to the live tracker database, so the pull request gives Dane the one command
that makes it. A practice run on a copy of the database showed all five loop
sign-ins can see the new project.
