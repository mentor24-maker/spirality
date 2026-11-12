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
