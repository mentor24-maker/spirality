## 2026-11-08 — WaveCenter and StarCaster cannot use the setup wizard: give it the steps for a project already on ClickUp (#128)

The setup wizard could only set up a brand-new project. WaveCenter and
StarCaster are not new: each already runs its own older copy of the loop,
with lanes on the Mini and its tickets in ClickUp. Moving one by hand meant
following a long runbook in the right order.

Now the wizard notices such a project (its folder on the Mini has its own
lane installer and no Spirality settings file) and asks one more question:
which ClickUp list its tickets are in. Then, before the setup pull request
is opened, it stops the old lanes (after checking none is half-way through a
pass), saves a full copy of the ClickUp list on the Mini, imports the
tickets into the tracker, and checks the switch is safe. Any of those
failing stops the run, says which, and the same command picks up there.
The setup pull request then lists which of the old loop's files it replaces
and which it leaves alone.

A brand-new project's run is exactly as before. This does not move
WaveCenter or StarCaster yet; those are their own tickets (SP-23, SP-25).

**After review (2026-11-09).** Four fixes. The switch check was checking the
wrong sign-ins for a project other than Spirality: it looked for Dane's own
seat and Spirality's lane names, so it could never say "safe" for WaveCenter
or StarCaster; it now checks the project's own seats. The setup page could
not answer the ClickUp question, so a run started from the page stopped
there for ever; the page's answers form now shows the ClickUp boxes for such
a project. The stop step now refuses, rather than carrying on, when a lane's
log cannot be found to check it is idle. And the wizard asks for the old
loop's ClickUp machine user too, so the old loop's comments are filed under
the loops instead of under a stranger.

**After the second review (2026-11-09).** If the switch check found tickets
that changed in ClickUp after the import, it asked for the import to run
again, but the wizard skipped the import on every rerun because it was
already logged done, so the run could never finish. The import now runs
again on each rerun until the switch check has said it is safe. The wizard
also now checks that it can read ClickUp before it stops the old lanes, so
a missing ClickUp key no longer leaves the project with no loop at all. A
lane log in a folder with a space in its name is now read correctly, and
the pull request's list of files the setup sits beside no longer suggests
deleting them.

Third round: that ClickUp read can take minutes on a big project, and a
lane could start working during it, then be switched off halfway through.
The wizard now does the slow read first, then looks again for a lane at
work, and switches the lanes off straight after that look. A lane whose
log shows an unfinished pass but whose lock says its runner is gone (it
was killed) is no longer mistaken for one still working. And a project
the wizard clones in the same run that turns out to have an old loop now
stops right after the clone, so the ClickUp questions get asked.
