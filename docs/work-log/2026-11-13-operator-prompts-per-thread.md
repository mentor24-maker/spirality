## 2026-11-13 — Any two threads in flight at once clash in docs/OPERATOR_PROMPTS.md: give each thread's prompts their own file (#222)

Every prompt Dane gives a hand-run thread is written down, word for word. Until
now they all went at the bottom of one file, so whenever two threads were
working at once, both added to the same spot and the second one to merge hit a
conflict. Nearly half the merge conflicts that named their files named only
this one.

Now each thread writes to a file of its own in `docs/operator-prompts/`, named
by the day it started and a short topic, the same fix the work log got earlier.
The ten threads already recorded were moved across unchanged (only their links
to other docs were adjusted for the new folder). The old file now just explains
the log and says where new threads go, `CLAUDE.md` points at the new folder,
and the Docs page on the tracker lists the threads under Operator Prompts with
their dates. The `doc-it` skill, which lives on each machine rather than in the
repository, needs a one-step wording change after merge; the pull request
carries the exact new text.
