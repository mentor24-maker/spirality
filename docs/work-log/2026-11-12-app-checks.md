## 2026-11-12 — A project schedules its own health checks and posts to the tracker itself: let it list application checks in its manifest for Spirality to run and post to its bus (#203)

StarCaster watches its own site (are imports running, are its keys good, are
its links whole) with checks that live in its own code, and that same code
posts to the tracker itself, with the Mini's name written into it. That is
Spirality's job done inside a project, so it would have to be copied into
every project that wants the same thing.

Now a project only says *what* to check: in its settings file
(`spirality.project.json`) it lists each check's name, the command to run and
how often. Spirality's new `npm run app-checks` runs the ones that are due
and posts to the project's bus only when something changes: a check that
starts failing (an alarm, which texts Dane, unless the check says it is not
one), a reminder once a day while it stays broken, and "well again" when it
recovers. A check that stays well says nothing. If a post does not get
through, the pass says so and tries again next time, instead of forgetting.

The settings file's format moved to version 2, because it gained a field.
Nothing runs the checks on a timer yet (SP-274 does that), and Spirality has
none of its own, so nothing new appears on any bus today.

**Second round, after review.** Review found two real faults and two smaller
ones, all fixed. A key a check printed could leak in part when it sat across
the 300-character cut, because the hiding ran after the cut; now the hiding
runs first. A check that could not be started at all crashed the whole pass
instead of being reported as "could not be run"; now it is reported and the
other checks run. A manifest that lists checks on a project still on ClickUp
is now refused when it loads, since the bus would refuse every post. And the
onboarding page now says the command runs from Spirality's folder with
`--config`, not from the project's.
