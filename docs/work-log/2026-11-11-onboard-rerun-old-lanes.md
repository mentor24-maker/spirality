## 2026-11-11 — A setup rerun after switching back skips the import: run stop, snapshot and import again when the old lanes are back (#188)

When the setup wizard moves a project like StarCaster off ClickUp, it first
stops the project's old loops, saves a copy of its ClickUp tickets and brings
them into the tracker. Tonight StarCaster's setup stopped a step later, and
Dane turned the old loops back on so StarCaster kept working. The wizard's
notes still said "stopped, saved, brought in", so the next try would have
skipped those steps while the old loops kept writing to ClickUp, and those
new writes would never have reached the tracker.

Now, on a rerun, the wizard checks whether the old loops are running again.
If they are, it says so in its log and does the stop, the save, the bring-in
and the safety check over again, in order, before going on. If they stayed
off, nothing changes.

Review then found two gaps, fixed in the same pull request. First, bringing
the tickets in again only added new ones; a ticket the old loops had moved
along (say from Queued to In review) kept its old status in the tracker, so
the safety check would have failed on every try. Now bringing them in again
also updates a ticket ClickUp changed since, unless someone changed it in the
tracker too, which it names and leaves alone. Second, the step that turns on
Spirality's own loops uses the same names as the old ones, and can fail after
turning them on; the wizard would then have mistaken Spirality's loops for
the old ones and stopped them. Now it only checks for the old loops before
that step has started.
