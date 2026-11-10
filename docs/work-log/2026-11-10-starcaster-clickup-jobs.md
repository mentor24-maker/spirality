## 2026-11-10 — StarCaster's bus-relay, pulse and weekly report read ClickUp: list what each needs on the tracker and file the work (#162)

Before StarCaster moves its tickets from ClickUp to our own tracker, we needed
to know everything on StarCaster's side that still talks to ClickUp. The move
only switches off StarCaster's two building and reviewing loops; about twenty
other background checks and reports keep running. This pass looked at each one
on the Mini and wrote down, in `docs/onboarding/STARCASTER.md`, what it reads
and writes on ClickUp and how it will work on the tracker instead.

The main lesson: most of those checks would not break after the move. They
would quietly keep watching a ClickUp list nobody uses any more, and post
their alarms where nobody looks. That is worse than breaking, because nothing
would say so. Four pieces of Spirality work came out of it (SP-204 to SP-207:
a place for StarCaster's alarms, a way for scripts to read tickets, the weekly
report's stage counts, and merge notices on the alarm channel). StarCaster's
move now waits on all four. Nothing in StarCaster itself was changed.
